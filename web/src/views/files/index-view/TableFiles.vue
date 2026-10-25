<script setup lang="ts">
import {
  mdiTrashCanOutline,
  mdiFolderPlusOutline,
  mdiFilePlusOutline,
  mdiFileDocumentPlusOutline,
  mdiFolderArrowUpOutline,
  mdiDownloadMultiple,
  mdiPencil,
  mdiEye,
  mdiInformationOutline,
  mdiFolderMove,
  mdiShareVariantOutline
} from '@mdi/js'
import { useCapability } from '@/composables/useCapability'
import { useKeyboardShortcuts } from '@/composables/useKeyboardShortcuts'
import { useMarqueeSelection } from '@/composables/useMarqueeSelection'
import { useLongPress } from '@/composables/useLongPress'
import { rangeBetween, sameSet } from '@/utils/selection'
import SortableName from '@/components/ui/SortableName.vue'
import TableFileRowWatcher from './TableFileRowWatcher.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import {
  blankMenuItems,
  canCreateHere,
  fileCapabilities,
  fileMenuItems,
  fileOpenRoute,
  parentFolderRoute,
  selectionMenuItems,
  type BlankMenuAction,
  type FileMenuAction,
  type SelectionMenuAction
} from '@/components/files/browser/fileMenuItems'
import {
  closeContextMenu,
  openContextMenu,
  openContextMenuFromEvent,
  type ContextMenuRequest
} from '@/composables/useContextMenu'
import { useFolderDropTarget } from '@/composables/useFolderDropTarget'
import { computed, onMounted, onUnmounted, ref, type HTMLAttributes } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import type { AppFile } from 'types'
import { isPreviewable, isMarkdownFile } from '!/preview'
import { SHARED_WITH_ME_DIR_ID } from '!/storage'
import { beginFileDrag, endFileDrag, isInternalFileDrag } from '!/storage/dragMove'

const props = defineProps<{
  selected: AppFile[]
  items: AppFile[]
  parents: AppFile[]
  parentId: string | undefined
  dir: AppFile | null
  file_id?: string
  searchedFileId?: string
  selectionDisabled?: boolean
  hideDelete?: boolean
  share?: boolean
  showActions?: boolean
  loading?: boolean
  error?: string | null
  sortOptions: { parameter: string; order: string }
}>()

const emits = defineEmits<{
  (event: 'actions', file: AppFile): void
  (event: 'browse'): void
  (event: 'retry'): void
  (event: 'deselect-all'): void
  (event: 'details', file: AppFile): void
  (event: 'directory'): void
  (event: 'file'): void
  (event: 'download-many'): void
  (event: 'download', file: AppFile): void
  (event: 'move-all'): void
  (event: 'remove-all'): void
  (event: 'remove', file: AppFile): void
  (event: 'rename', file: AppFile): void
  (event: 'sharing', file: AppFile): void
  (event: 'fork', file: AppFile): void
  (event: 'leave', file: AppFile): void
  (event: 'select-all', files: AppFile[], fileId: string | null | undefined): void
  (event: 'select-one', select: boolean, file: AppFile): void
  (event: 'set-selection', files: AppFile[]): void
  (event: 'set-sort-simple', value: string): void
  (event: 'upload-many', files: FileList, dirId?: string): void
  (event: 'browse-folder'): void
  (event: 'upload-folder-entries', entries: FileSystemEntry[], dirId?: string): void
}>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const isDropZone = ref(false)

const dirId = computed<string | undefined>(() => {
  if (props.dir) {
    return props.dir.id
  }

  return undefined
})

const selectedIds = computed(() => new Set(props.selected.map((file) => file.id)))

const selectedRows = computed(() => {
  return props.items.filter((item) => selectedIds.value.has(item.id))
})

const tableEl = ref<HTMLElement | null>(null)

// The same condition that renders the rows; the loading, empty and error
// states inside the table are no grid.
const hasRows = computed(() => !props.error && props.items.length > 0)

const columnHeader = (sortKey?: string): HTMLAttributes => {
  if (!hasRows.value) return {}
  const sorted = sortKey && props.sortOptions.parameter === sortKey
  return {
    role: 'columnheader',
    'aria-sort': sorted ? (props.sortOptions.order === 'asc' ? 'ascending' : 'descending') : undefined
  }
}
const listEl = ref<HTMLElement | null>(null)

const isSelectable = (file: AppFile) => file.id !== SHARED_WITH_ME_DIR_ID

