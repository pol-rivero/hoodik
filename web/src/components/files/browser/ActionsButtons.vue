<script setup lang="ts">
import PureButton from '@/components/ui/PureButton.vue'
import {
  mdiTrashCan,
  mdiEye,
  mdiDownload,
  mdiPencil,
  mdiShareVariantOutline,
  mdiContentSave,
  mdiAccountArrowLeft
} from '@mdi/js'
import { useCapability } from '@/composables/useCapability'
import { fileCapabilities } from './fileMenuItems'
import type { AppFile } from 'types'
import { computed } from 'vue'

const props = defineProps<{
  modelValue: AppFile
  hideDelete?: boolean
  share?: boolean
}>()

const emits = defineEmits<{
  (event: 'update:modelValue', value: AppFile | undefined): void
  (event: 'details', file: AppFile): void
  (event: 'remove', file: AppFile): void
  (event: 'sharing', file: AppFile): void
  (event: 'rename', file: AppFile): void
  (event: 'download', file: AppFile): void
  (event: 'fork', file: AppFile): void
  (event: 'leave', file: AppFile): void
}>()

const { sharingEnabled, forkEnabled } = useCapability()

const file = computed(() => props.modelValue)

const can = computed(() =>
  fileCapabilities(file.value, {
    sharingEnabled: sharingEnabled.value,
    forkEnabled: forkEnabled.value,
    hideDelete: props.hideDelete
  })
)
</script>

<template>
  <PureButton
    v-if="can.details"
    :icon="mdiEye"
    @click="emits('details', file)"
    :label="$t('files.actions.details')"
    name="details"
    class="block text-left p-2 sm:p-0 border-brownish-800 w-full hover:bg-paper-100 dark:hover:bg-brownish-600"
  />

  <PureButton
    v-if="can.rename"
    :icon="mdiPencil"
    @click="emits('rename', file)"
    :label="$t('common.rename')"
    name="rename"
    class="block text-left p-2 sm:p-0 border-brownish-800 w-full hover:bg-paper-100 dark:hover:bg-brownish-600"
  />

  <PureButton
    v-if="can.preview"
    :icon="mdiEye"
    :to="{
      name: 'file-preview',
      params: { id: file.id }
    }"
    :label="$t('files.actions.preview')"
    name="preview"
    class="block text-left p-2 sm:p-0 border-brownish-800 w-full hover:bg-paper-100 dark:hover:bg-brownish-600"
  />

  <PureButton
    :icon="mdiDownload"
    @click="emits('download', file)"
    v-if="can.download"
    :label="$t('common.download')"
    name="download"
    class="block text-left p-2 sm:p-0 border-brownish-800 w-full hover:bg-paper-100 dark:hover:bg-brownish-600"
  />

  <PureButton
    v-if="can.sharing"
    :icon="mdiShareVariantOutline"
    @click="emits('sharing', file)"
    :label="$t('files.actions.sharing')"
    name="sharing"
    data-testid="actions-share-account"
    class="block text-left p-2 sm:p-0 border-brownish-800 w-full hover:bg-paper-100 dark:hover:bg-brownish-600"
  />

  <PureButton
    v-if="can.fork"
    :icon="mdiContentSave"
    @click="emits('fork', file)"
    :label="$t('files.actions.fork')"
    :title="$t('files.actions.forkTitle')"
    name="fork"
    data-testid="actions-fork"
    class="block text-left p-2 sm:p-0 border-brownish-800 w-full hover:bg-paper-100 dark:hover:bg-brownish-600"
  />

  <PureButton
    v-if="can.leave"
    :icon="mdiAccountArrowLeft"
    @click="emits('leave', file)"
    :label="$t('common.remove')"
    name="leave"
    data-testid="actions-leave"
    class="block text-left p-2 sm:p-0 border-brownish-800 w-full hover:bg-paper-100 dark:hover:bg-brownish-600"
  />

  <PureButton
    v-if="can.remove"
    :icon="mdiTrashCan"
    @click="emits('remove', file)"
    :label="$t('files.delete.trashLabel')"
    name="delete"
    class="block text-left p-2 sm:p-0 w-full mt-1 pt-1 border-t border-paper-300 dark:border-brownish-600 text-redish-500 dark:text-redish-100 hover:bg-paper-100 dark:hover:bg-brownish-600"
  />
</template>
