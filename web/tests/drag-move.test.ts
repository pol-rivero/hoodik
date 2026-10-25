import { afterEach, describe, expect, it } from 'vitest'

import {
  FILE_DRAG_MIME,
  canSpringLoadAt,
  currentDragType,
  noteSpringLoad,
  activeDrag,
  beginFileDrag,
  canDropInto,
  endFileDrag,
  isInSharedTree,
  isInternalFileDrag
} from '../services/storage/dragMove'
import type { FileDrag } from '../services/storage/dragMove'
import { SHARED_WITH_ME_DIR_ID } from '../services/storage'

import type { AppFile } from '../types'

function file(id: string, overrides: Partial<AppFile> = {}): AppFile {
  return {
    id,
    user_id: 'me',
    is_owner: true,
    name: `name-${id}`,
    name_hash: '',
    mime: 'text/plain',
    chunks: 1,
    file_id: null,
    file_modified_at: 0,
    created_at: 0,
    is_new: false,
    editable: false,
    active_version: 1,
    encrypted_key: '',
    encrypted_name: '',
    cipher: '',
    ...overrides
  } as AppFile
}

const dir = (id: string, overrides: Partial<AppFile> = {}) =>
  file(id, { mime: 'dir', chunks: 0, ...overrides })

function drag(
  files: AppFile[],
  sourceParent: AppFile | null = null,
  sourceInSharedTree = false
): FileDrag {
  return {
    files,
    ids: new Set(files.map((f) => f.id)),
    sourceParent,
    sourceParentId: sourceParent?.id,
    sourceInSharedTree
  }
}

const ctx = (d: FileDrag | null, targetAncestorIds: string[] = [], extra = {}) => ({
  drag: d,
  targetAncestorIds,
  sharingEnabled: true,
  ...extra
})

