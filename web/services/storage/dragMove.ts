import { computed, shallowRef } from 'vue'
import { mdiFileMultipleOutline, mdiFileOutline, mdiFolder } from '@mdi/js'
import { i18n } from '@/i18n'
import { SHARED_WITH_ME_DIR_ID } from '../constants'
import { canWriteToShared } from './index'
import { classifyMove, isSharedFolder } from './moveInto'
import { capabilitiesStore } from '../shares/capabilities'

import type { AppFile } from 'types'

/**
 * Marker type for drags of the user's own rows. It is never read back:
 * during dragover browsers only expose `dataTransfer.types`, so the payload
 * lives in `activeDrag` and the type only tells internal drags apart from OS
 * file drops (which carry `Files` and feed the upload handlers instead).
 *
 * Each drag carries it with its own suffix (`currentDragType`), so a drag
 * from another window or tab of the app, or a stale one whose end was never
 * seen, can't pass for the drag in progress and move files nobody dragged.
 */
export const FILE_DRAG_MIME = 'application/x-hoodik-files'

let dragType: string | null = null

/** The type the drag in progress carries, or null with no drag. */
export function currentDragType(): string | null {
  return dragType
}

export interface FileDrag {
  files: AppFile[]
  ids: ReadonlySet<string>
  /** Folder the items are dragged out of; null at the account root. */
  sourceParent: AppFile | null
  sourceParentId: string | undefined
  /** The source folder is a share or sits inside one. */
  sourceInSharedTree: boolean
}

const current = shallowRef<FileDrag | null>(null)

/** The drag in progress, if it started from a file row of this page. */
export const activeDrag = computed<FileDrag | null>(() => current.value)

/**
 * Start dragging `files` out of `sourceDir`. Call from a `dragstart` handler.
 * `sourceChain` is the source folder's chain, root-first, ending with
 * `sourceDir` itself (`Storage.parents` in the file browser); it tells a move
 * out of a folder nested in a share apart from a private one.
 *
 * Returns false (and cancels the drag) when nothing movable is left, e.g.
 * when the only dragged row is the synthetic "Shared with me" folder.
 */
export function beginFileDrag(
  event: DragEvent,
  files: AppFile[],
  sourceDir: AppFile | null,
  sourceChain: readonly AppFile[] = sourceDir ? [sourceDir] : []
): boolean {
  const movable = files.filter((f) => f.id !== SHARED_WITH_ME_DIR_ID)
  const dt = event.dataTransfer
  if (!movable.length || !dt) {
    event.preventDefault()
    return false
  }

  // Lowercase: browsers lowercase `types`.
  dragType = `${FILE_DRAG_MIME}+${Math.random().toString(36).slice(2, 10)}`
  dt.setData(dragType, JSON.stringify(movable.map((f) => f.id)))
  dt.effectAllowed = 'move'
  setDragImage(dt, movable)

  current.value = {
    files: movable,
    ids: new Set(movable.map((f) => f.id)),
    sourceParent: sourceDir,
    sourceParentId: sourceDir ? sourceDir.id : (movable[0].file_id ?? undefined),
    sourceInSharedTree: isInSharedTree(sourceChain)
  }
  springOrigin = null
  installGlobalListeners()
  // `dragend` fires on the source row even once it has been detached (a
  // spring-loaded folder replaced the listing), where no bubbling listener
  // hears it any more.
  dragSource?.removeEventListener('dragend', endFileDrag)
  if (event.target instanceof EventTarget) {
    dragSource = event.target
    dragSource.addEventListener('dragend', endFileDrag, { once: true })
  }
  // Hover verdicts read the sharing switch; have it settled before the drop.
  capabilitiesStore()
    .ensureFetched()
    .catch(() => {})
  return true
}

let dragSource: EventTarget | null = null

export function endFileDrag(): void {
  current.value = null
  dragType = null
  springOrigin = null
  dragSource?.removeEventListener('dragend', endFileDrag)
  dragSource = null
  removeGlobalListeners()
}

