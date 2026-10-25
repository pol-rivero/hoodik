import Api from '../api'
import * as meta from './meta'
import { emitFileTreeChange } from './events'
import { store as filesStore } from '.'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import type {
  AppFile,
  DeleteManyFiles,
  EncryptedAppFile,
  KeyPair,
  RestoreTrashResponse,
  TrashListResponse
} from 'types'

const DAY_SECONDS = 86400

/** Time the background purge usually needs before stats reflect it. */
const PURGE_SETTLE_MS = 5000

/**
 * Whole days until a trashed item is deleted for good, rounded up so an item
 * with hours left still reads as "in 1 day" until its last day begins. Zero
 * means it goes today.
 *
 * `now` comes from the client clock while both timestamps come from the
 * server, so a client running a few seconds slow would show one day more
 * than the retention period. Passing `trashedAt` caps the count at it.
 */
export function daysUntilPurge(
  purgeAt: number,
  now: number = Date.now() / 1000,
  trashedAt?: number | null
): number {
  const days = Math.max(0, Math.ceil((purgeAt - now) / DAY_SECONDS))
  if (trashedAt == null || purgeAt <= trashedAt) return days
  return Math.min(days, Math.ceil((purgeAt - trashedAt) / DAY_SECONDS))
}

/**
 * The server purges a deleted upload that never finished right away instead of
 * keeping it in trash, since there is nothing in it worth restoring.
 */
export function isUnfinishedUpload(file: Pick<AppFile, 'mime' | 'chunks' | 'finished_upload_at'>) {
  return file.mime !== 'dir' && (file.chunks ?? 0) > 0 && !file.finished_upload_at
}

/**
 * Trash roots the caller owns, newest first. Thumbnails are not served for
 * trashed files, so the compact projection is all the view ever needs.
 */
export async function list(): Promise<EncryptedAppFile[]> {
  const response = await Api.get<TrashListResponse>('/api/storage/trash', { compact: true })
  return response.body?.items ?? []
}

export async function restore(ids: string[]): Promise<RestoreTrashResponse> {
  const response = await Api.post<DeleteManyFiles, RestoreTrashResponse>(
    '/api/storage/trash/restore',
    undefined,
    { ids }
  )

  return {
    restored: response.body?.restored ?? [],
    conflicts: response.body?.conflicts ?? [],
    missing: response.body?.missing ?? []
  }
}

/**
 * Accepted with 202: the items stop being restorable right away and the
 * server frees their bytes in the background.
 */
export async function purge(ids: string[]): Promise<void> {
  await Api.post<DeleteManyFiles, undefined>('/api/storage/trash/purge', undefined, { ids })
}

export async function empty(): Promise<void> {
  await Api.post<undefined, undefined>('/api/storage/trash/empty')
}

export const store = defineStore('trash', () => {
  const items = ref<AppFile[]>([])
  const selected = ref<AppFile[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Bumped by every load and every mutation. A list response that arrives
   * after either is older than what the user now sees and is dropped, so it
   * can't bring back a row that was just restored or purged.
   */
  let generation = 0

  async function decryptItem(item: EncryptedAppFile, kp: KeyPair): Promise<AppFile> {
    const row = { ...item, name: item.id } as AppFile

    try {
      return { ...row, ...(await meta.decrypt(item, kp.wrappingPrivate || (kp.input as string))) }
    } catch {
      // One corrupt key wrap must not hide the rest of the trash; the row
      // stays actionable under its id.
      return row
    }
  }

  async function load(kp: KeyPair): Promise<void> {
    const current = ++generation
    loading.value = true
    error.value = null

    try {
      const rows = await list()
      const decrypted = await Promise.all(rows.map((row) => decryptItem(row, kp)))
      if (current !== generation) return

      items.value = decrypted
      const ids = new Set(decrypted.map((item) => item.id))
      selected.value = selected.value.filter((item) => ids.has(item.id))
    } catch {
      if (current === generation) error.value = 'errors.listFailed'
    } finally {
      if (current === generation) loading.value = false
    }
  }

  function startMutation(): void {
    generation++
    loading.value = false
  }

  function drop(ids: Iterable<string>): void {
    const gone = new Set(ids)
    items.value = items.value.filter((item) => !gone.has(item.id))
    selected.value = selected.value.filter((item) => !gone.has(item.id))
  }

  async function refreshStats(): Promise<void> {
    try {
      await filesStore().loadStats(true)
    } catch {
      // The quota bar catches up on the next write; the trash action itself
      // already succeeded.
    }
  }

  let purgeStatsTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * A purge is accepted before its bytes are freed, so stats fetched right
   * away would still count them. Fetch once the background purge has had
   * time to finish instead.
   */
  function refreshStatsAfterPurge(): void {
    clearTimeout(purgeStatsTimer)
    purgeStatsTimer = setTimeout(() => void refreshStats(), PURGE_SETTLE_MS)
  }

  /**
   * Conflicting items stay listed so the user can rename the blocker and try
   * again. Missing ones are gone from the server's trash already (restored
   * elsewhere, or purged), so keeping them would only offer dead actions; the
   * caller tells the user about them.
   */
  async function restoreItems(files: AppFile[]): Promise<RestoreTrashResponse> {
    const result = await restore(files.map((file) => file.id))
    startMutation()

    drop([...result.restored.map((item) => item.id), ...result.missing])

    const targets = new Set(result.restored.map((item) => item.file_id ?? undefined))
    targets.forEach((folderId) => emitFileTreeChange({ type: 'restored', folderId }))

    return result
  }

  async function purgeItems(files: AppFile[]): Promise<void> {
    await purge(files.map((file) => file.id))
    startMutation()
    drop(files.map((file) => file.id))
    refreshStatsAfterPurge()
  }

  async function emptyTrash(): Promise<void> {
    await empty()
    startMutation()
    items.value = []
    selected.value = []
    refreshStatsAfterPurge()
  }

  function selectOne(select: boolean, file: AppFile): void {
    selected.value = selected.value.filter((item) => item.id !== file.id)
    if (select) selected.value.push(file)
  }

  function selectAll(files: AppFile[]): void {
    selected.value = [...files]
  }

  function deselectAll(): void {
    selected.value = []
  }

  function reset(): void {
    generation++
    clearTimeout(purgeStatsTimer)
    items.value = []
    selected.value = []
    loading.value = false
    error.value = null
  }

  return {
    deselectAll,
    emptyTrash,
    error,
    items,
    load,
    loading,
    purgeItems,
    reset,
    restoreItems,
    selectAll,
    selected,
    selectOne
  }
})