describe('canDropInto', () => {
  const home = dir('home')
  const a = file('a', { file_id: 'home' })
  const folder = dir('folder', { file_id: 'home' })
  const other = dir('other', { file_id: 'home' })

  it('accepts a sibling folder', () => {
    expect(canDropInto(other, ctx(drag([a, folder], home), ['home']))).toEqual({ ok: true })
  })

  it('rejects without an active drag', () => {
    expect(canDropInto(other, ctx(null))).toMatchObject({ ok: false, reason: 'no-drag' })
    expect(canDropInto(other, ctx(drag([])))).toMatchObject({ ok: false, reason: 'no-drag' })
  })

  it('rejects dropping onto a dragged folder', () => {
    expect(canDropInto(folder, ctx(drag([a, folder], home), ['home']))).toMatchObject({
      ok: false,
      reason: 'self'
    })
  })

  it('rejects descendants of a dragged folder, at any depth', () => {
    const child = dir('child', { file_id: 'folder' })
    const grandchild = dir('grandchild', { file_id: 'child' })
    const d = drag([folder], home)
    expect(canDropInto(child, ctx(d, ['home', 'folder']))).toMatchObject({
      ok: false,
      reason: 'descendant'
    })
    expect(canDropInto(grandchild, ctx(d, ['home', 'folder', 'child']))).toMatchObject({
      ok: false,
      reason: 'descendant'
    })
  })

  it('rejects the folder the items already live in', () => {
    expect(canDropInto(home, ctx(drag([a, folder], home)))).toMatchObject({
      ok: false,
      reason: 'same-parent'
    })
  })

  it('accepts a mixed-parent drag into one of the parents', () => {
    const elsewhere = file('x', { file_id: 'other' })
    expect(canDropInto(home, ctx(drag([a, elsewhere], home)))).toEqual({ ok: true })
  })

  it('accepts the account root unless the items are already there', () => {
    expect(canDropInto(undefined, ctx(drag([a], home)))).toEqual({ ok: true })
    const atRoot = file('r', { file_id: null })
    expect(canDropInto(undefined, ctx(drag([atRoot], null)))).toMatchObject({
      ok: false,
      reason: 'same-parent'
    })
  })

  it('never accepts the synthetic Shared with me folder', () => {
    const synthetic = dir(SHARED_WITH_ME_DIR_ID, { is_owner: false })
    expect(canDropInto(synthetic, ctx(drag([a], home)))).toMatchObject({
      ok: false,
      reason: 'synthetic-root'
    })
  })

  it('rejects non-folders', () => {
    const target = file('t', { file_id: 'home' })
    expect(canDropInto(target, ctx(drag([a], home)))).toMatchObject({
      ok: false,
      reason: 'not-dir'
    })
  })

  it('rejects a folder shared read-only', () => {
    const readOnly = dir('ro', { is_owner: false, share_role: 'reader' })
    expect(canDropInto(readOnly, ctx(drag([a], home)))).toMatchObject({
      ok: false,
      reason: 'read-only'
    })
  })

  it('accepts owned items into a folder shared with write access', () => {
    for (const role of ['editor', 'co-owner'] as const) {
      const writable = dir(`w-${role}`, { is_owner: false, share_role: role })
      expect(canDropInto(writable, ctx(drag([a], home)))).toEqual({ ok: true })
    }
  })

  it('blocks items the caller does not own from moving into a shared folder', () => {
    const shared = dir('shared', { members_signed_at: 1 })
    const notMine = file('nm', { file_id: 'home', is_owner: false })
    expect(canDropInto(shared, ctx(drag([a, notMine], home)))).toMatchObject({
      ok: false,
      reason: 'blocked'
    })
  })

  it('treats a folder below a share root as shared via the ancestor chain', () => {
    const nested = dir('nested', { file_id: 'shared' })
    const notMine = file('nm', { file_id: 'home', is_owner: false })
    const d = drag([notMine], home)
    expect(canDropInto(nested, ctx(d, ['shared']))).toEqual({ ok: true })
    expect(canDropInto(nested, ctx(d, ['shared'], { targetInSharedTree: true }))).toMatchObject({
      ok: false,
      reason: 'blocked'
    })
  })

  it('blocks non-owned items moving out of a shared folder', () => {
    const sharedSource = dir('src', { is_owner: false, share_role: 'editor' })
    const theirs = file('t', { file_id: 'src', is_owner: false })
    expect(canDropInto(undefined, ctx(drag([theirs], sharedSource)))).toMatchObject({
      ok: false,
      reason: 'blocked'
    })
  })

  it('blocks non-owned items moving out of a subfolder of a share', () => {
    // The source has no signed list of its own; its chain marks it shared.
    const sub = dir('sub', { file_id: 'share-root' })
    const theirs = file('t', { file_id: 'sub', is_owner: false })
    expect(canDropInto(undefined, ctx(drag([theirs], sub)))).toEqual({ ok: true })
    expect(canDropInto(undefined, ctx(drag([theirs], sub, true)))).toMatchObject({
      ok: false,
      reason: 'blocked'
    })
  })

  it('refuses every drop while another move is in flight', () => {
    expect(canDropInto(other, ctx(drag([a], home), ['home'], { moveInFlight: true }))).toMatchObject({
      ok: false,
      reason: 'busy'
    })
  })

  it('ignores share rules when sharing is disabled', () => {
    const shared = dir('shared', { members_signed_at: 1 })
    const notMine = file('nm', { file_id: 'home', is_owner: false })
    expect(
      canDropInto(shared, ctx(drag([notMine], home), [], { sharingEnabled: false }))
    ).toEqual({ ok: true })
  })
})

describe('isInSharedTree', () => {
  it('detects shared and synthetic ancestors', () => {
    expect(isInSharedTree([])).toBe(false)
    expect(isInSharedTree([dir('a'), dir('b')])).toBe(false)
    expect(isInSharedTree([dir('a', { members_signed_at: 5 })])).toBe(true)
    expect(isInSharedTree([dir('a', { is_owner: false })])).toBe(true)
    expect(isInSharedTree([dir(SHARED_WITH_ME_DIR_ID)])).toBe(true)
  })
})

