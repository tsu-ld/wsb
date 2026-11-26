const root = document.documentElement
const hero = document.querySelector('.hero')
const still = matchMedia('(prefers-reduced-motion: reduce)')
const pad = (value) => String(value).padStart(2, '0')
const clamp = (value) => Math.min(1, Math.max(0, value))
const smooth = (value) => value * value * (3 - 2 * value)
const out = (value) => 1 - (1 - clamp(value)) ** 3
const EASE = 'cubic-bezier(0.2, 0, 0, 1)'

function spring(duration, bounce) {
  const omega = (2 * Math.PI) / duration
  if (bounce <= 0) {
    return (time) => 1 - Math.exp(-omega * time) * (1 + omega * time)
  }
  const damping = 1 - bounce
  const decay = damping * omega
  const ring = omega * Math.sqrt(1 - damping * damping)
  return (time) =>
    1 - Math.exp(-decay * time) * (Math.cos(ring * time) + (decay / ring) * Math.sin(ring * time))
}

const glideX = spring(0.5, 0)
const glideY = spring(0.62, 0.2)
const READ = { appear: 480, takeoff: 520, fade: 300, land: 1080, wipe: 180, tail: 200, hide: 1440 }

const WAIT = 1499
const BEATS = [
  ['run', 3400],
  ['limit', 2400],
  ['read', 2600],
  ['hold', 5400],
  ['resume', 4200],
]
const TOTAL = BEATS.reduce((sum, [, ms]) => sum + ms, 0)
const LABEL = {
  run: 'An OpenCode session at night. One prompt: refactor the search index and run the tests. The agent is working.',
  limit:
    "The same OpenCode session. The provider's refusal appears: Retrying in 1499s, attempt 2, You've hit your 5-hour limit, resets 3:17am, Resets at 2026-11-25T03:17:00.000Z.",
  read: "The same OpenCode session. Under the refusal the wsb panel appears: waiting for the reset, resumes 03:17. That time comes from the provider's refusal.",
  hold: "The same OpenCode session during the wait. The composer is empty, OpenCode's retry line counts down and the wsb panel reads: waiting for the reset, resumes 03:17.",
  resume:
    'The same OpenCode session at 03:17. The refusal and the wsb panel are gone and the agent answers: Done. The index ranks by the new score and 128 tests pass. There is still one prompt.',
}

const CELLS = 8
const HOLD_END = 9
const HOLD_START = 30
const TRAIL = [1, 0.9, 0.65, 0.65 ** 2, 0.65 ** 3, 0.65 ** 4]
const SCAN_FRAMES = CELLS + HOLD_END + CELLS - 1 + HOLD_START
const SCAN_MS = 40
const DOTS = [
  '111000',
  '110100',
  '110101',
  '010101',
  '010111',
  '000111',
  '001011',
  '101011',
  '101010',
  '111010',
]
const DOTS_MS = 80
const REST = 4

const countdown = (seconds) => `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
const compact = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`)

function scanner(frame) {
  let active = 0
  let hold = -1
  let total = 0
  let moved = 0
  let span = 0
  let forward = true
  if (frame < CELLS) {
    active = frame
    moved = frame
    span = CELLS
  } else if (frame < CELLS + HOLD_END) {
    active = CELLS - 1
    hold = frame - CELLS
    total = HOLD_END
  } else if (frame < CELLS + HOLD_END + CELLS - 1) {
    moved = frame - CELLS - HOLD_END
    active = CELLS - 2 - moved
    span = CELLS - 1
    forward = false
  } else {
    hold = frame - CELLS - HOLD_END - CELLS + 1
    total = HOLD_START
    forward = false
  }
  const holding = hold >= 0
  const fade = holding
    ? Math.max(0.3, 1 - Math.min(hold / total, 1) * 0.7)
    : 0.3 + Math.min(moved / Math.max(1, span - 1), 1) * 0.7
  return Array.from({ length: CELLS }, (_, cell) => {
    const distance = forward ? active - cell : cell - active
    let index = -1
    if (holding) {
      index = distance + hold
    } else if (distance >= 0 && distance < TRAIL.length) {
      index = distance
    }
    return index >= 0 && index < TRAIL.length
      ? { on: true, alpha: TRAIL[index], glow: index === 1 ? 1.15 : 1 }
      : { on: false, alpha: 0.6 * fade, glow: 1 }
  })
}

