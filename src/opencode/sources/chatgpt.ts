import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { plausible } from '../../deadline.ts'
import { inferenceRequest, parseRefusal, readUsage } from '../../vendors/chatgpt.ts'
import { record, text } from '../../wire.ts'
import type { Reading } from '../../deadline.ts'
import type { Fetch } from '../../vendors/chatgpt.ts'
import type { Wire } from '../../wire.ts'

export type ResponseEvent = Readonly<{
  kind: string
  request: Request
  response: Response
}>

export type ErrorEvent = Readonly<{
  error?:
    | Readonly<{ type?: unknown; response?: Readonly<{ body?: unknown }> | undefined }>
    | undefined
}>

export type Connection = Readonly<{ method?: unknown; type?: unknown }>

export type ConnectionAPI = Readonly<{
  active: (id: string) => Promise<Connection | undefined>
  resolve: (connection: Connection) => Promise<Wire | undefined>
}>

const LIMIT_TYPE = 'provider.chatgpt-limit'

const other = (reason: string): Reading => ({ kind: 'other', reason })
const unknown = (reason: string): Reading => ({ kind: 'unknown', reason })

type CodexLogin = Readonly<{ token: string; account: string }>

async function readCodexLogin(): Promise<CodexLogin | undefined> {
  const home = process.env['CODEX_HOME'] || join(homedir(), '.codex')
  try {
    const value: unknown = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
    const auth = record(value)
    const tokens = record(auth?.['tokens'])
    const token = text(tokens?.['access_token'])
    const account = text(tokens?.['account_id'])
    return auth?.['auth_mode'] === 'chatgpt' && token && account ? { token, account } : undefined
  } catch {
    return undefined
  }
}

export function bearerFrom(credential: unknown) {
  const oauth = record(credential)
  if (!oauth || oauth['type'] !== 'oauth') {
    return undefined
  }
  const access = text(oauth['access'])
  if (!access) {
    return undefined
  }
  const metadata = record(oauth['metadata']) ?? {}
  const accountID = text(metadata['accountID'] ?? metadata['accountId'] ?? oauth['accountId'])
  return { access, accountID: accountID || undefined }
}

export function chatgptSource({
  fetch = globalThis.fetch,
  connection,
  codexLogin = readCodexLogin,
}: Readonly<{
  fetch?: Fetch
  connection?: () => ConnectionAPI | undefined
  codexLogin?: () => Promise<CodexLogin | undefined>
}> = {}) {
  return {
    async atResponse(event: ResponseEvent, now: number): Promise<Reading> {
      if (event.kind !== 'primary') {
        return other('not a primary request')
      }
      if (event.response.status !== 429) {
        return other(`status ${event.response.status}`)
      }
      if (!inferenceRequest(event.request.url)) {
        return other('not a ChatGPT inference request')
      }
      const bearer = event.request.headers.get('authorization')
      const account = event.request.headers.get('chatgpt-account-id')
      if (!bearer?.startsWith('Bearer ')) {
        return other('no bearer token')
      }
      if (!account) {
        return other('no account header')
      }
      const body: unknown = await event.response
        .clone()
        .json()
        .catch(() => undefined)
      const refusal = parseRefusal(body, now)
      if (refusal.kind === 'veto') {
        return other('not waitable')
      }
      if (refusal.kind !== 'limit') {
        return other('not a usage limit')
      }
      if (refusal.account && refusal.account !== account) {
        return other('refusal for another account')
      }
      if (plausible(refusal.direct, now)) {
        return { kind: 'until', until: refusal.direct }
      }
      return readUsage({ token: bearer.slice(7), account, fetch, now })
    },
    async atError(event: ErrorEvent, earlier: Reading | undefined, now: number): Promise<Reading> {
      const refusal = parseRefusal(event.error?.response?.body, now)
      if (refusal.kind === 'veto') {
        return other('not waitable')
      }
      if (event.error?.type !== LIMIT_TYPE && refusal.kind !== 'limit') {
        return other('not a usage limit')
      }
      const api = connection?.()
      if (!api) {
        return other('no connection API')
      }
      const active = await api.active('openai')
      if (!active || (active.method ?? active.type) !== 'oauth') {
        return other('not an oauth connection')
      }
      const auth = bearerFrom(await api.resolve(active))
      if (!auth) {
        return other('no oauth credential')
      }
      if (refusal.account && refusal.account !== auth.accountID) {
        return other('refusal for another account')
      }
      if (plausible(refusal.direct, now)) {
        return { kind: 'until', until: refusal.direct }
      }
      if (earlier?.kind === 'until' && plausible(earlier.until, now)) {
        return earlier
      }
      if (!refusal.account) {
        if (auth.accountID) {
          return unknown('no account in the refusal')
        }
        const codex = await codexLogin()
        return codex
          ? readUsage({ token: codex.token, account: codex.account, fetch, now })
          : unknown(
              'Sign in with ChatGPT gives no reset time; run `codex login` or reconnect OpenAI with Codex browser (legacy)',
            )
      }
      return readUsage({ token: auth.access, account: refusal.account, fetch, now })
    },
  }
}
