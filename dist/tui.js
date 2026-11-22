// @bun
// src/tui.tsx
import { effect as _$effect } from '@opentui/solid'
import { memo as _$memo } from '@opentui/solid'
import { insert as _$insert } from '@opentui/solid'
import { createTextNode as _$createTextNode } from '@opentui/solid'
import { insertNode as _$insertNode } from '@opentui/solid'
import { setProp as _$setProp } from '@opentui/solid'
import { createElement as _$createElement } from '@opentui/solid'
import { createComponent as _$createComponent } from '@opentui/solid'
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'

// src/hold.ts
var pad = (value) => String(value).padStart(2, '0')
function remaining(until, now) {
  return Math.max(0, Math.ceil((until - now) / 1000))
}
function countdown(seconds) {
  if (seconds >= 86400) {
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
  }
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
  }
  return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
}
function compact(seconds) {
  if (seconds >= 86400) {
    return `${Math.floor(seconds / 86400)}d`
  }
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m`
  }
  return `${seconds}s`
}
function clock(until, now) {
  const at = new Date(until)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (until - now < 86400000) {
    return time
  }
  const day = at.getDay() * 3
  return `${'SunMonTueWedThuFriSat'.slice(day, day + 3)} ${time}`
}
function bar(width, since, until, now) {
  const cells = Math.max(0, Math.floor(width))
  if (!(until > since)) {
    return { filled: cells, empty: 0 }
  }
  const ratio = Math.min(1, Math.max(0, (now - since) / (until - since)))
  const filled = Math.min(cells, Math.round(cells * ratio))
  return { filled, empty: cells - filled }
}
function providerLabel(providerID) {
  switch (providerID) {
    case 'anthropic':
      return 'Claude Max'
    case 'openai':
      return 'ChatGPT'
    case 'opencode-go':
      return 'OpenCode Go'
    default:
      return
  }
}

// src/rpc.ts
import { Rpc } from '@opencode/plugin/rpc'
var hold = {
  type: 'object',
  properties: {
    until: { type: 'number' },
    since: { type: 'number' },
    providerID: { type: 'string' },
    model: { type: 'string' },
  },
  required: ['until', 'since', 'providerID', 'model'],
  additionalProperties: false,
}
var state = {
  type: 'object',
  properties: {
    sessionID: { type: 'string' },
    ...hold.properties,
  },
  required: ['sessionID', ...hold.required],
  additionalProperties: false,
}
var Definition = Rpc.define({
  id: 'wsb.hold',
  methods: {
    get: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: { anyOf: [{ type: 'null' }, state] },
    },
  },
  events: {
    changed: {
      schema: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
    },
  },
})
var number = (value) => typeof value === 'number' && Number.isSafeInteger(value)
function changedSession(value) {
  if (!value || typeof value !== 'object' || !('sessionID' in value)) {
    return
  }
  return typeof value.sessionID === 'string' ? value.sessionID : undefined
}
function isHoldState(value) {
  if (!value || typeof value !== 'object') {
    return false
  }
  return (
    'sessionID' in value &&
    typeof value.sessionID === 'string' &&
    'until' in value &&
    number(value.until) &&
    'since' in value &&
    number(value.since) &&
    'providerID' in value &&
    typeof value.providerID === 'string' &&
    'model' in value &&
    typeof value.model === 'string'
  )
}

// src/tui.tsx
var CELLS = 24
function useNow() {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return now
}
function useHold(context, sessionID) {
  const [hold, setHold] = createSignal()
  const rpc = context.client.rpc(Definition)
  const load = (id) => {
    const directory = context.data.session.get(id)?.location.directory
    rpc
      .get(
        {
          sessionID: id,
        },
        directory
          ? {
              location: {
                directory,
              },
            }
          : undefined,
      )
      .then(
        (next) => {
          if (sessionID() === id) {
            setHold(isHoldState(next) ? next : undefined)
          }
        },
        () => {
          return
        },
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
  return {
    hold,
    load,
  }
}
function Panel(props) {
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
  return _$createComponent(Show, {
    get when() {
      return hold()
    },
    children: (current) => {
      const seconds = () => remaining(current().until, now())
      const cells = () => bar(CELLS, current().since, current().until, now())
      const provider = () => providerLabel(current().providerID)
      const last = () => (seconds() === 0 ? 'resetting\u2026' : countdown(seconds()))
      return (() => {
        var _el$ = _$createElement('box'),
          _el$2 = _$createElement('text'),
          _el$3 = _$createElement('span'),
          _el$5 = _$createElement('span'),
          _el$6 = _$createElement('span'),
          _el$7 = _$createElement('span'),
          _el$8 = _$createElement('text'),
          _el$9 = _$createElement('span'),
          _el$1 = _$createElement('span'),
          _el$11 = _$createElement('text'),
          _el$12 = _$createElement('span'),
          _el$14 = _$createTextNode(
            `then the same turn continues \xB7 a new message or Esc takes over`,
          )
        _$insertNode(_el$, _el$2)
        _$insertNode(_el$, _el$8)
        _$insertNode(_el$, _el$11)
        _$setProp(_el$, 'flexDirection', 'column')
        _$setProp(_el$, 'flexShrink', 0)
        _$setProp(_el$, 'paddingLeft', 3)
        _$setProp(_el$, 'paddingTop', 1)
        _$insertNode(_el$2, _el$3)
        _$insertNode(_el$2, _el$5)
        _$insertNode(_el$2, _el$6)
        _$insertNode(_el$2, _el$7)
        _$setProp(_el$2, 'fg', warning)
        _$insertNode(_el$3, _$createTextNode(`\u258C `))
        _$setProp(_el$3, 'style', {
          fg: warning,
        })
        _$setProp(_el$5, 'style', {
          fg: warning,
        })
        _$insert(_el$5, last)
        _$insert(_el$2, () => `${' '.repeat(Math.max(1, 7 - last().length))}left  `, _el$6)
        _$setProp(_el$6, 'style', {
          fg: warning,
        })
        _$insert(_el$6, () => '\u2501'.repeat(cells().filled))
        _$insert(_el$7, () => '\u2501'.repeat(cells().empty))
        _$insertNode(_el$8, _el$9)
        _$insertNode(_el$8, _el$1)
        _$insertNode(_el$9, _$createTextNode(`\u258C `))
        _$setProp(_el$9, 'style', {
          fg: warning,
        })
        _$insertNode(_el$1, _$createTextNode(`wsb`))
        _$setProp(_el$1, 'style', {
          fg: warning,
        })
        _$insert(_el$8, () => ` holds this turn until ${clock(current().until, now())}`, null)
        _$insert(
          _el$8,
          (() => {
            var _c$ = _$memo(() => !!provider())
            return () => (_c$() ? ` \xB7 ${provider()}` : '')
          })(),
          null,
        )
        _$insertNode(_el$11, _el$12)
        _$insertNode(_el$11, _el$14)
        _$insertNode(_el$12, _$createTextNode(`\u258C `))
        _$setProp(_el$12, 'style', {
          fg: warning,
        })
        _$effect(
          (_p$) => {
            var _v$ = {
                fg: theme.text.muted,
              },
              _v$2 = theme.text.muted,
              _v$3 = theme.text.muted
            _v$ !== _p$.e && (_p$.e = _$setProp(_el$7, 'style', _v$, _p$.e))
            _v$2 !== _p$.t && (_p$.t = _$setProp(_el$8, 'fg', _v$2, _p$.t))
            _v$3 !== _p$.a && (_p$.a = _$setProp(_el$11, 'fg', _v$3, _p$.a))
            return _p$
          },
          {
            e: undefined,
            t: undefined,
            a: undefined,
          },
        )
        return _el$
      })()
    },
  })
}
function Status(props) {
  const { hold, load } = useHold(props.context, () => props.sessionID)
  const now = useNow()
  createEffect(() => {
    const current = hold()
    const id = props.sessionID
    if (current && id && now() >= current.until) {
      load(id)
    }
  })
  return _$createComponent(Show, {
    get when() {
      return hold()
    },
    children: (current) =>
      (() => {
        var _el$15 = _$createElement('text')
        _$setProp(_el$15, 'flexShrink', 0)
        _$insert(_el$15, () => `wsb ${compact(remaining(current().until, now()))}`)
        _$effect((_$p) =>
          _$setProp(_el$15, 'fg', props.context.theme.text.feedback.warning.base, _$p),
        )
        return _el$15
      })(),
  })
}
var tui_default = {
  id: 'wsb',
  setup(context) {
    const panel = context.ui.slot({
      append: 'session.composer.top',
      render: (input) =>
        _$createComponent(Panel, {
          context,
          get sessionID() {
            return input.sessionID
          },
        }),
    })
    const status = context.ui.slot({
      append: 'prompt.footer.status',
      render: (input) =>
        _$createComponent(Status, {
          context,
          get sessionID() {
            return input.sessionID
          },
        }),
    })
    return () => {
      panel()
      status()
    }
  },
}
export { tui_default as default }