/** Whether the event belongs to the drag started by the last `beginFileDrag`. */
export function isInternalFileDrag(event: DragEvent): boolean {
  if (!current.value || !dragType) return false
  const types = event.dataTransfer?.types
  return !!types && Array.from(types).includes(dragType)
}

interface Point {
  x: number
  y: number
}

/** Pointer travel needed after a spring-load before another may arm. */
const SPRING_RESET_DISTANCE = 10

let springOrigin: Point | null = null

/**
 * Note that a hover at `at` (viewport coordinates) just opened a folder. The
 * listing that replaces it puts a new folder under the resting pointer, which
 * mustn't spring open in turn: the next spring waits until the pointer has
 * moved on (`canSpringLoadAt`).
 */
export function noteSpringLoad(at: Point): void {
  springOrigin = at
}

/** Whether a hover at this viewport point may arm a spring-load. */
export function canSpringLoadAt(x: number, y: number): boolean {
  if (!springOrigin) return true
  return Math.hypot(x - springOrigin.x, y - springOrigin.y) > SPRING_RESET_DISTANCE
}

// No mouse events reach the page during a native drag, so a move with no
// button down means the drag ended somewhere its `dragend` went unheard.
function onWindowPointerMove(event: MouseEvent) {
  if (event.buttons === 0) endFileDrag()
}

const acceptedEvents = new WeakSet<Event>()

/**
 * Flag a dragover a drop target accepted. Anything not flagged gets
 * `dropEffect = 'none'` from the window listener, because the file browser
 * layout cancels every dragover (to stop stray OS drops navigating away),
 * which would otherwise show a "move" cursor over the whole page.
 */
export function markDropAccepted(event: DragEvent): void {
  acceptedEvents.add(event)
}

function onWindowDragover(event: DragEvent) {
  if (!isInternalFileDrag(event) || acceptedEvents.has(event)) return
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
}

// Drop targets read the drag from their own (bubbling) drop handlers, so
// clear it only once the whole dispatch has finished.
function onWindowDrop() {
  setTimeout(endFileDrag, 0)
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') endFileDrag()
}

// `dragend` is lost when the source row is re-rendered mid-drag (it fires on
// the detached node), so these catch the drag having ended some other way.
// Not window `blur`: some platforms (Firefox on GTK) fire it as a drag starts.
const globalListeners: [string, EventListener, boolean][] = [
  ['dragend', endFileDrag, true],
  ['drop', onWindowDrop, true],
  ['dragover', onWindowDragover as EventListener, false],
  ['mousemove', onWindowPointerMove as EventListener, true],
  ['pointermove', onWindowPointerMove as EventListener, true],
  ['keydown', onWindowKeydown as EventListener, true],
  ['mousedown', endFileDrag, true]
]
let listening = false

function installGlobalListeners() {
  if (listening || typeof window === 'undefined') return
  listening = true
  for (const [type, fn, capture] of globalListeners) window.addEventListener(type, fn, capture)
}

function removeGlobalListeners() {
  if (!listening) return
  listening = false
  for (const [type, fn, capture] of globalListeners) window.removeEventListener(type, fn, capture)
}

function dragLabel(files: AppFile[]): string {
  if (files.length === 1) return files[0].name || '…'
  return i18n.global.t('files.dragMove.itemCount', files.length)
}

/**
 * A small pill instead of the browser's ghost of the whole row (or, for a
 * multi-selection, of just the row under the pointer). It has to be in the
 * DOM and rendered when `setDragImage` snapshots it, so it is parked
 * off-screen and removed on the next tick.
 */
