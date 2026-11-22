import { lastBlockingReset } from './policy.ts'

const PROVIDER = 'opencode-go'
const LIMIT_TYPE = 'provider.go-limit'
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const USAGE_ORIGIN = new URL(USAGE_URL).origin
const STATUSES = new Set([402, 403, 429])
const METERS = ['rolling', 'weekly', 'monthly']
const HOUR = 3_600_000
const WINDOWS = Object.freeze({
  '5 hour': 5 * HOUR,
  '5-hour': 5 * HOUR,
  '5h': 5 * HOUR,
  rolling: 5 * HOUR,
  week: 7 * 24 * HOUR,
  weekly: 7 * 24 * HOUR,
  month: 31 * 24 * HOUR,
  monthly: 31 * 24 * HOUR,
})

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const instant = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }
  const trimmed = value.trim()
  const at = /^-?\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
  return Number.isSafeInteger(at) ? at : undefined
}

const bodyOf = (error) => {
  const raw = error?.response?.body
  if (typeof raw !== 'string') {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const metadataOf = (body) => [body?.metadata, body?.error?.metadata].find(isRecord) ?? {}

const workspaceOf = (body) => {
  const value = metadataOf(body).workspace ?? body?.workspace
  return typeof value === 'string' && value !== '' ? value : undefined
}

const absoluteOf = (body) => {
  for (const source of [body?.metadata, body?.error?.metadata, body]) {
    if (isRecord(source) && Object.hasOwn(source, 'resetsAt')) {
      return { present: true, at: instant(source.resetsAt) }
    }
  }
  return { present: false, at: undefined }
}

const windowOf = (body) => {
  const value = metadataOf(body).limitName ?? body?.limitName
  return typeof value === 'string' ? WINDOWS[value.trim().toLowerCase()] : undefined
}

const delayOf = (error, body, now) => {
  const delay = error?.retryAfterMs
  const window = windowOf(body)
  if (!Number.isSafeInteger(delay) || delay <= 0 || window === undefined || delay > window) {
    return undefined
  }
  return lastBlockingReset([now + delay], now)
}

export async function goUsage(responseEvent, request = fetch, now = Date.now()) {
  const { model, kind, response } = responseEvent ?? {}
  if (model?.providerID !== PROVIDER || kind !== 'primary' || !STATUSES.has(response?.status)) {
    return undefined
  }
  if (!Number.isSafeInteger(now)) {
    return undefined
  }
  const inference = responseEvent.request
  let url
  try {
    url = new URL(inference.url)
  } catch {
    return undefined
  }
  if (url.origin !== USAGE_ORIGIN || !url.pathname.startsWith('/zen/go/v1/')) {
    return undefined
  }
  const auth = inference.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) {
    return undefined
  }
  const headers = { authorization: auth }
  const org = inference.headers.get('x-opencode-org-id')
  if (org) {
    headers['x-opencode-org-id'] = org
  }
  let reply
  try {
    reply = await request(USAGE_URL, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    })
  } catch {
    return undefined
  }
  if (!reply.ok) {
    return undefined
  }
  let payload
  try {
    payload = await reply.json()
  } catch {
    return undefined
  }
  const usage = payload?.usage
  if (!isRecord(usage)) {
    return undefined
  }
  const resets = []
  for (const name of METERS) {
    const meter = usage[name]
    if (!isRecord(meter) || !['ok', 'rate-limited'].includes(meter.status)) {
      return undefined
    }
    if (meter.status === 'rate-limited') {
      resets.push(instant(meter.resetsAt))
    }
  }
  return resets.length === 0 ? undefined : lastBlockingReset(resets, now)
}

const confirmed = (event) =>
  event?.error?.type === LIMIT_TYPE && event?.model?.providerID === PROVIDER

export function goAdapter() {
  return {
    async observe(event, read = fetch, now = Date.now()) {
      const at = await goUsage(event, read, now)
      if (at) {
        return at
      }
      if (
        event?.kind !== 'primary' ||
        event.model?.providerID !== PROVIDER ||
        !STATUSES.has(event.response?.status)
      ) {
        return undefined
      }
      const url = new URL(event.request.url)
      const org = event.request.headers.get('x-opencode-org-id')
      if (!org || url.origin !== USAGE_ORIGIN || !url.pathname.startsWith('/zen/go/v1/')) {
        return undefined
      }
      const body = await event.response
        .clone()
        .json()
        .catch(() => undefined)
      if (workspaceOf(body) !== org) {
        return undefined
      }
      return lastBlockingReset([absoluteOf(body).at], now)
    },
    confirmed,
    resolve(_ctx, event, now = Date.now(), observed) {
      if (!confirmed(event)) {
        return undefined
      }
      if (!Number.isSafeInteger(now)) {
        return undefined
      }
      const fromObservation = lastBlockingReset([observed], now)
      if (fromObservation !== undefined) {
        return fromObservation
      }
      const body = bodyOf(event.error)
      if (body === undefined) {
        return undefined
      }
      const absolute = absoluteOf(body)
      if (absolute.present) {
        return undefined
      }
      return delayOf(event.error, body, now)
    },
  }
}
