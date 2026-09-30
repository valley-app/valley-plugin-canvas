/**
 * The JSONCanvas data model + tolerant parse/serialize and the pure, immutable
 * mutation helpers the editor builds on. Everything here is React-free and
 * unit-tested (`plugins/canvas/tests/model.test.ts`).
 *
 * The spec of record is `spec/1.0.md` in the JSON Canvas repository (jsoncanvas.org)
 * (MIT) — the versioned file, not the website rendering, so a 1.1 shows up as a
 * diff. `tests/fixtures/sample.canvas` is an adapted sample with a neutral project link,
 * round-tripped by the test suite.
 *
 * Tolerance mirrors the vault's JSONL invariant: a malformed `.canvas` never
 * throws. Unparseable JSON is reported as invalid so the editor stays
 * read-only instead of overwriting it, and every node, edge or top-level key
 * the editor cannot use is kept verbatim so a save never drops another tool's data.
 */
import { paletteCssContrast, paletteCssValue, paletteRef } from '@valley/plugin-sdk/palette'

export type CanvasColor = string // a preset "1".."6" or a "#rrggbb" hex

export interface CanvasNodeBase {
  id: string
  x: number
  y: number
  width: number
  height: number
  color?: CanvasColor
  /** Preserve fields written by other tools and future spec additions. */
  [key: string]: unknown
}
export interface TextNode extends CanvasNodeBase {
  type: 'text'
  text: string
}
export interface FileNode extends CanvasNodeBase {
  type: 'file'
  file: string
  /** Always starts with `#` — a heading (`#Title`) or a block (`#^id`). */
  subpath?: string
}
export interface LinkNode extends CanvasNodeBase {
  type: 'link'
  url: string
}
/** How a group paints its `background` image. */
export type GroupBackgroundStyle = 'cover' | 'ratio' | 'repeat'
export const GROUP_BACKGROUND_STYLES: readonly GroupBackgroundStyle[] = ['cover', 'ratio', 'repeat']

export interface GroupNode extends CanvasNodeBase {
  type: 'group'
  label?: string
  /** Vault path to the background image. */
  background?: string
  backgroundStyle?: GroupBackgroundStyle
}
export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode
export type CanvasNodeType = CanvasNode['type']

export type EdgeSide = 'top' | 'right' | 'bottom' | 'left'
export type EdgeEnd = 'none' | 'arrow'

export interface CanvasEdge {
  id: string
  fromNode: string
  fromSide?: EdgeSide
  toNode: string
  toSide?: EdgeSide
  fromEnd?: EdgeEnd
  toEnd?: EdgeEnd
  color?: CanvasColor
  label?: string
  [key: string]: unknown
}

/** An array entry the editor cannot use, kept verbatim at its original position. */
export interface PreservedEntry {
  index: number
  raw: unknown
}

export interface CanvasData {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  /** Unknown top-level keys, written back after `nodes` and `edges`. */
  extra?: Record<string, unknown>
  /** Entries that could not be read as nodes/edges (no id, duplicate id, unknown type). */
  preserved?: { nodes: PreservedEntry[]; edges: PreservedEntry[] }
}

/**
 * The six presets, as **palette ids** rather than frozen hexes.
 *
 * The spec deliberately leaves the values open — "Specific values for the preset
 * colors are intentionally not defined so that applications can tailor the
 * presets to their specific brand colors or color scheme" — so `"1".."6"` stays
 * the on-disk form (the interchange contract) while the rendered
 * colour comes from `src/shared/palette.ts` and follows light/dark plus
 * any `.valley/design/*.css` override.
 */
export const CANVAS_PRESET_PALETTE: Record<string, string> = {
  '1': 'red',
  '2': 'orange',
  '3': 'yellow',
  '4': 'green',
  '5': 'cyan',
  '6': 'purple'
}

/**
 * Resolve a node/edge `color` to a CSS value, or null when unset/unknown.
 *
 * A preset becomes `var(--color-<id>)` — never a resolved hex, so the user can
 * still repoint it from a design snippet (AGENTS.md). A `#rrggbb` literal is
 * returned as written.
 */
export function resolveColor(color: CanvasColor | undefined): string | null {
  if (!color) return null
  if (color.startsWith('#')) return color
  const id = CANVAS_PRESET_PALETTE[color]
  return id ? paletteCssValue(paletteRef(id)) : null
}

