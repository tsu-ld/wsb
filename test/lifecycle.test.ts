import { expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { dispatchDecision } from '../src/opencode/hold.ts'
import { setup, start } from '../src/opencode/plugin.ts'
import { record } from '../src/wire.ts'
import type { Reading } from '../src/deadline.ts'
import type { HoldState } from '../src/opencode/rpc.ts'
import type { Wire } from '../src/wire.ts'
import type { Plugin } from '@opencode/plugin'

type Turn = Readonly<{ sessionID: string; kind?: string }>
type Hook = (event: Turn) => Promise<void> | void
type Get = (input: Readonly<{ sessionID: string }>) => Promise<HoldState | null>
type Interrupt = Readonly<{ data: Readonly<{ sessionID: string; reason: string }> }>

const fits = <T, V>(_value: V): _value is V & T => true

const route = () => ({
  sessionID: 's',
  agent: 'build',
  model: { providerID: 'test', id: 'model', variant: 'high' },
})

const refusal = () => ({ ...route(), decision: { retry: false, delay: 0 } })

const until = (at: number) => ({ atError: (): Reading => ({ kind: 'until', until: at }) })

function host(gate?: Promise<void>) {
  const store = new Map<string, Wire>()
  const hooks = new Map<string, Hook>()
  const reads = { count: 0 }
  const emitted = new Array<string>()
  const handlers = new Map<'get', Get>()
  const queue = new Array<Interrupt>()
  const waiters = new Array<() => void>()
  const fake = {
    session: {
      hook: (name: string, callback: Hook) => {
        hooks.set(name, callback)
      },
    },
    storage: {
      get: async (key: string) => {
        reads.count += 1
        return store.get(key)
      },
      set: async (key: string, value: Wire) => {
        await gate
        store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (queue.length === 0) {
              await new Promise<void>((resolve) => {
                waiters.push(resolve)
              })
            }
            const next = queue.shift()
            if (next) {
              yield next
            }
          }
        },
      }),
    },
    rpc: {
      register: async (_definition: unknown, methods: Readonly<{ get: Get }>) => {
        handlers.set('get', methods.get)
        return {
          dispose: async () => undefined,
          events: {
            emit: async (_name: string, payload: Readonly<{ sessionID: string }>) => {
              emitted.push(payload.sessionID)
            },
          },
        }
      },
    },
  }
  if (!fits<Plugin.Context, typeof fake>(fake)) {
    throw new Error('unreachable')
  }
  const call = async (name: string, event: Turn) => {
    const hook = hooks.get(name)
    if (!hook) {
      throw new Error(`no ${name} hook`)
    }
    await hook(event)
  }
  const interrupt = (reason: string) => {
    queue.push({ data: { sessionID: 's', reason } })
    waiters.shift()?.()
  }
  const get = async () => handlers.get('get')?.({ sessionID: 's' })
  return { ctx: fake, store, call, reads, emitted, interrupt, get }
}

const watch = (pending: Promise<void>) => {
  const state = { done: false }
  const settled = pending.then(() => {
    state.done = true
  })
  return { state, settled }
}

test('a prompt that arrives while the hold is being written does not publish a retry', async () => {
  const gate = Promise.withResolvers<void>()
  const h = host(gate.promise)
  await setup(h.ctx, { test: until(Date.now() + 100_000) })
  const e = refusal()
  const retry = h.call('retry', e)
  await sleep(10)
  const prompt = h.call('prompt', { sessionID: 's' })
  gate.resolve()
  await Promise.all([retry, prompt])
  expect(e.decision).toEqual({ retry: false, delay: 0 })
  expect(h.store.size).toBe(0)
})

test('the delay is computed after the write', async () => {
  const gate = Promise.withResolvers<void>()
  const h = host(gate.promise)
  const deadline = Date.now() + 100_000
  await setup(h.ctx, { test: until(deadline) })
  const e = refusal()
  const retry = h.call('retry', e)
  await sleep(200)
  gate.resolve()
  await retry
  expect(e.decision.retry).toBe(true)
  expect(Math.abs(Date.now() + e.decision.delay - deadline)).toBeLessThan(50)
})

