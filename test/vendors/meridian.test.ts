import { describe, expect, it } from 'bun:test'
import { read } from '../../src/vendors/meridian.ts'
import type { Reading } from '../../src/deadline.ts'
import type { Fetch, MeridianRefusal } from '../../src/vendors/meridian.ts'

const NOW = 1_795_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

const bucket = (type: string, status: string, resetsAt: unknown, utilization = 1) => ({
  type,
  status,
  utilization,
  resetsAt,
  isUsingOverage: false,
  overageStatus: null,
  overageResetsAt: null,
  overageDisabledReason: null,
  surpassedThreshold: null,
  observedAt: NOW - 1000,
})

type SeatPatch = Readonly<{
  isActive?: boolean
  type?: string | undefined
  stale?: boolean
  error?: string
  fetchedAt?: number
}>

const seat = (id: string, extra: SeatPatch = {}) => ({
  id,
  isActive: true,
  type: 'claude-max',
  windows: [],
  extraUsage: null,
  bankedResets: null,
  fetchedAt: NOW - 5000,
  stale: false,
  error: null,
  failure: null,
  spent: null,
  ...extra,
})

const all = (profiles: ReadonlyArray<{ id: string }>) => ({
  profiles,
  activeProfile: profiles[0]?.id ?? null,
  asOf: NOW,
})

const quota = (profile: string, buckets: ReadonlyArray<object>, fetchedAt = NOW - 5000) => ({
  profile,
  buckets,
  extraUsage: null,
  sources: { oauth: { fetchedAt }, sdk: { entryCount: buckets.length } },
  asOf: NOW,
})

const limited = (extra: Readonly<{ retry_after?: number }> = {}) => ({
  type: 'error',
  retry_after: 60,
  error: {
    type: 'rate_limit_error',
    message: 'Claude Max rate limit reached. Wait a moment and try again.',
  },
  ...extra,
})

type Route = (url: URL, init: RequestInit) => Response

const source = (routes: Readonly<{ [path: string]: Route }>) => {
  const calls: Array<string> = []
  const requests: Array<{ url: URL; init: RequestInit }> = []
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push(url.pathname + url.search)
    requests.push({ url, init })
    const handler = routes[url.pathname]
    return handler ? handler(url, init) : new Response('missing', { status: 404 })
  }
  return { calls, requests, fetch }
}

const healthy = (id: string, buckets: ReadonlyArray<object>) => ({
  '/v1/usage/quota/all': () => Response.json(all([seat(id)])),
  '/v1/usage/quota': () => Response.json(quota(id, buckets)),
})

const refusal = (fetch: Fetch, extra: Partial<MeridianRefusal> = {}): MeridianRefusal => ({
  origin: 'http://127.0.0.1:3456/v1/messages',
  key: null,
  modelID: 'claude-sonnet-4-5',
  status: 429,
  body: limited(),
  fetch,
  now: NOW,
  ...extra,
})

const until = (at: number): Reading => ({ kind: 'until', until: at })

