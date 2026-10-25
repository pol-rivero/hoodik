import {
  mdiAccountArrowLeft,
  mdiCheckAll,
  mdiContentSave,
  mdiDownload,
  mdiDownloadMultiple,
  mdiFileDocumentPlusOutline,
  mdiFilePlusOutline,
  mdiFolderArrowUpOutline,
  mdiFolderMove,
  mdiFolderOpenOutline,
  mdiFolderPlusOutline,
  mdiFolderZipOutline,
  mdiInformationOutline,
  mdiOpenInNew,
  mdiPencil,
  mdiShareVariantOutline,
  mdiTrashCan
} from '@mdi/js'
import type { RouteLocationRaw } from 'vue-router'
import type { AppFile } from 'types'
import { isMarkdownFile, isPreviewable } from '!/preview'
import { SHARED_WITH_ME_DIR_ID, canWriteToShared } from '!/storage'
import type {
  ContextMenuEntry,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator
} from '@/composables/useContextMenu'

/**
 * Actions on one file or folder. Each dispatches to the handler of the same
 * name in `LayoutFileBrowserInner`'s `on` map, called with the file:
 *
 * | action     | handler                                                      |
 * |------------|--------------------------------------------------------------|
 * | `open`     | none: `router.push(fileOpenRoute(file))` (folder, preview or notes editor) |
 * | `download` | `on.download(file)`                                          |
 * | `rename`   | `on.rename(file)`                                            |
 * | `move`     | none yet: select only this file, then `on['move-all']()`     |
 * | `sharing`  | `on.sharing(file)`                                           |
 * | `details`  | `on.details(file)`                                           |
 * | `fork`     | `on.fork(file)`                                              |
 * | `leave`    | `on.leave(file)` (recipient's "Remove")                      |
 * | `remove`   | `on.remove(file)` (owner's "Move to trash")                  |
 */
export type FileMenuAction =
  | 'open'
  | 'download'
  | 'rename'
  | 'move'
  | 'sharing'
  | 'details'
  | 'fork'
  | 'leave'
  | 'remove'

/**
 * Actions on the current selection (`Storage.selected`), dispatched with no
 * arguments: `on['download-many']()`, `on['move-all']()`, `on['remove-all']()`.
 */
export type SelectionMenuAction = 'download-many' | 'move-all' | 'remove-all'

/**
 * Actions on the folder being browsed, dispatched with no arguments:
 * `on.directory()`, `on.file()`, `on.browse()`, `on['browse-folder']()`.
 * `select-all` is the same as Ctrl+A in `TableFiles` (`on['select-all']`
 * takes the rows and the folder id there, so route it through the table's
 * own select-all rather than calling the store directly).
 */
export type BlankMenuAction = 'directory' | 'file' | 'browse' | 'browse-folder' | 'select-all'

export type FileBrowserMenuAction = FileMenuAction | SelectionMenuAction | BlankMenuAction

export type FileMenuItem = ContextMenuItem<FileMenuAction>
export type SelectionMenuItem = ContextMenuItem<SelectionMenuAction>
export type BlankMenuItem = ContextMenuItem<BlankMenuAction>

/** Narrow enough that both `useI18n().t` and `i18n.global.t` fit. */
export type Translate = (key: string, named?: Record<string, unknown>) => string

interface CommonMenuContext {
  t: Translate
  /** Picks the macOS spelling of shortcut hints. Detected from the browser when omitted. */
  isMac?: boolean
}

export interface FileCapabilityContext {
  sharingEnabled: boolean
  forkEnabled: boolean
  hideDelete?: boolean
}

export interface FileMenuContext extends CommonMenuContext, FileCapabilityContext {}

export interface SelectionMenuContext extends CommonMenuContext {
  hideDelete?: boolean
}

export interface BlankMenuContext extends CommonMenuContext {
  /** Id of the folder being browsed; undefined at the root. */
  parentId: string | undefined
  /** The folder being browsed (`Storage.dir`); null at the root. */
  dir: AppFile | null
  /** Offer "Select all": the listing has rows and selection is enabled. */
  canSelectAll?: boolean
}

export interface FileCapabilities {
  open: boolean
  preview: boolean
  download: boolean
  rename: boolean
  move: boolean
  sharing: boolean
  details: boolean
  fork: boolean
  leave: boolean
  remove: boolean
}

const detectMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// Key names are localised (Entf, Suppr, Strg+A); the macOS glyphs are the same everywhere.
const shortcuts = (ctx: CommonMenuContext) =>
  (ctx.isMac ?? detectMac())
    ? { delete: '⌘⌫', selectAll: '⌘A' }
    : {
        delete: ctx.t('files.contextMenu.shortcutDelete'),
        selectAll: ctx.t('files.contextMenu.shortcutSelectAll')
      }

/** A file whose content hasn't fully landed yet, so it can't be read or downloaded. */
const isContentPending = (file: AppFile) => file.mime !== 'dir' && !file.finished_upload_at

/**
 * The synthetic "Shared with me" root has no row on disk: its id is a
 * client-only marker that would 400 every storage / shares endpoint it
 * reaches, so the only thing it supports is navigating into it.
 */
