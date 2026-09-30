import { registerCanvasSession, pendingCanvasView, notifyCanvas, type CanvasSession } from './session'
import { canvasDocument } from './document'
import { restoreCanvasTarget } from './commands'
import { React, captureCanvasOwner, type CanvasOwner } from './runtime'
import { classifyFilePath } from '@valley/plugin-sdk/fileTypes'
import { useCanvasViewport } from './viewport'
import { useCanvasSelection } from './selection'
import { GHOST_SIZE, useCanvasGestures } from './gestures'
import { CardMenu, Controls, FileSuggest, OCCLUDER, SelectionMenu, lineDirection, type CreateKind } from './menus'
import { CanvasMinimap } from './CanvasMinimap'
import {
  type CanvasColor,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type FileNode,
  type GroupNode,
  type TextNode,
  DEFAULT_FILE_HEIGHT,
  DEFAULT_FILE_WIDTH,
  DEFAULT_LINK_HEIGHT,
  DEFAULT_LINK_WIDTH,
  DEFAULT_TEXT_HEIGHT,
  DEFAULT_TEXT_WIDTH,
  addNode,
  createFileNode,
  createGroupNode,
  createLinkNode,
  createTextNode,
  duplicateNodes,
  edgeById,
  genId,
  nodeById,
  parseCanvas,
  removeEdges,
  removeNodes,
  reorderNodes,
  serializeCanvas,
  setEdgeColor,
  setEdgeEnds,
  setEdgeLabel,
  setNodesColor,
  updateNode
} from './canvasModel'
import {
  type Point,
  type Rect,
  ZOOMED_OUT_LOG2,
  boundsOf,
  fitView,
  gridSpacing,
  screenToWorld,
  worldToScreen,
  zoomAt,
  zoomBy,
  zoomMultiplier
} from './geometry'
import { NodeView } from './CanvasNode'
import { EdgeLayer, edgeGeometry } from './edges'
import { uiText } from './localization'
import {
  AlignCenterHorizontalIcon, AlignCenterVerticalIcon, AlignEndHorizontalIcon, AlignEndVerticalIcon, AlignStartHorizontalIcon, AlignStartVerticalIcon,
  ArrowRightIcon, AspectRatioIcon, BringToFrontIcon, ClipboardIcon, DistributeHorizontalIcon, DistributeVerticalIcon, DuplicateIcon, EditIcon,
  FileImageIcon, FileInputIcon, FileTextIcon, GlobeIcon, GroupIcon, ImageOffIcon, LayoutGridIcon, LineHorizontalIcon, MoveHorizontalIcon,
  OpenIcon, RedoIcon, RepeatIcon, ScalingIcon, SendToBackIcon, StackHorizontalIcon, StackVerticalIcon, StickyNoteIcon, StretchHorizontalIcon,
  StretchVerticalIcon, TableIcon, TrashIcon, UndoIcon, ZoomToSelectionIcon
} from './icons'

/** One press of the zoom buttons, in log2 octaves. */
const ZOOM_BUTTON_STEP = 0.5
/** Room kept between a selection and the menu above it, in screen pixels. */
const GROUP_PADDING = 20
const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
type MenuItems = Parameters<CanvasOwner['api']['ui']['openMenu']>[0]

interface ViewProps {
  relPath: string
  tab?: unknown
  /** Set when the host embeds the file in another document. */
  thisPath?: string
  viewName?: string
}

/**
 * The `.canvas` file view. A board opened in its own tab is the editor; a board
 * embedded in a note or on another board is its minimap.
 */
const CanvasView = (props: ViewProps): ReturnType<typeof React.createElement> => {
  const [owner] = React.useState(() => captureCanvasOwner())
  const embedded = !props.tab || Boolean(props.thisPath && props.thisPath !== props.relPath)
  if (embedded) return <CanvasMinimap owner={owner} relPath={props.relPath} />
  return <CanvasEditor relPath={props.relPath} owner={owner} />
}

type Modal =
  | { type: 'pick'; kind: 'note' | 'media'; onPick: (path: string) => void }

