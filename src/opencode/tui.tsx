import type { Plugin } from '@opencode/plugin/tui'
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'
import { compact, remaining, resumeLabel, rise } from '../format.ts'
import { Definition, changedSession, isHoldState, isReason } from './rpc.ts'
import type { HoldState, Reason } from './rpc.ts'

type HoldStore = Readonly<{
  hold: () => HoldState | undefined
  why: () => Reason | undefined
  now: () => number
  refresh: (until: number) => void
  dispose: () => void
}>

type Lease = Readonly<{ store: HoldStore; release: () => void }>

const stores = new Map<string, { store: HoldStore; users: number }>()

function createHoldStore(context: Plugin.Context, sessionID: string): HoldStore {
  const [hold, setHold] = createSignal<HoldState>()
  const [why, setWhy] = createSignal<Reason>()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  const rpc = context.client.rpc(Definition)
  let turn = 0
  let asked = 0
  let askedAt = 0
  let active = true
  const load = () => {
    const current = ++turn
    const directory = context.data.session.get(sessionID)?.location.directory
    const options = directory ? { location: { directory } } : undefined
    void rpc.get({ sessionID }, options).then(
      (next) => {
        if (active && current === turn) {
          setHold(isHoldState(next) ? next : undefined)
        }
      },
      () => {
        if (active && current === turn) {
          setHold(undefined)
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
  const refresh = (until: number) => {
    const at = Date.now()
    if (asked === until && at - askedAt < 30_000) {
      return
    }
    asked = until
    askedAt = at
    load()
  }
  const changed = rpc.events.on('changed', (event) => {
    if (changedSession(event.data) === sessionID) {
      load()
    }
  })
  const connected = context.data.on('server.connected', load)
  return {
    hold,
    why,
    now,
    refresh,
    dispose: () => {
      active = false
      turn += 1
      clearInterval(timer)
      changed()
      connected()
    },
  }
}

function acquireHold(context: Plugin.Context, sessionID: string): Lease {
  let entry = stores.get(sessionID)
  if (!entry) {
    entry = { store: createHoldStore(context, sessionID), users: 0 }
    stores.set(sessionID, entry)
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
        if (stores.get(sessionID) === acquired) {
          stores.delete(sessionID)
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
      lease = id ? acquireHold(context, id) : undefined
      setCurrent(lease?.store)
    }),
  )
  onCleanup(() => lease?.release())
  return {
    hold: () => current()?.hold(),
    why: () => current()?.why(),
    now: () => current()?.now() ?? Date.now(),
    refresh: (until: number) => current()?.refresh(until),
  }
}

function Panel(props: { context: Plugin.Context; sessionID: string }) {
  const { hold, why, now, refresh } = useHold(props.context, () => props.sessionID)
  const theme = props.context.theme
  const warning = theme.text.feedback.warning.base
  const error = theme.text.feedback.error.base

  createEffect(() => {
    const current = hold()
    if (current && now() >= current.until) {
      refresh(current.until)
    }
  })

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
  const { hold, now, refresh } = useHold(props.context, () => props.sessionID)

  createEffect(() => {
    const current = hold()
    if (current && props.sessionID && now() >= current.until) {
      refresh(current.until)
    }
  })

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