export const isSyntheticRoot = (file: AppFile) => file.id === SHARED_WITH_ME_DIR_ID

/**
 * Owners always; recipients only when their role allows writes. Readers
 * open markdown in the read-only preview instead of the editor.
 */
export function canWriteMarkdown(file: AppFile): boolean {
  return !!file.is_owner || canWriteToShared(file)
}

/**
 * Where opening a row leads: the folder, the notes editor, or the preview.
 * Null for a file with nothing to show, where opening falls back to Details.
 */
export function fileOpenRoute(file: AppFile): RouteLocationRaw | null {
  if (file.mime === 'dir') return { name: 'files', params: { file_id: file.id } }
  if (file.finished_upload_at && isMarkdownFile(file) && canWriteMarkdown(file)) {
    return { name: 'notes', params: { id: file.id } }
  }
  if (isPreviewable(file)) return { name: 'file-preview', params: { id: file.id } }
  return null
}

/**
 * One level up from the folder at the end of `chain` (root-first, as in
 * `Storage.parents`), the way the breadcrumbs lead: its parent when the chain
 * has one, "Shared with me" from the top of an incoming share, else the root.
 * Null at the root itself.
 */
export function parentFolderRoute(chain: readonly AppFile[]): RouteLocationRaw | null {
  if (!chain.length) return null
  const parent = chain[chain.length - 2]
  if (parent) return { name: 'files', params: { file_id: parent.id } }
  const head = chain[0]
  if (!isSyntheticRoot(head) && head.is_owner === false) {
    return { name: 'files', params: { file_id: SHARED_WITH_ME_DIR_ID } }
  }
  return { name: 'files' }
}

/**
 * Whether new folders, new files and uploads can go into the folder being
 * browsed. Meant as the single rule for every create/upload affordance
 * (the blank-space menu now, the toolbar next). They work wherever the
 * multi-key create can run: the root, any folder the caller owns, and any
 * folder shared with a write role. Readers get none, and neither does the
 * synthetic "Shared with me" root, which has no real folder to write into.
 */
export function canCreateHere(dir: AppFile | null, parentId?: string): boolean {
  if (parentId === SHARED_WITH_ME_DIR_ID) return false
  if (!dir) return true
  if (isSyntheticRoot(dir)) return false
  if (dir.mime !== 'dir') return false
  if (dir.is_owner !== false) return true
  return canWriteToShared(dir)
}

/**
 * The rules behind every per-file action surface: the row dropdown, the
 * mobile actions modal and the context menu.
 */
export function fileCapabilities(file: AppFile, ctx: FileCapabilityContext): FileCapabilities {
  if (isSyntheticRoot(file)) {
    return {
      open: true,
      preview: false,
      download: false,
      rename: false,
      move: false,
      sharing: false,
      details: false,
      fork: false,
      leave: false,
      remove: false
    }
  }

  const isDir = file.mime === 'dir'
  const settled = isDir || !!file.finished_upload_at
  const recipient = file.is_owner === false

  return {
    open: fileOpenRoute(file) !== null,
    preview: isPreviewable(file),
    download: settled,
    rename: !!file.is_owner && settled,
    // Moving needs write access on the source; readers get a 403.
    move: !recipient || canWriteToShared(file),
    // Every member of a share may inspect its roster; the modal disables
    // mutation for callers without `can_reshare`. Incoming shares are
    // already uploaded on the owner's side, so only owned rows wait for
    // the upload to finish.
    sharing: ctx.sharingEnabled && (recipient || settled),
    details: true,
    // Co-owner-only: re-encrypts a copy under the caller's key so a
    // revocation can't take it away. Already-mine rows don't need it.
    fork:
      ctx.sharingEnabled &&
      ctx.forkEnabled &&
      recipient &&
      file.share_role === 'co-owner' &&
      !isDir,
    // Recipients drop only their own access; trashing stays an owner action.
    leave: recipient,
    remove: !ctx.hideDelete && !recipient
  }
}

const separator = (id: string): ContextMenuSeparator => ({ kind: 'separator', id })

/** Joins the non-empty groups with separators. */
function grouped<A extends string>(
  groups: (ContextMenuItem<A> | ContextMenuLabel)[][]
): ContextMenuEntry<A>[] {
  const entries: ContextMenuEntry<A>[] = []
  groups
    .filter((group) => group.length)
    .forEach((group, index) => {
      if (index > 0) entries.push(separator(`separator-${index}`))
      entries.push(...group)
    })
  return entries
}

function item<A extends string>(
  action: A,
  label: string,
  icon: string,
  extra: Partial<ContextMenuItem<A>> = {}
): ContextMenuItem<A> {
  return {
    kind: 'item',
    id: action,
    action,
    label,
    icon,
    testid: `context-menu-${action}`,
    ...extra
  }
}

