<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import type { Preview } from '!/preview'
import PreviewLoading from './PreviewLoading.vue'

const props = defineProps<{
  modelValue: Preview
}>()

const blobUrl = ref<string>()
const loadedBytes = ref(0)

const downloadPercent = computed(() => {
  const size = props.modelValue.size
  if (!size || !loadedBytes.value) return 0

  return Math.min(Math.round((loadedBytes.value / size) * 100), 99)
})

async function load() {
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value)
    blobUrl.value = undefined
  }
  loadedBytes.value = 0
  const buffer = (await props.modelValue.load((bytes) => (loadedBytes.value = bytes))).buffer
  const blob = new Blob([buffer], { type: 'application/pdf' })
  blobUrl.value = URL.createObjectURL(blob)
}

watch(() => props.modelValue, load, { immediate: true })

onUnmounted(() => {
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value)
  }
})
</script>

<template>
  <iframe
    v-if="blobUrl"
    :src="blobUrl"
    style="width: 100%; flex: 1; min-height: 0; border: none"
  />
  <PreviewLoading v-else :progress="downloadPercent" />
</template>
