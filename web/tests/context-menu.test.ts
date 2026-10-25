import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h, nextTick } from 'vue'
import ContextMenu from '../src/components/ui/ContextMenu.vue'
import ContextMenuHost from '../src/components/ui/ContextMenuHost.vue'
import {
  closeContextMenu,
  openContextMenu,
  openContextMenuFromEvent,
  selectContextMenuItem,
  useContextMenu,
  type ContextMenuEntry,
  type ContextMenuItem
} from '../src/composables/useContextMenu'

const ITEMS: ContextMenuEntry[] = [
  { kind: 'label', id: 'header', label: '2 selected' },
  { kind: 'separator', id: 'sep-1' },
  { kind: 'item', id: 'open', label: 'Open' },
  { kind: 'item', id: 'rename', label: 'Rename', shortcut: 'F2' },
  { kind: 'item', id: 'locked', label: 'Locked', disabled: true },
  { kind: 'separator', id: 'sep-2' },
  { kind: 'item', id: 'remove', label: 'Move to trash', danger: true, shortcut: 'Del' }
]
const RENAME = ITEMS[3] as ContextMenuItem

let wrapper: VueWrapper<any> | null = null
let clock = 1000

const menuEl = () => document.body.querySelector<HTMLElement>('[role="menu"]')
const focusedId = () => (document.activeElement as HTMLElement | null)?.dataset.itemId

const press = (key: string, init: KeyboardEventInit = {}, target?: EventTarget) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  ;(target ?? document.activeElement ?? document.body).dispatchEvent(event)
  return event
}

