<script setup lang="ts">
import { computed } from 'vue'
import { store as style } from '!/style'
import { gradientDark, gradientAzure } from '@/colors'

const colorClass = computed(() => (style().darkMode ? gradientDark : gradientAzure))
</script>

<template>
  <div class="flex min-h-screen items-center justify-center" :class="colorClass">
    <slot card-class="w-11/12 md:w-7/12 lg:w-6/12 xl:w-4/12" />
  </div>
</template>