test('an interrupt discards the lookup, removes the hold and wakes the sleeper; a shutdown does not', async () => {
  const h = host()
  const lookup = Promise.withResolvers<Reading>()
  let slow = false
  const deadline = Date.now() + 100_000
  const dispose = await setup(h.ctx, {
    test: {
      atError: () => (slow ? lookup.promise : { kind: 'until', until: deadline }),
    },
  })
  try {
    await h.call('retry', refusal())
    const sleeper = watch(h.call('context', route()))
    h.interrupt('shutdown')
    await sleep(30)
    expect(sleeper.state.done).toBe(false)
    expect(h.store.size).toBe(1)
    slow = true
    const late = refusal()
    const retry = h.call('retry', late)
    h.interrupt('user')
    await sleeper.settled
    expect(h.store.size).toBe(0)
    lookup.resolve({ kind: 'until', until: deadline })
    await retry
    expect(late.decision).toEqual({ retry: false, delay: 0 })
    expect(h.store.size).toBe(0)
  } finally {
    dispose()
  }
})

test('a title response between the refusal and the retry does not erase the observation', async () => {
  const h = host()
  const deadline = Date.now() + 100_000
  await setup(h.ctx, {
    test: {
      atResponse: async (): Promise<Reading> => ({ kind: 'until', until: deadline }),
      atError: (_event, earlier): Reading => earlier ?? { kind: 'unknown', reason: 'none' },
    },
  })
  await h.call('http.response', { ...route(), kind: 'primary' })
  await h.call('http.response', { ...route(), kind: 'title' })
  const e = refusal()
  await h.call('retry', e)
  expect(e.decision.retry).toBe(true)
  expect(Math.abs(Date.now() + e.decision.delay - deadline)).toBeLessThan(50)
})

test('a hold longer than MAX_SLEEP_MS is slept in slices', async () => {
  const h = host()
  await setup(h.ctx, { test: until(Date.now() + 100_000) }, undefined, { maxSleepMs: 20 })
  await h.call('retry', refusal())
  const sleeper = watch(h.call('context', route()))
  await sleep(110)
  expect(sleeper.state.done).toBe(false)
  expect(h.reads.count).toBeGreaterThanOrEqual(4)
  await h.call('prompt', { sessionID: 's' })
  await sleeper.settled
})

test('dispatchDecision passes, sleeps, keeps another route or removes', () => {
  const now = 1_000_000
  const stored = { until: now + 5000, agent: 'build', model: { providerID: 'test', id: 'model' } }
  const same = { agent: 'build', model: { providerID: 'test', id: 'model' } }
  expect(dispatchDecision(undefined, same, now)).toEqual({ kind: 'pass' })
  expect(dispatchDecision(stored, same, now)).toEqual({ kind: 'sleep', delay: 5000 })
  expect(dispatchDecision(stored, { ...same, agent: 'plan' }, now)).toEqual({ kind: 'pass' })
  expect(dispatchDecision({ ...stored, until: now }, same, now)).toEqual({ kind: 'remove' })
  expect(dispatchDecision({ until: 'soon' }, same, now)).toEqual({ kind: 'remove' })
})

test('a hold stored without since and with variant still sleeps and projects a since', async () => {
  const h = host()
  const deadline = Date.now() + 100_000
  const dispose = await start(h.ctx, {})
  h.store.set('wait/s', { until: deadline, agent: 'build', model: route().model })
  const sleeper = watch(h.call('context', route()))
  await sleep(20)
  expect(sleeper.state.done).toBe(false)
  const projected = await h.get()
  expect(projected).toMatchObject({ sessionID: 's', until: deadline, providerID: 'test' })
  expect(Math.abs((projected?.since ?? 0) - Date.now())).toBeLessThan(50)
  await h.call('prompt', { sessionID: 's' })
  await sleeper.settled
  await dispose()
})

