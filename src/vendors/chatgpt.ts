import { latestReset } from '../deadline.ts'
import { epochMs, record, text } from '../wire.ts'
import type { Reading } from '../deadline.ts'

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export type Refusal = { kind: 'limit' | 'veto' | 'unrecognized'; account?: string; direct?: number }

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TIMEOUT_MS = 10_000
const LIMIT_CODES = ['usage_limit_reached', 'subscription_sharing_usage_limit_exceeded']
const NOT_WAITABLE = [
  'usage_not_included',
  'insufficient_quota',
  'subscription_sharing_user_not_eligible',
]

const unknown = (reason: string): Reading => ({ kind: 'unknown', reason })

const finite = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const relativeMs = (value: unknown, now: number): number | undefined => {
  const parsed = finite(value)
  return parsed === undefined || parsed < 0 ? undefined : now + Math.round(parsed * 1000)
}

type Fields = ReturnType<typeof record>

const parseJSON = (raw: string): { fields: Fields } | undefined => {
  try {
    const value: unknown = JSON.parse(raw)
    return { fields: record(value) }
  } catch {
    return undefined
  }
}

const parseBody = (body: unknown): Fields => {
  if (record(body) || typeof body !== 'string' || !body) {
    return record(body)
  }
  const match = body.match(/\{[\s\S]*\}/)
  return (parseJSON(body) ?? (match ? parseJSON(match[0]) : undefined))?.fields
}

const textOf = (body: unknown): string => {
  if (typeof body === 'string') {
    return body
  }
  if (body === undefined || body === null) {
    return ''
  }
  try {
    return JSON.stringify(body) ?? ''
  } catch {
    return ''
  }
}

const candidatesOf = (body: unknown) => {
  const root = parseBody(body) ?? {}
  return [record(root['error']), root, record(record(root['response'])?.['error'])].flatMap(
    (item) => (item ? [item] : []),
  )
}

export function inferenceRequest(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.origin === 'https://chatgpt.com' && parsed.pathname.startsWith('/backend-api/codex/')
    )
  } catch {
    return false
  }
}

export function parseRefusal(body: unknown, now: number): Refusal {
  const whole = textOf(body)
  const kind = NOT_WAITABLE.some((code) => whole.includes(code))
    ? 'veto'
    : LIMIT_CODES.some((code) => whole.includes(code))
      ? 'limit'
      : 'unrecognized'
  const refusal: Refusal = { kind }
  for (const item of candidatesOf(body)) {
    const id = text(
      item['chatgpt_account_id'] ??
        item['chatgptAccountId'] ??
        item['account_id'] ??
        item['accountId'],
    )
    if (id) {
      refusal.account = id
      break
    }
  }
  for (const item of candidatesOf(body)) {
    const direct =
      epochMs(item['resets_at'] ?? item['reset_at'] ?? item['resetsAt']) ??
      relativeMs(
        item['resets_in_seconds'] ?? item['reset_after_seconds'] ?? item['resetsInSeconds'],
        now,
      )
    if (direct !== undefined) {
      refusal.direct = direct
      break
    }
  }
  return refusal
}

const resetOf = (raw: unknown, now: number): number | undefined => {
  const window = record(raw)
  if (!window) {
    return undefined
  }
  return (
    epochMs(window['reset_at'] ?? window['resets_at'] ?? window['resetsAt']) ??
    relativeMs(window['reset_after_seconds'] ?? window['resets_in_seconds'], now)
  )
}

const resetFromUsage = (payload: unknown, now: number): Reading => {
  const usage = record(payload)
  const limit = record(usage?.['rate_limit'] ?? usage?.['rateLimit'] ?? usage?.['rateLimits'])
  if (!limit) {
    return unknown('usage without a rate limit')
  }
  const exhausted = [
    limit['primary_window'] ?? limit['primary'],
    limit['secondary_window'] ?? limit['secondary'],
  ].flatMap((raw) => {
    const window = record(raw)
    const used = finite(window?.['used_percent'] ?? window?.['usedPercent'])
    return used !== undefined && used >= 100 ? [resetOf(raw, now)] : []
  })
  if (exhausted.length === 0) {
    return unknown('no exhausted window')
  }
  const until = latestReset(exhausted, now)
  return until === undefined ? unknown('no usable window reset') : { kind: 'until', until }
}

export async function readUsage({
  token,
  account,
  fetch,
  now,
}: Readonly<{ token: string; account: string; fetch: Fetch; now: number }>): Promise<Reading> {
  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'ChatGPT-Account-Id': account,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return unknown('usage lookup failed')
  }
  if (!response.ok) {
    return unknown(`usage status ${response.status}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return unknown('usage body unreadable')
  }
  return resetFromUsage(payload, now)
}
