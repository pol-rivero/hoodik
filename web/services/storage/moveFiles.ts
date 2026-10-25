import { computed, ref } from 'vue'
import { emitFileTreeChange } from './events'
import { MovePartiallyFailed, classifyMove, executeMove } from './moveInto'
import type { ExecuteMoveDeps, MoveDecision } from './moveInto'

import type { AppFile, FilesStore, KeyPair } from 'types'
import type { MoveCascadePreview } from '!/shares'

export interface MoveFilesRequest {
  sources: AppFile[]
  /** Folder to move into; undefined is the account root. */
  destination: AppFile | undefined
  /** Folder the sources currently live in; null at the account root. */
  sourceParent: AppFile | null
  /** Its id, when the row itself isn't loaded; defaults to `sourceParent.id`. */
  sourceParentId?: string
}

export interface MoveFilesDeps {
  Storage: Pick<FilesStore, 'moveAll' | 'find' | 'removeItem' | 'writeRosterId' | 'currentDirId'>
  keypair: KeyPair
  callerUserId: string
  sharingEnabled: boolean
  confirmCascade?: (folder: AppFile, preview: MoveCascadePreview) => Promise<boolean>
  confirmFiles?: ExecuteMoveDeps['confirmFiles']
  onProgress?: ExecuteMoveDeps['onProgress']
  /** Test seam; defaults to `executeMove`. */
  execute?: typeof executeMove
}

export type MoveFilesOutcome =
  | {
      status: 'moved'
      moved: number
      kind: Exclude<MoveDecision['kind'], 'blocked'>
      /** A confirmation was declined after `moved` items already went. */
      partial?: boolean
    }
  | { status: 'blocked'; message: string }
  | { status: 'cancelled' }
  /** Another move is still running (e.g. awaiting its confirmation). */
  | { status: 'busy' }

const inFlight = ref(false)

/**
 * True while a move runs, confirmation prompts included. Drop targets refuse
 * drops and the picker refuses picks meanwhile, so the same items can't be
 * sent twice and a second prompt can't replace the first.
 */
export const moveInFlight = computed(() => inFlight.value)

/**
 * Classify, execute and refresh one move. Shared by the move picker and every
 * drag-and-drop target. Navigation, notifications and error display stay
 * with the caller; errors propagate (after refreshing for whatever moved).
 *
 * Both ends are resolved against their shared trees, so a move out of any
 * folder inside a share, not only its root, drops the members' access.
 */
export async function moveFiles(
  request: MoveFilesRequest,
  deps: MoveFilesDeps
): Promise<MoveFilesOutcome> {
  if (inFlight.value) return { status: 'busy' }
  inFlight.value = true
  try {
    return await run(request, deps)
  } finally {
    inFlight.value = false
  }
}

async function run(request: MoveFilesRequest, deps: MoveFilesDeps): Promise<MoveFilesOutcome> {
  const { sources, destination, sourceParent } = request
  const { Storage } = deps
  if (!sources.length) return { status: 'cancelled' }

  const sourceParentId = request.sourceParentId ?? sourceParent?.id
  const [destinationRosterId, sourceRosterId] = await Promise.all([
    destination ? Storage.writeRosterId(destination.id) : undefined,
    sourceParentId ? Storage.writeRosterId(sourceParentId) : undefined
  ])

  const decision = classifyMove({
    sources,
    destination,
    sourceParent,
    sharingEnabled: deps.sharingEnabled,
    destinationRosterId,
    sourceRosterId
  })
  if (decision.kind === 'blocked') {
    return { status: 'blocked', message: decision.message }
  }

  const refreshShared = async (movedIds: string[]) => {
    const listed = Storage.currentDirId
    if (destination?.id !== listed) {
      movedIds.forEach((id) => Storage.removeItem(id))
    }
    await Storage.find(deps.keypair, listed, false)
    emitFileTreeChange({
      type: 'moved',
      folderId: sourceParentId,
      targetFolderId: destination?.id
    })
  }

  let result
  try {
    result = await (deps.execute ?? executeMove)(decision, {
      callerUserId: deps.callerUserId,
      keypair: deps.keypair,
      plainMove: (items, destinationId) =>
        Storage.moveAll(deps.keypair, items, destinationId, sourceParentId),
      confirmCascade: deps.confirmCascade,
      confirmFiles: deps.confirmFiles,
      onProgress: deps.onProgress
    })
  } catch (err) {
    if (err instanceof MovePartiallyFailed) {
      await refreshShared(err.movedIds).catch(() => {})
      throw err.cause
    }
    throw err
  }
  if (result.blocked) return { status: 'blocked', message: result.blocked }
  if (result.moved === 0) return { status: 'cancelled' }

  // The plain path refreshes through `Storage.moveAll`.
  if (decision.kind !== 'plain') await refreshShared(result.movedIds)

  return {
    status: 'moved',
    moved: result.moved,
    kind: decision.kind,
    ...(result.aborted ? { partial: true } : {})
  }
}
