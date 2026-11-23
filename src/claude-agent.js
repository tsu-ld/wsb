import { lastBlockingReset } from './policy.ts'

const LIMIT = /hit your (?:[\w-]+ ){0,3}limit|subscription limit reached/i
const RESET = /Resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\.?\s*$/

export function claudeAgentReset(event, now) {
  const message = event?.error?.message
  if (typeof message !== 'string' || !LIMIT.test(message)) {
    return undefined
  }
  const match = RESET.exec(message)
  return match ? lastBlockingReset([Date.parse(match[1])], now) : undefined
}