/** Menu for a single file or folder (right-click on a row). */
export function fileMenuItems(file: AppFile, ctx: FileMenuContext): ContextMenuEntry<FileMenuAction>[] {
  const { t } = ctx
  const can = fileCapabilities(file, ctx)
  const isDir = file.mime === 'dir'
  const open = can.open
    ? [item<FileMenuAction>('open', t('common.open'), isDir ? mdiFolderOpenOutline : mdiOpenInNew)]
    : []

  if (isSyntheticRoot(file)) return open

  return grouped<FileMenuAction>([
    open,
    [
      ...(can.download ? [item<FileMenuAction>('download', t('common.download'), mdiDownload)] : []),
      ...(can.rename
        ? [item<FileMenuAction>('rename', t('common.rename'), mdiPencil, { shortcut: 'F2' })]
        : []),
      ...(can.move
        ? [item<FileMenuAction>('move', t('files.contextMenu.move'), mdiFolderMove)]
        : [])
    ],
    [
      ...(can.sharing
        ? [item<FileMenuAction>('sharing', t('files.actions.sharing'), mdiShareVariantOutline)]
        : []),
      ...(can.fork
        ? [
            item<FileMenuAction>('fork', t('files.actions.fork'), mdiContentSave, {
              title: t('files.actions.forkTitle')
            })
          ]
        : []),
      ...(can.details
        ? [item<FileMenuAction>('details', t('files.actions.details'), mdiInformationOutline)]
        : [])
    ],
    [
      ...(can.leave ? [item<FileMenuAction>('leave', t('common.remove'), mdiAccountArrowLeft)] : []),
      ...(can.remove
        ? [
            item<FileMenuAction>('remove', t('files.delete.trashLabel'), mdiTrashCan, {
              danger: true,
              shortcut: shortcuts(ctx).delete
            })
          ]
        : [])
    ]
  ])
}

/**
 * Menu for a multi-row selection (right-click on a row that is part of it).
 * Mirrors the bulk toolbar in `TableFiles`, plus hiding Move when a
 * reader-only row would make the whole move fail. A selection made only of
 * rows shared with the caller is removed from their drive rather than
 * trashed (`DeleteMultipleModal`'s leave mode), so it reads "Remove" there.
 */
export function selectionMenuItems(
  files: AppFile[],
  ctx: SelectionMenuContext
): ContextMenuEntry<SelectionMenuAction>[] {
  const { t } = ctx
  if (!files.length) return []

  const hasSyntheticRoot = files.some(isSyntheticRoot)
  const hasPendingContent = files.some(isContentPending)
  const allShared = files.every((file) => file.is_owner === false)
  const hasDir = files.some((file) => file.mime === 'dir')
  const canMoveAll = files.every(
    (file) => file.is_owner !== false || canWriteToShared(file)
  )

  const header: ContextMenuLabel = {
    kind: 'label',
    id: 'selection-count',
    label: t('files.browser.selectedCount', { count: files.length }),
    testid: 'context-menu-selection-count'
  }

  // Same split as `downloadMany`: folders in a multi-selection go out as one ZIP.
  const asZip = files.length > 1 && hasDir

  return grouped<SelectionMenuAction>([
    [header],
    [
      ...(!hasPendingContent && !hasSyntheticRoot
        ? [
            item<SelectionMenuAction>(
              'download-many',
              asZip ? t('files.contextMenu.downloadZip') : t('common.download'),
              asZip ? mdiFolderZipOutline : mdiDownloadMultiple
            )
          ]
        : []),
      ...(!hasSyntheticRoot && canMoveAll
        ? [item<SelectionMenuAction>('move-all', t('files.contextMenu.move'), mdiFolderMove)]
        : [])
    ],
    [
      ...(!ctx.hideDelete && !hasSyntheticRoot
        ? [
            allShared
              ? item<SelectionMenuAction>('remove-all', t('common.remove'), mdiAccountArrowLeft, {
                  shortcut: shortcuts(ctx).delete
                })
              : item<SelectionMenuAction>('remove-all', t('files.delete.trashLabel'), mdiTrashCan, {
                  danger: true,
                  shortcut: shortcuts(ctx).delete
                })
          ]
        : [])
    ]
  ])
}

/**
 * Menu for empty space in the listing. Create and upload follow
 * `canCreateHere`. The toolbar still offers New file and Upload files in
 * read-only shared folders, where the server refuses them; this menu
 * doesn't.
 */
export function blankMenuItems(ctx: BlankMenuContext): ContextMenuEntry<BlankMenuAction>[] {
  const { t } = ctx
  const canWrite = canCreateHere(ctx.dir, ctx.parentId)

  return grouped<BlankMenuAction>([
    canWrite
      ? [
          item<BlankMenuAction>('directory', t('files.browser.createDirectory'), mdiFolderPlusOutline),
          item<BlankMenuAction>('file', t('files.browser.newFile'), mdiFileDocumentPlusOutline)
        ]
      : [],
    canWrite
      ? [
          item<BlankMenuAction>('browse', t('files.browser.uploadFiles'), mdiFilePlusOutline),
          item<BlankMenuAction>('browse-folder', t('files.browser.uploadFolder'), mdiFolderArrowUpOutline)
        ]
      : [],
    ctx.canSelectAll
      ? [
          item<BlankMenuAction>('select-all', t('common.selectAll'), mdiCheckAll, {
            shortcut: shortcuts(ctx).selectAll
          })
        ]
      : []
  ])
}
