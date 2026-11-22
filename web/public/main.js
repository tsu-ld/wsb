const FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uDrain;
uniform vec3 uReset;
uniform vec3 uWave;
uniform vec3 uIntro;
uniform float uTile;

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

vec3 spectrum(float x) {
  return 0.5 + 0.5 * cos(6.2832 * (x + vec3(0.0, 0.33, 0.67)));
}

float sweep(vec3 wave, vec2 cell, float speed, float width) {
  if (wave.z < 0.0) return 0.0;
  return clamp(((uTime - wave.z) * speed - distance(cell, wave.xy)) / width, 0.0, 1.0);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 id = floor(px / uTile);
  vec2 f = fract(px / uTile) - 0.5;
  vec2 cell = (id + 0.5) * uTile;
  float r = hash(id);

  float lit = step(uDrain, r * 0.98 + 0.01);
  float back = sweep(uReset, cell, uRes.y * 1.1, uTile * 5.0);
  lit = max(lit, step(0.5, back));
  float flip = back + sweep(uWave, cell, uRes.y * 1.4, uTile * 4.0);
  float intro = sweep(uIntro, cell, uRes.y * 0.9, uTile * 6.0);
  if (uIntro.z < 0.0) intro = 1.0;
  flip += (1.0 - intro) * 0.5;
  float a = flip * 3.14159;
  float squash = max(abs(cos(a)), 0.04);

  vec2 q = vec2(f.x / squash, f.y);
  vec2 d = abs(q) - 0.42 + 0.09;
  float box = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 0.09;
  float cover = 1.0 - smoothstep(-1.4 / uTile, 1.4 / uTile, box);
  float edge = smoothstep(-0.12, 0.0, box);

  vec2 uv = px / uRes.y;
  vec2 tilt = (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.7;
  float flow = noise(uv * 2.1 + vec2(uTime * 0.035, -uTime * 0.02) + r * 0.5);
  vec2 m = (px - uMouse) / uRes.y;
  float near = exp(-dot(m, m) * 10.0);
  float band = fract(flow * 2.2 + dot(uv + tilt * 0.35, vec2(0.7, -0.5)) * 1.2 + uTime * 0.025 + near * 0.5);
  float shine = pow(0.5 + 0.5 * sin(6.2832 * (flow * 1.6 + uv.x * 0.8 - uv.y * 0.55 + tilt.x * 0.6) + uTime * 0.45), 5.0);
  vec3 holo = mix(vec3(0.66, 0.68, 0.74), spectrum(band), 0.2 + 0.25 * near) * (0.08 + 1.3 * shine) + near * 0.28;
  float spark = step(0.9975, hash(floor(px) + floor(uTime * 2.5) * 0.37)) * (0.5 + 0.5 * sin(uTime * 8.0 + r * 40.0));

  vec3 off = vec3(0.035, 0.033, 0.045) + edge * vec3(0.04, 0.04, 0.05);
  vec3 col = mix(off, holo + spark * 1.2, lit);
  col += edge * 0.14 * lit;
  col *= 0.72 + 0.28 * abs(cos(a));
  col += pow(sin(a), 2.0) * 0.3;
  cover *= step(0.02, intro);
  col = col * cover + vec3(0.03, 0.028, 0.04) * (1.0 - cover);
  gl_FragColor = vec4(col, 1.0);
}`

const canvas = document.querySelector('.mosaic')
const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false })
const body = document.body
const clock = document.querySelector('.clock')
const info = gl?.getExtension('WEBGL_debug_renderer_info')
const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
const still = matchMedia('(prefers-reduced-motion: reduce)').matches
const software = /swiftshader|llvmpipe|software/i.test(renderer)
if (!gl || software) {
  body.classList.add('flat')
}

const LOOP = 19
const DRAIN = [4.1, 5.3]
const RESET = 12.8

let draw = () => {}
const wave = [0, 0, -1]
const intro = [0, 0, -1]
const mouse = [-9999, -9999]
let scale = 1

if (gl && !software) {
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
    ['uRes', 'uTime', 'uMouse', 'uDrain', 'uReset', 'uWave', 'uIntro', 'uTile'].map((name) => [
      name,
      gl.getUniformLocation(program, name),
    ]),
  )
  const resize = () => {
    scale = Math.min(devicePixelRatio || 1, 2) * 0.5
    canvas.width = Math.round(innerWidth * scale)
    canvas.height = Math.round(innerHeight * scale)
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
  resize()
  addEventListener('resize', resize)
  draw = (time, drain, reset) => {
    gl.uniform2f(u.uRes, canvas.width, canvas.height)
    gl.uniform1f(u.uTime, time)
    gl.uniform2f(u.uMouse, mouse[0], mouse[1])
    gl.uniform1f(u.uDrain, drain)
    gl.uniform3f(u.uReset, reset[0], reset[1], reset[2])
    gl.uniform3f(u.uWave, wave[0], wave[1], wave[2])
    gl.uniform3f(u.uIntro, intro[0], intro[1], intro[2])
    gl.uniform1f(u.uTile, 56 * scale)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}

const toCanvas = (x, y) => [x * scale, (innerHeight - y) * scale]
addEventListener('pointermove', (e) => {
  ;[mouse[0], mouse[1]] = toCanvas(e.clientX, e.clientY)
})

const clamp = (v) => Math.min(1, Math.max(0, v))
const ease = (t) => t * t * (3 - 2 * t)
const loopStart = performance.now() / 1000 + 0.6
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#%&*/<>'
const words = { over: document.querySelector('.w-over'), back: document.querySelector('.w-back') }
const finals = { over: words.over.textContent, back: words.back.textContent }
const lines = [...document.querySelectorAll('.ln[data-at]')].map((el) => ({
  el,
  at: Number(el.dataset.at),
  until: Number(el.dataset.until || Infinity),
}))
const typed = document.querySelector('.typed')
const PROMPT = 'refactor the search index and run the tests'
const meter = document.querySelector('.meter span')
const sky = document.querySelector('.sky')
const digits = [...clock.querySelectorAll('i:not(.colon)')]

function scramble(state) {
  const el = words[state]
  const text = finals[state]
  const start = performance.now()
  const tick = (now) => {
    const p = clamp((now - start) / 650)
    el.textContent = [...text]
      .map((ch, i) =>
        ch === ' ' || p * text.length >= i + 1
          ? ch
          : GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
      )
      .join('')
    if (p < 1) {
      requestAnimationFrame(tick)
    }
  }
  requestAnimationFrame(tick)
}

function flap(label) {
  clock.setAttribute('aria-label', label)
  const next = label.replace(':', '')
  digits.forEach((cell, i) => {
    if (cell.textContent === next[i]) {
      return
    }
    cell.textContent = next[i]
    const now = performance.now()
    if (now - (Number(cell.dataset.at) || 0) < 320) {
      return
    }
    cell.dataset.at = String(now)
    cell.classList.remove('flip')
    void cell.offsetWidth
    cell.classList.add('flip')
  })
}

function minutesAt(t) {
  if (t < 4.1) {
    return 161 + 7 * clamp(t / 4.1)
  }
  if (t < 4.8) {
    return 168
  }
  if (t < 7.4) {
    return 168 + 367 * clamp((t - 4.8) / 2.6) ** 2
  }
  if (t < 8.2) {
    return 535 - 367 * ease(clamp((t - 7.4) / 0.8))
  }
  if (t < 8.4) {
    return 168
  }
  if (t < RESET) {
    return 168 + 29 * clamp((t - 8.4) / (RESET - 8.4))
  }
  return 197 + 7 * clamp((t - RESET) / 1.9)
}

const set = (key, value) => {
  if (body.dataset[key] !== value) {
    body.dataset[key] = value
    return true
  }
  return false
}

function frame(now) {
  const time = now / 1000
  const t = Math.max(0, time - loopStart) % LOOP
  const drain = t < RESET ? ease(clamp((t - DRAIN[0]) / (DRAIN[1] - DRAIN[0]))) : 1
  const center = toCanvas(innerWidth * 0.7, innerHeight * 0.5)
  const reset = t >= RESET ? [center[0], center[1], time - (t - RESET)] : [0, 0, -1]
  draw(time, drain, reset)

  if (set('state', t > 4.3 && t < RESET + 0.1 ? 'over' : 'back')) {
    body.classList.add('moved')
    scramble(body.dataset.state)
  }
  set('tag', t >= 4.4 && t < 7.6 ? 'without' : t >= 7.9 ? 'with' : 'none')
  body.classList.toggle('rewind', t >= 7.4 && t < 8.2)

  const chars = Math.round(clamp((t - 0.2) / 1.4) * PROMPT.length)
  if (typed.textContent.length !== chars) {
    typed.textContent = PROMPT.slice(0, chars)
  }
  for (const line of lines) {
    const on = t >= line.at && t < line.until
    if (line.el.classList.contains('on') !== on) {
      line.el.classList.toggle('on', on)
    }
  }
  meter.style.transform = `scaleX(${clamp((t - 8.4) / (RESET - 8.4)).toFixed(3)})`

  const minutes = Math.round(minutesAt(t))
  const label = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  if (clock.getAttribute('aria-label') !== label) {
    flap(label)
    sky.querySelector('use').setAttribute('href', minutes >= 420 ? '#i-sun' : '#i-moon')
  }
  requestAnimationFrame(frame)
}

draw(0, 0, [0, 0, -1])
if (still) {
  typed.textContent = PROMPT
  for (const line of lines) {
    line.el.classList.toggle('on', !line.el.classList.contains('bad'))
  }
  meter.style.transform = 'scaleX(1)'
  body.dataset.tag = 'with'
  flap('03:24')
} else {
  ;[intro[0], intro[1]] = toCanvas(innerWidth / 2, innerHeight * 0.4)
  intro[2] = performance.now() / 1000
  requestAnimationFrame(frame)
}

const field = document.getElementById('install')
const tabs = [...document.querySelectorAll('[role="tab"]')]
const pbar = document.querySelector('.pbar')
const copy = document.querySelector('.send')
const status = document.querySelector('.status')
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
      status.textContent = 'Copied. Paste it into your agent.'
      cancelAnimationFrame(typing)
      pbar.classList.remove('sent')
      void pbar.offsetWidth
      pbar.classList.add('sent')
      clearTimeout(timer)
      timer = setTimeout(() => {
        pbar.classList.remove('sent')
        typeIn(text)
      }, 1900)
      const box = copy.getBoundingClientRect()
      if (!still) {
        sparks(box.x + box.width / 2, box.y + box.height / 2)
      }
      ;[wave[0], wave[1]] = toCanvas(box.x + box.width / 2, box.y + box.height / 2)
      wave[2] = performance.now() / 1000
    },
    () => {
      field.value = text
      field.focus()
      status.textContent = 'Text selected. Press Ctrl+C or Command+C to copy.'
    },
  )
})

function sparks(x, y) {
  for (let i = 0; i < 12; i++) {
    const spark = document.createElement('span')
    spark.className = 'spark'
    spark.style.left = `${x}px`
    spark.style.top = `${y}px`
    spark.style.setProperty('--a', `${i * 30 + Math.random() * 12}deg`)
    spark.style.setProperty('--d', `${46 + Math.random() * 34}px`)
    document.body.append(spark)
    spark.addEventListener('animationend', () => spark.remove())
  }
}

if (!still && matchMedia('(pointer: fine)').matches) {
  addEventListener('pointermove', (e) => {
    const box = copy.getBoundingClientRect()
    const dx = e.clientX - (box.x + box.width / 2)
    const dy = e.clientY - (box.y + box.height / 2)
    const near = Math.hypot(dx, dy) < 110
    copy.style.translate = near ? `${dx * 0.12}px ${dy * 0.18}px` : '0 0'
  })
}
