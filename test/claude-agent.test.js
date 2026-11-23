import { expect, test } from 'bun:test'
import { claudeAgentReset } from '../src/claude-agent.js'
import { providers } from '../src/providers.js'

const NOW = Date.parse('2026-11-24T17:00:00.000Z')
const RESET = Date.parse('2026-11-24T19:30:00.000Z')
const error = (message, type = 'provider.unknown') => ({ type, message })
const real =
  "You've hit your 5-hour limit · resets 4:30pm (America/Argentina/Buenos_Aires) Resets at 2026-11-24T19:30:00.000Z."

test('the native Claude Code refusal carries its own absolute reset', () => {
  expect(claudeAgentReset({ error: error(real) }, NOW)).toBe(RESET)
})

test('the bare subscription message with only the reset is also read', () => {
  expect(
    claudeAgentReset(
      {
        error: error(
          'Claude Code subscription limit reached (five hour). Resets at 2026-11-24T19:30:00.000Z.',
        ),
      },
      NOW,
    ),
  ).toBe(RESET)
})

test('a limit without a reset time, an elapsed reset or an unrelated error leaves the host decision alone', () => {
  expect(claudeAgentReset({ error: error("You've hit your 5-hour limit") }, NOW)).toBeUndefined()
  expect(claudeAgentReset({ error: error(real.replace('19:30', '16:30')) }, NOW)).toBeUndefined()
  expect(
    claudeAgentReset({ error: error('Claude Code could not finish its reply (HTTP 401)') }, NOW),
  ).toBeUndefined()
  expect(
    claudeAgentReset(
      { error: error('Anthropic is overloaded (529). Resets at 2026-11-24T19:30:00.000Z.') },
      NOW,
    ),
  ).toBeUndefined()
  expect(claudeAgentReset({}, NOW)).toBeUndefined()
})

test('the claude-agent provider is registered and resolves through the retry hook', async () => {
  const adapter = providers()['claude-agent']
  const until = await adapter.resolve({}, { error: error(real) }, NOW)
  expect(until).toBe(RESET)
})
