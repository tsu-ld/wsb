const FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uDrain;
uniform vec3 uReset;
uniform vec3 uWave;
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

const LOOP = 12
const DRAIN = [1.4, 3.4]
const RESET = 7.4

let draw = () => {}
const wave = [0, 0, -1]
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
    ['uRes', 'uTime', 'uMouse', 'uDrain', 'uReset', 'uWave', 'uTile'].map((name) => [
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
const loopStart = performance.now() / 1000

function frame(now) {
  const time = now / 1000
  const t = (time - loopStart) % LOOP
  const drain = t < RESET ? ease(clamp((t - DRAIN[0]) / (DRAIN[1] - DRAIN[0]))) : 1
  const center = toCanvas(innerWidth / 2, innerHeight * 0.4)
  const reset = t >= RESET ? [center[0], center[1], time - (t - RESET)] : [0, 0, -1]
  draw(time, drain, reset)

  const step = t < DRAIN[0] ? 3 : t < DRAIN[1] + 0.2 ? 1 : t < RESET + 0.4 ? 2 : 3
  if (body.dataset.step !== String(step)) {
    body.dataset.step = String(step)
  }
  const state = t > DRAIN[0] + 1.2 && t < RESET + 0.4 ? 'over' : 'back'
  if (body.dataset.state !== state) {
    body.classList.add('moved')
    body.dataset.state = state
  }
  const minutes =
    step === 2 ? 168 + Math.round(clamp((t - DRAIN[1]) / (RESET - DRAIN[1])) * 29) : 197
  const label = `0${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
  if (clock.textContent !== label) {
    clock.textContent = label
  }
  requestAnimationFrame(frame)
}

draw(0, 0, [0, 0, -1])
if (!still) {
  requestAnimationFrame(frame)
}

const field = document.getElementById('install')
const tabs = [...document.querySelectorAll('[role="tab"]')]
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    for (const other of tabs) {
      other.setAttribute('aria-selected', String(other === tab))
    }
    field.value = tab.dataset.text
  })
}

const copy = document.querySelector('.copy')
const status = document.querySelector('.status')
let timer = 0
copy.addEventListener('click', () => {
  navigator.clipboard.writeText(field.value).then(
    () => {
      status.textContent = 'Copied.'
      copy.classList.add('copied')
      clearTimeout(timer)
      timer = setTimeout(() => copy.classList.remove('copied'), 1600)
      const box = copy.getBoundingClientRect()
      ;[wave[0], wave[1]] = toCanvas(box.x + box.width / 2, box.y + box.height / 2)
      wave[2] = performance.now() / 1000
    },
    () => {
      field.focus()
      field.select()
      status.textContent = 'Text selected. Press Ctrl+C or Command+C to copy.'
    },
  )
})
