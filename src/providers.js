import { claudeAgentReset } from './claude-agent.js'
import { claudeReset } from './claude.js'
import { codexReset, observeCodex } from './codex.js'
import { goAdapter } from './go-transport.js'

export function providers() {
  return {
    anthropic: {
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
    },
    'claude-agent': { resolve: (_ctx, event, now) => claudeAgentReset(event, now) },
    openai: { resolve: codexReset, observe: observeCodex },
    'opencode-go': goAdapter(),
  }
}