/** Replaces the whole selection in one store write, however many rows changed. */
const setSelection = (ids: ReadonlySet<string>) => {
  if (sameSet(ids, selectedIds.value)) return
  emits('set-selection', props.items.filter((file) => ids.has(file.id) && isSelectable(file)))
}

/**
 * Anchor for shift-click and Shift+Arrow. A plain or Ctrl click moves it; a
 * shift-click selects everything between it and the clicked row, the way
 * every file manager behaves.
 */
const anchorId = ref<string | null>(null)

const toggle = (file: AppFile) => {
  if (!isSelectable(file)) return
  anchorId.value = file.id
  const next = new Set(selectedIds.value)
  if (!next.delete(file.id)) next.add(file.id)
  setSelection(next)
}

const selectRange = (file: AppFile, additive: boolean) => {
  const ids = props.items.map((f) => f.id)
  if (!anchorId.value || !ids.includes(anchorId.value)) anchorId.value = file.id

  const range = rangeBetween(ids, anchorId.value, file.id)
  setSelection(additive ? new Set([...selectedIds.value, ...range]) : new Set(range))
}

let lastPointerType = 'mouse'
let pressedOnBlank = false
let pressTarget: Element | null = null
const trackPress = (event: PointerEvent) => {
  lastPointerType = event.pointerType
  pressTarget = event.target instanceof Element ? event.target : null
  pressedOnBlank = event.target instanceof Element && isBlankSpace(event.target)
}

/**
 * Native file-manager click semantics: a click selects just that row (also
 * collapsing a multi-selection onto it), Ctrl/Cmd toggles, Shift selects the
 * range from the anchor and Ctrl+Shift adds that range. Touch has no
 * modifiers, so once anything is selected a tap toggles instead.
 */
const onRowClick = (event: MouseEvent | KeyboardEvent, file: AppFile) => {
  if (props.selectionDisabled) return

  const additive = event.ctrlKey || event.metaKey
  if (event.shiftKey) {
    selectRange(file, additive)
    return
  }

  const touchTap =
    event instanceof MouseEvent &&
    event.detail > 0 &&
    lastPointerType !== 'mouse' &&
    selectedIds.value.size > 0
  if (additive || touchTap) {
    toggle(file)
    return
  }

  anchorId.value = file.id
  setSelection(new Set(isSelectable(file) ? [file.id] : []))
}

/**
 * Shift+Arrow makes the selection exactly the rows between the anchor and the
 * newly focused row, so reversing direction shrinks it again. The anchor is
 * only kept while the row being left is part of the selection; otherwise the
 * range starts fresh from that row.
 */
const selectRangeByKeyboard = (from: number, to: number) => {
  const rows = props.items
  const anchorIndex =
    anchorId.value && selectedIds.value.has(rows[from].id)
      ? rows.findIndex((f) => f.id === anchorId.value)
      : -1
  if (anchorIndex < 0) anchorId.value = rows[from].id

  const start = anchorIndex >= 0 ? anchorIndex : from
  const [lo, hi] = start <= to ? [start, to] : [to, start]
  setSelection(new Set(rows.slice(lo, hi + 1).map((file) => file.id)))
}

/**
 * Arrow keys walk the row buttons so the browser is operable without a
 * pointer, and Shift+Arrow selects along the way. Enter (open) and Space
 * (select) are handled on the row, which leaves only the movement to do here.
 */
const onListKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (event.altKey || event.ctrlKey || event.metaKey) return

  const target = event.target as HTMLElement | null
  if (!target?.hasAttribute('data-row-nav')) return

  const buttons = [...(listEl.value?.querySelectorAll<HTMLElement>('[data-row-nav]') ?? [])]
  const index = buttons.indexOf(target)
  const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)]
  if (index < 0 || !next) return

  event.preventDefault()
  next.focus()

  if (!event.shiftKey || props.selectionDisabled) return
  const rowIndex = (el: HTMLElement) =>
    props.items.findIndex((f) => f.id === el.closest<HTMLElement>('[data-file-id]')?.dataset.fileId)
  const from = rowIndex(target)
  const to = rowIndex(next)
  if (from >= 0 && to >= 0) selectRangeByKeyboard(from, to)
}

const INTERACTIVE =
  'a, input, textarea, select, [contenteditable], [data-row-actions], button:not([data-row-nav])'

/**
 * Empty space around the rows: the table's own background, or any ancestor
 * of the table, which is what a press lands on in the page area below a short
 * listing. Siblings like the toolbar, breadcrumbs, sidebar and modals are
 * never ancestors, so they don't count.
 */
