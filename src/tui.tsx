import type { Plugin } from '@opencode/plugin/tui'
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'
import { bar, clock, compact, countdown, providerLabel, remaining } from './hold.ts'
import { Definition, changedSession, isHoldState } from './rpc.ts'
import type { HoldState } from './rpc.ts'

const CELLS = 24

function useNow() {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return now
}

function useHold(context: Plugin.Context, sessionID: () => string | undefined) {
  const [hold, setHold] = createSignal<HoldState>()
  const rpc = context.client.rpc(Definition)
  const load = (id: string) => {
    const directory = context.data.session.get(id)?.location.directory
    void rpc.get({ sessionID: id }, directory ? { location: { directory } } : undefined).then(
      (next) => {
        if (sessionID() === id) {
          setHold(isHoldState(next) ? next : undefined)
        }
      },
      () => undefined,
    )
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
      if (id) {
        load(id)
      }
    }),
  )
  return { hold, load }
}

function Panel(props: { context: Plugin.Context; sessionID: string }) {
  const { hold, load } = useHold(props.context, () => props.sessionID)
  const now = useNow()
  const theme = props.context.theme
  const warning = theme.text.feedback.warning.base

  createEffect(() => {
    const current = hold()
    if (current && now() >= current.until) {
      load(props.sessionID)
    }
  })

  return (
    <Show when={hold()}>
      {(current) => {
        const seconds = () => remaining(current().until, now())
        const cells = () => bar(CELLS, current().since, current().until, now())
        const provider = () => providerLabel(current().providerID)
        const last = () => (seconds() === 0 ? 'resetting…' : countdown(seconds()))
        return (
          <box flexDirection="column" flexShrink={0} paddingLeft={3} paddingTop={1}>
            <text fg={warning}>
              <span style={{ fg: warning }}>▌ </span>
              <span style={{ fg: warning }}>{last()}</span>
              {`${' '.repeat(Math.max(1, 7 - last().length))}left  `}
              <span style={{ fg: warning }}>{'━'.repeat(cells().filled)}</span>
              <span style={{ fg: theme.text.muted }}>{'━'.repeat(cells().empty)}</span>
            </text>
            <text fg={theme.text.muted}>
              <span style={{ fg: warning }}>▌ </span>
              <span style={{ fg: warning }}>wsb</span>
              {` holds this turn until ${clock(current().until, now())}`}
              {provider() ? ` · ${provider()}` : ''}
            </text>
            <text fg={theme.text.muted}>
              <span style={{ fg: warning }}>▌ </span>
              then the same turn continues · a new message or Esc takes over
            </text>
          </box>
        )
      }}
    </Show>
  )
}

function Status(props: { context: Plugin.Context; sessionID: string | undefined }) {
  const { hold, load } = useHold(props.context, () => props.sessionID)
  const now = useNow()

  createEffect(() => {
    const current = hold()
    const id = props.sessionID
    if (current && id && now() >= current.until) {
      load(id)
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
