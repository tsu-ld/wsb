import { describe, expect, it } from 'bun:test'
import { read } from '../../src/vendors/claude-message.ts'

const NOW = Date.parse('2026-11-24T17:00:00.000Z')
const RESET = Date.parse('2026-11-24T19:30:00.000Z')
const real =
  "You've hit your 5-hour limit · resets 4:30pm (America/Argentina/Buenos_Aires) Resets at 2026-11-24T19:30:00.000Z."

const noDeadline = (message: unknown, kind: 'other' | 'unknown') => {
  const reading = read(message, NOW)
  expect(reading.kind).not.toBe('until')
  expect(reading.kind).toBe(kind)
}

describe('claudeMessage.read', () => {
  it('the native Claude Code refusal carries its own absolute reset', () => {
    expect(read(real, NOW)).toEqual({ kind: 'until', until: RESET })
  })

  it('the bare subscription message with only the reset is also read', () => {
    expect(
      read(
        'Claude Code subscription limit reached (five hour). Resets at 2026-11-24T19:30:00.000Z.',
        NOW,
      ),
    ).toEqual({ kind: 'until', until: RESET })
  })

  it('a limit without a reset time, an elapsed reset or an unrelated error leaves the host decision alone', () => {
    noDeadline("You've hit your 5-hour limit", 'unknown')
    noDeadline(real.replace('19:30', '16:30'), 'unknown')
    noDeadline('Claude Code could not finish its reply (HTTP 401)', 'other')
    noDeadline('Anthropic is overloaded (529). Resets at 2026-11-24T19:30:00.000Z.', 'other')
    noDeadline(undefined, 'other')
  })
})
