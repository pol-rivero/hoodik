import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'

import type { FilesStore, KeyPair } from '../types'

const route = reactive<{ params: { id?: string } }>({ params: { id: 'file-a' } })

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn() })
}))

vi.mock('@/components/preview/PreviewView.vue', () => ({
  default: { props: ['modelValue', 'hideDelete'], template: '<div data-testid="preview" />' }
}))

vi.mock('@/components/ui/BaseButton.vue', () => ({
  default: {
    props: ['label', 'to'],
    emits: ['click'],
    template: '<button @click="$emit(\'click\')">{{ label }}</button>'
  }
}))

const { default: FileView } = await import('../src/views/files/file-view/FileView.vue')

const KEYPAIR = { input: 'private-key' } as KeyPair

function storage(metadata: (id: string) => Promise<unknown>) {
  return {
    getItem: () => null,
    metadata: vi.fn(metadata),
    deselectAll: vi.fn(),
    selectOne: vi.fn()
  } as unknown as FilesStore
}

function notFound() {
  return Object.assign(new Error('not found'), {
    kind: 'ErrorResponse',
    status: 404,
    description: 'File not found'
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  route.params.id = 'file-a'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FileView when the file cannot be loaded', () => {
  it('shows the not-found state for a 404, such as a file in trash', async () => {
    const wrapper = mount(FileView, {
      props: { kp: KEYPAIR, Storage: storage(() => Promise.reject(notFound())) }
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="file-preview-not-found"]').text()).toContain('File not found')
    expect(wrapper.find('[data-testid="file-preview-error"]').exists()).toBe(false)
  })

  it('shows other failures as an error with a retry, not as not found', async () => {
    let fail = true
    const Storage = storage(() =>
      fail ? Promise.reject(new TypeError('Failed to fetch')) : new Promise(() => {})
    )
    const wrapper = mount(FileView, { props: { kp: KEYPAIR, Storage } })
    await flushPromises()

    expect(wrapper.find('[data-testid="file-preview-not-found"]').exists()).toBe(false)
    const error = wrapper.get('[data-testid="file-preview-error"]')
    expect(error.text()).toContain("Can't reach the server")

    fail = false
    await error.findAll('button').find((b) => b.text() === 'Retry')?.trigger('click')
    await flushPromises()

    expect(Storage.metadata).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="file-preview-error"]').exists()).toBe(false)
  })

  it('ignores a late failure for a file the user already left', async () => {
    let rejectFirst: (reason: unknown) => void = () => {}
    const Storage = storage((id) =>
      id === 'file-a'
        ? new Promise((_, reject) => (rejectFirst = reject))
        : new Promise(() => {})
    )
    const wrapper = mount(FileView, { props: { kp: KEYPAIR, Storage } })
    await flushPromises()

    route.params.id = 'file-b'
    await flushPromises()
    rejectFirst(notFound())
    await flushPromises()

    expect(wrapper.find('[data-testid="file-preview-not-found"]').exists()).toBe(false)
  })
})