function setDragImage(dt: DataTransfer, files: AppFile[]) {
  if (typeof dt.setDragImage !== 'function' || typeof document === 'undefined') return

  const dark = document.documentElement.classList.contains('dark')
  const colors = dark
    ? { bg: '#232323', fg: '#EEEEEE', border: '#393939', icon: '#4887E4' }
    : { bg: '#FFFFFF', fg: '#1E1E1E', border: '#D2D2CE', icon: '#336FC6' }

  const pill = document.createElement('div')
  Object.assign(pill.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    maxWidth: '260px',
    padding: '6px 12px',
    borderRadius: '9999px',
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.fg,
    font: `500 13px/1.2 ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
    pointerEvents: 'none',
    zIndex: '9999'
  })

  const iconPath =
    files.length > 1 ? mdiFileMultipleOutline : files[0].mime === 'dir' ? mdiFolder : mdiFileOutline
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.style.flexShrink = '0'
  const path = document.createElementNS(svgNs, 'path')
  path.setAttribute('d', iconPath)
  path.setAttribute('fill', colors.icon)
  svg.appendChild(path)

  const label = document.createElement('span')
  label.textContent = dragLabel(files)
  Object.assign(label.style, {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  })

  pill.append(svg, label)
  document.body.appendChild(pill)
  dt.setDragImage(pill, 12, 12)
  setTimeout(() => pill.remove(), 0)
}

export type DropRejection =
  | 'no-drag'
  | 'busy'
  | 'synthetic-root'
  | 'not-dir'
  | 'self'
  | 'descendant'
  | 'same-parent'
  | 'read-only'
  | 'blocked'

export type DropVerdict =
  | { ok: true }
  | { ok: false; reason: DropRejection; message?: string }

export interface DropContext {
  drag: FileDrag | null
  /** Ids of the target's ancestors, root-first, excluding the target. */
  targetAncestorIds: readonly string[]
  /** Target sits inside a shared tree (an ancestor is shared). A shared
   *  target itself is detected from its own row. */
  targetInSharedTree?: boolean
  /** Mirrors the server's sharing kill-switch, as in `classifyMove`. */
  sharingEnabled?: boolean
  /** Another move is still running (`moveInFlight`). */
  moveInFlight?: boolean
}

/**
 * Whether the current drag may be dropped on `target`, where `undefined`
 * is the account root. Pure, so every drop surface (table rows, sidebar
 * tree, breadcrumbs) rejects the same things: moves into the selection or
 * below it (loops), no-op moves, non-folders, read-only shares, and the
 * moves `classifyMove` would block.
 */
export function canDropInto(target: AppFile | undefined, ctx: DropContext): DropVerdict {
  const { drag } = ctx
  if (!drag || !drag.files.length) return { ok: false, reason: 'no-drag' }
  if (ctx.moveInFlight) return { ok: false, reason: 'busy' }

  if (target) {
    if (target.id === SHARED_WITH_ME_DIR_ID) return { ok: false, reason: 'synthetic-root' }
    if (target.mime !== 'dir') return { ok: false, reason: 'not-dir' }
    if (drag.ids.has(target.id)) return { ok: false, reason: 'self' }
  }

  if (ctx.targetAncestorIds.some((id) => drag.ids.has(id))) {
    return { ok: false, reason: 'descendant' }
  }

  const targetId = target?.id
  if (drag.files.every((f) => (f.file_id ?? undefined) === targetId)) {
    return { ok: false, reason: 'same-parent' }
  }

  if (target && target.is_owner === false && !canWriteToShared(target)) {
    return { ok: false, reason: 'read-only' }
  }

  const decision = classifyMove({
    sources: drag.files,
    destination: target,
    sourceParent: drag.sourceParent,
    sharingEnabled: ctx.sharingEnabled ?? true,
    destinationRosterId: target && ctx.targetInSharedTree ? target.id : undefined,
    sourceRosterId: drag.sourceInSharedTree ? drag.sourceParentId : undefined
  })
  if (decision.kind === 'blocked') {
    return { ok: false, reason: 'blocked', message: decision.message }
  }

  return { ok: true }
}

/** Whether a folder chain (root-first) puts its children in a shared tree. */
export function isInSharedTree(ancestors: readonly AppFile[]): boolean {
  return ancestors.some((a) => a.id === SHARED_WITH_ME_DIR_ID || isSharedFolder(a))
}
