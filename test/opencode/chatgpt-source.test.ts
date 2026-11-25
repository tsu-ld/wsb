import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { chatgptSource } from '../../src/opencode/sources/chatgpt.ts'
import type { ConnectionAPI, ErrorEvent } from '../../src/opencode/sources/chatgpt.ts'
import type { Fetch } from '../../src/vendors/chatgpt.ts'
import type { Wire } from '../../src/wire.ts'

const NOW = 1_700_000_000_000
const S = NOW / 1000

type Call = Readonly<{ url: string; init?: RequestInit }>
type Fields = { readonly [key: string]: Wire }

const credential = (accountID?: string): Wire => ({
  type: 'oauth',
  access: 'tok',
  metadata: accountID ? { accountID } : {},
})

const api =
  (cred: Wire = credential('acct-a'), method = 'oauth') =>
  (): ConnectionAPI => ({
    active: async () => ({ method }),
    resolve: async () => cred,
  })

const error = (body: Wire, type = 'provider.chatgpt-limit'): ErrorEvent => ({
  error: { type, response: { body: JSON.stringify(body) } },
})

const limit = (extra: Fields = {}) => error({ error: { type: 'usage_limit_reached', ...extra } })
const sharingLimit = () => error({ error: { code: 'subscription_sharing_usage_limit_exceeded' } })

const serve = (payload: Wire) => {
  const calls: Array<Call> = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    return Response.json(payload)
  }
  return { calls, fetch }
}

const noLookup = () => {
  const calls: Array<Call> = []
  const fetch: Fetch = async (url) => {
    calls.push({ url })
    throw new Error('lookup must not run')
  }
  return { calls, fetch }
}

const exhausted = (reset_at: number) => ({
  rate_limit: {
    limit_reached: true,
    allowed: false,
    primary_window: { used_percent: 100, reset_at },
  },
})

