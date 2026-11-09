<script setup lang="ts">
import CardBoxModal from '@/components/ui/CardBoxModal.vue'
import DirectoryTree from '@/components/files/browser/DirectoryTree.vue'
import type { AppFile, Authenticated, FilesStore, KeyPair } from 'types'
import { mdiLinkVariantPlus } from '@mdi/js'
import { humanizeError, notification } from '!/notify'
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
  Storage: FilesStore
  kp: KeyPair
  authenticated: Authenticated
}>()

const emits = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const { t } = useI18n()
const working = ref(false)

// A single shortcut gets a name of its own, starting from the target's;
// several at once each take their target's name and can be renamed later.
const single = computed(() =>
  props.Storage.selected.length === 1 ? props.Storage.selected[0] : undefined
)
const name = ref('')
watch(
  () => [props.modelValue, single.value?.id],
  () => {
    if (props.modelValue) name.value = single.value?.name ?? ''
  },
  { immediate: true }
)

/** Adds a shortcut to every selected row inside `folder` (the root when undefined). */
const select = async (folder?: AppFile) => {
  const targets = [...props.Storage.selected]
  if (!targets.length || working.value) return
  const customName = targets.length === 1 ? name.value.trim() : ''
  if (targets.length === 1 && !customName) {
    notification(t('files.shortcut.failedTitle'), t('files.shortcut.nameRequired'), 'error')
    return
  }

  working.value = true
  const failed: string[] = []
  try {
    for (const target of targets) {
      try {
        await props.Storage.createShortcut(
          props.kp,
          target,
          folder?.id,
          props.authenticated.user.id,
          customName || target.name
        )
      } catch (err) {
        failed.push(`${target.name}: ${humanizeError(err)}`)
      }
    }
  } finally {
    working.value = false
  }

  const destination = folder?.name ?? t('files.tree.root')
  if (failed.length) {
    notification(t('files.shortcut.failedTitle'), failed.join('\n'), 'error')
  }
  if (failed.length < targets.length) {
    notification(
      t('files.shortcut.addedTitle'),
      t('files.shortcut.addedText', { count: targets.length - failed.length, folder: destination }),
      'success'
    )
    emits('update:modelValue', false)
  }
}
</script>

<template>
  <CardBoxModal
    :title="$t('files.shortcut.selectTarget')"
    :model-value="props.modelValue"
    :has-cancel="false"
    :has-close="true"
    :hide-submit="true"
    @cancel="emits('update:modelValue', false)"
  >
    <label v-if="single" class="block mb-4">
      <span class="block mb-2">{{ $t('files.shortcut.nameLabel') }}</span>
      <input
        v-model="name"
        type="text"
        data-testid="add-shortcut-name"
        class="w-full px-4 py-2 rounded-lg bg-white dark:bg-brownish-800 border border-paper-300 dark:border-brownish-600 text-brownish-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-200/60 dark:focus:ring-primary-100/50"
        :disabled="working"
      />
    </label>
    <div
      class="w-full border-[1px] border-t-0 border-paper-300 dark:border-brownish-800 min-h-[400px]"
      data-testid="add-shortcut-modal"
    >
      <DirectoryTree
        v-if="props.modelValue"
        @select="select"
        :keypair="props.kp"
        :Storage="props.Storage"
        :select-label="$t('files.shortcut.addHere')"
        :select-icon="mdiLinkVariantPlus"
        load
      />
    </div>
  </CardBoxModal>
</template>
