import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { moveFiles, moveInFlight } from '../services/storage/moveFiles'
import { MovePartiallyFailed } from '../services/storage/moveInto'
import type { MoveFilesDeps } from '../services/storage/moveFiles'
import * as events from '../services/storage/events'
import {
  moveConfirmState,
  registerMoveConfirmHost,
  requestMoveConfirm,
  resolveMoveConfirm
} from '../services/storage/moveConfirm'

import type { AppFile, KeyPair } from '../types'

const KEYPAIR = { input: 'priv', publicKey: 'pub' } as KeyPair

function file(id: string, overrides: Partial<AppFile> = {}): AppFile {
  return {
    id,
    user_id: 'me',
    is_owner: true,
    name: `name-${id}`,
    mime: 'text/plain',
    file_id: 'home',
    ...overrides
  } as AppFile
}

const dir = (id: string, overrides: Partial<AppFile> = {}) => file(id, { mime: 'dir', ...overrides })

function storage(currentDirId: string | undefined, rosterId?: string) {
  return {
    currentDirId,
    moveAll: vi.fn(async () => {}),
    find: vi.fn(async () => {}),
    removeItem: vi.fn(),
    writeRosterId: vi.fn<(id: string) => Promise<string | undefined>>(async () => rosterId)
  }
}

