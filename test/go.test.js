import { expect, test } from 'bun:test'
import { goAdapter, goUsage } from '../src/go-transport.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WORKSPACE = 'wrk_go'
const NOW = Date.parse('2026-11-21T12:00:00.000Z')
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

const limited = (resetsAt) => ({ percent: 100, status: 'rate-limited', resetsAt })
const clear = (resetsAt) => ({
  percent: 10,
  status: 'ok',
  resetsAt: new Date(resetsAt).toISOString(),
})
const usage = (rolling, weekly = clear(NOW + 20 * DAY), monthly = clear(NOW + 30 * DAY)) => ({
  usage: { rolling, weekly, monthly },
})
const readOnce = (payload, status = 200) => {
  const calls = []
  return {
    calls,
    read: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
}
const inference = (
  url = 'https://opencode.ai/zen/go/v1/messages',
  headers = { authorization: 'Bearer test', 'x-opencode-org-id': WORKSPACE },
) => new Request(url, { headers })
const responseEvent = (overrides = {}) => ({
  sessionID: 'ses_go',
  agent: 'build',
  model: { providerID: 'opencode-go', id: 'hy4' },
  kind: 'primary',
  response: new Response(null, { status: 429 }),
  request: inference(),
  ...overrides,
})
const failure = (overrides = {}) => ({
  type: 'provider.go-limit',
  message: 'OpenCode Go usage limit reached.',
  status: 429,
  response: {
    body: JSON.stringify({
      type: 'error',
      error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' },
      metadata: { workspace: WORKSPACE, limitName: 'rolling' },
    }),
  },
  ...overrides,
})
const retryEvent = (error = failure()) => ({
  sessionID: 'ses_go',
  agent: 'build',
  model: { providerID: 'opencode-go', id: 'hy4' },
  attempt: 2,
  error,
})
const absolute = (resetsAt, workspace = WORKSPACE) =>
  JSON.stringify({
    type: 'error',
    error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' },
    metadata: { workspace, limitName: 'rolling', resetsAt },
  })
const observeScope = (adapter, body, origin = 'https://opencode.ai') =>
  adapter.observe(
    responseEvent({
      request: inference(`${origin}/zen/go/v1/messages`),
      response: new Response(body, { status: 429 }),
    }),
    readOnce({}, 403).read,
    NOW,
  )

test('the usage route reports the latest limited Go window with the inference credential', async () => {
  const { calls, read } = readOnce(
    usage(limited(NOW + HOUR), limited(NOW + 2 * DAY), clear(NOW - DAY)),
  )
  expect(await goUsage(responseEvent(), read, NOW)).toBe(NOW + 2 * DAY)
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe(USAGE_URL)
  expect(calls[0].init.headers).toEqual({
    authorization: 'Bearer test',
    'x-opencode-org-id': WORKSPACE,
  })
  expect(calls[0].init.redirect).toBe('error')
  expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
})

test('foreign origins, foreign routes, missing credentials and unrelated responses never call the usage route', async () => {
  let calls = 0
  const read = () => {
    calls += 1
    return new Response(null, { status: 403 })
  }
  const events = [
    responseEvent({ request: inference('https://not-opencode.invalid/zen/go/v1/messages') }),
    responseEvent({ request: inference('https://opencode.ai/zen/go/v2/messages') }),
    responseEvent({ request: inference(undefined, { 'x-opencode-org-id': WORKSPACE }) }),
    responseEvent({ request: inference(undefined, { authorization: 'Basic test' }) }),
    responseEvent({ model: { providerID: 'anthropic', id: 'claude' } }),
    responseEvent({ kind: 'secondary' }),
    responseEvent({ response: new Response(null, { status: 500 }) }),
  ]
  for (const event of events) {
    expect(await goUsage(event, read, NOW)).toBeUndefined()
  }
  expect(calls).toBe(0)
})

test('an incomplete, unavailable or unreadable usage answer is refused', async () => {
  const payloads = [
    usage(limited(NOW + HOUR), { status: 'rate-limited' }, clear(NOW + 30 * DAY)),
    usage(limited(NOW + HOUR), { status: 'unknown', resetsAt: new Date(NOW + DAY).toISOString() }),
    { usage: { rolling: limited(NOW + HOUR), weekly: clear(NOW + DAY) } },
    { usage: null },
  ]
  for (const payload of payloads) {
    const { read } = readOnce(payload)
    expect(await goUsage(responseEvent(), read, NOW)).toBeUndefined()
  }
  const { read: refused } = readOnce(usage(limited(NOW + HOUR)), 403)
  expect(await goUsage(responseEvent(), refused, NOW)).toBeUndefined()
  expect(await goUsage(responseEvent(), async () => new Response('not json'), NOW)).toBeUndefined()
  expect(
    await goUsage(
      responseEvent(),
      async () => {
        throw new Error('offline')
      },
      NOW,
    ),
  ).toBeUndefined()
})

test('stale, malformed or missing limited resets leave the usage answer unknown', async () => {
  for (const resetsAt of [NOW - 1, 'soon', null, undefined]) {
    const { read } = readOnce(usage(limited(resetsAt)))
    expect(await goUsage(responseEvent(), read, NOW)).toBeUndefined()
  }
  const { read } = readOnce(usage(limited(NOW + HOUR), limited('soon'), limited(NOW + DAY)))
  expect(await goUsage(responseEvent(), read, NOW)).toBeUndefined()
})

test('all clear Go meters produce no wait', async () => {
  const { read } = readOnce(usage(clear(NOW + HOUR), clear(NOW + DAY), clear(NOW - DAY)))
  expect(await goUsage(responseEvent(), read, NOW)).toBeUndefined()
})

test('a usage observation is used only while it still points ahead', async () => {
  const adapter = goAdapter()
  expect(adapter.resolve({}, retryEvent(), NOW, NOW + HOUR)).toBe(NOW + HOUR)
  expect(adapter.resolve({}, retryEvent(), NOW, NOW - 1)).toBeUndefined()
  expect(adapter.resolve({}, retryEvent(), NOW, 'soon')).toBeUndefined()
  expect(adapter.resolve({}, retryEvent(), Number.NaN, NOW + HOUR)).toBeUndefined()
})

test('a generic provider 429 never becomes a Go reset', async () => {
  const adapter = goAdapter()
  for (const type of [
    'provider.rate-limit',
    'provider.quota',
    'provider.free-limit',
    'provider.budget-limit',
    'provider.model-budget-limit',
    'provider.auth',
    'unknown',
  ]) {
    const error = failure({ type, retryAfterMs: 60_000 })
    expect(adapter.confirmed(retryEvent(error))).toBe(false)
    expect(adapter.resolve({}, retryEvent(error), NOW, NOW + HOUR)).toBeUndefined()
  }
  expect(adapter.resolve({}, retryEvent(undefined), NOW)).toBeUndefined()
})

test('the adapter confirms only Go limit failures', () => {
  const adapter = goAdapter()
  expect(adapter.confirmed(retryEvent())).toBe(true)
  expect(adapter.confirmed(retryEvent(failure({ type: 'provider.rate-limit' })))).toBe(false)
  expect(
    adapter.confirmed({ ...retryEvent(), model: { providerID: 'anthropic', id: 'claude' } }),
  ).toBe(false)
})

test('a same-response absolute reset must match the observed workspace and still be ahead', async () => {
  const adapter = goAdapter()
  const at = NOW + 90 * 60_000
  expect(
    adapter.resolve(
      {},
      retryEvent(failure({ response: { body: absolute(at) } })),
      NOW,
      await observeScope(adapter, absolute(at)),
    ),
  ).toBe(at)
  expect(await observeScope(adapter, absolute(at), 'https://not-opencode.invalid')).toBeUndefined()
  expect(await observeScope(adapter, absolute(at, 'wrk_other'))).toBeUndefined()
  expect(await observeScope(adapter, absolute(NOW - 1))).toBeUndefined()
  expect(
    adapter.resolve(
      {},
      retryEvent(failure({ response: { body: absolute(at, 'wrk_other') } })),
      NOW,
    ),
  ).toBeUndefined()
  expect(
    adapter.resolve({}, retryEvent(failure({ response: { body: absolute(NOW - 1) } })), NOW),
  ).toBeUndefined()
  expect(
    goAdapter().resolve({}, retryEvent(failure({ response: { body: absolute(at) } })), NOW),
  ).toBeUndefined()
})

test('absolute resets are read from top-level and nested error metadata', async () => {
  const adapter = goAdapter()
  const at = NOW + 45 * 60_000
  const nested = JSON.stringify({
    type: 'error',
    error: {
      type: 'GoUsageLimitError',
      metadata: { workspace: WORKSPACE, resetsAt: String(at) },
    },
  })
  expect(
    adapter.resolve(
      {},
      retryEvent(failure({ response: { body: nested } })),
      NOW,
      await observeScope(adapter, nested),
    ),
  ).toBe(at)
  const top = JSON.stringify({
    metadata: { workspace: WORKSPACE, resetsAt: new Date(at).toISOString() },
  })
  expect(
    adapter.resolve(
      {},
      retryEvent(failure({ response: { body: top } })),
      NOW,
      await observeScope(adapter, top),
    ),
  ).toBe(at)
})

test('a malformed absolute reset does not fall through to a retry delay', async () => {
  const adapter = goAdapter()
  const event = retryEvent(failure({ retryAfterMs: HOUR, response: { body: absolute('soon') } }))
  expect(adapter.resolve({}, event, NOW)).toBeUndefined()
})

test('a Go retry delay is anchored to now and stays inside the named window', async () => {
  const adapter = goAdapter()
  expect(adapter.resolve({}, retryEvent(failure({ retryAfterMs: 60_000 })), NOW)).toBe(NOW + 60_000)
  expect(adapter.resolve({}, retryEvent(failure({ retryAfterMs: 4 * HOUR })), NOW)).toBe(
    NOW + 4 * HOUR,
  )
  const monthly = JSON.stringify({
    error: { type: 'GoUsageLimitError' },
    metadata: { workspace: WORKSPACE, limitName: 'monthly' },
  })
  expect(
    adapter.resolve(
      {},
      retryEvent(failure({ retryAfterMs: 20 * DAY, response: { body: monthly } })),
      NOW,
    ),
  ).toBe(NOW + 20 * DAY)
  for (const retryAfterMs of [0, -1, 1.5, 6 * HOUR, 46 * DAY]) {
    expect(adapter.resolve({}, retryEvent(failure({ retryAfterMs })), NOW)).toBeUndefined()
  }
})

test('delays without a Go body or a known window are refused', async () => {
  const adapter = goAdapter()
  expect(adapter.resolve({}, retryEvent(failure()), NOW)).toBeUndefined()
  const unknown = JSON.stringify({
    error: { type: 'GoUsageLimitError' },
    metadata: { workspace: WORKSPACE, limitName: 'fortnight' },
  })
  expect(
    adapter.resolve(
      {},
      retryEvent(failure({ retryAfterMs: HOUR, response: { body: unknown } })),
      NOW,
    ),
  ).toBeUndefined()
  expect(
    adapter.resolve(
      {},
      retryEvent(failure({ retryAfterMs: HOUR, response: { body: 'not json' } })),
      NOW,
    ),
  ).toBeUndefined()
  expect(
    adapter.resolve(
      {},
      retryEvent(failure({ retryAfterMs: HOUR, response: { body: undefined } })),
      NOW,
    ),
  ).toBeUndefined()
})
