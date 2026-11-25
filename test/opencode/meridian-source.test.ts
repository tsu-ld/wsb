import { describe, expect, it } from 'bun:test'
import { meridianSource } from '../../src/opencode/sources/meridian.ts'
import type { ResponseEvent } from '../../src/opencode/sources/meridian.ts'
import type { Fetch } from '../../src/vendors/meridian.ts'

const NOW = 1_795_000_000_000
const HOUR = 3_600_000

const recording = () => {
  const calls: Array<string> = []
  const fetch: Fetch = async (input) => {
    const url = new URL(input)
    calls.push(url.pathname + url.search)
    return url.pathname === '/v1/usage/quota/all'
      ? Response.json({
          profiles: [
            {
              id: 'work',
              isActive: true,
              type: 'claude-max',
              windows: [],
              fetchedAt: NOW - 5000,
              error: null,
            },
          ],
        })
      : Response.json({
          profile: 'work',
          buckets: [{ type: 'five_hour', status: 'rejected', resetsAt: NOW + HOUR }],
          sources: { oauth: { fetchedAt: NOW - 5000 } },
        })
  }
  return { calls, fetch }
}

const refused = (extra: Partial<ResponseEvent> = {}): ResponseEvent => ({
  sessionID: 'ses_a',
  kind: 'primary',
  model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
  request: new Request('http://127.0.0.1:3456/v1/messages', {
    headers: { 'x-opencode-session': 'ses_a' },
  }),
  response: Response.json(
    {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Claude Max rate limit reached. Wait a moment and try again.',
      },
    },
    { status: 429 },
  ),
  ...extra,
})

describe('meridianSource', () => {
  it('another or missing provider is never read', async () => {
    const { calls, fetch } = recording()
    const source = meridianSource(fetch)
    expect(
      (await source.atResponse(refused({ model: { providerID: 'openai', id: 'gpt' } }), NOW)).kind,
    ).toBe('other')
    expect(
      (await source.atResponse(refused({ model: { id: 'claude-sonnet-4-5' } }), NOW)).kind,
    ).toBe('other')
    expect(calls).toEqual([])
  })

  it('reads the quota for a primary refusal from its own session and leaves the body readable', async () => {
    const { calls, fetch } = recording()
    const event = refused()
    expect(await meridianSource(fetch).atResponse(event, NOW)).toEqual({
      kind: 'until',
      until: NOW + HOUR,
    })
    expect(calls).toEqual(['/v1/usage/quota/all', '/v1/usage/quota?profile=work'])
    expect(event.response.bodyUsed).toBe(false)
  })

  it('a title request or a request from another session is never read', async () => {
    const { calls, fetch } = recording()
    const source = meridianSource(fetch)
    expect((await source.atResponse(refused({ kind: 'title' }), NOW)).kind).toBe('other')
    const elsewhere = new Request('http://127.0.0.1:3456/v1/messages', {
      headers: { 'x-opencode-session': 'ses_b' },
    })
    expect((await source.atResponse(refused({ request: elsewhere }), NOW)).kind).toBe('other')
    expect(calls).toEqual([])
  })

  it('a 429 retry without an observed response is unknown', () => {
    expect(
      meridianSource(recording().fetch).atError({ error: { status: 429 } }, undefined, NOW),
    ).toEqual({
      kind: 'unknown',
      reason: 'no response observed',
    })
  })

  it('a 429 retry follows the observed reading; another status does not', () => {
    const source = meridianSource(recording().fetch)
    const earlier = { kind: 'until', until: NOW + HOUR } as const
    expect(source.atError({ error: { status: 429 } }, earlier, NOW)).toBe(earlier)
    expect(source.atError({ error: { status: 500 } }, earlier, NOW).kind).toBe('other')
  })
})
