import { plausible } from '../deadline.ts'
import type { HoldState } from './rpc.ts'

export const key = (sessionID: string) => `wait/${sessionID}`

export type Route = Readonly<{
  agent: string
  model: Readonly<{ providerID: string; id: string; variant?: string | undefined }>
}>

export type Stored = Route & Readonly<{ until: number; since?: number }>

export type Dispatch = Readonly<
  { kind: 'pass' } | { kind: 'remove' } | { kind: 'sleep'; delay: number }
>

export function sameRoute(left: Route, right: Route): boolean {
  return (
    left.agent === right.agent &&
    left.model.providerID === right.model.providerID &&
    left.model.id === right.model.id &&
    left.model.variant === right.model.variant
  )
}

export function isStored(value: unknown): value is Stored {
  if (
    !value ||
    typeof value !== 'object' ||
    !('until' in value) ||
    !Number.isSafeInteger(value.until) ||
    !('agent' in value) ||
    typeof value.agent !== 'string' ||
    !('model' in value) ||
    ('since' in value && !Number.isSafeInteger(value.since))
  ) {
    return false
  }
  const model = value.model
  return (
    !!model &&
    typeof model === 'object' &&
    'providerID' in model &&
    typeof model.providerID === 'string' &&
    'id' in model &&
    typeof model.id === 'string' &&
    (!('variant' in model) || typeof model.variant === 'string')
  )
}

export function project(sessionID: string, value: unknown, now: number): HoldState | null {
  if (!isStored(value) || value.until - now > 31 * 86_400_000) {
    return null
  }
  return {
    sessionID,
    until: value.until,
    since: value.since ?? Math.min(now, value.until),
    providerID: value.model.providerID,
    model: value.model.id,
  }
}

export function dispatchDecision(stored: unknown, route: Route, now: number): Dispatch {
  if (!stored) {
    return { kind: 'pass' }
  }
  if (!isStored(stored) || !plausible(stored.until, now)) {
    return { kind: 'remove' }
  }
  return sameRoute(stored, route) ? { kind: 'sleep', delay: stored.until - now } : { kind: 'pass' }
}
