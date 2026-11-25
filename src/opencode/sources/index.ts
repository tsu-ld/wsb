import { chatgptSource } from './chatgpt.ts'
import { claudeAgentSource } from './claude-agent.ts'
import { goSource } from './go.ts'
import { meridianSource } from './meridian.ts'
import type { Reading } from '../../deadline.ts'
import type { ConnectionAPI } from './chatgpt.ts'
import type { SessionHttpResponse, SessionRetry } from '@opencode/plugin/promise/session'

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export type Source = Readonly<{
  atResponse?: (event: SessionHttpResponse, now: number) => Promise<Reading>
  atError: (
    event: SessionRetry,
    earlier: Reading | undefined,
    now: number,
  ) => Promise<Reading> | Reading
}>

export function sources({
  connection,
  fetch,
}: Readonly<{ connection?: () => ConnectionAPI | undefined; fetch?: Fetch }> = {}) {
  const linked = connection ? { connection } : {}
  return {
    anthropic: meridianSource(fetch),
    'claude-agent': claudeAgentSource(),
    openai: chatgptSource(fetch ? { ...linked, fetch } : linked),
    'opencode-go': goSource(fetch ? { fetch } : {}),
  } satisfies { [providerID: string]: Source }
}

export function asProviders(registry: { [providerID: string]: Source }) {
  const adapt = ({ atResponse, atError }: Source) => ({
    observe: atResponse ? (event: SessionHttpResponse) => atResponse(event, Date.now()) : undefined,
    resolve: (_ctx: unknown, event: SessionRetry, now: number, earlier?: Reading) =>
      atError(event, earlier, now),
  })
  return Object.fromEntries(
    Object.entries(registry).map(([providerID, source]) => [providerID, adapt(source)]),
  )
}
