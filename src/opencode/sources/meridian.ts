import { read } from '../../vendors/meridian.ts'
import type { Reading } from '../../deadline.ts'
import type { Fetch } from '../../vendors/meridian.ts'

export type ResponseEvent = Readonly<{
  sessionID: string
  kind: string
  model: Readonly<{ providerID?: string | undefined; id: string }>
  request: Request
  response: Response
}>

export type ErrorEvent = Readonly<{
  error?: Readonly<{ status?: number | undefined }> | undefined
}>

const other = (reason: string): Reading => ({ kind: 'other', reason })

export function meridianSource(fetchImpl: Fetch = globalThis.fetch) {
  return {
    async atResponse(event: ResponseEvent, now: number): Promise<Reading> {
      if (event.model.providerID !== 'anthropic') {
        return other('not the anthropic provider')
      }
      if (event.kind !== 'primary') {
        return other('not a primary request')
      }
      if (event.response.status !== 429) {
        return other(`status ${event.response.status}`)
      }
      if (event.request.headers.get('x-opencode-session') !== event.sessionID) {
        return other('request from another session')
      }
      const body: unknown = await event.response
        .clone()
        .json()
        .catch(() => undefined)
      return read({
        origin: event.request.url,
        key: event.request.headers.get('x-api-key'),
        modelID: event.model.id,
        status: event.response.status,
        body,
        fetch: fetchImpl,
        now,
      })
    },
    atError(event: ErrorEvent, earlier: Reading | undefined, _now: number): Reading {
      if (event.error?.status !== 429) {
        return other('not a 429 retry')
      }
      return earlier ?? { kind: 'unknown', reason: 'no response observed' }
    },
  }
}
