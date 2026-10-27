<script setup lang="ts">
import FileThumbnail from '@/components/files/FileThumbnail.vue'
import FileIconTile from '@/components/files/FileIconTile.vue'
import ExpandableBox from '@/components/ui/ExpandableBox.vue'
import SpinnerIcon from '@/components/ui/SpinnerIcon.vue'
import { fileOpenRoute } from '@/components/files/browser/fileMenuItems'
import { largest } from '!/storage/meta'
import { formatSize } from '!/index'
import { computedAsync } from '@vueuse/core'
import { ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import type { AppFile, KeyPair } from 'types'

const props = defineProps<{
  kp: KeyPair
}>()

const loading = ref(true)
const failed = ref(false)

const files = computedAsync(
  async () => {
    try {
      return await largest(props.kp)
    } catch {
      failed.value = true
      return []
    }
  },
  [],
  loading
)

// Files with nothing to preview open their folder instead.
function route(file: AppFile): RouteLocationRaw {
  return fileOpenRoute(file) ?? { name: 'files', params: { file_id: file.file_id ?? undefined } }
}
</script>
<template>
  <div v-if="loading" class="flex justify-center py-6">
    <SpinnerIcon class="text-brownish-400 dark:text-brownish-50" />
  </div>
  <p v-else-if="failed" class="py-4 text-center text-sm text-brownish-400 dark:text-brownish-50">
    {{ $t('account.storage.biggestFilesFailed') }}
  </p>
  <p v-else-if="!files.length" class="py-4 text-center text-sm text-brownish-400 dark:text-brownish-50">
    {{ $t('account.storage.noFiles') }}
  </p>
  <ExpandableBox
    v-else
    :expand-label="$t('account.storage.showAll', { count: files.length })"
    :collapse-label="$t('account.storage.showLess')"
  >
    <ol data-testid="biggest-files">
      <li v-for="file in files" :key="file.id">
        <router-link
          :to="route(file)"
          class="flex items-center gap-3 -mx-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-paper-50 dark:hover:bg-brownish-800"
        >
          <FileThumbnail :file="file" img-class="w-8 h-8 rounded-md shrink-0">
            <FileIconTile :mime="file.mime" tile-class="w-8 h-8" :size="18" />
          </FileThumbnail>
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm">{{ file.name }}</div>
            <div class="truncate text-xs text-brownish-400 dark:text-brownish-50">{{ file.mime }}</div>
          </div>
          <span class="shrink-0 text-sm tabular-nums text-brownish-400 dark:text-brownish-50">
            {{ formatSize(file.size) }}
          </span>
        </router-link>
      </li>
    </ol>
  </ExpandableBox>
</template>
