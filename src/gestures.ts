import type { MutableRefObject, RefObject } from 'react'
import { React, api } from './runtime'
import { addEdge, addNode, createTextNode, duplicateNodes, genId, nodeById, removeEdges, setNodePositions, setNodeRect, validSide, type CanvasData, type CanvasEdge, type CanvasNode, type EdgeSide } from './canvasModel'
import { chooseSide, gridSpacing, nodeRect, rectFromPoints, rectsIntersect, resizeRect, screenToWorld, sideAnchor, snap as snapValue, snapToObjects, type Point, type Rect, type ResizeHandle, type SnapGuide, type Viewport } from './geometry'
import type { ConnectPreview } from './edges'
import type { CreateKind } from './menus'
import type { useCanvasViewport } from './viewport'
import type { useCanvasSelection } from './selection'
import { uiText } from './localization'

const MIN_NODE = 50
const MOVE_THRESHOLD = 3
const SNAP_PX = 15
const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
/** Dragging with this key held clones the cards (⌥ on macOS, Ctrl elsewhere). */
const cloneKey = (e: { altKey: boolean; ctrlKey: boolean }): boolean => isMac ? e.altKey : e.ctrlKey
/** Holding this key suspends snapping (⌃ on macOS, Alt elsewhere). */
const noSnapKey = (e: { altKey: boolean; ctrlKey: boolean }): boolean => isMac ? e.ctrlKey : e.altKey
const modKey = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => isMac ? e.metaKey : e.ctrlKey

/**
 * Pointer capture is a best-effort convenience — it keeps a drag alive when the
 * cursor leaves the element — never a correctness requirement, and jsdom does
 * not implement it at all. A bare call therefore threw and aborted the handler
 * mid-gesture, taking the selection update with it.
 */
function capturePointer(el: HTMLElement | null, pointerId: number): void {
  try {
    el?.setPointerCapture?.(pointerId)
  } catch {
    /* no active pointer (or no implementation) — the gesture works without it */
  }
}

/** Default size of a card dropped out of the create menu, per kind. */
export const GHOST_SIZE: Record<CreateKind, { width: number; height: number }> = {
  text: { width: 250, height: 60 },
  note: { width: 400, height: 400 },
  media: { width: 400, height: 400 },
  link: { width: 400, height: 400 },
  group: { width: 400, height: 400 }
}

type Interaction =
  | { type: 'pan'; startScreen: Point; origin: Viewport }
  | { type: 'marquee'; startScreen: Point; additive: boolean }
  | { type: 'drag'; before?: CanvasData; ids: Set<string>; primary: string; startWorld: Point; startScreen: Point; startPositions: Map<string, Point>; moved: boolean; engaged: boolean }
  | { type: 'resize'; id: string; handle: ResizeHandle; startRect: { x: number; y: number; width: number; height: number }; startWorld: Point; moved: boolean }
  | { type: 'connect'; fromNode: string; fromSide: EdgeSide; fromAnchor: Point; edgeId?: string; end?: 'from' | 'to' }
  /** Dragging a card out of the create menu. `engaged` gates pointer capture. */
  | { type: 'create'; kind: CreateKind; startScreen: Point; engaged: boolean }
  /** Mod-drag on the board: draw the size of a card, then pick its kind. */
  | { type: 'create-rect'; startScreen: Point }
  /** Press on a connection: a click selects it, a drag moves its nearer end. */
  | { type: 'edge'; edge: CanvasEdge; startScreen: Point }

interface GestureOptions {
  rootRef: RefObject<HTMLDivElement>
  modelRef: MutableRefObject<CanvasData>
  readOnlyRef: MutableRefObject<boolean>
  viewport: ReturnType<typeof useCanvasViewport>
  selection: ReturnType<typeof useCanvasSelection>
  setModelBoth(next: CanvasData): void
  apply(next: CanvasData, label: string): void
  pushUndo(label: string, previous: CanvasData, next: CanvasData): void
  scheduleSave(next: CanvasData): void
  addOfKind(kind: CreateKind, at?: Point): void
  /** A Mod-drag finished: offer the card kinds for `rect` (world) at the pointer. */
  onCreateRect(rect: Rect, client: Point): void
}

