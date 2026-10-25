import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'

import TrashTable from '../src/views/trash/TrashTable.vue'
import Api from '../services/api'
import * as meta from '../services/storage/meta'
import * as notify from '../services/notify'
import { store as trashStore } from '../services/storage/trash'

import type { EncryptedAppFile, KeyPair } from '../types'

const KEYPAIR = { input: 'private-key' } as KeyPair
const NOW = Math.floor(Date.now() / 1000)

function trashed(id: string, overrides: Partial<EncryptedAppFile> = {}) {
  return {
    id,
    user_id: 'owner',
    is_owner: true,
    name_hash: `hash-${id}`,
    mime: 'text/plain',
    size: 2048,
    chunks: 1,
    file_id: null,
    file_modified_at: NOW,
    created_at: NOW,
    is_new: false,
    editable: false,
    active_version: 1,
    encrypted_key: 'key',
    encrypted_name: id,
    cipher: 'aegis128l',
    trashed_at: NOW - 120,
    trash_root_id: id,
    purge_at: NOW + 30 * 86400,
    ...overrides
  } as EncryptedAppFile
}

function openDialog(wrapper: ReturnType<typeof mount>) {
  const open = wrapper.findAll('[role="dialog"]').filter((dialog) => dialog.isVisible())
  expect(open).toHaveLength(1)
  return open[0]
}

function buttonIn(dialog: ReturnType<ReturnType<typeof mount>['get']>, label: string) {
  const button = dialog.findAll('button').find((b) => b.text().trim() === label)
  if (!button) throw new Error(`no "${label}" button`)
  return button
}

