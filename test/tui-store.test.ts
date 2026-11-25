import { expect, test } from 'bun:test'
import type { Plugin } from '@opencode/plugin/tui'
import { shown, storeFor } from '../src/opencode/tui.tsx'
import type { HoldState } from '../src/opencode/rpc.ts'

const fits = <T, V>(_value: V): _value is V & T => true

function context() {
  const calls = new Array<string>()
  const fake = {
    client: {
      rpc: () => ({
        get: (input: Readonly<{ sessionID: string }>) => {
          calls.push(`get ${input.sessionID}`)
          return Promise.resolve(null)
        },
        why: (input: Readonly<{ sessionID: string }>) => {
          calls.push(`why ${input.sessionID}`)
          return Promise.resolve(null)
        },
        events: { on: () => () => undefined },
      }),
    },
    data: {
      session: { get: () => undefined },
      on: () => () => undefined,
    },
  }
  if (!fits<Plugin.Context, typeof fake>(fake)) {
    throw new Error('unreachable')
  }
  return { context: fake, calls }
}

const hold: HoldState = {
  sessionID: 's',
  until: 1_000_000,
  since: 900_000,
  providerID: 'claude-agent',
  model: 'opus',
}

test('two contexts get distinct stores for the same session', () => {
  const first = storeFor(context().context, 's')
  const second = storeFor(context().context, 's')
  expect(second.store).not.toBe(first.store)
  first.release()
  second.release()
})

test('two slots of one context share one store', () => {
  const { context: shared } = context()
  const panel = storeFor(shared, 's')
  const status = storeFor(shared, 's')
  expect(status.store).toBe(panel.store)
  panel.release()
  status.release()
  const next = storeFor(shared, 's')
  expect(next.store).not.toBe(panel.store)
  next.release()
})

test('a new store asks for the hold and the reason at once', () => {
  const { context: fresh, calls } = context()
  const lease = storeFor(fresh, 's')
  expect(calls).toEqual(['get s', 'why s'])
  lease.release()
})

test('a passed hold stays shown for 2 minutes after it was last seen', () => {
  expect(shown(hold, 950_000, 999_999)).toBe(hold)
  expect(shown(hold, 1_010_000, 1_010_000)).toBe(hold)
  expect(shown(hold, 1_010_000, 1_129_999)).toBe(hold)
  expect(shown(hold, 1_010_000, 1_130_000)).toBeUndefined()
  expect(shown(undefined, 1_010_000, 1_010_000)).toBeUndefined()
})
