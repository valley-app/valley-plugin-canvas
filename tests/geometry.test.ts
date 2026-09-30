import { describe, expect, it } from 'vitest'
import {
  bezierMidpoint,
  arrowPoints,
  bezierPath,
  boundsOf,
  chooseSide,
  clamp,
  fitView,
  gridSpacing,
  panBy,
  pointInRect,
  rectContains,
  rectFromPoints,
  rectsIntersect,
  resizeRect,
  screenToWorld,
  sideAnchor,
  snap,
  snapToObjects,
  worldToScreen,
  MAX_ZOOM,
  MAX_ZOOM_LOG2,
  MIN_ZOOM,
  MIN_ZOOM_LOG2,
  zoomBy,
  zoomMultiplier,
  zoomAt,
  type Viewport
} from '../src/geometry'
import type { CanvasNode } from '../src/canvasModel'

const v: Viewport = { x: 100, y: 50, zoom: 2 }

describe('viewport transforms', () => {
  it('preserves aspect ratio and the opposite anchor for every resize handle', () => {
    const start = { x: 20, y: 30, width: 240, height: 120 }
    for (const handle of ['n','ne','e','se','s','sw','w','nw'] as const) {
      for (const delta of [-500,-60,0,45,500]) {
        const result = resizeRect(start, handle, delta, delta / 2, 60, true)
        expect(result.width / result.height).toBeCloseTo(2)
        expect(result.width).toBeGreaterThanOrEqual(60)
        expect(result.height).toBeGreaterThanOrEqual(60)
        if (handle.includes('w')) expect(result.x + result.width).toBe(start.x + start.width)
        if (handle.includes('n')) expect(result.y + result.height).toBe(start.y + start.height)
      }
    }
  })
  it('worldToScreen and screenToWorld are inverses', () => {
    const screen = worldToScreen(v, 30, 40)
    expect(screen).toEqual({ x: 30 * 2 + 100, y: 40 * 2 + 50 })
    const world = screenToWorld(v, screen.x, screen.y)
    expect(world.x).toBeCloseTo(30)
    expect(world.y).toBeCloseTo(40)
  })

  it('panBy shifts the origin in screen space', () => {
    expect(panBy(v, 10, -5)).toEqual({ x: 110, y: 45, zoom: 2 })
  })

  it('zoomAt keeps the world point under the pivot fixed', () => {
    const pivot = { x: 300, y: 200 }
    // From 0.5×, so 1.5× lands inside the bounds rather than on the ceiling.
    const start = { ...v, zoom: 0.5 }
    const before = screenToWorld(start, pivot.x, pivot.y)
    const zoomed = zoomAt(start, pivot.x, pivot.y, 1.5)
    const after = screenToWorld(zoomed, pivot.x, pivot.y)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(zoomed.zoom).toBeCloseTo(0.75)
  })

  // The log2 zoom is clamped to [-4, 1]; these are those bounds as scales.
  it('zoomAt clamps to the zoom bounds', () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 0, 0, 100).zoom).toBe(MAX_ZOOM)
    expect(MAX_ZOOM).toBe(2)
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 0, 0, 0.001).zoom).toBe(MIN_ZOOM)
    expect(MIN_ZOOM).toBe(0.0625)
  })

  it('zoomBy moves in octaves — the same input travels the same distance', () => {
    expect(zoomBy({ x: 0, y: 0, zoom: 0.5 }, 0, 0, 1).zoom).toBeCloseTo(1)
    expect(zoomBy({ x: 0, y: 0, zoom: 1 }, 0, 0, 1).zoom).toBeCloseTo(2)
    expect(zoomBy({ x: 0, y: 0, zoom: 1 }, 0, 0, -1).zoom).toBeCloseTo(0.5)
    // A pivot is still honoured: the world point under it does not move.
    const pivoted = zoomBy({ x: 100, y: 50, zoom: 1 }, 300, 200, -0.5)
    const at = screenToWorld(pivoted, 300, 200)
    expect(at.x).toBeCloseTo(screenToWorld({ x: 100, y: 50, zoom: 1 }, 300, 200).x)
  })

  // The thresholds, expressed in scale: 2^-3.3, 2^-2.16, 2^-0.91.
  it('gridSpacing steps with the zoom so screen density stays even', () => {
    expect(gridSpacing(1)).toBe(20)
    expect(gridSpacing(2)).toBe(20)
    expect(gridSpacing(0.5)).toBe(40) // log2 = -1, below -0.91
    expect(gridSpacing(0.2)).toBe(80) // log2 ≈ -2.32, below -2.16
    expect(gridSpacing(0.0625)).toBe(160) // log2 = -4, below -3.3
  })

  it('gridSpacing keeps the drawn dot pitch legible at every zoom', () => {
    // The whole point of stepping. Across the full range the pitch stays in
    // roughly 8–41px; the old fixed 24-unit grid put the dots 1.5px apart at
    // min zoom, which is not a grid, it is a grey wash.
    let min = Infinity
    let max = 0
    for (let log2 = MIN_ZOOM_LOG2; log2 <= MAX_ZOOM_LOG2; log2 += 0.01) {
      const zoom = 2 ** log2
      const pitch = gridSpacing(zoom) * zoom
      min = Math.min(min, pitch)
      max = Math.max(max, pitch)
    }
    expect(min).toBeGreaterThan(8)
    expect(max).toBeLessThan(42)
    // A fixed spacing, for contrast: unusable at the bottom of the range.
    expect(24 * MIN_ZOOM).toBeLessThan(2)
  })

  it('zoomMultiplier gives chrome back part of the scale, not all of it', () => {
    expect(zoomMultiplier(1)).toBe(1)
    expect(zoomMultiplier(0.25)).toBe(2) // sqrt(4), not 4
    expect(zoomMultiplier(4)).toBe(0.5)
  })

  it('clamp bounds a value', () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
    expect(clamp(2, 0, 3)).toBe(2)
  })
})

