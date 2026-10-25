import { onMounted, onUnmounted } from 'vue'
import { swallowNextClick } from '@/utils/selection'

const DELAY = 500
const TOLERANCE = 10

export interface LongPressOptions {
  /** The element a touch press at this event would long-press, or null to ignore it. */
  target: (event: PointerEvent) => HTMLElement | null
  onLongPress: (target: HTMLElement) => void
}

/**
 * Touch and pen long-press. Mouse presses are left alone: the mouse has
 * modifier keys and a real context menu. The press also owns the native
 * context menu (and with it the callout) while it is held, and the click the
 * browser may send on release is swallowed so it doesn't undo the press.
 */
export function useLongPress(options: LongPressOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let press: {
    pointerId: number
    x: number
    y: number
    target: HTMLElement
    fired: boolean
  } | null = null

  const clear = () => {
    clearTimeout(timer)
    timer = undefined
    press = null
  }

  const fire = () => {
    if (!press || press.fired) return
    clearTimeout(timer)
    press.fired = true
    swallowNextClick(true)
    options.onLongPress(press.target)
  }

  const onPointerDown = (event: PointerEvent) => {
    clear()
    if (event.pointerType === 'mouse' || !event.isPrimary) return
    const target = options.target(event)
    if (!target) return

    press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, target, fired: false }
    timer = setTimeout(fire, DELAY)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!press || press.fired || event.pointerId !== press.pointerId) return
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TOLERANCE) clear()
  }

  const onPointerEnd = (event: PointerEvent) => {
    if (press && event.pointerId === press.pointerId) clear()
  }

  // Some browsers raise the context menu before our timer runs out; either
  // way the press means "select", not "show the native menu".
  const onContextMenu = (event: Event) => {
    if (!press) return
    event.preventDefault()
    fire()
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', onPointerEnd, true)
    window.addEventListener('pointercancel', onPointerEnd, true)
    document.addEventListener('contextmenu', onContextMenu, true)
  })

  onUnmounted(() => {
    clear()
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerEnd, true)
    window.removeEventListener('pointercancel', onPointerEnd, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
  })
}
