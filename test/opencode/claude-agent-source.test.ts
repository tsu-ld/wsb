import { expect, test } from 'bun:test'
import { sources } from '../../src/opencode/sources/index.ts'

const NOW = Date.parse('2026-11-24T17:00:00.000Z')
const RESET = Date.parse('2026-11-24T19:30:00.000Z')
const real =
  "You've hit your 5-hour limit · resets 4:30pm (America/Argentina/Buenos_Aires) Resets at 2026-11-24T19:30:00.000Z."

test('the claude-agent provider is registered and resolves through the retry hook', async () => {
  const event = { error: { type: 'provider.unknown', message: real } }
  const reading = sources()['claude-agent'].atError(event, undefined, NOW)
  expect(reading).toEqual({ kind: 'until', until: RESET })
})
