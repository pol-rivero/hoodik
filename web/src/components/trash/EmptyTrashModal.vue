<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CardBoxModal from '@/components/ui/CardBoxModal.vue'
import type { TrashStore } from 'types'
import { notification, humanizeError } from '!/notify'

const props = defineProps<{
  modelValue: boolean
  Trash: TrashStore
}>()

const emits = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const { t } = useI18n()

const count = computed(() => props.Trash.items.length)

const confirmEmpty = async () => {
  try {
    await props.Trash.emptyTrash()
  } catch (err) {
    notification(t('errors.purgeFailed'), humanizeError(err), 'error')
  }

  emits('update:modelValue', false)
}
</script>

<template>
  <CardBoxModal
    :title="$t('trash.confirm.emptyTitle')"
    button="danger"
    :model-value="props.modelValue"
    :button-label="$t('trash.actions.empty')"
    :has-cancel="true"
    @cancel="emits('update:modelValue', false)"
    :action="confirmEmpty"
  >
    <p>{{ $t('trash.confirm.empty', { count }, count) }}</p>
  </CardBoxModal>
</template>
