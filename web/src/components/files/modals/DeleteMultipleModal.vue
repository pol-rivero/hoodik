<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CardBoxModal from '@/components/ui/CardBoxModal.vue'
import type { FilesStore, KeyPair } from 'types'
import { notification, humanizeError } from '!/notify'
import { isUnfinishedUpload } from '!/storage/trash'

const props = defineProps<{
  modelValue: boolean
  Storage: FilesStore
  kp: KeyPair
}>()

const { t } = useI18n()

const emits = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const selected = computed(() => props.Storage.selected ?? [])
const count = computed(() => selected.value.length)
const single = computed(() => (count.value === 1 ? selected.value[0] : undefined))

const shared = computed(() => selected.value.filter((file) => file.is_owner === false))
const unfinished = computed(() =>
  selected.value.filter((file) => file.is_owner !== false && isUnfinishedUpload(file))
)
const trashable = computed(() => count.value - shared.value.length - unfinished.value.length)

/**
 * The trash copy, with its promise of a restore, is only used when something
 * in the selection really goes to trash. A selection made only of shares the
 * caller doesn't own, or only of unfinished uploads, gets the wording of what
 * the server does to those instead.
 */
const mode = computed<'trash' | 'leave' | 'purge'>(() => {
  if (trashable.value > 0 || !count.value) return 'trash'
  if (shared.value.length === count.value) return 'leave'
  // Only unfinished uploads, possibly mixed with shares: nothing is restorable.
  return 'purge'
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

const confirmRemoveAll = async () => {
  // Read before the call: a successful removal empties the selection.
  const done = mode.value
  const movedAny = trashable.value > 0

  try {
    await props.Storage.removeAll(props.kp, props.Storage.selected)
    if (movedAny) notification(t('files.delete.movedTitle'), undefined, 'success')
    else if (done === 'leave') notification(t('nav.leave.removedTitle'), undefined, 'success')
  } catch (err) {
    notification(t('errors.deleteFailed'), humanizeError(err), 'error')
  }
  emits('update:modelValue', false)
}
</script>

<template>
  <CardBoxModal
    :title="title"
    button="danger"
    :model-value="props.modelValue"
    :button-label="buttonLabel"
    :has-cancel="true"
    @cancel="emits('update:modelValue', false)"
    :action="confirmRemoveAll"
  >
    <i18n-t
      v-if="mode === 'leave'"
      tag="p"
      keypath="shares.revokeModal.selfBody"
      scope="global"
      data-testid="delete-leave-body"
    >
      <template #item>
        <strong>{{ single ? single.name : $t('files.moveShare.itemCount', count) }}</strong>
      </template>
    </i18n-t>

    <p v-else-if="mode === 'purge'" data-testid="delete-purge-body">
      {{
        single
          ? $t('trash.confirm.deleteForever', { name: single.name })
          : $t('trash.confirm.deleteForeverMany', { count }, count)
      }}
    </p>

    <template v-else>
      <p v-if="single">
        {{
          single.mime === 'dir'
            ? $t('files.delete.trashDirectory', { name: single.name })
            : $t('files.delete.trashFile', { name: single.name })
        }}
      </p>
      <p v-else>{{ $t('files.delete.trashMany', { count }, count) }}</p>

      <p
        v-if="shared.length"
        class="mt-2 text-sm text-brownish-400 dark:text-brownish-50"
        data-testid="delete-shared-note"
      >
        {{ $t('files.delete.sharedNote') }}
      </p>
    </template>
  </CardBoxModal>
</template>
