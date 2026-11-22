import { afterEach, expect, test } from 'bun:test'
import { codexReset, observeCodex } from '../src/codex.js'

const NOW = 1_700_000_000_000
const S = NOW / 1000
const realFetch = globalThis.fetch
let requests = []

afterEach(() => {
  globalThis.fetch = realFetch
  requests = []
})

const credential = (accountID, extra = {}) => ({
  type: 'oauth',
  access: 'tok',
  metadata: accountID ? { accountID } : {},
  ...extra,
})
const ctx = (cred = credential('acct-a'), method = 'oauth') => ({
  integration: {
    connection: { active: async (id) => ({ id, method }), resolve: async () => cred },
  },
})
const error = (body, extra = {}) => ({
  type: 'provider.chatgpt-limit',
  status: 429,
  response: { body: typeof body === 'string' ? body : JSON.stringify(body) },
  ...extra,
})
const usage = (primary, secondary, reached = true) => ({
  rate_limit: {
    limit_reached: reached,
    allowed: !reached,
    primary_window: primary,
    secondary_window: secondary ?? null,
  },
})
const serve = (payload, ok = true) => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return { ok, status: ok ? 200 : 429, json: async () => payload }
  }
}
const noLookup = () => {
  globalThis.fetch = async (url) => {
    requests.push({ url })
    throw new Error('lookup must not run')
  }
}

test('an unattributed failure cannot borrow the active account; stale matching reset triggers a fresh read', async () => {
  serve(usage({ used_percent: 100, reset_at: S + 90 }))
  expect(
    await codexReset(ctx(), { error: error({ error: { type: 'usage_limit_reached' } }) }, NOW),
  ).toBeUndefined()
  expect(requests).toHaveLength(0)
  expect(
    await codexReset(
      ctx(),
      {
        error: error({
          error: { type: 'usage_limit_reached', account_id: 'acct-a', resets_at: S - 1 },
        }),
      },
      NOW,
    ),
  ).toBe(NOW + 90_000)
  expect(requests).toHaveLength(1)
})

test('an HTTP refusal without account in the body can use the original ChatGPT request identity', async () => {
  const reset = Date.now() + 90_000
  serve(usage({ used_percent: 100, reset_at: reset }))
  const response = Response.json({ error: { type: 'usage_limit_reached' } }, { status: 429 })
  const init = { headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'acct-b' } }
  const from = (origin) => ({
    kind: 'primary',
    request: new Request(`${origin}/backend-api/codex/responses`, init),
    response,
  })
  expect(await observeCodex(from('https://example.invalid'))).toBeUndefined()
  expect(requests).toHaveLength(0)
  expect(await observeCodex(from('https://chatgpt.com'))).toBe(reset)
  expect(requests[0].init.headers['ChatGPT-Account-Id']).toBe('acct-b')
})

test('direct reset in the error is absolute, in seconds or milliseconds', async () => {
  noLookup()
  expect(
    await codexReset(
      ctx(),
      { error: error({ error: { type: 'usage_limit_reached', resets_at: S + 600 } }) },
      NOW,
    ),
  ).toBe((S + 600) * 1000)
  expect(
    await codexReset(
      ctx(),
      { error: error({ error: { type: 'usage_limit_reached', resetsAt: (S + 60) * 1000 } }) },
      NOW,
    ),
  ).toBe((S + 60) * 1000)
  expect(
    await codexReset(
      ctx(),
      { error: error({ error: { type: 'usage_limit_reached', resets_in_seconds: 90 } }) },
      NOW,
    ),
  ).toBe(NOW + 90_000)
  expect(requests).toEqual([])
})

test('without an explicit reset, the quota lookup returns the blocking window', async () => {
  serve(
    usage(
      { used_percent: 100, limit_window_seconds: 18_000, reset_at: S + 3600 },
      { used_percent: 40, reset_at: S + 86_400 },
    ),
  )
  const reset = await codexReset(
    ctx(credential('acct-a')),
    { error: error({ error: { type: 'usage_limit_reached', account_id: 'acct-a' } }) },
    NOW,
  )
  expect(reset).toBe((S + 3600) * 1000)
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe('https://chatgpt.com/backend-api/wham/usage')
  expect(requests[0].init.method).toBe('GET')
  expect(requests[0].init.headers.Authorization).toBe('Bearer tok')
  expect(requests[0].init.headers['ChatGPT-Account-Id']).toBe('acct-a')
  expect(requests[0].init.redirect).toBe('error')
})

