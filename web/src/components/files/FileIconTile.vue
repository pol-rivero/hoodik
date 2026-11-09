<script setup lang="ts">
import { computed } from 'vue'
import {
  mdiFileLinkOutline,
  mdiFileOutline,
  mdiFolder,
  mdiFolderArrowRight,
  mdiLinkVariantOff
} from '@mdi/js'
import BaseIcon from '@/components/ui/BaseIcon.vue'

/**
 * Rounded-square stand-in for files without a thumbnail, so every row
 * carries a tile of the same shape whether or not it has an image.
 */
const props = defineProps<{
  mime?: string
  /** For a shortcut: its target's mime, null when the target is gone. */
  targetMime?: string | null
  /** Overrides the generic folder/file glyph. */
  path?: string
  /** Size + spacing classes, matching the thumbnail's. */
  tileClass?: string
  /** Glyph colour classes. */
  iconClass?: string
  size?: number
}>()

const mimeIcon = () => {
  if (props.mime === 'dir') return mdiFolder
  if (props.mime !== 'shortcut') return mdiFileOutline
  if (!props.targetMime) return mdiLinkVariantOff
  return props.targetMime === 'dir' ? mdiFolderArrowRight : mdiFileLinkOutline
}

const iconPath = computed(() => props.path ?? mimeIcon())
</script>

<template>
  <BaseIcon
    :path="iconPath"
    :size="size ?? 16"
    w=""
    h=""
    class="shrink-0 rounded-md bg-paper-200 dark:bg-brownish-600"
    :class="[
      tileClass ?? 'w-6 h-6',
      iconClass ?? 'text-brownish-200 dark:text-brownish-50'
    ]"
  />
</template>
