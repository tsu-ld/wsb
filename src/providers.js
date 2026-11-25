import { claudeAgentReset } from './claude-agent.js'
import { claudeReset } from './claude.js'
import { codexReset, observeCodex } from './codex.js'
import { plausible } from './deadline.ts'
import { goAdapter } from './go-transport.js'

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

export function providers() {
  return {
    anthropic: legacy({
      async observe({ request, response, model, kind, sessionID }) {
        if (
          kind !== 'primary' ||
          response.status !== 429 ||
          request.headers.get('x-opencode-session') !== sessionID
        ) {
          return
        }
        const body = await response
          .clone()
          .json()
          .catch(() => undefined)
        if (
          body?.error?.type !== 'rate_limit_error' ||
          !/claude max rate limit reached/i.test(body.error.message)
        ) {
          return
        }
        return claudeReset(
          {
            providerID: 'anthropic',
            modelID: model.id,
            meridianBaseURL: request.url,
            meridianKey: request.headers.get('x-api-key'),
          },
          { status: response.status, error: body.error },
          Date.now(),
        )
      },
      resolve: (_ctx, event, _now, observed) =>
        event.error?.status === 429 ? observed : undefined,
    }),
    'claude-agent': legacy({ resolve: (_ctx, event, now) => claudeAgentReset(event, now) }),
    openai: legacy({ resolve: codexReset, observe: observeCodex }),
    'opencode-go': legacy(goAdapter()),
  }
}
