import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'

import AsideFileTree from '../src/components/ui/AsideFileTree.vue'
import AsideFileTreeNode from '../src/components/ui/AsideFileTreeNode.vue'
import FolderDropTarget from '../src/components/files/FolderDropTarget.vue'
import * as meta from '../services/storage/meta'
import * as sharesApi from '../services/shares/api'
import * as events from '../services/storage/events'
import { emitFileTreeChange } from '../services/storage/events'
import { store as filesStore } from '../services/storage'

import type { AppFile, FileResponse, KeyPair } from '../types'

const EMPTY_PAGE = { items: [], total: 0, limit: 50, offset: 0 }

const kp = (fingerprint: string) =>
  ({ input: 'priv', publicKey: 'pub', fingerprint }) as unknown as KeyPair

const dir = (id: string, parent: string | null = null) =>
  ({ id, name: id, encrypted_name: id, mime: 'dir', file_id: parent, chunks: 0 }) as unknown as AppFile

function setupRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/files/:file_id?', name: 'files', component: { template: '<div />' } },
      { path: '/other', name: 'other', component: { template: '<div />' } }
    ]
  })
}

/** `meta.find` backed by a mutable `dir_id → children` map ('' is root). */
function serveListings(listings: Record<string, AppFile[] | (() => Promise<AppFile[]>)>) {
  vi.spyOn(meta, 'find').mockImplementation(async (params) => {
    const entry = listings[(params as { dir_id?: string }).dir_id ?? '']
    const children = typeof entry === 'function' ? await entry() : (entry ?? [])
    return { children, parents: [] } as unknown as FileResponse
  })
  vi.spyOn(meta, 'decrypt').mockImplementation(async (item) => ({
    name: (item as AppFile).encrypted_name
  }))
}

async function mountTree(fingerprint: string) {
  vi.spyOn(sharesApi, 'getSharesMine').mockResolvedValue(EMPTY_PAGE)
  const router = setupRouter()
  await router.push('/other')
  const wrapper = mount(AsideFileTree, {
    props: { keypair: kp(fingerprint) },
    global: { plugins: [router] }
  })
  await flushPromises()
  return wrapper
}

const row = (wrapper: Awaited<ReturnType<typeof mountTree>>, name: string) =>
  wrapper.findAll('li').find((li) => li.attributes('title') === name)!

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AsideFileTree after moves', () => {
  it('collapses an expanded folder that was moved elsewhere', async () => {
    const listings: Record<string, AppFile[]> = {
      '': [dir('t4-a'), dir('t4-b')],
      't4-a': [],
      't4-b': []
    }
    serveListings(listings)
    const wrapper = await mountTree('fp-moved-expanded')

    await row(wrapper, 't4-a').trigger('click')
    await row(wrapper, 't4-b').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Empty')

    // t4-a moves into t4-b.
    listings[''] = [dir('t4-b')]
    listings['t4-b'] = [dir('t4-a', 't4-b')]
    emitFileTreeChange({ type: 'moved', folderId: undefined, targetFolderId: 't4-b' })
    await flushPromises()

    expect(row(wrapper, 't4-a')).toBeTruthy()
    // Before the fix t4-a rendered open with an "Empty" child and never loaded.
    expect(wrapper.text()).not.toContain('Empty')
  })

  it('finishes a folder load that a refresh raced', async () => {
    let release!: (items: AppFile[]) => void
    serveListings({
      '': [dir('t10-a')],
      't10-a': () => new Promise<AppFile[]>((resolve) => (release = resolve))
    })
    const wrapper = await mountTree('fp-merge-race')

    await row(wrapper, 't10-a').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Loading...')

    emitFileTreeChange({ type: 'created', folderId: undefined })
    await flushPromises()
    release([dir('t10-child', 't10-a')])
    await flushPromises()

    expect(wrapper.text()).not.toContain('Loading...')
    expect(row(wrapper, 't10-child')).toBeTruthy()
  })
})

describe('AsideFileTreeNode drop targets', () => {
  it('passes the folder chain down to nested nodes', () => {
    const root = dir('anc-root')
    const r = dir('anc-r', 'anc-root')
    const c1 = dir('anc-c1', 'anc-r')
    const c2 = dir('anc-c2', 'anc-c1')
    const node = (file: AppFile, children: ReturnType<typeof node>[] = []): {
      file: AppFile
      children: unknown[]
      loaded: boolean
      loading: boolean
    } => ({ file, children, loaded: true, loading: false })

    const wrapper = mount(AsideFileTreeNode, {
      props: {
        node: node(r, [node(c1, [node(c2)])]) as never,
        depth: 1,
        ancestors: [root],
        expanded: new Set(['anc-r', 'anc-c1'])
      },
      global: { plugins: [setupRouter()] }
    })

    const ancestorsOf = (id: string) =>
      wrapper
        .findAllComponents(FolderDropTarget)
        .find((t) => t.props('target')?.id === id)!
        .props('ancestors')
        .map((a: AppFile) => a.id)

    expect(ancestorsOf('anc-r')).toEqual(['anc-root'])
    expect(ancestorsOf('anc-c1')).toEqual(['anc-root', 'anc-r'])
    expect(ancestorsOf('anc-c2')).toEqual(['anc-root', 'anc-r', 'anc-c1'])
  })
})

describe('Storage.moveAll tree event', () => {
  it('names the folder the files left, not the one listed when it finishes', async () => {
    vi.spyOn(meta, 'moveMany').mockResolvedValue(undefined as never)
    vi.spyOn(meta, 'find').mockResolvedValue({ children: [], parents: [] } as never)
    vi.spyOn(sharesApi, 'getSharesMine').mockResolvedValue(EMPTY_PAGE)
    const emit = vi.spyOn(events, 'emitFileTreeChange')
    const Storage = filesStore()

    await Storage.moveAll(kp('x'), [dir('m')], 'dest', 'src')

    expect(emit).toHaveBeenCalledWith({ type: 'moved', folderId: 'src', targetFolderId: 'dest' })
  })
})
