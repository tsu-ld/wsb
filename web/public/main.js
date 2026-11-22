const body = document.body
const chart = document.querySelector('.chart')
const head = document.querySelector('.head')
const clock = document.querySelector('.clock')
const statusWord = document.querySelector('.status-word')
const logSrc = document.querySelector('.log .src')
const logMsg = document.querySelector('.log .msg-log')
const still = matchMedia('(prefers-reduced-motion: reduce)').matches

for (const track of document.querySelectorAll('.track')) {
  const fill = document.createElement('div')
  fill.className = 'fill'
  for (const seg of track.querySelectorAll('.seg')) {
    fill.append(seg.cloneNode(true))
  }
  track.append(fill)
}

const KEYS = [
  [0, 90],
  [2.4, 161],
  [3.8, 161],
  [6, 197],
  [6.9, 197],
  [7.5, 204],
  [8.3, 204],
  [11.2, 535],
  [14.2, 535],
]
const LOOP = 14.6

const PHASES = [
  [
    161,
    'work',
    'Working',
    'opencode',
    ['Read src/search.ts', 'Edit src/rank.ts', 'bun test · 128 pass', 'Edit src/cache.ts'],
  ],
  [161.5, 'limit', 'Limit hit', 'claude', ["You've hit your 5-hour limit · resets 3:17am"]],
  [197, 'hold', 'Holding', 'wsb', ['holding this turn until 03:17']],
  [204, 'back', 'Retrying', 'wsb', ['reset · retrying the same turn, same model']],
  [535, 'done', 'Done', 'opencode', ['bun test · 131 pass · done at 03:24']],
  [Infinity, 'done', 'Done', 'you', ['08:55 · wake up to finished work']],
]

const ease = (t) => t * t * (3 - 2 * t)

function minutesAt(t) {
  for (let i = 1; i < KEYS.length; i++) {
    const [t1, m1] = KEYS[i]
    if (t <= t1) {
      const [t0, m0] = KEYS[i - 1]
      return m0 + (m1 - m0) * ease((t - t0) / (t1 - t0))
    }
  }
  return KEYS.at(-1)[1]
}

const hhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`

function render(m, t) {
  chart.style.setProperty('--p', `${(((m - 60) / 480) * 100).toFixed(2)}%`)
  head.style.setProperty('--t', m.toFixed(2))
  clock.textContent = hhmm(m)
  let index = PHASES.findIndex(([until]) => m < until)
  if (m >= 535) {
    index = t > 12.4 ? 5 : 4
  }
  const [, phase, word, src, msgs] = PHASES[index]
  const from = index > 0 ? PHASES[index - 1][0] : 90
  const msg =
    msgs[
      Math.min(msgs.length - 1, Math.floor(((m - from) / (PHASES[index][0] - from)) * msgs.length))
    ]
  const left = phase === 'hold' ? ` · ${Math.ceil(197 - m)} min left` : ''
  if (body.dataset.phase !== phase) {
    body.dataset.phase = phase
  }
  statusWord.textContent = word
  logSrc.textContent = `[${src}]`
  logMsg.textContent = msg + left
}

const start = performance.now()
function frame(now) {
  const t = ((now - start) / 1000) % LOOP
  render(minutesAt(t), t)
  requestAnimationFrame(frame)
}

if (still) {
  render(535, 13)
} else {
  requestAnimationFrame(frame)
}

const field = document.getElementById('install')
const tabs = [...document.querySelectorAll('[role="tab"]')]
const pbar = document.querySelector('.pbar')
const copy = document.querySelector('.send')
const status = document.querySelector('.status')
const msg = document.querySelector('.pin .msg')
const current = () => tabs.find((tab) => tab.getAttribute('aria-selected') === 'true').dataset.text
let typing = 0
let timer = 0

function typeIn(text) {
  cancelAnimationFrame(typing)
  if (still) {
    field.value = text
    return
  }
  const start = performance.now()
  const step = (now) => {
    const n = Math.min(text.length, Math.round((now - start) / 11))
    field.value = text.slice(0, n)
    if (n < text.length) {
      typing = requestAnimationFrame(step)
    }
  }
  typing = requestAnimationFrame(step)
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    for (const other of tabs) {
      other.setAttribute('aria-selected', String(other === tab))
    }
    pbar.classList.remove('sent')
    typeIn(tab.dataset.text)
  })
}

field.addEventListener('focus', () => field.select())
setTimeout(() => typeIn(current()), 500)

copy.addEventListener('click', () => {
  const text = current()
  navigator.clipboard.writeText(text).then(
    () => {
      const where = tabs[0].getAttribute('aria-selected') === 'true' ? 'your agent' : 'a terminal'
      status.textContent = `Copied. Paste it into ${where}.`
      msg.textContent = status.textContent
      cancelAnimationFrame(typing)
      pbar.classList.remove('sent')
      void pbar.offsetWidth
      pbar.classList.add('sent')
      clearTimeout(timer)
      timer = setTimeout(() => {
        pbar.classList.remove('sent')
        typeIn(text)
      }, 1900)
    },
    () => {
      field.value = text
      field.focus()
      status.textContent = 'Text selected. Press Ctrl+C or Command+C to copy.'
    },
  )
})

const INSTALL = {
  agent: tabs[0].dataset.text,
  terminal: tabs[1].dataset.text,
}
async function registerTools() {
  if (!document.modelContext?.registerTool) {
    return
  }
  await document.modelContext.registerTool({
    name: 'get_wsb_install',
    description:
      'Get the instructions to install wsb, an OpenCode plugin that waits for a subscription usage limit to reset and retries the same turn.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['agent', 'terminal'],
          description: 'agent: a prompt to paste into a coding agent. terminal: the shell command.',
        },
      },
    },
    annotations: { readOnlyHint: true },
    execute: ({ method = 'terminal' }) =>
      `${INSTALL[method] ?? INSTALL.terminal}\nRequires OpenCode 2.3+. Works with Claude Max (opencode-with-claude), ChatGPT/Codex and OpenCode Go. Docs: https://wsb.tsu.ar/llms.txt`,
  })
}
try {
  await registerTools()
} catch {
  status.textContent = ''
}
