import { expect, test } from 'bun:test'
import plugin from '../src/opencode/plugin.ts'
import type { Reason } from '../src/opencode/rpc.ts'
import type { Wire } from '../src/wire.ts'
import type { Plugin } from '@opencode/plugin'

type Event = Readonly<{ sessionID: string }>
type Hook = (event: Event) => Promise<void> | void
type Why = (input: Readonly<{ sessionID: string }>) => Promise<Reason | null>
type Execution = Readonly<{ type: string; data: Readonly<{ sessionID: string }> }>

const fits = <T, V>(_value: V): _value is V & T => true

const route = (sessionID = 's') => ({
  sessionID,
  agent: 'build',
  model: { providerID: 'claude-agent', id: 'opus' },
})

const refusal = (message: string, sessionID = 's') => ({
  ...route(sessionID),
  error: { message },
  decision: { retry: false, delay: 0 },
})

const LIMIT = 'You have hit your limit'

const response = (kind: string, status: number) => ({
  ...route(),
  kind,
  request: new Request('http://127.0.0.1/v1/messages'),
  response: new Response(null, { status }),
})

async function load() {
  const store = new Map<string, Wire>()
  const hooks = new Map<string, Hook>()
  const handlers = new Map<'why', Why>()
  const emitted = new Array<string>()
  const queue = new Array<Execution>()
  const waiters = new Array<() => void>()
  const fake = {
    session: {
      hook: (name: string, callback: Hook) => {
        hooks.set(name, callback)
      },
    },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: Wire) => {
        store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
    },
    event: {
      subscribe: ({ types }: Readonly<{ types: ReadonlyArray<string> }>) => ({
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (queue.length === 0) {
              await new Promise<void>((resolve) => {
                waiters.push(resolve)
              })
            }
            const next = queue.shift()
            if (next && types.includes(next.type)) {
              yield next
            }
          }
        },
      }),
    },
    rpc: {
      register: async (_definition: unknown, methods: Readonly<{ why: Why }>) => {
        handlers.set('why', methods.why)
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
  const dispose = await plugin.setup(fake)
  const call = async (name: string, event: Event) => {
    const hook = hooks.get(name)
    if (!hook) {
      throw new Error(`no ${name} hook`)
    }
    await hook(event)
  }
  const why = async (sessionID = 's') => {
    const handler = handlers.get('why')
    if (!handler) {
      throw new Error('no why method')
    }
    return handler({ sessionID })
  }
  const publish = (type: string) => {
    queue.push({ type, data: { sessionID: 's' } })
    waiters.shift()?.()
  }
  return { store, call, why, emitted, dispose, publish }
}

test('a succeeded execution clears the reason', async () => {
  const p = await load()
  await p.call('retry', refusal(LIMIT))
  expect((await p.why())?.reason).toBe('no usable reset')
  p.publish('session.execution.succeeded')
  await Bun.sleep(20)
  expect(await p.why()).toBeNull()
  expect(p.emitted).toEqual(['s', 's'])
  await p.dispose()
})

test('a failed execution keeps the reason of an untimed refusal', async () => {
  const p = await load()
  await p.call('retry', refusal(LIMIT))
  p.publish('session.execution.failed')
  await Bun.sleep(20)
  expect((await p.why())?.reason).toBe('no usable reset')
  expect(p.emitted).toEqual(['s'])
  await p.dispose()
})

test('an unknown refusal records its reason and notifies', async () => {
  const p = await load()
  const before = Date.now()
  const e = refusal(LIMIT)
  await p.call('retry', e)
  expect(e.decision).toEqual({ retry: false, delay: 0 })
  const reason = await p.why()
  expect(reason?.reason).toBe('no usable reset')
  expect(reason?.at).toBeGreaterThanOrEqual(before)
  expect(reason?.at).toBeLessThanOrEqual(Date.now())
  expect(p.emitted).toEqual(['s'])
  await p.dispose()
})

test('an other refusal records nothing', async () => {
  const p = await load()
  await p.call('retry', refusal('Internal server error'))
  expect(await p.why()).toBeNull()
  expect(p.emitted).toEqual([])
  await p.dispose()
})

test('a prompt clears the reason', async () => {
  const p = await load()
  await p.call('retry', refusal(LIMIT))
  await p.call('prompt', { sessionID: 's' })
  expect(await p.why()).toBeNull()
  expect(p.emitted).toEqual(['s', 's'])
  await p.dispose()
})

test('a later hold clears the reason', async () => {
  const p = await load()
  await p.call('retry', refusal(LIMIT))
  const reset = new Date(Date.now() + 100_000).toISOString()
  const e = refusal(`${LIMIT}. Resets at ${reset}`)
  await p.call('retry', e)
  expect(e.decision.retry).toBe(true)
  expect(p.store.size).toBe(1)
  expect(await p.why()).toBeNull()
  expect(p.emitted).toEqual(['s', 's'])
  await p.dispose()
})

test('a successful primary response clears the reason', async () => {
  const p = await load()
  await p.call('retry', refusal(LIMIT))
  await p.call('http.response', response('title', 200))
  await p.call('http.response', response('primary', 429))
  expect((await p.why())?.reason).toBe('no usable reset')
  expect(p.emitted).toEqual(['s'])
  await p.call('http.response', response('primary', 200))
  expect(await p.why()).toBeNull()
  expect(p.emitted).toEqual(['s', 's'])
  await p.dispose()
})

test('a prompt during the lookup means the reason is never written', async () => {
  const p = await load()
  const retry = p.call('retry', refusal(LIMIT))
  const prompt = p.call('prompt', { sessionID: 's' })
  await Promise.all([retry, prompt])
  expect(await p.why()).toBeNull()
  expect(p.emitted).toEqual(['s'])
  await p.dispose()
})

test('the 201st written session evicts the least recently written', async () => {
  const p = await load()
  for (let index = 0; index < 200; index += 1) {
    await p.call('retry', refusal(LIMIT, `s${index}`))
  }
  await p.call('retry', refusal(LIMIT, 's0'))
  await p.call('retry', refusal(LIMIT, 's200'))
  expect((await p.why('s0'))?.reason).toBe('no usable reset')
  expect(await p.why('s1')).toBeNull()
  expect((await p.why('s2'))?.reason).toBe('no usable reset')
  expect((await p.why('s200'))?.reason).toBe('no usable reset')
  await p.dispose()
})

test('an evicted reason notifies its session', async () => {
  const p = await load()
  for (let index = 0; index < 200; index += 1) {
    await p.call('retry', refusal(LIMIT, `s${index}`))
  }
  await p.call('retry', refusal(LIMIT, 's200'))
  expect(await p.why('s0')).toBeNull()
  expect(p.emitted.slice(-2)).toEqual(['s0', 's200'])
  await p.dispose()
})
