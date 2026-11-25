import { latestReset } from '../deadline.ts'
import type { Reading } from '../deadline.ts'

const LIMIT = /hit your (?:[\w-]+ ){0,3}limit|subscription limit reached/i
const RESET = /Resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\.?\s*$/

export function read(message: unknown, now: number): Reading {
  if (typeof message !== 'string') {
    return { kind: 'other', reason: 'message is not a string' }
  }
  if (!LIMIT.test(message)) {
    return { kind: 'other', reason: 'not a subscription limit' }
  }
  const match = RESET.exec(message)
  const reset = match?.[1]
  const until = reset === undefined ? undefined : latestReset([Date.parse(reset)], now)
  if (until === undefined) {
    return { kind: 'unknown', reason: 'no usable reset' }
  }
  return { kind: 'until', until }
}
