<script setup lang="ts">
import BaseButton from '@/components/ui/BaseButton.vue'
import SpinnerIcon from '@/components/ui/SpinnerIcon.vue'
import { fileOpenRoute } from '@/components/files/browser/fileMenuItems'
import type { ErrorResponse } from '!/api'
import { humanizeError } from '!/notify'
import type { FilesStore, KeyPair } from 'types'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

/**
 * Where a shortcut to a file leads. Only the target's own metadata says
 * whether it opens in the notes editor or the preview, so this resolves it
 * and replaces itself in the history with that route.
 */
const props = defineProps<{
  kp: KeyPair
  Storage: FilesStore
}>()

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const error = ref<string>()

const resolve = async (id: string) => {
  error.value = undefined
  try {
    const target = await props.Storage.metadata(id, props.kp)
    if (route.params.id !== id) return
    await router.replace(fileOpenRoute(target) ?? { name: 'file-preview', params: { id } })
  } catch (err) {
    if (route.params.id !== id) return
    error.value =
      (err as ErrorResponse<unknown>)?.status === 404
        ? t('files.shortcut.broken')
        : humanizeError(err)
  }
}

watch(
  () => route.params.id,
  (id) => {
    if (typeof id === 'string' && id) void resolve(id)
  },
  { immediate: true }
)
</script>
<template>
  <div
    v-if="error"
    class="flex flex-col gap-4 items-center justify-center py-24"
    data-testid="shortcut-open-error"
    role="alert"
  >
    <p>{{ error }}</p>
    <BaseButton :label="$t('common.back')" color="light" small @click="router.back()" />
  </div>
  <div v-else class="flex items-center justify-center py-24">
    <SpinnerIcon />
  </div>
</template>
