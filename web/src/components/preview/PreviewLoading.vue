<script setup lang="ts">
import SpinnerIcon from '../ui/SpinnerIcon.vue'

defineProps<{
  progress: number
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center w-full flex-1 h-full gap-4">
    <SpinnerIcon />
    <div class="text-sm text-brownish-50">{{ $t('preview.loading', { progress }) }}</div>
    <div class="w-64 h-2 bg-brownish-700 rounded-full overflow-hidden">
      <div class="h-full bg-greeny-400 transition-all" :style="{ width: `${progress}%` }" />
    </div>
  </div>
</template>
