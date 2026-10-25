<script setup lang="ts">
import { useFolderDropTarget } from '@/composables/useFolderDropTarget'
import type { AppFile } from 'types'

/**
 * Element wrapper that makes one folder (or the account root, when `target`
 * is undefined) accept files dragged with `beginFileDrag`. For lists, where
 * `useFolderDropTarget` can't be called per item.
 */
const props = withDefaults(
  defineProps<{
    target?: AppFile
    /** The target's folder chain, root-first, excluding the target. */
    ancestors: readonly AppFile[]
    as?: string
    /** Classes added while a valid drag hovers. */
    overClass?: string
    disabled?: boolean
    springLoad?: boolean
  }>(),
  { as: 'div', overClass: '', disabled: false, springLoad: false }
)

const emit = defineEmits<{ 'spring-load': [] }>()

const { isOver, listeners } = useFolderDropTarget(
  () => props.target,
  () => props.ancestors,
  {
    disabled: () => props.disabled,
    onSpringLoad: () => {
      if (props.springLoad) emit('spring-load')
    }
  }
)
</script>

<template>
  <component
    :is="props.as"
    :class="isOver ? props.overClass : undefined"
    :data-drop-over="isOver ? 'true' : undefined"
    v-on="listeners"
  >
    <slot :is-over="isOver" />
  </component>
</template>
