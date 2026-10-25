<script setup lang="ts">
import { computed, ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { mdiChevronDown } from '@mdi/js'
import BaseIcon from '@/components/ui/BaseIcon.vue'

const props = withDefaults(
  defineProps<{
    expandLabel: string
    collapseLabel: string
    collapsedHeight?: number
  }>(),
  { collapsedHeight: 256 }
)

const content = ref<HTMLElement>()
const contentHeight = ref(0)
const expanded = ref(false)

useResizeObserver(content, () => {
  contentHeight.value = content.value?.offsetHeight ?? 0
})

const overflows = computed(() => contentHeight.value > props.collapsedHeight)
const collapsed = computed(() => overflows.value && !expanded.value)

// An explicit pixel height on both ends lets max-height animate; content that
// fits is left unconstrained so it never clips before the observer catches up.
const maxHeight = computed(() => {
  if (collapsed.value) return `${props.collapsedHeight}px`
  if (overflows.value) return `${contentHeight.value}px`
  return undefined
})

// A click anywhere on the collapsed content expands it, except on controls
// inside it (such as sort headers) that have a job of their own.
const expandFromClick = (event: MouseEvent) => {
  if (!collapsed.value) return
  if ((event.target as HTMLElement).closest('button, a, input, select')) return
  expanded.value = true
}
</script>

<template>
  <div>
    <div
      class="relative overflow-hidden transition-[max-height] duration-300"
      :class="{ 'cursor-pointer': collapsed }"
      :style="{ maxHeight }"
      data-testid="expandable-box-content"
      @click="expandFromClick"
    >
      <div ref="content">
        <slot />
      </div>
      <div
        v-if="collapsed"
        class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white dark:from-brownish-900"
      />
    </div>
    <button
      v-if="overflows"
      type="button"
      class="w-full flex items-center justify-center gap-1 pt-2 text-xs font-semibold text-brownish-400 dark:text-brownish-50 hover:text-brownish-700 dark:hover:text-white transition-colors"
      :aria-expanded="expanded"
      data-testid="expandable-box-toggle"
      @click="expanded = !expanded"
    >
      <span>{{ expanded ? collapseLabel : expandLabel }}</span>
      <BaseIcon
        :path="mdiChevronDown"
        :size="16"
        class="transition-transform duration-200"
        :class="{ 'rotate-180': expanded }"
      />
    </button>
  </div>
</template>
