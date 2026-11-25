import { describe, expect, it } from 'bun:test'
import { inferenceRequest, parseRefusal, readUsage } from '../../src/vendors/chatgpt.ts'
import type { Fetch } from '../../src/vendors/chatgpt.ts'
import type { Wire } from '../../src/wire.ts'

const NOW = 1_700_000_000_000
const S = NOW / 1000

type Call = Readonly<{ url: string; init: RequestInit }>
type Fields = { readonly [key: string]: Wire }

const limitBody = (extra: Fields) =>
  JSON.stringify({ error: { type: 'usage_limit_reached', ...extra } })

const usage = (primary: Fields, secondary?: Fields, reached = true) => ({
  rate_limit: {
    limit_reached: reached,
    allowed: !reached,
    primary_window: primary,
    secondary_window: secondary ?? null,
  },
})

const serve = (payload: Wire, ok = true) => {
  const calls: Array<Call> = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    return Response.json(payload, { status: ok ? 200 : 429 })
  }
  return { calls, fetch }
}

const read = (fetch: Fetch) => readUsage({ token: 'tok', account: 'acct-a', fetch, now: NOW })

describe('chatgpt vendor', () => {
  it('direct reset in the error is absolute, in seconds or milliseconds', () => {
    expect(parseRefusal(limitBody({ resets_at: S + 600 }), NOW)).toEqual({
      kind: 'limit',
      direct: (S + 600) * 1000,
    })
    expect(parseRefusal(limitBody({ resetsAt: (S + 60) * 1000 }), NOW).direct).toBe((S + 60) * 1000)
    expect(parseRefusal(limitBody({ resets_in_seconds: 90 }), NOW).direct).toBe(NOW + 90_000)
  })

  it('a relative reset is counted from the given now', () => {
    const body = { error: { resets_in_seconds: 90 } }
    expect(parseRefusal(body, NOW).direct).toBe(NOW + 90_000)
    expect(parseRefusal(body, NOW + 5000).direct).toBe(NOW + 95_000)
  })

  it('reads the account from the body and vetoes codes that are not waitable', () => {
    expect(
      parseRefusal(
        JSON.stringify({
          error: { type: 'usage_limit_reached', resets_at: S + 600, chatgpt_account_id: 'acct-b' },
        }),
        NOW,
      ),
    ).toEqual({ kind: 'limit', account: 'acct-b', direct: (S + 600) * 1000 })
    expect(
      parseRefusal(
        JSON.stringify({ error: { type: 'insufficient_quota', resets_at: S + 600 } }),
        NOW,
      ).kind,
    ).toBe('veto')
    expect(parseRefusal({ error: { type: 'something_else' } }, NOW).kind).toBe('unrecognized')
  })

  it('only ChatGPT codex requests are inference requests', () => {
    expect(inferenceRequest('https://example.invalid/backend-api/codex/responses')).toBe(false)
    expect(inferenceRequest('https://chatgpt.com/backend-api/codex/responses')).toBe(true)
  })

  it('without an explicit reset, the quota lookup returns the blocking window', async () => {
    const { calls, fetch } = serve(
      usage(
        { used_percent: 100, limit_window_seconds: 18_000, reset_at: S + 3600 },
        { used_percent: 40, reset_at: S + 86_400 },
      ),
    )
    expect(await read(fetch)).toEqual({ kind: 'until', until: (S + 3600) * 1000 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'ChatGPT-Account-Id': 'acct-a',
    })
    expect(calls[0]?.init.redirect).toBe('error')
  })

  it('a reset that is unknown or already spent is not guessed', async () => {
    const idle = serve(
      usage(
        { used_percent: 20, reset_at: S + 3600 },
        { used_percent: 10, reset_at: S + 86_400 },
        false,
      ),
    )
    expect((await read(idle.fetch)).kind).toBe('unknown')
    expect((await read(serve(usage({ used_percent: 100, reset_at: S - 60 })).fetch)).kind).toBe(
      'unknown',
    )
    expect(
      (
        await read(
          serve({ rate_limit: { limit_reached: true, primary_window: { used_percent: 100 } } })
            .fetch,
        )
      ).kind,
    ).toBe('unknown')
  })

  it('several windows wait for the last exhausted one, never guessing which window blocked', async () => {
    expect(
      await read(
        serve(
          usage(
            { used_percent: 100, reset_at: S + 300 },
            { used_percent: 100, reset_at: S + 10_080 },
          ),
        ).fetch,
      ),
    ).toEqual({ kind: 'until', until: (S + 10_080) * 1000 })
    expect(
      await read(
        serve(
          usage(
            { used_percent: 100, reset_at: S + 300 },
            { used_percent: 40, reset_at: S + 10_080 },
          ),
        ).fetch,
      ),
    ).toEqual({ kind: 'until', until: (S + 300) * 1000 })
    expect(
      (
        await read(
          serve(
            usage(
              { used_percent: 99, reset_at: S + 120 },
              { used_percent: 50, reset_at: S + 10_080 },
            ),
          ).fetch,
        )
      ).kind,
    ).toBe('unknown')
  })
})