describe('rect math', () => {
  it('pointInRect', () => {
    const r = { x: 0, y: 0, width: 10, height: 10 }
    expect(pointInRect(5, 5, r)).toBe(true)
    expect(pointInRect(11, 5, r)).toBe(false)
  })
  it('rectsIntersect', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true)
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 })).toBe(false)
  })
  it('rectContains', () => {
    expect(rectContains({ x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 10, width: 20, height: 20 })).toBe(true)
    expect(rectContains({ x: 0, y: 0, width: 100, height: 100 }, { x: 90, y: 90, width: 20, height: 20 })).toBe(false)
  })
  it('rectFromPoints normalizes corner order', () => {
    expect(rectFromPoints({ x: 30, y: 40 }, { x: 10, y: 5 })).toEqual({ x: 10, y: 5, width: 20, height: 35 })
  })
})

describe('edge geometry', () => {
  const r = { x: 0, y: 0, width: 100, height: 50 }
  it('sideAnchor returns the midpoint of each side', () => {
    expect(sideAnchor(r, 'top')).toEqual({ x: 50, y: 0 })
    expect(sideAnchor(r, 'bottom')).toEqual({ x: 50, y: 50 })
    expect(sideAnchor(r, 'left')).toEqual({ x: 0, y: 25 })
    expect(sideAnchor(r, 'right')).toEqual({ x: 100, y: 25 })
  })

  it('chooseSide points toward the other node', () => {
    const a = { x: 0, y: 0, width: 50, height: 50 }
    expect(chooseSide(a, { x: 200, y: 0, width: 50, height: 50 })).toBe('right')
    expect(chooseSide(a, { x: -200, y: 0, width: 50, height: 50 })).toBe('left')
    expect(chooseSide(a, { x: 0, y: 200, width: 50, height: 50 })).toBe('bottom')
    expect(chooseSide(a, { x: 0, y: -200, width: 50, height: 50 })).toBe('top')
  })

  it('bezierPath starts at the from-anchor with a cubic segment', () => {
    const d = bezierPath({ x: 0, y: 0 }, 'right', { x: 100, y: 0 }, 'left')
    expect(d.startsWith('M 0 0 C')).toBe(true)
  })

  it('arrowPoints returns three coordinate pairs', () => {
    const pts = arrowPoints({ x: 10, y: 0 }, 'left', 12).trim().split(/\s+/)
    expect(pts).toHaveLength(3)
    expect(pts[0]).toBe('10,0')
  })
})