describe('meridian.read', () => {
  it('resumes at the latest rejected subscription window', async () => {
    const { calls, fetch } = source(
      healthy('work', [
        bucket('five_hour', 'rejected', NOW + HOUR),
        bucket('seven_day', 'rejected', NOW + 3 * DAY),
        bucket('seven_day_sonnet', 'allowed', NOW + DAY, 0.4),
      ]),
    )
    expect(await read(refusal(fetch))).toEqual(until(NOW + 3 * DAY))
    expect(calls).toEqual(['/v1/usage/quota/all', '/v1/usage/quota?profile=work'])
  })

  it('takes the reset from the quota, not from Retry-After', async () => {
    const { fetch } = source(healthy('work', [bucket('five_hour', 'rejected', NOW + 2 * HOUR)]))
    expect(await read(refusal(fetch, { body: limited({ retry_after: 60 }) }))).toEqual(
      until(NOW + 2 * HOUR),
    )
  })

  it('a transient 429 without a rejected window is not a quota alarm', async () => {
    const { fetch } = source(
      healthy('work', [bucket('five_hour', 'allowed_warning', NOW + HOUR, 0.91)]),
    )
    expect(await read(refusal(fetch))).toEqual({ kind: 'unknown', reason: 'no rejected window' })
  })

  it('a Fable window does not alarm another model and an unknown window is not guessed', async () => {
    for (const modelID of ['claude-sonnet-4-5', 'unrelated']) {
      const { fetch } = source(healthy('work', [bucket('seven_day_fable', 'rejected', NOW + HOUR)]))
      expect((await read(refusal(fetch, { modelID }))).kind).toBe('unknown')
    }
  })

  it('an exhausted opus window does not alarm a sonnet turn', async () => {
    const { fetch } = source(
      healthy('work', [
        bucket('five_hour', 'allowed', NOW + HOUR, 0.2),
        bucket('seven_day', 'allowed', NOW + 3 * DAY, 0.3),
        bucket('seven_day_opus', 'rejected', NOW + 2 * DAY),
      ]),
    )
    expect((await read(refusal(fetch))).kind).toBe('unknown')
  })

  it('model-specific limits apply to their own model family', async () => {
    for (const modelID of ['claude-opus-5-5', 'claude-fable-5-2']) {
      const { fetch } = source(
        healthy('work', [
          bucket('five_hour', 'allowed', NOW + HOUR, 0.2),
          bucket('seven_day', 'allowed', NOW + 3 * DAY, 0.3),
          bucket('seven_day_opus', 'rejected', NOW + 2 * DAY),
        ]),
      )
      const reading = await read(refusal(fetch, { modelID }))
      if (modelID.includes('opus')) {
        expect(reading).toEqual(until(NOW + 2 * DAY))
      } else {
        expect(reading.kind).toBe('unknown')
      }
    }
    const { fetch } = source(healthy('work', [bucket('seven_day_fable', 'rejected', NOW + HOUR)]))
    expect(await read(refusal(fetch, { modelID: 'claude-fable-5-2' }))).toEqual(until(NOW + HOUR))
  })

  it('an exhausted sonnet window does not alarm an opus turn', async () => {
    const { fetch } = source(
      healthy('work', [
        bucket('seven_day', 'allowed', NOW + 3 * DAY, 0.3),
        bucket('seven_day_sonnet', 'rejected', NOW + DAY),
      ]),
    )
    expect((await read(refusal(fetch, { modelID: 'claude-opus-5-5' }))).kind).toBe('unknown')
  })

  it('a rejected overage window is not a subscription reset', async () => {
    const { fetch } = source(healthy('work', [bucket('overage', 'rejected', NOW + HOUR)]))
    expect((await read(refusal(fetch))).kind).toBe('unknown')
  })

  it('two Claude seats without an explicit profile are ambiguous', async () => {
    const { calls, fetch } = source({
      '/v1/usage/quota/all': () => Response.json(all([seat('work'), seat('personal')])),
      '/v1/usage/quota': () =>
        Response.json(quota('work', [bucket('five_hour', 'rejected', NOW + HOUR)])),
    })
    expect(await read(refusal(fetch))).toEqual({
      kind: 'unknown',
      reason: 'several subscription seats',
    })
    expect(calls).toEqual(['/v1/usage/quota/all'])
  })

  it('an inactive seat is not attributed by inference', async () => {
    const { calls, fetch } = source({
      '/v1/usage/quota/all': () => Response.json(all([seat('work', { isActive: false })])),
    })
    expect(await read(refusal(fetch))).toEqual({ kind: 'unknown', reason: 'seat not active' })
    expect(calls).toEqual(['/v1/usage/quota/all'])
  })

  it('the single default seat is attributed when no profile is configured', async () => {
    const { calls, fetch } = source({
      '/v1/usage/quota/all': () => Response.json(all([seat('default', { type: undefined })])),
      '/v1/usage/quota': () =>
        Response.json(quota('default', [bucket('five_hour', 'rejected', NOW + HOUR)])),
    })
    expect(await read(refusal(fetch))).toEqual(until(NOW + HOUR))
    expect(calls).toEqual(['/v1/usage/quota/all', '/v1/usage/quota?profile=default'])
  })

  it('an API-key seat is not a Claude subscription', async () => {
    const { calls, fetch } = source({
      '/v1/usage/quota/all': () => Response.json(all([seat('api', { type: 'api' })])),
    })
    expect(await read(refusal(fetch))).toEqual({ kind: 'unknown', reason: 'no subscription seat' })
    expect(calls).toEqual(['/v1/usage/quota/all'])
  })

  it('stale or failed quota reads are not a reset', async () => {
    for (const extra of [
      { stale: true },
      { error: 'rate_limited' },
      { fetchedAt: NOW - 16 * 60 * 1000 },
    ]) {
      const { calls, fetch } = source({
        '/v1/usage/quota/all': () => Response.json(all([seat('work', extra)])),
      })
      expect(await read(refusal(fetch))).toEqual({ kind: 'unknown', reason: 'seat data stale' })
      expect(calls).toEqual(['/v1/usage/quota/all'])
    }
  })

  it('a stale OAuth snapshot behind the quota route is not a reset', async () => {
    const { fetch } = source({
      '/v1/usage/quota/all': () => Response.json(all([seat('work')])),
      '/v1/usage/quota': () =>
        Response.json(
          quota('work', [bucket('five_hour', 'rejected', NOW + HOUR)], NOW - 16 * 60 * 1000),
        ),
    })
    expect(await read(refusal(fetch))).toEqual({ kind: 'unknown', reason: 'quota snapshot stale' })
  })

  it('a missing OAuth snapshot in the quota route is not a reset', async () => {
    const { fetch } = source({
      '/v1/usage/quota/all': () => Response.json(all([seat('work')])),
      '/v1/usage/quota': () =>
        Response.json({ ...quota('work', []), sources: { oauth: null, sdk: { entryCount: 1 } } }),
    })
    expect(await read(refusal(fetch))).toEqual({
      kind: 'unknown',
      reason: 'quota without oauth snapshot',
    })
  })

  it('a quota response for another profile is ignored', async () => {
    const { fetch } = source({
      '/v1/usage/quota/all': () => Response.json(all([seat('work')])),
      '/v1/usage/quota': () =>
        Response.json(quota('personal', [bucket('five_hour', 'rejected', NOW + HOUR)])),
    })
    expect(await read(refusal(fetch))).toEqual({
      kind: 'unknown',
      reason: 'quota for another seat',
    })
  })

  it('a reset must be epoch milliseconds in the future', async () => {
    for (const resetsAt of [
      NOW - 1,
      Math.floor((NOW + HOUR) / 1000),
      String(NOW + HOUR),
      null,
      NOW + 30 * DAY,
    ]) {
      const { fetch } = source(healthy('work', [bucket('five_hour', 'rejected', resetsAt)]))
      expect((await read(refusal(fetch))).kind).toBe('unknown')
    }
  })

  it('a rejected window without a reset is not a quota alarm', async () => {
    const { fetch } = source(healthy('work', [bucket('five_hour', 'rejected', null)]))
    expect(await read(refusal(fetch))).toEqual({ kind: 'unknown', reason: 'no usable reset' })
  })

  it('non-quota failures never read Meridian', async () => {
    const { calls, fetch } = source({})
    const events = [
      {
        status: 401,
        error: { type: 'authentication_error', message: 'Claude authentication expired' },
      },
      { status: 402, error: { type: 'billing_error', message: 'Claude Max subscription issue' } },
      { status: 403, error: { type: 'permission_error', message: 'forbidden' } },
      { status: 500, error: { type: 'api_error', message: 'server error' } },
      { status: 503, error: { type: 'overloaded_error', message: 'overloaded' } },
      { status: 529, error: { type: 'overloaded_error', message: 'overloaded' } },
      { status: 200 },
      {},
    ]
    for (const { status, ...body } of events) {
      expect((await read(refusal(fetch, { status, body }))).kind).toBe('other')
    }
    expect(calls).toEqual([])
  })

  it('a wrapped rate limit error without a status is not a Claude subscription limit', async () => {
    const { calls, fetch } = source(healthy('work', [bucket('five_hour', 'rejected', NOW + HOUR)]))
    const body = { error: { type: 'rate_limit_error', message: 'rate limit' } }
    expect(await read(refusal(fetch, { status: undefined, body }))).toEqual({
      kind: 'other',
      reason: 'not a Claude subscription limit',
    })
    expect(calls).toEqual([])
  })

  it('a wrapped subscription limit without a status still reads quota', async () => {
    const { fetch } = source(healthy('work', [bucket('five_hour', 'rejected', NOW + HOUR)]))
    const body = {
      error: { type: 'rate_limit_error', message: 'Claude Max rate limit reached.' },
    }
    expect(await read(refusal(fetch, { status: undefined, body }))).toEqual({
      kind: 'until',
      until: NOW + HOUR,
    })
  })

  it('a non-loopback address is never contacted', async () => {
    const { calls, fetch } = source(healthy('work', [bucket('five_hour', 'rejected', NOW + HOUR)]))
    for (const origin of [
      'https://meridian.example.com',
      'http://127.0.0.1.example.com:3456',
      'http://10.0.0.2:3456',
      'http://user:pass@127.0.0.1:3456',
    ]) {
      expect((await read(refusal(fetch, { origin }))).kind).toBe('other')
    }
    expect(calls).toEqual([])
  })

  it('a loopback IPv6 origin is accepted', async () => {
    const { fetch } = source(healthy('work', [bucket('five_hour', 'rejected', NOW + HOUR)]))
    expect(await read(refusal(fetch, { origin: 'http://[::1]:3456' }))).toEqual(until(NOW + HOUR))
  })

  it('sends the configured proxy key only to the loopback listener', async () => {
    const { requests, fetch } = source(
      healthy('work', [bucket('five_hour', 'rejected', NOW + HOUR)]),
    )
    expect(await read(refusal(fetch, { key: 'local-key' }))).toEqual(until(NOW + HOUR))
    expect(requests.map(({ init }) => new Headers(init.headers).get('x-api-key'))).toEqual([
      'local-key',
      'local-key',
    ])
  })

  it('fails closed on a missing route, bad JSON or an unreachable listener', async () => {
    const missing = source({})
    expect((await read(refusal(missing.fetch))).kind).toBe('unknown')

    const garbage = source({ '/v1/usage/quota/all': () => new Response('not json') })
    expect((await read(refusal(garbage.fetch))).kind).toBe('unknown')

    const broken = source({
      '/v1/usage/quota/all': () => {
        throw new Error('connection refused')
      },
    })
    expect((await read(refusal(broken.fetch))).kind).toBe('unknown')

    const unauthorized = source({
      '/v1/usage/quota/all': () => new Response('no', { status: 401 }),
    })
    expect((await read(refusal(unauthorized.fetch))).kind).toBe('unknown')
  })

  it('a nested 403 inside a 429 vetoes before any quota request', async () => {
    const { calls, fetch } = source(healthy('work', [bucket('five_hour', 'rejected', NOW + HOUR)]))
    const body = {
      error: { type: 'rate_limit_error', message: 'Claude Max rate limit reached', status: 403 },
    }
    expect((await read(refusal(fetch, { status: 429, body }))).kind).toBe('other')
    expect(calls).toEqual([])
  })

  it('a message that names billing is not a quota refusal', async () => {
    const { calls, fetch } = source(healthy('work', [bucket('five_hour', 'rejected', NOW + HOUR)]))
    const body = {
      error: { type: 'rate_limit_error', message: 'Claude Max rate limit reached: billing hold' },
    }
    expect((await read(refusal(fetch, { body }))).kind).toBe('other')
    expect(calls).toEqual([])
  })
})
