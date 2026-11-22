import { lastBlockingReset } from './policy.ts'

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
const OPUS_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus']
const SONNET_WINDOWS = ['five_hour', 'seven_day', 'seven_day_sonnet']
const SHARED_WINDOWS = ['five_hour', 'seven_day']

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const firstString = (...values) =>
  values.find((value) => typeof value === 'string' && value) ?? null

const statusesOf = (event) =>
  [
    event?.status,
    event?.statusCode,
    event?.response?.status,
    event?.error?.status,
    event?.error?.statusCode,
    event?.data?.statusCode,
    event?.data?.status,
  ].filter((value) => finite(value) !== null)

const typeOf = (event) => firstString(event?.error?.type, event?.data?.type, event?.type)
const textOf = (event) =>
  [event?.error?.message, event?.message, event?.data?.message, event?.reason]
    .filter((value) => typeof value === 'string')
    .join(' ')

const isQuotaSignal = (event) => {
  if (!isRecord(event)) {
    return false
  }
  const statuses = statusesOf(event)
  if (statuses.some((status) => NON_QUOTA_STATUS.has(status))) {
    return false
  }
  if (statuses.some((status) => status !== 429)) {
    return false
  }
  const type = typeOf(event)
  if (type && NON_QUOTA_TYPE.has(type)) {
    return false
  }
  if (NON_QUOTA_TEXT.test(textOf(event))) {
    return false
  }
  return statuses.includes(429) || type === 'rate_limit_error'
}

const baseOf = (ctx) => {
  const raw = ctx?.meridianBaseURL
  if (typeof raw !== 'string') {
    return null
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  if (url.username || url.password) {
    return null
  }
  if (!LOOPBACK_HOST.test(url.hostname)) {
    return null
  }
  return url.origin
}

const modelOf = (ctx) => {
  const value = ctx?.model
  const id =
    typeof value === 'string' ? value : isRecord(value) ? (value.id ?? value.modelID) : null
  return firstString(ctx?.modelID, id)
}

const providerOf = (ctx, event) => {
  const value = ctx?.model ?? event?.model
  const fromModel = isRecord(value) ? value.providerID : null
  return firstString(ctx?.providerID, event?.providerID, fromModel)
}

const windowsFor = (model) => {
  const id = String(model ?? '').toLowerCase()
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

const getJSON = async (fetchImpl, url, key) => {
  const headers = { accept: 'application/json' }
  if (key) {
    headers['x-api-key'] = key
  }
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response || response.ok !== true) {
      return null
    }
    const body = await response.json()
    return isRecord(body) ? body : null
  } catch {
    return null
  }
}

const isClaudeSeat = (entry, total) =>
  isRecord(entry) &&
  (entry.type === 'claude-max' ||
    (total === 1 && entry.id === 'default' && entry.type === undefined))

const isFresh = (seat, at) => {
  if (seat.stale === true) {
    return false
  }
  if (seat.error !== null && seat.error !== undefined) {
    return false
  }
  if (!Array.isArray(seat.windows)) {
    return false
  }
  const fetchedAt = finite(seat.fetchedAt)
  return fetchedAt !== null && fetchedAt > at - FRESH_MS && fetchedAt <= at + SKEW_MS
}

export async function claudeReset(ctx, event, now) {
  const at = typeof now === 'function' ? now() : (finite(now) ?? Date.now())
  if (!isQuotaSignal(event)) {
    return undefined
  }
  if (providerOf(ctx, event) !== 'anthropic') {
    return undefined
  }
  const base = baseOf(ctx)
  if (!base) {
    return undefined
  }
  const fetchImpl = ctx?.fetch ?? globalThis.fetch
  const key = firstString(ctx?.meridianKey)
  const requested = firstString(ctx?.profile)

  const all = await getJSON(fetchImpl, `${base}/v1/usage/quota/all`, key)
  const entries = Array.isArray(all?.profiles) ? all.profiles : null
  if (!entries) {
    return undefined
  }
  const seats = entries.filter((entry) => isClaudeSeat(entry, entries.length))
  let seat
  if (requested) {
    seat = seats.find((entry) => entry.id === requested) ?? null
    if (!seat) {
      return undefined
    }
  } else {
    if (seats.length !== 1 || seats[0].isActive !== true) {
      return undefined
    }
    seat = seats[0]
  }
  if (!isFresh(seat, at)) {
    return undefined
  }

  const quota = await getJSON(
    fetchImpl,
    `${base}/v1/usage/quota?profile=${encodeURIComponent(seat.id)}`,
    key,
  )
  if (!isRecord(quota) || quota.profile !== seat.id) {
    return undefined
  }
  const buckets = Array.isArray(quota.buckets) ? quota.buckets : null
  const oauth =
    isRecord(quota.sources) && isRecord(quota.sources.oauth) ? quota.sources.oauth : null
  if (!buckets || !oauth) {
    return undefined
  }
  const fetchedAt = finite(oauth.fetchedAt)
  if (fetchedAt === null || fetchedAt <= at - FRESH_MS || fetchedAt > at + SKEW_MS) {
    return undefined
  }

  const applicable = windowsFor(modelOf(ctx))
  const resets = buckets.flatMap((bucket) =>
    isRecord(bucket) && bucket.status === 'rejected' && applicable.includes(bucket.type)
      ? [bucket.resetsAt]
      : [],
  )
  const latest = lastBlockingReset(resets, at)
  return latest && latest - at <= AHEAD_MS ? latest : undefined
}
