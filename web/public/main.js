const FRAGMENT = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform float uDay;
uniform float uScreen;
uniform vec2 uGlow;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + 7.1;
    a *= 0.5;
  }
  return v;
}

float band(float x, float lo, float hi, float s) {
  return smoothstep(lo - s, lo + s, x) * (1.0 - smoothstep(hi - s, hi + s, x));
}

void main() {
  vec2 p = gl_FragCoord.xy / uRes.y;
  float aspect = uRes.x / uRes.y;
  float shear = mix(0.62, 0.95, uDay);
  vec2 q = p - vec2(aspect * mix(0.16, 0.04, uDay) + uTime * 0.0015, 1.12);
  q.y = -q.y;
  q.x -= q.y * shear;
  q /= vec2(0.82, 1.18);

  float soft = 0.004 + 0.045 * clamp(q.y, 0.0, 1.6);
  float win = band(q.x, 0.0, 1.0, soft) * band(q.y, 0.0, 1.0, soft);
  float bars = 1.0 - band(q.x, 0.485, 0.515, soft);
  bars *= 1.0 - band(q.y, 0.37, 0.4, soft);
  bars *= 1.0 - band(q.y, 0.7, 0.72, soft) * 0.9;

  float sway = sin(uTime * 0.5) * 0.05 + sin(uTime * 1.7 + q.y * 4.0) * 0.012;
  float leaf = fbm(q * vec2(3.4, 2.6) + vec2(sway, sway * 0.4));
  float reach = smoothstep(0.15, 0.85, q.x * 0.9 - q.y * 0.6 + 0.35);
  float shade = smoothstep(0.5 - soft * 3.0, 0.56 + soft * 3.0, leaf) * reach;

  float light = win * bars * (1.0 - 0.88 * shade);

  vec3 wall = mix(vec3(0.036, 0.034, 0.033), vec3(0.79, 0.75, 0.68), uDay);
  vec3 tint = mix(vec3(0.15, 0.18, 0.26), vec3(0.2, 0.17, 0.11), uDay);
  vec3 col = wall + light * tint;

  vec2 g = (p - uGlow) * vec2(0.8, 1.1);
  col += vec3(0.11, 0.105, 0.095) * uScreen * (1.0 - uDay) * exp(-dot(g, g) * 5.0);
  col += (hash(floor(gl_FragCoord.xy)) - 0.5) * 0.018;
  gl_FragColor = vec4(col, 1.0);
}`

const body = document.body
const still = matchMedia('(prefers-reduced-motion: reduce)').matches
const screen = document.querySelector('.screen')
const typed = document.querySelector('.typed')
const you = document.querySelector('.you')
const clock = document.querySelector('.bar .now')
const hold = document.querySelector('.hold')
const left = document.querySelector('.hold .left')
const retryText = document.querySelector('.retry-text')
const footStatus = document.querySelector('.foot-line .st')
const PROMPT = 'refactor the search index and run the tests'
const LOOP = 21
const LIMIT = 3.15
const HOLD = 3.5
const RESET = 10.85
const DONE = 12.5
const WAIT = 2160

const canvas = document.querySelector('.room')
const gl = canvas.getContext('webgl', { antialias: false })
const info = gl?.getExtension('WEBGL_debug_renderer_info')
const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
const software = /swiftshader|llvmpipe|software/i.test(renderer)
let paint = () => {}

if (gl && !software) {
  body.classList.add('lit-room')
  const compile = (type, source) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    return shader
  }
  const program = gl.createProgram()
  gl.attachShader(
    program,
    compile(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'),
  )
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const u = Object.fromEntries(
    ['uRes', 'uTime', 'uDay', 'uScreen', 'uGlow'].map((name) => [
      name,
      gl.getUniformLocation(program, name),
    ]),
  )
  let glow = [0, 0]
  let last = [16, 1, 1]
  paint = (time, day, lit) => {
    last = [time, day, lit]
    gl.uniform2f(u.uRes, canvas.width, canvas.height)
    gl.uniform1f(u.uTime, time)
    gl.uniform1f(u.uDay, day)
    gl.uniform1f(u.uScreen, lit)
    gl.uniform2f(u.uGlow, glow[0], glow[1])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  const resize = () => {
    const scale = Math.min(devicePixelRatio || 1, 2) * 0.5
    const width = Math.round(innerWidth * scale)
    const height = Math.round(innerHeight * scale)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      gl.viewport(0, 0, width, height)
    }
    const box = screen.getBoundingClientRect()
    glow = [(box.x + box.width / 2) / innerHeight, 1 - (box.y + box.height / 2) / innerHeight]
    if (still) {
      paint(...last)
    }
  }
  resize()
  addEventListener('resize', resize)
  addEventListener('scroll', resize, { passive: true })
}

const clamp = (v) => Math.min(1, Math.max(0, v))
const pad = (n) => String(n).padStart(2, '0')
const clockAt = (minutes) =>
  `${pad(Math.floor(minutes / 60) % 24)}:${pad(Math.floor(minutes % 60))}`
const ms = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(1)} s`)

