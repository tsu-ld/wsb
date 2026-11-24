export interface Hold {
  readonly until: number
  readonly since: number
  readonly providerID: string
  readonly model: string
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

export function clock(until: number, now: number): string {
  const at = new Date(until)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (until - now < 86_400_000) {
    return time
  }
  const day = at.getDay() * 3
  return `${'SunMonTueWedThuFriSat'.slice(day, day + 3)} ${time}`
}

const LEVELS = '▁▂▃▄▅▆▇█'

export function rise(since: number, until: number, now: number): string {
  if (!(until > since)) {
    return '█'
  }
  const ratio = Math.min(1, Math.max(0, (now - since) / (until - since)))
  return LEVELS[Math.floor(ratio * (LEVELS.length - 1))] ?? '█'
}

export function resumeLabel(until: number, now: number): string {
  const seconds = remaining(until, now)
  return seconds === 0
    ? 'resuming…'
    : `waiting for the reset · resumes ${clock(until, now)} · in ${countdown(seconds)}`
}