export function useCanvasGestures({ rootRef, modelRef, readOnlyRef, viewport, selection, setModelBoth, apply, pushUndo, scheduleSave, addOfKind, onCreateRect }: GestureOptions) {
  const { viewportRef, spaceRef, localPoint, worldAt, setViewport } = viewport
  const { selectionRef, editingRef, replaceSelection, expandWithGroups, setSelectedEdge, setEditingId, setEditingEdgeLabel } = selection
  const [marquee, setMarquee] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [preview, setPreview] = React.useState<ConnectPreview | null>(null)
  const [ghost, setGhost] = React.useState<{ kind: CreateKind; x: number; y: number } | null>(null)
  const [panning, setPanning] = React.useState(false)
  const [snapGuides, setSnapGuides] = React.useState<SnapGuide[]>([])
  const [draggingIds, setDraggingIds] = React.useState<Set<string>>(new Set())
  const interactionRef = React.useRef<Interaction | null>(null)
  const gestureStartRef = React.useRef<CanvasData>(modelRef.current)

  // ── Gesture: background pointer down ─────────────────────────────────────────
  const onRootPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return
    setEditingId(null)
    setEditingEdgeLabel(null)
    rootRef.current?.focus()
    capturePointer(rootRef.current, e.pointerId)
    const screen = localPoint(e.clientX, e.clientY)
    if (spaceRef.current || e.button === 1) {
      interactionRef.current = { type: 'pan', startScreen: screen, origin: viewportRef.current }
      setPanning(true)
      return
    }
    setSelectedEdge(null)
    if (!e.shiftKey) replaceSelection(new Set())
    interactionRef.current = modKey(e) && !readOnlyRef.current ? { type: 'create-rect', startScreen: screen } : { type: 'marquee', startScreen: screen, additive: e.shiftKey }
  }

  /** Press on the box around a multi-card selection: drag the whole selection. */
  const onSelectionPointerDown = (e: React.PointerEvent): void => {
    const first = [...selectionRef.current].map((id) => nodeById(modelRef.current, id)).find(Boolean)
    if (!first) return
    if (e.shiftKey) { onRootPointerDown(e); return }
    onNodePointerDown(e, first)
  }

  const onEdgePointerDown = (e: React.PointerEvent, edge: CanvasEdge): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    rootRef.current?.focus()
    setEditingEdgeLabel(null)
    if (!e.shiftKey) replaceSelection(new Set())
    setSelectedEdge(edge.id)
    if (!readOnlyRef.current) interactionRef.current = { type: 'edge', edge, startScreen: localPoint(e.clientX, e.clientY) }
  }

  // ── Gesture: node pointer down (select + start drag) ─────────────────────────
  const onNodePointerDown = (e: React.PointerEvent, node: CanvasNode): void => {
    if (spaceRef.current || e.button === 1) {
      e.preventDefault(); e.stopPropagation(); capturePointer(rootRef.current, e.pointerId)
      interactionRef.current = { type: 'pan', startScreen: localPoint(e.clientX, e.clientY), origin: viewportRef.current }
      setPanning(true)
      return
    }
    if (e.button !== 0) return
    if (editingRef.current === node.id) return
    e.stopPropagation()
    // Pressing another card ends the edit in progress (its editor commits on unmount).
    if (editingRef.current) setEditingId(null)
    setSelectedEdge(null)
    setEditingEdgeLabel(null)
    rootRef.current?.focus()

    let ids = new Set(selectionRef.current)
    if (e.shiftKey) {
      if (ids.has(node.id)) ids.delete(node.id)
      else ids.add(node.id)
    } else if (!ids.has(node.id)) {
      ids = new Set([node.id])
    }
    replaceSelection(ids)
    // Read-only: selection is allowed, but never start a move.
    if (readOnlyRef.current) return

    const beforeDuplicate = cloneKey(e) ? modelRef.current : undefined
    if (beforeDuplicate) {
      const duplicated = duplicateNodes(modelRef.current, expandWithGroups(ids), 0)
      setModelBoth(duplicated.data)
      ids = duplicated.ids
      replaceSelection(ids)
    }
    const moving = expandWithGroups(ids)
    const startPositions = new Map<string, Point>()
    for (const n of modelRef.current.nodes) if (moving.has(n.id)) startPositions.set(n.id, { x: n.x, y: n.y })
    gestureStartRef.current = modelRef.current
    interactionRef.current = {
      type: 'drag',
      before: beforeDuplicate,
      ids: moving,
      primary: ids.has(node.id) ? node.id : [...ids][0],
      startWorld: worldAt(e),
      startScreen: localPoint(e.clientX, e.clientY),
      startPositions,
      moved: !!beforeDuplicate,
      engaged: false
    }
  }

  const onResizeStart = (e: React.PointerEvent, node: CanvasNode, handle: ResizeHandle): void => {
    e.stopPropagation()
    if (readOnlyRef.current || e.button !== 0) return
    e.preventDefault()
    capturePointer(rootRef.current, e.pointerId)
    replaceSelection(new Set([node.id]))
    setSelectedEdge(null)
    gestureStartRef.current = modelRef.current
    interactionRef.current = {
      type: 'resize',
      id: node.id,
      handle,
      startRect: nodeRect(node),
      startWorld: worldAt(e),
      moved: false
    }
  }

  const onConnectStart = (e: React.PointerEvent, node: CanvasNode, side: EdgeSide): void => {
    e.stopPropagation()
    if (readOnlyRef.current || e.button !== 0) return
    e.preventDefault()
    capturePointer(rootRef.current, e.pointerId)
    const anchor = sideAnchor(nodeRect(node), side)
    interactionRef.current = { type: 'connect', fromNode: node.id, fromSide: side, fromAnchor: anchor }
    setPreview({ from: anchor, fromSide: side, to: anchor })
  }

  const onReconnect = (e: React.PointerEvent, edge: CanvasEdge, end: 'from' | 'to'): void => {
    e.stopPropagation()
    if (readOnlyRef.current || (e.type === 'pointerdown' && e.button !== 0)) return
    e.preventDefault()
    const fixed = nodeById(modelRef.current, end === 'from' ? edge.toNode : edge.fromNode)
    const moving = nodeById(modelRef.current, end === 'from' ? edge.fromNode : edge.toNode)
    if (!fixed || !moving) return
    const side = validSide(end === 'from' ? edge.toSide : edge.fromSide) ?? chooseSide(nodeRect(fixed), nodeRect(moving))
    const anchor = sideAnchor(nodeRect(fixed), side)
    capturePointer(rootRef.current, e.pointerId)
    interactionRef.current = { type: 'connect', fromNode: fixed.id, fromSide: side, fromAnchor: anchor, edgeId: edge.id, end }
    setPreview({ from: anchor, fromSide: side, to: worldAt(e) })
  }

  /**
   * Press on a create-menu button. Capture is deliberately NOT taken here: it
   * retargets the compatibility mouse events too, so capturing on press would
   * swallow the button's own `click` and kill the click-to-create fallback
   * (AGENTS.md — the same bug the To-Do swipe row hit). It engages on move.
   */
  const onCreateStart = (e: React.PointerEvent, kind: CreateKind): void => {
    if (e.button !== 0 || readOnlyRef.current) return
    interactionRef.current = { type: 'create', kind, startScreen: localPoint(e.clientX, e.clientY), engaged: false }
  }

  // ── Gesture move ─────────────────────────────────────────────────────────────
  // Snap to the grid you can actually see: the spacing steps with zoom, so a
  // card dropped while zoomed out lands on the coarse dots under the cursor
  // rather than on a fine grid nothing is drawing — which is why the spacing
  // is not a setting: a number the user picks cannot track the zoom.
  const snapping = React.useRef(true)
  const gridSnap = (v: number): number => (
    api.settings.get().snapToGrid && snapping.current && !spaceRef.current ? snapValue(v, gridSpacing(viewportRef.current.zoom)) : v
  )

  const onRootPointerMove = (e: React.PointerEvent): void => {
    const it = interactionRef.current
    if (!it) return
    if (it.type === 'drag' && !it.engaged && (e.buttons & 1) === 0) {
      cancelInteraction()
      return
    }
    const screen = localPoint(e.clientX, e.clientY)
    snapping.current = !noSnapKey(e)
    if (it.type === 'edge') {
      if (Math.hypot(screen.x - it.startScreen.x, screen.y - it.startScreen.y) <= MOVE_THRESHOLD) return
      const from = nodeById(modelRef.current, it.edge.fromNode)
      const to = nodeById(modelRef.current, it.edge.toNode)
      if (!from || !to) { interactionRef.current = null; return }
      const start = screenToWorld(viewportRef.current, it.startScreen.x, it.startScreen.y)
      const fromAnchor = sideAnchor(nodeRect(from), validSide(it.edge.fromSide) ?? chooseSide(nodeRect(from), nodeRect(to)))
      const toAnchor = sideAnchor(nodeRect(to), validSide(it.edge.toSide) ?? chooseSide(nodeRect(to), nodeRect(from)))
      const end = Math.hypot(start.x - fromAnchor.x, start.y - fromAnchor.y) < Math.hypot(start.x - toAnchor.x, start.y - toAnchor.y) ? 'from' : 'to'
      onReconnect(e, it.edge, end)
      return
    }
    if (it.type === 'create-rect') {
      setMarquee(rectFromPoints(it.startScreen, screen))
      return
    }
    if (it.type === 'create') {
      if (!it.engaged) {
        if (Math.hypot(screen.x - it.startScreen.x, screen.y - it.startScreen.y) <= MOVE_THRESHOLD) return
        it.engaged = true
        capturePointer(rootRef.current, e.pointerId)
      }
      const size = GHOST_SIZE[it.kind]
      setGhost({ kind: it.kind, x: screen.x - (size.width * viewportRef.current.zoom) / 2, y: screen.y - (size.height * viewportRef.current.zoom) / 2 })
      return
    }
    if (it.type === 'pan') {
      setViewport({ ...it.origin, x: it.origin.x + (screen.x - it.startScreen.x), y: it.origin.y + (screen.y - it.startScreen.y) })
      return
    }
    if (it.type === 'marquee') {
      setMarquee(rectFromPoints(it.startScreen, screen))
      return
    }
    const world = screenToWorld(viewportRef.current, screen.x, screen.y)
    if (it.type === 'connect') {
      setPreview({ from: it.fromAnchor, fromSide: it.fromSide, to: world })
      return
    }
    if (it.type === 'drag') {
      if (!it.engaged && Math.hypot(screen.x - it.startScreen.x, screen.y - it.startScreen.y) > MOVE_THRESHOLD) {
        it.engaged = true
        it.moved = true
        capturePointer(rootRef.current, e.pointerId)
        setDraggingIds(new Set(it.ids))
      }
      if (!it.moved) return
      let dx = world.x - it.startWorld.x
      let dy = world.y - it.startWorld.y
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0 }
      // Snap-to-objects: nudge the whole drag so the primary card aligns with a
      // nearby card (takes precedence over grid snap on a snapped axis).
      let sdx = 0
      let sdy = 0
      let guides: SnapGuide[] = []
      if (!spaceRef.current && snapping.current && api.settings.get().snapToObjects !== false) {
        const start = it.startPositions.get(it.primary)
        const prim = nodeById(gestureStartRef.current, it.primary)
        if (start && prim) {
          const dragged = { x: start.x + dx, y: start.y + dy, width: prim.width, height: prim.height }
          const others = gestureStartRef.current.nodes.filter((n) => !it.ids.has(n.id)).map(nodeRect)
          const res = snapToObjects(dragged, others, SNAP_PX / viewportRef.current.zoom)
          sdx = res.dx
          sdy = res.dy
          guides = res.guides
        }
      }
      const positions = new Map<string, Point>()
      for (const [id, p] of it.startPositions) {
        positions.set(id, {
          x: sdx !== 0 ? p.x + dx + sdx : gridSnap(p.x + dx),
          y: sdy !== 0 ? p.y + dy + sdy : gridSnap(p.y + dy)
        })
      }
      setSnapGuides(guides)
      setModelBoth(setNodePositions(gestureStartRef.current, positions))
      return
    }
    if (it.type === 'resize') {
      it.moved = true
      const dx = gridSnap(world.x - it.startWorld.x)
      const dy = gridSnap(world.y - it.startWorld.y)
      const rect = resizeRect(it.startRect, it.handle, dx, dy, MIN_NODE, e.shiftKey)
      setModelBoth(setNodeRect(gestureStartRef.current, it.id, rect))
    }
  }

  // ── Gesture up ───────────────────────────────────────────────────────────────
  const onRootPointerUp = (e: React.PointerEvent): void => {
    const it = interactionRef.current
    interactionRef.current = null
    if (snapGuides.length) setSnapGuides([])
    if (draggingIds.size) setDraggingIds(new Set())
    setPanning(false)
    if (!it) return
    if (it.type === 'edge') return
    if (it.type === 'create-rect') {
      const screen = localPoint(e.clientX, e.clientY)
      setMarquee(null)
      const a = screenToWorld(viewportRef.current, it.startScreen.x, it.startScreen.y)
      const b = screenToWorld(viewportRef.current, screen.x, screen.y)
      const box = rectFromPoints(a, b)
      if (box.width >= MIN_NODE && box.height >= MIN_NODE) onCreateRect(box, { x: e.clientX, y: e.clientY })
      return
    }
    if (it.type === 'create') {
      setGhost(null)
      // Not engaged = a plain click; the button's own onClick creates it centered.
      if (it.engaged) addOfKind(it.kind, worldAt(e))
      return
    }
    if (it.type === 'marquee') {
      const screen = localPoint(e.clientX, e.clientY)
      const a = screenToWorld(viewportRef.current, it.startScreen.x, it.startScreen.y)
      const b = screenToWorld(viewportRef.current, screen.x, screen.y)
      const box = rectFromPoints(a, b)
      setMarquee(null)
      if (box.width < 2 && box.height < 2) return
      const hits = modelRef.current.nodes.filter((n) => rectsIntersect(nodeRect(n), box)).map((n) => n.id)
      replaceSelection(it.additive ? new Set([...selectionRef.current, ...hits]) : new Set(hits))
      return
    }
    if (it.type === 'connect') {
      setPreview(null)
      const target = e.currentTarget.ownerDocument
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest('[data-node-id]')
        ?.getAttribute('data-node-id')
      if (target && target !== it.fromNode) {
        const from = nodeById(modelRef.current, it.fromNode)
        const to = nodeById(modelRef.current, target)
        if (from && to) {
          const edge = {
            id: genId(),
            fromNode: it.fromNode,
            fromSide: it.fromSide,
            toNode: target,
            toSide: chooseSide(nodeRect(to), nodeRect(from))
          }
          if (it.edgeId) {
            const data = modelRef.current
            const hit = e.currentTarget.ownerDocument.elementFromPoint(e.clientX, e.clientY)?.closest('[data-side]')?.getAttribute('data-side')
            const side = (['top', 'right', 'bottom', 'left'].includes(hit ?? '') ? hit : edge.toSide) as EdgeSide
            apply({ ...data, edges: data.edges.map((existing) => existing.id !== it.edgeId ? existing : {
              ...existing,
              ...(it.end === 'from' ? { fromNode: target, fromSide: side } : { toNode: target, toSide: side })
            }) }, 'Reconnect cards')
          } else apply(addEdge(modelRef.current, edge), 'Connect cards')
        }
      } else if (!target && it.edgeId) {
        apply(removeEdges(modelRef.current, new Set([it.edgeId])), 'Detach connection')
        setSelectedEdge(null)
      } else if (!target) {
        const point = worldAt(e)
        const card = createTextNode(point.x - 125, point.y - 30)
        const from = nodeById(modelRef.current, it.fromNode)
        if (from) {
          const next = addNode(modelRef.current, card)
          apply(addEdge(next, { id: genId(), fromNode: it.fromNode, fromSide: it.fromSide, toNode: card.id, toSide: chooseSide(nodeRect(card), nodeRect(from)) }), 'Create connected card')
          replaceSelection(new Set([card.id])); setEditingId(card.id)
        }
      }
      return
    }
    if ((it.type === 'drag' || it.type === 'resize') && it.moved) {
      const label = it.type === 'resize' ? uiText('auto.fd41e3156204') : uiText('auto.7a727a73ce56')
      pushUndo(it.type === 'drag' && it.before ? 'Duplicate cards' : label, it.type === 'drag' && it.before ? it.before : gestureStartRef.current, modelRef.current)
      scheduleSave(modelRef.current)
    }
  }

  const cancelInteraction = (): void => {
    const interaction = interactionRef.current
    if (interaction?.type === 'drag' || interaction?.type === 'resize') setModelBoth(interaction.type === 'drag' && interaction.before ? interaction.before : gestureStartRef.current)
    interactionRef.current = null
    setPreview(null); setMarquee(null); setDraggingIds(new Set()); setSnapGuides([]); setGhost(null); setPanning(false)
  }

  return { marquee, preview, ghost, snapGuides, draggingIds, panning, onRootPointerDown, onRootPointerMove, onRootPointerUp, onNodePointerDown, onResizeStart, onConnectStart, onReconnect, onCreateStart, onEdgePointerDown, onSelectionPointerDown, cancelInteraction }
}