function deps(Storage: ReturnType<typeof storage>, extra: Partial<MoveFilesDeps> = {}): MoveFilesDeps {
  return {
    Storage: Storage as unknown as MoveFilesDeps['Storage'],
    keypair: KEYPAIR,
    callerUserId: 'me',
    sharingEnabled: true,
    ...extra
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('moveFiles', () => {
  const home = dir('home', { file_id: null })

  it('routes a private move through Storage.moveAll', async () => {
    const Storage = storage('home')
    const target = dir('target')
    const sources = [file('a'), dir('b')]

    const outcome = await moveFiles({ sources, destination: target, sourceParent: home }, deps(Storage))

    expect(outcome).toEqual({ status: 'moved', moved: 2, kind: 'plain' })
    expect(Storage.moveAll).toHaveBeenCalledWith(KEYPAIR, sources, 'target', 'home')
    // moveAll refreshes the listing and the tree itself.
    expect(Storage.find).not.toHaveBeenCalled()
  })

  it('moves to the account root with an undefined destination', async () => {
    const Storage = storage('home')
    await moveFiles({ sources: [file('a')], destination: undefined, sourceParent: home }, deps(Storage))
    expect(Storage.moveAll).toHaveBeenCalledWith(KEYPAIR, [file('a')], undefined, 'home')
    expect(Storage.writeRosterId).toHaveBeenCalledTimes(1)
    expect(Storage.writeRosterId).toHaveBeenCalledWith('home')
  })

  it('routes into a shared tree with the resolved roster, then refreshes', async () => {
    const Storage = storage('home')
    Storage.writeRosterId.mockImplementation(async (id: string) =>
      id === 'nested' ? 'share-root' : undefined
    )
    const emit = vi.spyOn(events, 'emitFileTreeChange')
    const execute = vi.fn(async () => ({ moved: 1, movedIds: ['a'] }))
    const target = dir('nested', { file_id: 'share-root' })

    const outcome = await moveFiles(
      { sources: [file('a')], destination: target, sourceParent: home },
      deps(Storage, { execute })
    )

    expect(outcome).toEqual({ status: 'moved', moved: 1, kind: 'into-shared' })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'into-shared',
        destinationFolderId: 'nested',
        rosterFolderId: 'share-root'
      }),
      expect.anything()
    )
    expect(Storage.moveAll).not.toHaveBeenCalled()
    expect(Storage.removeItem).toHaveBeenCalledWith('a')
    expect(Storage.find).toHaveBeenCalledWith(KEYPAIR, 'home', false)
    expect(emit).toHaveBeenCalledWith({ type: 'moved', folderId: 'home', targetFolderId: 'nested' })
  })

  it('routes owned items out of a shared folder', async () => {
    const Storage = storage('shared')
    const execute = vi.fn(async () => ({ moved: 1, movedIds: ['a'] }))
    const sharedParent = dir('shared', { members_signed_at: 1 })

    const outcome = await moveFiles(
      { sources: [file('a', { file_id: 'shared' })], destination: undefined, sourceParent: sharedParent },
      deps(Storage, { execute })
    )

    expect(outcome).toMatchObject({ status: 'moved', kind: 'move-out' })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'move-out', destinationId: undefined }),
      expect.anything()
    )
    expect(Storage.find).toHaveBeenCalledWith(KEYPAIR, 'shared', false)
  })

  it('returns blocked without executing', async () => {
    const Storage = storage('home', 'shared')
    const execute = vi.fn()

    const outcome = await moveFiles(
      { sources: [file('a', { is_owner: false })], destination: dir('shared'), sourceParent: home },
      deps(Storage, { execute })
    )

    expect(outcome.status).toBe('blocked')
    expect(execute).not.toHaveBeenCalled()
  })

  it('routes a move out of a subfolder of a share as move-out, not plain', async () => {
    // `sub` has no signed list of its own; its roster resolves to the share root.
    const Storage = storage('sub')
    Storage.writeRosterId.mockImplementation(async (id: string) =>
      id === 'sub' ? 'share-root' : undefined
    )
    const execute = vi.fn(async () => ({ moved: 1, movedIds: ['a'] }))
    const sub = dir('sub', { file_id: 'share-root' })

    const outcome = await moveFiles(
      { sources: [file('a', { file_id: 'sub' })], destination: dir('private'), sourceParent: sub },
      deps(Storage, { execute })
    )

    expect(outcome).toMatchObject({ status: 'moved', kind: 'move-out' })
    expect(Storage.moveAll).not.toHaveBeenCalled()
  })

  it('refreshes for the items moved before a declined confirmation', async () => {
    const Storage = storage('home', 'shared')
    const emit = vi.spyOn(events, 'emitFileTreeChange')
    const execute = vi.fn(async () => ({ moved: 1, movedIds: ['x'], aborted: true }))

    const outcome = await moveFiles(
      { sources: [dir('x'), dir('y')], destination: dir('shared'), sourceParent: home },
      deps(Storage, { execute })
    )

    expect(outcome).toEqual({ status: 'moved', moved: 1, kind: 'into-shared', partial: true })
    expect(Storage.removeItem).toHaveBeenCalledTimes(1)
    expect(Storage.removeItem).toHaveBeenCalledWith('x')
    expect(Storage.find).toHaveBeenCalledWith(KEYPAIR, 'home', false)
    expect(emit).toHaveBeenCalledWith({ type: 'moved', folderId: 'home', targetFolderId: 'shared' })
  })

  it('refreshes for the items moved before a failure, then rethrows the cause', async () => {
    const Storage = storage('home', 'shared')
    const cause = new Error('network')
    const execute = vi.fn(async () => {
      throw new MovePartiallyFailed(['x'], cause)
    })

    await expect(
      moveFiles(
        { sources: [dir('x'), dir('y')], destination: dir('shared'), sourceParent: home },
        deps(Storage, { execute })
      )
    ).rejects.toBe(cause)
    expect(Storage.removeItem).toHaveBeenCalledWith('x')
    expect(Storage.find).toHaveBeenCalled()
  })

  it('refuses a second move while one is in flight', async () => {
    const Storage = storage('home', 'shared')
    let release!: () => void
    const execute = vi.fn(
      () => new Promise<{ moved: number; movedIds: string[] }>((resolve) => {
        release = () => resolve({ moved: 1, movedIds: ['a'] })
      })
    )
    const first = moveFiles(
      { sources: [file('a')], destination: dir('shared'), sourceParent: home },
      deps(Storage, { execute })
    )
    await vi.waitFor(() => expect(execute).toHaveBeenCalled())
    expect(moveInFlight.value).toBe(true)

    await expect(
      moveFiles({ sources: [file('b')], destination: dir('t'), sourceParent: home }, deps(Storage))
    ).resolves.toEqual({ status: 'busy' })

    release()
    await expect(first).resolves.toMatchObject({ status: 'moved' })
    expect(moveInFlight.value).toBe(false)
  })

  it('reports a declined confirmation as cancelled and refreshes nothing', async () => {
    const Storage = storage('home', 'shared')
    const execute = vi.fn(async () => ({ moved: 0, movedIds: [], aborted: true }))

    const outcome = await moveFiles(
      { sources: [dir('a')], destination: dir('shared'), sourceParent: home },
      deps(Storage, { execute })
    )

    expect(outcome).toEqual({ status: 'cancelled' })
    expect(Storage.find).not.toHaveBeenCalled()
    expect(Storage.removeItem).not.toHaveBeenCalled()
  })

  it('treats sharing as off when the capability is disabled', async () => {
    const Storage = storage('home', 'shared')
    await moveFiles(
      { sources: [file('a', { is_owner: false })], destination: dir('shared'), sourceParent: home },
      deps(Storage, { sharingEnabled: false })
    )
    expect(Storage.moveAll).toHaveBeenCalled()
  })

  it('propagates execution errors', async () => {
    const Storage = storage('home')
    Storage.moveAll.mockRejectedValueOnce(new Error('boom'))
    await expect(
      moveFiles({ sources: [file('a')], destination: dir('t'), sourceParent: home }, deps(Storage))
    ).rejects.toThrow('boom')
  })
})

describe('move confirmation host', () => {
  it('declines immediately when no host is mounted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      requestMoveConfirm({ folderName: 'f', destinationName: 'd', itemCount: 1, memberLabels: [] })
    ).resolves.toBe(false)
  })

  it('shows the prompt and resolves with the answer', async () => {
    const unregister = registerMoveConfirmHost()
    const answer = requestMoveConfirm({
      folderName: 'f',
      destinationName: 'd',
      itemCount: 3,
      memberLabels: ['bob']
    })
    expect(moveConfirmState).toMatchObject({ visible: true, folderName: 'f', itemCount: 3 })
    resolveMoveConfirm(true)
    await expect(answer).resolves.toBe(true)
    expect(moveConfirmState.visible).toBe(false)

    const pending = requestMoveConfirm({ folderName: 'g', destinationName: 'd', itemCount: 1, memberLabels: [] })
    unregister()
    await expect(pending).resolves.toBe(false)
  })
})
