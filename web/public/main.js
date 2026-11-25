const root = document.documentElement
const hero = document.querySelector('.hero')
const find = (selector) => hero.querySelector(selector)
const pad = (value) => String(value).padStart(2, '0')
const clamp = (value) => Math.min(1, Math.max(0, value))
const smooth = (value) => value * value * (3 - 2 * value)

const WAIT = 1499
const RESET = 3 * 3600 + 17 * 60
const BEATS = [
  ['run', 3200],
  ['limit', 2600],
  ['read', 2800],
  ['hold', 5200],
  ['resume', 5600],
]
const TOTAL = BEATS.reduce((sum, [, ms]) => sum + ms, 0)
const KEY = { run: 0.8, limit: 0.6, read: 0.97, hold: 0.01, resume: 0.5 }

const countdown = (seconds) => `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
const compact = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`)
const clock = (seconds) => {
  const minutes = Math.floor(seconds / 60)
  return pad(Math.floor(minutes / 60) % 24) + pad(minutes % 60)
}

function view(beat, p) {
  if (beat === 'run') {
    return {
      beat,
      step: p < 0.14 ? 0 : p < 0.5 ? 1 : 2,
      time: RESET - WAIT - 1 - Math.round((1 - clamp(p / 0.9)) * 480),
      left: WAIT,
    }
  }
  if (beat === 'limit') {
    return { beat, step: 0, time: RESET - WAIT, left: WAIT }
  }
  if (beat === 'read') {
    return {
      beat,
      step: p < 0.2 ? 0 : p < 0.6 ? 1 : 2,
      time: RESET - WAIT,
      left: WAIT,
      fly: clamp((p - 0.2) / 0.4),
    }
  }
  if (beat === 'hold') {
    const left = Math.round(WAIT * (1 - smooth(smooth(p))))
    return { beat, step: 0, time: RESET - left, left }
  }
  const wake = smooth(clamp((p - 0.62) / 0.16))
  return {
    beat,
    step: p < 0.12 ? 0 : p < 0.62 ? 1 : 2,
    time: RESET + Math.round((wake * (7 * 3600 - RESET)) / 60) * 60,
    left: 0,
  }
}

function frame(at) {
  let start = 0
  for (const [beat, ms] of BEATS) {
    if (at < start + ms) {
      return view(beat, (at - start) / ms)
    }
    start += ms
  }
  return view('resume', 1)
}

function moment(beat) {
  let start = 0
  for (const [id, ms] of BEATS) {
    if (id === beat) {
      return start + KEY[id] * ms
    }
    start += ms
  }
  return 0
}