const isBlankSpace = (target: Element) => {
  const table = tableEl.value
  if (!table) return false
  if (target.contains(table)) return true
  return (
    table.contains(target) &&
    !target.closest('[data-file-id], [data-row-placeholder], [data-table-header]') &&
    !target.closest(INTERACTIVE)
  )
}

const rowAt = (target: Element) => {
  const row = target.closest<HTMLElement>('[data-file-id]')
  return row && listEl.value?.contains(row) ? row : null
}

/**
 * The one place deciding whether a pointerdown begins a rubber band. Only a
 * primary mouse press does (touch keeps scrolling), and only on blank space or
 * on a row that isn't selected yet, never on its ⋮ actions or other controls.
 * Shift on a row means a range click, which a shaky hand mustn't turn into a
 * band; Shift+drag from blank space still adds.
 *
 * A press on an already-selected row is left alone entirely, not even
 * preventDefault'd: that is where a native drag of the selection starts.
 */
const shouldStartMarquee = (event: PointerEvent): boolean => {
  if (props.selectionDisabled || event.pointerType !== 'mouse' || event.button !== 0) return false
  const target = event.target
  if (!(target instanceof Element)) return false
  if (isBlankSpace(target)) return true

  const row = rowAt(target)
  if (!row || event.shiftKey || target.closest(INTERACTIVE)) return false
  return !selectedIds.value.has(row.dataset.fileId ?? '')
}

// Rows far off screen render as placeholders; they still take up their place
// in the list, so the band has to be able to hit them too.
const marqueeTargets = (): [string, Element][] =>
  [
    ...(listEl.value?.querySelectorAll<HTMLElement>('[data-file-id], [data-row-placeholder]') ??
      [])
  ].map((el) => [el.dataset.fileId ?? el.dataset.rowPlaceholder ?? '', el])

const { band, cancel: cancelMarquee } = useMarqueeSelection({
  shouldStart: shouldStartMarquee,
  targets: marqueeTargets,
  getSelection: () => selectedIds.value,
  setSelection,
  // A following shift-click extends from the row nearest where the band began.
  onCommit: (hits, selection) => {
    anchorId.value = hits.find((id) => selection.has(id)) ?? anchorId.value
  },
  // The fixed navbar (h-14) covers the top of the viewport.
  topInset: 56
})

useLongPress({
  target: (event) => {
    if (props.selectionDisabled || !(event.target instanceof Element)) return null
    if (event.target.closest(INTERACTIVE)) return null
    return rowAt(event.target)
  },
  onLongPress: (row) => {
    const file = props.items.find((f) => f.id === row.dataset.fileId)
    if (file) toggle(file)
  }
})

// Both ends must be blank: a press on one row released on another clicks
// their common ancestor, the list, which is not a click on nothing.
const onDocumentClick = (event: MouseEvent) => {
  if (props.selectionDisabled || !selectedIds.value.size || !pressedOnBlank) return
  if (event.ctrlKey || event.metaKey || event.shiftKey) return
  if (event.target instanceof Element && isBlankSpace(event.target)) setSelection(new Set())
}

const isMenuOpen = () =>
  [...document.querySelectorAll('[role="menu"], .floating-menu')].some(
    (el) => el.getClientRects().length > 0
  )

/**
 * Escape clears the selection only when nothing else wants the key. Menus and
 * dialogs are checked in the capture phase, while they are still open: some
 * close on this same Escape without claiming it. Everything else that acts on
 * it (the transfers panel) claims it with preventDefault, which can only be
 * read once the whole dispatch is over.
 */
const onEscape = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  if (cancelMarquee()) {
    event.preventDefault()
    event.stopPropagation()
    return
  }

  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('input, textarea, select, [contenteditable]')) return
  if (!selectedIds.value.size || isDialogOpen() || isMenuOpen()) return
  setTimeout(() => {
    if (!event.defaultPrevented) setSelection(new Set())
  })
}

const showDeleteAll = computed(() => {
  return selectedRows.value.length > 0 && !props.hideDelete
})

const { sharingEnabled, forkEnabled } = useCapability()

const singleSelected = computed(() => {
  if (selectedRows.value.length !== 1) {
    return null
  }

  return selectedRows.value[0]
})

const renameable = computed(() => {
  const file = singleSelected.value
  if (!file || !props.showActions) return null
  const can = fileCapabilities(file, {
    sharingEnabled: sharingEnabled.value,
    forkEnabled: forkEnabled.value,
    hideDelete: props.hideDelete
  })
  return can.rename ? file : null
})