const mouse = (type: string, target: EventTarget, init: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

const element = (tag = 'div') => {
  const el = document.createElement(tag)
  document.body.appendChild(el)
  return el
}

const mountMenu = (
  props: Partial<{ x: number; y: number; items: ContextMenuEntry[]; anchor: Element | null }> = {}
) => {
  wrapper = mount(ContextMenu, {
    props: { x: 40, y: 50, items: ITEMS, label: 'Actions', ...props },
    attachTo: document.body
  })
  return wrapper
}

const closeReasons = (w: VueWrapper<any>) => (w.emitted('close') ?? []).map(([reason]) => reason)

beforeEach(() => {
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  closeContextMenu({ restoreFocus: false })
  // Ends any click swallow a test left armed.
  mouse('pointerdown', window)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ContextMenu', () => {
  it('renders a labelled menu with items, separators and hints in a body teleport', () => {
    mountMenu()
    const menu = menuEl()!

    expect(menu.parentElement).toBe(document.body)
    expect(menu.getAttribute('aria-label')).toBe('Actions')
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(4)
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(2)
    expect(menu.querySelector('[data-item-id="locked"]')!.getAttribute('aria-disabled')).toBe('true')
    expect(menu.querySelector('[data-testid="context-menu-item-remove"]')!.textContent).toContain('Del')
  })

  it('renders a label entry as heading text, not as an item', () => {
    mountMenu()
    const heading = menuEl()!.querySelector('[data-testid="context-menu-label-header"]')!

    expect(heading.getAttribute('role')).toBe('presentation')
    expect(heading.textContent).toBe('2 selected')
  })

  it('focuses the first enabled item on open', () => {
    mountMenu()
    expect(focusedId()).toBe('open')
  })

  it('walks enabled items with the arrow keys, wrapping at both ends', () => {
    mountMenu()

    press('ArrowDown')
    expect(focusedId()).toBe('rename')
    press('ArrowDown')
    expect(focusedId()).toBe('remove')
    press('ArrowDown')
    expect(focusedId()).toBe('open')
    press('ArrowUp')
    expect(focusedId()).toBe('remove')
    press('Home')
    expect(focusedId()).toBe('open')
    press('End')
    expect(focusedId()).toBe('remove')
  })

  it('jumps to an item by its first letter', () => {
    mountMenu()
    press('m')
    expect(focusedId()).toBe('remove')
  })

  it('activates the focused item with Enter or Space, once', () => {
    const w = mountMenu()

    press('Enter')
    press('ArrowDown')
    press(' ')

    expect(w.emitted('select')!.map(([item]) => (item as { id: string }).id)).toEqual(['open'])
  })

  it('ignores clicks on disabled items', () => {
    const w = mountMenu()

    menuEl()!.querySelector<HTMLElement>('[data-item-id="locked"]')!.click()
    menuEl()!.querySelector<HTMLElement>('[data-item-id="rename"]')!.click()

    expect(w.emitted('select')!.map(([item]) => (item as { id: string }).id)).toEqual(['rename'])
  })

  it('closes on Escape without the key reaching the page shortcuts', () => {
    const pageShortcut = vi.fn()
    window.addEventListener('keydown', pageShortcut)
    const w = mountMenu()

    press('Delete')
    const event = press('Escape')
    window.removeEventListener('keydown', pageShortcut)

    expect(closeReasons(w)).toEqual(['escape'])
    expect(event.defaultPrevented).toBe(true)
    expect(pageShortcut).not.toHaveBeenCalled()
  })

  it('keeps the keyboard when focus has slipped out to the page', () => {
    const pageShortcut = vi.fn()
    window.addEventListener('keydown', pageShortcut)
    const w = mountMenu()
    ;(document.activeElement as HTMLElement).blur()

    press('Delete', {}, document.body)
    press('a', { ctrlKey: true }, document.body)
    press('ArrowDown', {}, document.body)
    expect(focusedId()).toBe('open')
    press('Escape', {}, document.body)
    window.removeEventListener('keydown', pageShortcut)

    expect(pageShortcut).not.toHaveBeenCalled()
    expect(closeReasons(w)).toEqual(['escape'])
  })

  it('keeps focus in the menu when a separator or the padding is pressed', () => {
    mountMenu()

    expect(mouse('mousedown', menuEl()!.querySelector('[role="separator"]')!).defaultPrevented).toBe(true)
    expect(mouse('mousedown', menuEl()!).defaultPrevented).toBe(true)
    expect(menuEl()!.getAttribute('tabindex')).toBe('-1')
  })

  it('closes on Tab, keeping Tab from carrying focus off into the browser', () => {
    const w = mountMenu()
    const event = press('Tab')

    expect(closeReasons(w)).toEqual(['tab'])
    expect(event.defaultPrevented).toBe(true)
  })

  it('closes on a pointerdown outside, but not inside', () => {
    const outside = element()
    const w = mountMenu()

    mouse('pointerdown', menuEl()!.querySelector('[data-item-id="open"]')!)
    expect(w.emitted('close')).toBeUndefined()

    mouse('pointerdown', outside)
    expect(closeReasons(w)).toEqual(['outside'])
  })

  it('emits close only once, however many reasons follow', () => {
    const w = mountMenu()

    press('Escape')
    window.dispatchEvent(new Event('resize'))
    mouse('pointerdown', element())

    expect(closeReasons(w)).toEqual(['escape'])
  })

  it('closes on resize and window blur', () => {
    const w = mountMenu()
    window.dispatchEvent(new Event('resize'))
    expect(closeReasons(w)).toEqual(['resize'])

    wrapper!.unmount()
    const again = mountMenu()
    window.dispatchEvent(new Event('blur'))
    expect(closeReasons(again)).toEqual(['blur'])
  })

  describe('scrolling', () => {
    it('ignores scrolls inside the menu and right after opening', () => {
      const w = mountMenu()

      clock += 500
      menuEl()!.dispatchEvent(new Event('scroll'))
      expect(w.emitted('close')).toBeUndefined()

      wrapper!.unmount()
      const fresh = mountMenu()
      clock += 50
      document.dispatchEvent(new Event('scroll'))
      expect(fresh.emitted('close')).toBeUndefined()

      clock += 100
      document.dispatchEvent(new Event('scroll'))
      expect(closeReasons(fresh)).toEqual(['scroll'])
    })

    it('stays open when a container that does not hold the anchor scrolls', () => {
      const list = element()
      const anchor = list.appendChild(document.createElement('button'))
      const sidebar = element()
      const w = mountMenu({ anchor })
      clock += 500

      sidebar.dispatchEvent(new Event('scroll'))
      expect(w.emitted('close')).toBeUndefined()

      list.dispatchEvent(new Event('scroll'))
      expect(closeReasons(w)).toEqual(['scroll'])
    })
  })

  it('suppresses the native menu on itself', () => {
    mountMenu()
    expect(mouse('contextmenu', menuEl()!).defaultPrevented).toBe(true)
  })

  describe('placement', () => {
    beforeEach(() => {
      // jsdom has no layout; give the menu a size so placement has something to fit.
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        const size =
          this.getAttribute('role') === 'menu' ? { width: 200, height: 150 } : { width: 0, height: 0 }
        return { x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, ...size, toJSON: () => ({}) }
      })
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768)
    })

    const position = async () => {
      await nextTick()
      return { left: menuEl()!.style.left, top: menuEl()!.style.top }
    }

    it('opens at the pointer when it fits', async () => {
      mountMenu({ x: 40, y: 50 })
      expect(await position()).toEqual({ left: '40px', top: '50px' })
    })

    it('flips to the other side of the pointer near the right and bottom edges', async () => {
      mountMenu({ x: 1000, y: 700 })
      expect(await position()).toEqual({ left: '800px', top: '550px' })
    })

    it('clamps inside the viewport when neither side fits', async () => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(150)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(160)
      mountMenu({ x: 100, y: 100 })
      expect(await position()).toEqual({ left: '8px', top: '8px' })
    })

    it('caps its height to the viewport it was placed in', async () => {
      mountMenu()
      await nextTick()
      expect(menuEl()!.style.maxHeight).toBe('752px')
    })
  })
})