function view(beat, p) {
  if (beat === 'run') {
    return { beat, step: p < 0.14 ? 0 : p < 0.5 ? 1 : 2, left: WAIT }
  }
  if (beat === 'limit') {
    return { beat, step: 0, left: WAIT }
  }
  if (beat === 'read') {
    const ms = p * BEATS[2][1]
    return { beat, step: ms < READ.takeoff ? 0 : ms < READ.land ? 1 : 2, left: WAIT, ms }
  }
  if (beat === 'hold') {
    return { beat, step: 0, left: Math.round(WAIT * (1 - smooth(smooth(p)))) }
  }
  return { beat, step: p < 0.16 ? 0 : 1, left: 0 }
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

function moment(beat, part) {
  let start = 0
  for (const [id, ms] of BEATS) {
    if (id === beat) {
      return start + part * ms
    }
    start += ms
  }
  return 0
}

if (hero) {
  const find = (selector) => hero.querySelector(selector)
  const tui = find('.tui')
  const secs = find('.secs')
  const left = find('.left')
  const short = find('.short')
  const rise = find('.mark.rise')
  const source = find('.src')
  const target = find('.dst')
  const flyer = find('.flyer')
  const panel = find('.t-panel')
  const later = find('.later')
  const play = find('.play')
  const stage = find('.stage')
  const cells = [...hero.querySelectorAll('.scan i')]
  const dots = [...hero.querySelectorAll('.spin b')]
  const shown = {}
  let path
  let wanted = false
  let touched = false
  let manual = false
  let inside = false
  let visible = false
  let running = false
  let origin = 0
  let at = moment('hold', 0.01)
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
    const x = box.left + tui.clientLeft
    const y = box.top + tui.clientTop
    path = { x0: from.left - x, y0: from.top - y, x1: to.left - x, y1: to.top - y }
  }

  const fly = (ms) => {
    const reading = ms >= 0
    if (still.matches) {
      source.style.setProperty('--hl', reading && ms < READ.appear ? '1' : '0')
      panel.style.opacity = ''
      later.style.opacity = reading && ms < READ.land ? '0' : ''
      target.style.opacity = reading && ms < READ.land ? '0' : ''
      flyer.hidden = true
      path = undefined
      return
    }
    source.style.setProperty('--hl', reading && ms < READ.appear ? out(ms / 140).toFixed(3) : '0')
    panel.style.opacity =
      reading && ms < READ.land ? out((ms - READ.takeoff) / READ.fade).toFixed(3) : ''
    later.style.opacity =
      reading && ms < READ.hide ? out((ms - READ.land) / READ.tail).toFixed(3) : ''
    target.style.opacity = reading && ms < READ.hide ? '0' : ''
    if (!reading || ms < READ.appear || ms >= READ.hide) {
      flyer.hidden = true
      path = undefined
      return
    }
    if (!path) {
      measure()
    }
    const time = Math.max(0, ms - READ.takeoff) / 1000
    const along = glideX(time)
    const x = path.x0 + (path.x1 - path.x0) * along
    const y = path.y0 + (path.y1 - path.y0) * glideY(Math.max(0, time - 0.07))
    const size = 1 + 0.1 * Math.sin(Math.PI * Math.min(1, time / 0.5))
    flyer.hidden = false
    flyer.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${size.toFixed(4)})`
    flyer.style.setProperty('--mix', along.toFixed(3))
    flyer.style.setProperty('--off', out((ms - READ.land) / READ.wipe).toFixed(3))
  }

  const busy = (clock) => {
    put('scan', Math.floor(clock / SCAN_MS) % SCAN_FRAMES, (index) => {
      scanner(index).forEach((cell, at) => {
        cells[at].classList.toggle('on', cell.on)
        cells[at].style.setProperty('--a', cell.alpha.toFixed(3))
        cells[at].style.setProperty('--b', cell.glow)
      })
    })
    put('dots', Math.floor(clock / DOTS_MS) % DOTS.length, (index) => {
      dots.forEach((dot, at) => dot.style.setProperty('--o', DOTS[index][at]))
    })
  }

  const draw = (state) => {
    put('beat', state.beat, (beat) => {
      hero.dataset.beat = beat
      tui.setAttribute('aria-label', LABEL[beat])
    })
    put('step', state.step, (step) => {
      hero.dataset.step = step
    })
    put('left', state.left, (seconds) => {
      secs.textContent = seconds
      left.textContent = countdown(seconds)
      short.textContent = compact(seconds)
      rise.style.setProperty('--rise', 1 + Math.floor((1 - seconds / WAIT) * 7))
    })
    put('fly', state.ms ?? -1, fly)
  }

  const label = () => {
    play.setAttribute('aria-label', wanted ? 'Pause the animation' : 'Play the animation')
    play.dataset.tip = wanted ? 'Pause' : 'Play'
    hero.classList.toggle('paused', !wanted)
  }

  const tick = (now) => {
    const clock = Math.max(0, now - origin)
    at = clock % TOTAL
    draw(frame(at))
    busy(clock)
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
  busy(REST * SCAN_MS)
  label()

  if (!still.matches) {
    const begin = () =>
      setTimeout(() => {
        if (touched || still.matches) {
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

const wants = new WeakMap()
const moves = new Set()

function move(node, frames, options) {
  const motion = node.animate(frames, options)
  const drop = () => moves.delete(motion)
  moves.add(motion)
  motion.finished.then(drop, drop)
  return motion
}

function swap(node, text) {
  if (wants.get(node) === text) {
    return
  }
  wants.set(node, text)
  for (const motion of node.getAnimations()) {
    motion.cancel()
  }
  if (node.textContent === text) {
    return
  }
  const shift = still.matches ? 0 : 4
  const leave = move(
    node,
    [
      { opacity: 1, translate: '0 0' },
      { opacity: 0, translate: `0 ${-shift}px` },
    ],
    { duration: 100, easing: 'ease-out', fill: 'forwards' },
  )
  leave.onfinish = () => {
    node.textContent = text
    leave.cancel()
    move(
      node,
      [
        { opacity: 0, translate: `0 ${still.matches ? 0 : shift}px` },
        { opacity: 1, translate: '0 0' },
      ],
      { duration: 150, easing: 'ease-out' },
    )
  }
}

const boxes = [...document.querySelectorAll('.get')].map((get) => ({
  get,
  tabs: [...get.querySelectorAll('[role="tab"]')],
  modes: get.querySelector('.modes'),
  copy: get.querySelector('.copy'),
  hint: get.querySelector('.hint span'),
  note: get.querySelector('[role="status"]'),
  timer: 0,
  serial: 0,
}))
const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'))
const chosen = (box) => box.tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')

const idle = (box) => {
  box.serial += 1
  clearTimeout(box.timer)
  box.get.classList.remove('done')
  box.copy.setAttribute('aria-label', 'Copy')
  box.copy.dataset.tip = 'Copy'
  box.note.textContent = ''
  swap(box.hint, chosen(box).dataset.hint)
}

const choose = (index) => {
  for (const box of boxes) {
    box.tabs.forEach((tab, at) => {
      const on = at === index
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      panelOf(tab).hidden = !on
    })
    box.modes.style.setProperty('--i', index)
    idle(box)
  }
}

for (const box of boxes) {
  box.tabs.forEach((tab, at) => {
    tab.addEventListener('click', () => choose(at))
    tab.addEventListener('keydown', (event) => {
      const last = box.tabs.length - 1
      const next = {
        ArrowRight: at === last ? 0 : at + 1,
        ArrowLeft: at === 0 ? last : at - 1,
        Home: 0,
        End: last,
      }[event.key]
      if (next === undefined) {
        return
      }
      choose(next)
      box.tabs[next].focus()
      event.preventDefault()
    })
  })

  box.copy.addEventListener('click', (event) => {
    const tab = chosen(box)
    const panel = panelOf(tab)
    idle(box)
    const ticket = box.serial
    const rect = box.copy.getBoundingClientRect()
    const byPointer = event.detail > 0
    box.copy.style.setProperty(
      '--x',
      `${byPointer ? ((event.clientX - rect.left) / rect.width) * 100 : 50}%`,
    )
    box.copy.style.setProperty(
      '--y',
      `${byPointer ? ((event.clientY - rect.top) / rect.height) * 100 : 50}%`,
    )
    const done = () => {
      if (ticket !== box.serial) {
        return
      }
      box.get.classList.add('done')
      box.copy.setAttribute('aria-label', 'Copied')
      box.copy.dataset.tip = 'Copied'
      box.note.textContent = tab.dataset.note
      swap(box.hint, 'Copied')
      if (!still.matches) {
        move(
          panel,
          [
            { scale: '0 1', transformOrigin: '0 50%', easing: 'ease-out' },
            { scale: '1 1', transformOrigin: '0 50%', offset: 0.45 },
            { scale: '1 1', transformOrigin: '100% 50%', offset: 0.55, easing: 'ease-out' },
            { scale: '0 1', transformOrigin: '100% 50%' },
          ],
          { duration: 560, pseudoElement: '::after' },
        )
      }
      navigator.vibrate?.(8)
      box.timer = setTimeout(() => idle(box), 2400)
    }
    const failed = () => {
      if (ticket !== box.serial) {
        return
      }
      getSelection().selectAllChildren(panel)
      box.note.textContent = 'Could not copy. The text is selected: copy it by hand.'
      swap(box.hint, 'Copy it by hand')
      box.timer = setTimeout(() => idle(box), 4000)
    }
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(tab.dataset.text))
      .then(done, failed)
  })
}

const folds = new WeakMap()
const fades = new WeakMap()

function fold(item, open) {
  const summary = item.querySelector('summary')
  const answer = item.querySelector('.a')
  const shut = !item.open || item.classList.contains('closing')
  if (open !== shut) {
    return
  }
  const from = item.getBoundingClientRect().height
  folds.get(item)?.cancel()
  clearTimeout(fades.get(item))
  if (still.matches) {
    item.classList.toggle('closing', !open)
    if (open) {
      item.open = true
      return
    }
    fades.set(
      item,
      setTimeout(() => {
        item.open = false
        item.classList.remove('closing')
      }, 150),
    )
    return
  }
  item.classList.toggle('closing', !open)
  if (open) {
    item.open = true
  }
  const edge = item.offsetHeight - item.clientHeight
  const to = summary.offsetHeight + edge + (open ? answer.offsetHeight : 0)
  item.style.overflow = 'clip'
  const motion = move(
    item,
    { height: [`${from}px`, `${to}px`] },
    { duration: open ? 350 : 200, easing: open ? EASE : 'ease-out' },
  )
  folds.set(item, motion)
  motion.onfinish = () => {
    if (!open) {
      item.open = false
      item.classList.remove('closing')
    }
    item.style.overflow = ''
    folds.delete(item)
  }
}

still.addEventListener('change', () => {
  if (!still.matches) {
    return
  }
  for (const motion of moves) {
    motion.finish()
  }
})

for (const item of document.querySelectorAll('.qa details')) {
  item.querySelector('summary').addEventListener('click', (event) => {
    event.preventDefault()
    fold(item, !item.open || item.classList.contains('closing'))
  })
}

for (const link of document.querySelectorAll('a[data-p]')) {
  link.addEventListener('click', (event) => {
    const item = document.querySelector(link.hash)
    const part = item?.querySelector(`.a [data-p="${link.dataset.p}"]`)
    if (!item || !part) {
      return
    }
    event.preventDefault()
    fold(item, true)
    history.replaceState(null, '', link.hash)
    item.scrollIntoView({ behavior: still.matches ? 'auto' : 'smooth', block: 'center' })
    item.querySelector('summary').focus({ preventScroll: true })
    for (const other of item.querySelectorAll('.lit')) {
      other.classList.remove('lit')
    }
    setTimeout(() => part.classList.add('lit'), 500)
    setTimeout(() => part.classList.remove('lit'), 2600)
  })
}

let warm = 0
document.addEventListener('pointerover', (event) => {
  if (event.target.closest?.('[data-tip]')) {
    clearTimeout(warm)
    warm = setTimeout(() => root.classList.add('warm'), 600)
  }
})
document.addEventListener('pointerout', (event) => {
  if (event.target.closest?.('[data-tip]')) {
    clearTimeout(warm)
    warm = setTimeout(() => root.classList.remove('warm'), 380)
  }
})

const title = document.title
let back = 0
document.addEventListener('visibilitychange', () => {
  clearTimeout(back)
  if (document.hidden) {
    document.title = 'it’s so over · wsb'
    return
  }
  document.title = 'we’re so back · wsb'
  back = setTimeout(() => {
    document.title = title
  }, 2600)
})

root.classList.add('ready')