/**
 * The readable foreground for text sitting ON a filled {@link resolveColor} —
 * a group's label plate, which is filled solid once the group is themed.
 * Null when the colour is unset or unknown; a custom hex falls back to the app's
 * title colour, because we cannot know a user literal's luminance without
 * freezing a computed value.
 */
export function resolveContrast(color: CanvasColor | undefined): string | null {
  if (!color) return null
  if (color.startsWith('#')) return paletteCssContrast(color)
  const id = CANVAS_PRESET_PALETTE[color]
  return id ? paletteCssContrast(paletteRef(id)) : null
}

export const DEFAULT_TEXT_WIDTH = 250
export const DEFAULT_TEXT_HEIGHT = 60
export const DEFAULT_FILE_WIDTH = 400
export const DEFAULT_FILE_HEIGHT = 400
export const DEFAULT_LINK_WIDTH = 400
export const DEFAULT_LINK_HEIGHT = 300

const NODE_TYPES: readonly CanvasNodeType[] = ['text', 'file', 'link', 'group']
const EDGE_ENDS: readonly EdgeEnd[] = ['none', 'arrow']
export const EDGE_SIDES: readonly EdgeSide[] = ['top', 'right', 'bottom', 'left']

function edgeSide(v: unknown): EdgeSide | undefined {
  return EDGE_SIDES.includes(v as EdgeSide) ? (v as EdgeSide) : undefined
}
function edgeEnd(v: unknown): EdgeEnd | undefined {
  return EDGE_ENDS.includes(v as EdgeEnd) ? (v as EdgeEnd) : undefined
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 16 lowercase hex chars, the usual JSON Canvas node/edge id shape. */
export function genId(): string {
  const bytes = new Uint8Array(8)
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function coerceNode(raw: unknown): CanvasNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id : null
  const type = o.type as CanvasNodeType
  if (!id || !NODE_TYPES.includes(type)) return null
  // Every other key — including values this editor does not understand, such as
  // a subpath without `#` or an unknown background style — is kept as written.
  const base = {
    ...o,
    id,
    type,
    x: num(o.x, 0),
    y: num(o.y, 0),
    width: num(o.width, DEFAULT_TEXT_WIDTH),
    height: num(o.height, DEFAULT_TEXT_HEIGHT)
  }
  if (type === 'text') return { ...base, text: str(o.text) } as TextNode
  if (type === 'file') return { ...base, file: str(o.file) } as FileNode
  if (type === 'link') return { ...base, url: str(o.url) } as LinkNode
  return base as GroupNode
}

function coerceEdge(raw: unknown): CanvasEdge | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id : null
  const fromNode = typeof o.fromNode === 'string' ? o.fromNode : null
  const toNode = typeof o.toNode === 'string' ? o.toNode : null
  if (!id || !fromNode || !toNode) return null
  return { ...o, id, fromNode, toNode } as CanvasEdge
}

/** A side the renderer can anchor to; anything else falls back to the derived side. */
export function validSide(side: unknown): EdgeSide | undefined {
  return edgeSide(side)
}
/** An end the renderer can draw; anything else uses the spec default. */
export function validEnd(end: unknown): EdgeEnd | undefined {
  return edgeEnd(end)
}
/** The subpath of a file node, when it is one (`#Heading` or `#^block`). */
export function fileSubpath(node: FileNode): string | undefined {
  return typeof node.subpath === 'string' && node.subpath.startsWith('#') ? node.subpath : undefined
}
/** The background image of a group, and how it paints. */
export function groupBackground(node: GroupNode): { file: string; style: GroupBackgroundStyle } | null {
  if (typeof node.background !== 'string' || !node.background) return null
  const style = GROUP_BACKGROUND_STYLES.includes(node.backgroundStyle as GroupBackgroundStyle) ? node.backgroundStyle as GroupBackgroundStyle : 'cover'
  return { file: node.background, style }
}

export interface ParsedCanvas {
  data: CanvasData
  /** False when the text is not a JSON Canvas document at all; the file must not be overwritten. */
  valid: boolean
}