describe('useContextMenu', () => {
  it('opens nothing when no item can be chosen', () => {
    const { isOpen } = useContextMenu()
    const opened = openContextMenu({
      x: 0,
      y: 0,
      items: [
        { kind: 'label', id: 'l', label: 'Heading' },
        { kind: 'item', id: 'x', label: 'X', disabled: true }
      ],
      onSelect: vi.fn()
    })

    expect(opened).toBe(false)
    expect(isOpen.value).toBe(false)
  })

  it('keeps one menu at a time and returns focus to where it was before the first', () => {
    const row = element('button')
    row.focus()
    const firstClosed = vi.fn()
    const { menu, close } = useContextMenu()

    openContextMenu({ x: 1, y: 1, items: ITEMS, onSelect: vi.fn(), onClose: firstClosed })
    const firstId = menu.value!.id
    element('button').focus()

    openContextMenu({ x: 9, y: 9, items: ITEMS, onSelect: vi.fn() })
    expect(firstClosed).toHaveBeenCalledOnce()
    expect(menu.value).toMatchObject({ x: 9, y: 9 })
    expect(menu.value!.id).not.toBe(firstId)

    close()
    expect(menu.value).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('ignores a close or select from a menu that has been replaced', () => {
    const { menu } = useContextMenu()
    const firstSelect = vi.fn()
    const secondSelect = vi.fn()

    openContextMenu({ x: 1, y: 1, items: ITEMS, onSelect: firstSelect })
    const staleId = menu.value!.id
    openContextMenu({ x: 9, y: 9, items: ITEMS, onSelect: secondSelect })

    closeContextMenu({ id: staleId })
    selectContextMenuItem(RENAME, { id: staleId })
    expect(menu.value).toMatchObject({ x: 9, y: 9 })
    expect(firstSelect).not.toHaveBeenCalled()
    expect(secondSelect).not.toHaveBeenCalled()

    selectContextMenuItem(RENAME, { id: menu.value!.id })
    expect(secondSelect).toHaveBeenCalledWith(RENAME)
    expect(menu.value).toBeNull()
  })

  it('closes and restores focus before running the chosen action', () => {
    const row = element('button')
    row.focus()
    const { select, isOpen } = useContextMenu()
    let focusedDuringSelect: Element | null = null
    let openDuringSelect = true

    openContextMenu({
      x: 0,
      y: 0,
      items: ITEMS,
      onSelect: () => {
        focusedDuringSelect = document.activeElement
        openDuringSelect = isOpen.value
      }
    })
    element('button').focus()
    select(RENAME)

    expect(openDuringSelect).toBe(false)
    expect(focusedDuringSelect).toBe(row)
  })

  it('anchors keyboard-raised context menus to the target element', () => {
    const { openFromEvent, menu } = useContextMenu()
    const target = element('button')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 200, left: 100, top: 200, width: 300, height: 40, right: 400, bottom: 240, toJSON: () => ({})
    })

    const raised = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    Object.defineProperty(raised, 'target', { value: target })
    expect(openFromEvent(raised, { items: ITEMS, onSelect: vi.fn() })).toBe(true)
    expect(raised.defaultPrevented).toBe(true)
    expect(menu.value).toMatchObject({ x: 124, y: 220, anchor: target })
  })
})

