import type { Plugin } from '@opencode/plugin/tui'
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'
import { compact, remaining, resumeLabel, rise } from '../format.ts'
import { Definition, changedSession, isHoldState, isReason } from './rpc.ts'
import type { HoldState, Reason } from './rpc.ts'

type HoldStore = Readonly<{
  hold: () => HoldState | undefined
  why: () => Reason | undefined
  now: () => number
  dispose: () => void
}>

type Lease = Readonly<{ store: HoldStore; release: () => void }>

type Seen = Readonly<{ hold: HoldState; at: number }>

type Entry = { store: HoldStore; users: number }

const GRACE = 120_000

const stores = new WeakMap<Plugin.Context, Map<string, Entry>>()

export function shown(
  hold: HoldState | undefined,
  lastSeenAt: number,
  now: number,
): HoldState | undefined {
  if (!hold) {
    return undefined
  }
  return now < hold.until || now - Math.max(lastSeenAt, hold.until) < GRACE ? hold : undefined
}

function createHoldStore(context: Plugin.Context, sessionID: string): HoldStore {
  const [seen, setSeen] = createSignal<Seen>()
  const [why, setWhy] = createSignal<Reason>()
  const [now, setNow] = createSignal(Date.now())
  const rpc = context.client.rpc(Definition)
  let turn = 0
  let asked = 0
  let askedAt = 0
  let forced = false
  let active = true
  const settle = (next: HoldState | undefined) => {
    const at = Date.now()
    const force = forced
    forced = false
    if (next) {
      setSeen({ hold: next, at })
      return
    }
    const last = seen()
    if (!force && last && shown(last.hold, last.at, at) && at >= last.hold.until) {
      return
    }
    setSeen(undefined)
  }
  const load = (force = false) => {
    forced ||= force
    const current = ++turn
    const directory = context.data.session.get(sessionID)?.location.directory
    const options = directory ? { location: { directory } } : undefined
    void rpc.get({ sessionID }, options).then(
      (next) => {
        if (active && current === turn) {
          settle(isHoldState(next) ? next : undefined)
        }
      },
      () => {
        if (active && current === turn) {
          settle(undefined)
        }
      },
    )
    void rpc.why({ sessionID }, options).then(
      (next) => {
        if (active && current === turn) {
          setWhy(isReason(next) ? next : undefined)
        }
      },
      () => {
        if (active && current === turn) {
          setWhy(undefined)
        }
      },
    )
  }
  const refresh = (until: number, at: number) => {
    if (asked === until && at - askedAt < 30_000) {
      return
    }
    asked = until
    askedAt = at
    load()
  }
  const timer = setInterval(() => {
    const at = Date.now()
    setNow(at)
    const last = seen()
    if (last && at >= last.hold.until) {
      refresh(last.hold.until, at)
    }
  }, 1000)
  const changed = rpc.events.on('changed', (event) => {
    if (changedSession(event.data) === sessionID) {
      load(true)
    }
  })
  const connected = context.data.on('server.connected', () => load())
  load()
  return {
    hold: () => {
      const last = seen()
      return last && shown(last.hold, last.at, now())
    },
    why,
    now,
    dispose: () => {
      active = false
      turn += 1
      clearInterval(timer)
      changed()
      connected()
    },
  }
}

export function storeFor(context: Plugin.Context, sessionID: string): Lease {
  let entries = stores.get(context)
  if (!entries) {
    entries = new Map()
    stores.set(context, entries)
  }
  const scoped = entries
  let entry = scoped.get(sessionID)
  if (!entry) {
    entry = { store: createHoldStore(context, sessionID), users: 0 }
    scoped.set(sessionID, entry)
  }
  const acquired = entry
  acquired.users += 1
  let released = false
  return {
    store: acquired.store,
    release: () => {
      if (released) {
        return
      }
      released = true
      acquired.users -= 1
      if (acquired.users === 0) {
        if (scoped.get(sessionID) === acquired) {
          scoped.delete(sessionID)
        }
        acquired.store.dispose()
      }
    },
  }
}

function useHold(context: Plugin.Context, sessionID: () => string | undefined) {
  const [current, setCurrent] = createSignal<HoldStore>()
  let selected: string | undefined
  let lease: Lease | undefined
  createEffect(
    on(sessionID, (id) => {
      if (id === selected) {
        return
      }
      selected = id
      lease?.release()
      lease = id ? storeFor(context, id) : undefined
      setCurrent(lease?.store)
    }),
  )
  onCleanup(() => lease?.release())
  return {
    hold: () => current()?.hold(),
    why: () => current()?.why(),
    now: () => current()?.now() ?? Date.now(),
  }
}

function Panel(props: { context: Plugin.Context; sessionID: string }) {
  const { hold, why, now } = useHold(props.context, () => props.sessionID)
  const theme = props.context.theme
  const warning = theme.text.feedback.warning.base
  const error = theme.text.feedback.error.base

  return (
    <Show
      when={hold()}
      fallback={
        <Show when={why()}>
          {(reason) => (
            <box flexShrink={0} paddingLeft={3} paddingTop={1} paddingBottom={1}>
              <text fg={theme.text.muted}>
                <span style={{ fg: theme.text.base }}>wsb</span>
                {` · not waiting: ${reason().reason}`}
              </text>
            </box>
          )}
        </Show>
      }
    >
      {(current) => {
        return (
          <box flexShrink={0} paddingLeft={3} paddingTop={1} paddingBottom={1}>
            <text fg={theme.text.muted}>
              <span style={{ fg: theme.text.base }}>█</span>
              <span style={{ fg: error }}>{rise(current().since, current().until, now())}</span>
              <span style={{ fg: warning }}>█</span>
              {'  '}
              <span style={{ fg: theme.text.base }}>wsb</span>
              {` · ${resumeLabel(current().until, now())}`}
            </text>
          </box>
        )
      }}
    </Show>
  )
}

function Status(props: { context: Plugin.Context; sessionID: string | undefined }) {
  const { hold, now } = useHold(props.context, () => props.sessionID)

  return (
    <Show when={hold()}>
      {(current) => (
        <text fg={props.context.theme.text.feedback.warning.base} flexShrink={0}>
          {`wsb ${compact(remaining(current().until, now()))}`}
        </text>
      )}
    </Show>
  )
}

export default {
  id: 'wsb',
  setup(context: Plugin.Context) {
    const panel = context.ui.slot({
      append: 'session.composer.top',
      render: (input) => <Panel context={context} sessionID={input.sessionID} />,
    })
    const status = context.ui.slot({
      append: 'prompt.footer.status',
      render: (input) => <Status context={context} sessionID={input.sessionID} />,
    })
    return () => {
      panel()
      status()
    }
  },
}
