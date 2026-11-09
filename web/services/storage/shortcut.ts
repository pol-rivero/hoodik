import type { AppFile } from 'types'

/** Mime of a shortcut row: a pointer to another file or folder, no content of its own. */
export const SHORTCUT_MIME = 'shortcut'

export const isShortcut = (file: Pick<AppFile, 'mime'>): boolean => file.mime === SHORTCUT_MIME

/** The target is in the trash, purged, or no longer shared with the caller. */
export const isBrokenShortcut = (file: AppFile): boolean =>
  isShortcut(file) && !file.shortcut_target_mime

export const isFolderShortcut = (file: AppFile): boolean =>
  isShortcut(file) && file.shortcut_target_mime === 'dir'

/** Folders, and shortcuts to folders: what lists group and sort as folders. */
export const isFolderLike = (file: AppFile): boolean =>
  file.mime === 'dir' || isFolderShortcut(file)

/** Rows with content of their own, as opposed to folders and shortcuts. */
export const hasContent = (file: Pick<AppFile, 'mime'>): boolean =>
  file.mime !== 'dir' && !isShortcut(file)
