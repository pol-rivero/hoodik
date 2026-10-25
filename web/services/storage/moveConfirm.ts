import { reactive } from 'vue'

/**
 * State behind the single "Move and share folder?" confirmation, rendered by
 * `MoveConfirmHost.vue` inside the file browser layout. Living here rather
 * than in a modal lets any move entry point (the move picker, drag and drop
 * onto rows, the sidebar tree or breadcrumbs) raise the same prompt.
 */
export interface MoveConfirmState {
  visible: boolean
  /** Set when the prompt is for plain files rather than one folder's cascade;
   *  `folderName` then holds the file name when there is a single one. */
  fileCount: number | null
  folderName: string
  destinationName: string
  itemCount: number
  memberLabels: string[]
  progress: number | null
}

export const moveConfirmState = reactive<MoveConfirmState>({
  visible: false,
  fileCount: null,
  folderName: '',
  destinationName: '',
  itemCount: 0,
  memberLabels: [],
  progress: null
})

let pending: ((accepted: boolean) => void) | null = null
let hosts = 0

/** Called by the host on mount; the returned function unregisters it. */
export function registerMoveConfirmHost(): () => void {
  hosts++
  return () => {
    hosts--
    if (hosts === 0) resolveMoveConfirm(false)
  }
}

export function requestMoveConfirm(prompt: {
  fileCount?: number
  folderName: string
  destinationName: string
  itemCount: number
  memberLabels: string[]
}): Promise<boolean> {
  if (hosts === 0) {
    // Nothing could ever answer; declining sends nothing to the server.
    console.warn('Move confirmation requested with no MoveConfirmHost mounted')
    return Promise.resolve(false)
  }
  resolveMoveConfirm(false)
  Object.assign(moveConfirmState, {
    fileCount: null,
    ...prompt,
    visible: true,
    progress: null
  })
  return new Promise((resolve) => {
    pending = resolve
  })
}

export function resolveMoveConfirm(accepted: boolean): void {
  const resolve = pending
  pending = null
  moveConfirmState.visible = false
  resolve?.(accepted)
}

/** Re-wrap progress (0..1) while the prompt is up, null when unknown. */
export function reportMoveProgress(progress: number | null): void {
  if (moveConfirmState.visible) moveConfirmState.progress = progress
}
