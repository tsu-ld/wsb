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
const lines = [...document.querySelectorAll('.ln[data-at]')].map((el) => ({
  el,
  at: Number(el.dataset.at),
}))
const typed = document.querySelector('.typed')
const screen = document.querySelector('.screen')
const arc = document.querySelector('.ring .arc')
const PROMPT = 'refactor the search index and run the tests'
const LOOP = 20

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
  let scale = 1
  const resize = () => {
    scale = Math.min(devicePixelRatio || 1, 2) * 0.5
    canvas.width = Math.round(innerWidth * scale)
    canvas.height = Math.round(innerHeight * scale)
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
  resize()
  addEventListener('resize', resize)
  paint = (time, day, lit) => {
    const box = screen.getBoundingClientRect()
    gl.uniform2f(u.uRes, canvas.width, canvas.height)
    gl.uniform1f(u.uTime, time)
    gl.uniform1f(u.uDay, day)
    gl.uniform1f(u.uScreen, lit)
    gl.uniform2f(
      u.uGlow,
      (box.x + box.width / 2) / innerHeight,
      1 - (box.y + box.height / 2) / innerHeight,
    )
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}

const SEGS = {
  a: [5, 0, 30, 6],
  b: [34, 5, 6, 28],
  c: [34, 37, 6, 28],
  d: [5, 64, 30, 6],
  e: [0, 37, 6, 28],
  f: [0, 5, 6, 28],
  g: [5, 32, 30, 6],
}
const DIGITS = [
  'abcdef',
  'bc',
  'abged',
  'abgcd',
  'fgbc',
  'afgcd',
  'afgedc',
  'abc',
  'abcdefg',
  'abcdfg',
]
const NS = 'http://www.w3.org/2000/svg'
const seg7 = document.querySelector('.seg7')
const rect = (attrs) => {
  const el = document.createElementNS(NS, 'rect')
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value))
  }
  seg7.append(el)
  return el
}
const cells = [0, 44, 112, 156].map((x) =>
  Object.fromEntries(
    Object.entries(SEGS).map(([name, [sx, sy, w, h]]) => [
      name,
      rect({ x: x + sx, y: sy, width: w, height: h, rx: 2 }),
    ]),
  ),
)
rect({ x: 95, y: 20, width: 7, height: 7, rx: 2, class: 'lit' })
rect({ x: 95, y: 44, width: 7, height: 7, rx: 2, class: 'lit' })

const now = document.querySelector('.now')
const reels = []
for (let i = 0; i < 4; i++) {
  if (i === 2) {
    now.append(':')
  }
  const cell = document.createElement('span')
  const strip = document.createElement('span')
  cell.className = 'reel'
  strip.textContent = '0123456789'
  cell.append(strip)
  now.append(cell)
  reels.push(strip)
}

const clamp = (v) => Math.min(1, Math.max(0, v))
const ease = (t) => t * t * (3 - 2 * t)
const hhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}${String(Math.floor(m % 60)).padStart(2, '0')}`

function minutesAt(t) {
  if (t < 4.1) {
    return 132 + 29 * clamp(t / 4.1)
  }
  if (t < 10.6) {
    return 161 + 36 * ease(clamp((t - 5.4) / 4.8))
  }
  if (t < 13.6) {
    return 197 + 7 * clamp((t - 10.6) / 2.2)
  }
  return 535
}

const phaseAt = (t) =>
  t < 4.1
    ? 'work'
    : t < 5
      ? 'limit'
      : t < 10.6
        ? 'sleep'
        : t < 13.6
          ? 'back'
          : t < 19.2
            ? 'day'
            : 'dusk'

let shown = ''
let day = 0
let lit = 1
function render(t, seconds) {
  const phase = phaseAt(t)
  if (body.dataset.phase !== phase) {
    body.dataset.phase = phase
  }
  for (const line of lines) {
    const on = t >= line.at
    if (line.el.classList.contains('on') !== on) {
      line.el.classList.toggle('on', on)
    }
  }
  const chars = Math.round(clamp((t - 0.2) / 1.3) * PROMPT.length)
  if (typed.textContent.length !== chars) {
    typed.textContent = PROMPT.slice(0, chars)
  }
  arc.style.strokeDashoffset = (1 - clamp((t - 5.4) / 4.8)).toFixed(3)
  const label = hhmm(minutesAt(t))
  if (label !== shown) {
    shown = label
    reels.forEach((strip, i) => {
      strip.style.transform = `translateY(${-1.2 * Number(label[i])}em)`
    })
    cells.forEach((cell, i) => {
      const on = DIGITS[Number(label[i])]
      for (const [name, el] of Object.entries(cell)) {
        el.classList.toggle('lit', on.includes(name))
      }
    })
  }
  const dayTarget = phase === 'day' ? 1 : 0
  const litTarget = phase === 'sleep' ? 0 : 1
  day += (dayTarget - day) * 0.045
  lit += (litTarget - lit) * 0.08
  const time = day > 0.5 ? 'day' : 'night'
  if (body.dataset.time !== time) {
    body.dataset.time = time
  }
  paint(seconds, day, lit)
}

const start = performance.now()
function frame(ms) {
  render(((ms - start) / 1000) % LOOP, ms / 1000)
  requestAnimationFrame(frame)
}

if (still) {
  day = 1
  render(16, 0)
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
    moveThumb()
    pbar.classList.remove('sent')
    typeIn(tab.dataset.text)
  })
}

const thumb = document.querySelector('.thumb')
function moveThumb() {
  const tab = tabs.find((item) => item.getAttribute('aria-selected') === 'true')
  thumb.style.width = `${tab.offsetWidth}px`
  thumb.style.transform = `translateX(${tab.offsetLeft}px)`
}
moveThumb()
addEventListener('resize', moveThumb)
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
