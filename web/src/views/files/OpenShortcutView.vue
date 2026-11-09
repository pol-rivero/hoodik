<script setup lang="ts">
import LayoutFileBrowser from '@/layouts/LayoutFileBrowser.vue'
import OpenShortcut from './shortcut-view/OpenShortcut.vue'
</script>
<template>
  <LayoutFileBrowser clear v-slot="{ keypair, Storage }">
    <OpenShortcut :kp="keypair" :Storage="Storage" />
  </LayoutFileBrowser>
</template>
