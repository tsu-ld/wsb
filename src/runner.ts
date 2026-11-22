import { setTimeout as sleep } from 'node:timers/promises'
import { sameRoute, retryDecision } from './policy.ts'
import { SessionLocks, SessionSignals } from './coordination.ts'
import type { Wait } from './policy.ts'
import type { Plugin } from '@opencode/plugin'
import type { SessionHttpResponse, SessionRetry } from '@opencode/plugin/promise/session'

const key = (id: string) => `wait/${id}`

export interface ProviderAdapter {
  observe?: (event: SessionHttpResponse) => Promise<number | undefined>
  resolve(
    ctx: Plugin.Context,
    event: SessionRetry,
    now: number,
    observed?: number,
  ): Promise<number | undefined> | number | undefined
}

function isWait(value: unknown): value is Wait {
  if (
    !value ||
    typeof value !== 'object' ||
    !('until' in value) ||
    !Number.isSafeInteger(value.until) ||
    !('agent' in value) ||
    typeof value.agent !== 'string' ||
    !('model' in value)
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

export async function setup(ctx: Plugin.Context, readers: Record<string, ProviderAdapter>) {
  const pending = new SessionSignals()
  const changed = new SessionSignals()
  const locks = new SessionLocks()
  const observations = new Map<string, Wait>()
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
      const until = await observe(event).catch(() => undefined)
      if (
        signal.aborted ||
        unloading.signal.aborted ||
        until === undefined ||
        !retryDecision(until, Date.now())
      ) {
        return
      }
      observations.set(event.sessionID, { model: event.model, agent: event.agent, until })
    })
  })

  await ctx.session.hook('prompt', async ({ sessionID }) => {
    observations.delete(sessionID)
    pending.notify(sessionID)
    await locks.run(sessionID, () => ctx.storage.remove(key(sessionID)))
    changed.notify(sessionID)
  })

  await ctx.session.hook('retry', async (event) => {
    const provider =
      Object.hasOwn(readers, event.model.providerID) && readers[event.model.providerID]
    if (!provider) {
      return
    }
    const observed = observations.get(event.sessionID)
    observations.delete(event.sessionID)
    await pending.run(event.sessionID, async (signal) => {
      const matching = observed && sameRoute(observed, event)
      const until = await Promise.resolve()
        .then(() => provider.resolve(ctx, event, Date.now(), matching ? observed.until : undefined))
        .catch(() => undefined)
      if (signal.aborted || unloading.signal.aborted) {
        return
      }
      if (until === undefined || !retryDecision(until, Date.now())) {
        return
      }
      const base = {
        providerID: event.model.providerID,
        id: event.model.id,
      }
      const model = event.model.variant ? { ...base, variant: event.model.variant } : base
      await locks.run(event.sessionID, async () => {
        if (signal.aborted || unloading.signal.aborted) {
          return
        }
        await ctx.storage.set(key(event.sessionID), { until, agent: event.agent, model })
        if (!signal.aborted && !unloading.signal.aborted) {
          event.decision = { retry: true, delay: Math.max(0, until - Date.now()) }
          changed.notify(event.sessionID)
        }
      })
    })
  })

  await ctx.session.hook('context', async (event) => {
    while (!unloading.signal.aborted) {
      const waited = await changed.run(event.sessionID, async (changedSignal) => {
        const decision = await locks.run(event.sessionID, async () => {
          const value = await ctx.storage.get(key(event.sessionID))
          if (!value) {
            return undefined
          }
          if (isWait(value)) {
            const delay = retryDecision(value.until, Date.now())
            if (delay) {
              return sameRoute(value, event) ? delay : undefined
            }
          }
          await ctx.storage.remove(key(event.sessionID))
          return undefined
        })
        if (!decision) {
          return false
        }
        const signal = AbortSignal.any([changedSignal, unloading.signal])
        await sleep(Math.min(2_147_483_647, decision.delay), undefined, {
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
