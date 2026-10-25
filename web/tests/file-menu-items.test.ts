import { describe, expect, it } from 'vitest'
import { i18n } from '../src/i18n'
import {
  blankMenuItems,
  canCreateHere,
  fileMenuItems,
  fileOpenRoute,
  parentFolderRoute,
  selectionMenuItems,
  type BlankMenuContext,
  type FileMenuContext
} from '../src/components/files/browser/fileMenuItems'
import type { ContextMenuEntry } from '../src/composables/useContextMenu'
import { SHARED_WITH_ME_DIR_ID } from '../services/constants'
import type { AppFile } from '../types'

const t = i18n.global.t as FileMenuContext['t']

const ctx = (overrides: Partial<FileMenuContext> = {}): FileMenuContext => ({
  t,
  sharingEnabled: true,
  forkEnabled: true,
  isMac: false,
  ...overrides
})

function row(overrides: Partial<AppFile> = {}): AppFile {
  return {
    id: 'f1',
    name: 'report.pdf',
    mime: 'application/pdf',
    size: 1024,
    is_owner: true,
    finished_upload_at: 1700000000,
    ...overrides
  } as AppFile
}

const folder = (overrides: Partial<AppFile> = {}) =>
  row({ id: 'd1', name: 'Projects', mime: 'dir', size: 0, finished_upload_at: undefined, ...overrides })

/** Actions in order, with separators as '|'. */
const actions = (entries: ContextMenuEntry[]) =>
  entries.map((entry) => (entry.kind === 'separator' ? '|' : (entry.action ?? entry.id)))

describe('fileMenuItems', () => {
  it('gives an owner every action on a finished file', () => {
    const entries = fileMenuItems(row(), ctx())

    expect(actions(entries)).toEqual([
      'open',
      '|',
      'download',
      'rename',
      'move',
      '|',
      'sharing',
      'details',
      '|',
      'remove'
    ])
    const remove = entries.find((e) => e.kind === 'item' && e.action === 'remove')
    expect(remove).toMatchObject({
      label: 'Move to trash',
      danger: true,
      shortcut: 'Del',
      testid: 'context-menu-remove'
    })
    const rename = entries.find((e) => e.kind === 'item' && e.action === 'rename')
    expect(rename).toMatchObject({ shortcut: 'F2' })
  })

  it('opens folders by navigating into them', () => {
    const entries = fileMenuItems(folder(), ctx())

    expect(actions(entries)).toEqual(actions(fileMenuItems(row(), ctx())))
    expect(fileOpenRoute(folder())).toEqual({ name: 'files', params: { file_id: 'd1' } })
  })

  it('routes Open the same way a double click does', () => {
    const note = row({ name: 'todo.md', mime: 'text/markdown' })
    expect(fileOpenRoute(note)).toEqual({ name: 'notes', params: { id: 'f1' } })
    expect(fileOpenRoute({ ...note, is_owner: false, share_role: 'reader' })).toEqual({
      name: 'file-preview',
      params: { id: 'f1' }
    })
    expect(fileOpenRoute({ ...note, is_owner: false, share_role: 'editor' })).toEqual({
      name: 'notes',
      params: { id: 'f1' }
    })
    expect(fileOpenRoute(row())).toEqual({ name: 'file-preview', params: { id: 'f1' } })
  })

  it('leaves Open out when the file has nothing to show, since Details covers it', () => {
    const blob = row({ name: 'data.bin', mime: 'application/octet-stream' })

    expect(fileOpenRoute(blob)).toBeNull()
    expect(actions(fileMenuItems(blob, ctx()))[0]).toBe('download')
  })

  it('offers a reader recipient only read actions and Remove', () => {
    const shared = row({ is_owner: false, share_role: 'reader' })

    expect(actions(fileMenuItems(shared, ctx()))).toEqual([
      'open',
      '|',
      'download',
      '|',
      'sharing',
      'details',
      '|',
      'leave'
    ])
    const leave = fileMenuItems(shared, ctx()).find((e) => e.kind === 'item' && e.action === 'leave')
    expect(leave).toMatchObject({ label: 'Remove' })
    expect(leave).not.toHaveProperty('danger')
  })

  it('lets an editor recipient move but not rename, fork or trash', () => {
    const shared = row({ is_owner: false, share_role: 'editor' })

    expect(actions(fileMenuItems(shared, ctx()))).toEqual([
      'open',
      '|',
      'download',
      'move',
      '|',
      'sharing',
      'details',
      '|',
      'leave'
    ])
  })

  it('offers a co-owner Fork on files only', () => {
    const file = row({ is_owner: false, share_role: 'co-owner' })

    expect(actions(fileMenuItems(file, ctx()))).toContain('fork')
    expect(actions(fileMenuItems(folder({ is_owner: false, share_role: 'co-owner' }), ctx()))).not.toContain(
      'fork'
    )
    expect(actions(fileMenuItems(file, ctx({ forkEnabled: false })))).not.toContain('fork')
  })

  it('gives the synthetic Shared with me root nothing but Open', () => {
    const root = folder({ id: SHARED_WITH_ME_DIR_ID, name: 'Shared with me' })

    expect(actions(fileMenuItems(root, ctx()))).toEqual(['open'])
    expect(fileOpenRoute(root)).toEqual({ name: 'files', params: { file_id: SHARED_WITH_ME_DIR_ID } })
  })

  it('holds back everything that needs the content while an upload is unfinished', () => {
    const uploading = row({ finished_upload_at: undefined })

    expect(actions(fileMenuItems(uploading, ctx()))).toEqual(['move', '|', 'details', '|', 'remove'])
  })

  it('drops Delete when the browser hides it', () => {
    expect(actions(fileMenuItems(row(), ctx({ hideDelete: true })))).not.toContain('remove')
  })

  it('drops Sharing and Fork when sharing is off on the server', () => {
    const off = ctx({ sharingEnabled: false })

    expect(actions(fileMenuItems(row(), off))).not.toContain('sharing')
    expect(actions(fileMenuItems(row({ is_owner: false, share_role: 'co-owner' }), off))).toEqual([
      'open',
      '|',
      'download',
      'move',
      '|',
      'details',
      '|',
      'leave'
    ])
  })

  it('names shortcut keys in the reader\'s language', () => {
    const german: FileMenuContext['t'] = (key, named) =>
      key === 'files.contextMenu.shortcutDelete' ? 'Entf' : t(key, named ?? {})
    const remove = fileMenuItems(row(), ctx({ t: german })).find(
      (e) => e.kind === 'item' && e.action === 'remove'
    )
    expect(remove).toMatchObject({ shortcut: 'Entf' })
  })

  it('uses the macOS spelling of shortcut hints there', () => {
    const remove = fileMenuItems(row(), ctx({ isMac: true })).find(
      (e) => e.kind === 'item' && e.action === 'remove'
    )
    expect(remove).toMatchObject({ shortcut: '⌘⌫' })
  })
})

