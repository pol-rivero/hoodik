import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'

import TableFileRow from '../../src/views/files/index-view/TableFileRow.vue'
import { SHARED_WITH_ME_DIR_ID } from '../../services/storage'
import { store as uploadStore } from '../../services/storage/upload'
import { isPreviewable } from '../../services/preview'
import type { AppFile, UploadAppFile } from '../../types'

const routerPush = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush })
}))

const OWNER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const SIZES = {
  name: 'flex-1 p-2 pt-3 pl-3 min-w-0 flex',
  size: 'hidden p-2 pt-3 md:block w-28 shrink-0',
  type: 'hidden p-2 pt-3 xl:block w-24 shrink-0',
  modifiedAt: 'hidden p-2 pt-3 sm:block w-52 shrink-0',
  buttons: 'w-10 p-2 shrink-0'
}

function baseFile(overrides: Partial<AppFile> = {}): AppFile {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: OWNER_ID,
    is_owner: true,
    name: 'doc.pdf',
    name_hash: '',
    mime: 'application/pdf',
    chunks: 0,
    file_id: null,
    file_modified_at: 0,
    created_at: 0,
    finished_upload_at: 1_700_000_000,
    is_new: false,
    editable: false,
    active_version: 1,
    encrypted_key: '',
    encrypted_name: '',
    cipher: 'aegis128l',
    ...overrides
  } as unknown as AppFile
}