/** Opens a folder, the notes editor or the preview; Details for anything else. */
const openFile = (file: AppFile) => {
  const route = fileOpenRoute(file)
  if (route) router.push(route)
  else emits('details', file)
}

const parentRoute = computed(() => parentFolderRoute(props.parents))

// Enter on a focused row is the row's own; this covers a selection made with
// the mouse or the band, where focus is left on the page itself.
const isPageFocused = () => !document.activeElement || document.activeElement === document.body

useKeyboardShortcuts([
  // Ctrl+A selects every row in the current folder
  {
    key: 'a',
    mod: true,
    when: () => !props.selectionDisabled && props.items.length > 0,
    handler: () => emits('select-all', props.items, dirId.value)
  },
  {
    key: 'Delete',
    when: () => showDeleteAll.value,
    handler: () => emits('remove-all')
  },
  {
    key: 'Backspace',
    mod: true,
    when: () => showDeleteAll.value,
    handler: () => emits('remove-all')
  },
  {
    key: 'F2',
    when: () => !!renameable.value,
    handler: () => emits('rename', renameable.value as AppFile)
  },
  {
    key: 'Enter',
    when: () => !!singleSelected.value && isPageFocused(),
    handler: () => openFile(singleSelected.value as AppFile)
  },
  {
    key: 'ArrowUp',
    alt: true,
    when: () => !!parentRoute.value,
    handler: () => router.push(parentRoute.value as RouteLocationRaw)
  }
])

const showMoveAll = computed(() => {
  return selectedRows.value.length > 0
})

const showDownloadMany = computed(() => {
  const hasIncompleteUploads = selectedRows.value.some(
    (item) => item.mime !== 'dir' && !item.finished_upload_at
  )
  const hasSyntheticRoot = selectedRows.value.some((item) => item.id === SHARED_WITH_ME_DIR_ID)

  return selectedRows.value.length > 0 && !hasIncompleteUploads && !hasSyntheticRoot
})

/**
 * Inside the synthetic "Shared with me" folder there is no real parent
 * to upload into — the user must first navigate into one of the shared
 * folders surfaced as a row. Write actions stay hidden to keep that
 * affordance unambiguous.
 */
const isSharedWithMeRoot = computed(() => props.parentId === SHARED_WITH_ME_DIR_ID)

const canCreate = computed(() => canCreateHere(props.dir, props.parentId))

const hasFiles = (e: DragEvent) =>
  !!e.dataTransfer?.types.includes('Files') && !isInternalFileDrag(e)

// Modals stay in the DOM behind v-show, so only a rendered one counts as open.
const isDialogOpen = () =>
  [...document.querySelectorAll('[role="dialog"]')].some((el) => el.getClientRects().length > 0)

const isDropBlocked = () => isSharedWithMeRoot.value || isDialogOpen()

// Bound on the window rather than the table so a drop anywhere on the page,
// including the empty space around a short listing, lands in this folder.
// Folder rows handle their own drops and stop propagation before this runs.
const dragover = (e: DragEvent) => {
  if (!hasFiles(e)) return
  e.preventDefault()

  if (isDropBlocked()) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    return
  }
  isDropZone.value = true
}

const dragleave = (e: DragEvent) => {
  // A null relatedTarget means the pointer left the window, not just moved
  // between two elements of the page.
  if (e.relatedTarget === null) isDropZone.value = false
}

const drop = (e: DragEvent) => {
  if (!hasFiles(e)) return
  isDropZone.value = false
  e.preventDefault()

  if (isDropBlocked()) return

  // Extract FileSystemEntry objects synchronously — DataTransferItemList is only valid
  // during the event and becomes empty after the handler returns.
  if (e.dataTransfer?.items) {
    const entries: FileSystemEntry[] = []
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const entry = e.dataTransfer.items[i].webkitGetAsEntry()
      if (entry) entries.push(entry)
    }
    if (entries.some((entry) => entry.isDirectory)) {
      emits('upload-folder-entries', entries, dirId.value)
      return
    }
  }

  if (e.dataTransfer?.files && e.dataTransfer.files.length) {
    emits('upload-many', e.dataTransfer.files, dirId.value)
  }
}

/**
 * Dragging a selected row carries the whole selection. Rows only become
 * draggable once selected, so a press on any other row is the band's.
 */
