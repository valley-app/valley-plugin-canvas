import { addNode, addEdge, createTextNode, createFileNode, createLinkNode, createGroupNode, duplicateNodes, genId, removeNodes, removeEdges, reorderNodes, updateNode, type CanvasData, type CanvasNode, type CanvasEdge } from './canvasModel'
import { boundsOf, gridSpacing, type Rect } from './geometry'
import { isAllowedExternalUrl, normalizeRelPathOpt } from '@valley/plugin-sdk/paths'

export const canvasNodeFields = { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 }, color: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, subpath: { type: 'string' }, url: { type: 'string' }, label: { type: 'string' }, background: { type: 'string' }, backgroundStyle: { type: 'string', enum: ['cover', 'ratio', 'repeat'] } }
export const canvasEdgeFields = { fromNode: { type: 'string' }, toNode: { type: 'string' }, fromSide: { type: 'string', enum: ['top', 'right', 'bottom', 'left'] }, toSide: { type: 'string', enum: ['top', 'right', 'bottom', 'left'] }, fromEnd: { type: 'string', enum: ['none', 'arrow'] }, toEnd: { type: 'string', enum: ['none', 'arrow'] }, color: { type: 'string' }, label: { type: 'string' } }
export const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
export const stringSchema = { type: 'string', minLength: 1 }
const idsSchema = { type: 'array', items: stringSchema, minItems: 1, uniqueItems: true }
export const canvasOperationSchema = { oneOf: [
  objectSchema({ type: { const: 'add-node' }, node: objectSchema({ id: stringSchema, type: { type: 'string', enum: ['text', 'file', 'link', 'group'] }, ...canvasNodeFields }, ['type', 'x', 'y']) }, ['type', 'node']),
  objectSchema({ type: { const: 'update-node' }, id: stringSchema, values: objectSchema(canvasNodeFields) }, ['type', 'id', 'values']),
  objectSchema({ type: { const: 'add-edge' }, edge: objectSchema({ id: stringSchema, ...canvasEdgeFields }, ['fromNode', 'toNode']) }, ['type', 'edge']),
  objectSchema({ type: { const: 'update-edge' }, id: stringSchema, values: objectSchema(canvasEdgeFields) }, ['type', 'id', 'values']),
  ...['delete-nodes', 'delete-edges', 'duplicate-nodes'].map((type) => objectSchema({ type: { const: type }, ids: idsSchema }, ['type', 'ids'])),
  objectSchema({ type: { const: 'reorder-nodes' }, ids: idsSchema, to: { type: 'string', enum: ['front', 'back'] } }, ['type', 'ids', 'to'])
] }

