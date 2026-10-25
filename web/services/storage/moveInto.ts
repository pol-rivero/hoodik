import {
  moveSingleFileIntoSharedFolder,
  moveIntoSharedFolder,
  moveOutOfSharedFolder,
  trustedFingerprintsStore,
  UploadIntoSharedFolderAborted
} from '!/shares'
import type {
  MoveCascadePreview,
  MoveIntoSharedFolderOptions,
  UnknownMemberPrompt
} from '!/shares'

import type { AppFile, KeyPair } from 'types'

/**
 * A directory is a multi-key (shared) move target when the caller doesn't own
 * it, or owns it but has shared it (its member list has been signed). The same
 * predicate the upload funnel uses in `LayoutFileBrowserInner.vue`. The account
 * root is never a target — there is no `AppFile` for it.
 */
export function isSharedFolder(file: AppFile | null | undefined): boolean {
  return (
    !!file &&
    file.mime === 'dir' &&
    (file.is_owner === false || file.members_signed_at != null)
  )
}

export type MoveDecision =
  | { kind: 'plain'; sources: AppFile[]; destinationId: string | undefined }
  | { kind: 'blocked'; message: string }
  | {
      kind: 'into-shared'
      sources: AppFile[]
      destinationFolderId: string
      rosterFolderId?: string
    }
  | { kind: 'move-out'; sources: AppFile[]; destinationId: string | undefined }

/**
 * Classify a requested move from the sources, their current parent, and the
 * chosen destination — the single place the funnel's decision tree lives,
 * mirroring the mobile `MoveRouter`. Reads only share-state; it never wraps a
 * key or hits a mutation endpoint. The server still enforces every hard rule
 * (ownership, dest-is-shared, folder-requires-cascade); this is the client-side
 * routing plus the early "block the whole move on any ineligible item" guard.
 *
 * When `sharingEnabled` is false (kill-switch or an older server), every
 * destination resolves to a plain move so a server that doesn't speak sharing
 * never engages these paths.
 */
export function classifyMove(args: {
  sources: AppFile[]
  destination: AppFile | undefined
  sourceParent: AppFile | null
  sharingEnabled: boolean
  /** Resolved roster source for the destination (`Storage.writeRosterId`).
   *  Set for any destination inside a shared tree — including folders
   *  below the share root, which `isSharedFolder` alone can't see. */
  destinationRosterId?: string
  /** Same, for the folder the sources leave. Without it a move out of a
   *  subfolder of a share would go through plain `move-many`, which keeps
   *  every member's access row on the moved items. */
  sourceRosterId?: string
}): MoveDecision {
  const { sources, destination, sourceParent, sharingEnabled, destinationRosterId, sourceRosterId } =
    args
  if (sources.length === 0) {
    return { kind: 'plain', sources, destinationId: destination?.id }
  }

  const destShared =
    sharingEnabled && (destinationRosterId != null || isSharedFolder(destination))
  if (destShared && destination) {
    if (sources.some((f) => !f.is_owner)) {
      return {
        kind: 'blocked',
        message: 'You can only move files you own into a shared folder.'
      }
    }
    return {
      kind: 'into-shared',
      sources,
      destinationFolderId: destination.id,
      rosterFolderId: destinationRosterId
    }
  }

  const sourceShared =
    sharingEnabled && (sourceRosterId != null || isSharedFolder(sourceParent))
  if (!sourceShared) {
    return { kind: 'plain', sources, destinationId: destination?.id }
  }

  if (sources.some((f) => !f.is_owner)) {
    return {
      kind: 'blocked',
      message: 'Only the owner can move a file out of a shared folder.'
    }
  }
  return { kind: 'move-out', sources, destinationId: destination?.id }
}

export interface MoveResult {
  moved: number
  /** Ids actually relocated, in order. A partial batch lists only those. */
  movedIds: string[]
  blocked?: string
  /** A confirmation was declined part-way; `movedIds` went before it. */
  aborted?: boolean
}

/**
 * Thrown when a shared-path batch fails after some items already moved, so
 * the caller can still refresh for those before surfacing `cause`.
 */
export class MovePartiallyFailed extends Error {
  constructor(
    readonly movedIds: string[],
    readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'MovePartiallyFailed'
  }
}

