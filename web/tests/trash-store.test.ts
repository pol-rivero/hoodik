import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import Api from '../services/api'
import * as meta from '../services/storage/meta'
import { onFileTreeChange } from '../services/storage/events'
import { store as storageStore } from '../services/storage'
import {
  store as trashStore,
  daysUntilPurge,
  isUnfinishedUpload
} from '../services/storage/trash'

import type { AppFile, EncryptedAppFile, KeyPair, RestoreTrashResponse } from '../types'

const KEYPAIR = { input: 'private-key' } as KeyPair
const NOW = 1_800_000_000

function trashed(id: string, trashedAt: number, overrides: Partial<EncryptedAppFile> = {}) {
  return {
    id,
    user_id: 'owner',
    is_owner: true,
    name_hash: `hash-${id}`,
    mime: 'text/plain',
    size: 10,
    chunks: 1,
    file_id: null,
    file_modified_at: trashedAt,
    created_at: trashedAt,
    is_new: false,
    editable: false,
    active_version: 1,
    encrypted_key: `key-${id}`,
    encrypted_name: `enc-${id}`,
    cipher: 'aegis128l',
    trashed_at: trashedAt,
    trash_root_id: id,
    purge_at: trashedAt + 30 * 86400,
    ...overrides
  } as EncryptedAppFile
}

function apiResponse<T>(body: T) {
  return { status: 200, body } as never
}

let statsSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setActivePinia(createPinia())
  statsSpy = vi.spyOn(meta, 'stats').mockResolvedValue({ stats: [], used_space: 0 })
  vi.spyOn(meta, 'decrypt').mockImplementation(async (file) => ({
    name: `plain-${(file as EncryptedAppFile).encrypted_name}`
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function loadedStore(items: EncryptedAppFile[]) {
  vi.spyOn(Api, 'get').mockResolvedValue(apiResponse({ items }))
  const store = trashStore()
  await store.load(KEYPAIR)
  return store
}

describe('trash store: load', () => {
  it('lists compact trash roots, decrypts them and keeps the server order', async () => {
    const get = vi.spyOn(Api, 'get').mockResolvedValue(
      apiResponse({ items: [trashed('b', NOW - 10), trashed('a', NOW - 100)] })
    )

    const store = trashStore()
    await store.load(KEYPAIR)

    expect(get).toHaveBeenCalledWith('/api/storage/trash', { compact: true })
    expect(store.items.map((item) => item.id)).toEqual(['b', 'a'])
    expect(store.items.map((item) => item.name)).toEqual(['plain-enc-b', 'plain-enc-a'])
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('keeps a row whose key fails to unwrap, named by its id', async () => {
    vi.mocked(meta.decrypt).mockRejectedValueOnce(new Error('bad wrap'))
    const store = await loadedStore([trashed('a', NOW)])

    expect(store.items).toHaveLength(1)
    expect(store.items[0].name).toBe('a')
  })

  it('records an error when the list request fails', async () => {
    vi.spyOn(Api, 'get').mockRejectedValue(new Error('offline'))

    const store = trashStore()
    await store.load(KEYPAIR)

    expect(store.error).toBe('errors.listFailed')
    expect(store.items).toEqual([])
    expect(store.loading).toBe(false)
  })
})

describe('trash store: restore', () => {
  it('drops restored and missing items, keeps conflicts, and refreshes the tree', async () => {
    const store = await loadedStore([
      trashed('a', NOW - 1),
      trashed('b', NOW - 2),
      trashed('c', NOW - 3),
      trashed('d', NOW - 4),
      trashed('e', NOW - 5)
    ])
    store.selectAll(store.items)

    const response: RestoreTrashResponse = {
      restored: [
        { id: 'a', file_id: 'folder-1', relocated: false },
        { id: 'b', file_id: 'folder-1', relocated: false },
        { id: 'c', file_id: null, relocated: true }
      ],
      conflicts: ['d'],
      missing: ['e']
    }
    const post = vi.spyOn(Api, 'post').mockResolvedValue(apiResponse(response))

    const events: Array<{ type: string; folderId?: string }> = []
    const unsubscribe = onFileTreeChange((event) => events.push(event))
    statsSpy.mockClear()

    const result = await store.restoreItems(store.items as AppFile[])
    unsubscribe()

    expect(post).toHaveBeenCalledWith('/api/storage/trash/restore', undefined, {
      ids: ['a', 'b', 'c', 'd', 'e']
    })
    expect(result).toEqual(response)
    expect(store.items.map((item) => item.id)).toEqual(['d'])
    expect(store.selected.map((item) => item.id)).toEqual(['d'])

    expect(events).toHaveLength(2)
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'restored', folderId: 'folder-1' },
        { type: 'restored', folderId: undefined }
      ])
    )
    // Trashed bytes count toward usage the same as active ones.
    expect(statsSpy).not.toHaveBeenCalled()
  })

  it('leaves the list untouched when the request fails', async () => {
    const store = await loadedStore([trashed('a', NOW)])
    vi.spyOn(Api, 'post').mockRejectedValue(new Error('boom'))

    await expect(store.restoreItems(store.items as AppFile[])).rejects.toThrow('boom')
    expect(store.items.map((item) => item.id)).toEqual(['a'])
  })
})

describe('trash store: purge and empty', () => {
  async function storeWithStats(items: EncryptedAppFile[]) {
    const store = await loadedStore(items)
    statsSpy.mockResolvedValue({ stats: [], used_space: 1000 })
    await storageStore().loadStats(true)
    statsSpy.mockClear()
    return store
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('purge drops the items and refetches stats once the purge has settled', async () => {
    vi.useFakeTimers()
    const store = await storeWithStats([
      trashed('a', NOW, { size: 100 }),
      trashed('b', NOW - 1, { size: 50 }),
      trashed('dir', NOW - 2, { mime: 'dir', size: undefined })
    ])
    store.selectAll(store.items)
    const post = vi.spyOn(Api, 'post').mockResolvedValue({ status: 202, body: undefined } as never)

    await store.purgeItems([store.items[0], store.items[2]])

    expect(post).toHaveBeenCalledWith('/api/storage/trash/purge', undefined, { ids: ['a', 'dir'] })
    expect(store.items.map((item) => item.id)).toEqual(['b'])
    expect(store.selected.map((item) => item.id)).toEqual(['b'])
    // The 202 lands before the background purge frees anything; refetching
    // straight away would bring the old totals back.
    expect(statsSpy).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(statsSpy).toHaveBeenCalledTimes(1)
  })

  it('empty clears every item and refetches stats once the purge has settled', async () => {
    vi.useFakeTimers()
    const store = await storeWithStats([trashed('a', NOW), trashed('b', NOW - 1)])
    const post = vi.spyOn(Api, 'post').mockResolvedValue({ status: 202, body: undefined } as never)

    await store.emptyTrash()

    expect(post).toHaveBeenCalledWith('/api/storage/trash/empty')
    expect(store.items).toEqual([])
    expect(store.selected).toEqual([])

    expect(statsSpy).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(statsSpy).toHaveBeenCalledTimes(1)
  })

  it('purge keeps the items when the request fails', async () => {
    const store = await loadedStore([trashed('a', NOW)])
    vi.spyOn(Api, 'post').mockRejectedValue(new Error('boom'))

    await expect(store.purgeItems(store.items as AppFile[])).rejects.toThrow('boom')
    expect(store.items).toHaveLength(1)
  })
})

describe('trash store: stale list responses', () => {
  it('drops a list response that started before a purge', async () => {
    const store = await loadedStore([trashed('a', NOW), trashed('b', NOW - 1)])

    let answer: (value: unknown) => void = () => {}
    vi.spyOn(Api, 'get').mockReturnValue(new Promise((resolve) => (answer = resolve)) as never)
    const reload = store.load(KEYPAIR)

    vi.spyOn(Api, 'post').mockResolvedValue({ status: 202, body: undefined } as never)
    await store.purgeItems([store.items[0]])

    answer({ status: 200, body: { items: [trashed('a', NOW), trashed('b', NOW - 1)] } })
    await reload

    expect(store.items.map((item) => item.id)).toEqual(['b'])
    expect(store.loading).toBe(false)
  })

  it('keeps the rows on a failed reload and reports the error', async () => {
    const store = await loadedStore([trashed('a', NOW)])
    vi.spyOn(Api, 'get').mockRejectedValue(new Error('offline'))

    await store.load(KEYPAIR)

    expect(store.items.map((item) => item.id)).toEqual(['a'])
    expect(store.error).toBe('errors.listFailed')
  })
})

describe('daysUntilPurge', () => {
  it('rounds partial days up', () => {
    expect(daysUntilPurge(NOW + 30 * 86400, NOW)).toBe(30)
    expect(daysUntilPurge(NOW + 29 * 86400 + 1, NOW)).toBe(30)
    expect(daysUntilPurge(NOW + 3600, NOW)).toBe(1)
  })

  it('reaches zero on the purge day and never goes negative', () => {
    expect(daysUntilPurge(NOW, NOW)).toBe(0)
    expect(daysUntilPurge(NOW - 5 * 86400, NOW)).toBe(0)
    expect(daysUntilPurge(0, NOW)).toBe(0)
  })

  it('never exceeds the retention period when the client clock runs slow', () => {
    const trashedAt = NOW
    const purgeAt = trashedAt + 30 * 86400
    expect(daysUntilPurge(purgeAt, trashedAt - 5)).toBe(31)
    expect(daysUntilPurge(purgeAt, trashedAt - 5, trashedAt)).toBe(30)
  })
})

describe('isUnfinishedUpload', () => {
  it('matches only files with chunks and no finished upload', () => {
    expect(isUnfinishedUpload({ mime: 'text/plain', chunks: 2, finished_upload_at: undefined })).toBe(
      true
    )
    expect(isUnfinishedUpload({ mime: 'text/plain', chunks: 2, finished_upload_at: 1 })).toBe(false)
    expect(isUnfinishedUpload({ mime: 'text/plain', chunks: 0, finished_upload_at: undefined })).toBe(
      false
    )
    expect(isUnfinishedUpload({ mime: 'dir', chunks: 0, finished_upload_at: undefined })).toBe(false)
  })
})
