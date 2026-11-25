import { describe, expect, it } from 'bun:test'
import { goSource } from '../../src/opencode/sources/go.ts'
import type { ErrorEvent, ResponseEvent } from '../../src/opencode/sources/go.ts'
import type { Reading } from '../../src/deadline.ts'
import type { Fetch } from '../../src/vendors/go.ts'
import type { Wire } from '../../src/wire.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WORKSPACE = 'wrk_go'
const NOW = Date.parse('2026-11-21T12:00:00.000Z')
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

type Call = Readonly<{ url: string; init: RequestInit }>

const limited = (resetsAt: number) => ({ percent: 100, status: 'rate-limited', resetsAt })
const clear = (resetsAt: number) => ({
  percent: 10,
  status: 'ok',
  resetsAt: new Date(resetsAt).toISOString(),
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
const inference = (
  url = 'https://opencode.ai/zen/go/v1/messages',
  headers: { [name: string]: string } = {
    authorization: 'Bearer test',
    'x-opencode-org-id': WORKSPACE,
  },
) => new Request(url, { headers })
const responseEvent = (overrides: Partial<ResponseEvent> = {}): ResponseEvent => ({
  model: { providerID: 'opencode-go' },
  kind: 'primary',
  response: new Response(null, { status: 429 }),
  request: inference(),
  ...overrides,
})
const failure = (
  overrides: Partial<{
    type: string
    retryAfterMs: number
    response: { body?: string | undefined }
  }> = {},
) => ({
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
const retryEvent = (error: ErrorEvent['error'] = failure()): ErrorEvent => ({
  model: { providerID: 'opencode-go' },
  error,
})
const absolute = (resetsAt: number | string, workspace = WORKSPACE) =>
  JSON.stringify({
    type: 'error',
    error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' },
    metadata: { workspace, limitName: 'rolling', resetsAt },
  })
const observeScope = (body: string, origin = 'https://opencode.ai') =>
  goSource({ fetch: readOnce({}, 403).fetch }).atResponse(
    responseEvent({
      request: inference(`${origin}/zen/go/v1/messages`),
      response: new Response(body, { status: 429 }),
    }),
    NOW,
  )
const until = (at: number): Reading => ({ kind: 'until', until: at })
const notUntil = (reading: Reading) => expect(reading.kind).not.toBe('until')

describe('Go source', () => {
  it('reads the usage route with the inference credential', async () => {
    const { calls, fetch } = readOnce({
      usage: {
        rolling: limited(NOW + HOUR),
        weekly: limited(NOW + 2 * DAY),
        monthly: clear(NOW - DAY),
      },
    })
    expect(await goSource({ fetch }).atResponse(responseEvent(), NOW)).toEqual(until(NOW + 2 * DAY))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(USAGE_URL)
    expect(calls[0]?.init.headers).toEqual({
      authorization: 'Bearer test',
      'x-opencode-org-id': WORKSPACE,
    })
    expect(calls[0]?.init.redirect).toBe('error')
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('never calls the usage route for foreign origins, routes, missing credentials or unrelated responses', async () => {
    let calls = 0
    const fetch: Fetch = async () => {
      calls += 1
      return new Response(null, { status: 403 })
    }
    const source = goSource({ fetch })
    const events = [
      responseEvent({ request: inference('https://not-opencode.invalid/zen/go/v1/messages') }),
      responseEvent({ request: inference('https://opencode.ai/zen/go/v2/messages') }),
      responseEvent({ request: inference(undefined, { 'x-opencode-org-id': WORKSPACE }) }),
      responseEvent({ request: inference(undefined, { authorization: 'Basic test' }) }),
      responseEvent({ model: { providerID: 'anthropic' } }),
      responseEvent({ kind: 'secondary' }),
      responseEvent({ response: new Response(null, { status: 500 }) }),
    ]
    for (const event of events) {
      expect((await source.atResponse(event, NOW)).kind).toBe('other')
    }
    expect(calls).toBe(0)
  })

  it('uses a response-stage deadline only while it still points ahead', () => {
    const source = goSource()
    expect(source.atError(retryEvent(), until(NOW + HOUR), NOW)).toEqual(until(NOW + HOUR))
    notUntil(source.atError(retryEvent(), until(NOW - 1), NOW))
    notUntil(source.atError(retryEvent(), until(Number.NaN), NOW))
    notUntil(source.atError(retryEvent(), { kind: 'unknown', reason: 'soon' }, NOW))
    notUntil(source.atError(retryEvent(), until(NOW + HOUR), Number.NaN))
  })

  it('never turns a generic provider 429 into a Go reset', () => {
    const source = goSource()
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
      expect(source.atError(retryEvent(error), undefined, NOW).kind).toBe('other')
      expect(source.atError(retryEvent(error), until(NOW + HOUR), NOW).kind).toBe('other')
    }
    notUntil(source.atError(retryEvent(undefined), undefined, NOW))
    expect(source.atError({ model: { providerID: 'opencode-go' } }, undefined, NOW).kind).toBe(
      'other',
    )
  })

  it('confirms only Go limit failures', () => {
    const source = goSource()
    expect(source.atError(retryEvent(), undefined, NOW).kind).not.toBe('other')
    expect(
      source.atError(retryEvent(failure({ type: 'provider.rate-limit' })), undefined, NOW).kind,
    ).toBe('other')
    expect(
      source.atError({ ...retryEvent(), model: { providerID: 'anthropic' } }, undefined, NOW).kind,
    ).toBe('other')
  })

  it('takes a same-response absolute reset only for the observed workspace while it is ahead', async () => {
    const source = goSource()
    const at = NOW + 90 * 60_000
    const observed = await observeScope(absolute(at))
    expect(observed).toEqual(until(at))
    expect(
      source.atError(retryEvent(failure({ response: { body: absolute(at) } })), observed, NOW),
    ).toEqual(until(at))
    expect((await observeScope(absolute(at), 'https://not-opencode.invalid')).kind).toBe('other')
    notUntil(await observeScope(absolute(at, 'wrk_other')))
    notUntil(await observeScope(absolute(NOW - 1)))
    expect(
      source.atError(
        retryEvent(failure({ response: { body: absolute(at, 'wrk_other') } })),
        undefined,
        NOW,
      ).kind,
    ).toBe('unknown')
    expect(
      source.atError(retryEvent(failure({ response: { body: absolute(NOW - 1) } })), undefined, NOW)
        .kind,
    ).toBe('unknown')
    expect(
      goSource().atError(retryEvent(failure({ response: { body: absolute(at) } })), undefined, NOW)
        .kind,
    ).toBe('unknown')
  })

  it('reads absolute resets from top-level and nested error metadata end to end', async () => {
    const source = goSource()
    const at = NOW + 45 * 60_000
    const nested = JSON.stringify({
      type: 'error',
      error: {
        type: 'GoUsageLimitError',
        metadata: { workspace: WORKSPACE, resetsAt: String(at) },
      },
    })
    expect(
      source.atError(
        retryEvent(failure({ response: { body: nested } })),
        await observeScope(nested),
        NOW,
      ),
    ).toEqual(until(at))
    const top = JSON.stringify({
      metadata: { workspace: WORKSPACE, resetsAt: new Date(at).toISOString() },
    })
    expect(
      source.atError(
        retryEvent(failure({ response: { body: top } })),
        await observeScope(top),
        NOW,
      ),
    ).toEqual(until(at))
  })

  it('does not fall through to a retry delay after a malformed absolute reset', () => {
    const event = retryEvent(failure({ retryAfterMs: HOUR, response: { body: absolute('soon') } }))
    expect(goSource().atError(event, undefined, NOW).kind).toBe('unknown')
  })

  it('anchors a host retry delay to now inside the named window', () => {
    const source = goSource()
    expect(source.atError(retryEvent(failure({ retryAfterMs: 60_000 })), undefined, NOW)).toEqual(
      until(NOW + 60_000),
    )
    expect(source.atError(retryEvent(failure({ retryAfterMs: 4 * HOUR })), undefined, NOW)).toEqual(
      until(NOW + 4 * HOUR),
    )
    const monthly = JSON.stringify({
      error: { type: 'GoUsageLimitError' },
      metadata: { workspace: WORKSPACE, limitName: 'monthly' },
    })
    expect(
      source.atError(
        retryEvent(failure({ retryAfterMs: 20 * DAY, response: { body: monthly } })),
        undefined,
        NOW,
      ),
    ).toEqual(until(NOW + 20 * DAY))
    for (const retryAfterMs of [0, -1, 1.5, 6 * HOUR, 46 * DAY]) {
      expect(source.atError(retryEvent(failure({ retryAfterMs })), undefined, NOW).kind).toBe(
        'unknown',
      )
    }
  })

  it('refuses delays without a Go body or a known window', () => {
    const source = goSource()
    expect(source.atError(retryEvent(failure()), undefined, NOW).kind).toBe('unknown')
    const fortnight = JSON.stringify({
      error: { type: 'GoUsageLimitError' },
      metadata: { workspace: WORKSPACE, limitName: 'fortnight' },
    })
    for (const response of [{ body: fortnight }, { body: 'not json' }, { body: undefined }]) {
      expect(
        source.atError(retryEvent(failure({ retryAfterMs: HOUR, response })), undefined, NOW).kind,
      ).toBe('unknown')
    }
  })
})
