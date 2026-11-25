import { expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { setup } from '../src/opencode/plugin.ts'

const event = () => ({
  sessionID: 's',
  agent: 'build',
  model: { providerID: 'test', id: 'model', variant: 'high' },
  decision: { retry: false },
})

function fixture() {
  const store = new Map()
  const until = Date.now() + 100_000
  const boot = async (read = async () => ({ kind: 'until', until }), extra = {}) => {
    const hooks = {}
    const cleanup = await setup(
      {
        session: {
          hook: (name, cb) => {
            hooks[name] = cb
          },
        },
        storage: {
          get: (key) => store.get(key),
          set: (key, value) => store.set(key, value),
          remove: (key) => store.delete(key),
        },
        event: { subscribe: () => (async function* () {})() },
      },
      { test: { resolve: read, ...extra } },
    )
    return { hooks, cleanup }
  }
  return { until, boot, store }
}

test('one native retry, no synthetic prompt and only the deadline and route persisted', async () => {
  const { boot, store, until } = fixture()
  const { hooks } = await boot()
  const e = event()
  await hooks.retry(e)
  expect(e.decision.retry).toBe(true)
  expect(Math.abs(Date.now() + e.decision.delay - until)).toBeLessThan(50)
  const stored = [...store.values()][0]
  expect({ ...stored, since: undefined }).toEqual({
    until,
    since: undefined,
    agent: e.agent,
    model: e.model,
  })
  expect(Math.abs(stored.since - Date.now())).toBeLessThan(50)
})

test('a manual prompt releases a recovered wait without sending a message', async () => {
  const { boot } = fixture()
  await (await boot()).hooks.retry(event())
  const { hooks } = await boot()
  let released = false
  const wait = hooks.context(event()).then(() => {
    released = true
  })
  await sleep(10)
  expect(released).toBe(false)
  await hooks.prompt(event())
  await wait
  expect(released).toBe(true)
})

test('different routing does not inherit a wait; absent wake-up data never schedules a retry', async () => {
  const { boot } = fixture()
  await (await boot()).hooks.retry(event())
  const { hooks } = await boot(async () => ({ kind: 'unknown', reason: 'absent' }))
  const e = event()
  e.model.variant = 'low'
  await hooks.context(e)
  await hooks.retry(e)
  expect(e.decision).toEqual({ retry: false })
})

test('an unavailable usage reader does not break unrelated native errors', async () => {
  const { boot } = fixture()
  const { hooks } = await boot(async () => {
    throw new Error('unavailable')
  })
  const e = event()
  e.error = { type: 'provider.transport' }
  e.decision = { retry: true, delay: 100 }
  await hooks.retry(e)
  expect(e.decision).toEqual({ retry: true, delay: 100 })
})

async function keepsHostRetry(read) {
  const { boot, store } = fixture()
  const { hooks } = await boot(read, { confirmed: () => true })
  const e = event()
  e.decision = { retry: true, delay: 123 }
  await hooks.retry(e)
  expect(e.decision).toEqual({ retry: true, delay: 123 })
  expect(store.size).toBe(0)
}

test('an implausible year never vetoes existing host retry', async () => {
  await keepsHostRetry(() => ({ kind: 'until', until: Date.now() * 1000 }))
})

test('an unknown reset never vetoes existing host retry', async () => {
  await keepsHostRetry(() => ({ kind: 'unknown', reason: 'x' }))
})

test('a reader that throws never vetoes existing host retry', async () => {
  await keepsHostRetry(() => {
    throw new Error('unavailable')
  })
})

test('a second deadline cannot be erased by an older recovery; manual input releases both', async () => {
  const { boot, store } = fixture()
  let deadline = Date.now() + 75
  const { hooks, cleanup } = await boot(() => ({ kind: 'until', until: deadline }))
  try {
    await hooks.retry(event())
    let released = false
    const waiting = hooks.context(event()).then(() => {
      released = true
    })
    await sleep(10)
    deadline += 1000
    await hooks.retry(event())
    await sleep(85)
    expect(released).toBe(false)
    expect([...store.values()][0]?.until).toBe(deadline)
    await hooks.prompt(event())
    await waiting
    expect(store.size).toBe(0)
  } finally {
    cleanup()
  }
})

function interrupts() {
  const queue = []
  let wake
  const wait = () =>
    new Promise((resolve) => {
      wake = resolve
    })
  return {
    push(reason, sessionID = 's') {
      queue.push({ type: 'session.execution.interrupted', data: { sessionID, reason } })
      wake?.()
    },
    subscribe() {
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (queue.length === 0) {
              await wait()
            }
            yield queue.shift()
          }
        },
      }
    },
  }
}

async function interruptedSetup() {
  const store = new Map()
  const hooks = {}
  const events = interrupts()
  const until = Date.now() + 100_000
  const cleanup = await setup(
    {
      session: {
        hook: (name, callback) => {
          hooks[name] = callback
        },
      },
      storage: {
        get: (key) => store.get(key),
        set: (key, value) => store.set(key, value),
        remove: (key) => store.delete(key),
      },
      event: { subscribe: () => events.subscribe() },
    },
    { test: { resolve: async () => ({ kind: 'until', until }) } },
  )
  return { store, hooks, events, cleanup }
}

test('interrupting the turn by hand drops the deadline and releases the wait', async () => {
  const { store, hooks, events, cleanup } = await interruptedSetup()
  try {
    await hooks.retry(event())
    let released = false
    const waiting = hooks.context(event()).then(() => {
      released = true
    })
    await sleep(10)
    expect(released).toBe(false)
    events.push('user')
    await waiting
    expect(released).toBe(true)
    expect(store.size).toBe(0)
  } finally {
    cleanup()
  }
})

test('a shutdown keeps the deadline so a restarted OpenCode still resumes at reset', async () => {
  const { store, hooks, events, cleanup } = await interruptedSetup()
  try {
    await hooks.retry(event())
    let released = false
    void hooks.context(event()).then(() => {
      released = true
    })
    await sleep(10)
    events.push('shutdown')
    await sleep(30)
    expect(released).toBe(false)
    expect(store.size).toBe(1)
    events.push('user')
  } finally {
    cleanup()
  }
})
