import { React } from './runtime'
import {
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type EdgeSide,
  resolveColor,
  validEnd,
  validSide
} from './canvasModel'
import {
  ARROW_LENGTH,
  arrowHead,
  bezierPath,
  boundsOf,
  chooseSide,
  edgePath,
  nodeRect,
  sideAnchor,
  type Point
} from './geometry'

// Padding around the node bounds so the SVG box comfortably contains bezier
// control-point bows + arrowheads (the curve can bow out by up to ~400px).
const SVG_PAD = 500
/** Edge labels sit above unselected cards (their z-index band), so host content leaves room for them. */
const LABEL_LAYER = 50000

function opposite(side: EdgeSide): EdgeSide {
  return side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left'
}

export interface EdgeGeom {
  edge: CanvasEdge
  path: string
  from: Point
  fromSide: EdgeSide
  to: Point
  toSide: EdgeSide
  mid: Point
  color: string | null
  fromArrow: boolean
  toArrow: boolean
}

/** Where an edge runs, or null when either end is not on the board. */
export function edgeGeometry(edge: CanvasEdge, nodes: Map<string, CanvasNode>, zm: number): EdgeGeom | null {
  const a = nodes.get(edge.fromNode)
  const b = nodes.get(edge.toNode)
  if (!a || !b) return null
  const ra = nodeRect(a)
  const rb = nodeRect(b)
  const fromSide = validSide(edge.fromSide) ?? chooseSide(ra, rb)
  const toSide = validSide(edge.toSide) ?? chooseSide(rb, ra)
  const from = sideAnchor(ra, fromSide)
  const to = sideAnchor(rb, toSide)
  const drawn = edgePath(from, fromSide, to, toSide, ARROW_LENGTH * zm)
  return {
    edge,
    path: drawn.path,
    from,
    fromSide,
    to,
    toSide,
    mid: drawn.mid,
    color: resolveColor(edge.color),
    fromArrow: (validEnd(edge.fromEnd) ?? 'none') === 'arrow',
    toArrow: (validEnd(edge.toEnd) ?? 'arrow') === 'arrow'
  }
}

export interface ConnectPreview {
  from: Point
  fromSide: EdgeSide
  to: Point
}

export interface EdgeLayerProps {
  data: CanvasData
  nodesById: Map<string, CanvasNode>
  selectedEdge: string | null
  /** Id of the edge whose label is being edited inline, if any. */
  editingLabel: string | null
  /** The zoom multiplier: chrome inside the board keeps part of its screen size. */
  zm: number
  connecting: boolean
  onEdgePointerDown: (event: React.PointerEvent, edge: CanvasEdge) => void
  onStartLabelEdit: (id: string) => void
  onCommitLabel: (id: string, label: string) => void
  onCancelLabel: () => void
  preview: ConnectPreview | null
}

/**
 * The connector layer, drawn in world units inside the transformed world element
 * so it pans/zooms with the nodes.
 *
 * Two sub-layers: one SVG for the curves, arrowheads and fat transparent hit
 * paths, and a DOM layer above it for labels. Labels are DOM rather than SVG
 * `<text>` because they need an opaque plate to stay readable over a card, and
 * an inline editor on double-click.
 */
export const EdgeLayer = (props: EdgeLayerProps): ReturnType<typeof React.createElement> => {
  const { data, nodesById, selectedEdge, editingLabel, zm, preview } = props
  // Size the SVG to the node bounds (+ padding) and give it a matching viewBox so
  // its user space is identical to world space — a 0×0 SVG does not paint its
  // overflow in Chromium, so edges drawn at world coords were being culled.
  const bounds = boundsOf(data.nodes)
  if (!bounds) return <svg className="canvas-edges" />
  const minX = bounds.x - SVG_PAD
  const minY = bounds.y - SVG_PAD
  const w = bounds.width + SVG_PAD * 2
  const h = bounds.height + SVG_PAD * 2

  const geoms = data.edges
    .map((edge) => edgeGeometry(edge, nodesById, zm))
    .filter((g): g is EdgeGeom => g !== null)

  return (
    <>
      <svg
        className={`canvas-edges${props.connecting ? ' is-connecting' : ''}`}
        style={{ left: minX, top: minY, width: w, height: h }}
        width={w}
        height={h}
        viewBox={`${minX} ${minY} ${w} ${h}`}
      >
        {geoms.map((g) => {
          const edge = g.edge
          const style = g.color ? ({ ['--canvas-color' as string]: g.color } as React.CSSProperties) : undefined
          return (
            <g key={edge.id} className={`canvas-edge${selectedEdge === edge.id ? ' is-focused' : ''}${g.color ? ' is-themed' : ''}`} style={style} data-edge-id={edge.id}>
              <path className="canvas-display-path" d={g.path} />
              <path className="canvas-interaction-path" d={g.path} onPointerDown={(e) => props.onEdgePointerDown(e, edge)} />
              {g.toArrow && <polygon className="canvas-path-end" points={arrowHead(g.to, g.toSide, zm)} />}
              {g.fromArrow && <polygon className="canvas-path-end" points={arrowHead(g.from, g.fromSide, zm)} />}
            </g>
          )
        })}
        {preview && (
          <path
            className="canvas-edge-preview"
            d={bezierPath(preview.from, preview.fromSide, preview.to, opposite(preview.fromSide))}
          />
        )}
      </svg>

      <div className="canvas-edge-labels">
        {geoms.map((g) => {
          const editing = editingLabel === g.edge.id
          if (!g.edge.label && !editing) return null
          const style = { left: g.mid.x, top: g.mid.y, ...(g.color ? { ['--canvas-color' as string]: g.color } : {}) } as React.CSSProperties
          return (
            <div
              key={g.edge.id}
              className={`canvas-path-label-wrapper${selectedEdge === g.edge.id ? ' is-focused' : ''}`}
              style={style}
            >
              {editing ? (
                <EdgeLabelInput
                  initial={typeof g.edge.label === 'string' ? g.edge.label : ''}
                  onCommit={(value) => props.onCommitLabel(g.edge.id, value)}
                  onCancel={props.onCancelLabel}
                />
              ) : (
                <div
                  className="canvas-path-label"
                  data-plugin-widget-occluder={LABEL_LAYER}
                  onPointerDown={(e) => props.onEdgePointerDown(e, g.edge)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    props.onStartLabelEdit(g.edge.id)
                  }}
                >
                  {String(g.edge.label)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

const EdgeLabelInput = (props: {
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}): ReturnType<typeof React.createElement> => {
  const [value, setValue] = React.useState(props.initial)
  const done = React.useRef(false)
  const commit = (): void => {
    if (done.current) return
    done.current = true
    props.onCommit(value)
  }
  return (
    <textarea
      className="canvas-path-label is-editing"
      data-plugin-widget-occluder={LABEL_LAYER}
      autoFocus
      rows={Math.max(1, value.split('\n').length)}
      value={value}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          done.current = true
          props.onCancel()
        }
      }}
    />
  )
}