const CanvasEditor = ({ relPath, owner }: { relPath: string; owner: CanvasOwner }): ReturnType<typeof React.createElement> => {
  const api = owner.api
  const document = React.useMemo(() => canvasDocument(owner, relPath), [owner, relPath])
  const context = React.useMemo(() => ({ mounted: true }), [document])
  const latestContext = React.useRef(context)
  latestContext.current = context
  const isViewActive = React.useCallback(() => context.mounted && latestContext.current === context && owner.isActive(), [context, owner])
  const snapshot = React.useSyncExternalStore(document.subscribe, document.get, document.get)
  const { data: model, error: saveError } = snapshot
  const rootRef = React.useRef<HTMLDivElement>(null)
  const viewportState = useCanvasViewport(rootRef)
  const { viewport, setViewport, viewportRef, viewportSize, dimensions, worldAt } = viewportState
  const [readOnly, setReadOnly] = React.useState(false)
  const [modal, setModal] = React.useState<Modal | null>(null)
  const pointerRef = React.useRef<Point | null>(null)

  const modelRef = React.useRef(model)
  const selectionState = useCanvasSelection(modelRef)
  const { selection, setSelection, selectionRef, selectedEdge, setSelectedEdge, selectedEdgeRef, editingId, setEditingId, editingRef, editingEdgeLabel, setEditingEdgeLabel, replaceSelection } = selectionState
  const readOnlyRef = React.useRef(false)
  modelRef.current = model
  const locked = readOnly || snapshot.invalid
  readOnlyRef.current = locked || snapshot.busy || !snapshot.ready || !isViewActive()

  const nodesById = React.useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes])
  const zm = zoomMultiplier(viewport.zoom)
  const zoomedOut = Math.log2(viewport.zoom) <= ZOOMED_OUT_LOG2

  const setModelBoth = React.useCallback((next: CanvasData): void => {
    if (!isViewActive()) return
    document.setData(next)
    modelRef.current = document.get().data
  }, [document, isViewActive])
  const flushSave = (next: CanvasData): Promise<void> => isViewActive() ? document.flush(next) : Promise.resolve()
  const scheduleSave = (next: CanvasData): void => { if (isViewActive()) document.schedule(next) }
  const pushUndo = (label: string, prev: CanvasData, next: CanvasData): void => {
    if (!isViewActive() || document.get().busy) return
    const previous = structuredClone(prev)
    const following = structuredClone(next)
    api.undo.push({
      label,
      undo: async () => { await restoreCanvasTarget(owner, relPath, previous, serializeCanvas(following)); return { ok: true } },
      redo: async () => { await restoreCanvasTarget(owner, relPath, following, serializeCanvas(previous)); return { ok: true } }
    })
  }
  const apply = (next: CanvasData, label: string): void => {
    if (readOnlyRef.current || !isViewActive() || document.get().busy) return
    const prev = document.get().data
    setModelBoth(next)
    scheduleSave(next)
    pushUndo(label, prev, next)
  }
  React.useEffect(() => {
    context.mounted = true
    const detach = document.attach()
    return () => { context.mounted = false; detach() }
  }, [document, context])
  const fitted = React.useMemo(() => ({ done: false }), [document])
  React.useEffect(() => {
    if (!snapshot.ready || fitted.done || !context.mounted) return
    const rect = viewportSize()
    const bounds = boundsOf(snapshot.data.nodes)
    fitted.done = Boolean(rect && rect.width > 0 && rect.height > 0)
    if (bounds && rect && fitted.done) setViewport(fitView(bounds, rect.width, rect.height))
    const pending = pendingCanvasView(relPath, owner)
    if (pending?.viewport) { setViewport(pending.viewport); fitted.done = true }
    if (pending?.nodeIds) setSelection(new Set(pending.nodeIds))
    if (pending?.edgeId !== undefined) setSelectedEdge(pending.edgeId)
  }, [snapshot, fitted, context, viewportSize, dimensions, setViewport, setSelection, setSelectedEdge, relPath, owner])

  const bridgeRef = React.useMemo<{ current: CanvasSession | null }>(() => ({ current: null }), [document])
  bridgeRef.current = {
    get: () => ({ data: document.get().data, viewport: viewportRef.current, nodeIds: [...selectionRef.current], edgeId: selectedEdgeRef.current, readOnly: readOnlyRef.current, ready: document.get().ready && isViewActive(), invalid: document.get().invalid, revision: serializeCanvas(document.get().data), error: document.get().error }),
    commit: async (next, revision) => {
      owner.assertActive()
      if (!isViewActive() || readOnlyRef.current) throw new Error(uiText('canvas.error.readOnly'))
      await document.commit(next, revision)
    },
    restore: (view) => {
      owner.assertActive()
      if (!isViewActive()) return
      if (view.viewport) setViewport(view.viewport)
      if (view.nodeIds) setSelection(new Set(view.nodeIds))
      if (view.edgeId !== undefined) setSelectedEdge(view.edgeId)
    }
  }
  React.useEffect(() => registerCanvasSession(relPath, { get: () => bridgeRef.current!.get(), commit: (data, revision) => bridgeRef.current!.commit(data, revision), restore: (view) => bridgeRef.current!.restore(view) }, owner), [relPath, bridgeRef, owner])
  React.useEffect(() => notifyCanvas(owner), [owner, model, viewport, selection, selectedEdge, readOnly, saveError])

  const reloadDisk = async (): Promise<void> => {
    const restored = await document.reload(() => api.ui.confirm({ title: uiText('canvas.action.reload'), message: uiText('canvas.error.discard'), actions: [{ label: uiText('canvas.action.cancel'), value: 'cancel', variant: 'ghost' }, { label: uiText('canvas.action.reload'), value: 'reload', variant: 'danger' }] }), isViewActive)
    if (restored && isViewActive()) { setSelection(new Set()); setSelectedEdge(null) }
  }

  // ── Create ───────────────────────────────────────────────────────────────────
  const commitNode = (node: CanvasNode, patch: Partial<CanvasNode>): void => {
    setEditingId(null)
    const current = nodeById(modelRef.current, node.id)
    if (!current || Object.entries(patch).every(([key, value]) => (current as Record<string, unknown>)[key] === value)) return
    apply(updateNode(modelRef.current, node.id, patch), uiText('auto.2077c3c7a6d7'))
  }

  const viewportCenterWorld = (): Point => {
    const r = viewportSize()
    return screenToWorld(viewportRef.current, (r?.width ?? 600) / 2, (r?.height ?? 400) / 2)
  }

  const addAndSelect = (node: CanvasNode, label: string, edit = false): void => {
    apply(addNode(modelRef.current, node), label)
    replaceSelection(new Set([node.id]))
    setSelectedEdge(null)
    if (edit) setEditingId(node.id)
  }
  /** Cards are centred on `at` (a pointer or drop point), or on the viewport centre. */
  const addText = (at?: Point, text = '', size?: Rect): void => {
    const c = at ?? viewportCenterWorld()
    const node = size ? createTextNode(size.x, size.y, text, size.width, size.height) : createTextNode(c.x - DEFAULT_TEXT_WIDTH / 2, c.y - DEFAULT_TEXT_HEIGHT / 2, text)
    addAndSelect(node, uiText('auto.0d93b235dd84'), !text)
  }
  const addFile = (file: string, at?: Point, size?: Rect, subpath?: string): void => {
    const c = at ?? viewportCenterWorld()
    const node = size ? createFileNode(size.x, size.y, file, size.width, size.height, subpath) : createFileNode(c.x - DEFAULT_FILE_WIDTH / 2, c.y - DEFAULT_FILE_HEIGHT / 2, file, undefined, undefined, subpath)
    addAndSelect(node, uiText('auto.44cc5b642313'))
  }
  const addLink = (at?: Point, url = '', size?: Rect): void => {
    const c = at ?? viewportCenterWorld()
    const node = size ? createLinkNode(size.x, size.y, url, size.width, size.height) : createLinkNode(c.x - DEFAULT_LINK_WIDTH / 2, c.y - DEFAULT_LINK_HEIGHT / 2, url)
    addAndSelect(node, uiText('auto.d0194874754e'), !url)
  }
  const addGroup = (rect: Rect): void => {
    addAndSelect(createGroupNode(rect.x, rect.y, rect.width, rect.height), uiText('auto.2fca464f9c89'))
  }
  const pickFile = (kind: 'note' | 'media', onPick: (path: string) => void): void => {
    if (readOnlyRef.current) return
    setModal({ type: 'pick', kind, onPick: (path) => { setModal(null); if (isViewActive()) onPick(path) } })
  }
  const addOfKind = (kind: CreateKind, at?: Point, size?: Rect): void => {
    if (kind === 'text') addText(at, '', size)
    else if (kind === 'link') addLink(at, '', size)
    else if (kind === 'group') { const c = at ?? viewportCenterWorld(); addGroup(size ?? { x: c.x - 200, y: c.y - 200, width: 400, height: 400 }) }
    else pickFile(kind, (path) => addFile(path, at, size))
  }

  /** The kinds offered for a Mod-drawn rectangle, or a right-click on the board. */
  const creationItems = (at: Point, size?: Rect): MenuItems => [
    { id: 'card', label: uiText('auto.91edf1fe47ea'), icon: <StickyNoteIcon />, enabled: !locked, onSelect: () => addText(at, '', size) },
    { id: 'note', label: uiText('auto.f4ee7eb1d857'), icon: <FileTextIcon />, enabled: !locked, onSelect: () => pickFile('note', (path) => addFile(path, at, size)) },
    { id: 'media', label: uiText('auto.ddc84cc1637c'), icon: <FileImageIcon />, enabled: !locked, onSelect: () => pickFile('media', (path) => addFile(path, at, size)) },
    { id: 'web', label: uiText('auto.9b2b448d5f52'), icon: <GlobeIcon />, enabled: !locked, onSelect: () => addLink(at, '', size) },
    { id: 'group', label: uiText('auto.5a0b1c170fd5'), icon: <GroupIcon />, enabled: !locked, onSelect: () => addGroup(size ?? { x: at.x - 175, y: at.y - 125, width: 350, height: 250 }) }
  ]

  const onCreateRect = (rect: Rect, client: Point): void => {
    if (!isViewActive()) return
    void api.ui.openMenu(creationItems({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, rect), client)
  }

  const gestures = useCanvasGestures({ rootRef, modelRef, readOnlyRef, viewport: viewportState, selection: selectionState, setModelBoth, apply, pushUndo, scheduleSave, addOfKind, onCreateRect })
  const { marquee, preview, ghost, snapGuides, draggingIds, panning, onRootPointerDown, onRootPointerMove, onRootPointerUp, onNodePointerDown, onResizeStart, onConnectStart, onCreateStart, onEdgePointerDown, onSelectionPointerDown, cancelInteraction } = gestures

  // ── History and clipboard ────────────────────────────────────────────────────
  const doUndo = (): void => { if (isViewActive()) void api.commands.execute('undo') }
  const doRedo = (): void => { if (isViewActive()) void api.commands.execute('redo') }

  const selectionFragment = (): CanvasData | null => {
    const ids = selectionRef.current
    if (!ids.size) return null
    const nodes = modelRef.current.nodes.filter((node) => ids.has(node.id))
    const edges = modelRef.current.edges.filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode))
    return { nodes, edges }
  }
  const copySelection = async (cut: boolean): Promise<void> => {
    const fragment = selectionFragment()
    if (!fragment) return
    try {
      await navigator.clipboard.writeText(serializeCanvas(fragment))
    } catch {
      return
    }
    if (cut && !readOnlyRef.current) deleteSelection()
  }
  /** Paste cards copied from a board, a URL as a web page, or text as a card, at `at`. */
  const pasteAt = async (at: Point): Promise<void> => {
    if (readOnlyRef.current) return
    let text = ''
    try { text = (await navigator.clipboard.readText()).trim() } catch { return }
    if (!text || !isViewActive() || readOnlyRef.current) return
    const fragment = text.startsWith('{') ? parseCanvas(text) : null
    if (fragment?.nodes.length) {
      const bounds = boundsOf(fragment.nodes)!
      const ids = new Map(fragment.nodes.map((node) => [node.id, genId()]))
      const dx = at.x - (bounds.x + bounds.width / 2)
      const dy = at.y - (bounds.y + bounds.height / 2)
      const nodes = fragment.nodes.map((node) => ({ ...node, id: ids.get(node.id)!, x: node.x + dx, y: node.y + dy }) as CanvasNode)
      const edges = fragment.edges.filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode)).map((edge) => ({ ...edge, id: genId(), fromNode: ids.get(edge.fromNode)!, toNode: ids.get(edge.toNode)! }))
      const data = modelRef.current
      apply({ ...data, nodes: [...data.nodes, ...nodes], edges: [...data.edges, ...edges] }, uiText('auto.db2483000d15'))
      replaceSelection(new Set(nodes.map((node) => node.id)))
      return
    }
    if (/^https?:\/\/\S+$/i.test(text)) addLink(at, text)
    else addText(at, text)
  }
  const pastePoint = (): Point => {
    const pointer = pointerRef.current
    const size = viewportSize()
    return pointer && size && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= size.width && pointer.y <= size.height ? screenToWorld(viewportRef.current, pointer.x, pointer.y) : viewportCenterWorld()
  }

  // ── Selection actions ────────────────────────────────────────────────────────
  const deleteSelection = (): void => {
    if (selectedEdgeRef.current) {
      apply(removeEdges(modelRef.current, new Set([selectedEdgeRef.current])), uiText('auto.f6fdbe48dc54'))
      setSelectedEdge(null)
      return
    }
    if (selectionRef.current.size === 0) return
    apply(removeNodes(modelRef.current, selectionRef.current), uiText('auto.f6fdbe48dc54'))
    replaceSelection(new Set())
  }
  const duplicateSelection = (): void => {
    if (readOnlyRef.current || selectionRef.current.size === 0) return
    const result = duplicateNodes(modelRef.current, selectionRef.current)
    if (result.ids.size === 0) return
    apply(result.data, uiText('auto.972d57379db3'))
    replaceSelection(result.ids)
  }
  const restack = (to: 'front' | 'back'): void => {
    if (readOnlyRef.current || selectionRef.current.size === 0) return
    apply(reorderNodes(modelRef.current, selectionRef.current, to), to === 'front' ? uiText('auto.1f65ed95fba6') : uiText('auto.e259d4e19e69'))
  }
  const applyColor = (color: CanvasColor | undefined): void => {
    if (selectedEdgeRef.current) apply(setEdgeColor(modelRef.current, selectedEdgeRef.current, color), uiText('auto.1d0c8304baed'))
    else if (selectionRef.current.size) apply(setNodesColor(modelRef.current, selectionRef.current, color), uiText('auto.1d0c8304baed'))
  }
  const fitTo = (nodes: readonly CanvasNode[]): void => {
    const bounds = boundsOf(nodes)
    const rect = viewportSize()
    if (bounds && rect) setViewport(fitView(bounds, rect.width, rect.height))
  }
  const zoomToSelection = (): void => {
    const edge = selectedEdgeRef.current ? edgeById(modelRef.current, selectedEdgeRef.current) : undefined
    fitTo(edge ? modelRef.current.nodes.filter((node) => node.id === edge.fromNode || node.id === edge.toNode) : modelRef.current.nodes.filter((node) => selectionRef.current.has(node.id)))
  }
  const createGroupFromSelection = (): void => {
    const members = modelRef.current.nodes.filter((node) => selectionRef.current.has(node.id))
    const bounds = boundsOf(members)
    if (!bounds || readOnlyRef.current) return
    const group = createGroupNode(bounds.x - GROUP_PADDING, bounds.y - GROUP_PADDING, bounds.width + GROUP_PADDING * 2, bounds.height + GROUP_PADDING * 2)
    // Below its members: the array index is the z-order.
    const data = modelRef.current
    const at = Math.min(...members.map((node) => data.nodes.indexOf(node)))
    apply({ ...data, nodes: [...data.nodes.slice(0, at), group, ...data.nodes.slice(at)] }, uiText('auto.5a0b1c170fd5'))
    replaceSelection(new Set([group.id]))
  }

  /** The cards an alignment moves, and the box it aligns them in. */
  const alignTargets = (): { nodes: CanvasNode[]; box: Rect } | null => {
    const selected = modelRef.current.nodes.filter((node) => selectionRef.current.has(node.id))
    if (selected.length === 1 && selected[0].type === 'group') {
      const group = selected[0]
      const inner = { x: group.x + GROUP_PADDING, y: group.y + GROUP_PADDING, width: group.width - GROUP_PADDING * 2, height: group.height - GROUP_PADDING * 2 }
      const nodes = modelRef.current.nodes.filter((node) => node.id !== group.id && node.x >= group.x && node.y >= group.y && node.x + node.width <= group.x + group.width && node.y + node.height <= group.y + group.height)
      return nodes.length ? { nodes, box: inner } : null
    }
    const nodes = selected.filter((node) => node.type !== 'group')
    const box = boundsOf(nodes)
    return nodes.length > 1 && box ? { nodes, box } : null
  }
  const moveAll = (moves: Map<string, Partial<Rect>>, label: string): void => {
    if (!moves.size) return
    const data = modelRef.current
    apply({ ...data, nodes: data.nodes.map((node) => moves.has(node.id) ? { ...node, ...moves.get(node.id) } as CanvasNode : node) }, label)
  }
  const align = (edge: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void => {
    const target = alignTargets()
    if (!target) return
    const { box } = target
    const moves = new Map<string, Partial<Rect>>()
    for (const node of target.nodes) {
      if (edge === 'left') moves.set(node.id, { x: box.x })
      else if (edge === 'right') moves.set(node.id, { x: box.x + box.width - node.width })
      else if (edge === 'center') moves.set(node.id, { x: box.x + (box.width - node.width) / 2 })
      else if (edge === 'top') moves.set(node.id, { y: box.y })
      else if (edge === 'bottom') moves.set(node.id, { y: box.y + box.height - node.height })
      else moves.set(node.id, { y: box.y + (box.height - node.height) / 2 })
    }
    moveAll(moves, uiText('canvas.menu.align'))
  }
  const arrange = (layout: 'horizontal' | 'vertical' | 'grid'): void => {
    const target = alignTargets()
    if (!target || target.nodes.length < 2) return
    const gap = gridSpacing(viewportRef.current.zoom)
    const rows: CanvasNode[][] = []
    let bottom = -Infinity
    for (const node of [...target.nodes].sort((a, b) => a.y - b.y)) {
      if (node.y < bottom && rows.length) { rows[rows.length - 1].push(node); bottom = Math.min(bottom, node.y + node.height) } else { rows.push([node]); bottom = node.y + node.height }
    }
    rows.forEach((row) => row.sort((a, b) => a.x - b.x))
    const moves = new Map<string, Partial<Rect>>()
    const ordered = rows.flat()
    if (layout === 'grid') {
      let y = target.box.y
      for (const row of rows) {
        let x = target.box.x
        let height = 0
        for (const node of row) { moves.set(node.id, { x, y }); x += node.width + gap; height = Math.max(height, node.height) }
        y += height + gap
      }
    } else {
      let previous = ordered[0]
      for (const node of ordered.slice(1)) {
        const at = layout === 'horizontal' ? { x: (moves.get(previous.id)?.x ?? previous.x) + previous.width + gap, y: moves.get(ordered[0].id)?.y ?? ordered[0].y } : { x: moves.get(ordered[0].id)?.x ?? ordered[0].x, y: (moves.get(previous.id)?.y ?? previous.y) + previous.height + gap }
        moves.set(node.id, at)
        previous = node
      }
    }
    moveAll(moves, uiText('canvas.menu.align'))
  }
  const distribute = (axis: 'horizontal' | 'vertical'): void => {
    const target = alignTargets()
    if (!target || target.nodes.length < 3) return
    const horizontal = axis === 'horizontal'
    const nodes = [...target.nodes].sort((a, b) => horizontal ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x)
    const total = nodes.reduce((sum, node) => sum + (horizontal ? node.width : node.height), 0)
    const space = ((horizontal ? target.box.width : target.box.height) - total) / (nodes.length - 1)
    const moves = new Map<string, Partial<Rect>>()
    let cursor = horizontal ? nodes[0].x + nodes[0].width + space : nodes[0].y + nodes[0].height + space
    for (const node of nodes.slice(1, -1)) {
      moves.set(node.id, horizontal ? { x: cursor } : { y: cursor })
      cursor += (horizontal ? node.width : node.height) + space
    }
    moveAll(moves, uiText('canvas.menu.align'))
  }
  const justify = (axis: 'horizontal' | 'vertical'): void => {
    const target = alignTargets()
    if (!target || target.nodes.length < 2) return
    const moves = new Map<string, Partial<Rect>>()
    for (const node of target.nodes) moves.set(node.id, axis === 'horizontal' ? { x: target.box.x, width: target.box.width } : { y: target.box.y, height: target.box.height })
    moveAll(moves, uiText('canvas.menu.align'))
  }
  const openAlignMenu = (anchor: HTMLElement): void => {
    const r = anchor.getBoundingClientRect()
    void api.ui.openMenu([
      { id: 'align-left', label: uiText('canvas.align.left'), icon: <AlignStartVerticalIcon />, onSelect: () => align('left') },
      { id: 'align-center', label: uiText('canvas.align.center'), icon: <AlignCenterVerticalIcon />, onSelect: () => align('center') },
      { id: 'align-right', label: uiText('canvas.align.right'), icon: <AlignEndVerticalIcon />, onSelect: () => align('right') },
      { type: 'separator' },
      { id: 'align-top', label: uiText('canvas.align.top'), icon: <AlignStartHorizontalIcon />, onSelect: () => align('top') },
      { id: 'align-middle', label: uiText('canvas.align.middle'), icon: <AlignCenterHorizontalIcon />, onSelect: () => align('middle') },
      { id: 'align-bottom', label: uiText('canvas.align.bottom'), icon: <AlignEndHorizontalIcon />, onSelect: () => align('bottom') },
      { type: 'separator' },
      { id: 'arrange-horizontal', label: uiText('canvas.align.arrangeHorizontal'), icon: <StackHorizontalIcon />, onSelect: () => arrange('horizontal') },
      { id: 'arrange-vertical', label: uiText('canvas.align.arrangeVertical'), icon: <StackVerticalIcon />, onSelect: () => arrange('vertical') },
      { id: 'arrange-grid', label: uiText('canvas.align.arrangeGrid'), icon: <LayoutGridIcon />, onSelect: () => arrange('grid') },
      { type: 'separator' },
      { id: 'distribute-horizontal', label: uiText('canvas.align.distributeHorizontal'), icon: <DistributeHorizontalIcon />, onSelect: () => distribute('horizontal') },
      { id: 'distribute-vertical', label: uiText('canvas.align.distributeVertical'), icon: <DistributeVerticalIcon />, onSelect: () => distribute('vertical') },
      { type: 'separator' },
      { id: 'justify-horizontal', label: uiText('canvas.align.justifyHorizontal'), icon: <StretchHorizontalIcon />, onSelect: () => justify('horizontal') },
      { id: 'justify-vertical', label: uiText('canvas.align.justifyVertical'), icon: <StretchVerticalIcon />, onSelect: () => justify('vertical') }
    ], { x: r.left, y: r.bottom + 4 })
  }
  const openLineDirectionMenu = (anchor: HTMLElement): void => {
    const edge = selectedEdgeRef.current ? edgeById(modelRef.current, selectedEdgeRef.current) : undefined
    if (!edge) return
    const current = lineDirection(edge)
    const set = (fromEnd: 'none' | 'arrow', toEnd: 'none' | 'arrow'): void => apply(setEdgeEnds(modelRef.current, edge.id, fromEnd, toEnd), uiText('canvas.menu.lineDirection'))
    const r = anchor.getBoundingClientRect()
    void api.ui.openMenu([
      { id: 'none', label: uiText('canvas.direction.none'), icon: <LineHorizontalIcon />, type: 'checkbox', checked: current === 'none', onSelect: () => set('none', 'none') },
      { id: 'one', label: uiText('canvas.direction.one'), icon: <ArrowRightIcon />, type: 'checkbox', checked: current === 'one', onSelect: () => set('none', 'arrow') },
      { id: 'both', label: uiText('canvas.direction.both'), icon: <MoveHorizontalIcon />, type: 'checkbox', checked: current === 'both', onSelect: () => set('arrow', 'arrow') }
    ], { x: r.left, y: r.bottom + 4 })
  }
  const openBackgroundMenu = (anchor: HTMLElement): void => {
    const id = [...selectionRef.current][0]
    const group = id ? nodeById(modelRef.current, id) as GroupNode | undefined : undefined
    if (group?.type !== 'group') return
    const choose = (): void => pickFile('media', (path) => apply(updateNode(modelRef.current, group.id, { background: path } as Partial<GroupNode>), uiText('canvas.menu.setBackground')))
    if (!group.background) { choose(); return }
    const style = (value: 'cover' | 'ratio' | 'repeat'): void => apply(updateNode(modelRef.current, group.id, { backgroundStyle: value } as Partial<GroupNode>), uiText('canvas.menu.editBackground'))
    const current = group.backgroundStyle ?? 'cover'
    const r = anchor.getBoundingClientRect()
    void api.ui.openMenu([
      { id: 'replace', label: uiText('canvas.background.replace'), icon: <RepeatIcon />, onSelect: choose },
      { id: 'remove', label: uiText('canvas.background.remove'), icon: <ImageOffIcon />, onSelect: () => {
        const data = modelRef.current
        apply({ ...data, nodes: data.nodes.map((node) => { if (node.id !== group.id) return node; const next = { ...node }; delete next.background; delete next.backgroundStyle; return next }) }, uiText('canvas.background.remove'))
      } },
      { type: 'separator' },
      { id: 'cover', label: uiText('canvas.background.cover'), icon: <ScalingIcon />, type: 'checkbox', checked: current === 'cover', onSelect: () => style('cover') },
      { id: 'ratio', label: uiText('canvas.background.ratio'), icon: <AspectRatioIcon />, type: 'checkbox', checked: current === 'ratio', onSelect: () => style('ratio') },
      { id: 'repeat', label: uiText('canvas.background.repeat'), icon: <LayoutGridIcon />, type: 'checkbox', checked: current === 'repeat', onSelect: () => style('repeat') }
    ], { x: r.left, y: r.bottom + 4 })
  }
  const editSelection = (): void => {
    if (readOnlyRef.current) return
    if (selectedEdgeRef.current) { setEditingEdgeLabel(selectedEdgeRef.current); return }
    const id = [...selectionRef.current][0]
    if (id && selectionRef.current.size === 1) setEditingId(id)
  }
  const removeLabel = (): void => {
    if (selectedEdgeRef.current) apply(setEdgeLabel(modelRef.current, selectedEdgeRef.current, ''), uiText('canvas.menu.removeLabel'))
  }
  const commitEdgeLabel = (id: string, label: string): void => {
    setEditingEdgeLabel(null)
    const edge = edgeById(modelRef.current, id)
    if (!edge || (edge.label ?? '') === label.trim()) return
    apply(setEdgeLabel(modelRef.current, id, label), uiText('auto.84e1c434e634'))
  }

  /** Turn a text card into a note next to the board, keeping its place, size and colour. */
  const convertToFile = async (node: TextNode): Promise<void> => {
    if (readOnlyRef.current) return
    const folder = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
    for (let n = 0; n < 1000; n++) {
      const name = `${n === 0 ? 'Untitled' : `Untitled ${n}`}.md`
      const path = folder ? `${folder}/${name}` : name
      const written = await owner.run(() => api.vault.writeFileGuarded(path, node.text, null))
      if (written.ok) {
        if (!isViewActive()) return
        const data = modelRef.current
        apply({ ...data, nodes: data.nodes.map((entry) => entry.id !== node.id ? entry : { id: node.id, type: 'file', x: node.x, y: node.y, width: node.width, height: node.height, file: path, ...(node.color ? { color: node.color } : {}) } as FileNode) }, uiText('canvas.menu.convertToFile'))
        return
      }
      if (written.reason === 'error') return
    }
  }
  /** View names a `.base` file declares, in order. */
  const baseViews = async (path: string): Promise<string[]> => {
    const file = await owner.run(() => api.vault.readFileBaseline(path))
    if (!file) return []
    const names: string[] = []
    let inViews = false
    for (const line of file.content.split('\n')) {
      if (/^views\s*:/.test(line)) { inViews = true; continue }
      if (inViews && /^\S/.test(line)) break
      const match = inViews ? /^\s*(?:-\s*)?name\s*:\s*(.+?)\s*$/.exec(line) : null
      if (match) names.push(match[1].replace(/^(['"])(.*)\1$/, '$2'))
    }
    return names
  }

  const nodeMenuItems = async (node: CanvasNode): Promise<MenuItems> => {
    const items: MenuItems = []
    if (node.type === 'text') {
      items.push({ id: 'edit', label: uiText('canvas.menu.edit'), icon: <EditIcon />, enabled: !locked, onSelect: () => setEditingId(node.id) })
      items.push({ id: 'convert', label: uiText('canvas.menu.convertToFile'), icon: <FileInputIcon />, enabled: !locked, onSelect: () => convertToFile(node) })
      items.push({ type: 'separator' })
    }
    if (node.type === 'file' && node.file) {
      items.push({ id: 'open', label: uiText('canvas.menu.open'), icon: <OpenIcon />, onSelect: () => api.workspace.openFile(node.file) })
      items.push({ id: 'open-tab', label: uiText('canvas.menu.openInNewTab'), icon: <OpenIcon />, onSelect: () => api.workspace.openFile(node.file, undefined, { newTab: true }) })
      if (classifyFilePath(node.file) === 'base') {
        const views = await baseViews(node.file)
        const setView = (name: string | null): void => {
          const data = modelRef.current
          apply({ ...data, nodes: data.nodes.map((entry) => { if (entry.id !== node.id) return entry; const next = { ...entry } as FileNode; if (name) next.subpath = `#${name}`; else delete next.subpath; return next }) }, uiText('canvas.menu.chooseView'))
        }
        items.push({ id: 'view', label: uiText('canvas.menu.chooseView'), icon: <TableIcon />, enabled: !locked, submenu: [
          { id: 'default', label: uiText('canvas.menu.defaultView'), type: 'checkbox', checked: !node.subpath, onSelect: () => setView(null) },
          ...views.map((name) => ({ id: `view-${name}`, label: name, type: 'checkbox' as const, checked: node.subpath === `#${name}`, onSelect: () => setView(name) }))
        ] })
      }
      items.push({ type: 'separator' })
    }
    items.push(
      { id: 'front', label: uiText('auto.1f65ed95fba6'), icon: <BringToFrontIcon />, enabled: !locked, onSelect: () => restack('front') },
      { id: 'back', label: uiText('auto.e259d4e19e69'), icon: <SendToBackIcon />, enabled: !locked, onSelect: () => restack('back') },
      { id: 'duplicate', label: uiText('auto.972d57379db3'), icon: <DuplicateIcon />, enabled: !locked, onSelect: duplicateSelection },
      { id: 'zoom', label: uiText('canvas.menu.zoomToSelection'), icon: <ZoomToSelectionIcon />, onSelect: zoomToSelection },
      { type: 'separator' },
      { id: 'remove', label: uiText('canvas.menu.remove'), icon: <TrashIcon />, danger: true, enabled: !locked, onSelect: deleteSelection }
    )
    return items
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (editingRef.current) {
      if (e.key === 'Escape') setEditingId(null)
      return
    }
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
    const mod = isMac ? e.metaKey : e.ctrlKey
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (readOnlyRef.current) return
      e.preventDefault()
      deleteSelection()
    } else if (e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2')) {
      e.preventDefault()
      if (e.code === 'Digit1') fitTo(modelRef.current.nodes)
      else zoomToSelection()
    } else if (e.key === 'Escape') {
      cancelInteraction()
      replaceSelection(new Set())
      setSelectedEdge(null)
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      replaceSelection(new Set(modelRef.current.nodes.map((n) => n.id)))
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      duplicateSelection()
    } else if (mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
      if (!selectionRef.current.size) return
      e.preventDefault()
      void copySelection(e.key.toLowerCase() === 'x')
    } else if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      void pasteAt(pastePoint())
    } else if (e.key === 'Enter' && selectionRef.current.size === 1 && !readOnlyRef.current) {
      e.preventDefault()
      editSelection()
    }
  }

  // ── Drag-drop vault files / URLs onto the canvas ─────────────────────────────
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    if (readOnlyRef.current) return
    const world = worldAt(e)
    const paths = e.dataTransfer.getData('application/x-valley-path').split('\n').map((path) => path.trim()).filter(Boolean)
    if (paths.length) {
      paths.forEach((path, index) => addFile(path, { x: world.x + index * 40, y: world.y + index * 40 }))
      return
    }
    const text = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).trim()
    if (/^https?:\/\//i.test(text)) addLink(world, text)
  }

  // ── Context menu ─────────────────────────────────────────────────────────────
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if (!isViewActive()) return
    const nodeId = (e.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id') ?? null
    const world = worldAt(e)
    const at = { x: e.clientX, y: e.clientY }
    if (nodeId) {
      if (!selectionRef.current.has(nodeId)) { replaceSelection(new Set([nodeId])); setSelectedEdge(null) }
      const node = nodeById(modelRef.current, nodeId)
      if (node) void nodeMenuItems(node).then((items) => { if (isViewActive()) void api.ui.openMenu(items, at) })
      return
    }
    void api.ui.openMenu([
      ...creationItems(world),
      { type: 'separator' },
      { id: 'undo', label: uiText('auto.39fc72124884'), icon: <UndoIcon />, onSelect: doUndo },
      { id: 'redo', label: uiText('canvas.control.redo'), icon: <RedoIcon />, onSelect: doRedo },
      { id: 'paste', label: uiText('auto.db2483000d15'), icon: <ClipboardIcon />, enabled: !locked, onSelect: () => pasteAt(world) },
      { type: 'separator' },
      { id: 'read-only', label: uiText('auto.9b19a5a212de'), type: 'checkbox', checked: readOnly, onSelect: () => { setReadOnly(!readOnly); replaceSelection(new Set()); setSelectedEdge(null) } }
    ], at)
  }

  // ── Selection menu placement ─────────────────────────────────────────────────
  const selectedNodes = React.useMemo(() => model.nodes.filter((n) => selection.has(n.id)), [model.nodes, selection])
  const selectedEdgeObj: CanvasEdge | undefined = selectedEdge ? model.edges.find((x) => x.id === selectedEdge) : undefined
  const pane = viewportSize() ?? { width: 0, height: 0 }
  const menuAnchor = React.useMemo((): Point | null => {
    if (editingId || preview || marquee || draggingIds.size || panning) return null
    if (selectedEdgeObj) {
      const geom = edgeGeometry(selectedEdgeObj, nodesById, zm)
      if (!geom) return null
      const p = worldToScreen(viewport, geom.mid.x, geom.mid.y)
      return { x: p.x, y: p.y - 20 - (selectedEdgeObj.label ? 16 * zm * viewport.zoom : 0) }
    }
    const bounds = boundsOf(selectedNodes)
    if (!bounds) return null
    const lift = selectedNodes.some((node) => node.type === 'group') ? 35 * zm : selectedNodes[selectedNodes.length - 1]?.type === 'file' ? 30 * zm : 10 / viewport.zoom
    const top = worldToScreen(viewport, bounds.x + bounds.width / 2, bounds.y - lift)
    return { x: top.x, y: top.y }
  }, [selectedEdgeObj, selectedNodes, nodesById, viewport, zm, editingId, preview, marquee, draggingIds, panning])

  const groupSelection = React.useMemo((): Rect | null => {
    if (selectedNodes.length < 2) return null
    const bounds = boundsOf(selectedNodes)!
    const a = worldToScreen(viewport, bounds.x, bounds.y)
    const b = worldToScreen(viewport, bounds.x + bounds.width, bounds.y + bounds.height)
    return { x: a.x - 8, y: a.y - 8, width: b.x - a.x + 16, height: b.y - a.y + 16 }
  }, [selectedNodes, viewport])

  const rootClass =
    'canvas-root' +
    (preview ? ' is-connecting' : '') +
    (panning ? ' is-panning' : '') +
    (draggingIds.size ? ' is-dragging' : '') +
    (zoomedOut ? ' is-zoomed-out' : '') +
    (locked ? ' is-readonly' : '')
  // The tile is the *stepped* world spacing times the scale, so the dots keep a
  // near-constant screen density across the whole range. The position is the
  // pan modulo one tile — the grid still reads as world-locked.
  const gridPx = gridSpacing(viewport.zoom) * viewport.zoom
  const gridStyle: React.CSSProperties = {
    backgroundSize: `${gridPx}px ${gridPx}px`,
    backgroundPosition: `${viewport.x % gridPx - gridPx / 2}px ${viewport.y % gridPx - gridPx / 2}px`
  }
  const Modal = api.ui.Modal

  return (
    <div
      ref={rootRef}
      className={rootClass}
      style={gridStyle}
      tabIndex={0}
      onPointerDown={onRootPointerDown}
      onPointerMove={(e) => { const r = rootRef.current?.getBoundingClientRect(); if (r) pointerRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }; onRootPointerMove(e) }}
      onPointerUp={onRootPointerUp}
      onPointerCancel={cancelInteraction}
      onDoubleClick={(e) => {
        if (e.target !== rootRef.current || readOnlyRef.current) return
        addText(worldAt(e))
      }}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div
        className="canvas-world"
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, ['--zm' as string]: String(zm) } as React.CSSProperties}
      >
        <EdgeLayer
          data={model}
          nodesById={nodesById}
          selectedEdge={selectedEdge}
          editingLabel={editingEdgeLabel}
          zm={zm}
          connecting={Boolean(preview)}
          onEdgePointerDown={onEdgePointerDown}
          onStartLabelEdit={(id) => { if (!readOnlyRef.current) setEditingEdgeLabel(id) }}
          onCommitLabel={commitEdgeLabel}
          onCancelLabel={() => setEditingEdgeLabel(null)}
          preview={preview}
        />
        {model.nodes.map((node, index) => (
          <NodeView
            owner={owner}
            previewEnabled={!zoomedOut}
            sourcePath={relPath}
            key={nodesById.get(node.id) === node ? node.id : `${node.id}:${index}`}
            node={node}
            index={index}
            selected={selection.has(node.id)}
            focused={selection.size === 1 && selection.has(node.id) && !selectedEdge}
            editing={editingId === node.id}
            dragging={draggingIds.has(node.id)}
            zoom={viewport.zoom}
            readOnly={locked}
            onNodePointerDown={onNodePointerDown}
            onResizeStart={onResizeStart}
            onConnectStart={onConnectStart}
            onStartEdit={(n) => { if (!readOnlyRef.current) { replaceSelection(new Set([n.id])); setEditingId(n.id) } }}
            onCommit={commitNode}
            onCancelEdit={() => setEditingId(null)}
          />
        ))}
      </div>

      {snapGuides.map((g, i) => {
        const a = worldToScreen(viewport, g.x1, g.y1)
        const b = worldToScreen(viewport, g.x2, g.y2)
        return (
          <div
            key={i}
            className="canvas-snap-guide"
            style={{ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: g.orientation === 'v' ? 1 : Math.abs(b.x - a.x), height: g.orientation === 'v' ? Math.abs(b.y - a.y) : 1 }}
          />
        )
      })}

      {groupSelection && !draggingIds.size && (
        <div
          className="canvas-selection mod-group-selection"
          style={{ left: groupSelection.x, top: groupSelection.y, width: groupSelection.width, height: groupSelection.height, pointerEvents: 'none' }}
        />
      )}
      {marquee && <div className="canvas-selection" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
      {ghost && (
        <div
          className="canvas-drag-ghost"
          style={{ left: ghost.x, top: ghost.y, width: GHOST_SIZE[ghost.kind].width * viewport.zoom, height: GHOST_SIZE[ghost.kind].height * viewport.zoom }}
        />
      )}

      {snapshot.invalid && (
        <div className="canvas-banner" role="alert" {...OCCLUDER} onPointerDown={(e) => e.stopPropagation()}>
          <span>{uiText('canvas.error.invalid')}</span>
          <button type="button" onClick={() => void reloadDisk()}>{uiText('canvas.action.reload')}</button>
        </div>
      )}
      {saveError && !snapshot.invalid && (
        <div className="canvas-banner" role="alert" {...OCCLUDER} onPointerDown={(e) => e.stopPropagation()}>
          <span>{saveError}</span>
          <button type="button" onClick={() => { void flushSave(modelRef.current).catch(() => {}) }}>{uiText('canvas.action.retry')}</button>
          <button type="button" onClick={() => void reloadDisk()}>{uiText('canvas.action.reload')}</button>
        </div>
      )}

      {menuAnchor && (selectedNodes.length || selectedEdgeObj) && (
        <SelectionMenu
          owner={owner}
          anchor={menuAnchor}
          pane={pane}
          nodes={selectedNodes}
          edge={selectedEdgeObj}
          readOnly={locked}
          actions={{
            onRemove: deleteSelection,
            onColor: applyColor,
            onZoomToSelection: zoomToSelection,
            onCreateGroup: createGroupFromSelection,
            onAlign: openAlignMenu,
            onLineDirection: openLineDirectionMenu,
            onRemoveLabel: removeLabel,
            onEdit: editSelection,
            onBackground: openBackgroundMenu
          }}
        />
      )}

      <CardMenu owner={owner} readOnly={locked} onCreateStart={onCreateStart} onCreateClick={(kind) => addOfKind(kind)} />

      <Controls
        owner={owner}
        readOnly={readOnly}
        onUnlock={() => setReadOnly(false)}
        onZoomIn={() => { const r = viewportSize(); setViewport((v) => zoomBy(v, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2, ZOOM_BUTTON_STEP)) }}
        onZoomOut={() => { const r = viewportSize(); setViewport((v) => zoomBy(v, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2, -ZOOM_BUTTON_STEP)) }}
        onReset={() => { const r = viewportSize(); setViewport((v) => zoomAt(v, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2, 1 / v.zoom)) }}
        onFit={() => fitTo(modelRef.current.nodes)}
        onUndo={doUndo}
        onRedo={doRedo}
      />

      {modal?.type === 'pick' && (
        <Modal title={uiText(modal.kind === 'note' ? 'auto.f4ee7eb1d857' : 'auto.ddc84cc1637c')} onClose={() => setModal(null)} size="medium">
          <FileSuggest owner={owner} kind={modal.kind} onPick={modal.onPick} onClose={() => setModal(null)} />
        </Modal>
      )}
    </div>
  )
}

export default CanvasView
