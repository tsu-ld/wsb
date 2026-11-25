import { setTimeout as sleep } from 'node:timers/promises'
import { plausible } from '../deadline.ts'
import { record } from '../wire.ts'
import { dispatchDecision, key, project, sameRoute } from './hold.ts'
import { SessionLocks } from './locks.ts'
import { Definition, changedSession } from './rpc.ts'
import { sources } from './sources/index.ts'
import type { Reading } from '../deadline.ts'
import type { ConnectionAPI } from './sources/chatgpt.ts'
import type { Route } from './hold.ts'
import type { Source } from './sources/index.ts'
import type { Plugin } from '@opencode/plugin'
import type { SessionRetry } from '@opencode/plugin/promise/session'

export const MAX_SLEEP_MS = 2_147_483_647

type Legacy = Readonly<{
  resolve: (
    ctx: Plugin.Context,
    event: SessionRetry,
    now: number,
    earlier?: Reading,
  ) => Reading | Promise<Reading>
}>

export type Registry = Readonly<{ [providerID: string]: Source | Legacy }>

export type Options = Readonly<{ maxSleepMs?: number }>

const threw = (error: unknown): Reading => ({
  kind: 'other',
  reason: `threw ${error instanceof Error ? error.name : typeof error}`,
})

export async function setup(
  ctx: Plugin.Context,
  registry: Registry,
  onChange?: (sessionID: string) => void,
  { maxSleepMs = MAX_SLEEP_MS }: Options = {},
) {
  const adapted = new Map<string, Source>(
    Object.entries(registry).map(([providerID, source]) => [
      providerID,
      'atError' in source
        ? source
        : { atError: (event, earlier, now) => source.resolve(ctx, event, now, earlier) },
    ]),
  )
  const locks = new SessionLocks()
  const observations = new Map<string, Route & Readonly<{ reading: Reading }>>()
  const epochs = new Map<string, number>()
  const wakes = new Map<string, PromiseWithResolvers<void>>()
  const unloading = new AbortController()
  const unloaded = Promise.withResolvers<void>()

  const epoch = (sessionID: string) => epochs.get(sessionID) ?? 0
  const current = (sessionID: string, started: number) =>
    !unloading.signal.aborted && epoch(sessionID) === started

  const woken = (sessionID: string) => {
    const existing = wakes.get(sessionID)
    if (existing) {
      return existing.promise
    }
    const created = Promise.withResolvers<void>()
    wakes.set(sessionID, created)
    return created.promise
  }

  const wake = (sessionID: string) => {
    wakes.get(sessionID)?.resolve()
    wakes.delete(sessionID)
  }

  const nap = async (ms: number, wakeup: Promise<void>) => {
    const timer = new AbortController()
    await Promise.race([
      sleep(ms, undefined, { signal: timer.signal, ref: false }).catch(() => undefined),
      wakeup,
      unloaded.promise,
    ])
    timer.abort()
  }

  const release = async (sessionID: string) => {
    observations.delete(sessionID)
    epochs.set(sessionID, epoch(sessionID) + 1)
    await locks.run(sessionID, () => ctx.storage.remove(key(sessionID)))
    wake(sessionID)
    onChange?.(sessionID)
  }

  await ctx.session.hook('http.response', async (event) => {
    if (event.kind !== 'primary') {
      return
    }
    const sessionID = event.sessionID
    observations.delete(sessionID)
    const atResponse = adapted.get(event.model.providerID)?.atResponse
    if (!atResponse) {
      return
    }
    const started = epoch(sessionID)
    const reading = await Promise.resolve()
      .then(() => atResponse(event, Date.now()))
      .catch(threw)
    if (current(sessionID, started)) {
      observations.set(sessionID, { model: event.model, agent: event.agent, reading })
    }
  })

  await ctx.session.hook('prompt', ({ sessionID }) => release(sessionID))

  void (async () => {
    for await (const event of ctx.event.subscribe({
      types: ['session.execution.interrupted'],
      signal: unloading.signal,
    })) {
      if (event.data.reason !== 'shutdown') {
        await release(event.data.sessionID)
      }
    }
  })().catch(() => undefined)

  await ctx.session.hook('retry', async (event) => {
    const sessionID = event.sessionID
    const source = adapted.get(event.model.providerID)
    if (!source) {
      return
    }
    const observed = observations.get(sessionID)
    observations.delete(sessionID)
    const started = epoch(sessionID)
    const earlier = observed && sameRoute(observed, event) ? observed.reading : undefined
    const reading = await Promise.resolve()
      .then(() => source.atError(event, earlier, Date.now()))
      .catch(threw)
    if (
      !current(sessionID, started) ||
      reading.kind !== 'until' ||
      !plausible(reading.until, Date.now())
    ) {
      return
    }
    const until = reading.until
    const base = { providerID: event.model.providerID, id: event.model.id }
    const model = event.model.variant ? { ...base, variant: event.model.variant } : base
    await locks.run(sessionID, async () => {
      if (!current(sessionID, started)) {
        return
      }
      await ctx.storage.set(key(sessionID), {
        until,
        since: Date.now(),
        agent: event.agent,
        model,
      })
      if (!current(sessionID, started)) {
        return
      }
      event.decision = { retry: true, delay: Math.max(0, until - Date.now()) }
      wake(sessionID)
      onChange?.(sessionID)
    })
  })

  await ctx.session.hook('context', async (event) => {
    const sessionID = event.sessionID
    while (!unloading.signal.aborted) {
      const wakeup = woken(sessionID)
      const decision = await locks.run(sessionID, async () => {
        const next = dispatchDecision(await ctx.storage.get(key(sessionID)), event, Date.now())
        if (next.kind === 'remove') {
          await ctx.storage.remove(key(sessionID))
        }
        return next
      })
      if (decision.kind === 'remove') {
        onChange?.(sessionID)
      }
      if (decision.kind !== 'sleep') {
        return
      }
      await nap(Math.min(maxSleepMs, decision.delay), wakeup)
    }
  })

  return () => {
    unloading.abort()
    unloaded.resolve()
  }
}

export async function start(ctx: Plugin.Context, registry: Registry, options: Options = {}) {
  const state = new Map<'notify', (sessionID: string) => void>()
  const dispose = await setup(
    ctx,
    registry,
    (sessionID) => state.get('notify')?.(sessionID),
    options,
  )
  const registration = await ctx.rpc.register(Definition, {
    get: async (input) => {
      const sessionID = changedSession(input)
      return sessionID
        ? project(sessionID, await ctx.storage.get(key(sessionID)), Date.now())
        : null
    },
  })
  state.set('notify', (sessionID) => {
    void registration.events.emit('changed', { sessionID }).catch(() => undefined)
  })
  return async () => {
    await registration.dispose()
    dispose()
  }
}

type Host = Plugin.Context['integration']['connection']

function linked(host: Host): ConnectionAPI {
  const seen = new WeakMap<object, Parameters<Host['resolve']>[0]>()
  return {
    active: async (id) => {
      const info = await host.active(id)
      if (info) {
        seen.set(info, info)
      }
      return info
    },
    resolve: async (connection) => {
      const info = seen.get(connection)
      return info ? record(await host.resolve(info)) : undefined
    },
  }
}

export default {
  id: 'wsb',
  setup: (ctx: Plugin.Context) =>
    start(
      ctx,
      sources({
        connection: () => {
          const host = ctx.integration?.connection
          return host ? linked(host) : undefined
        },
      }),
    ),
}
