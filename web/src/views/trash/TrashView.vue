<script setup lang="ts">
import LayoutAuthenticatedWithLoader from '@/layouts/LayoutAuthenticatedWithLoader.vue'
import SectionMain from '@/components/ui/SectionMain.vue'
import TrashTable from './TrashTable.vue'
</script>

<template>
  <LayoutAuthenticatedWithLoader v-slot="{ keypair }">
    <SectionMain>
      <TrashTable :kp="keypair" />
    </SectionMain>
  </LayoutAuthenticatedWithLoader>
</template>