describe('chatgptSource', () => {
  it('an unattributed failure cannot borrow the active account; stale matching reset triggers a fresh read', async () => {
    const { calls, fetch } = serve(exhausted(S + 90))
    const source = chatgptSource({ fetch, connection: api() })
    expect(await source.atError(limit(), undefined, NOW)).toEqual({
      kind: 'unknown',
      reason: 'no account in the refusal',
    })
    expect(calls).toHaveLength(0)
    expect(
      await source.atError(limit({ account_id: 'acct-a', resets_at: S - 1 }), undefined, NOW),
    ).toEqual({ kind: 'until', until: NOW + 90_000 })
    expect(calls).toHaveLength(1)
  })

  it('an unattributed sharing limit uses the Codex CLI login for the quota lookup', async () => {
    const { calls, fetch } = serve(exhausted(S + 90))
    const source = chatgptSource({
      fetch,
      connection: api(credential()),
      codexLogin: async () => ({ token: 'ctok', account: 'acct-c' }),
    })
    expect(await source.atError(sharingLimit(), undefined, NOW)).toEqual({
      kind: 'until',
      until: NOW + 90_000,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer ctok',
      'ChatGPT-Account-Id': 'acct-c',
    })
  })

  it('an unattributed sharing limit without a Codex CLI login remains unknown', async () => {
    const { calls, fetch } = noLookup()
    const source = chatgptSource({
      fetch,
      connection: api(credential()),
      codexLogin: async () => undefined,
    })
    expect(await source.atError(sharingLimit(), undefined, NOW)).toEqual({
      kind: 'unknown',
      reason:
        'Sign in with ChatGPT gives no reset time; run `codex login` or reconnect OpenAI with Codex browser (legacy)',
    })
    expect(calls).toEqual([])
  })

  it('the default Codex login reader uses CODEX_HOME and rejects unusable files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wsb-codex-'))
    const previous = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = dir
    const { calls, fetch } = serve(exhausted(S + 90))
    try {
      const source = chatgptSource({ fetch, connection: api(credential()) })
      const file = join(dir, 'auth.json')
      const unknown = {
        kind: 'unknown',
        reason:
          'Sign in with ChatGPT gives no reset time; run `codex login` or reconnect OpenAI with Codex browser (legacy)',
      } as const
      expect(await source.atError(sharingLimit(), undefined, NOW)).toEqual(unknown)
      for (const value of [
        { auth_mode: 'apiKey', tokens: { access_token: 'ctok', account_id: 'acct-c' } },
        { auth_mode: 'chatgpt', tokens: { access_token: 'ctok' } },
        { auth_mode: 'chatgpt', tokens: { account_id: 'acct-c' } },
      ]) {
        await writeFile(file, JSON.stringify(value))
        expect(await source.atError(sharingLimit(), undefined, NOW)).toEqual(unknown)
      }
      expect(calls).toEqual([])
      await writeFile(
        file,
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { access_token: 'ctok', account_id: 'acct-c' },
        }),
      )
      expect(await source.atError(sharingLimit(), undefined, NOW)).toEqual({
        kind: 'until',
        until: NOW + 90_000,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.init?.headers).toMatchObject({
        Authorization: 'Bearer ctok',
        'ChatGPT-Account-Id': 'acct-c',
      })
      await writeFile(file, '{')
      expect(await source.atError(sharingLimit(), undefined, NOW)).toEqual(unknown)
      expect(calls).toHaveLength(1)
    } finally {
      if (previous === undefined) {
        delete process.env['CODEX_HOME']
      } else {
        process.env['CODEX_HOME'] = previous
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an HTTP refusal without account in the body can use the original ChatGPT request identity', async () => {
    const reset = NOW + 90_000
    const { calls, fetch } = serve(exhausted(reset))
    const response = Response.json({ error: { type: 'usage_limit_reached' } }, { status: 429 })
    const init = { headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'acct-b' } }
    const from = (origin: string) => ({
      kind: 'primary',
      request: new Request(`${origin}/backend-api/codex/responses`, init),
      response,
    })
    const source = chatgptSource({ fetch })
    expect((await source.atResponse(from('https://example.invalid'), NOW)).kind).toBe('other')
    expect(calls).toHaveLength(0)
    expect(await source.atResponse(from('https://chatgpt.com'), NOW)).toEqual({
      kind: 'until',
      until: reset,
    })
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer fixture',
      'ChatGPT-Account-Id': 'acct-b',
    })
    expect(response.bodyUsed).toBe(false)
  })

  it('direct reset in the error is absolute, in seconds or milliseconds', async () => {
    const { calls, fetch } = noLookup()
    const source = chatgptSource({ fetch, connection: api() })
    expect(await source.atError(limit({ resets_at: S + 600 }), undefined, NOW)).toEqual({
      kind: 'until',
      until: (S + 600) * 1000,
    })
    expect(await source.atError(limit({ resetsAt: (S + 60) * 1000 }), undefined, NOW)).toEqual({
      kind: 'until',
      until: (S + 60) * 1000,
    })
    expect(await source.atError(limit({ resets_in_seconds: 90 }), undefined, NOW)).toEqual({
      kind: 'until',
      until: NOW + 90_000,
    })
    expect(calls).toEqual([])
  })

  it('without an explicit reset, the error stage looks up the quota with the oauth token', async () => {
    const { calls, fetch } = serve(exhausted(S + 3600))
    const source = chatgptSource({ fetch, connection: api(credential('acct-a')) })
    expect(await source.atError(limit({ account_id: 'acct-a' }), undefined, NOW)).toEqual({
      kind: 'until',
      until: (S + 3600) * 1000,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'ChatGPT-Account-Id': 'acct-a',
    })
    expect(calls[0]?.init?.redirect).toBe('error')
  })

  it('without the connection API the error is not read', async () => {
    const { calls, fetch } = noLookup()
    expect(
      (await chatgptSource({ fetch }).atError(limit({ account_id: 'acct-a' }), undefined, NOW))
        .kind,
    ).toBe('other')
    expect(
      (
        await chatgptSource({ fetch, connection: () => undefined }).atError(
          limit({ account_id: 'acct-a' }),
          undefined,
          NOW,
        )
      ).kind,
    ).toBe('other')
    expect(calls).toEqual([])
  })

  it('an API key connection is metered and never continues on a subscription reset', async () => {
    const { calls, fetch } = noLookup()
    const body = { resets_at: S + 600 }
    expect(
      (
        await chatgptSource({ fetch, connection: api(credential('acct-a'), 'apiKey') }).atError(
          limit(body),
          undefined,
          NOW,
        )
      ).kind,
    ).toBe('other')
    expect(
      (
        await chatgptSource({ fetch, connection: api({ type: 'apiKey', key: 'sk-test' }) }).atError(
          limit(body),
          undefined,
          NOW,
        )
      ).kind,
    ).toBe('other')
    expect(
      (
        await chatgptSource({ fetch, connection: api(credential('acct-a')) }).atError(
          error({ error: { type: 'insufficient_quota', resets_at: S + 600 } }),
          undefined,
          NOW,
        )
      ).kind,
    ).toBe('other')
    expect(calls).toEqual([])
  })

  it('a code that is not waitable vetoes the host limit type', async () => {
    const { calls, fetch } = noLookup()
    expect(
      await chatgptSource({ fetch, connection: api() }).atError(
        error(
          { error: { code: 'insufficient_quota', message: 'quota' } },
          'provider.chatgpt-limit',
        ),
        { kind: 'until', until: NOW + 60_000 },
        NOW,
      ),
    ).toEqual({ kind: 'other', reason: 'not waitable' })
    expect(calls).toEqual([])
  })

  it('an error naming another account is refused, direct or looked up', async () => {
    const { calls, fetch } = noLookup()
    const body = { resets_at: S + 600, chatgpt_account_id: 'acct-b' }
    expect(
      (
        await chatgptSource({ fetch, connection: api(credential('acct-a')) }).atError(
          limit(body),
          undefined,
          NOW,
        )
      ).kind,
    ).toBe('other')
    expect(
      (
        await chatgptSource({ fetch, connection: api(credential(undefined)) }).atError(
          limit({ account_id: 'acct-a' }),
          undefined,
          NOW,
        )
      ).kind,
    ).toBe('other')
    expect(calls).toEqual([])
  })

  it('a camelCase account B under oauth account A refuses even a future direct reset', async () => {
    const { calls, fetch } = noLookup()
    expect(
      await chatgptSource({ fetch, connection: api(credential('A')) }).atError(
        limit({ accountId: 'B', resets_at: S + 600 }),
        undefined,
        NOW,
      ),
    ).toEqual({ kind: 'other', reason: 'refusal for another account' })
    expect(calls).toEqual([])
  })

  it('a plausible earlier reading wins over a lookup when the error has no direct reset', async () => {
    const { calls, fetch } = noLookup()
    const earlier = { kind: 'until', until: NOW + 60_000 } as const
    expect(
      await chatgptSource({ fetch, connection: api() }).atError(
        limit({ account_id: 'acct-a' }),
        earlier,
        NOW,
      ),
    ).toBe(earlier)
    expect(calls).toEqual([])
  })
})