describe('ContextMenuHost', () => {
  const mountHost = async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => null } },
        { path: '/other', component: { render: () => null } }
      ]
    })
    await router.push('/')
    wrapper = mount(
      defineComponent({ render: () => h(ContextMenuHost) }),
      { global: { plugins: [router] }, attachTo: document.body }
    )
    return router
  }

  const openAt = async (x: number, onSelect = vi.fn()) => {
    openContextMenu({ x, y: 5, items: ITEMS, onSelect })
    await nextTick()
  }

  it('renders the open menu and runs the chosen item', async () => {
    await mountHost()
    const onSelect = vi.fn()

    await openAt(5, onSelect)
    menuEl()!.querySelector<HTMLElement>('[data-item-id="rename"]')!.click()
    await nextTick()

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'rename' }))
    expect(menuEl()).toBeNull()
  })

  it('closes on Escape and when the path changes, but not on a hash-only change', async () => {
    const router = await mountHost()

    await openAt(5)
    press('Escape')
    await nextTick()
    expect(menuEl()).toBeNull()

    await openAt(5)
    await router.push({ path: '/', hash: '#file-1' })
    await flushPromises()
    expect(menuEl()).not.toBeNull()

    await router.push('/other')
    await flushPromises()
    expect(menuEl()).toBeNull()
  })

  it('swallows the click that dismisses the menu, and only that one', async () => {
    await mountHost()
    const row = element('button')
    const pageClick = vi.fn()
    const pageMouseDown = vi.fn()
    const pagePointerDown = vi.fn()
    document.addEventListener('click', pageClick)
    document.addEventListener('mousedown', pageMouseDown)
    row.addEventListener('pointerdown', pagePointerDown)

    await openAt(5)
    mouse('pointerdown', row, { button: 0 })
    mouse('mousedown', row, { button: 0 })
    mouse('click', row, { button: 0 })
    await nextTick()

    expect(menuEl()).toBeNull()
    expect(pagePointerDown).not.toHaveBeenCalled()
    expect(pageMouseDown).not.toHaveBeenCalled()
    expect(pageClick).not.toHaveBeenCalled()

    mouse('pointerdown', row, { button: 0 })
    mouse('mousedown', row, { button: 0 })
    mouse('click', row, { button: 0 })
    expect(pagePointerDown).toHaveBeenCalledOnce()
    expect(pageClick).toHaveBeenCalledOnce()

    document.removeEventListener('click', pageClick)
    document.removeEventListener('mousedown', pageMouseDown)
  })

  it('does not hand focus back to the old element when a press dismisses the menu', async () => {
    await mountHost()
    const row = element('button')
    row.focus()

    await openAt(5)
    expect(focusedId()).toBe('open')
    mouse('pointerdown', element(), { button: 0 })
    await nextTick()

    expect(menuEl()).toBeNull()
    expect(document.activeElement).not.toBe(row)
  })

  it('opens a fresh menu where a right-click lands while one is open', async () => {
    await mountHost()
    const row = element('button')
    row.addEventListener('contextmenu', (event) =>
      openContextMenuFromEvent(event, { items: ITEMS, onSelect: vi.fn() })
    )
    const pageClick = vi.fn()
    document.addEventListener('click', pageClick)

    await openAt(5)
    const firstId = useContextMenu().menu.value!.id
    mouse('pointerdown', row, { button: 2 })
    const raised = mouse('contextmenu', row, { button: 2, clientX: 300, clientY: 200 })
    await nextTick()

    expect(raised.defaultPrevented).toBe(true)
    expect(useContextMenu().menu.value).toMatchObject({ x: 300, y: 200 })
    expect(useContextMenu().menu.value!.id).not.toBe(firstId)
    expect(menuEl()).not.toBeNull()

    // A right-click arms no swallow, so the next ordinary click still lands.
    closeContextMenu()
    await nextTick()
    mouse('click', row, { button: 0 })
    expect(pageClick).toHaveBeenCalledOnce()
    document.removeEventListener('click', pageClick)
  })
})
