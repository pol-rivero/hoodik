<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  mdiAlertCircleOutline,
  mdiDeleteForeverOutline,
  mdiDeleteSweepOutline,
  mdiRestore
} from '@mdi/js'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseIcon from '@/components/ui/BaseIcon.vue'
import SpinnerIcon from '@/components/ui/SpinnerIcon.vue'
import FileIconTile from '@/components/files/FileIconTile.vue'
import TableCheckboxCell from '@/components/ui/TableCheckboxCell.vue'
import TruncatedSpan from '@/components/ui/TruncatedSpan.vue'
import PurgeTrashModal from '@/components/trash/PurgeTrashModal.vue'
import EmptyTrashModal from '@/components/trash/EmptyTrashModal.vue'
import { formatRelative, formatSize } from '!'
import { notification, humanizeError } from '!/notify'
import { store as filesStore } from '!/storage'
import { store as trashStore, daysUntilPurge } from '!/storage/trash'
import type { AppFile, KeyPair } from 'types'

const props = defineProps<{
  kp: KeyPair
}>()

const { t } = useI18n()
const Trash = trashStore()
const Storage = filesStore()

const now = ref(Date.now() / 1000)
const restoring = ref(false)
const purgeTarget = ref<AppFile[]>()
const emptyOpen = ref(false)

/** Rows the last restore left behind because their name is taken at the target. */
const conflictIds = ref(new Set<string>())

// The page can stay open for hours; the days-left column must not freeze.
const clock = setInterval(() => (now.value = Date.now() / 1000), 60_000)
onUnmounted(() => clearInterval(clock))

async function load(): Promise<void> {
  await Promise.all([
    Trash.load(props.kp),
    // A direct visit to /trash is the only route into this page that hasn't
    // loaded the quota bar yet.
    Storage.loadStats().catch(() => undefined)
  ])
  now.value = Date.now() / 1000
}

void load()

const selectedIds = computed(() => new Set(Trash.selected.map((item) => item.id)))
const hasSelection = computed(() => Trash.selected.length > 0)
const allChecked = computed({
  get: () => Trash.items.length > 0 && Trash.selected.length === Trash.items.length,
  set: (value: boolean) => (value ? Trash.selectAll(Trash.items) : Trash.deselectAll())
})

function sizeLabel(item: AppFile): string {
  return item.mime === 'dir' ? '—' : formatSize(item.size)
}

function expiresLabel(item: AppFile): string {
  const days = daysUntilPurge(item.purge_at ?? 0, now.value, item.trashed_at)
  return days === 0 ? t('trash.expiresToday') : t('trash.expiresIn', days)
}

async function restore(files: AppFile[]): Promise<void> {
  if (!files.length || restoring.value) return

  const names = new Map(files.map((file) => [file.id, file.name]))
  restoring.value = true

  try {
    const result = await Trash.restoreItems(files)
    conflictIds.value = new Set(result.conflicts)

    if (result.restored.length) {
      notification(
        t('trash.notify.restoredTitle'),
        t('trash.notify.restored', result.restored.length),
        'success'
      )
    }

    const relocated = result.restored.filter((item) => item.relocated)
    if (relocated.length === 1) {
      const name = names.get(relocated[0].id) ?? relocated[0].id
      notification(t('trash.notify.restoredTitle'), t('trash.notify.relocated', { name }), 'info')
    } else if (relocated.length > 1) {
      notification(
        t('trash.notify.restoredTitle'),
        t('trash.notify.relocatedMany', relocated.length),
        'info'
      )
    }

    if (result.conflicts.length) {
      notification(t('trash.notify.conflictTitle'), t('trash.notify.conflict'), 'warn')
    }

    // Typically the item crossed its purge date while the page was open, so
    // it is being deleted for good: say so instead of letting the row
    // vanish as if it had been restored, and resync whatever else went stale.
    if (result.missing.length) {
      notification(
        t('trash.notify.conflictTitle'),
        t('trash.notify.missing', result.missing.length),
        'warn'
      )
      void Trash.load(props.kp)
    }
  } catch (err) {
    notification(t('errors.restoreFailed'), humanizeError(err), 'error')
  } finally {
    restoring.value = false
  }
}

const borderClass = 'sm:border-l sm:border-paper-300 sm:dark:border-brownish-950'