test('a second refusal with an earlier deadline wakes the sleeper', async () => {
  const h = host()
  let deadline = Date.now() + 100_000
  await setup(h.ctx, { test: { atError: (): Reading => ({ kind: 'until', until: deadline }) } })
  await h.call('retry', refusal())
  const sleeper = watch(h.call('context', route()))
  await sleep(10)
  deadline = Date.now() + 60
  await h.call('retry', refusal())
  await sleep(300)
  expect(sleeper.state.done).toBe(true)
  expect(h.store.size).toBe(0)
})

test('unload never removes a hold', async () => {
  const gate = Promise.withResolvers<Reading>()
  let slow = false
  const deadline = Date.now() + 100_000
  const h = host()
  const dispose = await setup(h.ctx, {
    test: { atError: () => (slow ? gate.promise : { kind: 'until', until: deadline }) },
  })
  await h.call('retry', refusal())
  const sleeper = watch(h.call('context', route()))
  slow = true
  const late = refusal()
  const retry = h.call('retry', late)
  dispose()
  await sleeper.settled
  gate.resolve({ kind: 'until', until: deadline + 1000 })
  await retry
  expect(late.decision).toEqual({ retry: false, delay: 0 })
  expect(h.store.size).toBe(1)
  expect(record(h.store.get('wait/s'))?.['until']).toBe(deadline)
})

test('the TUI is notified when a hold is published, released or removed as expired', async () => {
  const h = host()
  const dispose = await start(h.ctx, { test: until(Date.now() + 100_000) })
  await h.call('retry', refusal())
  expect(h.emitted).toEqual(['s'])
  const sleeper = watch(h.call('context', route()))
  await sleep(10)
  await h.call('prompt', { sessionID: 's' })
  expect(h.emitted).toEqual(['s', 's'])
  await sleeper.settled
  h.store.set('wait/s', { until: Date.now() - 1, agent: 'build', model: route().model })
  await h.call('context', route())
  expect(h.emitted).toEqual(['s', 's', 's'])
  expect(h.store.size).toBe(0)
  await dispose()
})

test('a prompt during a host-owned wait keeps the hold', async () => {
  const h = host()
  const deadline = Date.now() + 100_000
  const dispose = await start(h.ctx, { test: until(deadline) })
  const e = refusal()
  await h.call('retry', e)
  expect(e.decision.retry).toBe(true)
  await h.call('prompt', { sessionID: 's' })
  expect(h.store.size).toBe(1)
  expect(await h.get()).toMatchObject({ sessionID: 's', until: deadline, providerID: 'test' })
  expect(h.emitted).toEqual(['s'])
  await dispose()
})

test('the kept hold is removed when the turn is dispatched after the deadline', async () => {
  const h = host()
  await setup(h.ctx, { test: until(Date.now() + 60) })
  await h.call('retry', refusal())
  await h.call('prompt', { sessionID: 's' })
  expect(h.store.size).toBe(1)
  await sleep(100)
  await h.call('context', route())
  expect(h.store.size).toBe(0)
})

test('a prompt releases a wait the plugin itself is sleeping', async () => {
  const h = host()
  await setup(h.ctx, { test: until(Date.now() + 100_000) })
  await h.call('retry', refusal())
  const sleeper = watch(h.call('context', route()))
  await sleep(10)
  expect(sleeper.state.done).toBe(false)
  await h.call('prompt', { sessionID: 's' })
  await sleeper.settled
  expect(h.store.size).toBe(0)
})

test('after a restart a prompt releases a stored hold', async () => {
  const h = host()
  h.store.set('wait/s', { until: Date.now() + 100_000, agent: 'build', model: route().model })
  const dispose = await start(h.ctx, { test: until(Date.now() + 100_000) })
  await h.call('prompt', { sessionID: 's' })
  expect(h.store.size).toBe(0)
  expect(await h.get()).toBeNull()
  await dispose()
})
