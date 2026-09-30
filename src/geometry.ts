/**
 * Pure 2-D geometry for the infinite canvas: the screen↔world viewport
 * transform, rect math/hit-testing, edge anchor + bezier/arrow geometry, content
 * bounds + fit-to-view, and grid snapping. React-free, unit-tested
 * (`plugins/canvas/tests/geometry.test.ts`).
 *
 * The world layer is a single CSS-`transform`ed element: a world point `(wx,wy)`
 * maps to the screen as `wx*zoom + x`, so edges/arrows are drawn directly in
 * world units inside that element (they pan/zoom with the nodes for free).
 */
import type { CanvasNode, EdgeSide } from './canvasModel'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** `x`/`y` = screen-space translation of the world origin; `zoom` = scale. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/**
 * Zoom is stored as a scale but reasoned about in **log2**: the zoom exponent is
 * clamped to `[-4, 1]` and `scale = 2 ** zoom`. Matching the bounds matters as
 * much as matching the curve — a board that zooms to 4× when other JSON Canvas
 * editors stop at 2× feels wrong long before you notice the number.
 */
export const MIN_ZOOM_LOG2 = -4
export const MAX_ZOOM_LOG2 = 1
export const MIN_ZOOM = 2 ** MIN_ZOOM_LOG2 // 0.0625
export const MAX_ZOOM = 2 ** MAX_ZOOM_LOG2 // 2

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * World units between background dots, stepped so the **screen** density stays
 * roughly constant instead of collapsing into a haze as you zoom out. The
 * thresholds switch on the log2 zoom:
 *
 * ```
 * zoom < -3.3 → 160   zoom < -2.16 → 80   zoom < -0.91 → 40   else → 20
 * ```
 *
 * A fixed spacing (what this canvas had) multiplies straight through by the
 * scale, so at 0.1× a 24-unit grid lands dots 2.4px apart — solid grey — and at
 * 4× it strands them 96px apart. Stepping is the whole trick.
 */
export function gridSpacing(zoom: number): number {
  const log2 = Math.log2(zoom)
  if (log2 < -3.3) return 160
  if (log2 < -2.16) return 80
  if (log2 < -0.91) return 40
  return 20
}

/**
 * The chrome multiplier for things that must not shrink with the board — resize
 * handles, ports, edge labels. `sqrt(1 / zoom)` rather than `1 / zoom`, so
 * chrome shrinks *some* of the way with the content instead of staying pinned
 * at a fixed screen size.
 */
export function zoomMultiplier(zoom: number): number {
  return Math.sqrt(1 / zoom)
}

export function worldToScreen(v: Viewport, wx: number, wy: number): Point {
  return { x: wx * v.zoom + v.x, y: wy * v.zoom + v.y }
}

export function screenToWorld(v: Viewport, sx: number, sy: number): Point {
  return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom }
}

/** Pan by a screen-space delta. */
export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { ...v, x: v.x + dx, y: v.y + dy }
}

/** Zoom by `factor` keeping the world point under the screen pivot fixed. */
export function zoomAt(v: Viewport, pivotX: number, pivotY: number, factor: number): Viewport {
  const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const world = screenToWorld(v, pivotX, pivotY)
  return { zoom, x: pivotX - world.x * zoom, y: pivotY - world.y * zoom }
}

/**
 * Zoom by `steps` **log2 octaves** about a screen pivot — `+1` doubles, `-1`
 * halves, and the same input always travels the same visual distance whether you
 * are at 0.1× or at 2×. That evenness is what a multiply-by-1.2 stepper cannot
 * give you near the ends of the range.
 */
export function zoomBy(v: Viewport, pivotX: number, pivotY: number, steps: number): Viewport {
  return zoomAt(v, pivotX, pivotY, 2 ** steps)
}

export function nodeRect(node: { x: number; y: number; width: number; height: number }): Rect {
  return { x: node.x, y: node.y, width: node.width, height: node.height }
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** True when `inner` is entirely inside `outer`. */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/** A normalized rect from two corner points (any order). */
export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/**
 * World-space midpoint of a rect's side.
 *
 * Total on purpose: an exhaustive switch returns `undefined` for a side outside
 * the enum, and the caller then reads `.x` off it and takes the whole canvas
 * down. A `.canvas` written by another tool is untrusted input, so this falls
 * back to `right` instead of trusting the type.
 */
export function sideAnchor(r: Rect, side: EdgeSide): Point {
  switch (side) {
    case 'top':
      return { x: r.x + r.width / 2, y: r.y }
    case 'bottom':
      return { x: r.x + r.width / 2, y: r.y + r.height }
    case 'left':
      return { x: r.x, y: r.y + r.height / 2 }
    case 'right':
    default:
      return { x: r.x + r.width, y: r.y + r.height / 2 }
  }
}

/** Outward unit normal of a side (the direction an edge leaves the node). */
export function sideNormal(side: EdgeSide): Point {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
    default:
      return { x: 1, y: 0 }
  }
}

