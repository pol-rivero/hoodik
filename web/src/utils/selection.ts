export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Modifiers {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * How a rubber-band (or range) selection combines with what was selected
 * before it started: `replace` drops the old selection, `toggle` flips every
 * hit relative to it (Ctrl/Cmd), `add` unions with it (Shift).
 */
export type MergeMode = 'replace' | 'toggle' | 'add'

export const rectFromPoints = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  left: Math.min(x1, x2),
  top: Math.min(y1, y2),
  right: Math.max(x1, x2),
  bottom: Math.max(y1, y2)
})

/** Edges that merely touch don't count, so a band stopping on a row border skips that row. */
export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/**
 * Indexes of the rects `band` intersects, for rects stacked top to bottom
 * without overlap (rows of a list). Binary-searches the first candidate, so
 * a band over a long list reads only the rects near it.
 */
export const stackedHits = (
  count: number,
  rectAt: (index: number) => Rect,
  band: Rect
): number[] => {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rectAt(mid).bottom <= band.top) lo = mid + 1
    else hi = mid
  }

  const hits: number[] = []
  for (let i = lo; i < count; i++) {
    const rect = rectAt(i)
    if (rect.top >= band.bottom) break
    if (rectsIntersect(band, rect)) hits.push(i)
  }
  return hits
}

export const mergeModeFor = (modifiers: Modifiers): MergeMode => {
  if (modifiers.ctrlKey || modifiers.metaKey) return 'toggle'
  if (modifiers.shiftKey) return 'add'
  return 'replace'
}

export const mergeSelection = (
  base: ReadonlySet<string>,
  hits: ReadonlySet<string>,
  mode: MergeMode
): Set<string> => {
  if (mode === 'replace') return new Set(hits)

  const result = new Set(base)
  for (const id of hits) {
    if (mode === 'toggle' && base.has(id)) result.delete(id)
    else result.add(id)
  }
  return result
}

/** Ids from `anchor` to `target` inclusive, in list order; just `target` when the anchor is gone. */
export const rangeBetween = (
  ids: readonly string[],
  anchor: string | null,
  target: string
): string[] => {
  const to = ids.indexOf(target)
  if (to < 0) return []
  const from = anchor === null ? -1 : ids.indexOf(anchor)
  if (from < 0) return [target]

  const [start, end] = from <= to ? [from, to] : [to, from]
  return ids.slice(start, end + 1)
}

export const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((id) => b.has(id))

/**
 * Swallows the click the browser synthesises at the end of a gesture that
 * already did its job (a rubber band, a long press), so it doesn't land as a
 * plain click and reset the selection. A mouse click follows its pointerup in
 * the same task; a touch one may trail it, hence the longer grace there.
 */
export const swallowNextClick = (untilRelease = false) => {
  const swallow = (event: Event) => {
    event.stopPropagation()
    event.preventDefault()
    done()
  }
  const release = () => setTimeout(done, 400)
  const done = () => {
    window.removeEventListener('click', swallow, true)
    window.removeEventListener('pointerup', release, true)
    window.removeEventListener('pointercancel', release, true)
  }

  window.addEventListener('click', swallow, true)
  if (untilRelease) {
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
  } else {
    setTimeout(done, 0)
  }
}
