import { expect, test } from 'bun:test'
import { providers } from '../../src/providers.js'

const NOW = Date.parse('2026-11-24T17:00:00.000Z')
const RESET = Date.parse('2026-11-24T19:30:00.000Z')
const real =
  "You've hit your 5-hour limit · resets 4:30pm (America/Argentina/Buenos_Aires) Resets at 2026-11-24T19:30:00.000Z."

test('the claude-agent provider is registered and resolves through the retry hook', async () => {
  const adapter = providers()['claude-agent']
  const reading = await adapter.resolve(
    {},
    { error: { type: 'provider.unknown', message: real } },
    NOW,
  )
  expect(reading).toEqual({ kind: 'until', until: RESET })
})
