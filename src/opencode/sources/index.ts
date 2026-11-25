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
