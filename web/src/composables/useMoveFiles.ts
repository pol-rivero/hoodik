import { i18n } from '@/i18n'
import { errorNotification, notification } from '!/notify'
import { store as storageStore } from '!/storage'
import { store as cryptoStore } from '!/crypto'
import { store as loginStore } from '!/auth/login'
import { capabilitiesStore } from '!/shares/capabilities'
import { moveFiles } from '!/storage/moveFiles'
import type { MoveFilesOutcome } from '!/storage/moveFiles'
import { reportMoveProgress, requestMoveConfirm } from '!/storage/moveConfirm'

import type { AppFile, FolderMember, KeyPair } from 'types'

export interface MoveFilesOptions {
  /** Folder the sources live in; defaults to the folder being listed. */
  sourceParent?: AppFile | null
  /** Show "Moved N items to <folder>" on success. */
  notifySuccess?: boolean
  /**
   * Ask before plain files are shared with a destination's members, not only
   * before folder cascades. Drag and drop sets it: one slip of the pointer
   * shouldn't share a file. The picker, an explicit choice, doesn't.
   */
  confirmFileShares?: boolean
  /** Override the session keypair / user (the move picker passes its props). */
  keypair?: KeyPair
  callerUserId?: string
}

/**
 * Move `sources` into `destination` (undefined = account root) with the full
 * UI around it: shared-folder confirmations through `MoveConfirmHost`,
 * blocked, busy and failed moves as notifications, and an optional success
 * notification. Never navigates. Resolves to null when the move failed.
 *
 * Unknown destination members are trusted on first use, the same as the
 * upload and picker paths (`executeMove` default).
 *
 * Safe to call outside a component's setup (e.g. from a drop handler).
 */
export async function moveFilesInteractive(
  sources: AppFile[],
  destination: AppFile | undefined,
  options: MoveFilesOptions = {}
): Promise<MoveFilesOutcome | null> {
  const t = i18n.global.t
  const Storage = storageStore()
  // Snapshot before any await: the user may navigate while this runs.
  const sourceParent = options.sourceParent !== undefined ? options.sourceParent : Storage.dir
  const sourceParentId = sourceParent?.id ?? sources[0]?.file_id ?? undefined
  const keypair = options.keypair ?? cryptoStore().keypair
  const callerUserId = options.callerUserId ?? loginStore().authenticated?.user.id ?? ''
  const destinationName = destination?.name || t('files.move.home')
  const caps = capabilitiesStore()

  const memberLabels = (members: FolderMember[]) =>
    members.filter((m) => m.user_id !== callerUserId).map((m) => m.email ?? m.user_id)

  let outcome: MoveFilesOutcome
  try {
    await caps.ensureFetched()
    outcome = await moveFiles(
      { sources, destination, sourceParent, sourceParentId },
      {
        Storage,
        keypair,
        callerUserId,
        sharingEnabled: caps.sharingEnabled,
        confirmCascade: (folder, preview) =>
          requestMoveConfirm({
            folderName: folder.name,
            destinationName,
            itemCount: preview.itemCount,
            memberLabels: memberLabels(preview.members)
          }),
        confirmFiles: options.confirmFileShares
          ? (files, preview) =>
              requestMoveConfirm({
                fileCount: files.length,
                folderName: files[0]?.name ?? '',
                destinationName,
                itemCount: files.length,
                memberLabels: memberLabels(preview.members)
              })
          : undefined,
        onProgress: (p) => reportMoveProgress(p.totalKeys > 0 ? p.wrappedKeys / p.totalKeys : null)
      }
    )
  } catch (error) {
    errorNotification(error)
    return null
  }

  if (outcome.status === 'blocked') {
    errorNotification(outcome.message)
  } else if (outcome.status === 'busy') {
    notification(t('files.dragMove.busy'), undefined, 'warn')
  } else if (outcome.status === 'moved' && outcome.partial) {
    notification(
      t('files.dragMove.partial', { moved: outcome.moved, total: sources.length, folder: destinationName }),
      undefined,
      'info'
    )
  } else if (outcome.status === 'moved' && options.notifySuccess) {
    notification(
      t('files.dragMove.moved', { count: outcome.moved, folder: destinationName }, outcome.moved),
      undefined,
      'success'
    )
  }
  return outcome
}

export function useMoveFiles() {
  return { moveFiles: moveFilesInteractive }
}
