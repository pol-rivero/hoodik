<script setup lang="ts">
import CardBoxModal from '@/components/ui/CardBoxModal.vue'
import type { AppFile, Authenticated, FilesStore, KeyPair } from 'types'
import DirectoryTree from '@/components/files/browser/DirectoryTree.vue'
import { useRouter } from 'vue-router'
import { useMoveFiles } from '@/composables/useMoveFiles'

const router = useRouter()
const { moveFiles } = useMoveFiles()

const props = defineProps<{
  modelValue: boolean
  Storage: FilesStore
  kp: KeyPair
  authenticated: Authenticated
}>()

const emits = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

// The shared-folder confirmation is raised through the `MoveConfirmHost`
// mounted by the file browser layout.
const select = async (file?: AppFile) => {
  if (!props.Storage.selected.length) {
    return
  }

  const outcome = await moveFiles([...props.Storage.selected], file, {
    sourceParent: props.Storage.dir,
    keypair: props.kp,
    callerUserId: props.authenticated.user.id
  })
  // A partial move (a later confirmation declined) keeps the picker open
  // with the items that stayed still selected.
  if (outcome?.status !== 'moved' || outcome.partial) {
    return
  }

  emits('update:modelValue', false)
  router.push({ name: 'files', params: { file_id: file?.id } })
}
</script>

<template>
  <CardBoxModal
    :title="$t('files.move.selectTarget')"
    :model-value="props.modelValue"
    :has-cancel="false"
    :has-close="true"
    :hide-submit="true"
    @cancel="emits('update:modelValue', false)"
  >
    <div class="w-full border-[1px] border-t-0 border-paper-300 dark:border-brownish-800 min-h-[400px]">
      <DirectoryTree
        v-if="props.modelValue"
        @select="select"
        :keypair="props.kp"
        :Storage="props.Storage"
        load
      />
    </div>
  </CardBoxModal>
</template>
