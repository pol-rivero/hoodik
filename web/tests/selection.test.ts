import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mergeModeFor,
  mergeSelection,
  rangeBetween,
  rectFromPoints,
  rectsIntersect,
  sameSet,
  stackedHits,
  swallowNextClick
} from '../src/utils/selection'

const set = (...ids: string[]) => new Set(ids)
const sorted = (ids: Set<string>) => [...ids].sort()

describe('rectFromPoints', () => {
  it('normalizes a band dragged in any direction', () => {
    const expected = { left: 10, top: 20, right: 30, bottom: 40 }
    expect(rectFromPoints(10, 20, 30, 40)).toEqual(expected)
    expect(rectFromPoints(30, 40, 10, 20)).toEqual(expected)
    expect(rectFromPoints(30, 20, 10, 40)).toEqual(expected)
  })
})

describe('rectsIntersect', () => {
  const row = { left: 0, top: 100, right: 500, bottom: 140 }

  it('hits a row the band overlaps', () => {
    expect(rectsIntersect(rectFromPoints(50, 90, 60, 110), row)).toBe(true)
    expect(rectsIntersect(rectFromPoints(50, 120, 60, 125), row)).toBe(true)
  })

  it('hits a row the band fully covers', () => {
    expect(rectsIntersect(rectFromPoints(-10, 0, 600, 300), row)).toBe(true)
  })

  it('misses a row the band only touches or passes by', () => {
    expect(rectsIntersect(rectFromPoints(50, 60, 60, 100), row)).toBe(false)
    expect(rectsIntersect(rectFromPoints(50, 140, 60, 180), row)).toBe(false)
    expect(rectsIntersect(rectFromPoints(510, 110, 520, 120), row)).toBe(false)
  })
})

describe('stackedHits', () => {
  // Ten 40px rows stacked from y=100, each 500px wide.
  const rows = Array.from({ length: 10 }, (_, i) => ({
    left: 0,
    right: 500,
    top: 100 + i * 40,
    bottom: 140 + i * 40
  }))

  const hits = (band: ReturnType<typeof rectFromPoints>) => {
    const read: number[] = []
    const result = stackedHits(rows.length, (i) => (read.push(i), rows[i]), band)
    return { result, read: new Set(read) }
  }

  it('finds the rows the band crosses', () => {
    expect(hits(rectFromPoints(10, 150, 20, 230)).result).toEqual([1, 2, 3])
  })

  it('finds nothing above, below or beside the rows', () => {
    expect(hits(rectFromPoints(10, 0, 20, 100)).result).toEqual([])
    expect(hits(rectFromPoints(10, 500, 20, 900)).result).toEqual([])
    expect(hits(rectFromPoints(600, 150, 700, 230)).result).toEqual([])
  })

  it('covers every row when the band does', () => {
    expect(hits(rectFromPoints(-10, 0, 600, 1000)).result).toEqual([...rows.keys()])
  })

  it('only measures the rows near the band', () => {
    const { read } = hits(rectFromPoints(10, 430, 20, 450))
    expect(read.size).toBeLessThan(rows.length)
    expect(read.has(0)).toBe(false)
  })
})

describe('mergeModeFor', () => {
  const keys = { ctrlKey: false, metaKey: false, shiftKey: false }

  it('replaces without modifiers', () => {
    expect(mergeModeFor(keys)).toBe('replace')
  })

  it('toggles with Ctrl or Cmd, even with Shift held', () => {
    expect(mergeModeFor({ ...keys, ctrlKey: true })).toBe('toggle')
    expect(mergeModeFor({ ...keys, metaKey: true })).toBe('toggle')
    expect(mergeModeFor({ ...keys, ctrlKey: true, shiftKey: true })).toBe('toggle')
  })

  it('adds with Shift', () => {
    expect(mergeModeFor({ ...keys, shiftKey: true })).toBe('add')
  })
})

describe('mergeSelection', () => {
  const base = set('a', 'b')
  const hits = set('b', 'c')

  it('replace keeps only the hits', () => {
    expect(sorted(mergeSelection(base, hits, 'replace'))).toEqual(['b', 'c'])
  })

  it('add unions the hits with the starting selection', () => {
    expect(sorted(mergeSelection(base, hits, 'add'))).toEqual(['a', 'b', 'c'])
  })

  it('toggle flips each hit relative to the starting selection', () => {
    expect(sorted(mergeSelection(base, hits, 'toggle'))).toEqual(['a', 'c'])
  })

  it('shrinking the band gives back what it toggled', () => {
    expect(sorted(mergeSelection(base, set(), 'toggle'))).toEqual(['a', 'b'])
  })

  it('never mutates the starting selection', () => {
    mergeSelection(base, hits, 'toggle')
    mergeSelection(base, hits, 'add')
    expect(sorted(base)).toEqual(['a', 'b'])
  })
})

describe('rangeBetween', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']

  it('selects from the anchor down to the target', () => {
    expect(rangeBetween(ids, 'b', 'd')).toEqual(['b', 'c', 'd'])
  })

  it('selects from the anchor up to the target', () => {
    expect(rangeBetween(ids, 'd', 'a')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('falls back to the target alone without a usable anchor', () => {
    expect(rangeBetween(ids, null, 'c')).toEqual(['c'])
    expect(rangeBetween(ids, 'gone', 'c')).toEqual(['c'])
  })

  it('is empty for a target that is not in the list', () => {
    expect(rangeBetween(ids, 'a', 'gone')).toEqual([])
  })
})

describe('sameSet', () => {
  it('compares membership regardless of order', () => {
    expect(sameSet(set('a', 'b'), set('b', 'a'))).toBe(true)
    expect(sameSet(set('a'), set('a', 'b'))).toBe(false)
    expect(sameSet(set('a', 'c'), set('a', 'b'))).toBe(false)
  })
})

describe('swallowNextClick', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const click = () => {
    const onClick = vi.fn()
    document.body.addEventListener('click', onClick, { once: true })
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.body.removeEventListener('click', onClick)
    return onClick.mock.calls.length > 0
  }

  it('swallows only the click that ends the gesture', () => {
    swallowNextClick()
    expect(click()).toBe(false)
    expect(click()).toBe(true)
  })

  it('stops waiting once the gesture is over without a click', () => {
    vi.useFakeTimers()
    swallowNextClick()
    vi.runAllTimers()
    expect(click()).toBe(true)
  })

  it('waits for the release when asked to', () => {
    vi.useFakeTimers()
    swallowNextClick(true)
    vi.advanceTimersByTime(5000)
    window.dispatchEvent(new Event('pointerup'))
    expect(click()).toBe(false)

    swallowNextClick(true)
    window.dispatchEvent(new Event('pointerup'))
    vi.runAllTimers()
    expect(click()).toBe(true)
  })
})
