export type Wire =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Wire>
  | { readonly [key: string]: Wire }

type WireRecord = { readonly [key: string]: Wire }

const isRecord = (value: unknown): value is WireRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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

export function record(value: unknown): WireRecord | undefined {
  return isRecord(value) ? value : undefined
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

export function epochMs(value: unknown): number | undefined {
  const parsed = finite(value)
  if (parsed === undefined || parsed <= 0) {
    return undefined
  }
  return Math.round(parsed > 1e12 ? parsed : parsed * 1000)
}