const onDragstart = (event: DragEvent) => {
  const row = event.target instanceof Element ? rowAt(event.target) : null
  if (!row || props.selectionDisabled || !selectedIds.value.has(row.dataset.fileId ?? '')) return
  // A touch long-press on a row toggles its selection; it mustn't also pick it
  // up. A press in the ⋮ dropdown that wobbles is choosing an item, not a drag.
  if (lastPointerType === 'touch' || pressTarget?.closest('[data-row-actions]')) {
    event.preventDefault()
    return
  }
  closeContextMenu({ restoreFocus: false })
  beginFileDrag(event, selectedRows.value, props.dir, props.parents)
}

/**
 * The listing itself stands for the folder being browsed, which matters once
 * a hover has sprung a folder open mid-drag: the items can then be dropped
 * anywhere in it. In the folder they came from it refuses them (same parent).
 */
const routeFolderId = computed(() => {
  const id = route.params.file_id
  return (Array.isArray(id) ? id[0] : id) || undefined
})

const { isOver: isListingDropTarget, listeners: listingDropListeners } = useFolderDropTarget(
  () => props.dir ?? undefined,
  () => props.parents.slice(0, -1),
  // Until the folder being opened has loaded, a missing `dir` would read as the root.
  { disabled: () => routeFolderId.value !== props.dir?.id }
)

const runFileAction = (action: FileMenuAction, file: AppFile) => {
  switch (action) {
    case 'open':
      return openFile(file)
    case 'move':
      anchorId.value = file.id
      setSelection(new Set([file.id]))
      return emits('move-all')
    case 'download':
      return emits('download', file)
    case 'rename':
      return emits('rename', file)
    case 'sharing':
      return emits('sharing', file)
    case 'details':
      return emits('details', file)
    case 'fork':
      return emits('fork', file)
    case 'leave':
      return emits('leave', file)
    case 'remove':
      return emits('remove', file)
  }
}

const runSelectionAction = (action: SelectionMenuAction) => {
  switch (action) {
    case 'download-many':
      return emits('download-many')
    case 'move-all':
      return emits('move-all')
    case 'remove-all':
      return emits('remove-all')
  }
}

const runBlankAction = (action: BlankMenuAction) => {
  switch (action) {
    case 'directory':
      return emits('directory')
    case 'file':
      return emits('file')
    case 'browse':
      return emits('browse')
    case 'browse-folder':
      return emits('browse-folder')
    case 'select-all':
      return emits('select-all', props.items, dirId.value)
  }
}

/**
 * Right-clicking a row that is part of a multi-selection acts on all of it;
 * any other row becomes the selection first, as in native file managers.
 */
/**
 * Opens at the pointer, or for a menu raised from the keyboard, next to
 * `anchor` when given (the event's own target otherwise).
 */
const openMenu = <A extends string>(
  event: MouseEvent,
  request: Omit<ContextMenuRequest<A>, 'x' | 'y'>,
  anchor?: Element | null
) => {
  if (!anchor) return openContextMenuFromEvent(event, request)
  const rect = anchor.getBoundingClientRect()
  const opened = openContextMenu({
    anchor,
    ...request,
    x: rect.left + Math.min(rect.width / 2, 24),
    y: rect.top + rect.height / 2
  })
  if (opened) {
    event.preventDefault()
    event.stopPropagation()
  }
  return opened
}

const openRowMenu = (event: MouseEvent, file: AppFile, anchor?: Element | null) => {
  if (!props.selectionDisabled && selectedIds.value.has(file.id) && selectedRows.value.length > 1) {
    openMenu<SelectionMenuAction>(
      event,
      {
        items: selectionMenuItems(selectedRows.value, { t, hideDelete: props.hideDelete }),
        label: t('files.browser.selectedCount', { count: selectedRows.value.length }),
        onSelect: (item) => item.action && runSelectionAction(item.action)
      },
      anchor
    )
    return
  }

  if (!props.selectionDisabled) {
    anchorId.value = file.id
    setSelection(new Set(isSelectable(file) ? [file.id] : []))
  }
  openMenu<FileMenuAction>(event, {
    items: fileMenuItems(file, {
      t,
      sharingEnabled: sharingEnabled.value,
      forkEnabled: forkEnabled.value,
      hideDelete: props.hideDelete
    }),
    label: file.name,
    onSelect: (item) => item.action && runFileAction(item.action, file)
  }, anchor)
}

