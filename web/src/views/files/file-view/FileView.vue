<script lang="ts">
export default { inheritAttrs: false }
</script>

<script setup lang="ts">
import PreviewView from '@/components/preview/PreviewView.vue'
import SpinnerIcon from '@/components/ui/SpinnerIcon.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useRoute, useRouter } from 'vue-router'
import type { FilesStore, KeyPair, AppFile } from 'types'
import { ref, watch } from 'vue'
import { FilePreview } from '!/preview/file'
import type { Preview } from '!/preview'
import { useTitle } from '@vueuse/core'
import { humanizeError } from '!/notify'
import type { ErrorResponse } from '!/api'

const props = defineProps<{
  kp: KeyPair
  Storage: FilesStore
}>()

const emits = defineEmits<{
  (event: 'actions', file: AppFile): void
  (event: 'browse'): void
  (event: 'deselect-all'): void
  (event: 'details', file: AppFile): void
  (event: 'directory'): void
  (event: 'download-many'): void
  (event: 'download', file: AppFile): void
  (event: 'link', file: AppFile): void
  (event: 'move-all'): void
  (event: 'remove-all'): void
  (event: 'remove', file: AppFile): void
  (event: 'rename', file: AppFile): void
  (event: 'select-all', files: AppFile[], fileId: string | null | undefined): void
  (event: 'select-one', select: boolean, file: AppFile): void
  (event: 'set-sort-simple', value: string): void
  (event: 'upload-many', files: FileList, dirId?: string): void
  (event: 'browse-folder'): void
  (event: 'upload-folder-entries', entries: FileSystemEntry[], dirId?: string): void
}>()

const title = useTitle()
const router = useRouter()
const route = useRoute()
const file = ref()
const preview = ref()

/**
 * Set when the file can't be shown: `notFound` for a 404 (deleted, in trash,
 * or never shared with this account — the server answers all of these the
 * same way), otherwise the reason, with a retry.
 */
const notFound = ref(false)
const loadError = ref<string>()

function currentId(): string | undefined {
  const id = route.params.id
  return Array.isArray(id) ? id[0] : id
}

async function open(fileId: string): Promise<void> {
  notFound.value = false
  loadError.value = undefined

  // The browser has usually already decrypted this row, and it carries
  // everything a preview needs. Mounting from it puts the frame and the
  // thumbnail on screen straight away instead of holding a blank view
  // for the round trip; a deep link with nothing cached still waits.
  const cached = props.Storage.getItem(fileId)

  if (cached?.key) {
    file.value = cached
    preview.value = new FilePreview(cached, props.kp)
  } else {
    preview.value = undefined
    let fetched: AppFile
    try {
      fetched = await props.Storage.metadata(fileId, props.kp)
    } catch (err) {
      // A slow answer for a file the user already navigated away from
      // must not take over the view of the next one.
      if (currentId() !== fileId) return
      if ((err as ErrorResponse<unknown>)?.status === 404) notFound.value = true
      else loadError.value = humanizeError(err)
      return
    }
    if (currentId() !== fileId) return
    file.value = fetched
    preview.value = new FilePreview(fetched, props.kp)
  }

  title.value = `${file.value.name} -- ${window.defaultDocumentTitle}`

  props.Storage.deselectAll()
  props.Storage.selectOne(true, file.value)

  // Siblings only feed the previous/next arrows, so this listing runs
  // alongside the image rather than in front of it.
  preview.value.loadItems().catch(() => {
    // Navigation stays on the current file; nothing else depends on it.
  })
}

function retry(): void {
  const id = currentId()
  if (id) void open(id)
}

watch(
  () => route.params.id,
  (id: string[] | string) => {
    if (!id) return
    void open(Array.isArray(id) ? id[0] : id)
  },
  { immediate: true }
)

/**
 * Navigate to the next or previous file
 */
const nextOrPrevious = (id: string | undefined) => {
  if (!id) return

  router.push({
    name: 'file-preview',
    params: { id }
  })
}

const cancel = (preview: Preview) => {
  router.push({
    name: 'files',
    params: { file_id: preview.parentId },
    hash: `#${preview.id}`
  })
}
</script>
<template>
  <!-- The stage appears the moment the route does; a deep link is still
       fetching metadata at this point and would otherwise show nothing. -->
  <div
    v-if="notFound"
    class="fixed top-0 left-0 flex flex-col gap-4 items-center justify-center w-full h-full bg-brownish-950 text-brownish-100"
    data-testid="file-preview-not-found"
    role="alert"
  >
    <p>{{ $t('errors.file_not_found') }}</p>
    <BaseButton :label="$t('common.back')" color="light" small :to="{ name: 'files' }" />
  </div>
  <div
    v-else-if="loadError"
    class="fixed top-0 left-0 flex flex-col gap-4 items-center justify-center w-full h-full bg-brownish-950 text-brownish-100"
    data-testid="file-preview-error"
    role="alert"
  >
    <p>{{ loadError }}</p>
    <div class="flex gap-2">
      <BaseButton :label="$t('common.retry')" color="light" small @click="retry" />
      <BaseButton :label="$t('common.back')" color="light" small :to="{ name: 'files' }" />
    </div>
  </div>
  <div
    v-else-if="!preview"
    class="fixed top-0 left-0 flex items-center justify-center w-full h-full bg-brownish-950 text-brownish-100"
  >
    <SpinnerIcon />
  </div>
  <PreviewView
    v-else
    v-model="preview"
    :hideDelete="file?.is_owner === false"
    :hidePreviousAndNext="false"
    @details="emits('details', file)"
    @download="emits('download', file)"
    @remove="emits('remove', file)"
    @previous="nextOrPrevious"
    @next="nextOrPrevious"
    @cancel="cancel"
  />
</template>
