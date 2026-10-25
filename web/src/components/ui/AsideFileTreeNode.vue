<script setup lang="ts">
import { computed } from 'vue'
import { mdiFolder, mdiFolderOpen, mdiFileDocumentOutline, mdiFileOutline, mdiChevronRight, mdiChevronDown } from '@mdi/js'
import { isMarkdownFile } from '!/preview'
import type { AppFile } from 'types'
import BaseIcon from '@/components/ui/BaseIcon.vue'
import FolderDropTarget from '@/components/files/FolderDropTarget.vue'

interface TreeNode {
  file: AppFile
  children: TreeNode[]
  loaded: boolean
  loading: boolean
}

const props = defineProps<{
  node: TreeNode
  depth: number
  /** Folder chain above this node, root-first. */
  ancestors: readonly AppFile[]
  expanded: Set<string>
  activeFileId?: string
  activeFolderId?: string
}>()

const emit = defineEmits<{
  /** Click: expand/collapse (loading children) and navigate. */
  'toggle-folder': [node: TreeNode]
  /** Drag spring-loading: expand without navigating. */
  'expand-folder': [node: TreeNode]
  'file-click': [file: AppFile]
}>()

const DROP_OVER_CLASS = '!bg-orangy-500/25 !text-white ring-1 ring-inset ring-orangy-400'

const padLeft = `padding-left: ${props.depth * 16 + 8}px`

const childAncestors = computed(() => [...props.ancestors, props.node.file])

function iconFor(file: AppFile): string {
  if (file.mime === 'dir') {
    return props.expanded.has(file.id) ? mdiFolderOpen : mdiFolder
  }
  if (isMarkdownFile(file)) return mdiFileDocumentOutline
  return mdiFileOutline
}

function springExpand() {
  if (!props.expanded.has(props.node.file.id)) emit('expand-folder', props.node)
}
</script>

<template>
  <FolderDropTarget
    v-if="node.file.mime === 'dir'"
    as="li"
    :target="node.file"
    :ancestors="ancestors"
    :over-class="DROP_OVER_CLASS"
    spring-load
    :title="node.file.name"
    class="flex items-center gap-1 py-1 cursor-pointer transition-colors duration-150"
    :class="
      node.file.id === activeFolderId
        ? 'bg-orangy-500/15 text-orangy-300'
        : 'text-brownish-50 hover:bg-brownish-700/50 hover:text-white'
    "
    :style="padLeft"
    @click="emit('toggle-folder', node)"
    @spring-load="springExpand"
  >
    <BaseIcon
      :path="expanded.has(node.file.id) ? mdiChevronDown : mdiChevronRight"
      :size="12"
      class="flex-shrink-0 text-brownish-100"
    />
    <BaseIcon :path="iconFor(node.file)" :size="14" class="flex-shrink-0 text-orangy-400" />
    <span class="truncate">{{ node.file.name }}</span>
  </FolderDropTarget>

  <template v-if="node.file.mime === 'dir' && expanded.has(node.file.id)">
    <li v-if="node.loading" class="py-1 text-brownish-50" :style="`padding-left: ${(depth + 1) * 16 + 24}px`">
      {{ $t('common.loading') }}
    </li>
    <template v-else>
      <AsideFileTreeNode
        v-for="child in node.children"
        :key="child.file.id"
        :node="child"
        :depth="depth + 1"
        :ancestors="childAncestors"
        :expanded="expanded"
        :active-file-id="activeFileId"
        :active-folder-id="activeFolderId"
        @toggle-folder="(n: TreeNode) => emit('toggle-folder', n)"
        @expand-folder="(n: TreeNode) => emit('expand-folder', n)"
        @file-click="(f: AppFile) => emit('file-click', f)"
      />
      <li
        v-if="!node.children.length"
        class="py-1 text-brownish-50 italic"
        :style="`padding-left: ${(depth + 1) * 16 + 24}px`"
      >
        {{ $t('ui.fileTree.empty') }}
      </li>
    </template>
  </template>

  <li
    v-else-if="node.file.mime !== 'dir'"
    :title="node.file.name"
    class="flex items-center gap-1 py-1 cursor-pointer transition-colors duration-150"
    :class="
      node.file.id === activeFileId
        ? 'bg-orangy-500/15 text-orangy-300'
        : 'text-brownish-50 hover:bg-brownish-700/50 hover:text-white'
    "
    :style="padLeft"
    @click="emit('file-click', node.file)"
  >
    <span class="w-3 flex-shrink-0" />
    <BaseIcon :path="iconFor(node.file)" :size="14" class="flex-shrink-0" />
    <span class="truncate">{{ node.file.name }}</span>
  </li>
</template>