async function mountWith(items: EncryptedAppFile[]) {
  vi.spyOn(Api, 'get').mockResolvedValue({ status: 200, body: { items } } as never)
  const wrapper = mount(TrashTable, {
    props: { kp: KEYPAIR },
    global: { stubs: { RouterLink: true } }
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(meta, 'decrypt').mockImplementation(async (file) => ({
    name: (file as EncryptedAppFile).encrypted_name
  }))
  vi.spyOn(meta, 'stats').mockResolvedValue({ stats: [], used_space: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TrashTable', () => {
  it('shows the empty state when nothing is in trash', async () => {
    const wrapper = await mountWith([])

    expect(wrapper.get('[data-testid="trash-empty-state"]').text()).toBe('Trash is empty')
    expect(wrapper.get('[data-testid="trash-empty"]').attributes('disabled')).toBeDefined()
  })

  it('shows an error with a retry when the list fails', async () => {
    vi.spyOn(Api, 'get').mockRejectedValue(new Error('offline'))
    const wrapper = mount(TrashTable, { props: { kp: KEYPAIR } })
    await flushPromises()

    expect(wrapper.find('[data-testid="trash-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trash-empty-state"]').exists()).toBe(false)
  })

  it('renders a row per item with size, deletion time and days left', async () => {
    const wrapper = await mountWith([
      trashed('notes.txt'),
      trashed('Old', { mime: 'dir', size: undefined, purge_at: NOW + 3600 })
    ])

    const file = wrapper.get('[data-testid="trash-row-notes.txt"]')
    expect(file.text()).toContain('2 KB')
    expect(file.text()).toContain('2 minutes ago')
    expect(file.get('[data-testid="trash-expires"]').text()).toBe('in 30 days')

    const folder = wrapper.get('[data-testid="trash-row-Old"]')
    expect(folder.text()).toContain('—')
    expect(folder.get('[data-testid="trash-expires"]').text()).toBe('in 1 day')
  })

  it('says today once the last day has started', async () => {
    const wrapper = await mountWith([trashed('soon', { purge_at: NOW - 1 })])
    expect(wrapper.get('[data-testid="trash-expires"]').text()).toBe('today')
  })

  it('restores the selection and reports conflicts and a relocation', async () => {
    const wrapper = await mountWith([trashed('a'), trashed('b'), trashed('c')])
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    const post = vi.spyOn(Api, 'post').mockResolvedValue({
      status: 200,
      body: {
        restored: [{ id: 'a', file_id: null, relocated: true }],
        conflicts: ['b'],
        missing: []
      }
    } as never)

    await wrapper.get('[data-testid="trash-row-a"] input[type="checkbox"]').setValue(true)
    await wrapper.get('[data-testid="trash-row-b"] input[type="checkbox"]').setValue(true)
    await wrapper.get('[data-testid="trash-restore-selected"]').trigger('click')
    await flushPromises()

    expect(post).toHaveBeenCalledWith('/api/storage/trash/restore', undefined, { ids: ['a', 'b'] })
    expect(wrapper.find('[data-testid="trash-row-a"]').exists()).toBe(false)
    const marker = wrapper.get('[data-testid="trash-row-b"] [data-testid="trash-conflict"]')
    expect(marker.attributes('role')).toBe('img')
    expect(marker.attributes('aria-label')).toContain('same name already exists')
    expect(wrapper.find('[data-testid="trash-row-c"] [data-testid="trash-conflict"]').exists()).toBe(
      false
    )
    expect(toast).toHaveBeenCalledWith('Restored', '1 item restored', 'success')
    expect(toast).toHaveBeenCalledWith(
      'Restored',
      "'a' was restored to My files because its original folder is no longer available.",
      'info'
    )
    expect(toast).toHaveBeenCalledWith(
      'Some items were not restored',
      'An item with the same name already exists there. Rename or move it, then try again.',
      'warn'
    )
  })

  it('collapses several relocations into one notice', async () => {
    const wrapper = await mountWith([trashed('a'), trashed('b')])
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    vi.spyOn(Api, 'post').mockResolvedValue({
      status: 200,
      body: {
        restored: [
          { id: 'a', file_id: null, relocated: true },
          { id: 'b', file_id: null, relocated: true }
        ],
        conflicts: [],
        missing: []
      }
    } as never)

    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true)
    await wrapper.get('[data-testid="trash-restore-selected"]').trigger('click')
    await flushPromises()

    const infos = toast.mock.calls.filter(([, , type]) => type === 'info')
    expect(infos).toEqual([
      [
        'Restored',
        '2 items were restored to My files because their original folders are no longer available.',
        'info'
      ]
    ])
  })

  it('warns when an item could no longer be restored and reloads the list', async () => {
    const wrapper = await mountWith([trashed('a'), trashed('b')])
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    vi.spyOn(Api, 'post').mockResolvedValue({
      status: 200,
      body: { restored: [], conflicts: [], missing: ['a'] }
    } as never)
    const get = vi
      .spyOn(Api, 'get')
      .mockResolvedValue({ status: 200, body: { items: [trashed('b')] } } as never)

    await wrapper.get('[data-testid="trash-row-a"] [name="trash-restore"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="trash-row-a"]').exists()).toBe(false)
    expect(toast).toHaveBeenCalledWith(
      'Some items were not restored',
      '1 item could no longer be restored. It was already restored or deleted forever.',
      'warn'
    )
    expect(toast).not.toHaveBeenCalledWith('Restored', expect.anything(), 'success')
    expect(get).toHaveBeenCalledWith('/api/storage/trash', { compact: true })
  })

  it('reports a failed restore and keeps the row', async () => {
    const wrapper = await mountWith([trashed('a')])
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    vi.spyOn(Api, 'post').mockRejectedValue(new Error('boom'))

    await wrapper.get('[data-testid="trash-row-a"] [name="trash-restore"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="trash-row-a"]').exists()).toBe(true)
    expect(toast).toHaveBeenCalledWith(
      "Couldn't restore. The item is still in trash.",
      'boom',
      'error'
    )
  })

  it('asks before deleting a row forever', async () => {
    const wrapper = await mountWith([trashed('a'), trashed('b')])
    const post = vi.spyOn(Api, 'post').mockResolvedValue({ status: 202, body: undefined } as never)

    await wrapper.get('[data-testid="trash-row-a"] [name="trash-delete-forever"]').trigger('click')
    await flushPromises()
    expect(post).not.toHaveBeenCalled()

    const dialog = openDialog(wrapper)
    expect(dialog.attributes('aria-label')).toBe('Delete forever')
    expect(dialog.text()).toContain("Delete 'a' forever? This cannot be undone.")

    await buttonIn(dialog, 'Delete forever').trigger('click')
    await flushPromises()

    expect(post).toHaveBeenCalledWith('/api/storage/trash/purge', undefined, { ids: ['a'] })
    expect(wrapper.find('[data-testid="trash-row-a"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="trash-row-b"]').exists()).toBe(true)
  })

  it('counts the selection in the delete-forever confirmation', async () => {
    const wrapper = await mountWith([trashed('a'), trashed('b')])
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true)
    await wrapper.get('[data-testid="trash-delete-selected"]').trigger('click')

    expect(openDialog(wrapper).text()).toContain('Delete 2 items forever? This cannot be undone.')
  })

  it('cancelling the confirmation deletes nothing', async () => {
    const wrapper = await mountWith([trashed('a')])
    const post = vi.spyOn(Api, 'post')

    await wrapper.get('[data-testid="trash-row-a"] [name="trash-delete-forever"]').trigger('click')
    await buttonIn(openDialog(wrapper), 'Cancel').trigger('click')
    await flushPromises()

    expect(post).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="trash-row-a"]').exists()).toBe(true)
  })

  it('reports a failed purge and keeps the row', async () => {
    const wrapper = await mountWith([trashed('a')])
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    vi.spyOn(Api, 'post').mockRejectedValue(new Error('boom'))

    await wrapper.get('[data-testid="trash-row-a"] [name="trash-delete-forever"]').trigger('click')
    await buttonIn(openDialog(wrapper), 'Delete forever').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="trash-row-a"]').exists()).toBe(true)
    expect(toast).toHaveBeenCalledWith("Couldn't delete. The item is still in trash.", 'boom', 'error')
  })

  it('asks before emptying the trash', async () => {
    const wrapper = await mountWith([trashed('a'), trashed('b')])
    const post = vi.spyOn(Api, 'post').mockResolvedValue({ status: 202, body: undefined } as never)

    await wrapper.get('[data-testid="trash-empty"]').trigger('click')
    await flushPromises()
    expect(post).not.toHaveBeenCalled()

    const dialog = openDialog(wrapper)
    expect(dialog.attributes('aria-label')).toBe('Empty trash')
    expect(dialog.text()).toContain('Delete all 2 items in trash forever? This cannot be undone.')

    await buttonIn(dialog, 'Empty trash').trigger('click')
    await flushPromises()

    expect(post).toHaveBeenCalledWith('/api/storage/trash/empty')
    expect(wrapper.find('[data-testid="trash-empty-state"]').exists()).toBe(true)
  })

  it('reports a failed empty and keeps the rows', async () => {
    const wrapper = await mountWith([trashed('a')])
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    vi.spyOn(Api, 'post').mockRejectedValue(new Error('boom'))

    await wrapper.get('[data-testid="trash-empty"]').trigger('click')
    await buttonIn(openDialog(wrapper), 'Empty trash').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="trash-row-a"]').exists()).toBe(true)
    expect(toast).toHaveBeenCalledWith("Couldn't delete. The item is still in trash.", 'boom', 'error')
  })

  it('loads the storage stats for the quota bar', async () => {
    await mountWith([])
    expect(meta.stats).toHaveBeenCalled()
  })

  it('keeps the rows and offers a retry when a reload fails', async () => {
    const wrapper = await mountWith([trashed('a')])
    vi.spyOn(Api, 'get').mockRejectedValue(new Error('offline'))

    expect(wrapper.find('[data-testid="trash-stale-error"]').exists()).toBe(false)

    await trashStore().load(KEYPAIR)
    await flushPromises()

    expect(wrapper.find('[data-testid="trash-row-a"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="trash-stale-error"]').text()).toContain("Couldn't load")
  })

  it('shows the expiry under the name for narrow screens', async () => {
    const wrapper = await mountWith([trashed('a')])
    expect(wrapper.get('[data-testid="trash-expires-inline"]').text()).toBe(
      'Deleted forever in 30 days'
    )
  })
})
