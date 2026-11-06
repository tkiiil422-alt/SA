/**
 * Keep transient view state across the 3-second repaint.
 *
 * Views rebuild their DOM with innerHTML, which throws away three things the
 * person can see: expanded <details>, scroll offsets, and focus/caret. The
 * shell wraps every refresh with snapshot() -> refresh() -> restore(), so a
 * view does not have to remember anything itself.
 *
 * Contract:
 *   <details data-keep="page.section">          stable key per collapsible
 *   <input data-focus-key="page.field">         (or a stable id) to restore focus
 *   <div data-keep-scroll>                      (optional) key for inner scrollers
 *
 * Open state lives in a desired map for the life of one mounted view: a manual
 * toggle is authoritative, and a MutationObserver re-applies it after any
 * repaint, including a second paint that finishes after refresh() returned.
 * Scrolls are timestamped and compared with the current position, so a person
 * who scrolls while a refresh is in flight is not snapped back.
 */

const desiredOpen = new Map()
const liveScroll = new Map()
let lastWindowScroll = { y: 0, at: 0 }
let suppressScrollUntil = 0
let watchedRoot = null
let observer = null

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Tell watch() to ignore the scroll events caused by a shell-level scrollTo. */
export function holdScroll(ms = 150) {
  suppressScrollUntil = now() + ms
}

function detailsIn(root) {
  return [...root.querySelectorAll('details[data-keep]')]
}

function detailsKeyOf(details, all) {
  const base = details.dataset.keep
  if (!base) return ''
  const same = all.filter((item) => item.dataset.keep === base)
  if (same.length < 2) return base
  return `${base}#${same.indexOf(details) + 1}`
}

function scrollKeyOf(element, root) {
  if (element.dataset.keepScroll) return element.dataset.keepScroll
  if (element.id) return `#${element.id}`
  const tag = element.tagName.toLowerCase()
  // SVG elements expose className as an SVGAnimatedString, not a string: read the attribute instead.
  const raw = typeof element.className === 'string' ? element.className : (element.getAttribute?.('class') ?? '')
  const escape = (value) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&'))
  const classes = String(raw || '').trim().split(/\s+/).filter(Boolean)
  const selector = classes.length ? `${tag}.${classes.map(escape).join('.')}` : tag
  let index = 0
  try {
    for (const other of root.querySelectorAll(selector)) {
      if (other === element) break
      index += 1
    }
  } catch {
    // A selector the browser still refuses only loses this element's scroll position, never the repaint.
    return `${tag}#?`
  }
  return `${selector}#${index}`
}

function findScrollable(root, key) {
  for (const element of root.querySelectorAll('*')) {
    if (element === root) continue
    if (scrollKeyOf(element, root) === key && element.scrollHeight > element.clientHeight) return element
  }
  return null
}

function focusKeyOf(element) {
  if (!element) return ''
  if (element.dataset?.focusKey) return `k:${element.dataset.focusKey}`
  if (element.id) return `i:${element.id}`
  return ''
}

function visibleRoot(root) {
  if (!root) return null
  if (root.isConnected) return root
  return document.querySelector('.stage') || document.body
}

/** Record the state that a repaint would otherwise destroy. */
export function snapshot(root) {
  const host = visibleRoot(root)
  const at = now()
  const all = host ? detailsIn(host) : []
  const details = {}
  for (const item of all) {
    const key = detailsKeyOf(item, all)
    if (key) details[key] = item.open
  }

  const scrollers = []
  if (host) {
    for (const element of host.querySelectorAll('*')) {
      if (!element.scrollTop) continue
      if (element.scrollHeight <= element.clientHeight) continue
      scrollers.push({ key: scrollKeyOf(element, host), top: element.scrollTop })
    }
  }

  const active = document.activeElement
  let focus = null
  if (host && active && host.contains(active)) {
    const key = focusKeyOf(active)
    if (key) {
      focus = { key }
      if (typeof active.selectionStart === 'number') {
        focus.start = active.selectionStart
        focus.end = active.selectionEnd
      }
    }
  }

  return { details, scrollers, scrollY: window.scrollY, at, focus }
}


/** Seed the desired state from what the view rendered by default. */
function seedDesired(root) {
  const all = detailsIn(root)
  for (const item of all) {
    const key = detailsKeyOf(item, all)
    if (key && !desiredOpen.has(key)) desiredOpen.set(key, item.open)
  }
}

