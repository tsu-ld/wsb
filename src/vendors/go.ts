import { latestReset } from '../deadline.ts'
import { record } from '../wire.ts'
import type { Reading } from '../deadline.ts'

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export type Refusal = {
  workspace?: string
  absolute: { present: boolean; at?: number }
  window?: number
}

export const REFUSAL_STATUSES: ReadonlySet<number> = new Set([402, 403, 429])

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const USAGE_ORIGIN = new URL(USAGE_URL).origin
const TIMEOUT_MS = 4000
const METERS = ['rolling', 'weekly', 'monthly']
const HOUR = 3_600_000
const WINDOWS: ReadonlyMap<string, number> = new Map([
  ['5 hour', 5 * HOUR],
  ['5-hour', 5 * HOUR],
  ['5h', 5 * HOUR],
  ['rolling', 5 * HOUR],
  ['week', 7 * 24 * HOUR],
  ['weekly', 7 * 24 * HOUR],
  ['month', 31 * 24 * HOUR],
  ['monthly', 31 * 24 * HOUR],
])

const unknown = (reason: string): Reading => ({ kind: 'unknown', reason })

const instant = (value: unknown): number | undefined => {
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

export function inferenceRequest(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.origin === USAGE_ORIGIN && parsed.pathname.startsWith('/zen/go/v1/')
  } catch {
    return false
  }
}

export async function readUsage({
  authorization,
  org,
  fetch,
  now,
}: Readonly<{
  authorization: string
  org?: string | null | undefined
  fetch: Fetch
  now: number
}>): Promise<Reading> {
  if (!Number.isSafeInteger(now)) {
    return unknown('invalid clock')
  }
  const headers = org ? { authorization, 'x-opencode-org-id': org } : { authorization }
  let reply: Response
  try {
    reply = await fetch(USAGE_URL, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return unknown('usage lookup failed')
  }
  if (!reply.ok) {
    return unknown(`usage status ${reply.status}`)
  }
  let payload: unknown
  try {
    payload = await reply.json()
  } catch {
    return unknown('usage body unreadable')
  }
  const usage = record(record(payload)?.['usage'])
  if (!usage) {
    return unknown('usage without meters')
  }
  const resets: Array<number | undefined> = []
  for (const name of METERS) {
    const meter = record(usage[name])
    const status = meter?.['status']
    if (!meter || (status !== 'ok' && status !== 'rate-limited')) {
      return unknown(`meter ${name} unusable`)
    }
    if (status === 'rate-limited') {
      resets.push(instant(meter['resetsAt']))
    }
  }
  if (resets.length === 0) {
    return unknown('no rate-limited meter')
  }
  const until = latestReset(resets, now)
  return until === undefined ? unknown('no usable meter reset') : { kind: 'until', until }
}

export function parseRefusal(body: unknown): Refusal {
  const root = record(body)
  const nested = record(root?.['error'])
  const metadata = record(root?.['metadata']) ?? record(nested?.['metadata']) ?? {}
  const refusal: Refusal = { absolute: { present: false } }
  const workspace = metadata['workspace'] ?? root?.['workspace']
  if (typeof workspace === 'string' && workspace !== '') {
    refusal.workspace = workspace
  }
  for (const source of [record(root?.['metadata']), record(nested?.['metadata']), root]) {
    if (source && Object.hasOwn(source, 'resetsAt')) {
      const at = instant(source['resetsAt'])
      refusal.absolute = at === undefined ? { present: true } : { present: true, at }
      break
    }
  }
  const name = metadata['limitName'] ?? root?.['limitName']
  const window = typeof name === 'string' ? WINDOWS.get(name.trim().toLowerCase()) : undefined
  if (window !== undefined) {
    refusal.window = window
  }
  return refusal
}

export function windowDelay(delayMs: unknown, window: number | undefined, now: number): Reading {
  if (typeof delayMs !== 'number' || !Number.isSafeInteger(delayMs) || delayMs <= 0) {
    return unknown('no usable retry delay')
  }
  if (window === undefined) {
    return unknown('no known limit window')
  }
  if (delayMs > window) {
    return unknown('retry delay longer than the window')
  }
  const until = latestReset([now + delayMs], now)
  return until === undefined ? unknown('retry delay already elapsed') : { kind: 'until', until }
}
