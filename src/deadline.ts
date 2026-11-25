export type Reading =
  | { kind: 'until'; until: number }
  | { kind: 'unknown'; reason: string }
  | { kind: 'other'; reason: string }

const MONTH = 31 * 86_400_000

export function latestReset(resets: ReadonlyArray<unknown>, now: number): number | undefined {
  let latest: number | undefined
  for (const reset of resets) {
    if (typeof reset !== 'number' || !Number.isSafeInteger(reset) || reset <= 0) {
      return undefined
    }
    if (reset <= now) {
      continue
    }
    latest = Math.max(latest ?? 0, reset)
  }
  return latest
}

export function plausible(until: unknown, now: number): until is number {
  return (
    typeof until === 'number' && Number.isSafeInteger(until) && until > now && until - now <= MONTH
  )
}
