<script setup lang="ts">
import CardBox from '@/components/ui/CardBox.vue'
import StatsTable from '@/components/files/stats/StatsTable.vue'
import BaseIcon from '@/components/ui/BaseIcon.vue'
import ExpandableBox from '@/components/ui/ExpandableBox.vue'
import BiggestFiles from './BiggestFiles.vue'
import { store as filesStore } from '!/storage'
import { computedAsync } from '@vueuse/core'
import { computed, ref } from 'vue'
import { formatSize } from '!/index'
import { mdiChartDonut, mdiDatabase, mdiSortDescending } from '@mdi/js'
import type { KeyPair } from 'types'

const props = defineProps<{
  class?: string
  kp: KeyPair
}>()

const tabs = [
  { key: 'biggest', label: 'account.storage.tabBiggestFiles', icon: mdiSortDescending },
  { key: 'byType', label: 'account.storage.tabByFileType', icon: mdiChartDonut }
] as const

const activeTab = ref<(typeof tabs)[number]['key']>('biggest')

const storage = filesStore()
const data = computedAsync(async () => {
  await storage.loadStats()
  return storage.stats
})

const quota = computed(() => {
  if (!data.value?.quota) return null
  return formatSize(data.value.quota)
})

const usedSpace = computed(() => {
  if (!data.value?.used_space) return '0 B'
  return formatSize(data.value?.used_space)
})

const usagePercent = computed(() => {
  if (!data.value?.quota || !data.value?.used_space) return 0
  return Math.min(100, Math.round((data.value.used_space / data.value.quota) * 100))
})

const usageColor = computed(() => {
  if (usagePercent.value >= 90) return 'bg-redish-500'
  if (usagePercent.value >= 70) return 'bg-orangy-400'
  return 'bg-greeny-500'
})

const usageTextColor = computed(() => {
  if (usagePercent.value >= 90) return 'text-redish-500 dark:text-redish-100'
  if (usagePercent.value >= 70) return 'text-orangy-800 dark:text-orangy-400'
  return 'text-greeny-500 dark:text-greeny-300'
})
</script>
<template>
  <CardBox :class="props.class">
    <div class="-mx-4 -mt-4 px-6 py-6 border-b border-paper-200 dark:border-brownish-700/50 rounded-t-2xl">
      <div class="flex items-center gap-2 mb-4">
        <BaseIcon :path="mdiDatabase" :size="14" class="text-brownish-400 dark:text-brownish-50" />
        <p class="text-xs font-semibold text-brownish-400 dark:text-brownish-50">{{ $t('account.storage.title') }}</p>
      </div>

      <div class="flex items-end justify-between mb-3">
        <div>
          <span class="text-2xl font-bold" :class="usageTextColor">{{ usedSpace }}</span>
          <span class="text-sm text-brownish-400 dark:text-brownish-50 ml-1">
            <span v-if="quota">/ {{ quota }}</span>
            <span v-else>/ {{ $t('account.storage.unlimited') }}</span>
          </span>
        </div>
        <span v-if="quota" class="text-sm font-semibold" :class="usageTextColor">{{ usagePercent }}%</span>
      </div>

      <div v-if="quota" class="h-3 rounded-full bg-paper-100 dark:bg-brownish-700 overflow-hidden">
        <div
          class="h-full rounded-full transition-[width] duration-700"
          :class="usageColor"
          :style="{ width: usagePercent + '%' }"
        />
      </div>
    </div>

    <div class="-mx-4 -mb-4">
      <div
        class="flex gap-1 px-4 border-b border-paper-200 dark:border-brownish-700/50"
        role="tablist"
        data-testid="storage-tabs"
      >
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          :data-testid="`storage-tab-${tab.key}`"
          class="inline-flex items-center gap-2 px-2 py-3 -mb-px border-b-2 text-xs font-semibold whitespace-nowrap transition-colors"
          :class="
            activeTab === tab.key
              ? 'border-primary-500 text-primary-500 dark:text-primary-100'
              : 'border-transparent text-brownish-400 dark:text-brownish-50 hover:text-brownish-700 dark:hover:text-white'
          "
          @click="activeTab = tab.key"
        >
          <BaseIcon :path="tab.icon" :size="14" />
          {{ $t(tab.label) }}
        </button>
      </div>
      <div class="px-4 py-4" role="tabpanel">
        <BiggestFiles v-if="activeTab === 'biggest'" :kp="props.kp" />
        <ExpandableBox
          v-else-if="data"
          :expand-label="$t('account.storage.showAll', { count: data.stats.length })"
          :collapse-label="$t('account.storage.showLess')"
        >
          <StatsTable :data="data.stats" :max="data.quota" />
        </ExpandableBox>
      </div>
    </div>
  </CardBox>
</template>