/** Re-apply the desired state after any child replacement inside the view. */
function applyDesired(root) {
  const all = detailsIn(root)
  for (const item of all) {
    const key = detailsKeyOf(item, all)
    if (!key) continue
    if (!desiredOpen.has(key)) {
      desiredOpen.set(key, item.open)
      continue
    }
    const wanted = desiredOpen.get(key)
    if (item.open !== wanted) {
      item.open = wanted
    }
  }
}

/** Put the recorded state back, synchronously, before the next frame paints. */
export function restore(root, snap) {
  if (!snap) return
  const host = visibleRoot(root)
  if (!host) return
  const all = detailsIn(host)
  for (const item of all) {
    const key = detailsKeyOf(item, all)
    if (!key) continue
    // The desired map is authoritative: it holds the person's last toggle and
    // survives every repaint in this mount, including a late second paint.
    const desired = desiredOpen.has(key) ? desiredOpen.get(key) : snap.details[key]
    if (desired === undefined) continue
    if (!desiredOpen.has(key)) desiredOpen.set(key, Boolean(desired))
    if (item.open !== Boolean(desired)) {
      item.open = Boolean(desired)
    }
  }

  for (const entry of snap.scrollers) {
    const live = liveScroll.get(entry.key)
    if (live && live.at > snap.at) continue
    const element = findScrollable(host, entry.key)
    if (element) element.scrollTop = entry.top
  }

  // Do not undo a scroll that happened while the refresh was waiting. The
  // scroll event may not have fired yet, so also trust the current position:
  // a repaint does not move the window, but the person does.
  const currentY = window.scrollY
  if (lastWindowScroll.at <= snap.at && Math.abs(currentY - Number(snap.scrollY)) <= 1) {
    suppressScrollUntil = now() + 80
    window.scrollTo(0, snap.scrollY)
  }

  if (snap.focus) {
    const key = snap.focus.key
    const element = key.startsWith('k:')
      ? host.querySelector(`[data-focus-key="${key.slice(2).replace(/"/g, '\\"')}"]`)
      : (() => {
          try { return host.querySelector(`#${CSS.escape(key.slice(2))}`) } catch { return null }
        })()
    if (element && typeof element.focus === 'function') {
      element.focus({ preventScroll: true })
      if (typeof snap.focus.start === 'number' && typeof element.setSelectionRange === 'function') {
        try { element.setSelectionRange(snap.focus.start, snap.focus.end) } catch { /* some inputs reject ranges */ }
      }
    }
  }
}

/**
 * Watch one mounted view root. Manual expand/collapse and scrolling update the
 * live record at once, so a refresh that is already in flight cannot replay an
 * older state over the person's action.
 * Returns a disposer.
 */
export function watch(root) {
  if (watchedRoot) watchedRoot.abort?.()
  observer?.disconnect()
  observer = null
  desiredOpen.clear()
  const controller = new AbortController()
  watchedRoot = controller
  seedDesired(root)

  root.addEventListener('toggle', (event) => {
    const target = event.target
    if (!(target instanceof HTMLDetailsElement) || !target.dataset.keep) return
    const all = detailsIn(root)
    const key = detailsKeyOf(target, all)
    if (key) {
      desiredOpen.set(key, target.open)
    }
  }, { capture: true, signal: controller.signal })

  // A view may repaint a second time after refresh() has already returned
  // (for example an older load that was started before the refresh). Put the
  // desired state back as soon as that DOM replacement happens.
  const localObserver = new MutationObserver(() => applyDesired(root))
  localObserver.observe(root, { childList: true, subtree: true })
  observer = localObserver

  window.addEventListener('scroll', () => {
    if (now() < suppressScrollUntil) return
    lastWindowScroll = { y: window.scrollY, at: now() }
  }, { capture: true, passive: true, signal: controller.signal })

  window.addEventListener('scroll', (event) => {
    if (now() < suppressScrollUntil) return
    const target = event.target
    if (!(target instanceof Element) || target === document.documentElement) return
    if (target.scrollHeight <= target.clientHeight) return
    liveScroll.set(scrollKeyOf(target, root), { top: target.scrollTop, at: now() })
  }, { capture: true, passive: true, signal: controller.signal })

  return () => {
    controller.abort()
    localObserver.disconnect()
    if (observer === localObserver) observer = null
  }
}
