<script setup lang="ts">
import TableFileRow from './TableFileRow.vue'
import scrollMonitor from 'scrollmonitor'
import type { AppFile } from 'types'
import { ref, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  file: AppFile
  selected: boolean
  hideDelete?: boolean
  share?: boolean
  selectionDisabled?: boolean
  highlighted?: boolean
  ancestors?: readonly AppFile[]
  sizes: {
    name: string
    size: string
    type: string
    modifiedAt: string
    buttons: string
  }
}>()

const emits = defineEmits<{
  (event: 'actions', file: AppFile): void
  (event: 'details', file: AppFile): void
  (event: 'download', file: AppFile): void
  (event: 'sharing', file: AppFile): void
  (event: 'remove', file: AppFile): void
  (event: 'rename', file: AppFile): void
  (event: 'fork', file: AppFile): void
  (event: 'leave', file: AppFile): void
  (event: 'row-click', origin: MouseEvent | KeyboardEvent, file: AppFile): void
  (event: 'upload-many', files: FileList, dirId?: string): void
}>()

const referenceObject = ref()
const visible = ref(false)

let elementWatcher: ReturnType<typeof scrollMonitor.create> | undefined

onMounted(() => {
  elementWatcher = scrollMonitor.create(referenceObject.value, 2000)
  elementWatcher.enterViewport(() => {
    visible.value = true
  }, false)

  elementWatcher.exitViewport(() => {
    visible.value = false
  }, false)
})

// scrollMonitor keeps every watcher in a global array it walks on each
// scroll event — an undestroyed one outlives its row, pointing at detached
// DOM and slowing every future scroll.
onUnmounted(() => {
  elementWatcher?.destroy()
})
</script>

<template>
  <Suspense>
    <div
      :class="{
        '!border !border-greeny-300 dark:!border-greeny-700': props.highlighted
      }"
      class="w-full flex pl-3 pt-3.5 pb-3.5 bg-paper-50 dark:bg-brownish-900"
      :data-row-placeholder="props.file.id"
      aria-hidden="true"
      v-if="!visible"
    >
      <div class="flex items-start">
        <div class="w-6 h-6 mr-2 rounded-md bg-paper-50 dark:bg-brownish-800"></div>
        <div class="w-32 h-6 mr-2 rounded-md bg-paper-50 dark:bg-brownish-800"></div>
      </div>
    </div>
    <TableFileRow
      v-else
      :file="props.file"
      :selected="props.selected"
      :hide-delete="props.hideDelete"
      :share="props.share"
      :selection-disabled="props.selectionDisabled"
      :sizes="props.sizes"
      :highlighted="props.highlighted"
      :ancestors="props.ancestors"
      @actions="(f: AppFile) => emits('actions', f)"
      @details="(f: AppFile) => emits('details', f)"
      @download="(f: AppFile) => emits('download', f)"
      @remove="(f: AppFile) => emits('remove', f)"
      @rename="(f: AppFile) => emits('rename', f)"
      @sharing="(f: AppFile) => emits('sharing', f)"
      @fork="(f: AppFile) => emits('fork', f)"
      @leave="(f: AppFile) => emits('leave', f)"
      @row-click="(e: MouseEvent | KeyboardEvent, f: AppFile) => emits('row-click', e, f)"
      @upload-many="(f: FileList, d?: string) => emits('upload-many', f, d)"
    />
  </Suspense>
  <div ref="referenceObject" :id="props.file.id" aria-hidden="true"></div>
</template>