export function record(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object.'); return raw as Record<string, unknown> }
export function requiredString(raw: unknown): string { if (typeof raw !== 'string' || !raw.trim()) throw new Error('Expected a nonempty id or path.'); return raw }
function checkFields(raw: unknown, allowed: Record<string, unknown>): Record<string, unknown> {
  const values = record(raw)
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(allowed, key)) throw new Error(`Unsupported canvas field "${key}".`)
    if (['x', 'y', 'width', 'height'].includes(key)) { if (typeof value !== 'number' || !Number.isFinite(value) || (['width', 'height'].includes(key) && value <= 0)) throw new Error('Invalid card geometry.') }
    else if (typeof value !== 'string') throw new Error(`Expected text for "${key}".`)
    const choices = (allowed[key] as { enum?: string[] }).enum
    if (choices && !choices.includes(String(value))) throw new Error(`Invalid canvas ${key}.`)
  }
  for (const key of ['file', 'background']) if (values[key] && normalizeRelPathOpt(values[key]) !== values[key]) throw new Error('Invalid canvas file path.')
  if (values.url && !isAllowedExternalUrl(String(values.url))) throw new Error('Unsafe canvas link.')
  if (values.color && !/^(?:[1-6]|#[0-9a-f]{6})$/i.test(String(values.color))) throw new Error('Invalid canvas color.')
  return values
}


function fieldsForNode(type: string): Record<string, unknown> {
  const keys = ['x', 'y', 'width', 'height', 'color', ...(type === 'text' ? ['text'] : type === 'file' ? ['file', 'subpath'] : type === 'link' ? ['url'] : type === 'group' ? ['label', 'background', 'backgroundStyle'] : [])]
  return Object.fromEntries(Object.entries(canvasNodeFields).filter(([key]) => keys.includes(key)))
}

export function applyCanvasOperation(data: CanvasData, raw: unknown): CanvasData {
  const operation = record(raw)
  const type = requiredString(operation.type)
  const allowedKeys = type === 'add-node' ? ['type', 'node'] : type === 'add-edge' ? ['type', 'edge'] : type.startsWith('update-') ? ['type', 'id', 'values'] : type === 'reorder-nodes' ? ['type', 'ids', 'to'] : ['type', 'ids']
  if (Object.keys(operation).some((key) => !allowedKeys.includes(key))) throw new Error('Unsupported canvas operation argument.')
  const id = typeof operation.id === 'string' ? operation.id : ''
  const ids = Array.isArray(operation.ids) && operation.ids.every((value) => typeof value === 'string') ? operation.ids as string[] : []
  const needNodes = (targets: string[]): void => { if (!targets.length || new Set(targets).size !== targets.length || targets.some((target) => !data.nodes.some((node) => node.id === target))) throw new Error('A targeted canvas card no longer exists.') }
  const needEdges = (targets: string[]): void => { if (!targets.length || targets.some((target) => !data.edges.some((edge) => edge.id === target))) throw new Error('A targeted connection no longer exists.') }
  switch (type) {
    case 'add-node': {
      const node = record(operation.node)
      const kind = requiredString(node.type)
      const { id: requestedId, type: _kind, ...rawValues } = node
      const values = checkFields(rawValues, fieldsForNode(kind))
      if (typeof values.x !== 'number' || typeof values.y !== 'number') throw new Error('Expected card coordinates.')
      const created = kind === 'text' ? createTextNode(values.x, values.y, typeof values.text === 'string' ? values.text : '') : kind === 'file' ? createFileNode(values.x, values.y, requiredString(values.file)) : kind === 'link' ? createLinkNode(values.x, values.y, requiredString(values.url)) : kind === 'group' ? createGroupNode(values.x, values.y, Number(values.width ?? 400), Number(values.height ?? 300), typeof values.label === 'string' ? values.label : undefined) : null
      if (!created) throw new Error('Unsupported canvas card type.')
      const next = { ...created, ...values, ...(requestedId === undefined ? {} : { id: requiredString(requestedId) }) } as CanvasNode
      if (data.nodes.some((entry) => entry.id === next.id)) throw new Error('The canvas card id already exists.')
      return addNode(data, next)
    }
    case 'update-node': needNodes([id]); return updateNode(data, id, checkFields(operation.values, fieldsForNode(data.nodes.find((node) => node.id === id)!.type)))
    case 'delete-nodes': needNodes(ids); return removeNodes(data, new Set(ids))
    case 'duplicate-nodes': needNodes(ids); return duplicateNodes(data, new Set(ids)).data
    case 'reorder-nodes': needNodes(ids); if (operation.to !== 'front' && operation.to !== 'back') throw new Error('Expected front or back order.'); return reorderNodes(data, new Set(ids), operation.to)
    case 'add-edge': {
      const edge = record(operation.edge)
      const { id: requestedId, ...rawValues } = edge
      const values = checkFields(rawValues, canvasEdgeFields)
      needNodes([requiredString(values.fromNode)]); needNodes([requiredString(values.toNode)])
      const edgeId = requestedId === undefined ? genId() : requiredString(requestedId)
      if (data.edges.some((entry) => entry.id === edgeId)) throw new Error('The connection id already exists.')
      return addEdge(data, { ...values, id: edgeId } as CanvasEdge)
    }
    case 'update-edge': {
      needEdges([id]); const values = checkFields(operation.values, canvasEdgeFields)
      for (const key of ['fromNode', 'toNode']) if (values[key] !== undefined) needNodes([requiredString(values[key])])
      return { ...data, edges: data.edges.map((edge) => edge.id === id ? { ...edge, ...values } : edge) }
    }
    case 'delete-edges': needEdges(ids); return removeEdges(data, new Set(ids))
    default: throw new Error('Unsupported canvas operation.')
  }
}


export const canvasSelectionActions = ['group-selection', 'align-left', 'align-center', 'align-right', 'align-top', 'align-middle', 'align-bottom', 'arrange-horizontal', 'arrange-vertical', 'arrange-grid', 'distribute-horizontal', 'distribute-vertical', 'justify-horizontal', 'justify-vertical', 'order-front', 'order-back', 'color-remove', 'background-remove', 'line-direction-none', 'line-direction-one', 'line-direction-both', 'background-style-cover', 'background-style-ratio', 'background-style-repeat'] as const
export function applyCanvasSelectionAction(data: CanvasData, action: string, nodeIds: string[], edgeId: string | null, zoom: number): { data: CanvasData; nodeIds: string[]; edgeId: string | null } {
  const ids = new Set(nodeIds)
  if (nodeIds.length > 512 || ids.size !== nodeIds.length || nodeIds.some(id => !data.nodes.some(node => node.id === id)) || edgeId && (!data.edges.some(edge => edge.id === edgeId) || nodeIds.length)) throw new Error('The exact Canvas selection changed.')
  const selected = data.nodes.filter(node => ids.has(node.id))
  const result = (next: CanvasData, selection = nodeIds) => ({ data: next, nodeIds: selection, edgeId })
  if (action === 'color-remove') {
    if (!edgeId && !selected.length) throw new Error('Select Canvas cards or a connection.')
    return result({ ...data, nodes: data.nodes.map(node => { if (!ids.has(node.id)) return node; const next = { ...node }; delete next.color; return next }), edges: data.edges.map(edge => { if (edge.id !== edgeId) return edge; const next = { ...edge }; delete next.color; return next }) })
  }
  if (action.startsWith('line-direction-')) {
    if (!edgeId) throw new Error('Select one Canvas connection.')
    const direction = action.slice(15)
    if (!['none', 'one', 'both'].includes(direction)) throw new Error('Unsupported Canvas line direction.')
    return result({ ...data, edges: data.edges.map(edge => edge.id === edgeId ? { ...edge, fromEnd: direction === 'both' ? 'arrow' : 'none', toEnd: direction === 'none' ? 'none' : 'arrow' } : edge) })
  }
  if (action === 'background-remove' || action.startsWith('background-style-')) {
    if (selected.length !== 1 || selected[0].type !== 'group' || !selected[0].background) throw new Error('Select one Canvas group with a background.')
    return result({ ...data, nodes: data.nodes.map(node => { if (node.id !== selected[0].id) return node; const next = { ...node } as CanvasNode & { background?: string; backgroundStyle?: string }; if (action === 'background-remove') { delete next.background; delete next.backgroundStyle } else { const style = action.slice(17); if (!['cover', 'ratio', 'repeat'].includes(style)) throw new Error('Unsupported Canvas background style.'); next.backgroundStyle = style } return next as CanvasNode }) })
  }
  if (edgeId || !selected.length) throw new Error('Select Canvas cards.')
  if (action === 'order-front' || action === 'order-back') return result(reorderNodes(data, ids, action === 'order-front' ? 'front' : 'back'))
  if (action === 'group-selection') {
    if (selected.length < 2) throw new Error('Select at least two Canvas cards.')
    const box = boundsOf(selected)!
    const group = createGroupNode(box.x - 20, box.y - 20, box.width + 40, box.height + 40)
    const at = Math.min(...selected.map(node => data.nodes.indexOf(node)))
    return result({ ...data, nodes: [...data.nodes.slice(0, at), group, ...data.nodes.slice(at)] }, [group.id])
  }
  let nodes: CanvasNode[] = selected.filter(node => node.type !== 'group')
  let box = boundsOf(nodes)
  if (selected.length === 1 && selected[0].type === 'group') {
    const group = selected[0]
    box = { x: group.x + 20, y: group.y + 20, width: group.width - 40, height: group.height - 40 }
    nodes = data.nodes.filter(node => node.id !== group.id && node.x >= group.x && node.y >= group.y && node.x + node.width <= group.x + group.width && node.y + node.height <= group.y + group.height)
  } else if (nodes.length < 2) throw new Error('Select at least two cards or one containing group.')
  if (!box || !nodes.length) throw new Error('The Canvas selection has no arrangement targets.')
  const moves = new Map<string, Partial<Rect>>()
  const kind = action.split('-')[0], mode = action.slice(kind.length + 1)
  if (kind === 'align' && ['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(mode)) {
    for (const node of nodes) moves.set(node.id, mode === 'left' ? { x: box.x } : mode === 'center' ? { x: box.x + (box.width - node.width) / 2 } : mode === 'right' ? { x: box.x + box.width - node.width } : mode === 'top' ? { y: box.y } : mode === 'middle' ? { y: box.y + (box.height - node.height) / 2 } : { y: box.y + box.height - node.height })
  } else if (kind === 'justify' && ['horizontal', 'vertical'].includes(mode)) {
    if (nodes.length < 2) throw new Error('Select at least two arrangement targets.')
    for (const node of nodes) moves.set(node.id, mode === 'horizontal' ? { x: box.x, width: box.width } : { y: box.y, height: box.height })
  } else if (kind === 'distribute' && ['horizontal', 'vertical'].includes(mode)) {
    if (nodes.length < 3) throw new Error('Select at least three arrangement targets.')
    const horizontal = mode === 'horizontal'
    const ordered = [...nodes].sort((a, b) => horizontal ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x)
    const total = ordered.reduce((sum, node) => sum + (horizontal ? node.width : node.height), 0)
    const space = ((horizontal ? box.width : box.height) - total) / (ordered.length - 1)
    let cursor = horizontal ? ordered[0].x + ordered[0].width + space : ordered[0].y + ordered[0].height + space
    for (const node of ordered.slice(1, -1)) { moves.set(node.id, horizontal ? { x: cursor } : { y: cursor }); cursor += (horizontal ? node.width : node.height) + space }
  } else if (kind === 'arrange' && ['horizontal', 'vertical', 'grid'].includes(mode)) {
    if (nodes.length < 2) throw new Error('Select at least two arrangement targets.')
    const rows: CanvasNode[][] = []
    let bottom = -Infinity
    for (const node of [...nodes].sort((a, b) => a.y - b.y)) { if (node.y < bottom && rows.length) { rows[rows.length - 1].push(node); bottom = Math.min(bottom, node.y + node.height) } else { rows.push([node]); bottom = node.y + node.height } }
    rows.forEach(row => row.sort((a, b) => a.x - b.x))
    const ordered = rows.flat(), gap = gridSpacing(zoom)
    if (mode === 'grid') {
      let y = box.y
      for (const row of rows) { let x = box.x, height = 0; for (const node of row) { moves.set(node.id, { x, y }); x += node.width + gap; height = Math.max(height, node.height) } y += height + gap }
    } else {
      let previous = ordered[0]
      for (const node of ordered.slice(1)) { moves.set(node.id, mode === 'horizontal' ? { x: (moves.get(previous.id)?.x ?? previous.x) + previous.width + gap, y: ordered[0].y } : { x: ordered[0].x, y: (moves.get(previous.id)?.y ?? previous.y) + previous.height + gap }); previous = node }
    }
  } else throw new Error('Unsupported Canvas selection action.')
  return result({ ...data, nodes: data.nodes.map(node => moves.has(node.id) ? { ...node, ...moves.get(node.id) } as CanvasNode : node) })
}
