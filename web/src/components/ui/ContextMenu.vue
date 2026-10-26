<script setup lang="ts">
import BaseIcon from '@/components/ui/BaseIcon.vue'
import {
  isMenuItem,
  swallowDismissingClick,
  type ContextMenuCloseReason,
  type ContextMenuEntry,
  type ContextMenuItem
} from '@/composables/useContextMenu'
import { onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{
  /** Viewport (client) coordinates the menu opens at. */
  x: number
  y: number
  items: ContextMenuEntry[]
  label?: string
  /** What was right-clicked; scrolling a container that doesn't hold it leaves the menu open. */
  anchor?: Element | null
}>()

const emits = defineEmits<{
  (event: 'select', item: ContextMenuItem): void
  (event: 'close', reason: ContextMenuCloseReason): void
}>()

const VIEWPORT_MARGIN = 8
/** Scrolls this soon after opening are the tail of whatever led here
 *  (momentum, a smooth scrollTo), not the user moving away. */
const SCROLL_GRACE_MS = 100

const root = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)
const maxHeight = ref<number | null>(null)
let mountedAt = 0
let done = false

const close = (reason: ContextMenuCloseReason) => {
  if (done) return
  done = true
  emits('close', reason)
}

const activate = (item: ContextMenuItem) => {
  if (done || item.disabled) return
  done = true
  emits('select', item)
}

const itemElements = () =>
  [...(root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter(
    (el) => el.getAttribute('aria-disabled') !== 'true'
  )

const focusAt = (index: number) => {
  const items = itemElements()
  if (!items.length) return
  const wrapped = (index + items.length) % items.length
  items[wrapped].focus({ preventScroll: true })
}

const focusedIndex = () => itemElements().indexOf(document.activeElement as HTMLElement)

const moveFocus = (delta: number) => {
  const index = focusedIndex()
  if (index < 0) focusAt(delta > 0 ? 0 : -1)
  else focusAt(index + delta)
}

/**
 * Opens towards the bottom right of the pointer, flips to the other side
 * of it on an axis where that would overflow, and finally clamps so the
 * menu never leaves the viewport even when it's bigger than either side.
 */
const place = () => {
  const el = root.value
  if (!el) return
  const viewportWidth = Math.min(
    window.innerWidth,
    document.documentElement.clientWidth || window.innerWidth
  )
  const viewportHeight = Math.min(
    window.innerHeight,
    document.documentElement.clientHeight || window.innerHeight
  )

  // Applied before measuring, so a long menu is measured at the height it will have.
  maxHeight.value = Math.max(0, viewportHeight - VIEWPORT_MARGIN * 2)
  el.style.maxHeight = `${maxHeight.value}px`
  const { width, height } = el.getBoundingClientRect()

  const fit = (start: number, size: number, viewport: number) => {
    const flipped = start + size > viewport - VIEWPORT_MARGIN ? start - size : start
    const max = viewport - size - VIEWPORT_MARGIN
    return Math.max(VIEWPORT_MARGIN, Math.min(flipped, max))
  }

  left.value = fit(props.x, width, viewportWidth)
  top.value = fit(props.y, height, viewportHeight)
}

const entryById = (el: Element | null) => {
  const id = el?.closest<HTMLElement>('[role="menuitem"]')?.dataset.itemId
  return props.items.find((entry): entry is ContextMenuItem => isMenuItem(entry) && entry.id === id)
}

/** First-letter jump, the way native menus let you pick an item by typing. */
const typeahead = (char: string) => {
  const items = itemElements()
  const start = focusedIndex()
  for (let step = 1; step <= items.length; step++) {
    const index = (start + step) % items.length
    if (items[index].textContent?.trim().toLowerCase().startsWith(char)) {
      focusAt(index)
      return
    }
  }
}

/**
 * Bound on the document in the capture phase rather than on the menu, so
 * the menu keeps the keyboard even if focus slipped out of it, and the
 * page's own shortcuts (Del, Ctrl+A, Escape on the window) never see a key
 * while it's open. Unhandled keys keep their browser default (reload, zoom).
 */
const onKeydown = (event: KeyboardEvent) => {
  event.stopPropagation()

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      moveFocus(1)
      return
    case 'ArrowUp':
      event.preventDefault()
      moveFocus(-1)
      return
    case 'Home':
      event.preventDefault()
      focusAt(0)
      return
    case 'End':
      event.preventDefault()
      focusAt(-1)
      return
    case 'Enter':
    case ' ': {
      event.preventDefault()
      const item = entryById(document.activeElement)
      if (item) activate(item)
      return
    }
    case 'Escape':
      event.preventDefault()
      close('escape')
      return
    case 'Tab':
      // Focus returns to where it was before the menu opened, as with
      // native menus; letting Tab through would move it on from there, or
      // into the browser chrome when nothing on the page had focus.
      event.preventDefault()
      close('tab')
      return
  }

  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    typeahead(event.key.toLowerCase())
  }
}

