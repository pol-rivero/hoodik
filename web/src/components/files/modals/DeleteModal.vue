<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CardBoxModal from '@/components/ui/CardBoxModal.vue'
import type { FilesStore, KeyPair, AppFile } from 'types'
import { notification, humanizeError } from '!/notify'
import { isUnfinishedUpload } from '!/storage/trash'

const props = defineProps<{
  modelValue: AppFile | undefined
  Storage: FilesStore
  kp: KeyPair
}>()

const { t } = useI18n()

const emits = defineEmits<{
  (event: 'update:modelValue', value: AppFile | undefined): void
}>()

/**
 * What the server will actually do: a recipient only drops their own access,
 * an upload that never finished is purged at once, and everything else the
 * caller owns goes to trash. The copy must not promise a restore that the
 * first two can't offer.
 */
const mode = computed<'trash' | 'leave' | 'purge'>(() => {
  const file = props.modelValue
  if (file?.is_owner === false) return 'leave'
  if (file && isUnfinishedUpload(file)) return 'purge'
  return 'trash'
})

const title = computed(() => {
  if (mode.value === 'leave') return t('shares.revokeModal.selfTitle')
  if (mode.value === 'purge') return t('trash.confirm.deleteForeverTitle')
  return t('files.delete.trashTitle')
})

const buttonLabel = computed(() => {
  if (mode.value === 'leave') return t('shares.revokeModal.leave')
  if (mode.value === 'purge') return t('trash.actions.deleteForever')
  return t('files.delete.trashLabel')
})

const confirmRemove = async () => {
  const file = props.modelValue
  if (!file) return
  const done = mode.value

  // The dialog closes once this settles, so a failure has to announce
  // itself — the row simply staying put reads as success.
  try {
    await props.Storage.remove(props.kp, file)
    if (done === 'trash') notification(t('files.delete.movedTitle'), undefined, 'success')
    if (done === 'leave') {
      notification(t('nav.leave.removedTitle'), t('nav.leave.removedText'), 'success')
    }
  } catch (err) {
    notification(t('errors.deleteFailed'), humanizeError(err), 'error')
  }

  emits('update:modelValue', undefined)
}
</script>

<template>
  <CardBoxModal
    :title="title"
    button="danger"
    :model-value="!!props.modelValue"
    :button-label="buttonLabel"
    :has-cancel="true"
    @cancel="emits('update:modelValue', undefined)"
    :action="confirmRemove"
  >
    <i18n-t
      v-if="mode === 'leave'"
      tag="p"
      keypath="shares.revokeModal.selfBody"
      scope="global"
      data-testid="delete-leave-body"
    >
      <template #item>
        <strong>{{ props.modelValue?.name }}</strong>
      </template>
    </i18n-t>
    <p v-else-if="mode === 'purge'" data-testid="delete-purge-body">
      {{ $t('trash.confirm.deleteForever', { name: props.modelValue?.name }) }}
    </p>
    <p v-else>
      {{
        props.modelValue?.mime === 'dir'
          ? $t('files.delete.trashDirectory', { name: props.modelValue?.name })
          : $t('files.delete.trashFile', { name: props.modelValue?.name })
      }}
    </p>
  </CardBoxModal>
</template>
