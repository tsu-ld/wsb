import { expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { setup } from '../src/runner.ts'

const event = () => ({
  sessionID: 's',
  agent: 'build',
  model: { providerID: 'test', id: 'model', variant: 'high' },
  decision: { retry: false },
})

function fixture() {
  const store = new Map()
  const until = Date.now() + 100_000
  const boot = async (read = async () => until, extra = {}) => {
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
  expect([...store.values()]).toEqual([{ until, agent: e.agent, model: e.model }])
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
  const { hooks } = await boot(async () => undefined)
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

test('unavailable reset never vetoes existing host retry or accepts an implausible year', async () => {
  for (const reset of [undefined, Date.now() * 1000]) {
    const { boot, store } = fixture()
    const { hooks } = await boot(() => reset, { confirmed: () => true })
    const e = event()
    e.decision = { retry: true, delay: 123 }
    await hooks.retry(e)
    expect(e.decision).toEqual({ retry: true, delay: 123 })
    expect(store.size).toBe(0)
  }
})

test('a second deadline cannot be erased by an older recovery; manual input releases both', async () => {
  const { boot, store } = fixture()
  let deadline = Date.now() + 75
  const { hooks, cleanup } = await boot(() => deadline)
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