const onItemPointerMove = (event: PointerEvent) => {
  const el = (event.currentTarget as HTMLElement | null) ?? null
  if (el && el.getAttribute('aria-disabled') !== 'true' && document.activeElement !== el) {
    el.focus({ preventScroll: true })
  }
}

const inside = (target: EventTarget | null) =>
  target instanceof Node && !!root.value?.contains(target)

const onDocumentPointerDown = (event: PointerEvent) => {
  if (inside(event.target)) return
  // A right-click goes on to raise its own menu at the new position.
  if (event.button === 0) {
    event.stopPropagation()
    swallowDismissingClick()
  }
  close('outside')
}

const onScroll = (event: Event) => {
  if (inside(event.target)) return
  if (performance.now() - mountedAt < SCROLL_GRACE_MS) return
  const anchor = props.anchor
  if (anchor?.isConnected && event.target instanceof Node && !event.target.contains(anchor)) return
  close('scroll')
}

const onResize = () => close('resize')
const onBlur = () => close('blur')

onMounted(() => {
  mountedAt = performance.now()
  place()
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)
  window.addEventListener('blur', onBlur)
  focusAt(0)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('blur', onBlur)
})
</script>

<template>
  <Teleport to="body">
    <!-- mousedown is prevented so a press on a separator, the padding or
         the scrollbar doesn't move focus out to the page. -->
    <div
      ref="root"
      role="menu"
      tabindex="-1"
      aria-orientation="vertical"
      :aria-label="props.label"
      data-testid="context-menu"
      class="fixed z-[60] w-max min-w-[12rem] max-w-[18rem] overflow-y-auto py-1 rounded-md shadow-lg bg-white dark:bg-brownish-700 text-brownish-900 dark:text-dirty-white border border-paper-300 dark:border-brownish-600 text-sm focus:outline-none"
      :style="{
        left: `${left}px`,
        top: `${top}px`,
        maxHeight: maxHeight === null ? undefined : `${maxHeight}px`
      }"
      @mousedown.prevent
      @contextmenu.prevent
    >
      <template v-for="entry in props.items" :key="entry.id">
        <div
          v-if="entry.kind === 'separator'"
          role="separator"
          class="my-1 border-t border-paper-300 dark:border-brownish-600"
        />
        <div
          v-else-if="entry.kind === 'label'"
          role="presentation"
          :data-testid="entry.testid ?? `context-menu-label-${entry.id}`"
          class="px-3 py-1 text-xs font-semibold text-brownish-300 dark:text-brownish-50 select-none truncate"
        >{{ entry.label }}</div>
        <div
          v-else
          role="menuitem"
          tabindex="-1"
          :data-item-id="entry.id"
          :data-testid="entry.testid ?? `context-menu-item-${entry.id}`"
          :aria-disabled="entry.disabled ? 'true' : undefined"
          :title="entry.title"
          class="flex items-center gap-1 px-2 py-1 select-none focus:outline-none"
          :class="[
            entry.disabled
              ? 'cursor-default opacity-60'
              : 'cursor-pointer focus:bg-paper-100 dark:focus:bg-brownish-600',
            entry.danger ? 'text-redish-500 dark:text-redish-100' : ''
          ]"
          @click="activate(entry)"
          @pointermove="onItemPointerMove"
        >
          <BaseIcon v-if="entry.icon" class="m-1 shrink-0" :path="entry.icon" :size="15" />
          <span v-else class="w-6 mx-1 shrink-0" aria-hidden="true" />
          <span class="truncate">{{ entry.label }}</span>
          <span
            v-if="entry.shortcut"
            class="ml-auto pl-6 text-xs text-brownish-300 dark:text-brownish-50"
            aria-hidden="true"
          >{{ entry.shortcut }}</span>
        </div>
      </template>
    </div>
  </Teleport>
</template>