describe('beginFileDrag', () => {
  afterEach(() => endFileDrag())

  function dragEvent(type: string): { event: DragEvent; data: Map<string, string> } {
    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'none',
      setData: (k: string, v: string) => data.set(k, v),
      get types() {
        return [...data.keys()]
      }
    }
    const event = new Event(type, { cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    return { event, data }
  }

  it('marks the drag and stores the payload', () => {
    const home = dir('home')
    const items = [file('a', { file_id: 'home' }), dir(SHARED_WITH_ME_DIR_ID)]
    const { event, data } = dragEvent('dragstart')

    expect(beginFileDrag(event, items, home)).toBe(true)
    const type = currentDragType()!
    expect(type.startsWith(`${FILE_DRAG_MIME}+`)).toBe(true)
    expect(type).toBe(type.toLowerCase())
    expect(data.has(type)).toBe(true)
    expect(event.dataTransfer!.effectAllowed).toBe('move')
    expect(activeDrag.value?.files.map((f) => f.id)).toEqual(['a'])
    expect(activeDrag.value?.sourceParentId).toBe('home')
    expect(activeDrag.value?.sourceInSharedTree).toBe(false)

    const over = dragEvent('dragover')
    over.data.set(type, '')
    expect(isInternalFileDrag(over.event)).toBe(true)
  })

  it('only takes the drag in progress for itself, not another or a stale one', () => {
    beginFileDrag(dragEvent('dragstart').event, [file('a')], null)
    const stale = currentDragType()!
    endFileDrag()
    beginFileDrag(dragEvent('dragstart').event, [file('b')], null)
    expect(currentDragType()).not.toBe(stale)

    for (const type of [stale, FILE_DRAG_MIME, `${FILE_DRAG_MIME}+other`]) {
      const other = dragEvent('dragover')
      other.data.set(type, '')
      expect(isInternalFileDrag(other.event)).toBe(false)
    }
  })

  it('ends on a dragend fired at a source row that left the page', () => {
    const row = document.createElement('div')
    document.body.appendChild(row)
    const { event } = dragEvent('dragstart')
    Object.defineProperty(event, 'target', { value: row })
    beginFileDrag(event, [file('a')], null)
    row.remove()

    row.dispatchEvent(new Event('dragend'))
    expect(activeDrag.value).toBeNull()
    expect(currentDragType()).toBeNull()
  })

  it('ends on a pointer move with no button down, never mid-press', () => {
    beginFileDrag(dragEvent('dragstart').event, [file('a')], null)
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1 }))
    expect(activeDrag.value).not.toBeNull()
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }))
    expect(activeDrag.value).toBeNull()
  })

  it('holds the next spring-load until the pointer moves on', () => {
    beginFileDrag(dragEvent('dragstart').event, [file('a')], null)
    expect(canSpringLoadAt(10, 10)).toBe(true)
    noteSpringLoad({ x: 10, y: 10 })
    expect(canSpringLoadAt(11, 10)).toBe(false)
    expect(canSpringLoadAt(10, 25)).toBe(true)
    endFileDrag()
    expect(canSpringLoadAt(11, 10)).toBe(true)
  })

  it('marks a source inside a shared tree from its chain', () => {
    const root = dir('root', { members_signed_at: 1 })
    const sub = dir('sub', { file_id: 'root' })
    beginFileDrag(dragEvent('dragstart').event, [file('a', { file_id: 'sub' })], sub, [root, sub])
    expect(activeDrag.value?.sourceInSharedTree).toBe(true)
  })

  it('cancels a drag of nothing movable', () => {
    const { event } = dragEvent('dragstart')
    expect(beginFileDrag(event, [dir(SHARED_WITH_ME_DIR_ID)], null)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(activeDrag.value).toBeNull()
  })

  it('does not treat OS file drags as internal', () => {
    beginFileDrag(dragEvent('dragstart').event, [file('a')], null)
    const os = dragEvent('dragover')
    os.data.set('Files', '')
    expect(isInternalFileDrag(os.event)).toBe(false)
  })

  it('survives window blur (Firefox on GTK fires it at drag start)', () => {
    beginFileDrag(dragEvent('dragstart').event, [file('a')], null)
    window.dispatchEvent(new Event('blur'))
    expect(activeDrag.value).not.toBeNull()
  })

  it('clears on dragend, Escape and mousedown', () => {
    for (const end of [
      () => window.dispatchEvent(new Event('dragend')),
      () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      () => window.dispatchEvent(new MouseEvent('mousedown'))
    ]) {
      beginFileDrag(dragEvent('dragstart').event, [file('a')], null)
      expect(activeDrag.value).not.toBeNull()
      end()
      expect(activeDrag.value).toBeNull()
    }
  })
})
