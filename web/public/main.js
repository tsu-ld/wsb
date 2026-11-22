const tube = document.getElementById('tube')
const liquid = document.querySelector('.liquid')
const clock = document.querySelector('.clock')
const total = tube.getTotalLength()

const along = (x) => {
  let lo = 0
  let hi = total
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (tube.getPointAtLength(mid).x < x) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return lo / total
}
const PIT_START = along(640)
const PIT_END = along(960)

const LOOP = 10_000
const FALL = 1600
const RESET = 6600
const CLIMB = 1500
const COUNT = 22

const balls = Array.from({ length: COUNT }, (_, i) => {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  liquid.append(circle)
  const spread = ((i * 7919) % COUNT) / COUNT
  return {
    circle,
    lag: i * 55,
    r: 20 + ((i * 5) % 10),
    rest: PIT_START + (PIT_END - PIT_START) * (0.04 + spread * 0.92),
    phase: i * 1.3,
  }
})

const clamp = (v) => Math.min(1, Math.max(0, v))
const easeIn = (t) => t * t
const easeOut = (t) => 1 - (1 - t) ** 3
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const lerp = (a, b, t) => a + (b - a) * t

function place(ball, t, now) {
  const local = t - ball.lag
  if (local < 0) {
    return null
  }
  if (local < FALL) {
    return { s: lerp(0, PIT_START, easeIn(local / FALL)), r: ball.r * 0.9 }
  }
  const wobble = 0.006 * Math.sin(now / 900 + ball.phase)
  if (t < RESET) {
    const settle = easeOut(clamp((local - FALL) / 2200))
    return {
      s: lerp(PIT_START, ball.rest, settle) + wobble * settle,
      r: lerp(ball.r * 0.9, ball.r * 0.75, settle),
    }
  }
  const go = clamp((t - RESET - (COUNT - 1 - ball.lag / 55) * 35) / CLIMB)
  if (go >= 1) {
    return null
  }
  return { s: lerp(ball.rest + wobble, 1.02, easeInOut(go)), r: ball.r * 0.95 }
}

function frame(now) {
  const t = now % LOOP
  for (const ball of balls) {
    const at = place(ball, t, now)
    if (!at || at.s >= 1) {
      ball.circle.setAttribute('r', '0')
      continue
    }
    const p = tube.getPointAtLength(at.s * total)
    ball.circle.setAttribute('cx', p.x.toFixed(1))
    ball.circle.setAttribute('cy', p.y.toFixed(1))
    ball.circle.setAttribute('r', at.r.toFixed(1))
  }
  const over = t > FALL * 0.7 && t < RESET + CLIMB * 0.6
  document.body.dataset.state = over ? 'over' : 'back'
  if (over && t < RESET) {
    const minutes = 168 + Math.round(clamp((t - FALL) / (RESET - FALL)) * 29)
    clock.textContent = `holding the turn · 0${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} → 03:17`
  } else {
    clock.textContent = over ? 'reset · retrying the same turn' : 'same turn · same model · 03:17'
  }
  requestAnimationFrame(frame)
}

if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  requestAnimationFrame(frame)
}

const status = document.querySelector('.status')
for (const button of document.querySelectorAll('[data-copy]')) {
  const field = document.getElementById(button.dataset.copy)
  button.hidden = false
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(field.value).then(
      () => {
        status.textContent = 'Copied.'
      },
      () => {
        field.focus()
        field.select()
        status.textContent = 'Text selected. Press Ctrl+C or Command+C to copy.'
      },
    )
  })
}
