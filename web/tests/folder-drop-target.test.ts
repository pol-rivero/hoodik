import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../src/composables/useMoveFiles', () => ({
  moveFilesInteractive: vi.fn(async () => ({ status: 'moved', moved: 1, kind: 'plain' }))
}))

import FolderDropTarget from '../src/components/files/FolderDropTarget.vue'
import { moveFilesInteractive } from '../src/composables/useMoveFiles'
import { activeDrag, beginFileDrag, currentDragType, endFileDrag } from '../services/storage/dragMove'

import type { AppFile } from '../types'

const dir = (id: string, file_id: string | null = null) =>
  ({ id, name: id, mime: 'dir', is_owner: true, file_id }) as AppFile

function dataTransfer(types: string[]) {
  return { types, dropEffect: 'none', effectAllowed: 'all', setData: () => {} }
}

function fire(
  el: Element,
  type: string,
  types: string[] = [currentDragType() ?? ''],
  at: { x: number; y: number } = { x: 0, y: 0 }
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const dt = dataTransfer(types)
  Object.defineProperty(event, 'dataTransfer', { value: dt })
  Object.defineProperty(event, 'clientX', { value: at.x })
  Object.defineProperty(event, 'clientY', { value: at.y })
  el.dispatchEvent(event)
  return { event, dt }
}

function startDrag(files: AppFile[], source: AppFile | null) {
  const event = new Event('dragstart', { cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer([]) })
  beginFileDrag(event, files, source)
}

const home = dir('home')
const item = dir('item', 'home')

beforeEach(() => {
  vi.mocked(moveFilesInteractive).mockClear()
})

afterEach(() => {
  endFileDrag()
  vi.useRealTimers()
})

describe('FolderDropTarget', () => {
  it('highlights a valid target, survives child enter/leave, and moves on drop', async () => {
    const target = dir('target', 'home')
    const wrapper = mount(FolderDropTarget, {
      props: { target, ancestors: [home] },
      slots: { default: '<span class="child">x</span>' }
    })
    startDrag([item], home)

    const { event, dt } = fire(wrapper.element, 'dragenter')
    fire(wrapper.element, 'dragover')
    await wrapper.vm.$nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.attributes('data-drop-over')).toBe('true')
    expect(dt.dropEffect).not.toBe('none')

    // Entering a child then leaving the parent keeps the highlight.
    fire(wrapper.get('.child').element, 'dragenter')
    fire(wrapper.element, 'dragleave')
    await wrapper.vm.$nextTick()
    expect(wrapper.attributes('data-drop-over')).toBe('true')

    fire(wrapper.get('.child').element, 'drop')
    await wrapper.vm.$nextTick()
    expect(moveFilesInteractive).toHaveBeenCalledWith([item], target, {
      sourceParent: home,
      notifySuccess: true,
      confirmFileShares: true
    })
    expect(wrapper.attributes('data-drop-over')).toBeUndefined()
    expect(activeDrag.value).toBeNull()
  })

  it('refuses a drop into a descendant of a dragged folder', async () => {
    const below = dir('below', 'item')
    const wrapper = mount(FolderDropTarget, { props: { target: below, ancestors: [home, item] } })
    startDrag([item], home)

    const { event, dt } = fire(wrapper.element, 'dragover')
    await wrapper.vm.$nextTick()
    expect(event.defaultPrevented).toBe(false)
    expect(dt.dropEffect).toBe('none')
    expect(wrapper.attributes('data-drop-over')).toBeUndefined()

    fire(wrapper.element, 'drop')
    expect(moveFilesInteractive).not.toHaveBeenCalled()
  })

  it('ignores OS file drags', async () => {
    const wrapper = mount(FolderDropTarget, { props: { target: dir('t', 'home'), ancestors: [] } })
    startDrag([item], home)
    const { event } = fire(wrapper.element, 'dragover', ['Files'])
    expect(event.defaultPrevented).toBe(false)
    fire(wrapper.element, 'drop', ['Files'])
    expect(moveFilesInteractive).not.toHaveBeenCalled()
  })

  it('spring-loads after hovering, including over the items’ own folder', async () => {
    vi.useFakeTimers()
    const wrapper = mount(FolderDropTarget, {
      props: { target: home, ancestors: [], springLoad: true }
    })
    startDrag([item], home)

    fire(wrapper.element, 'dragenter')
    fire(wrapper.element, 'dragover')
    vi.advanceTimersByTime(699)
    expect(wrapper.emitted('spring-load')).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(wrapper.emitted('spring-load')).toHaveLength(1)
  })

  it('does not spring-load once the pointer has left', () => {
    vi.useFakeTimers()
    const wrapper = mount(FolderDropTarget, {
      props: { target: dir('t', 'home'), ancestors: [], springLoad: true }
    })
    startDrag([item], home)
    fire(wrapper.element, 'dragenter')
    fire(wrapper.element, 'dragleave')
    vi.advanceTimersByTime(1000)
    expect(wrapper.emitted('spring-load')).toBeUndefined()
  })

  it('does not spring-load a folder that appeared under a resting pointer', () => {
    vi.useFakeTimers()
    startDrag([item], home)
    const springLoaded = (w: ReturnType<typeof mount>) => w.emitted('spring-load')?.length ?? 0
    const at = { x: 100, y: 100 }

    const first = mount(FolderDropTarget, {
      props: { target: dir('first', 'home'), ancestors: [home], springLoad: true }
    })
    fire(first.element, 'dragenter', undefined, at)
    fire(first.element, 'dragover', undefined, at)
    vi.advanceTimersByTime(700)
    expect(springLoaded(first)).toBe(1)

    // The opened folder's first row renders under the pointer: it only sees
    // dragovers, and the pointer only wobbles.
    const next = mount(FolderDropTarget, {
      props: { target: dir('next', 'first'), ancestors: [home], springLoad: true }
    })
    for (let i = 0; i < 10; i++) {
      fire(next.element, 'dragover', undefined, { x: at.x + (i % 2), y: at.y })
      vi.advanceTimersByTime(300)
    }
    expect(springLoaded(next)).toBe(0)

    // Moving on re-arms it.
    fire(next.element, 'dragover', undefined, { x: at.x + 30, y: at.y })
    vi.advanceTimersByTime(700)
    expect(springLoaded(next)).toBe(1)
  })

  it('does not arm a spring-load from the first dragover of an element it never entered', () => {
    vi.useFakeTimers()
    startDrag([item], home)
    const wrapper = mount(FolderDropTarget, {
      props: { target: dir('t', 'home'), ancestors: [home], springLoad: true }
    })
    fire(wrapper.element, 'dragover')
    vi.advanceTimersByTime(1000)
    expect(wrapper.emitted('spring-load')).toBeUndefined()
  })
})
