import { read } from '../../vendors/claude-message.ts'
import type { Reading } from '../../deadline.ts'

export type ErrorEvent = Readonly<{
  error?: Readonly<{ message?: unknown }> | undefined
}>

export function claudeAgentSource() {
  return {
    atError(event: ErrorEvent, _earlier: Reading | undefined, now: number): Reading {
      return read(event.error?.message, now)
    },
  }
}
