import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('../services/shares', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/shares')>()
  return {
    ...actual,
    moveIntoSharedFolder: vi.fn(),
    moveSingleFileIntoSharedFolder: vi.fn(),
    moveOutOfSharedFolder: vi.fn()
  }
})

import {
  UploadIntoSharedFolderAborted,
  moveIntoSharedFolder,
  moveOutOfSharedFolder,
  moveSingleFileIntoSharedFolder
} from '../services/shares'
import { MovePartiallyFailed, executeMove } from '../services/storage/moveInto'
import type { MoveDecision } from '../services/storage/moveInto'
import {
  moveConfirmState,
  registerMoveConfirmHost,
  requestMoveConfirm,
  resolveMoveConfirm
} from '../services/storage/moveConfirm'
import { store as storageStore } from '../services/storage'
import { moveFilesInteractive } from '../src/composables/useMoveFiles'
import MoveConfirmHost from '../src/components/files/modals/MoveConfirmHost.vue'
import { installCapabilities } from './helpers/capabilities'

import type { AppFile, FolderMember, KeyPair } from '../types'

const KEYPAIR = { input: 'priv', publicKey: 'pub' } as KeyPair
const ME = 'me'
const MEMBERS = [
  { user_id: ME, email: 'me@example.com' },
  { user_id: 'bob', email: 'bob@example.com' }
] as FolderMember[]

const file = (id: string, overrides: Partial<AppFile> = {}) =>
  ({ id, name: id, mime: 'text/plain', is_owner: true, file_id: 'home', ...overrides }) as AppFile
const dir = (id: string, overrides: Partial<AppFile> = {}) => file(id, { mime: 'dir', ...overrides })

const intoShared = (sources: AppFile[]): MoveDecision => ({
  kind: 'into-shared',
  sources,
  destinationFolderId: 'shared'
})

type ConfirmOpt = { confirm?: (p: { itemCount: number; members: FolderMember[] }) => Promise<boolean> }

/** Stand-in for the single-file path: runs its confirm gate like the real one. */
function singleFileHonoursConfirm() {
  vi.mocked(moveSingleFileIntoSharedFolder).mockImplementation(async (_args, options) => {
    const confirm = (options as ConfirmOpt | undefined)?.confirm
    if (confirm && !(await confirm({ itemCount: 0, members: MEMBERS }))) {
      throw new UploadIntoSharedFolderAborted()
    }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(moveIntoSharedFolder).mockReset()
  vi.mocked(moveSingleFileIntoSharedFolder).mockReset()
  vi.mocked(moveOutOfSharedFolder).mockReset()
})

afterEach(() => {
  resolveMoveConfirm(false)
  vi.restoreAllMocks()
})

describe('executeMove partial batches', () => {
  const deps = { callerUserId: ME, keypair: KEYPAIR, plainMove: vi.fn() }

  it('reports the folders moved before a declined cascade confirmation', async () => {
    vi.mocked(moveIntoSharedFolder)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new UploadIntoSharedFolderAborted())

    const result = await executeMove(intoShared([dir('x'), dir('y'), dir('z')]), deps)

    expect(result).toEqual({ moved: 1, movedIds: ['x'], aborted: true })
    expect(moveIntoSharedFolder).toHaveBeenCalledTimes(2)
  })

  it('wraps a failure after some items moved', async () => {
    const cause = new Error('boom')
    vi.mocked(moveOutOfSharedFolder).mockResolvedValueOnce(undefined).mockRejectedValueOnce(cause)

    const err = await executeMove(
      { kind: 'move-out', sources: [file('a'), file('b')], destinationId: undefined },
      deps
    ).catch((e) => e)

    expect(err).toBeInstanceOf(MovePartiallyFailed)
    expect(err.movedIds).toEqual(['a'])
    expect(err.cause).toBe(cause)
  })

  it('rethrows a failure on the first item unchanged', async () => {
    const cause = new Error('boom')
    vi.mocked(moveOutOfSharedFolder).mockRejectedValueOnce(cause)
    await expect(
      executeMove({ kind: 'move-out', sources: [file('a')], destinationId: undefined }, deps)
    ).rejects.toBe(cause)
  })

  it('asks once for all plain files, after the roster verified', async () => {
    singleFileHonoursConfirm()
    const confirmFiles = vi.fn(async () => true)
    const files = [file('a'), file('b')]

    const result = await executeMove(intoShared([...files, dir('d')]), { ...deps, confirmFiles })

    expect(result).toEqual({ moved: 3, movedIds: ['a', 'b', 'd'] })
    expect(confirmFiles).toHaveBeenCalledTimes(1)
    expect(confirmFiles).toHaveBeenCalledWith(files, { itemCount: 0, members: MEMBERS })
  })

  it('moves no file when the file confirmation is declined', async () => {
    singleFileHonoursConfirm()
    const result = await executeMove(intoShared([file('a'), file('b')]), {
      ...deps,
      confirmFiles: async () => false
    })
    expect(result).toEqual({ moved: 0, movedIds: [], aborted: true })
    expect(moveSingleFileIntoSharedFolder).toHaveBeenCalledTimes(1)
  })
})

