<script setup lang="ts">
import ContextMenu from '@/components/ui/ContextMenu.vue'
import {
  useContextMenu,
  type ContextMenuCloseReason,
  type ContextMenuItem
} from '@/composables/useContextMenu'
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'

/**
 * Renders the single app-wide context menu. Mount it once near the root;
 * anything can then open a menu through `useContextMenu().open`.
 */
const { menu, close, select } = useContextMenu()

// Path only: a hash-only push (scrolling to a search hit) isn't leaving the page.
const route = useRoute()
watch(
  () => route.path,
  () => close({ restoreFocus: false })
)

// Bound per menu, so a menu on its way out can't close or act for its replacement.
const handlers = computed(() => {
  const id = menu.value?.id
  return {
    select: (item: ContextMenuItem) => select(item, { id }),
    // The press that dismissed the menu is about to focus its own target.
    close: (reason: ContextMenuCloseReason) => close({ id, restoreFocus: reason !== 'outside' })
  }
})
</script>

<template>
  <ContextMenu
    v-if="menu"
    :key="menu.id"
    :x="menu.x"
    :y="menu.y"
    :items="menu.items"
    :label="menu.label"
    :anchor="menu.anchor"
    @select="handlers.select"
    @close="handlers.close"
  />
</template>
