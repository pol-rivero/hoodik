<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import MoveIntoSharedConfirmModal from '@/components/files/modals/MoveIntoSharedConfirmModal.vue'
import {
  moveConfirmState as state,
  registerMoveConfirmHost,
  resolveMoveConfirm
} from '!/storage/moveConfirm'

let unregister: (() => void) | null = null
onMounted(() => {
  unregister = registerMoveConfirmHost()
})
onUnmounted(() => unregister?.())

// Closing the dialog any other way (X, Escape, backdrop) is a decline, or the
// move awaiting the answer would hang. Deferred because the modal also
// reports itself hidden right before emitting `confirm`.
const onVisible = (visible: boolean) => {
  if (!visible) queueMicrotask(() => resolveMoveConfirm(false))
}
</script>

<template>
  <MoveIntoSharedConfirmModal
    :model-value="state.visible"
    :folder-name="state.folderName"
    :destination-name="state.destinationName"
    :item-count="state.itemCount"
    :member-labels="state.memberLabels"
    :progress="state.progress"
    :file-count="state.fileCount"
    @update:model-value="onVisible"
    @confirm="resolveMoveConfirm(true)"
    @cancel="resolveMoveConfirm(false)"
  />
</template>