describe('selectionMenuItems', () => {
  const selCtx = { t, isMac: false }

  it('heads the menu with a disabled count, then download, move and delete', () => {
    const entries = selectionMenuItems([row(), row({ id: 'f2' })], selCtx)

    expect(actions(entries)).toEqual(['selection-count', '|', 'download-many', 'move-all', '|', 'remove-all'])
    expect(entries[0]).toEqual({
      kind: 'label',
      id: 'selection-count',
      label: '2 selected',
      testid: 'context-menu-selection-count'
    })
    expect(entries[2]).toMatchObject({ label: 'Download' })
  })

  it('downloads a selection with folders as one ZIP', () => {
    const entries = selectionMenuItems([row(), folder()], selCtx)

    expect(entries[2]).toMatchObject({ action: 'download-many', label: 'Download as ZIP' })
  })

  it('hides Download while any upload in the selection is unfinished', () => {
    const entries = selectionMenuItems([row(), row({ id: 'f2', finished_upload_at: undefined })], selCtx)

    expect(actions(entries)).toEqual(['selection-count', '|', 'move-all', '|', 'remove-all'])
  })

  it('hides Move when a reader-only row would make the whole move fail', () => {
    const entries = selectionMenuItems([row(), row({ id: 'f2', is_owner: false, share_role: 'reader' })], selCtx)

    expect(actions(entries)).not.toContain('move-all')
  })

  it('offers nothing actionable for the synthetic root', () => {
    const root = folder({ id: SHARED_WITH_ME_DIR_ID })

    expect(actions(selectionMenuItems([row(), root], selCtx))).toEqual(['selection-count'])
  })

  it('reads Remove, not Move to trash, when every row is only shared with the caller', () => {
    const shared = [
      row({ is_owner: false, share_role: 'editor' }),
      row({ id: 'f2', is_owner: false, share_role: 'reader' })
    ]
    const remove = selectionMenuItems(shared, selCtx).at(-1)

    expect(remove).toMatchObject({ action: 'remove-all', label: 'Remove' })
    expect(remove).not.toHaveProperty('danger')

    const mixed = selectionMenuItems([row(), shared[0]], selCtx).at(-1)
    expect(mixed).toMatchObject({ action: 'remove-all', label: 'Move to trash', danger: true })
  })

  it('drops Delete when the browser hides it', () => {
    expect(actions(selectionMenuItems([row(), row({ id: 'f2' })], { ...selCtx, hideDelete: true }))).not.toContain(
      'remove-all'
    )
  })
})