describe('bounds + fit + snap + resize', () => {
  const nodes: CanvasNode[] = [
    { id: 'a', type: 'text', text: '', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', type: 'text', text: '', x: 200, y: 150, width: 100, height: 50 }
  ]

  it('boundsOf wraps every node', () => {
    expect(boundsOf(nodes)).toEqual({ x: 0, y: 0, width: 300, height: 200 })
    expect(boundsOf([])).toBeNull()
  })

  it('fitView centers content and never zooms past 1', () => {
    const fit = fitView({ x: 0, y: 0, width: 300, height: 200 }, 600, 400)
    expect(fit.zoom).toBeLessThanOrEqual(1)
    const center = worldToScreen(fit, 150, 100)
    expect(center.x).toBeCloseTo(300)
    expect(center.y).toBeCloseTo(200)
  })

  it('snap rounds to the grid', () => {
    expect(snap(23, 20)).toBe(20)
    expect(snap(31, 20)).toBe(40)
    expect(snap(31, 0)).toBe(31) // a zero grid is a no-op
  })

  it('resizeRect grows from the east handle', () => {
    expect(resizeRect({ x: 0, y: 0, width: 100, height: 100 }, 'e', 20, 0, 40)).toEqual({ x: 0, y: 0, width: 120, height: 100 })
  })

  it('resizeRect from the west handle moves the origin and clamps to the minimum', () => {
    // Drag the west edge far right past the minimum: width clamps, x holds the
    // opposite (east) edge fixed.
    const out = resizeRect({ x: 0, y: 0, width: 100, height: 100 }, 'w', 200, 0, 40)
    expect(out.width).toBe(40)
    expect(out.x).toBe(60)
  })
})

describe('snapToObjects', () => {
  const other = { x: 100, y: 50, width: 50, height: 50 }

  it('snaps to a near edge within the threshold and returns a guide', () => {
    // Dragged left/center/right are all 3px right of `other` → nudge dx = -3.
    const res = snapToObjects({ x: 103, y: 200, width: 50, height: 50 }, [other], 8)
    expect(res.dx).toBe(-3)
    expect(res.dy).toBe(0)
    expect(res.guides).toHaveLength(1)
    expect(res.guides[0].orientation).toBe('v')
    expect(res.guides[0].x1).toBe(100) // aligned to other's left edge
  })

  it('is a no-op when no edge is within the threshold', () => {
    const res = snapToObjects({ x: 200, y: 200, width: 50, height: 50 }, [other], 8)
    expect(res).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('snaps both axes and returns a guide per snapped axis', () => {
    const res = snapToObjects({ x: 103, y: 47, width: 50, height: 50 }, [other], 8)
    expect(res.dx).toBe(-3)
    expect(res.dy).toBe(3)
    expect(res.guides).toHaveLength(2)
    expect(res.guides.map((g) => g.orientation).sort()).toEqual(['h', 'v'])
  })
})

describe('bezierMidpoint', () => {
  // The straight-line midpoint is not the curve midpoint once an edge bows, so
  // an edge label anchored to it drifts off the connector. Cubic at t=0.5 is
  // (P0 + 3·P1 + 3·P2 + P3) / 8.
  it('matches the closed form for a right→left connector', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 200, y: 0 }
    // dist = 200 → d = clamp(100, 30, 400) = 100.
    // c1 = (100, 0) leaving `right`; c2 = (100, 0) leaving `left`.
    const mid = bezierMidpoint(from, 'right', to, 'left')
    expect(mid.x).toBeCloseTo((0 + 3 * 100 + 3 * 100 + 200) / 8, 6)
    expect(mid.y).toBeCloseTo(0, 6)
  })

  it('bows away from the straight line for same-side anchors', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 200, y: 0 }
    // Both anchors leave downward, so the curve — and its midpoint — sits below
    // the straight line joining them.
    const mid = bezierMidpoint(from, 'bottom', to, 'bottom')
    expect(mid.y).toBeGreaterThan(0)
    expect(mid.x).toBeCloseTo(100, 6)
  })

  it('is symmetric when the endpoints are mirrored', () => {
    const a = bezierMidpoint({ x: 0, y: 0 }, 'right', { x: 200, y: 120 }, 'left')
    const b = bezierMidpoint({ x: 200, y: 120 }, 'left', { x: 0, y: 0 }, 'right')
    expect(a.x).toBeCloseTo(b.x, 6)
    expect(a.y).toBeCloseTo(b.y, 6)
  })

  it('stays on the path bezierPath draws', () => {
    // Same control points feed both, so the label can never anchor to a curve
    // the renderer is not drawing.
    const d = bezierPath({ x: 0, y: 0 }, 'right', { x: 200, y: 0 }, 'left')
    expect(d).toBe('M 0 0 C 100 0 100 0 200 0')
  })
})

describe('side geometry is total', () => {
  // A .canvas from another tool is untrusted input: an exhaustive switch returns
  // undefined for a side outside the enum and the caller then reads `.x` off it,
  // which is what crashed the whole view on the broken-board fixture.
  const bogus = 'sideways' as unknown as Parameters<typeof sideAnchor>[1]
  const rect = { x: 0, y: 0, width: 100, height: 50 }

  it('sideAnchor returns a real point for a side outside the enum', () => {
    const p = sideAnchor(rect, bogus)
    expect(Number.isFinite(p.x)).toBe(true)
    expect(Number.isFinite(p.y)).toBe(true)
  })

  it('bezierPath and arrowPoints stay finite with a bogus side', () => {
    expect(bezierPath(sideAnchor(rect, bogus), bogus, { x: 200, y: 0 }, 'left')).not.toContain('NaN')
    expect(arrowPoints({ x: 0, y: 0 }, bogus, 10)).not.toContain('NaN')
  })
})
