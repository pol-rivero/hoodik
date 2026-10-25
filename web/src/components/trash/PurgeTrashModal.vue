<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CardBoxModal from '@/components/ui/CardBoxModal.vue'
import type { AppFile, TrashStore } from 'types'
import { notification, humanizeError } from '!/notify'

const props = defineProps<{
  modelValue: AppFile[] | undefined
  Trash: TrashStore
}>()

const emits = defineEmits<{
  (event: 'update:modelValue', value: AppFile[] | undefined): void
}>()

const { t } = useI18n()

const files = computed(() => props.modelValue ?? [])
const single = computed(() => (files.value.length === 1 ? files.value[0] : undefined))

const confirmPurge = async () => {
  if (!files.value.length) return

  try {
    await props.Trash.purgeItems(files.value)
  } catch (err) {
    notification(t('errors.purgeFailed'), humanizeError(err), 'error')
  }

  emits('update:modelValue', undefined)
}
</script>

<template>
  <CardBoxModal
    :title="$t('trash.confirm.deleteForeverTitle')"
    button="danger"
    :model-value="files.length > 0"
    :button-label="$t('trash.actions.deleteForever')"
    :has-cancel="true"
    @cancel="emits('update:modelValue', undefined)"
    :action="confirmPurge"
  >
    <p v-if="single">{{ $t('trash.confirm.deleteForever', { name: single.name }) }}</p>
    <p v-else>
      {{ $t('trash.confirm.deleteForeverMany', { count: files.length }, files.length) }}
    </p>
  </CardBoxModal>
</template>