const sizes = {
  checkbox: 'pl-2 pt-3 w-10 shrink-0',
  name: 'flex-1 p-2 pt-3 min-w-0 flex items-start',
  size: 'hidden p-2 pt-3 md:block w-24 shrink-0',
  deleted: 'hidden p-2 pt-3 sm:block w-40 shrink-0',
  expires: 'hidden p-2 pt-3 lg:block w-36 shrink-0',
  expiresInline: 'lg:hidden text-xs text-brownish-400 dark:text-brownish-50',
  buttons: 'p-2 shrink-0 flex gap-2'
}
</script>

<template>
  <PurgeTrashModal v-model="purgeTarget" :Trash="Trash" />
  <EmptyTrashModal v-model="emptyOpen" :Trash="Trash" />

  <header class="flex items-center justify-between gap-3 mb-4">
    <h1 class="text-xl sm:text-2xl font-semibold">{{ $t('trash.title') }}</h1>
    <span
      v-if="Trash.loading && Trash.items.length"
      role="status"
      :aria-label="$t('common.loading')"
      data-testid="trash-refreshing"
    >
      <SpinnerIcon />
    </span>
  </header>

  <div
    v-if="Trash.error && Trash.items.length"
    role="alert"
    class="flex items-center gap-2 rounded-md border border-orangy-500/30 bg-orangy-500/10 px-3 py-2 mb-3 text-sm text-orangy-700 dark:border-orangy-400/25 dark:bg-orangy-400/10 dark:text-orangy-200"
    data-testid="trash-stale-error"
  >
    <BaseIcon :path="mdiAlertCircleOutline" :size="16" w="w-4" h="h-4" class="shrink-0" />
    <span class="flex-1">{{ $t(Trash.error) }}</span>
    <BaseButton :label="$t('common.retry')" small color="light" @click="load" />
  </div>

  <div class="w-full p-2 mb-2 flex flex-wrap rounded-t-md bg-paper-100 dark:bg-brownish-900 gap-2">
    <BaseButton
      :label="$t('trash.actions.restore')"
      :icon="mdiRestore"
      :iconSize="18"
      small
      color="light"
      data-testid="trash-restore-selected"
      :disabled="!hasSelection || restoring"
      @click="restore(Trash.selected)"
    />
    <BaseButton
      :label="$t('trash.actions.deleteForever')"
      :icon="mdiDeleteForeverOutline"
      :iconSize="18"
      small
      color="danger"
      data-testid="trash-delete-selected"
      :disabled="!hasSelection"
      @click="purgeTarget = [...Trash.selected]"
    />
    <BaseButton
      class="ml-auto"
      :label="$t('trash.actions.empty')"
      :icon="mdiDeleteSweepOutline"
      :iconSize="18"
      small
      color="danger"
      outline
      data-testid="trash-empty"
      :disabled="!Trash.items.length"
      @click="emptyOpen = true"
    />
  </div>

  <div class="bg-white dark:bg-brownish-900 rounded-lg border border-paper-300/40 dark:border-brownish-700/40">
    <div class="w-full flex rounded-t-lg bg-paper-100 dark:bg-brownish-950 border-b border-paper-300 dark:border-brownish-700/40">
      <div :class="sizes.checkbox">
        <TableCheckboxCell
          v-model="allChecked"
          :disabled="!Trash.items.length"
          :label="$t('common.selectAll')"
        />
      </div>
      <div :class="sizes.name">
        <span>{{ $t('common.name') }}</span>
      </div>
      <div :class="`${sizes.size} ${borderClass}`">
        <span>{{ $t('common.size') }}</span>
      </div>
      <div :class="`${sizes.deleted} ${borderClass}`">
        <span>{{ $t('trash.columns.deleted') }}</span>
      </div>
      <div :class="`${sizes.expires} ${borderClass}`">
        <span>{{ $t('trash.columns.expires') }}</span>
      </div>
      <div :class="sizes.buttons" class="w-20" />
    </div>

    <div
      v-if="Trash.loading && !Trash.items.length"
      class="w-full rounded-b-lg bg-paper-50 dark:bg-brownish-900"
      data-testid="trash-loading"
      role="status"
      :aria-label="$t('common.loading')"
    >
      <div
        v-for="(width, index) in ['w-1/2', 'w-2/5', 'w-3/5']"
        :key="index"
        class="w-full flex trash-row-separator animate-pulse"
        aria-hidden="true"
      >
        <div :class="sizes.checkbox">
          <div class="w-5 h-5 rounded bg-paper-200 dark:bg-brownish-700" />
        </div>
        <div :class="sizes.name">
          <div class="w-6 h-6 mr-2 rounded-md shrink-0 bg-paper-200 dark:bg-brownish-700" />
          <div class="h-4 rounded bg-paper-200 dark:bg-brownish-700" :class="width" />
        </div>
        <div :class="sizes.size">
          <div class="h-3 w-12 rounded bg-paper-200/70 dark:bg-brownish-700/60" />
        </div>
        <div :class="sizes.deleted">
          <div class="h-3 w-24 rounded bg-paper-200/70 dark:bg-brownish-700/60" />
        </div>
        <div :class="sizes.expires">
          <div class="h-3 w-16 rounded bg-paper-200/70 dark:bg-brownish-700/60" />
        </div>
      </div>
    </div>

    <div
      v-else-if="Trash.error && !Trash.items.length"
      role="alert"
      class="w-full rounded-b-lg bg-paper-50 dark:bg-brownish-900 py-14 flex flex-col items-center gap-3"
      data-testid="trash-error"
    >
      <span class="flex items-center gap-2 text-redish-500 dark:text-redish-100">
        <BaseIcon :path="mdiAlertCircleOutline" :size="16" w="w-4" h="h-4" class="shrink-0" />
        {{ $t(Trash.error) }}
      </span>
      <BaseButton :label="$t('common.retry')" small color="light" @click="load" />
    </div>

    <div
      v-else-if="!Trash.items.length"
      class="w-full rounded-b-lg bg-paper-50 dark:bg-brownish-900 py-14 flex flex-col items-center gap-1"
      data-testid="trash-empty-state"
    >
      <span class="text-brownish-300 dark:text-brownish-50">{{ $t('trash.emptyState') }}</span>
    </div>

    <div v-else class="flex flex-col rounded-b-lg">
      <div
        v-for="item in Trash.items"
        :key="item.id"
        :data-testid="`trash-row-${item.name}`"
        class="w-full flex trash-row-separator"
        :class="{ 'bg-paper-50 dark:bg-brownish-700': selectedIds.has(item.id) }"
      >
        <div :class="sizes.checkbox">
          <TableCheckboxCell
            :model-value="selectedIds.has(item.id)"
            :label="$t('common.selectRow', { name: item.name })"
            @update:model-value="(value: boolean) => Trash.selectOne(value, item)"
          />
        </div>

        <div :class="sizes.name" :title="item.name">
          <FileIconTile :mime="item.mime" tile-class="w-6 h-6 mr-2" />
          <div class="min-w-0 flex flex-col">
            <div class="min-w-0 flex items-center">
              <TruncatedSpan :text="item.name" />
              <span
                v-if="conflictIds.has(item.id)"
                class="ml-2 inline-flex items-center text-orangy-800 dark:text-orangy-400"
                role="img"
                :title="$t('trash.notify.conflict')"
                :aria-label="$t('trash.notify.conflict')"
                data-testid="trash-conflict"
              >
                <BaseIcon :path="mdiAlertCircleOutline" :size="14" />
              </span>
            </div>
            <span :class="sizes.expiresInline" data-testid="trash-expires-inline">
              {{ $t('trash.expiresLine', { when: expiresLabel(item) }) }}
            </span>
          </div>
        </div>

        <div :class="sizes.size">
          <span>{{ sizeLabel(item) }}</span>
        </div>

        <div :class="sizes.deleted">
          <TruncatedSpan :text="item.trashed_at ? formatRelative(item.trashed_at, now) : '—'" />
        </div>

        <div :class="sizes.expires" data-testid="trash-expires">
          <TruncatedSpan :text="expiresLabel(item)" />
        </div>

        <div :class="sizes.buttons">
          <BaseButton
            :icon="mdiRestore"
            small
            color="light"
            name="trash-restore"
            :title="$t('trash.actions.restore')"
            :disabled="restoring"
            @click="restore([item])"
          />
          <BaseButton
            :icon="mdiDeleteForeverOutline"
            small
            color="danger"
            name="trash-delete-forever"
            :title="$t('trash.actions.deleteForever')"
            @click="purgeTarget = [item]"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trash-row-separator {
  box-shadow: inset 0 -1px 0 0 rgba(120, 120, 120, 0.15);
}

:global(.dark) .trash-row-separator {
  box-shadow: inset 0 -1px 0 0 rgba(120, 120, 120, 0.1);
}
</style>