/** Parse `.canvas` text. Never throws; entries the editor cannot use are preserved verbatim. */
export function parseCanvasDocument(text: string): ParsedCanvas {
  if (!text || !text.trim()) return { data: { nodes: [], edges: [] }, valid: true }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { data: { nodes: [], edges: [] }, valid: false }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: { nodes: [], edges: [] }, valid: false }
  const obj = raw as Record<string, unknown>
  if ((obj.nodes !== undefined && !Array.isArray(obj.nodes)) || (obj.edges !== undefined && !Array.isArray(obj.edges))) return { data: { nodes: [], edges: [] }, valid: false }
  const preserved: { nodes: PreservedEntry[]; edges: PreservedEntry[] } = { nodes: [], edges: [] }
  const nodes: CanvasNode[] = []
  const nodeIds = new Set<string>()
  ;(obj.nodes as unknown[] | undefined ?? []).forEach((entry, index) => {
    const node = coerceNode(entry)
    if (node && !nodeIds.has(node.id)) { nodeIds.add(node.id); nodes.push(node) } else preserved.nodes.push({ index, raw: entry })
  })
  const edges: CanvasEdge[] = []
  const edgeIds = new Set<string>()
  ;(obj.edges as unknown[] | undefined ?? []).forEach((entry, index) => {
    const edge = coerceEdge(entry)
    if (edge && !edgeIds.has(edge.id)) { edgeIds.add(edge.id); edges.push(edge) } else preserved.edges.push({ index, raw: entry })
  })
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) if (key !== 'nodes' && key !== 'edges') extra[key] = value
  const data: CanvasData = { nodes, edges }
  if (Object.keys(extra).length) data.extra = extra
  if (preserved.nodes.length || preserved.edges.length) data.preserved = preserved
  return { data, valid: true }
}

/** Parse `.canvas` text into a model. Never throws — malformed → empty canvas. */
export function parseCanvas(text: string): CanvasData {
  return parseCanvasDocument(text).data
}

function withPreserved(items: readonly unknown[], preserved: readonly PreservedEntry[] | undefined): unknown[] {
  if (!preserved?.length) return [...items]
  const out = [...items]
  for (const entry of preserved) out.splice(Math.min(entry.index, out.length), 0, entry.raw)
  return out
}

function serializeList(key: string, items: readonly unknown[]): string {
  if (!items.length) return `\t${JSON.stringify(key)}:[]`
  return `\t${JSON.stringify(key)}:[\n${items.map((item) => `\t\t${JSON.stringify(item)}`).join(',\n')}\n\t]`
}

/**
 * Serialize in the common JSON Canvas layout: tab-indented, one entry per line,
 * no trailing newline — so a board saved here diffs cleanly against one saved
 * by another JSON Canvas editor.
 *
 * Node order IS z-order (spec: "Nodes are placed in the array in ascending order
 * by z-index"), so the array is written exactly as held — never sorted.
 */
export function serializeCanvas(data: CanvasData): string {
  const parts = [
    serializeList('nodes', withPreserved(data.nodes, data.preserved?.nodes)),
    serializeList('edges', withPreserved(data.edges, data.preserved?.edges))
  ]
  for (const [key, value] of Object.entries(data.extra ?? {})) parts.push(`\t${JSON.stringify(key)}:${JSON.stringify(value)}`)
  return `{\n${parts.join(',\n')}\n}`
}

export const EMPTY_CANVAS = serializeCanvas({ nodes: [], edges: [] })

/**
 * The slice of `markdown` a file node's `subpath` points at.
 *
 * `#Heading` runs from that ATX heading to the next heading of equal-or-higher
 * level; `#^blockid` returns the single block whose line ends `^blockid`. No
 * match returns the whole text — a subpath that stopped resolving should show
 * the note, not an empty card. Never throws.
 */
export function sliceSubpath(markdown: string, subpath: string | undefined): string {
  if (!subpath || !subpath.startsWith('#')) return markdown
  const target = subpath.slice(1).trim()
  if (!target) return markdown
  const lines = markdown.split('\n')

  if (target.startsWith('^')) {
    const id = target.slice(1)
    if (!id) return markdown
    const at = lines.findIndex((line) => line.trimEnd().endsWith(`^${id}`))
    if (at === -1) return markdown
    // A block is the contiguous run of non-blank lines around the anchor.
    let start = at
    while (start > 0 && lines[start - 1].trim() !== '') start -= 1
    let end = at
    while (end < lines.length - 1 && lines[end + 1].trim() !== '') end += 1
    return lines
      .slice(start, end + 1)
      .join('\n')
      .replace(new RegExp(`\\s*\\^${id}\\s*$`), '')
  }

  const wanted = target.toLowerCase()
  const headingAt = (line: string): { level: number; text: string } | null => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    return m ? { level: m[1].length, text: m[2].trim() } : null
  }
  const start = lines.findIndex((line) => headingAt(line)?.text.toLowerCase() === wanted)
  if (start === -1) return markdown
  const level = headingAt(lines[start])!.level
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const h = headingAt(lines[i])
    if (h && h.level <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trimEnd()
}

