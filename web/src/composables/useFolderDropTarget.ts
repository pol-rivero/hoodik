import { onUnmounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import {
  activeDrag,
  canDropInto,
  canSpringLoadAt,
  endFileDrag,
  isInSharedTree,
  isInternalFileDrag,
  markDropAccepted,
  noteSpringLoad
} from '!/storage/dragMove'
import type { DropRejection, DropVerdict, FileDrag } from '!/storage/dragMove'
import { capabilitiesStore } from '!/shares/capabilities'
import { moveInFlight } from '!/storage/moveFiles'
import { moveFilesInteractive } from './useMoveFiles'

import type { AppFile } from 'types'

// Refused as a drop but still worth opening: their subfolders can be valid.
const SPRING_LOADABLE = new Set<DropRejection>(['same-parent', 'synthetic-root'])

export interface FolderDropTargetOptions {
  /** Replaces the default drop action (move with a success notification). */
  onDrop?: (target: AppFile | undefined, drag: FileDrag) => void
  /**
   * Called after hovering for `springLoadDelay` ms, for a target that is a
   * valid drop, the items' own folder or the synthetic "Shared with me"
   * folder (their subfolders can still be valid). Used to expand a
   * collapsed tree node.
   */
  onSpringLoad?: () => void
  springLoadDelay?: number
  /** Turn the target off without unbinding the listeners. */
  disabled?: () => boolean
}

export interface FolderDropTarget {
  /** A valid internal drag is over the target: render the highlight. */
  isOver: Ref<boolean>
  /** An internal drag the target refuses is over it. */
  isRejected: Ref<boolean>
  onDragenter: (event: DragEvent) => void
  onDragover: (event: DragEvent) => void
  onDragleave: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  /** The four handlers keyed by event name, for `v-on="listeners"`. */
  listeners: {
    dragenter: (event: DragEvent) => void
    dragover: (event: DragEvent) => void
    dragleave: (event: DragEvent) => void
    drop: (event: DragEvent) => void
  }
}

/**
 * Drop-target behaviour for one folder (or the account root, when
 * `getTarget` returns undefined) receiving files dragged with
 * `beginFileDrag`. Only internal drags are handled; OS file drops pass
 * through untouched to whatever upload handler the element already has.
 *
 * `getAncestors` returns the target's folder chain, root-first and
 * excluding the target, so dropping a folder into its own subtree is
 * refused and shared-tree destinations are recognised.
 */
export function useFolderDropTarget(
  getTarget: () => AppFile | undefined,
  getAncestors: () => readonly AppFile[],
  options: FolderDropTargetOptions = {}
): FolderDropTarget {
  const isOver = ref(false)
  const isRejected = ref(false)
  // dragenter/dragleave also fire for every child element crossed; only the
  // last leave means the pointer left the target.
  let depth = 0
  let springTimer: ReturnType<typeof setTimeout> | null = null
  let pointer = { x: 0, y: 0 }

  const verdict = (): DropVerdict => {
    if (options.disabled?.()) return { ok: false, reason: 'no-drag' }
    const ancestors = getAncestors()
    return canDropInto(getTarget(), {
      drag: activeDrag.value,
      targetAncestorIds: ancestors.map((a) => a.id),
      targetInSharedTree: isInSharedTree(ancestors),
      sharingEnabled: capabilitiesStore().sharingEnabled,
      moveInFlight: moveInFlight.value
    })
  }

  const clearSpring = () => {
    if (springTimer) clearTimeout(springTimer)
    springTimer = null
  }

  const reset = () => {
    depth = 0
    isOver.value = false
    isRejected.value = false
    clearSpring()
  }

  const armSpring = (v: DropVerdict) => {
    if (!options.onSpringLoad || springTimer) return
    if (!v.ok && !SPRING_LOADABLE.has(v.reason)) return
    if (!canSpringLoadAt(pointer.x, pointer.y)) return
    springTimer = setTimeout(() => {
      springTimer = null
      if (depth === 0) return
      noteSpringLoad(pointer)
      options.onSpringLoad?.()
    }, options.springLoadDelay ?? 700)
  }

  const apply = (event: DragEvent, arm = true): boolean => {
    pointer = { x: event.clientX ?? 0, y: event.clientY ?? 0 }
    const v = verdict()
    isOver.value = v.ok
    isRejected.value = !v.ok
    if (arm) armSpring(v)
    if (v.ok) {
      event.preventDefault()
      event.stopPropagation()
      markDropAccepted(event)
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    } else if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'none'
    }
    return v.ok
  }

  const onDragenter = (event: DragEvent) => {
    if (!isInternalFileDrag(event)) return
    depth++
    apply(event)
  }

  const onDragover = (event: DragEvent) => {
    if (!isInternalFileDrag(event)) return
    // A drag that entered before this element rendered never counted in.
    // Such an element appeared under the pointer (a spring-load swapped the
    // listing), so it doesn't arm a spring-load of its own from here.
    const appeared = depth === 0
    if (appeared) depth = 1
    apply(event, !appeared)
  }

  const onDragleave = (event: DragEvent) => {
    if (!isInternalFileDrag(event)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) reset()
  }

  const onDrop = (event: DragEvent) => {
    if (!isInternalFileDrag(event)) return
    const drag = activeDrag.value
    const target = getTarget()
    const ok = verdict().ok
    reset()
    if (!ok || !drag) return

    event.preventDefault()
    event.stopPropagation()
    endFileDrag()

    if (options.onDrop) {
      options.onDrop(target, drag)
    } else {
      moveFilesInteractive(drag.files, target, {
        sourceParent: drag.sourceParent,
        notifySuccess: true,
        confirmFileShares: true
      })
    }
  }

  const stop = watch(activeDrag, (drag) => {
    if (!drag) reset()
  })
  onUnmounted(() => {
    stop()
    clearSpring()
  })

  return {
    isOver,
    isRejected,
    onDragenter,
    onDragover,
    onDragleave,
    onDrop,
    listeners: {
      dragenter: onDragenter,
      dragover: onDragover,
      dragleave: onDragleave,
      drop: onDrop
    }
  }
}
