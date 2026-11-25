import { setTimeout as sleep } from 'node:timers/promises'
import { plausible } from './deadline.ts'
import { SessionLocks, SessionSignals } from './coordination.ts'
import type { Reading } from './deadline.ts'
import type { HoldState } from './rpc.ts'
import type { Plugin } from '@opencode/plugin'
import type { SessionHttpResponse, SessionRetry } from '@opencode/plugin/promise/session'

const key = (id: string) => `wait/${id}`

export type Route = Readonly<{
  agent: string
  model: Readonly<{ providerID: string; id: string; variant?: string | undefined }>
}>

export type Wait = Route & Readonly<{ until: number }>

export function sameRoute(left: Route, right: Route): boolean {
  return (
    left.agent === right.agent &&
    left.model.providerID === right.model.providerID &&
    left.model.id === right.model.id &&
    left.model.variant === right.model.variant
  )
}

const threw = (error: unknown): Reading => ({
  kind: 'other',
  reason: `threw ${error instanceof Error ? error.name : typeof error}`,
})

export interface ProviderAdapter {
  observe?: (event: SessionHttpResponse) => Promise<Reading>
  resolve(
    ctx: Plugin.Context,
    event: SessionRetry,
    now: number,
    observed?: Reading,
  ): Reading | Promise<Reading>
}

interface Stored extends Wait {
  readonly since?: number
}

function isWait(value: unknown): value is Stored {
  if (
    !value ||
    typeof value !== 'object' ||
    !('until' in value) ||
    !Number.isSafeInteger(value.until) ||
    !('agent' in value) ||
    typeof value.agent !== 'string' ||
    !('model' in value) ||
    ('since' in value && !Number.isSafeInteger(value.since))
  ) {
    return false
  }
  const model = value.model
  return (
    !!model &&
    typeof model === 'object' &&
    'providerID' in model &&
    typeof model.providerID === 'string' &&
    'id' in model &&
    typeof model.id === 'string' &&
    (!('variant' in model) || typeof model.variant === 'string')
  )
}

export async function holdFor(ctx: Plugin.Context, sessionID: string): Promise<HoldState | null> {
  const value = await ctx.storage.get(key(sessionID))
  if (!value || !isWait(value) || !plausible(value.until, Date.now())) {
    return null
  }
  return {
    sessionID,
    until: value.until,
    since: value.since ?? Math.min(Date.now(), value.until),
    providerID: value.model.providerID,
    model: value.model.id,
  }
}

export async function setup(
  ctx: Plugin.Context,
  readers: Record<string, ProviderAdapter>,
  onChange?: (sessionID: string) => void,
) {
  const pending = new SessionSignals()
  const changed = new SessionSignals()
  const locks = new SessionLocks()
  const observations = new Map<string, Route & Readonly<{ reading: Reading }>>()
  const unloading = new AbortController()

  await ctx.session.hook('http.response', async (event) => {
    if (event.kind !== 'primary') {
      return
    }
    observations.delete(event.sessionID)
    const observe =
      Object.hasOwn(readers, event.model.providerID) && readers[event.model.providerID]?.observe
    if (!observe) {
      return
    }
    await pending.run(event.sessionID, async (signal) => {
      const reading = await Promise.resolve()
        .then(() => observe(event))
        .catch(threw)
      if (signal.aborted || unloading.signal.aborted) {
        return
      }
      observations.set(event.sessionID, { model: event.model, agent: event.agent, reading })
    })
  })

  await ctx.session.hook('prompt', async ({ sessionID }) => {
    observations.delete(sessionID)
    pending.notify(sessionID)
    await locks.run(sessionID, () => ctx.storage.remove(key(sessionID)))
    changed.notify(sessionID)
    onChange?.(sessionID)
  })

  void (async () => {
    for await (const event of ctx.event.subscribe({
      types: ['session.execution.interrupted'],
      signal: unloading.signal,
    })) {
      if (event.data.reason === 'shutdown') {
        continue
      }
      const sessionID = event.data.sessionID
      observations.delete(sessionID)
      pending.notify(sessionID)
      await locks.run(sessionID, () => ctx.storage.remove(key(sessionID)))
      changed.notify(sessionID)
      onChange?.(sessionID)
    }
  })().catch(() => undefined)

  await ctx.session.hook('retry', async (event) => {
    const provider =
      Object.hasOwn(readers, event.model.providerID) && readers[event.model.providerID]
    if (!provider) {
      return
    }
    const observed = observations.get(event.sessionID)
    observations.delete(event.sessionID)
    await pending.run(event.sessionID, async (signal) => {
      const earlier = observed && sameRoute(observed, event) ? observed.reading : undefined
      const reading = await Promise.resolve()
        .then(() => provider.resolve(ctx, event, Date.now(), earlier))
        .catch(threw)
      if (signal.aborted || unloading.signal.aborted) {
        return
      }
      if (reading.kind !== 'until' || !plausible(reading.until, Date.now())) {
        return
      }
      const until = reading.until
      const base = {
        providerID: event.model.providerID,
        id: event.model.id,
      }
      const model = event.model.variant ? { ...base, variant: event.model.variant } : base
      await locks.run(event.sessionID, async () => {
        if (signal.aborted || unloading.signal.aborted) {
          return
        }
        await ctx.storage.set(key(event.sessionID), {
          until,
          since: Date.now(),
          agent: event.agent,
          model,
        })
        if (!signal.aborted && !unloading.signal.aborted) {
          event.decision = { retry: true, delay: Math.max(0, until - Date.now()) }
          changed.notify(event.sessionID)
          onChange?.(event.sessionID)
        }
      })
    })
  })

  await ctx.session.hook('context', async (event) => {
    while (!unloading.signal.aborted) {
      const waited = await changed.run(event.sessionID, async (changedSignal) => {
        const outcome = await locks.run(event.sessionID, async () => {
          const value = await ctx.storage.get(key(event.sessionID))
          if (!value) {
            return { delay: undefined, cleared: false }
          }
          const now = Date.now()
          if (isWait(value) && plausible(value.until, now)) {
            return {
              delay: sameRoute(value, event) ? value.until - now : undefined,
              cleared: false,
            }
          }
          await ctx.storage.remove(key(event.sessionID))
          return { delay: undefined, cleared: true }
        })
        if (outcome.cleared) {
          onChange?.(event.sessionID)
        }
        const decision = outcome.delay
        if (!decision) {
          return false
        }
        const signal = AbortSignal.any([changedSignal, unloading.signal])
        await sleep(Math.min(2_147_483_647, decision), undefined, {
          signal,
          ref: false,
        }).catch((error: unknown) => {
          if (!signal.aborted) {
            throw error
          }
        })
        return true
      })
      if (!waited) {
        return
      }
    }
  })
  return () => unloading.abort()
}
