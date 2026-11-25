import type { Plugin } from '@opencode/plugin/tui'
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'
import { compact, remaining, resumeLabel, rise } from './format.ts'
import { Definition, changedSession, isHoldState } from './rpc.ts'
import type { HoldState } from './rpc.ts'

function useNow() {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return now
}

function useHold(context: Plugin.Context, sessionID: () => string | undefined) {
  const [hold, setHold] = createSignal<HoldState>()
  const rpc = context.client.rpc(Definition)
  let turn = 0
  let asked = 0
  let askedAt = 0
  const load = (id: string) => {
    const current = ++turn
    const directory = context.data.session.get(id)?.location.directory
    void rpc.get({ sessionID: id }, directory ? { location: { directory } } : undefined).then(
      (next) => {
        if (current === turn && sessionID() === id) {
          setHold(isHoldState(next) ? next : undefined)
        }
      },
      () => undefined,
    )
  }
  const refresh = (id: string, until: number) => {
    const at = Date.now()
    if (asked === until && at - askedAt < 30_000) {
      return
    }
    asked = until
    askedAt = at
    load(id)
  }
  onCleanup(
    rpc.events.on('changed', (event) => {
      const id = changedSession(event.data)
      if (id && id === sessionID()) {
        load(id)
      }
    }),
  )
  onCleanup(
    context.data.on('server.connected', () => {
      const id = sessionID()
      if (id) {
        load(id)
      }
    }),
  )
  createEffect(
    on(sessionID, (id) => {
      setHold(undefined)
      asked = 0
      if (id) {
        load(id)
      }
    }),
  )
  return { hold, refresh }
}

function Panel(props: { context: Plugin.Context; sessionID: string }) {
  const { hold, refresh } = useHold(props.context, () => props.sessionID)
  const now = useNow()
  const theme = props.context.theme
  const warning = theme.text.feedback.warning.base
  const error = theme.text.feedback.error.base

  createEffect(() => {
    const current = hold()
    if (current && now() >= current.until) {
      refresh(props.sessionID, current.until)
    }
  })

  return (
    <Show when={hold()}>
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
  const { hold, refresh } = useHold(props.context, () => props.sessionID)
  const now = useNow()

  createEffect(() => {
    const current = hold()
    const id = props.sessionID
    if (current && id && now() >= current.until) {
      refresh(id, current.until)
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