export interface ExecuteMoveDeps {
  callerUserId: string
  keypair: KeyPair
  /** Runs the unchanged batch relocation (`Storage.moveAll`). */
  plainMove: (sources: AppFile[], destinationId: string | undefined) => Promise<void>
  /** Fires before any folder cascade wraps a key; false aborts the move. */
  confirmCascade?: (folder: AppFile, preview: MoveCascadePreview) => Promise<boolean>
  /** Fires once, before the first plain file of the batch is wrapped for the
   *  destination members (after their roster verified); covers every file
   *  in the batch. Without it files move in unprompted. */
  confirmFiles?: (files: AppFile[], preview: MoveCascadePreview) => Promise<boolean>
  onProgress?: MoveIntoSharedFolderOptions['onProgress']
  onSubtreeProgress?: MoveIntoSharedFolderOptions['onSubtreeProgress']
  onUnknownMember?: (prompt: UnknownMemberPrompt) => Promise<boolean>
}

/**
 * Run a classified move, mirroring the mobile `MoveExecutor`. Owned items
 * bound for a shared folder are routed individually — a file through the
 * single-file `member_keys` path, a directory through the cascade `entries`
 * path (which fires the confirm gate before wrapping). The batch was
 * guaranteed all-owned by `classifyMove`, so there is no partial-skip: the
 * first failure aborts and surfaces.
 */
export async function executeMove(
  decision: MoveDecision,
  deps: ExecuteMoveDeps
): Promise<MoveResult> {
  if (!deps.keypair.input || !deps.keypair.publicKey) {
    throw new Error('Cannot move without an active keypair')
  }
  const privateKey = deps.keypair.input
  const wrappingPrivateKey = deps.keypair.wrappingPrivate || deps.keypair.input
  const trusted = trustedFingerprintsStore()
  const onUnknownMember = deps.onUnknownMember ?? (async () => true)

  switch (decision.kind) {
    case 'blocked':
      return { moved: 0, movedIds: [], blocked: decision.message }

    case 'plain':
      await deps.plainMove(decision.sources, decision.destinationId)
      return { moved: decision.sources.length, movedIds: decision.sources.map((f) => f.id) }

    case 'into-shared': {
      const movedIds: string[] = []
      const files = decision.sources.filter((f) => f.mime !== 'dir')
      let filesConfirmed = !deps.confirmFiles
      try {
        for (const item of decision.sources) {
          if (item.mime === 'dir') {
            await moveIntoSharedFolder(
              {
                callerUserId: deps.callerUserId,
                callerPrivateKey: privateKey,
                callerWrappingPrivateKey: wrappingPrivateKey,
                root: item,
                destinationFolderId: decision.destinationFolderId,
                rosterFolderId: decision.rosterFolderId,
                trustedFingerprints: trusted,
                onUnknownMember
              },
              {
                onProgress: deps.onProgress,
                onSubtreeProgress: deps.onSubtreeProgress,
                confirm: deps.confirmCascade
                  ? (preview) => deps.confirmCascade!(item, preview)
                  : undefined
              }
            )
          } else {
            await moveSingleFileIntoSharedFolder(
              {
                callerUserId: deps.callerUserId,
                callerPrivateKey: privateKey,
                callerWrappingPrivateKey: wrappingPrivateKey,
                file: item,
                destinationFolderId: decision.destinationFolderId,
                rosterFolderId: decision.rosterFolderId,
                trustedFingerprints: trusted,
                onUnknownMember
              },
              {
                confirm: filesConfirmed
                  ? undefined
                  : async (preview) => {
                      filesConfirmed = await deps.confirmFiles!(files, preview)
                      return filesConfirmed
                    }
              }
            )
          }
          movedIds.push(item.id)
        }
      } catch (err) {
        // A declined confirm (or TOFU prompt) stops the batch with nothing
        // more sent: report what went before it, not an error.
        if (err instanceof UploadIntoSharedFolderAborted) {
          return { moved: movedIds.length, movedIds, aborted: true }
        }
        throw movedIds.length ? new MovePartiallyFailed(movedIds, err) : err
      }
      return { moved: movedIds.length, movedIds }
    }

    case 'move-out': {
      const movedIds: string[] = []
      try {
        for (const item of decision.sources) {
          await moveOutOfSharedFolder({
            callerUserId: deps.callerUserId,
            callerPrivateKey: privateKey,
            fileId: item.id,
            destinationFolderId: decision.destinationId ?? null
          })
          movedIds.push(item.id)
        }
      } catch (err) {
        throw movedIds.length ? new MovePartiallyFailed(movedIds, err) : err
      }
      return { moved: movedIds.length, movedIds }
    }
  }
}
