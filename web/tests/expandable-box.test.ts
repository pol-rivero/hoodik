import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ExpandableBox from '../src/components/ui/ExpandableBox.vue'

// jsdom does no layout, so feed the box a content height through a stubbed
// ResizeObserver that fires as soon as it starts observing.
let contentHeight = 0

class FakeResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    Object.defineProperty(target, 'offsetHeight', { configurable: true, get: () => contentHeight })
    this.callback([], this as unknown as ResizeObserver)
  }
  unobserve() {}
  disconnect() {}
}

const mountBox = async (height: number) => {
  contentHeight = height
  const wrapper = mount(ExpandableBox, {
    props: { expandLabel: 'Show all', collapseLabel: 'Show less', collapsedHeight: 100 },
    slots: { default: '<div class="row">row</div><button class="sort">Sort</button>' }
  })
  await nextTick()
  return wrapper
}

describe('ExpandableBox', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('leaves content that fits alone', async () => {
    const wrapper = await mountBox(80)

    expect(wrapper.find('[data-testid="expandable-box-toggle"]').exists()).toBe(false)
    const content = wrapper.find('[data-testid="expandable-box-content"]')
    expect((content.element as HTMLElement).style.maxHeight).toBe('')
  })

  it('caps tall content and expands it from the toggle', async () => {
    const wrapper = await mountBox(300)
    const content = wrapper.find('[data-testid="expandable-box-content"]')
    const toggle = wrapper.find('[data-testid="expandable-box-toggle"]')

    expect((content.element as HTMLElement).style.maxHeight).toBe('100px')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.text()).toBe('Show all')

    await toggle.trigger('click')
    expect((content.element as HTMLElement).style.maxHeight).toBe('300px')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.text()).toBe('Show less')

    await toggle.trigger('click')
    expect((content.element as HTMLElement).style.maxHeight).toBe('100px')
  })

  it('expands when the collapsed content itself is clicked', async () => {
    const wrapper = await mountBox(300)

    await wrapper.find('.row').trigger('click')

    const toggle = wrapper.find('[data-testid="expandable-box-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('true')
  })

  it('leaves clicks on controls inside the content to those controls', async () => {
    const wrapper = await mountBox(300)

    await wrapper.find('.sort').trigger('click')

    const toggle = wrapper.find('[data-testid="expandable-box-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
  })
})