function mountRow(file: AppFile): ReturnType<typeof mount> {
  return mount(TableFileRow, {
    props: { file, selected: false, sizes: SIZES }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TableFileRow: shared-out hint', () => {
  it('renders the share badge when the owner has shared the row out', () => {
    const wrapper = mountRow(baseFile({ shared_with_count: 2 }))
    const badge = wrapper.find('[data-testid="shared-out-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('title')).toContain('2')
  })

  it('uses the singular phrasing for one recipient', () => {
    const wrapper = mountRow(baseFile({ shared_with_count: 1 }))
    const badge = wrapper.find('[data-testid="shared-out-badge"]')
    expect(badge.attributes('title')).toContain('1 other account')
  })

  it('omits the badge when the owner has shared with nobody', () => {
    const wrapper = mountRow(baseFile({ shared_with_count: 0 }))
    expect(wrapper.find('[data-testid="shared-out-badge"]').exists()).toBe(false)
  })

  it('omits the badge on non-owner rows even when the count is set', () => {
    // Incoming-share rows surface an "owned by" badge — the owner-side
    // share count would be misleading on them.
    const wrapper = mountRow(
      baseFile({ is_owner: false, shared_with_count: 5, share_role: 'reader' })
    )
    expect(wrapper.find('[data-testid="shared-out-badge"]').exists()).toBe(false)
  })
})

describe('TableFileRow: selection state', () => {
  it('leaves the synthetic root out of the selection model', () => {
    const wrapper = mountRow(
      baseFile({ id: SHARED_WITH_ME_DIR_ID, mime: 'dir', name: 'Shared with me' })
    )
    expect(wrapper.get('[role="row"]').attributes('aria-selected')).toBeUndefined()
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
  })

  it('reports whether a regular row is selected, without a checkbox', () => {
    const file = baseFile()
    const unselected = mountRow(file)
    expect(unselected.get('[role="row"]').attributes('aria-selected')).toBe('false')
    expect(unselected.find('input[type="checkbox"]').exists()).toBe(false)

    const selected = mount(TableFileRow, {
      props: { file, selected: true, sizes: SIZES }
    })
    const row = selected.get('[role="row"]')
    expect(row.attributes('aria-selected')).toBe('true')
    expect(row.classes()).toContain('file-row-selected')
  })

  it('has no selection state at all when selection is disabled', () => {
    const wrapper = mount(TableFileRow, {
      props: {
        file: baseFile(),
        selected: false,
        selectionDisabled: true,
        sizes: SIZES
      }
    })
    expect(wrapper.get('[role="row"]').attributes('aria-selected')).toBeUndefined()
  })
})

describe('TableFileRow: dragging', () => {
  const mountWith = (file: AppFile, extra: Record<string, unknown> = {}) =>
    mount(TableFileRow, { props: { file, selected: true, sizes: SIZES, ...extra } })

  it('makes only a selected row draggable', () => {
    expect(mountRow(baseFile()).get('[role="row"]').attributes('draggable')).toBeUndefined()
    expect(mountWith(baseFile()).get('[role="row"]').attributes('draggable')).toBe('true')
  })

  it('never drags the synthetic root or a row in a list without selection', () => {
    const root = baseFile({ id: SHARED_WITH_ME_DIR_ID, mime: 'dir', name: 'Shared with me' })
    expect(mountWith(root).get('[role="row"]').attributes('draggable')).toBeUndefined()
    expect(
      mountWith(baseFile(), { selectionDisabled: true }).get('[role="row"]').attributes('draggable')
    ).toBeUndefined()
  })

  it('keeps thumbnails from being dragged on their own', () => {
    const wrapper = mountRow(baseFile({ mime: 'image/png', thumbnail: 'data:image/png;base64,' }))
    expect(wrapper.get('img').attributes('draggable')).toBe('false')
  })
})

describe('TableFileRow: clicks', () => {
  it('hands a click anywhere on the row to the table, with its modifiers', async () => {
    const wrapper = mountRow(baseFile())
    await wrapper.find('[role="gridcell"]:nth-child(2)').trigger('click', { ctrlKey: true })

    const [[event, file]] = wrapper.emitted('row-click') as [MouseEvent, AppFile][]
    expect(event.ctrlKey).toBe(true)
    expect(file.id).toBe(baseFile().id)
  })

  it('keeps clicks on the actions cell to the actions', async () => {
    const wrapper = mountRow(baseFile())
    await wrapper.find('[data-row-actions]').trigger('click')
    await wrapper.find('[data-row-actions]').trigger('dblclick')
    expect(wrapper.emitted('row-click')).toBeFalsy()
    expect(routerPush).not.toHaveBeenCalled()
  })

  it('Space selects through the table and Enter opens', async () => {
    routerPush.mockClear()
    const dir = baseFile({ mime: 'dir', name: 'Photos' })
    const wrapper = mountRow(dir)
    const button = wrapper.find('button[data-row-nav]')

    await button.trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('row-click')).toHaveLength(1)

    await button.trigger('keydown', { key: 'Enter' })
    expect(routerPush).toHaveBeenCalledWith({ name: 'files', params: { file_id: dir.id } })
  })
})

describe('isPreviewable: shared image without decrypted thumbnail', () => {
  // A shared image row arrives without a decrypted
  // thumbnail (the encrypted_thumbnail isn't always shipped to
  // recipients), but the file-preview view can render directly from
  // chunks. The previewable check must not block routing on thumbnail
  // presence for image and video mime types.
  it('accepts a shared image even when thumbnail is undefined', () => {
    const file = baseFile({
      is_owner: false,
      mime: 'image/png',
      size: 12_345,
      thumbnail: undefined,
      share_role: 'reader'
    })
    expect(isPreviewable(file)).toBe(true)
  })

  it('accepts a shared video even when thumbnail is undefined', () => {
    const file = baseFile({
      is_owner: false,
      mime: 'video/mp4',
      size: 999_999,
      thumbnail: undefined,
      share_role: 'reader'
    })
    expect(isPreviewable(file)).toBe(true)
  })

  it('rejects an unknown mime type when no thumbnail is present', () => {
    const file = baseFile({
      is_owner: false,
      mime: 'application/octet-stream',
      size: 100,
      thumbnail: undefined,
      share_role: 'reader'
    })
    expect(isPreviewable(file)).toBe(false)
  })

  it('rejects a file whose upload never finished', () => {
    const file = baseFile({
      mime: 'image/png',
      size: 12_345,
      thumbnail: 'data:image/png;base64,XXX',
      finished_upload_at: undefined
    })
    expect(isPreviewable(file)).toBe(false)
  })
})

describe('TableFileRow: still-uploading row', () => {
  it('marks the row as uploading while the queue is working on it', () => {
    const file = baseFile({ finished_upload_at: undefined, chunks: 0 })
    uploadStore().running.push(file as UploadAppFile)

    const wrapper = mountRow(file)
    const progress = wrapper.find('.border-greeny-500')

    expect(wrapper.find('[data-testid="uploading-icon"]').exists()).toBe(true)
    expect(progress.attributes('style')).toContain('width: 0%')
  })

  it('marks an unfinished row with no live transfer as stalled, not uploading', () => {
    // After a refresh the in-memory queue is empty — the row must not sit
    // on a progress bar that will never move.
    const wrapper = mountRow(baseFile({ finished_upload_at: undefined, chunks: 0 }))

    expect(wrapper.find('[data-testid="uploading-icon"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stalled-upload-icon"]').exists()).toBe(true)
    expect(wrapper.find('.border-greeny-500').exists()).toBe(false)
  })

  it('leaves a finished row without the uploading affordances', () => {
    const wrapper = mountRow(baseFile())

    expect(wrapper.find('[data-testid="uploading-icon"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stalled-upload-icon"]').exists()).toBe(false)
    expect(wrapper.find('.border-greeny-500').exists()).toBe(false)
  })
})

describe('TableFileRow: double-click routing on shared previewable rows', () => {
  beforeEach(() => {
    routerPush.mockClear()
  })

  function doubleClickRow(wrapper: ReturnType<typeof mountRow>): Promise<void> {
    // The row listens for the browser's own dblclick rather than counting
    // clicks against a timer, so this drives the real event.
    return wrapper.find('button').trigger('dblclick') as Promise<void>
  }

  it('shared image with finished upload routes to file-preview (B3)', async () => {
    const wrapper = mountRow(
      baseFile({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        is_owner: false,
        mime: 'image/png',
        size: 12_345,
        finished_upload_at: 1_700_000_000,
        share_role: 'reader',
        thumbnail: undefined
      })
    )
    await doubleClickRow(wrapper)
    expect(routerPush).toHaveBeenCalledWith({
      name: 'file-preview',
      params: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    })
  })

  it('owned image still routes to file-preview', async () => {
    const wrapper = mountRow(
      baseFile({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        is_owner: true,
        mime: 'image/png',
        size: 12_345,
        finished_upload_at: 1_700_000_000,
        thumbnail: 'data:image/png;base64,XXX'
      })
    )
    await doubleClickRow(wrapper)
    expect(routerPush).toHaveBeenCalledWith({
      name: 'file-preview',
      params: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    })
  })
})
