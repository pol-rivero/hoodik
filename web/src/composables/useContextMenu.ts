import { computed, shallowRef, type ComputedRef } from 'vue'

export interface ContextMenuItem<A extends string = string> {
  kind: 'item'
  /** Unique within one menu; also the default `data-testid` suffix. */
  id: string
  label: string
  /** An `@mdi/js` path. */
  icon?: string
  /** Hint text shown on the right, e.g. "Del". Display only; it binds nothing. */
  shortcut?: string
  /** Hover tooltip. */
  title?: string
  danger?: boolean
  disabled?: boolean
  testid?: string
  /** What the caller should do when the item is chosen. Opaque to the menu. */
  action?: A
}

export interface ContextMenuSeparator {
  kind: 'separator'
  id: string
}

/** Non-interactive heading text, e.g. "3 selected". Not announced as an item. */
export interface ContextMenuLabel {
  kind: 'label'
  id: string
  label: string
  testid?: string
}

export type ContextMenuEntry<A extends string = string> =
  | ContextMenuItem<A>
  | ContextMenuSeparator
  | ContextMenuLabel

export type ContextMenuCloseReason = 'escape' | 'tab' | 'outside' | 'scroll' | 'resize' | 'blur'

export interface ContextMenuRequest<A extends string = string> {
  /** Viewport (client) coordinates of the pointer. */
  x: number
  y: number
  items: ContextMenuEntry<A>[]
  onSelect: (item: ContextMenuItem<A>) => void
  /** Accessible name of the menu. */
  label?: string
  /** What was right-clicked. Scrolling a container that doesn't hold it leaves the menu open. */
  anchor?: Element | null
  /** Runs whenever this menu goes away, including when another menu replaces it. */
  onClose?: () => void
}

export interface OpenContextMenu extends ContextMenuRequest {
  /** Changes on every open, so a replacement remounts the menu at its new position. */
  id: number
}

export const isMenuItem = <A extends string>(
  entry: ContextMenuEntry<A>
): entry is ContextMenuItem<A> => entry.kind === 'item'

const current = shallowRef<OpenContextMenu | null>(null)
let returnFocusTo: HTMLElement | null = null
let sequence = 0

/**
 * Opens the app-wide menu, replacing any menu already open. A request with
 * nothing selectable in it opens nothing, so callers can leave the native
 * browser menu alone in that case. Returns whether a menu is now open.
 */
export function openContextMenu<A extends string>(request: ContextMenuRequest<A>): boolean {
  if (!request.items.some((entry) => isMenuItem(entry) && !entry.disabled)) {
    closeContextMenu()
    return false
  }

  const previous = current.value
  if (previous) {
    previous.onClose?.()
  } else {
    // A replacement keeps the focus captured by the first menu: the
    // element focused now is that menu's item, which is about to vanish.
    const active = document.activeElement
    returnFocusTo = active instanceof HTMLElement && active !== document.body ? active : null
  }

  current.value = { ...(request as unknown as ContextMenuRequest), id: ++sequence }
  return true
}

export interface CloseContextMenuOptions {
  /** Focus the element that had it before the menu opened. Default true. */
  restoreFocus?: boolean
  /** Only close if this menu is still the open one, so a stale menu can't close its replacement. */
  id?: number
}

export function closeContextMenu(options: CloseContextMenuOptions = {}): void {
  const menu = current.value
  if (!menu) return
  if (options.id !== undefined && options.id !== menu.id) return

  current.value = null
  const target = returnFocusTo
  returnFocusTo = null
  if (options.restoreFocus !== false && target?.isConnected) {
    target.focus({ preventScroll: true })
  }
  menu.onClose?.()
}

/**
 * Closes the menu before running the handler, so focus is back on the page
 * by the time a handler opens a modal that wants to trap it.
 */
export function selectContextMenuItem(item: ContextMenuItem, options: { id?: number } = {}): void {
  const menu = current.value
  if (!menu || item.disabled) return
  if (options.id !== undefined && options.id !== menu.id) return
  closeContextMenu()
  menu.onSelect(item)
}

let cancelSwallow: (() => void) | null = null

/**
 * A press that dismisses a menu does nothing else, like native menus: its
 * mousedown and click never reach the page, so it can't select a row, open
 * a folder or clear the selection. The next press ends the swallow, so a
 * press that never produced a click can't eat a later one.
 */
export function swallowDismissingClick(): void {
  cancelSwallow?.()

  const swallow = (event: Event) => {
    event.stopPropagation()
    event.preventDefault()
    if (event.type === 'click') cancelSwallow?.()
  }
  const stop = () => cancelSwallow?.()

  window.addEventListener('mousedown', swallow, true)
  window.addEventListener('click', swallow, true)
  window.addEventListener('pointerdown', stop, true)
  cancelSwallow = () => {
    window.removeEventListener('mousedown', swallow, true)
    window.removeEventListener('click', swallow, true)
    window.removeEventListener('pointerdown', stop, true)
    cancelSwallow = null
  }
}

/**
 * Opens the menu from a `contextmenu` event. Keyboard-raised events
 * (the Menu key, Shift+F10) carry no pointer position, so the menu anchors
 * to the event target instead. When a menu opens, the event's default and
 * propagation are stopped, so an outer handler (say, the blank-space menu
 * around a row) doesn't replace it and the native menu stays hidden.
 */
export function openContextMenuFromEvent<A extends string>(
  event: MouseEvent,
  request: Omit<ContextMenuRequest<A>, 'x' | 'y'>
): boolean {
  const target = event.target instanceof Element ? event.target : null
  let x = event.clientX
  let y = event.clientY
  if (!x && !y && target) {
    const rect = target.getBoundingClientRect()
    x = rect.left + Math.min(rect.width / 2, 24)
    y = rect.top + rect.height / 2
  }

  const opened = openContextMenu({ anchor: target, ...request, x, y })
  if (opened) {
    event.preventDefault()
    event.stopPropagation()
  }
  return opened
}

export function useContextMenu(): {
  menu: ComputedRef<OpenContextMenu | null>
  isOpen: ComputedRef<boolean>
  open: typeof openContextMenu
  openFromEvent: typeof openContextMenuFromEvent
  close: typeof closeContextMenu
  select: typeof selectContextMenuItem
} {
  return {
    menu: computed(() => current.value),
    isOpen: computed(() => current.value !== null),
    open: openContextMenu,
    openFromEvent: openContextMenuFromEvent,
    close: closeContextMenu,
    select: selectContextMenuItem
  }
}
