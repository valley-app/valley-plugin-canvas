import { React, type CanvasOwner } from './runtime'
import { parseCanvasDocument, resolveColor, type CanvasData, type CanvasNode } from './canvasModel'
import { boundsOf, nodeRect } from './geometry'
import { edgeGeometry } from './edges'
import { uiText } from './localization'

/**
 * What an embedded board shows — `![[board.canvas]]` in a note, or a `.canvas`
 * card on another board: an outline of its groups, connections and cards.
 * It is read-only, never captures the wheel (the note keeps scrolling), and
 * opens the board on click.
 */
export const CanvasMinimap = ({ owner, relPath }: { owner: CanvasOwner; relPath: string }): ReturnType<typeof React.createElement> => {
  const api = owner.api
  const [state, setState] = React.useState<{ data: CanvasData; valid: boolean } | null>(null)
  const [missing, setMissing] = React.useState(false)
  const [epoch, setEpoch] = React.useState(0)
  React.useEffect(() => {
    if (!owner.isActive()) return
    const off = api.vault.onChanged((event) => { if (event.full || event.changes.some((change) => change.relPath === relPath)) setEpoch((n) => n + 1) })
    const offOwner = owner.onDispose(off)
    return () => { offOwner(); off() }
  }, [api, owner, relPath])
  React.useEffect(() => {
    let active = true
    void owner.run(() => api.vault.readFileBaseline(relPath)).then((file) => {
      if (!active || !owner.isActive()) return
      if (!file) { setMissing(true); return }
      setMissing(false)
      setState(parseCanvasDocument(file.content))
    }).catch(() => { if (active && owner.isActive()) setMissing(true) })
    return () => { active = false }
  }, [api, owner, relPath, epoch])

  const open = (event: React.MouseEvent): void => {
    if (owner.isActive()) void api.workspace.openFile(relPath, undefined, { newTab: api.ui.hasModKey(event) })
  }
  const message = missing ? uiText('canvas.file.missing', { path: relPath }) : state && !state.valid ? uiText('canvas.error.invalid') : state && !state.data.nodes.length ? uiText('canvas.minimap.empty') : ''
  return (
    <div className="canvas-minimap-embed" role="button" tabIndex={0} aria-label={relPath} onClick={open} onKeyDown={(event) => { if (event.key === 'Enter') open(event as unknown as React.MouseEvent) }}>
      {message ? <div className="canvas-minimap-message">{message}</div> : state ? <Minimap data={state.data} /> : null}
    </div>
  )
}

const Minimap = ({ data }: { data: CanvasData }): ReturnType<typeof React.createElement> | null => {
  const bounds = boundsOf(data.nodes)
  if (!bounds) return null
  const nodes = new Map(data.nodes.map((node) => [node.id, node]))
  // Stroke widths scale with the board so a huge board still reads as an outline.
  const scale = Math.sqrt(Math.max(bounds.width, 1) / 10)
  const pad = 10 * scale
  const viewBox = `${bounds.x - pad} ${bounds.y - pad} ${bounds.width + pad * 2} ${bounds.height + pad * 2}`
  const rect = (node: CanvasNode): ReturnType<typeof React.createElement> => {
    const r = nodeRect(node)
    const color = resolveColor(node.color)
    return (
      <rect
        key={node.id}
        className={color ? 'is-themed' : undefined}
        style={{ ...(color ? { ['--canvas-color' as string]: color } : {}), strokeWidth: 5 * scale / 3 }}
        x={r.x}
        y={r.y}
        width={Math.max(1, r.width)}
        height={Math.max(1, r.height)}
        rx={20}
        ry={20}
      />
    )
  }
  return (
    <svg className="canvas-minimap" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" style={{ aspectRatio: `${bounds.width + pad * 2} / ${bounds.height + pad * 2}` }}>
      {data.nodes.filter((node) => node.type === 'group').map(rect)}
      {data.edges.map((edge) => {
        const geom = edgeGeometry(edge, nodes, 0)
        if (!geom) return null
        return <path key={edge.id} className={geom.color ? 'is-themed' : undefined} style={{ ...(geom.color ? { ['--canvas-color' as string]: geom.color } : {}), strokeWidth: scale }} d={geom.path} />
      })}
      {data.nodes.filter((node) => node.type !== 'group').map(rect)}
    </svg>
  )
}