// ── Node factories ──────────────────────────────────────────────────────────

export function createTextNode(x: number, y: number, text = '', width = DEFAULT_TEXT_WIDTH, height = DEFAULT_TEXT_HEIGHT): TextNode {
  return { id: genId(), type: 'text', x, y, width, height, text }
}
export function createFileNode(x: number, y: number, file: string, width = DEFAULT_FILE_WIDTH, height = DEFAULT_FILE_HEIGHT, subpath?: string): FileNode {
  return { id: genId(), type: 'file', x, y, width, height, file, ...(subpath ? { subpath } : {}) }
}
export function createLinkNode(x: number, y: number, url: string, width = DEFAULT_LINK_WIDTH, height = DEFAULT_LINK_HEIGHT): LinkNode {
  return { id: genId(), type: 'link', x, y, width, height, url }
}
export function createGroupNode(x: number, y: number, width: number, height: number, label?: string): GroupNode {
  return { id: genId(), type: 'group', x, y, width, height, ...(label ? { label } : {}) }
}

// ── Immutable mutation helpers ──────────────────────────────────────────────

/**
 * Append a node. Last in the array = on top, per the spec's z-order rule, so a
 * freshly added card lands above whatever it was dropped onto.
 */
export function addNode(data: CanvasData, node: CanvasNode): CanvasData {
  return { ...data, nodes: [...data.nodes, node] }
}

export function addEdge(data: CanvasData, edge: CanvasEdge): CanvasData {
  return { ...data, edges: [...data.edges, edge] }
}

/** Remove nodes (by id) and any edge touching them. */
export function removeNodes(data: CanvasData, ids: ReadonlySet<string>): CanvasData {
  if (ids.size === 0) return data
  return {
    ...data,
    nodes: data.nodes.filter((n) => !ids.has(n.id)),
    edges: data.edges.filter((e) => !ids.has(e.fromNode) && !ids.has(e.toNode))
  }
}

export function removeEdges(data: CanvasData, ids: ReadonlySet<string>): CanvasData {
  if (ids.size === 0) return data
  return { ...data, edges: data.edges.filter((e) => !ids.has(e.id)) }
}

/**
 * Move nodes to the top (`'front'`) or bottom (`'back'`) of the array — which,
 * per the spec, *is* the stacking change. Relative order within the moved set
 * and within the rest is preserved, so raising two cards keeps them ordered.
 */
export function reorderNodes(data: CanvasData, ids: ReadonlySet<string>, to: 'front' | 'back'): CanvasData {
  if (ids.size === 0) return data
  const moved = data.nodes.filter((n) => ids.has(n.id))
  if (moved.length === 0) return data
  const rest = data.nodes.filter((n) => !ids.has(n.id))
  return { ...data, nodes: to === 'front' ? [...rest, ...moved] : [...moved, ...rest] }
}

export function moveNodes(data: CanvasData, ids: ReadonlySet<string>, dx: number, dy: number): CanvasData {
  if (ids.size === 0 || (dx === 0 && dy === 0)) return data
  return { ...data, nodes: data.nodes.map((n) => (ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }
}

export function setNodePositions(
  data: CanvasData,
  positions: ReadonlyMap<string, { x: number; y: number }>
): CanvasData {
  return {
    ...data,
    nodes: data.nodes.map((n) => {
      const p = positions.get(n.id)
      return p ? { ...n, x: p.x, y: p.y } : n
    })
  }
}

export function setNodeRect(
  data: CanvasData,
  id: string,
  rect: { x: number; y: number; width: number; height: number }
): CanvasData {
  return { ...data, nodes: data.nodes.map((n) => (n.id === id ? { ...n, ...rect } : n)) }
}

export function updateNode(data: CanvasData, id: string, patch: Partial<CanvasNode>): CanvasData {
  return { ...data, nodes: data.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n)) }
}

export function setNodeText(data: CanvasData, id: string, text: string): CanvasData {
  return updateNode(data, id, { text } as Partial<TextNode>)
}

