import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'

import DeleteModal from '../src/components/files/modals/DeleteModal.vue'
import DeleteMultipleModal from '../src/components/files/modals/DeleteMultipleModal.vue'
import * as notify from '../services/notify'

import type { AppFile, FilesStore, KeyPair } from '../types'

const KEYPAIR = { input: 'private-key' } as KeyPair

function row(overrides: Partial<AppFile>): AppFile {
  return {
    id: 'f1',
    name: 'report.pdf',
    mime: 'application/pdf',
    is_owner: true,
    file_id: null,
    ...overrides
  } as AppFile
}

function confirmButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button').find((b) => b.text().includes('Move to trash'))
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DeleteModal', () => {
  function mountSingle(target: AppFile, remove = vi.fn().mockResolvedValue(undefined)) {
    const Storage = { remove } as unknown as FilesStore
    return mount(DeleteModal, { props: { modelValue: target, Storage, kp: KEYPAIR } })
  }

  it('offers to move a file to trash without a typed gate', () => {
    const wrapper = mountSingle(row({}))

    expect(wrapper.text()).toContain("Move 'report.pdf' to trash? You can restore it from Trash.")
    expect(wrapper.find('input[type="text"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="delete-confirm-name"]').exists()).toBe(false)
    expect(confirmButton(wrapper)?.attributes('disabled')).toBeUndefined()
  })

  it('uses the folder copy for directories, still without a typed gate', () => {
    const wrapper = mountSingle(row({ name: 'Projects', mime: 'dir' }))

    expect(wrapper.text()).toContain("Move the folder 'Projects' and everything in it to trash?")
    expect(wrapper.find('input').exists()).toBe(false)
  })

  it('does not promise a restore when the file is only shared with the caller', () => {
    const wrapper = mountSingle(row({ is_owner: false }))

    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe(
      'Remove yourself from this share?'
    )
    expect(wrapper.get('[data-testid="delete-leave-body"]').text()).toContain(
      'You will lose access to report.pdf'
    )
    expect(wrapper.text()).not.toContain('restore')
    expect(confirmButton(wrapper)).toBeUndefined()
    expect(wrapper.findAll('button').some((b) => b.text() === 'Leave')).toBe(true)
  })

  it('announces a leave instead of a move to trash', async () => {
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    const wrapper = mountSingle(row({ is_owner: false }))

    await wrapper.findAll('button').find((b) => b.text() === 'Leave')?.trigger('click')
    await flushPromises()

    expect(toast).toHaveBeenCalledWith('Removed from share', 'You no longer see this file.', 'success')
    expect(toast).not.toHaveBeenCalledWith('Moved to trash', undefined, 'success')
  })

  it('warns that an unfinished upload is deleted for good', async () => {
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    const wrapper = mountSingle(row({ chunks: 3, finished_upload_at: undefined }))

    expect(wrapper.get('[data-testid="delete-purge-body"]').text()).toBe(
      "Delete 'report.pdf' forever? This cannot be undone."
    )
    expect(confirmButton(wrapper)).toBeUndefined()

    await wrapper.findAll('button').find((b) => b.text() === 'Delete forever')?.trigger('click')
    await flushPromises()
    expect(toast).not.toHaveBeenCalled()
  })

  it('removes the file and announces the move to trash', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    const target = row({})
    const wrapper = mountSingle(target, remove)

    await confirmButton(wrapper)?.trigger('click')
    await flushPromises()

    expect(remove).toHaveBeenCalledWith(KEYPAIR, target)
    expect(toast).toHaveBeenCalledWith('Moved to trash', undefined, 'success')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([undefined])
  })
})

describe('DeleteMultipleModal', () => {
  function mountMany(selected: AppFile[], removeAll = vi.fn().mockResolvedValue(undefined)) {
    const Storage = { selected, removeAll } as unknown as FilesStore
    return mount(DeleteMultipleModal, { props: { modelValue: true, Storage, kp: KEYPAIR } })
  }

  it('summarizes several items with the trash copy and no count gate', () => {
    const wrapper = mountMany([row({ id: 'a' }), row({ id: 'b', name: 'b.txt' })])

    expect(wrapper.text()).toContain('Move 2 items to trash? You can restore them from Trash.')
    expect(wrapper.find('[data-testid="delete-confirm-count"]').exists()).toBe(false)
    expect(wrapper.find('input[type="text"]').exists()).toBe(false)
    expect(confirmButton(wrapper)?.attributes('disabled')).toBeUndefined()
  })

  it('names a single selected item', () => {
    const wrapper = mountMany([row({})])
    expect(wrapper.text()).toContain("Move 'report.pdf' to trash?")
  })

  it('adds the shared note only when a selected row is not owned', () => {
    expect(
      mountMany([row({ id: 'a' }), row({ id: 'b' })]).find('[data-testid="delete-shared-note"]').exists()
    ).toBe(false)

    const mixed = mountMany([row({ id: 'a' }), row({ id: 'b', is_owner: false })])
    expect(mixed.find('[data-testid="delete-shared-note"]').exists()).toBe(true)
    expect(mixed.text()).toContain('Move 2 items to trash?')
  })

  it('uses the leave copy when nothing selected is owned', () => {
    const wrapper = mountMany([
      row({ id: 'a', is_owner: false }),
      row({ id: 'b', is_owner: false })
    ])

    expect(wrapper.get('[data-testid="delete-leave-body"]').text()).toContain(
      'You will lose access to 2 items'
    )
    expect(confirmButton(wrapper)).toBeUndefined()
  })

  it('uses the delete-forever copy when only unfinished uploads are selected', () => {
    const wrapper = mountMany([
      row({ id: 'a', chunks: 2, finished_upload_at: undefined }),
      row({ id: 'b', chunks: 1, finished_upload_at: undefined })
    ])

    expect(wrapper.get('[data-testid="delete-purge-body"]').text()).toBe(
      'Delete 2 items forever? This cannot be undone.'
    )
  })

  it('skips the moved toast when nothing went to trash', async () => {
    const toast = vi.spyOn(notify, 'notification').mockImplementation(() => {})
    const wrapper = mountMany([row({ id: 'a', chunks: 2, finished_upload_at: undefined })])

    await wrapper.findAll('button').find((b) => b.text() === 'Delete forever')?.trigger('click')
    await flushPromises()

    expect(toast).not.toHaveBeenCalled()
  })

  it('removes the whole selection in one call', async () => {
    const removeAll = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(notify, 'notification').mockImplementation(() => {})
    const selected = [row({ id: 'a' }), row({ id: 'b' })]
    const wrapper = mountMany(selected, removeAll)

    await confirmButton(wrapper)?.trigger('click')
    await flushPromises()

    expect(removeAll).toHaveBeenCalledWith(KEYPAIR, selected)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })
})
