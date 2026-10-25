<script setup lang="ts">
import ActionsDropdown from '@/components/files/browser/ActionsDropdown.vue'
import FileThumbnail from '@/components/files/FileThumbnail.vue'
import FileIconTile from '@/components/files/FileIconTile.vue'
import TruncatedSpan from '@/components/ui/TruncatedSpan.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseIcon from '@/components/ui/BaseIcon.vue'
import { formatPrettyDate, formatSize } from '!'
import {
  mdiDotsVertical,
  mdiAlertCircleOutline,
  mdiCloudSyncOutline,
  mdiFolderAccount,
  mdiShareVariantOutline,
  mdiUploadOutline
} from '@mdi/js'
import type { AppFile } from 'types'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { isPreviewable, isMarkdownFile } from '!/preview'
import { SHARED_WITH_ME_DIR_ID } from '!/storage'
import { activeDrag, isInternalFileDrag } from '!/storage/dragMove'
import { store as uploadStore } from '!/storage/upload'
import { useFolderDropTarget } from '@/composables/useFolderDropTarget'
import { prettyMime } from '@/utils/mime'

const router = useRouter()
const { t } = useI18n()

const isDropZone = ref(false)

const props = defineProps<{
  file: AppFile
  selected: boolean
  hideDelete?: boolean
  share?: boolean
  selectionDisabled?: boolean
  highlighted?: boolean
  /** The current folder's chain, root-first and ending with the current folder. */
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


const upload = uploadStore()

const isUnfinished = computed(() => {
  return props.file.mime !== 'dir' && !props.file.finished_upload_at
})

/**
 * The upload queue lives in memory, so after a refresh an unfinished row
 * has no transfer behind it anymore. Live progress renders only for rows
 * the queue is actually working on; the rest surface as stalled uploads
 * instead of sitting on a progress bar that will never move.
 */
const showProgress = computed(() => {
  if (!isUnfinished.value) {
    return false
  }

  return (
    upload.running.some((item) => item.id === props.file.id) ||
    upload.waiting.some((item) => item.id === props.file.id)
  )
})

const isStalledUpload = computed(() => isUnfinished.value && !showProgress.value)

const isDir = computed(() => {
  return props.file.mime === 'dir'
})

const fileName = computed(() => {
  const name = props.file.name || '...'

  return props.file.mime === 'dir' ? `${name}/` : name
})

const fileSize = computed(() => {
  return props.file.size ? formatSize(props.file.size) : ''
})

const fileModifiedAt = computed(() => {
  return props.file.file_modified_at ? formatPrettyDate(props.file.file_modified_at) : ''
})

const progressValue = computed(() => {
  const total = props.file.chunks

  if (props.file.finished_upload_at) {
    return 100
  }

  if (!total) {
    return 0
  }

  const uploaded = props.file.chunks_stored || 0
  const progress = uploaded / total
  return Math.ceil(progress * 100)
})

// Selection keeps its own hover shade so a hovered selected row still reads as selected.
const rowClass = computed(() => {
  if (props.selected) {
    return 'file-row-selected bg-orangy-500/20 hover:bg-orangy-500/30 dark:bg-orangy-500/15 dark:hover:bg-orangy-500/25'
  }
  return 'dark:bg-brownish-900 hover:bg-paper-100 hover:dark:bg-brownish-700'
})

/**
 * Owner-of-row email surfaced next to the file name when the caller does
 * not own the row. `owner_email` is the server-side ground truth from the
 * storage listing; `shared_by_email` is the synthetic-root fallback the
 * incoming-share mapper sets when listing `__shared_with_me__`. Owned
 * rows skip the badge — the caller already knows whose folder they are
 * sitting in.
 */
const ownerBadgeEmail = computed(() => {
  if (props.file.is_owner) return ''
  return props.file.owner_email || props.file.shared_by_email || ''
})

/**
 * Inline hint next to the name when the caller (as owner) has shared
 * this row with at least one other account. Recipient-side rows surface
 * an "owned by" badge instead, so this stays hidden on incoming shares.
 */
const isSharedOut = computed(() => {
  if (!props.file.is_owner) return false
  return (props.file.shared_with_count ?? 0) > 0
})

const sharedOutTitle = computed(() =>
  t('files.row.sharedWith', props.file.shared_with_count ?? 0)
)

/**
 * The synthetic "Shared with me" root is rendered as an injected
 * navigation affordance, not a real `user_files` row. Selecting or
 * actioning it would push the synthetic id into endpoints that demand a
 * UUID, so the checkbox and dropdown stay hidden — only the click-through
 * to navigate into the virtual folder remains.
 */
const isSyntheticRoot = computed(() => props.file.id === SHARED_WITH_ME_DIR_ID)

const isSelectable = computed(() => !props.selectionDisabled && !isSyntheticRoot.value)

// Only a selected row drags, and it carries the whole selection with it; a
// press on an unselected row starts the rubber band instead.
const isDraggable = computed(() => props.selected && isSelectable.value)

const isBeingMoved = computed(() => !!activeDrag.value?.ids.has(props.file.id))

const border = 'sm:border-l sm:border-paper-300 sm:dark:border-brownish-950'
const sizes = computed(() => {
  return {
    name: `${props.sizes.name}`,
    size: `${border} ${props.sizes.size}`,
    type: `${border} ${props.sizes.type}`,
    modifiedAt: `${border} ${props.sizes.modifiedAt}`,
    buttons: `${props.sizes.buttons} text-right`
  }
})

const navButton = ref<HTMLButtonElement | null>(null)

// The ⋮ button and its dropdown live inside the row, but their clicks are theirs.
const fromActions = (event: Event) =>
  !!(event.target as Element | null)?.closest('[data-row-actions]')

/**
 * What a click means for the selection is decided by the table, which knows
 * the anchor and the rest of the list. Clicking anywhere on the row also
 * focuses it, so the arrow keys carry on from there.
 */
const click = (event: MouseEvent) => {
  if (fromActions(event)) return
  if (document.activeElement !== navButton.value) navButton.value?.focus({ preventScroll: true })
  emits('row-click', event, props.file)
}

/**
 * The browser already knows what a double click is, and it knows it at the
 * speed the reader configured. This used to be a hand-rolled 250ms counter,
 * which made diving into folders feel like it was thinking about it.
 */
const doubleClick = (event: MouseEvent) => {
  if (fromActions(event)) return
  open()
}

const open = () => {
  if (isDir.value) {
    router.push({ name: 'files', params: { file_id: props.file.id } })
  } else {
    detailsOrPreview()
  }
}

const canWriteMarkdown = computed(() => {
  // Owners always; recipients only if their role allows writes. The
  // editor's save toolbar wires through `preview.editable` which is
  // the file row's editable flag — true for every markdown file — so
  // the routing decision is the place to gate Readers out of the
  // editor and into the read-only preview instead.
  if (props.file.is_owner) return true
  const role = props.file.share_role
  return role === 'editor' || role === 'co-owner'
})

const detailsOrPreview = () => {
  if (props.file.finished_upload_at && isMarkdownFile(props.file) && canWriteMarkdown.value) {
    router.push({ name: 'notes', params: { id: props.file.id } })
  } else if (isPreviewable(props.file)) {
    router.push({ name: 'file-preview', params: { id: props.file.id } })
  } else {
    emits('details', props.file)
  }
}

/**
 * Folder rows take the selection dragged from another row. Hovering one for a
 * moment opens it, so the items can be carried further down, like Finder's
 * spring-loaded folders.
 */
const moveTarget = useFolderDropTarget(
  () => props.file,
  () => props.ancestors ?? [],
  {
    disabled: () => !isDir.value,
    onSpringLoad: () => router.push({ name: 'files', params: { file_id: props.file.id } })
  }
)
const isMoveTarget = moveTarget.isOver

// The upload handlers below are for files dragged in from the OS; a drag of
// the user's own rows goes to `moveTarget`, or bubbles up from a file row to
// the listing's own drop target.
const dragenter = (e: DragEvent) => {
  if (isInternalFileDrag(e)) {
    if (isDir.value) moveTarget.onDragenter(e)
    return
  }
  dragover(e)
}

const dragleave = (e: DragEvent) => {
  if (isInternalFileDrag(e)) {
    if (isDir.value) moveTarget.onDragleave(e)
    return
  }
  if (props.file.mime !== 'dir') {
    return
  }

  isDropZone.value = false

  e.preventDefault()
  e.stopPropagation()
}

const dragover = (e: DragEvent) => {
  if (isInternalFileDrag(e)) {
    if (isDir.value) moveTarget.onDragover(e)
    return
  }
  if (props.file.mime !== 'dir') {
    return
  }

  isDropZone.value = true

  e.preventDefault()
  e.stopPropagation()
}

const drop = (e: DragEvent) => {
  if (isInternalFileDrag(e)) {
    if (isDir.value) moveTarget.onDrop(e)
    return
  }
  if (props.file.mime !== 'dir') {
    return
  }

  isDropZone.value = false

  e.preventDefault()
  e.stopPropagation()

  if (e.dataTransfer?.files && e.dataTransfer.files.length) {
    emits('upload-many', e.dataTransfer.files, props.file.id)

    setTimeout(() => {
      router.push({ name: 'files', params: { file_id: props.file.id } })
    }, 100)
  }
}
</script>

<template>
  <div
    @dragenter="dragenter"
    @dragleave="dragleave"
    @dragend="isDropZone = false"
    @dragover="dragover"
    @drop="drop"
    :data-testid="`file-row-${file.name}`"
    :data-file-id="file.id"
    :draggable="isDraggable ? 'true' : undefined"
    :data-drop-over="isMoveTarget ? 'true' : undefined"
    role="row"
    :aria-selected="isSelectable ? props.selected : undefined"
    class="w-full flex file-row-separator file-row prevent-select"
    :class="{
      [rowClass]: true,
      'opacity-50': isBeingMoved,
      '!bg-orangy-500/20 outline outline-2 -outline-offset-2 outline-orangy-500 z-10':
        isMoveTarget,
      'outline-2 outline-redish-300 outline z-10': isDropZone,
      'outline outline-1 -outline-offset-1 outline-greeny-300 dark:outline-greeny-700':
        props.highlighted && !isDropZone && !isMoveTarget
    }"
    @click="click"
    @dblclick="doubleClick"
  >
    <div role="gridcell" class="flex flex-1 min-w-0">
      <button
        ref="navButton"
        :class="`${sizes.name} flex justify-start cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-redish-400/60 dark:focus-visible:ring-redish-500/50`"
        :title="fileName"
        data-row-nav
        @keydown.space.prevent="(e: KeyboardEvent) => emits('row-click', e, file)"
        @keydown.enter.prevent="open"
      >
        <FileThumbnail :file="file" img-class="w-6 h-6 mr-2 rounded-md shrink-0">
          <FileIconTile
            v-if="showProgress"
            :path="mdiUploadOutline"
            tile-class="w-6 h-6 mr-2"
            icon-class="text-greeny-500 dark:text-greeny-300"
            data-testid="uploading-icon"
          />
          <FileIconTile
            v-else-if="isStalledUpload"
            :path="mdiAlertCircleOutline"
            tile-class="w-6 h-6 mr-2"
            icon-class="text-orangy-800 dark:text-orangy-400"
            :title="$t('files.row.uploadIncomplete')"
            data-testid="stalled-upload-icon"
          />
          <FileIconTile
            v-else-if="file.id === SHARED_WITH_ME_DIR_ID"
            :path="mdiFolderAccount"
            tile-class="w-6 h-6 mr-2"
            icon-class="text-orangy-800 dark:text-orangy-400"
            data-testid="shared-with-me-folder-icon"
          />
          <FileIconTile v-else :mime="file.mime" tile-class="w-6 h-6 mr-2" />
        </FileThumbnail>

        <TruncatedSpan :text="fileName" />
        <span
          v-if="isSharedOut"
          class="ml-2 inline-flex items-center text-brownish-400 dark:text-brownish-50"
          :title="sharedOutTitle"
          data-testid="shared-out-badge"
        >
          <BaseIcon :path="mdiShareVariantOutline" :size="14" />
        </span>
        <!-- Saving-in-another-session badge. Surfaced as soon as the
             server reports a pending_version on the row so users get a
             heads-up before they try to edit and run into a 409. -->
        <span
          v-if="file.pending_version != null"
          class="ml-2 inline-flex items-center text-orangy-800 dark:text-orangy-400"
          :title="$t('files.row.savingInAnotherSession')"
        >
          <BaseIcon :path="mdiCloudSyncOutline" :size="14" />
        </span>
        <span
          v-if="ownerBadgeEmail"
          class="ml-2 inline-flex items-center max-w-[10rem] truncate px-2 py-0.5 rounded-full text-xs font-semibold bg-paper-100 dark:bg-brownish-800 text-brownish-700 dark:text-brownish-50"
          :title="$t('files.row.ownedBy', { email: ownerBadgeEmail })"
          data-testid="shared-by-badge"
        >
          {{ ownerBadgeEmail }}
        </span>
      </button>
    </div>

    <div role="gridcell" :class="sizes.size" :title="fileSize">
      <span>{{ fileSize || '-' }}</span>
    </div>

    <div role="gridcell" :class="sizes.type" :title="props.file.mime">
      <TruncatedSpan :text="prettyMime(props.file.mime)" />
    </div>

    <div role="gridcell" :class="sizes.modifiedAt" :title="fileModifiedAt">
      <TruncatedSpan :text="fileModifiedAt" />
    </div>

    <div role="gridcell" :class="sizes.buttons" data-row-actions>
      <template v-if="!isSyntheticRoot">
        <BaseButton
          class="ml-2 sm:hidden float-right"
          color="dark"
          :icon="mdiDotsVertical"
          small
          name="actions-modal"
          :title="$t('common.actions')"
          :aria-label="$t('common.actions')"
          aria-haspopup="menu"
          @click="emits('actions', file)"
          :disabled="!props.file.id"
        />
        <ActionsDropdown
          class="ml-2 hidden sm:block float-right"
          :model-value="props.file"
          :disabled="!props.file.id"
          :hide-delete="props.hideDelete"
          :share="props.share"
          @details="(f: AppFile) => emits('details', f)"
          @download="(f: AppFile) => emits('download', f)"
          @remove="(f: AppFile) => emits('remove', f)"
          @rename="(f: AppFile) => emits('rename', f)"
          @sharing="(f: AppFile) => emits('sharing', f)"
          @fork="(f: AppFile) => emits('fork', f)"
          @leave="(f: AppFile) => emits('leave', f)"
        />
      </template>
    </div>
  </div>

  <div
    v-if="showProgress"
    aria-hidden="true"
    class="border-b-2 border-greeny-500 dark:border-greeny-400 -mt-[1px]"
    :style="{
      width: progressValue + '%'
    }"
  ></div>
</template>
<style lang="css">
.prevent-select {
  -webkit-user-select: none;
  -ms-user-select: none;
  user-select: none;
}

.file-row-separator {
  box-shadow: inset 0 -1px 0 0 rgba(120, 120, 120, 0.15);
}

.dark .file-row-separator {
  box-shadow: inset 0 -1px 0 0 rgba(120, 120, 120, 0.1);
}

/* orangy-500, the same accent as the sidebar's active item */
.file-row-separator.file-row-selected {
  box-shadow:
    inset 3px 0 0 0 #ee9b5c,
    inset 0 -1px 0 0 rgba(120, 120, 120, 0.15);
}

.dark .file-row-separator.file-row-selected {
  box-shadow:
    inset 3px 0 0 0 #ee9b5c,
    inset 0 -1px 0 0 rgba(120, 120, 120, 0.1);
}

/* A long press selects the row; iOS would otherwise raise its link/image callout. */
.file-row {
  -webkit-touch-callout: none;
}
</style>