describe('canCreateHere', () => {
  it('allows the root, owned folders and folders shared with a write role', () => {
    expect(canCreateHere(null)).toBe(true)
    expect(canCreateHere(folder())).toBe(true)
    expect(canCreateHere(folder({ is_owner: false, share_role: 'editor' }))).toBe(true)
    expect(canCreateHere(folder({ is_owner: false, share_role: 'co-owner' }))).toBe(true)
  })

  it('refuses read-only shares, the Shared with me root and non-folders', () => {
    expect(canCreateHere(folder({ is_owner: false, share_role: 'reader' }))).toBe(false)
    expect(canCreateHere(null, SHARED_WITH_ME_DIR_ID)).toBe(false)
    expect(canCreateHere(folder({ id: SHARED_WITH_ME_DIR_ID }))).toBe(false)
    expect(canCreateHere(row())).toBe(false)
  })
})

describe('blankMenuItems', () => {
  const blank = (overrides: Partial<BlankMenuContext> = {}) =>
    blankMenuItems({ t, isMac: false, parentId: undefined, dir: null, ...overrides })

  it('offers the four create/upload actions at the root', () => {
    const entries = blank()

    expect(actions(entries)).toEqual(['directory', 'file', '|', 'browse', 'browse-folder'])
    expect(entries.map((e) => (e.kind === 'item' ? e.label : '|'))).toEqual([
      'Create folder',
      'New file',
      '|',
      'Upload files',
      'Upload folder'
    ])
  })

  it('adds Select all only when asked', () => {
    expect(actions(blank({ canSelectAll: true }))).toEqual([
      'directory',
      'file',
      '|',
      'browse',
      'browse-folder',
      '|',
      'select-all'
    ])
    expect(blank({ canSelectAll: true }).at(-1)).toMatchObject({ shortcut: 'Ctrl+A' })
  })

  it('offers nothing to write in the Shared with me root', () => {
    expect(blank({ parentId: SHARED_WITH_ME_DIR_ID })).toEqual([])
    expect(actions(blank({ parentId: SHARED_WITH_ME_DIR_ID, canSelectAll: true }))).toEqual(['select-all'])
  })

  it('offers nothing to write in a folder shared read-only', () => {
    const dir = folder({ is_owner: false, share_role: 'reader' })

    expect(blank({ parentId: dir.id, dir })).toEqual([])
  })

  it('offers every write action in a folder shared with a write role', () => {
    for (const role of ['editor', 'co-owner'] as const) {
      const dir = folder({ is_owner: false, share_role: role })
      expect(actions(blank({ parentId: dir.id, dir }))).toEqual([
        'directory',
        'file',
        '|',
        'browse',
        'browse-folder'
      ])
    }
  })

  it('offers every write action in an owned folder', () => {
    const dir = folder()
    expect(actions(blank({ parentId: dir.id, dir }))).toHaveLength(5)
  })
})

describe('parentFolderRoute', () => {
  it('has nowhere to go from the root', () => {
    expect(parentFolderRoute([])).toBeNull()
  })

  it('leads from a top-level folder to the root', () => {
    expect(parentFolderRoute([folder()])).toEqual({ name: 'files' })
  })

  it('leads to the parent in the chain', () => {
    const parent = folder({ id: 'p1' })
    expect(parentFolderRoute([parent, folder({ file_id: 'p1' })])).toEqual({
      name: 'files',
      params: { file_id: 'p1' }
    })
  })

  it('leads from the top of an incoming share to Shared with me', () => {
    expect(parentFolderRoute([folder({ is_owner: false })])).toEqual({
      name: 'files',
      params: { file_id: SHARED_WITH_ME_DIR_ID }
    })
  })

  it('leads from Shared with me to the root', () => {
    const root = folder({ id: SHARED_WITH_ME_DIR_ID, is_owner: false })
    expect(parentFolderRoute([root])).toEqual({ name: 'files' })
  })
})
