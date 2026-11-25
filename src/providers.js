import { claudeAgentReset } from './claude-agent.js'
import { codexReset, observeCodex } from './codex.js'
import { plausible } from './deadline.ts'
import { goAdapter } from './go-transport.js'
import { meridianSource } from './opencode/sources/meridian.ts'

const fromLegacy = (value) =>
  typeof value === 'number'
    ? { kind: 'until', until: value }
    : { kind: 'unknown', reason: 'legacy' }

const legacy = ({ observe, resolve }) => ({
  observe: observe && (async (event) => fromLegacy(await observe(event))),
  resolve: async (ctx, event, now, earlier) =>
    fromLegacy(
      await resolve(
        ctx,
        event,
        now,
        earlier?.kind === 'until' && plausible(earlier.until, now) ? earlier.until : undefined,
      ),
    ),
})

const adapt = (source) => ({
  observe: (event) => source.atResponse(event, Date.now()),
  resolve: (_ctx, event, now, earlier) => source.atError(event, earlier, now),
})

export function providers() {
  return {
    anthropic: adapt(meridianSource()),
    'claude-agent': legacy({ resolve: (_ctx, event, now) => claudeAgentReset(event, now) }),
    openai: legacy({ resolve: codexReset, observe: observeCodex }),
    'opencode-go': legacy(goAdapter()),
  }
}