/** Pick the side of `from` whose center best points toward `to`. */
export function chooseSide(from: Rect, to: Rect): EdgeSide {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/** Cubic-bezier path string between two anchors, bowing out along side normals. */
export function bezierPath(from: Point, fromSide: EdgeSide, to: Point, toSide: EdgeSide): string {
  const [c1, c2] = bezierControls(from, fromSide, to, toSide)
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`
}

/** The two cubic control points {@link bezierPath} bows through. */
function bezierControls(from: Point, fromSide: EdgeSide, to: Point, toSide: EdgeSide): [Point, Point] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  const d = clamp(dist / 2, 30, 400)
  const n1 = sideNormal(fromSide)
  const n2 = sideNormal(toSide)
  return [
    { x: from.x + n1.x * d, y: from.y + n1.y * d },
    { x: to.x + n2.x * d, y: to.y + n2.y * d }
  ]
}

/**
 * The point at t=0.5 on the same curve {@link bezierPath} draws — where an edge
 * label belongs. The straight-line midpoint drifts off a bowed connector, so the
 * label is anchored to the curve instead.
 *
 * Closed form for a cubic at t=0.5: `(P0 + 3·P1 + 3·P2 + P3) / 8`.
 */
export function bezierMidpoint(from: Point, fromSide: EdgeSide, to: Point, toSide: EdgeSide): Point {
  const [c1, c2] = bezierControls(from, fromSide, to, toSide)
  return {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8
  }
}

/**
 * Three points of the arrowhead triangle at `tip`, opening away from the node
 * along the side's outward normal (so the tip sits on the node border).
 */
export function arrowPoints(tip: Point, side: EdgeSide, size: number): string {
  const n = sideNormal(side)
  // Base center is `size` back from the tip, along the inward direction.
  const baseX = tip.x + n.x * size
  const baseY = tip.y + n.y * size
  // Perpendicular spread.
  const px = -n.y
  const py = n.x
  const half = size * 0.6
  const a = { x: baseX + px * half, y: baseY + py * half }
  const b = { x: baseX - px * half, y: baseY - py * half }
  return `${tip.x},${tip.y} ${a.x},${a.y} ${b.x},${b.y}`
}

/** Log2 zoom at or below which the board is "zoomed out": labels hide, cards show placeholders. */
export const ZOOMED_OUT_LOG2 = -1.7
/** Length and half-width of the arrowhead, in screen pixels at 100% (scaled by the zoom multiplier). */
export const ARROW_LENGTH = 10.4
export const ARROW_HALF_WIDTH = 6.5

/**
 * A connector as drawn on the board: a straight lead of `lead` world units out
 * of each card, then a cubic between the two lead ends. The lead keeps an
 * arrowhead aligned with its side however the curve bends.
 */
export function edgePath(from: Point, fromSide: EdgeSide, to: Point, toSide: EdgeSide, lead: number): { path: string; mid: Point; start: Point; end: Point } {
  const n1 = sideNormal(fromSide)
  const n2 = sideNormal(toSide)
  const start = { x: from.x + n1.x * lead, y: from.y + n1.y * lead }
  const end = { x: to.x + n2.x * lead, y: to.y + n2.y * lead }
  const [c1, c2] = bezierControls(start, fromSide, end, toSide)
  return {
    path: `M ${from.x} ${from.y} L ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y} L ${to.x} ${to.y}`,
    mid: bezierMidpoint(start, fromSide, end, toSide),
    start,
    end
  }
}

/** The arrowhead triangle with its tip on `tip`, opening outward along `side`, scaled by `zm`. */
export function arrowHead(tip: Point, side: EdgeSide, zm: number): string {
  const n = sideNormal(side)
  const baseX = tip.x + n.x * ARROW_LENGTH * zm
  const baseY = tip.y + n.y * ARROW_LENGTH * zm
  const half = ARROW_HALF_WIDTH * zm
  return `${tip.x},${tip.y} ${baseX - n.y * half},${baseY + n.x * half} ${baseX + n.y * half},${baseY - n.x * half}`
}

/** Bounding rect of every node, or null when there are none. */
export function boundsOf(nodes: readonly CanvasNode[]): Rect | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** A viewport that fits `bounds` into a `width`×`height` screen with padding. */
export function fitView(bounds: Rect, width: number, height: number, padding = 60): Viewport {
  if (bounds.width <= 0 || bounds.height <= 0) {
    const zoom = 1
    return { zoom, x: width / 2 - (bounds.x + bounds.width / 2) * zoom, y: height / 2 - (bounds.y + bounds.height / 2) * zoom }
  }
  const zoom = clamp(
    Math.min((width - padding * 2) / bounds.width, (height - padding * 2) / bounds.height),
    MIN_ZOOM,
    1
  )
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  return { zoom, x: width / 2 - cx * zoom, y: height / 2 - cy * zoom }
}

export function snap(value: number, grid: number): number {
  return grid > 0 ? Math.round(value / grid) * grid : value
}

/** A world-space alignment guide segment drawn while object-snapping a drag. */
export interface SnapGuide {
  orientation: 'v' | 'h'
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Result of {@link snapToObjects}: a position nudge plus the guides to draw. */
export interface ObjectSnap {
  dx: number
  dy: number
  guides: SnapGuide[]
}

/**
 * "Snap to objects": nudge a dragged rect so one of its
 * left/center/right (and top/center/bottom) edges aligns with the matching edge
 * of a nearby other rect, within `threshold` world units. Returns the smallest
 * such nudge per axis (0 when nothing is close) and a guide segment spanning the
 * dragged + matched rect for each snapped axis. Pure — unit-tested.
 */
export function snapToObjects(dragged: Rect, others: readonly Rect[], threshold: number): ObjectSnap {
  const xAnchors = [dragged.x, dragged.x + dragged.width / 2, dragged.x + dragged.width]
  const yAnchors = [dragged.y, dragged.y + dragged.height / 2, dragged.y + dragged.height]
  let bestX: { delta: number; line: number; other: Rect } | null = null
  let bestY: { delta: number; line: number; other: Rect } | null = null
  for (const o of others) {
    const xLines = [o.x, o.x + o.width / 2, o.x + o.width]
    const yLines = [o.y, o.y + o.height / 2, o.y + o.height]
    for (const a of xAnchors)
      for (const line of xLines) {
        const delta = line - a
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, line, other: o }
      }
    for (const a of yAnchors)
      for (const line of yLines) {
        const delta = line - a
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, line, other: o }
      }
  }
  const dx = bestX ? bestX.delta : 0
  const dy = bestY ? bestY.delta : 0
  const snapped = { x: dragged.x + dx, y: dragged.y + dy, width: dragged.width, height: dragged.height }
  const guides: SnapGuide[] = []
  if (bestX) {
    const o = bestX.other
    guides.push({
      orientation: 'v',
      x1: bestX.line,
      y1: Math.min(snapped.y, o.y),
      x2: bestX.line,
      y2: Math.max(snapped.y + snapped.height, o.y + o.height)
    })
  }
  if (bestY) {
    const o = bestY.other
    guides.push({
      orientation: 'h',
      x1: Math.min(snapped.x, o.x),
      y1: bestY.line,
      x2: Math.max(snapped.x + snapped.width, o.x + o.width),
      y2: bestY.line
    })
  }
  return { dx, dy, guides }
}

/** All 8 resize-handle directions (corners + edge midpoints). */
export const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type ResizeHandle = (typeof RESIZE_HANDLES)[number]

/** Apply a resize-handle drag (`dx`/`dy` in world units) to a starting rect. */
export function resizeRect(start: Rect, handle: ResizeHandle, dx: number, dy: number, min: number, keepAspectRatio = false): Rect {
  let { x, y, width, height } = start
  if (handle.includes('e')) width = start.width + dx
  if (handle.includes('s')) height = start.height + dy
  if (handle.includes('w')) {
    width = start.width - dx
    x = start.x + dx
  }
  if (handle.includes('n')) {
    height = start.height - dy
    y = start.y + dy
  }
  if (keepAspectRatio && start.width > 0 && start.height > 0) {
    const horizontal = handle.includes('e') || handle.includes('w')
    const vertical = handle.includes('n') || handle.includes('s')
    const sx = width / start.width
    const sy = height / start.height
    const scale = Math.max(min / start.width, min / start.height,
      horizontal && vertical ? Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy : horizontal ? sx : sy)
    width = start.width * scale
    height = start.height * scale
    x = handle.includes('w') ? start.x + start.width - width : !horizontal ? start.x + (start.width - width) / 2 : start.x
    y = handle.includes('n') ? start.y + start.height - height : !vertical ? start.y + (start.height - height) / 2 : start.y
  }
  // Clamp to a minimum, holding the opposite edge fixed.
  if (width < min) {
    if (handle.includes('w')) x = start.x + (start.width - min)
    width = min
  }
  if (height < min) {
    if (handle.includes('n')) y = start.y + (start.height - min)
    height = min
  }
  return { x, y, width, height }
}
