import { latestReset, plausible } from '../../deadline.ts'
import {
  REFUSAL_STATUSES,
  inferenceRequest,
  parseRefusal,
  readUsage,
  windowDelay,
} from '../../vendors/go.ts'
import type { Reading } from '../../deadline.ts'
import type { Fetch } from '../../vendors/go.ts'

export type ResponseEvent = Readonly<{
  kind: string
  model: Readonly<{ providerID?: string | undefined }>
  request: Request
  response: Response
}>

export type ErrorEvent = Readonly<{
  model?: Readonly<{ providerID?: string | undefined }> | undefined
  error?:
    | Readonly<{
        type?: unknown
        retryAfterMs?: unknown
        response?: Readonly<{ body?: unknown }> | undefined
      }>
    | undefined
}>

const PROVIDER = 'opencode-go'
const LIMIT_TYPE = 'provider.go-limit'

const other = (reason: string): Reading => ({ kind: 'other', reason })
const unknown = (reason: string): Reading => ({ kind: 'unknown', reason })

const confirmed = (event: ErrorEvent) =>
  event.error?.type === LIMIT_TYPE && event.model?.providerID === PROVIDER

const bodyOf = (raw: unknown): { value: unknown } | undefined => {
  if (typeof raw !== 'string') {
    return undefined
  }
  try {
    return { value: JSON.parse(raw) }
  } catch {
    return undefined
  }
}

const absoluteFromBody = async (event: ResponseEvent, now: number): Promise<Reading> => {
  const org = event.request.headers.get('x-opencode-org-id')
  if (!org) {
    return other('no org header')
  }
  const body: unknown = await event.response
    .clone()
    .json()
    .catch(() => undefined)
  const refusal = parseRefusal(body)
  if (refusal.workspace !== org) {
    return other('refusal for another workspace')
  }
  const until = latestReset([refusal.absolute.at], now)
  return until === undefined ? unknown('no usable absolute reset') : { kind: 'until', until }
}

export function goSource({ fetch = globalThis.fetch }: Readonly<{ fetch?: Fetch }> = {}) {
  return {
    async atResponse(event: ResponseEvent, now: number): Promise<Reading> {
      if (event.model.providerID !== PROVIDER) {
        return other('not the opencode-go provider')
      }
      if (event.kind !== 'primary') {
        return other('not a primary request')
      }
      if (!REFUSAL_STATUSES.has(event.response.status)) {
        return other(`status ${event.response.status}`)
      }
      if (!inferenceRequest(event.request.url)) {
        return other('not a Go inference request')
      }
      const authorization = event.request.headers.get('authorization')
      const usage = authorization?.startsWith('Bearer ')
        ? await readUsage({
            authorization,
            org: event.request.headers.get('x-opencode-org-id'),
            fetch,
            now,
          })
        : other('no bearer token')
      if (usage.kind === 'until') {
        return usage
      }
      const absolute = await absoluteFromBody(event, now)
      return absolute.kind === 'until' ? absolute : usage
    },
    atError(event: ErrorEvent, earlier: Reading | undefined, now: number): Reading {
      if (!confirmed(event)) {
        return other('not a Go usage limit')
      }
      if (!Number.isSafeInteger(now)) {
        return unknown('invalid clock')
      }
      if (earlier?.kind === 'until' && plausible(earlier.until, now)) {
        return earlier
      }
      const body = bodyOf(event.error?.response?.body)
      if (!body) {
        return unknown('refusal body unreadable')
      }
      const refusal = parseRefusal(body.value)
      if (refusal.absolute.present) {
        return unknown('absolute reset not observed at the response')
      }
      return windowDelay(event.error?.retryAfterMs, refusal.window, now)
    },
  }
}
