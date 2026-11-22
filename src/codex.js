import { lastBlockingReset } from './policy.ts'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const LIMIT_TYPE = 'provider.chatgpt-limit'
const LIMIT_CODES = ['usage_limit_reached', 'subscription_sharing_usage_limit_exceeded']
const NOT_WAITABLE = [
  'usage_not_included',
  'insufficient_quota',
  'subscription_sharing_user_not_eligible',
]

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finite = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const epochMs = (value) => {
  const parsed = finite(value)
  if (parsed === null || parsed <= 0) {
    return null
  }
  return Math.round(parsed > 1e12 ? parsed : parsed * 1000)
}

const relativeMs = (value, now) => {
  const parsed = finite(value)
  return parsed === null || parsed < 0 ? null : now + Math.round(parsed * 1000)
}

const parseBody = (body) => {
  if (isRecord(body)) {
    return body
  }
  if (typeof body !== 'string' || !body) {
    return null
  }
  try {
    return JSON.parse(body)
  } catch {
    const match = body.match(/\{[\s\S]*\}/)
    if (!match) {
      return null
    }
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

const textOf = (error) => {
  const body = error?.response?.body
  if (typeof body === 'string') {
    return body
  }
  if (body === undefined || body === null) {
    return ''
  }
  try {
    return JSON.stringify(body)
  } catch {
    return ''
  }
}

const candidatesOf = (error) => {
  const body = parseBody(error?.response?.body)
  const root = isRecord(body) ? body : {}
  return [root.error, root, isRecord(root.response) ? root.response.error : null].filter(isRecord)
}

const header = (headers, name) => {
  if (!headers) {
    return null
  }
  if (typeof headers.get === 'function') {
    return headers.get(name)
  }
  if (!isRecord(headers)) {
    return null
  }
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name)
  return key ? headers[key] : null
}

export function isLimitError(error) {
  if (!isRecord(error)) {
    return false
  }
  const text = textOf(error)
  if (NOT_WAITABLE.some((code) => text.includes(code))) {
    return false
  }
  return error.type === LIMIT_TYPE || LIMIT_CODES.some((code) => text.includes(code))
}

export function resetFromError(error, now) {
  for (const item of candidatesOf(error)) {
    const at = epochMs(item.resets_at ?? item.reset_at ?? item.resetsAt)
    if (at !== null) {
      return at
    }
    const after = relativeMs(
      item.resets_in_seconds ?? item.reset_after_seconds ?? item.resetsInSeconds,
      now,
    )
    if (after !== null) {
      return after
    }
  }
  return null
}

export function accountFrom(error) {
  for (const item of candidatesOf(error)) {
    const id = item.chatgpt_account_id ?? item.chatgptAccountId ?? item.account_id ?? item.accountId
    if (typeof id === 'string' && id) {
      return id
    }
  }
  const value = header(error?.response?.headers, 'chatgpt-account-id')
  return typeof value === 'string' && value ? value : null
}

export function bearerFrom(credential) {
  if (!isRecord(credential) || credential.type !== 'oauth') {
    return null
  }
  if (typeof credential.access !== 'string' || !credential.access) {
    return null
  }
  const metadata = isRecord(credential.metadata) ? credential.metadata : {}
  const accountID = metadata.accountID ?? metadata.accountId ?? credential.accountId
  return {
    access: credential.access,
    accountID: typeof accountID === 'string' && accountID ? accountID : null,
  }
}

const windowOf = (raw, now) => {
  if (!isRecord(raw)) {
    return null
  }
  const used = finite(raw.used_percent ?? raw.usedPercent)
  const reset =
    epochMs(raw.reset_at ?? raw.resets_at ?? raw.resetsAt) ??
    relativeMs(raw.reset_after_seconds ?? raw.resets_in_seconds, now)
  return reset === null ? null : { used, reset }
}

export function resetFromUsage(payload, now) {
  if (!isRecord(payload)) {
    return null
  }
  const limit = payload.rate_limit ?? payload.rateLimit ?? payload.rateLimits
  if (!isRecord(limit)) {
    return null
  }
  const exhausted = [
    limit.primary_window ?? limit.primary,
    limit.secondary_window ?? limit.secondary,
  ].flatMap((raw) =>
    raw && finite(raw.used_percent ?? raw.usedPercent) >= 100 ? [windowOf(raw, now)?.reset] : [],
  )
  return lastBlockingReset(exhausted, now) ?? null
}

export async function codexReset(ctx, event, now, observed) {
  const at = typeof now === 'function' ? now() : (now ?? Date.now())
  const error = isRecord(event?.error) ? event.error : isRecord(event) ? event : null
  if (!error || !isLimitError(error)) {
    return undefined
  }
  const connectionAPI = ctx?.integration?.connection
  if (!connectionAPI) {
    return undefined
  }
  const connection = await connectionAPI.active('openai')
  if (!connection || (connection.method ?? connection.type) !== 'oauth') {
    return undefined
  }
  const auth = bearerFrom(await connectionAPI.resolve(connection))
  if (!auth) {
    return undefined
  }
  const account = accountFrom(error)
  if (account && account !== auth.accountID) {
    return undefined
  }
  const direct = resetFromError(error, at)
  if (direct !== null && direct > at && direct - at <= 31 * 86_400_000) {
    return direct
  }
  if (observed && observed > at) {
    return observed
  }
  if (!account || account !== auth.accountID) {
    return undefined
  }
  return readUsage(auth.access, account, at)
}

export async function observeCodex({ request, response, kind }) {
  if (kind !== 'primary' || response.status !== 429) {
    return undefined
  }
  const url = new URL(request.url)
  if (url.origin !== 'https://chatgpt.com' || !url.pathname.startsWith('/backend-api/codex/')) {
    return undefined
  }
  const bearer = request.headers.get('authorization')
  const account = request.headers.get('chatgpt-account-id')
  if (!bearer?.startsWith('Bearer ') || !account) {
    return undefined
  }
  const error = {
    response: {
      body: await response
        .clone()
        .json()
        .catch(() => null),
    },
  }
  const now = Date.now()
  if (!isLimitError(error) || (accountFrom(error) && accountFrom(error) !== account)) {
    return undefined
  }
  const direct = resetFromError(error, now)
  if (direct && direct > now && direct - now <= 31 * 86_400_000) {
    return direct
  }
  return readUsage(bearer.slice(7), account, now)
}

async function readUsage(token, account, at) {
  try {
    const response = await globalThis.fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'ChatGPT-Account-Id': account,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return undefined
    }
    return resetFromUsage(await response.json(), at) ?? undefined
  } catch {
    return undefined
  }
}