// Like a click on nothing, a right-click there drops the selection.
const openBlankMenu = (event: MouseEvent) => {
  if (!props.selectionDisabled) setSelection(new Set())
  openContextMenuFromEvent<BlankMenuAction>(event, {
    items: blankMenuItems({
      t,
      parentId: props.parentId,
      dir: props.dir,
      canSelectAll: !props.selectionDisabled && props.items.some(isSelectable)
    }),
    label: props.dir?.name || t('files.browser.fileList'),
    onSelect: (item) => item.action && runBlankAction(item.action)
  })
}

// The Menu key and Shift+F10 raise a contextmenu with no pointer position.
const isKeyboardRaised = (event: MouseEvent) => !event.clientX && !event.clientY

/**
 * Bound on the document so the page area below a short listing counts, the
 * same blank space a click clears the selection on. A touch long-press has
 * already claimed the event (it selects instead), and so has an open menu.
 */
const onContextMenu = (event: MouseEvent) => {
  if (event.defaultPrevented || !props.showActions || isDialogOpen()) return
  const target = event.target instanceof Element ? event.target : null
  if (!target) return

  const row = rowAt(target)
  if (row) {
    if (target.closest('.floating-menu')) return
    const file = props.items.find((f) => f.id === row.dataset.fileId)
    if (file) openRowMenu(event, file)
  } else if (isBlankSpace(target)) {
    if (isKeyboardRaised(event) && selectedRows.value.length) {
      // The Menu key with focus on the page (after a band or a blank click)
      // means the selection, as in native file managers, not empty space.
      const first = selectedRows.value[0]
      const anchor = listEl.value?.querySelector(`[data-file-id="${CSS.escape(first.id)}"]`)
      openRowMenu(event, first, anchor ?? tableEl.value)
    } else {
      openBlankMenu(event)
    }
  }
}

onMounted(() => {
  window.addEventListener('dragover', dragover)
  window.addEventListener('dragleave', dragleave)
  window.addEventListener('drop', drop)
  document.addEventListener('pointerdown', trackPress, true)
  document.addEventListener('click', onDocumentClick)
  window.addEventListener('keydown', onEscape, true)
  document.addEventListener('contextmenu', onContextMenu)
})
onUnmounted(() => {
  window.removeEventListener('dragover', dragover)
  window.removeEventListener('dragleave', dragleave)
  window.removeEventListener('drop', drop)
  document.removeEventListener('pointerdown', trackPress, true)
  document.removeEventListener('click', onDocumentClick)
  window.removeEventListener('keydown', onEscape, true)
  document.removeEventListener('contextmenu', onContextMenu)
})

const borderClass = 'sm:border-l sm:border-paper-300 sm:dark:border-brownish-950'

const sizes = {
  name: 'flex-1 p-2 pt-3 pl-3 min-w-0 flex',
  size: 'hidden p-2 pt-3 md:block w-28 shrink-0',
  type: 'hidden p-2 pt-3 xl:block w-24 shrink-0',
  modifiedAt: 'hidden p-2 pt-3 sm:block w-52 shrink-0',
  buttons: 'w-10 p-2 shrink-0'
}
</script>

