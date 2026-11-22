export interface Hold {
  readonly until: number
  readonly since: number
  readonly providerID: string
  readonly model: string
}

export interface Bar {
  readonly filled: number
  readonly empty: number
}

const pad = (value: number) => String(value).padStart(2, '0')

export function remaining(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000))
}

export function countdown(seconds: number): string {
  if (seconds >= 86_400) {
    return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`
  }
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
  }
  return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
}

export function compact(seconds: number): string {
  if (seconds >= 86_400) {
    return `${Math.floor(seconds / 86_400)}d`
  }
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m`
  }
  return `${seconds}s`
}

export function countdownField(seconds: number): string {
  const text = seconds === 0 ? 'resetting…' : countdown(seconds)
  return text.length >= 8 ? text : text.padEnd(8)
}

export function clock(until: number, now: number): string {
  const at = new Date(until)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (until - now < 86_400_000) {
    return time
  }
  const day = at.getDay() * 3
  return `${'SunMonTueWedThuFriSat'.slice(day, day + 3)} ${time}`
}

export function bar(width: number, since: number, until: number, now: number): Bar {
  const cells = Math.max(0, Math.floor(width))
  if (!(until > since)) {
    return { filled: cells, empty: 0 }
  }
  const ratio = Math.min(1, Math.max(0, (now - since) / (until - since)))
  const filled = Math.min(cells, Math.round(cells * ratio))
  return { filled, empty: cells - filled }
}

export function providerLabel(providerID: string): string | undefined {
  switch (providerID) {
    case 'anthropic':
      return 'Claude Max'
    case 'openai':
      return 'ChatGPT'
    case 'opencode-go':
      return 'OpenCode Go'
    default:
      return undefined
  }
}
