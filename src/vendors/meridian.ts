import { latestReset } from '../deadline.ts'
import { int, record, text } from '../wire.ts'
import type { Reading } from '../deadline.ts'
import type { Wire } from '../wire.ts'

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export type MeridianRefusal = Readonly<{
  origin: string
  key: string | null
  modelID: string
  status: number | undefined
  body: unknown
  fetch: Fetch
  now: number
}>

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i
const FRESH_MS = 15 * 60 * 1000
const AHEAD_MS = 8 * 24 * 60 * 60 * 1000
const SKEW_MS = 60 * 1000
const TIMEOUT_MS = 5000
const NON_QUOTA_STATUS = new Set([400, 401, 402, 403, 404, 405, 408, 409, 500, 502, 503, 504, 529])
const NON_QUOTA_TYPE = new Set([
  'authentication_error',
  'billing_error',
  'invalid_request_error',
  'not_found_error',
  'overloaded_error',
  'api_error',
  'timeout_error',
])
const NON_QUOTA_TEXT =
  /authenticat|invalid api key|invalid x-api-key|credential|billing|insufficient|overloaded|payment/i
const SUBSCRIPTION_LIMIT = /claude max rate limit reached/i
const OPUS_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus']
const SONNET_WINDOWS = ['five_hour', 'seven_day', 'seven_day_sonnet']
const SHARED_WINDOWS = ['five_hour', 'seven_day']

const other = (reason: string): Reading => ({ kind: 'other', reason })
const unknown = (reason: string): Reading => ({ kind: 'unknown', reason })
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const veto = (status: number | undefined, body: unknown): Reading | undefined => {
  const error = record(record(body)?.['error'])
  const statuses = [status, error?.['status'], error?.['statusCode']].flatMap((value) => {
    const code = int(value)
    return code === undefined ? [] : [code]
  })
  const refused = statuses.find((code) => NON_QUOTA_STATUS.has(code))
  if (refused !== undefined) {
    return other(`status ${refused}`)
  }
  const unexpected = statuses.find((code) => code !== 429)
  if (unexpected !== undefined) {
    return other(`unexpected status ${unexpected}`)
  }
  const type = text(error?.['type'])
  if (type && NON_QUOTA_TYPE.has(type)) {
    return other(type)
  }
  const message = text(error?.['message']) ?? ''
  if (NON_QUOTA_TEXT.test(message)) {
    return other('message names a non-quota failure')
  }
  if (type !== 'rate_limit_error' || !SUBSCRIPTION_LIMIT.test(message)) {
    return other('not a Claude subscription limit')
  }
  return undefined
}

const baseOf = (origin: string): string | Reading => {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return other('malformed origin')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return other('origin is not http')
  }
  if (url.username || url.password) {
    return other('origin carries credentials')
  }
  if (!LOOPBACK_HOST.test(url.hostname)) {
    return other('origin is not loopback')
  }
  return url.origin
}

const windowsFor = (modelID: string): ReadonlyArray<string> => {
  const id = modelID.toLowerCase()
  if (/fable/.test(id)) {
    return [...SHARED_WINDOWS, 'seven_day_fable']
  }
  if (/opus/.test(id)) {
    return OPUS_WINDOWS
  }
  if (/sonnet/.test(id)) {
    return SONNET_WINDOWS
  }
  return SHARED_WINDOWS
}

const getJSON = async (fetch: Fetch, url: string, key: string | null) => {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: key
        ? { accept: 'application/json', 'x-api-key': key }
        : { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response || response.ok !== true) {
      return undefined
    }
    return record(await response.json())
  } catch {
    return undefined
  }
}

const isClaudeSeat = (entry: Wire, total: number) => {
  const seat = record(entry)
  return (
    seat !== undefined &&
    (seat['type'] === 'claude-max' ||
      (total === 1 && seat['id'] === 'default' && seat['type'] === undefined))
  )
}

const fresh = (fetchedAt: unknown, now: number) => {
  const at = finite(fetchedAt)
  return at !== undefined && at > now - FRESH_MS && at <= now + SKEW_MS
}

export async function read({
  origin,
  key,
  modelID,
  status,
  body,
  fetch,
  now,
}: MeridianRefusal): Promise<Reading> {
  const vetoed = veto(status, body)
  if (vetoed) {
    return vetoed
  }
  const base = baseOf(origin)
  if (typeof base !== 'string') {
    return base
  }

  const all = await getJSON(fetch, `${base}/v1/usage/quota/all`, key)
  const entries = all?.['profiles']
  if (!Array.isArray(entries)) {
    return unknown('quota list unavailable')
  }
  const seats = entries.flatMap((entry: Wire) => {
    const seat = record(entry)
    return seat && isClaudeSeat(entry, entries.length) ? [seat] : []
  })
  const [seat] = seats
  if (!seat) {
    return unknown('no subscription seat')
  }
  if (seats.length !== 1) {
    return unknown('several subscription seats')
  }
  if (seat['isActive'] !== true) {
    return unknown('seat not active')
  }
  if (
    seat['stale'] === true ||
    (seat['error'] !== null && seat['error'] !== undefined) ||
    !Array.isArray(seat['windows']) ||
    !fresh(seat['fetchedAt'], now)
  ) {
    return unknown('seat data stale')
  }
  const id = text(seat['id']) ?? ''

  const quota = await getJSON(
    fetch,
    `${base}/v1/usage/quota?profile=${encodeURIComponent(id)}`,
    key,
  )
  if (!quota) {
    return unknown('quota unavailable')
  }
  if (quota['profile'] !== id) {
    return unknown('quota for another seat')
  }
  const buckets = quota['buckets']
  const oauth = record(record(quota['sources'])?.['oauth'])
  if (!Array.isArray(buckets) || !oauth) {
    return unknown('quota without oauth snapshot')
  }
  if (!fresh(oauth['fetchedAt'], now)) {
    return unknown('quota snapshot stale')
  }

  const applicable = windowsFor(modelID)
  const resets = buckets.flatMap((entry: Wire) => {
    const bucket = record(entry)
    return bucket &&
      bucket['status'] === 'rejected' &&
      applicable.includes(text(bucket['type']) ?? '')
      ? [bucket['resetsAt']]
      : []
  })
  if (resets.length === 0) {
    return unknown('no rejected window')
  }
  const latest = latestReset(resets, now)
  if (latest === undefined) {
    return unknown('no usable reset')
  }
  if (latest - now > AHEAD_MS) {
    return unknown('reset beyond 8 days')
  }
  return { kind: 'until', until: latest }
}