function countdown(seconds) {
  if (seconds >= 86_400) {
    return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`
  }
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
  }
  return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
}

function compact(seconds) {
  if (seconds >= 86_400) {
    return `${Math.floor(seconds / 86_400)}d`
  }
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m`
  }
  return `${seconds}s`
}

const items = [...document.querySelectorAll('.item[data-start]')].map((el) => ({
  el,
  start: Number(el.dataset.start),
  end: Number(el.dataset.end ?? Number.POSITIVE_INFINITY),
  persist: !el.classList.contains('retry'),
}))
const rows = [...document.querySelectorAll('.item.row')].map((el) => ({
  el,
  start: Number(el.dataset.start),
  end: Number(el.dataset.end),
  res: el.dataset.res || '',
  tm: el.querySelector('.tm'),
  out: el.querySelector('.res'),
}))

const setAttr = (el, name, on, value = '') => {
  if (on && el.getAttribute(name) !== value) {
    el.setAttribute(name, value)
  } else if (!on && el.hasAttribute(name)) {
    el.removeAttribute(name)
  }
}

function remainingAt(t) {
  if (t < HOLD) {
    return WAIT
  }
  if (t < RESET) {
    return Math.round(WAIT * (1 - clamp((t - HOLD) / (RESET - HOLD))))
  }
  return 0
}

function minutesAt(t) {
  if (t < RESET) {
    return 197 - remainingAt(t) / 60
  }
  if (t < DONE) {
    return 197 + 7 * clamp((t - RESET) / (DONE - RESET))
  }
  return 204
}

let day = 0
let lit = 1
let lastT = 0
let lastSeconds = 0
let lastClock = ''
let lastLeft = ''
let lastStatus = ''
function render(t, seconds) {
  if (t < lastT) {
    for (const item of items) {
      item.el.removeAttribute('data-on')
    }
    for (const row of rows) {
      row.el.removeAttribute('data-status')
    }
  }
  lastT = t
  const out = t >= LIMIT && t < RESET
  setAttr(body, 'data-word', true, out ? 'over' : 'back')
  setAttr(body, 'data-sweep', t >= RESET && t < RESET + 0.4)

  const chars = Math.round(clamp((t - 0.2) / 1.3) * PROMPT.length)
  if (typed.textContent.length !== chars) {
    typed.textContent = PROMPT.slice(0, chars)
  }
  you.classList.toggle('typed-out', t > 1.65)

  for (const item of items) {
    setAttr(item.el, 'data-on', t >= item.start && (item.persist || t < item.end))
  }

  for (const row of rows) {
    const state = t < row.start ? 'hidden' : t < row.end ? 'running' : 'done'
    if (row.el.dataset.status !== state) {
      row.el.dataset.status = state
    }
    const p = state === 'running' ? 0.9 * clamp((t - row.start) / (row.end - row.start)) : 1
    row.el.style.setProperty('--p', p.toFixed(3))
    const tm = state === 'done' ? ms((Math.min(t, row.end) - row.start) * 0.6) : ''
    if (row.tm.textContent !== tm) {
      row.tm.textContent = tm
    }
    const res = state === 'done' ? row.res : ''
    if (row.out.textContent !== res) {
      row.out.textContent = res
    }
  }

  const open = t >= HOLD && t < RESET
  setAttr(hold, 'data-open', open)
  hold.style.setProperty('--p', clamp((t - HOLD) / (RESET - HOLD)).toFixed(3))
  const remaining = remainingAt(t)
  if (open && lastLeft !== countdown(remaining)) {
    lastLeft = countdown(remaining)
    left.textContent = lastLeft
  }
  const status = open ? `wsb ${compact(remaining)}` : ''
  if (lastStatus !== status) {
    lastStatus = status
    footStatus.textContent = status
  }
  const retry = remaining > 0 ? `Retrying in ${remaining}s` : 'Retry due'
  if (retryText.textContent !== retry) {
    retryText.textContent = retry
  }
  const label = clockAt(minutesAt(t))
  if (lastClock !== label) {
    lastClock = label
    clock.textContent = label
  }

  const dayTarget = t >= 13.6 && t < 20.3 ? 1 : 0
  const litTarget = out ? 1.7 : 1
  const dt = Math.min(0.1, Math.max(0, seconds - lastSeconds))
  lastSeconds = seconds
  day += (dayTarget - day) * (1 - Math.exp(-dt * 2.6))
  lit += (litTarget - lit) * (1 - Math.exp(-dt * 4.8))
  setAttr(body, 'data-time', true, day > 0.5 ? 'day' : 'night')
  paint(seconds, day, lit)
}

