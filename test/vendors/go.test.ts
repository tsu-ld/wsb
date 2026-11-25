import { describe, expect, it } from 'bun:test'
import {
  REFUSAL_STATUSES,
  inferenceRequest,
  parseRefusal,
  readUsage,
  windowDelay,
} from '../../src/vendors/go.ts'
import type { Fetch } from '../../src/vendors/go.ts'
import type { Wire } from '../../src/wire.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WORKSPACE = 'wrk_go'
const NOW = Date.parse('2026-11-21T12:00:00.000Z')
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

type Call = Readonly<{ url: string; init: RequestInit }>

const limited = (resetsAt: Wire | undefined) =>
  resetsAt === undefined
    ? { percent: 100, status: 'rate-limited' }
    : { percent: 100, status: 'rate-limited', resetsAt }
const clear = (resetsAt: number) => ({
  percent: 10,
  status: 'ok',
  resetsAt: new Date(resetsAt).toISOString(),
})
const usage = (
  rolling: Wire,
  weekly: Wire = clear(NOW + 20 * DAY),
  monthly: Wire = clear(NOW + 30 * DAY),
) => ({
  usage: { rolling, weekly, monthly },
})
const readOnce = (payload: Wire, status = 200) => {
  const calls: Array<Call> = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, fetch }
}
const read = (fetch: Fetch, now = NOW) =>
  readUsage({ authorization: 'Bearer test', org: WORKSPACE, fetch, now })
const notUntil = (reading: { kind: string }) => expect(reading.kind).not.toBe('until')

describe('Go vendor', () => {
  it('reports the latest limited Go window with the given credential', async () => {
    const { calls, fetch } = readOnce(
      usage(limited(NOW + HOUR), limited(NOW + 2 * DAY), clear(NOW - DAY)),
    )
    expect(await read(fetch)).toEqual({ kind: 'until', until: NOW + 2 * DAY })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(USAGE_URL)
    expect(calls[0]?.init.headers).toEqual({
      authorization: 'Bearer test',
      'x-opencode-org-id': WORKSPACE,
    })
    expect(calls[0]?.init.redirect).toBe('error')
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('recognizes only Go inference requests and refusal statuses', () => {
    expect(inferenceRequest('https://opencode.ai/zen/go/v1/messages')).toBe(true)
    expect(inferenceRequest('https://not-opencode.invalid/zen/go/v1/messages')).toBe(false)
    expect(inferenceRequest('https://opencode.ai/zen/go/v2/messages')).toBe(false)
    expect(inferenceRequest('not a url')).toBe(false)
    expect([...REFUSAL_STATUSES].toSorted((a, b) => a - b)).toEqual([402, 403, 429])
  })

  it('leaves an incomplete, unavailable or unreadable usage answer unknown', async () => {
    const payloads: Array<Wire> = [
      usage(limited(NOW + HOUR), { status: 'rate-limited' }, clear(NOW + 30 * DAY)),
      usage(limited(NOW + HOUR), {
        status: 'unknown',
        resetsAt: new Date(NOW + DAY).toISOString(),
      }),
      { usage: { rolling: limited(NOW + HOUR), weekly: clear(NOW + DAY) } },
      { usage: null },
    ]
    for (const payload of payloads) {
      expect((await read(readOnce(payload).fetch)).kind).toBe('unknown')
    }
    expect((await read(readOnce(usage(limited(NOW + HOUR)), 403).fetch)).kind).toBe('unknown')
    expect((await read(async () => new Response('not json'))).kind).toBe('unknown')
    expect(
      (
        await read(async () => {
          throw new Error('offline')
        })
      ).kind,
    ).toBe('unknown')
  })

  it('leaves stale, malformed or missing limited resets unknown', async () => {
    for (const resetsAt of [NOW - 1, 'soon', null, undefined]) {
      expect((await read(readOnce(usage(limited(resetsAt))).fetch)).kind).toBe('unknown')
    }
    const { fetch } = readOnce(usage(limited(NOW + HOUR), limited('soon'), limited(NOW + DAY)))
    expect((await read(fetch)).kind).toBe('unknown')
  })

  it('produces no wait when all Go meters are clear', async () => {
    const { fetch } = readOnce(usage(clear(NOW + HOUR), clear(NOW + DAY), clear(NOW - DAY)))
    notUntil(await read(fetch))
  })

  it('reads absolute resets from top-level and nested error metadata', () => {
    const at = NOW + 45 * 60_000
    expect(
      parseRefusal({
        type: 'error',
        error: {
          type: 'GoUsageLimitError',
          metadata: { workspace: WORKSPACE, resetsAt: String(at) },
        },
      }),
    ).toEqual({ workspace: WORKSPACE, absolute: { present: true, at } })
    expect(
      parseRefusal({ metadata: { workspace: WORKSPACE, resetsAt: new Date(at).toISOString() } }),
    ).toEqual({ workspace: WORKSPACE, absolute: { present: true, at } })
    expect(
      parseRefusal({ metadata: { workspace: WORKSPACE, limitName: 'rolling', resetsAt: 'soon' } }),
    ).toEqual({ workspace: WORKSPACE, absolute: { present: true }, window: 5 * HOUR })
  })

  it('anchors a retry delay to now and keeps it inside the named window', () => {
    const rolling = parseRefusal({
      metadata: { workspace: WORKSPACE, limitName: 'rolling' },
    }).window
    expect(windowDelay(60_000, rolling, NOW)).toEqual({ kind: 'until', until: NOW + 60_000 })
    expect(windowDelay(4 * HOUR, rolling, NOW)).toEqual({ kind: 'until', until: NOW + 4 * HOUR })
    const monthly = parseRefusal({
      error: { type: 'GoUsageLimitError' },
      metadata: { workspace: WORKSPACE, limitName: 'monthly' },
    }).window
    expect(windowDelay(20 * DAY, monthly, NOW)).toEqual({ kind: 'until', until: NOW + 20 * DAY })
    for (const retryAfterMs of [0, -1, 1.5, 6 * HOUR, 46 * DAY]) {
      expect(windowDelay(retryAfterMs, rolling, NOW).kind).toBe('unknown')
    }
  })

  it('refuses a delay without a known window', () => {
    const fortnight = parseRefusal({
      error: { type: 'GoUsageLimitError' },
      metadata: { workspace: WORKSPACE, limitName: 'fortnight' },
    }).window
    expect(fortnight).toBeUndefined()
    expect(windowDelay(HOUR, fortnight, NOW).kind).toBe('unknown')
    expect(windowDelay(undefined, 5 * HOUR, NOW).kind).toBe('unknown')
  })
})