test('a reset that is unknown or already spent is not guessed', async () => {
  serve(
    usage(
      { used_percent: 20, reset_at: S + 3600 },
      { used_percent: 10, reset_at: S + 86_400 },
      false,
    ),
  )
  expect(
    await codexReset(
      ctx(),
      { error: error({ error: { type: 'usage_limit_reached', account_id: 'acct-a' } }) },
      NOW,
    ),
  ).toBeUndefined()
  serve(usage({ used_percent: 100, reset_at: S - 60 }))
  expect(
    await codexReset(
      ctx(),
      { error: error({ error: { type: 'usage_limit_reached', account_id: 'acct-a' } }) },
      NOW,
    ),
  ).toBeUndefined()
  serve({ rate_limit: { limit_reached: true, primary_window: { used_percent: 100 } } })
  expect(
    await codexReset(
      ctx(),
      { error: error({ error: { type: 'usage_limit_reached', account_id: 'acct-a' } }) },
      NOW,
    ),
  ).toBeUndefined()
  expect(
    await codexReset(
      undefined,
      { error: error({ error: { type: 'usage_limit_reached', account_id: 'acct-a' } }) },
      NOW,
    ),
  ).toBeUndefined()
})

test('an API key connection is metered and never continues on a subscription reset', async () => {
  noLookup()
  const body = { error: { type: 'usage_limit_reached', resets_at: S + 600 } }
  expect(
    await codexReset(ctx(credential('acct-a'), 'apiKey'), { error: error(body) }, NOW),
  ).toBeUndefined()
  expect(
    await codexReset(ctx({ type: 'apiKey', key: 'sk-test' }), { error: error(body) }, NOW),
  ).toBeUndefined()
  expect(
    await codexReset(
      ctx(credential('acct-a'), 'oauth'),
      { error: error({ error: { type: 'insufficient_quota', resets_at: S + 600 } }) },
      NOW,
    ),
  ).toBeUndefined()
  expect(requests).toEqual([])
})

test('an error naming another account is refused, direct or looked up', async () => {
  noLookup()
  const body = {
    error: { type: 'usage_limit_reached', resets_at: S + 600, chatgpt_account_id: 'acct-b' },
  }
  expect(await codexReset(ctx(credential('acct-a')), { error: error(body) }, NOW)).toBeUndefined()
  expect(
    await codexReset(
      ctx(credential(undefined)),
      { error: error({ error: { type: 'usage_limit_reached', account_id: 'acct-a' } }) },
      NOW,
    ),
  ).toBeUndefined()
  expect(requests).toEqual([])
})

test('several windows wait for the last exhausted one, never guessing which window blocked', async () => {
  serve(
    usage({ used_percent: 100, reset_at: S + 300 }, { used_percent: 100, reset_at: S + 10_080 }),
  )
  expect(
    await codexReset(
      ctx(),
      { error: error({ error: { type: 'usage_limit_reached', account_id: 'acct-a' } }) },
      NOW,
    ),
  ).toBe((S + 10_080) * 1000)
  serve(usage({ used_percent: 100, reset_at: S + 300 }, { used_percent: 40, reset_at: S + 10_080 }))
  expect(
    await codexReset(
      ctx(),
      { error: error({ error: { type: 'usage_limit_reached', account_id: 'acct-a' } }) },
      NOW,
    ),
  ).toBe((S + 300) * 1000)
  serve(usage({ used_percent: 99, reset_at: S + 120 }, { used_percent: 50, reset_at: S + 10_080 }))
  expect(
    await codexReset(
      ctx(),
      { error: error({ error: { type: 'usage_limit_reached', account_id: 'acct-a' } }) },
      NOW,
    ),
  ).toBeUndefined()
})