const start = performance.now()
let visible = true
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting
}).observe(screen)
function frame(now) {
  if (visible) {
    render(((now - start) / 1000) % LOOP, now / 1000)
  }
  requestAnimationFrame(frame)
}

if (still) {
  day = 0
  render(6.5, 0)
} else {
  requestAnimationFrame(frame)
}

const reveals = document.querySelectorAll('.costs, .how')
const seen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in')
        seen.unobserve(entry.target)
      }
    }
  },
  { threshold: 0.2 },
)
for (const list of reveals) {
  list.classList.add('reveal')
  ;[...list.children].forEach((item, i) => item.style.setProperty('--i', String(i)))
  seen.observe(list)
}

const field = document.getElementById('install')
const tabs = [...document.querySelectorAll('[role="tab"]')]
const pbar = document.querySelector('.pbar')
const copy = document.querySelector('.send')
const status = document.querySelector('.status')
const msg = document.querySelector('.pin .msg span')
const thumb = document.querySelector('.thumb')
const OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'
const selected = () => tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
let timer = 0

function moveThumb() {
  const tab = selected()
  thumb.style.width = `${tab.offsetWidth}px`
  thumb.style.transform = `translateX(${tab.offsetLeft}px)`
}

function reset() {
  clearTimeout(timer)
  pbar.classList.remove('sent', 'failed')
}

let swap = 0

async function swapText(text) {
  const run = ++swap
  if (still) {
    field.value = text
    return
  }
  await field
    .animate(
      [{ transform: 'none' }, { transform: 'translateY(-70%)', filter: 'blur(3px)', opacity: 0 }],
      {
        duration: 160,
        easing: OUT,
      },
    )
    .finished.catch(() => undefined)
  if (run !== swap) {
    return
  }
  field.value = text
  field.animate(
    [{ transform: 'translateY(70%)', filter: 'blur(3px)', opacity: 0 }, { transform: 'none' }],
    {
      duration: 240,
      easing: OUT,
    },
  )
}

function select(tab) {
  if (tab === selected()) {
    return
  }
  for (const other of tabs) {
    other.setAttribute('aria-selected', String(other === tab))
    other.tabIndex = other === tab ? 0 : -1
  }
  reset()
  moveThumb()
  void swapText(tab.dataset.text)
}

for (const tab of tabs) {
  tab.tabIndex = tab === selected() ? 0 : -1
  tab.addEventListener('click', () => select(tab))
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }
    const next =
      tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    select(next)
    next.focus()
  })
}

moveThumb()
addEventListener('resize', moveThumb)
document.fonts.addEventListener('loadingdone', moveThumb)
field.addEventListener('focus', () => field.select())

function announce(text) {
  status.textContent = ''
  requestAnimationFrame(() => {
    status.textContent = text
  })
}

async function copyText() {
  const text = selected().dataset.text
  reset()
  void pbar.offsetWidth
  try {
    await navigator.clipboard.writeText(text)
    const where = selected() === tabs[0] ? 'your agent' : 'a terminal'
    msg.textContent = `Copied. Paste it into ${where}.`
    announce(msg.textContent)
    pbar.classList.add('sent')
    timer = setTimeout(reset, 1900)
  } catch {
    field.focus()
    field.select()
    pbar.classList.add('failed')
    announce('Text selected. Press Ctrl+C or Command+C to copy.')
  }
}
copy.addEventListener('click', () => {
  void copyText()
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
