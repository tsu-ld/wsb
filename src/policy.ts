export type Route = Readonly<{
  agent: string
  model: Readonly<{ providerID: string; id: string; variant?: string | undefined }>
}>

export type Wait = Route & Readonly<{ until: number }>

export function lastBlockingReset(resets: ReadonlyArray<unknown>, now: number): number | undefined {
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

export function sameRoute(left: Route, right: Route): boolean {
  return (
    left.agent === right.agent &&
    left.model.providerID === right.model.providerID &&
    left.model.id === right.model.id &&
    left.model.variant === right.model.variant
  )
}

export function retryDecision(reset: unknown, now: number) {
  if (
    typeof reset === 'number' &&
    Number.isSafeInteger(reset) &&
    reset > now &&
    reset - now <= 31 * 86_400_000
  ) {
    return { retry: true, delay: reset - now } as const
  }
  return undefined
}