/** Duplicate nodes with fresh ids, offset so the copies are visibly distinct. */
export function duplicateNodes(
  data: CanvasData,
  ids: ReadonlySet<string>,
  offset = 32
): { data: CanvasData; ids: Set<string> } {
  const copies: CanvasNode[] = []
  const made = new Set<string>()
  const mapping = new Map<string, string>()
  for (const n of data.nodes) {
    if (!ids.has(n.id)) continue
    const id = genId()
    made.add(id)
    mapping.set(n.id, id)
    copies.push({ ...n, id, x: n.x + offset, y: n.y + offset } as CanvasNode)
  }
  if (copies.length === 0) return { data, ids: made }
  return { data: { ...data, nodes: [...data.nodes, ...copies], edges: [...data.edges, ...data.edges.filter((edge) => mapping.has(edge.fromNode) && mapping.has(edge.toNode)).map((edge) => ({ ...edge, id: genId(), fromNode: mapping.get(edge.fromNode)!, toNode: mapping.get(edge.toNode)! }))] }, ids: made }
}

/** Apply a color (or clear it with `undefined`) to many nodes at once. */
export function setNodesColor(data: CanvasData, ids: ReadonlySet<string>, color: CanvasColor | undefined): CanvasData {
  if (ids.size === 0) return data
  return {
    ...data,
    nodes: data.nodes.map((n) => {
      if (!ids.has(n.id)) return n
      const next = { ...n }
      if (color) next.color = color
      else delete next.color
      return next
    })
  }
}

function patchEdge(data: CanvasData, id: string, patch: (edge: CanvasEdge) => CanvasEdge): CanvasData {
  return { ...data, edges: data.edges.map((e) => (e.id === id ? patch({ ...e }) : e)) }
}

export function setEdgeColor(data: CanvasData, id: string, color: CanvasColor | undefined): CanvasData {
  return patchEdge(data, id, (next) => {
    if (color) next.color = color
    else delete next.color
    return next
  })
}

/** Set (or clear, with an empty string) an edge's `label`. */
export function setEdgeLabel(data: CanvasData, id: string, label: string): CanvasData {
  return patchEdge(data, id, (next) => {
    const trimmed = label.trim()
    if (trimmed) next.label = trimmed
    else delete next.label
    return next
  })
}

/**
 * Set an edge's arrowheads. The spec's defaults are `fromEnd: 'none'` and
 * `toEnd: 'arrow'`, so those two are written out only when they differ — a
 * plain one-way arrow stays minimal.
 */
export function setEdgeEnds(data: CanvasData, id: string, fromEnd: EdgeEnd, toEnd: EdgeEnd): CanvasData {
  return patchEdge(data, id, (next) => {
    if (!EDGE_ENDS.includes(fromEnd) || !EDGE_ENDS.includes(toEnd)) return next
    if (fromEnd === 'none') delete next.fromEnd
    else next.fromEnd = fromEnd
    if (toEnd === 'arrow') delete next.toEnd
    else next.toEnd = toEnd
    return next
  })
}

/** The four `fromEnd`/`toEnd` pairs the edge menu cycles through, in order. */
export const EDGE_END_CYCLE: readonly { fromEnd: EdgeEnd; toEnd: EdgeEnd }[] = [
  { fromEnd: 'none', toEnd: 'arrow' },
  { fromEnd: 'arrow', toEnd: 'none' },
  { fromEnd: 'arrow', toEnd: 'arrow' },
  { fromEnd: 'none', toEnd: 'none' }
]

/** The next entry of {@link EDGE_END_CYCLE} after this edge's current ends. */
export function nextEdgeEnds(edge: CanvasEdge): { fromEnd: EdgeEnd; toEnd: EdgeEnd } {
  const fromEnd = edge.fromEnd === 'arrow' ? 'arrow' : 'none'
  const toEnd = edge.toEnd === 'none' ? 'none' : 'arrow'
  const at = EDGE_END_CYCLE.findIndex((c) => c.fromEnd === fromEnd && c.toEnd === toEnd)
  return EDGE_END_CYCLE[(at + 1) % EDGE_END_CYCLE.length]
}

export function nodeById(data: CanvasData, id: string): CanvasNode | undefined {
  return data.nodes.find((n) => n.id === id)
}

export function edgeById(data: CanvasData, id: string): CanvasEdge | undefined {
  return data.edges.find((e) => e.id === id)
}