describe('moveFilesInteractive into a shared folder', () => {
  function setup() {
    installCapabilities({ sharing: { enabled: true, roles: [] } })
    const Storage = storageStore()
    vi.spyOn(Storage, 'writeRosterId').mockImplementation(async (id) =>
      id === 'shared' ? 'shared' : undefined
    )
    vi.spyOn(Storage, 'find').mockResolvedValue()
    singleFileHonoursConfirm()
    return Storage
  }

  const run = (confirmFileShares: boolean) =>
    moveFilesInteractive([file('report.pdf')], dir('shared', { name: 'Team' }), {
      sourceParent: dir('home'),
      keypair: KEYPAIR,
      callerUserId: ME,
      confirmFileShares
    })

  it('drag and drop confirms before sharing a single file, naming the members', async () => {
    setup()
    const unregister = registerMoveConfirmHost()

    const pending = run(true)
    await vi.waitFor(() => expect(moveConfirmState.visible).toBe(true))
    expect(moveConfirmState).toMatchObject({
      fileCount: 1,
      folderName: 'report.pdf',
      destinationName: 'Team',
      memberLabels: ['bob@example.com']
    })
    resolveMoveConfirm(true)

    await expect(pending).resolves.toMatchObject({ status: 'moved', kind: 'into-shared' })
    unregister()
  })

  it('a declined drag confirmation moves nothing', async () => {
    setup()
    const unregister = registerMoveConfirmHost()
    const pending = run(true)
    await vi.waitFor(() => expect(moveConfirmState.visible).toBe(true))
    resolveMoveConfirm(false)
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    unregister()
  })

  it('the picker keeps moving files in unprompted', async () => {
    setup()
    await expect(run(false)).resolves.toMatchObject({ status: 'moved' })
    expect(moveConfirmState.visible).toBe(false)
  })
})

describe('MoveConfirmHost', () => {
  async function prompt() {
    const wrapper = mount(MoveConfirmHost, { attachTo: document.body })
    const answer = requestMoveConfirm({
      folderName: 'f',
      destinationName: 'Team',
      itemCount: 2,
      memberLabels: ['bob']
    })
    await flushPromises()
    return { wrapper, answer }
  }

  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!

  it('resolves true on confirm, although the modal reports itself hidden first', async () => {
    const { wrapper, answer } = await prompt()
    button('Move and share').click()
    await expect(answer).resolves.toBe(true)
    wrapper.unmount()
  })

  it('resolves false on cancel', async () => {
    const { wrapper, answer } = await prompt()
    button('Cancel').click()
    await expect(answer).resolves.toBe(false)
    wrapper.unmount()
  })

  it('resolves false when unmounted with a prompt open', async () => {
    const { wrapper, answer } = await prompt()
    wrapper.unmount()
    await expect(answer).resolves.toBe(false)
  })
})
