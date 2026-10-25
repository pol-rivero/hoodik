import { onMounted, onUnmounted, ref } from 'vue'
import {
  mergeModeFor,
  mergeSelection,
  rectFromPoints,
  sameSet,
  stackedHits,
  swallowNextClick,
  type MergeMode,
  type Rect
} from '@/utils/selection'

const THRESHOLD = 4
const EDGE = 48
const MAX_SCROLL_STEP = 24

export interface MarqueeOptions {
  /** Decides whether this pointerdown may begin a band. Nothing else gates it. */
  shouldStart: (event: PointerEvent) => boolean
  /** Every element the band can hit, paired with the id it selects, top to bottom. */
  targets: () => [string, Element][]
  getSelection: () => ReadonlySet<string>
  setSelection: (ids: Set<string>) => void
  /** A band was released: the ids it covered, nearest its start first, and the resulting selection. */
  onCommit?: (hits: string[], selection: ReadonlySet<string>) => void
  /** Fixed chrome covering the top of the viewport, so auto-scroll starts below it. */
  topInset?: number
}

interface Drag {
  pointerId: number
  /** Start point in document coordinates, so it stays put while the page scrolls. */
  startX: number
  startY: number
  clientX: number
  clientY: number
  base: Set<string>
  mode: MergeMode
  active: boolean
  cancelled: boolean
  hits: string[]
  selection: Set<string>
}

/**
 * Rubber-band selection for a window-scrolled list. The band is anchored in
 * document coordinates and rendered from `band` (viewport coordinates, for a
 * fixed overlay). Rows are hit-tested from their live rects on every frame,
 * which keeps it right as rows render in and out during auto-scroll; being
 * stacked, only the ones near the band are measured.
 */
export function useMarqueeSelection(options: MarqueeOptions) {
  const band = ref<Rect | null>(null)

  let drag: Drag | null = null
  let frame = 0
  let scrollFrame = 0

  const update = () => {
    frame = 0
    if (!drag?.active || drag.cancelled) return

    const rect = rectFromPoints(
      drag.startX - window.scrollX,
      drag.startY - window.scrollY,
      drag.clientX,
      drag.clientY
    )
    band.value = rect

    const targets = options.targets()
    const rects = new Map<number, DOMRect>()
    const rectAt = (i: number) => {
      let r = rects.get(i)
      if (!r) rects.set(i, (r = targets[i][1].getBoundingClientRect()))
      return r
    }
    drag.hits = stackedHits(targets.length, rectAt, rect).map((i) => targets[i][0])

    const next = mergeSelection(drag.base, new Set(drag.hits), drag.mode)
    drag.selection = next
    if (!sameSet(next, options.getSelection())) options.setSelection(next)
  }

  const scheduleUpdate = () => {
    if (!frame) frame = requestAnimationFrame(update)
  }

  const autoScroll = () => {
    scrollFrame = 0
    if (!drag?.active || drag.cancelled) return

    const top = (options.topInset ?? 0) + EDGE
    const bottom = window.innerHeight - EDGE
    const speed = (overshoot: number) =>
      Math.min(MAX_SCROLL_STEP, Math.ceil((overshoot / EDGE) * MAX_SCROLL_STEP))

    let dy = 0
    if (drag.clientY < top) dy = -speed(top - drag.clientY)
    else if (drag.clientY > bottom) dy = speed(drag.clientY - bottom)

    if (dy) {
      // `html` has smooth scrolling on, which would queue up instead of tracking the pointer.
      window.scrollBy({ top: dy, behavior: 'instant' })
      scheduleUpdate()
    }
    scrollFrame = requestAnimationFrame(autoScroll)
  }

  const finish = () => {
    if (frame) cancelAnimationFrame(frame)
    if (scrollFrame) cancelAnimationFrame(scrollFrame)
    frame = scrollFrame = 0
    drag = null
    band.value = null
    document.documentElement.classList.remove('select-none')
  }

  const onPointerDown = (event: PointerEvent) => {
    // A press whose release we never saw (it happened outside the window).
    if (drag) finish()
    if (!options.shouldStart(event)) return

    drag = {
      pointerId: event.pointerId,
      startX: event.clientX + window.scrollX,
      startY: event.clientY + window.scrollY,
      clientX: event.clientX,
      clientY: event.clientY,
      base: new Set(options.getSelection()),
      mode: mergeModeFor(event),
      active: false,
      cancelled: false,
      hits: [],
      selection: new Set()
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return

    // The button came up somewhere we never heard about (outside the window).
    if (!(event.buttons & 1)) {
      finish()
      return
    }

    drag.clientX = event.clientX
    drag.clientY = event.clientY
    if (drag.cancelled) return

    if (!drag.active) {
      const dx = event.clientX + window.scrollX - drag.startX
      const dy = event.clientY + window.scrollY - drag.startY
      if (Math.hypot(dx, dy) < THRESHOLD) return

      drag.active = true
      window.getSelection()?.removeAllRanges()
      document.documentElement.classList.add('select-none')
      scrollFrame = requestAnimationFrame(autoScroll)
    }
    scheduleUpdate()
  }

  const onPointerUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    if (drag.active || drag.cancelled) swallowNextClick()
    if (drag.active && !drag.cancelled) {
      // The last move may still be waiting for its frame.
      update()
      const fromStart =
        drag.clientY + window.scrollY < drag.startY ? [...drag.hits].reverse() : drag.hits
      options.onCommit?.(fromStart, drag.selection)
    }
    finish()
  }

  const onPointerCancel = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    if (drag.active) options.setSelection(drag.base)
    finish()
  }

  // A pending band owns the press: no text selection, and no native drag of a
  // thumbnail image that would steal the pointer with a pointercancel.
  const preventWhileDragging = (event: Event) => {
    if (drag) event.preventDefault()
  }

  const onScroll = () => {
    if (drag?.active) scheduleUpdate()
  }

  /**
   * Abandons a live band and puts back the selection it started from. The
   * press stays owned until release so the click it ends in is swallowed too.
   * Returns whether there was a band to cancel.
   */
  const cancel = (): boolean => {
    if (!drag?.active || drag.cancelled) return false
    drag.cancelled = true
    options.setSelection(drag.base)
    band.value = null
    return true
  }

  // Leaving the window mid-drag would otherwise keep auto-scrolling with no
  // pointer to stop it; the band keeps what it has selected so far.
  const onLeave = () => {
    if (document.visibilityState === 'hidden' || !document.hasFocus()) finish()
  }

  onMounted(() => {
    window.addEventListener('blur', onLeave)
    document.addEventListener('visibilitychange', onLeave)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    document.addEventListener('selectstart', preventWhileDragging, true)
    document.addEventListener('dragstart', preventWhileDragging, true)
    window.addEventListener('scroll', onScroll, { passive: true })
  })

  onUnmounted(() => {
    finish()
    window.removeEventListener('blur', onLeave)
    document.removeEventListener('visibilitychange', onLeave)
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    document.removeEventListener('selectstart', preventWhileDragging, true)
    document.removeEventListener('dragstart', preventWhileDragging, true)
    window.removeEventListener('scroll', onScroll)
  })

  return { band, cancel }
}
