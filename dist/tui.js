// @bun
// src/tui.tsx
import { effect as _$effect } from '@opentui/solid'
import { insert as _$insert } from '@opentui/solid'
import { createTextNode as _$createTextNode } from '@opentui/solid'
import { insertNode as _$insertNode } from '@opentui/solid'
import { setProp as _$setProp } from '@opentui/solid'
import { createElement as _$createElement } from '@opentui/solid'
import { createComponent as _$createComponent } from '@opentui/solid'
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'

// src/format.ts
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
var LEVELS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588'
function rise(since, until, now) {
  if (!(until > since)) {
    return '\u2588'
  }
  const ratio = Math.min(1, Math.max(0, (now - since) / (until - since)))
  return LEVELS[Math.floor(ratio * (LEVELS.length - 1))] ?? '\u2588'
}
function resumeLabel(until, now) {
  const seconds = remaining(until, now)
  return seconds === 0
    ? 'resuming\u2026'
    : `waiting for the reset \xB7 resumes ${clock(until, now)} \xB7 in ${countdown(seconds)}`
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
function useNow() {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return now
}
function useHold(context, sessionID) {
  const [hold, setHold] = createSignal()
  const rpc = context.client.rpc(Definition)
  let turn = 0
  let asked = 0
  let askedAt = 0
  const load = (id) => {
    const current = ++turn
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
          if (current === turn && sessionID() === id) {
            setHold(isHoldState(next) ? next : undefined)
          }
        },
        () => {
          return
        },
      )
  }
  const refresh = (id, until) => {
    const at = Date.now()
    if (asked === until && at - askedAt < 30000) {
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
  return {
    hold,
    refresh,
  }
}
function Panel(props) {
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
  return _$createComponent(Show, {
    get when() {
      return hold()
    },
    children: (current) => {
      return (() => {
        var _el$ = _$createElement('box'),
          _el$2 = _$createElement('text'),
          _el$3 = _$createElement('span'),
          _el$5 = _$createElement('span'),
          _el$6 = _$createElement('span'),
          _el$8 = _$createTextNode(`  `),
          _el$9 = _$createElement('span')
        _$insertNode(_el$, _el$2)
        _$setProp(_el$, 'flexShrink', 0)
        _$setProp(_el$, 'paddingLeft', 3)
        _$setProp(_el$, 'paddingTop', 1)
        _$setProp(_el$, 'paddingBottom', 1)
        _$insertNode(_el$2, _el$3)
        _$insertNode(_el$2, _el$5)
        _$insertNode(_el$2, _el$6)
        _$insertNode(_el$2, _el$8)
        _$insertNode(_el$2, _el$9)
        _$insertNode(_el$3, _$createTextNode(`\u2588`))
        _$setProp(_el$5, 'style', {
          fg: error,
        })
        _$insert(_el$5, () => rise(current().since, current().until, now()))
        _$insertNode(_el$6, _$createTextNode(`\u2588`))
        _$setProp(_el$6, 'style', {
          fg: warning,
        })
        _$insertNode(_el$9, _$createTextNode(`wsb`))
        _$insert(_el$2, () => ` \xB7 ${resumeLabel(current().until, now())}`, null)
        _$effect(
          (_p$) => {
            var _v$ = theme.text.muted,
              _v$2 = {
                fg: theme.text.base,
              },
              _v$3 = {
                fg: theme.text.base,
              }
            _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, 'fg', _v$, _p$.e))
            _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, 'style', _v$2, _p$.t))
            _v$3 !== _p$.a && (_p$.a = _$setProp(_el$9, 'style', _v$3, _p$.a))
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
  const { hold, refresh } = useHold(props.context, () => props.sessionID)
  const now = useNow()
  createEffect(() => {
    const current = hold()
    const id = props.sessionID
    if (current && id && now() >= current.until) {
      refresh(id, current.until)
    }
  })
  return _$createComponent(Show, {
    get when() {
      return hold()
    },
    children: (current) =>
      (() => {
        var _el$1 = _$createElement('text')
        _$setProp(_el$1, 'flexShrink', 0)
        _$insert(_el$1, () => `wsb ${compact(remaining(current().until, now()))}`)
        _$effect((_$p) =>
          _$setProp(_el$1, 'fg', props.context.theme.text.feedback.warning.base, _$p),
        )
        return _el$1
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