if (hero) {
  const tui = find('.tui')
  const digits = [...hero.querySelectorAll('.clock-t i')]
  const secs = find('.secs')
  const left = find('.left')
  const short = find('.short')
  const rise = find('.mark.rise')
  const source = find('.src')
  const target = find('.dst')
  const flyer = find('.flyer')
  const play = find('.play')
  const tiles = [...hero.querySelectorAll('.tiles button')]
  const stage = find('.stage')
  const still = matchMedia('(prefers-reduced-motion: reduce)')
  const shown = {}
  let path
  let wanted = false
  let touched = false
  let manual = false
  let inside = false
  let visible = false
  let running = false
  let origin = 0
  let at = moment('hold')
  let raf = 0

  const put = (key, value, write) => {
    if (shown[key] !== value) {
      shown[key] = value
      write(value)
    }
  }

  const measure = () => {
    const box = tui.getBoundingClientRect()
    const from = source.getBoundingClientRect()
    const to = target.getBoundingClientRect()
    path = {
      x0: from.left - box.left,
      y0: from.top - box.top,
      x1: to.right - box.left - from.width,
      y1: to.top - box.top,
      lift: from.height * 1.1,
    }
  }

  const fly = (progress) => {
    if (progress <= 0 || progress >= 1) {
      flyer.hidden = true
      path = undefined
      return
    }
    if (!path) {
      measure()
    }
    const eased = smooth(progress)
    const x = path.x0 + (path.x1 - path.x0) * eased
    const y = path.y0 + (path.y1 - path.y0) * eased - Math.sin(Math.PI * progress) * path.lift
    flyer.hidden = false
    flyer.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
    flyer.classList.toggle('landing', progress > 0.55)
  }

  const draw = (state) => {
    put('beat', state.beat, (beat) => {
      hero.dataset.beat = beat
      tui.setAttribute('aria-label', find(`.beats [data-beat="${beat}"]`).dataset.label)
      for (const tile of tiles) {
        if (tile.dataset.go === beat) {
          tile.setAttribute('aria-current', 'step')
        } else {
          tile.removeAttribute('aria-current')
        }
      }
    })
    put('step', state.step, (step) => {
      hero.dataset.step = step
    })
    put('time', clock(state.time), (text) => {
      digits.forEach((digit, index) => {
        digit.textContent = text[index]
      })
    })
    put('left', state.left, (seconds) => {
      secs.textContent = seconds
      left.textContent = countdown(seconds)
      short.textContent = compact(seconds)
      rise.style.setProperty('--rise', 1 + Math.floor((1 - seconds / WAIT) * 7))
    })
    put('fly', state.fly ?? 0, fly)
  }

  const label = () => {
    play.setAttribute('aria-label', wanted ? 'Pause the animation' : 'Play the animation')
    play.querySelector('use').setAttribute('href', wanted ? '#i-pause' : '#i-play')
    hero.classList.toggle('paused', !wanted)
  }

  const tick = (now) => {
    at = (now - origin) % TOTAL
    draw(frame(at))
    raf = requestAnimationFrame(tick)
  }

  const update = () => {
    const should = wanted && (visible || (manual && inside)) && !document.hidden
    if (should && !running) {
      running = true
      origin = performance.now() - at
      raf = requestAnimationFrame(tick)
    }
    if (!should && running) {
      running = false
      cancelAnimationFrame(raf)
    }
    label()
  }

  play.addEventListener('click', () => {
    touched = true
    wanted = !wanted
    manual = wanted
    update()
  })

  for (const tile of tiles) {
    tile.addEventListener('click', () => {
      touched = true
      wanted = false
      update()
      at = moment(tile.dataset.go)
      path = undefined
      draw(frame(at))
    })
  }

  new IntersectionObserver(
    ([entry]) => {
      const inView =
        entry.intersectionRatio >= 0.75 || entry.intersectionRect.height >= innerHeight * 0.6
      if (inView && !visible && wanted && !manual) {
        at = 0
      }
      inside = entry.isIntersecting
      visible = inView
      update()
    },
    { threshold: Array.from({ length: 21 }, (_, step) => step / 20) },
  ).observe(stage)
  document.addEventListener('visibilitychange', update)
  still.addEventListener('change', () => {
    if (still.matches) {
      wanted = false
      manual = false
      update()
    }
  })
  addEventListener('resize', () => {
    path = undefined
  })

  draw(frame(at))
  label()

  if (!still.matches) {
    const begin = () =>
      setTimeout(() => {
        if (touched) {
          return
        }
        at = 0
        wanted = true
        update()
      }, 900)
    if (document.readyState === 'complete') {
      begin()
    } else {
      addEventListener('load', begin, { once: true })
    }
  }
}

for (const get of document.querySelectorAll('.get')) {
  const tabs = [...get.querySelectorAll('[role="tab"]')]
  const copy = get.querySelector('.copy')
  const note = get.querySelector('[role="status"]')
  let timer = 0
  let serial = 0

  const idle = () => {
    serial += 1
    clearTimeout(timer)
    copy.textContent = copy.dataset.idle
    copy.classList.remove('done')
    note.textContent = ''
  }

  const choose = (tab) => {
    idle()
    for (const other of tabs) {
      const on = other === tab
      other.setAttribute('aria-selected', String(on))
      other.tabIndex = on ? 0 : -1
      document.getElementById(other.getAttribute('aria-controls')).hidden = !on
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => choose(tab))
    tab.addEventListener('keydown', (event) => {
      const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
      if (!move) {
        return
      }
      const next = tabs[(tabs.indexOf(tab) + move + tabs.length) % tabs.length]
      choose(next)
      next.focus()
      event.preventDefault()
    })
  }

  copy.addEventListener('click', () => {
    const tab = tabs.find((item) => item.getAttribute('aria-selected') === 'true')
    idle()
    const ticket = serial
    const done = () => {
      if (ticket !== serial) {
        return
      }
      copy.textContent = copy.dataset.done
      copy.classList.add('done')
      note.textContent = tab.dataset.note
      clearTimeout(timer)
      timer = setTimeout(idle, 2200)
    }
    const failed = () => {
      if (ticket !== serial) {
        return
      }
      getSelection().selectAllChildren(document.getElementById(tab.getAttribute('aria-controls')))
      note.textContent = 'Could not copy. The text is selected: copy it by hand.'
    }
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(tab.dataset.text))
      .then(done, failed)
  })
}

root.classList.add('ready')
