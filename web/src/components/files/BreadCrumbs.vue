<script setup lang="ts">
import type { AppFile } from 'types'
import BaseButton from '../ui/BaseButton.vue'
import FolderDropTarget from './FolderDropTarget.vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SHARED_WITH_ME_DIR_ID } from '!/storage'
import { activeDrag } from '!/storage/dragMove'

const { t } = useI18n()

const props = defineProps<{
  parents: AppFile[]
  parentId?: string
}>()

/**
 * The root crumb reflects the surface the user is browsing inside. When
 * the chain originates from incoming content (the synthetic
 * `__shared_with_me__` placeholder or any ancestor the caller doesn't own)
 * the recipient lands on "Shared with me"; owned content keeps "My Files".
 * Both root anchors route to their respective entry points so the user can
 * jump back without leaving the file browser.
 */
const inSharedContent = computed<boolean>(() => {
  const head = props.parents[0]
  if (!head) return false
  if (head.id === SHARED_WITH_ME_DIR_ID) return true
  return head.is_owner === false
})

const rootCrumb = computed(() =>
  inSharedContent.value
    ? {
        label: t('files.sharedWithMe'),
        to: { name: 'files', params: { file_id: SHARED_WITH_ME_DIR_ID } }
      }
    : {
        label: t('files.myFiles'),
        to: { name: 'files' }
      }
)

/**
 * The chain begins with either the synthetic root or the recipient's
 * shared-content head. Both already render through `rootCrumb`, so drop
 * them from the per-parent iteration to avoid duplicating the entry.
 */
const visibleParents = computed<AppFile[]>(() => {
  return props.parents.filter((p) => p.id !== SHARED_WITH_ME_DIR_ID)
})

const expanded = ref(false)

/**
 * Drop target of the root crumb: the account root (undefined) for owned
 * content, the synthetic "Shared with me" folder (never a valid target)
 * for incoming content.
 */
const SHARED_WITH_ME_TARGET = { id: SHARED_WITH_ME_DIR_ID, mime: 'dir' } as AppFile
const rootTarget = computed<AppFile | undefined>(() =>
  inSharedContent.value ? SHARED_WITH_ME_TARGET : undefined
)

/** Folder chain above `parent`, root-first, for drop validation. */
function ancestorsOf(parent: AppFile): AppFile[] {
  const index = props.parents.findIndex((p) => p.id === parent.id)
  return index === -1 ? [] : props.parents.slice(0, index)
}

const DROP_OVER_CLASS = 'rounded-md bg-primary-100/20 ring-2 ring-primary-100'

// Dragging over the collapsed "..." reveals the hidden crumbs as drop targets.
const revealOnDrag = () => {
  if (activeDrag.value) expanded.value = true
}

const skipIndexes = computed<number[]>(() => {
  if (expanded.value || visibleParents.value.length < 3) {
    return []
  }
  return visibleParents.value
    .slice(1, visibleParents.value.length - 2)
    .map((_, index) => index + 1)
})
</script>

<template>
  <nav :aria-label="$t('files.breadcrumbs')">
    <ol class="flex mb-2">
      <FolderDropTarget as="li" :target="rootTarget" :ancestors="[]" :over-class="DROP_OVER_CLASS">
        <BaseButton
          :to="rootCrumb.to"
          :label="rootCrumb.label"
          :disabled="!visibleParents.length"
          no-border
          class="pl-1 pr-1 text-lg"
          data-testid="breadcrumb-root"
        />
      </FolderDropTarget>

      <template v-for="(parent, index) in visibleParents" v-bind:key="index">
        <li v-if="skipIndexes.indexOf(index) === -1">
          <span> / </span>
          <FolderDropTarget
            as="span"
            class="inline-block"
            :target="parent"
            :ancestors="ancestorsOf(parent)"
            :over-class="DROP_OVER_CLASS"
          >
            <BaseButton
              :to="{ name: 'files', params: { file_id: parent.id } }"
              :label="`${parent.name || '...'}`"
              no-border
              class="pl-1 pr-1 text-lg"
            />
          </FolderDropTarget>
        </li>
        <li v-else-if="skipIndexes[0] === index" @dragenter="revealOnDrag">
          <span> / </span>
          <BaseButton
            label="..."
            no-border
            :title="$t('files.breadcrumbsShowAll')"
            class="pl-1 pr-1 text-lg"
            data-testid="breadcrumb-expand"
            @click="expanded = true"
          />
        </li>
      </template>
    </ol>
  </nav>
</template>