<template>
  <div
    class="w-full min-h-[3.125rem] p-2 mb-2 flex items-center overflow-x-auto rounded-t-md bg-paper-100 dark:bg-brownish-900 gap-4"
    v-if="showActions"
  >
    <span
      v-if="selectedRows.length"
      data-testid="files-selected-count"
      class="self-center shrink-0 whitespace-nowrap text-sm text-brownish-700 dark:text-brownish-50"
    >{{ $t('files.browser.selectedCount', { count: selectedRows.length }) }}</span>

    <BaseButton
      :title="$t('files.delete.trashLabel')"
      :iconSize="20"
      :xs="true"
      :icon="mdiTrashCanOutline"
      color="danger"
      v-if="showDeleteAll"
      @click="() => emits('remove-all')"
    />

    <BaseButton
      :title="$t('files.browser.addToDownloadQueue')"
      :iconSize="20"
      :xs="true"
      :icon="mdiDownloadMultiple"
      color="light"
      v-if="showDownloadMany"
      @click="() => emits('download-many')"
    />

    <BaseButton
      :title="$t('common.move')"
      data-testid="move-selected"
      :iconSize="20"
      :xs="true"
      :icon="mdiFolderMove"
      color="light"
      v-if="showMoveAll"
      @click="() => emits('move-all')"
    />

    <span class="p-1" v-if="showMoveAll && singleSelected">|</span>

    <BaseButton
      :title="$t('files.browser.renameTitle')"
      :iconSize="20"
      :xs="true"
      :icon="mdiPencil"
      color="light"
      v-if="singleSelected"
      @click="() => emits('rename', singleSelected as AppFile)"
    />

    <BaseButton
      :title="$t('files.actions.preview')"
      :iconSize="20"
      :xs="true"
      :icon="mdiEye"
      color="light"
      v-if="singleSelected && isPreviewable(singleSelected)"
      :to="isMarkdownFile(singleSelected) ? { name: 'notes', params: { id: singleSelected.id } } : { name: 'file-preview', params: { id: singleSelected.id } }"
    />

    <BaseButton
      :title="$t('files.actions.details')"
      :iconSize="20"
      :xs="true"
      :icon="mdiInformationOutline"
      color="light"
      v-if="singleSelected"
      @click="() => emits('details', singleSelected as AppFile)"
    />

    <BaseButton
      :title="$t('files.actions.sharing')"
      :iconSize="20"
      :xs="true"
      :icon="mdiShareVariantOutline"
      color="light"
      v-if="
        singleSelected &&
        sharingEnabled &&
        singleSelected.id !== SHARED_WITH_ME_DIR_ID &&
        (
          singleSelected.is_owner === false ||
          singleSelected.mime === 'dir' ||
          !!singleSelected.finished_upload_at
        )
      "
      data-testid="bulk-sharing-button"
      @click="() => emits('sharing', singleSelected as AppFile)"
    />

    <!-- Selection actions sit on the left, create and upload on the right.
         The bar keeps one height whatever it holds: if selecting a row grew
         it, the listing would jump under a double click between its clicks. -->
    <div v-if="canCreate" class="ml-auto flex shrink-0 gap-4">
      <BaseButton
        name="create-dir"
        :title="$t('files.browser.createDirectory')"
        :iconSize="20"
        :xs="true"
        :icon="mdiFolderPlusOutline"
        color="light"
        @click="emits('directory')"
      />

      <BaseButton
        name="create-file"
        :title="$t('files.browser.newFile')"
        :iconSize="20"
        :xs="true"
        :icon="mdiFileDocumentPlusOutline"
        color="light"
        @click="emits('file')"
      />

      <BaseButton
        name="browse"
        :title="$t('files.browser.uploadFiles')"
        :iconSize="20"
        :xs="true"
        :icon="mdiFilePlusOutline"
        color="light"
        @click="emits('browse')"
      />

      <BaseButton
        name="browse-folder"
        :title="$t('files.browser.uploadFolder')"
        :iconSize="20"
        :xs="true"
        :icon="mdiFolderArrowUpOutline"
        color="light"
        @click="emits('browse-folder')"
      />
    </div>
  </div>

  <div
    ref="tableEl"
    :role="hasRows ? 'grid' : undefined"
    :aria-label="hasRows ? $t('files.browser.fileList') : undefined"
    :aria-multiselectable="hasRows && !props.selectionDisabled ? true : undefined"
    :class="{
      'border-2 border-redish-300 border-spacing-0 m-[-2px]': isDropZone,
      'outline outline-2 outline-orangy-500': isListingDropTarget
    }"
    :data-drop-over="isListingDropTarget ? 'true' : undefined"
    class="bg-white dark:bg-brownish-900 rounded-lg border border-paper-300/40 dark:border-brownish-700/40"
    v-on="listingDropListeners"
  >
    <div
      data-table-header
      :role="hasRows ? 'row' : undefined"
      class="w-full flex rounded-t-lg bg-paper-100 dark:bg-brownish-950 border-b border-paper-300 dark:border-brownish-700/40"
    >
      <div :class="`${sizes.name}`" v-bind="columnHeader('name')">
        <SortableName
          name="name"
          :label="$t('common.name')"
          :sort-options="sortOptions"
          @sort="(v: string) => emits('set-sort-simple', v)"
        />
      </div>

      <div :class="`${sizes.size} ${borderClass}`" v-bind="columnHeader('size')">
        <SortableName
          name="size"
          :label="$t('common.size')"
          :sort-options="sortOptions"
          @sort="(v: string) => emits('set-sort-simple', v)"
        />
      </div>

      <div :class="`${sizes.type} ${borderClass}`" v-bind="columnHeader('mime')">
        <SortableName
          name="mime"
          :label="$t('common.type')"
          :sort-options="sortOptions"
          @sort="(v: string) => emits('set-sort-simple', v)"
        />
      </div>

      <div :class="`${sizes.modifiedAt} ${borderClass}`" v-bind="columnHeader('file_modified_at')">
        <SortableName
          name="file_modified_at"
          :label="$t('common.modified')"
          :sort-options="sortOptions"
          @sort="(v: string) => emits('set-sort-simple', v)"
        />
      </div>

      <div :class="`${sizes.buttons}`" v-bind="columnHeader()">
        <span v-if="hasRows" class="sr-only">{{ $t('common.actions') }}</span>
      </div>
    </div>

    <div
      v-if="props.error"
      class="w-full rounded-b-lg bg-paper-50 dark:bg-brownish-900 py-10 flex flex-col items-center gap-3"
      data-testid="files-error"
    >
      <span class="text-sm text-brownish-300 dark:text-brownish-50 px-6 text-center">
        {{ $t(props.error) }}
      </span>
      <BaseButton color="info" small :label="$t('common.retry')" @click="emits('retry')" />
    </div>
    <!-- Cached rows for the target folder render immediately; this only covers
         a folder we know nothing about yet. Placeholder rows on the real
         columns say what is arriving and stop the header jumping when it does,
         which a spinner in the middle of the panel does neither of. -->
    <div
      v-else-if="props.loading && !props.items.length"
      class="w-full rounded-b-lg bg-paper-50 dark:bg-brownish-900"
      data-testid="files-loading"
      role="status"
      :aria-label="$t('common.loading')"
    >
      <div
        v-for="(width, index) in ['w-2/5', 'w-3/5', 'w-1/3', 'w-1/2', 'w-2/5']"
        :key="index"
        class="w-full flex file-row-separator animate-pulse"
        aria-hidden="true"
      >
        <div :class="sizes.name">
          <div class="w-6 h-6 mr-2 rounded-md shrink-0 bg-paper-200 dark:bg-brownish-700" />
          <div class="h-4 rounded bg-paper-200 dark:bg-brownish-700" :class="width" />
        </div>
        <div :class="sizes.size">
          <div class="h-3 w-12 rounded bg-paper-200/70 dark:bg-brownish-700/60" />
        </div>
        <div :class="sizes.type">
          <div class="h-3 w-12 rounded bg-paper-200/70 dark:bg-brownish-700/60" />
        </div>
        <div :class="sizes.modifiedAt">
          <div class="h-3 w-28 rounded bg-paper-200/70 dark:bg-brownish-700/60" />
        </div>
        <div :class="sizes.buttons" />
      </div>
    </div>
    <div
      v-else-if="!props.items.length"
      class="w-full rounded-b-lg bg-paper-50 dark:bg-brownish-900 py-14 flex flex-col items-center gap-1"
      data-testid="files-empty"
    >
      <span class="text-brownish-300 dark:text-brownish-50">{{
        $t('files.browser.emptyFolder')
      }}</span>
      <span class="text-xs text-brownish-200 dark:text-brownish-50">
        {{ $t('files.browser.emptyFolderHint') }}
      </span>
    </div>
    <div
      v-else
      ref="listEl"
      role="rowgroup"
      class="flex flex-col rounded-b-lg"
      @keydown="onListKeydown"
      @dragstart="onDragstart"
      @dragend="endFileDrag"
    >
      <template v-for="file in props.items" :key="file.id">
        <TableFileRowWatcher
          :file="file"
          :sizes="sizes"
          :selected="selectedIds.has(file.id)"
          :selectionDisabled="props.selectionDisabled"
          :hideDelete="props.hideDelete"
          :share="props.share"
          :highlighted="props.searchedFileId === file.id"
          :ancestors="props.parents"
          @actions="(f: AppFile) => emits('actions', f)"
          @details="(f: AppFile) => emits('details', f)"
          @download="(f: AppFile) => emits('download', f)"
          @remove="(f: AppFile) => emits('remove', f)"
          @rename="(f: AppFile) => emits('rename', f)"
          @sharing="(f: AppFile) => emits('sharing', f)"
          @fork="(f: AppFile) => emits('fork', f)"
          @leave="(f: AppFile) => emits('leave', f)"
          @row-click="onRowClick"
          @upload-many="(f: FileList, d?: string) => emits('upload-many', f, d)"
        />
      </template>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="band"
      data-testid="selection-marquee"
      aria-hidden="true"
      class="fixed z-20 pointer-events-none rounded-sm border border-orangy-600 bg-orangy-500/20"
      :style="{
        left: `${band.left}px`,
        top: `${band.top}px`,
        width: `${band.right - band.left}px`,
        height: `${band.bottom - band.top}px`
      }"
    />
  </Teleport>
</template>
