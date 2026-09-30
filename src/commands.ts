import { guardedCreatedFileRevert, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { FileBaseline } from '@valley/plugin-sdk/types'
import { EMPTY_CANVAS, addNode, addEdge, createTextNode, createFileNode, createLinkNode, createGroupNode, duplicateNodes, genId, removeNodes, removeEdges, reorderNodes, updateNode, parseCanvasDocument, serializeCanvas, type CanvasData, type CanvasNode, type CanvasEdge } from './canvasModel'
import { isAllowedExternalUrl, normalizeRelPathOpt } from '@valley/plugin-sdk/paths'
import { canvasDraft, canvasSession } from './session'
import { captureCanvasOwner, type CanvasOwner } from './runtime'

/** Parent folder of the active file (or vault root when nothing is open). */
function activeFolder(api: ValleyPluginApi): string {
  const active = api.getState().activePath
  if (!active) return ''
  const slash = active.lastIndexOf('/')
  return slash > 0 ? active.slice(0, slash) : ''
}

/** Atomically create the first free `Untitled[.n].canvas` in `folder`. */
async function createCanvasFile(
  api: ValleyPluginApi,
  folder: string,
  owner: CanvasOwner,
  assertActive: () => void
): Promise<{ relPath: string; baseline: FileBaseline }> {
  const prefix = folder ? `${folder}/` : ''
  for (let n = 0; n < 1000; n++) {
    const name = n === 0 ? 'Untitled.canvas' : `Untitled ${n}.canvas`
    const relPath = `${prefix}${name}`
    assertActive()
    const written = await owner.run(() => { assertActive(); return api.vault.writeFileGuarded(relPath, EMPTY_CANVAS, null) })
    if (written.ok) return { relPath, baseline: written.baseline }
    assertActive()
    if (written.reason === 'error') throw new Error(`Could not create ${relPath}`)
  }
  throw new Error(`Could not find a free canvas name in ${folder || 'the vault root'}`)
}

/**
 * `canvas:create` — write an empty JSONCanvas next to the active file and open
 * it. Undo removes only the exact baseline created here; an edited file wins.
 */
export function registerCanvasCommands(api: ValleyPluginApi, owner = captureCanvasOwner(api)): () => void {
  let registered = true
  const assertActive = (): void => { owner.assertActive(); if (!registered) throw new Error('The canvas commands are no longer registered.') }
  const guardedVault = {
    ...api.vault,
    restoreTrashed: (...args: Parameters<typeof api.vault.restoreTrashed>) => owner.run(() => { assertActive(); return api.vault.restoreTrashed(...args) }),
    readFileBaseline: (path: string) => owner.run(() => { assertActive(); return api.vault.readFileBaseline(path) }),
    trashFileGuarded: (...args: Parameters<typeof api.vault.trashFileGuarded>) => owner.run(() => { assertActive(); return api.vault.trashFileGuarded(...args) }),
    writeFileGuarded: (...args: Parameters<typeof api.vault.writeFileGuarded>) => owner.run(() => { assertActive(); return api.vault.writeFileGuarded(...args) })
  }

  const offCreate = api.commands.register<{ folder?: string }, { relPath: string }, 'write'>({
    id: 'create',
    label: 'Canvas: Create new canvas', labelKey: 'auto.7b18787efddd',
    sideEffect: 'write',
    revision: ({ folder }) => { assertActive(); return { folder: folder ?? activeFolder(api) } },
    preview: ({ folder }) => { assertActive(); return { action: 'create-canvas', folder: folder ?? activeFolder(api) } },
    input: { schema: { type: 'object', properties: { folder: { type: 'string' } }, additionalProperties: false }, parse: (raw) => { const folder = (raw as { folder?: unknown } | undefined)?.folder; if (folder !== undefined && (typeof folder !== 'string' || (folder && normalizeRelPathOpt(folder) !== folder))) throw new Error('Expected a vault folder.'); return { folder: folder as string | undefined } } },
    run: async ({ folder }) => {
      assertActive()
      const { relPath, baseline } = await createCanvasFile(api, folder ?? activeFolder(api), owner, assertActive)
      if (registered && owner.isActive()) await owner.run(() => { assertActive(); return api.workspace.openFile(relPath) })
      return {
        value: { relPath },
        revert: guardedCreatedFileRevert(guardedVault, relPath, EMPTY_CANVAS, baseline, 'Create canvas')
      }
    }
  })
  const offGet = api.commands.register({ id: 'get', label: 'Canvas: Inspect canvas', labelKey: 'canvas.command.get', paletteSafe: false, sideEffect: 'read', input: { schema: objectSchema({ path: stringSchema }, ['path']), parse: (raw) => ({ path: requiredString(record(raw).path) }) }, run: async ({ path }) => { const target = await readCanvasTarget(api, path, owner, assertActive); return { path, data: target.data, revision: target.revision } } })
  const offEdit = api.commands.register({ id: 'edit', label: 'Canvas: Edit canvas', labelKey: 'canvas.command.edit', paletteSafe: false, sideEffect: 'write', input: { schema: objectSchema({ path: stringSchema, operation: canvasOperationSchema, expectedRevision: { type: 'string' } }, ['path', 'operation']), parse: (raw) => { const input = record(raw); if (input.expectedRevision !== undefined && typeof input.expectedRevision !== 'string') throw new Error('Expected a canvas revision.'); return { path: requiredString(input.path), operation: record(input.operation), expectedRevision: input.expectedRevision as string | undefined } } }, revision: async ({ path }) => (await readCanvasTarget(api, path, owner, assertActive)).revision, preview: ({ path, operation }) => ({ path, operation }), run: ({ path, operation, expectedRevision }) => editCanvasTarget(api, path, operation, expectedRevision, owner, assertActive) })
  return () => { registered = false; offCreate(); offGet(); offEdit() }

}

export const canvasNodeFields = { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 }, color: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, subpath: { type: 'string' }, url: { type: 'string' }, label: { type: 'string' }, background: { type: 'string' }, backgroundStyle: { type: 'string', enum: ['cover', 'ratio', 'repeat'] } }
export const canvasEdgeFields = { fromNode: { type: 'string' }, toNode: { type: 'string' }, fromSide: { type: 'string', enum: ['top', 'right', 'bottom', 'left'] }, toSide: { type: 'string', enum: ['top', 'right', 'bottom', 'left'] }, fromEnd: { type: 'string', enum: ['none', 'arrow'] }, toEnd: { type: 'string', enum: ['none', 'arrow'] }, color: { type: 'string' }, label: { type: 'string' } }
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const stringSchema = { type: 'string', minLength: 1 }
const idsSchema = { type: 'array', items: stringSchema, minItems: 1, uniqueItems: true }
export const canvasOperationSchema = { oneOf: [
  objectSchema({ type: { const: 'add-node' }, node: objectSchema({ id: stringSchema, type: { type: 'string', enum: ['text', 'file', 'link', 'group'] }, ...canvasNodeFields }, ['type', 'x', 'y']) }, ['type', 'node']),
  objectSchema({ type: { const: 'update-node' }, id: stringSchema, values: objectSchema(canvasNodeFields) }, ['type', 'id', 'values']),
  objectSchema({ type: { const: 'add-edge' }, edge: objectSchema({ id: stringSchema, ...canvasEdgeFields }, ['fromNode', 'toNode']) }, ['type', 'edge']),
  objectSchema({ type: { const: 'update-edge' }, id: stringSchema, values: objectSchema(canvasEdgeFields) }, ['type', 'id', 'values']),
  ...['delete-nodes', 'delete-edges', 'duplicate-nodes'].map((type) => objectSchema({ type: { const: type }, ids: idsSchema }, ['type', 'ids'])),
  objectSchema({ type: { const: 'reorder-nodes' }, ids: idsSchema, to: { type: 'string', enum: ['front', 'back'] } }, ['type', 'ids', 'to'])
] }

function record(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object.'); return raw as Record<string, unknown> }
function requiredString(raw: unknown): string { if (typeof raw !== 'string' || !raw.trim()) throw new Error('Expected a nonempty id or path.'); return raw }
function checkFields(raw: unknown, allowed: Record<string, unknown>): Record<string, unknown> {
  const values = record(raw)
  for (const [key, value] of Object.entries(values)) {
    if (!(key in allowed)) throw new Error(`Unsupported canvas field "${key}".`)
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

export async function readCanvasTarget(api: ValleyPluginApi, path: string, owner = captureCanvasOwner(api), assertActive = owner.assertActive) {
  assertActive()
  if (!path.endsWith('.canvas') || normalizeRelPathOpt(path) !== path) throw new Error('Expected a vault-relative canvas path.')
  const session = canvasSession(path, owner)
  if (session) { const snapshot = session.get(); if (!snapshot.ready) throw new Error('The canvas is still loading.'); if (snapshot.invalid) throw new Error('The canvas file is invalid.'); return { data: snapshot.data, revision: snapshot.revision, baseline: null, session } }
  if (canvasDraft(path, owner)) throw new Error('The canvas has an unsaved draft. Reopen it and resolve the save error before editing.')
  const recovery = await owner.run(() => { assertActive(); return api.vault.drafts.read(path, 'editor') })
  assertActive()
  if (recovery) throw new Error('The canvas has an unsaved draft. Reopen it and resolve the save error before editing.')
  const file = await owner.run(() => { assertActive(); return api.vault.readFileBaseline(path) })
  assertActive()
  if (canvasSession(path, owner) || canvasDraft(path, owner)) throw new Error('The canvas changed. Inspect its active draft before editing.')
  if (!file) throw new Error('The canvas file no longer exists.')
  const parsed = parseCanvasDocument(file.content)
  if (!parsed.valid) throw new Error('The canvas file is invalid.')
  const data = parsed.data
  return { data, revision: serializeCanvas(data), baseline: file.baseline, session: undefined }
}
async function commitTarget(owner: CanvasOwner, path: string, data: CanvasData, previous: Awaited<ReturnType<typeof readCanvasTarget>>, assertActive: () => void): Promise<void> {
  assertActive()
  if (canvasSession(path, owner) !== previous.session) throw new Error('The canvas changed. Inspect its active draft before editing.')
  if (previous.session) await owner.run(() => { assertActive(); return previous.session!.commit(data, previous.revision) })
  else {
    const result = await owner.run(() => {
      assertActive()
      if (canvasSession(path, owner) || canvasDraft(path, owner)) throw new Error('The canvas changed. Inspect its active draft before editing.')
      return owner.api.vault.writeFileGuarded(path, serializeCanvas(data), previous.baseline)
    })
    if (!result.ok) throw new Error('The canvas changed or could not be saved. Your request was not applied.')
  }
}
export async function restoreCanvasTarget(owner: CanvasOwner, path: string, data: CanvasData, revision: string, assertActive = owner.assertActive): Promise<void> {
  const captured = structuredClone(data)
  const current = await readCanvasTarget(owner.api, path, owner, assertActive)
  if (current.revision !== revision) throw new Error('The canvas changed after this edit. Undo would overwrite newer work.')
  await commitTarget(owner, path, captured, current, assertActive)
}
export async function editCanvasTarget(api: ValleyPluginApi, path: string, operation: unknown, expectedRevision?: string, owner = captureCanvasOwner(api), assertActive = owner.assertActive) {
  assertActive()
  const accepted = structuredClone(operation)
  const previous = await readCanvasTarget(api, path, owner, assertActive)
  if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw new Error('The canvas changed. Inspect it again before editing.')
  const before = structuredClone(previous.data)
  const next = applyCanvasOperation(before, accepted)
  const nextRevision = serializeCanvas(next)
  await commitTarget(owner, path, next, previous, assertActive)
  const after = structuredClone(next)
  return { value: { path, data: next, revision: nextRevision }, revert: { label: 'Edit canvas', run: () => restoreCanvasTarget(owner, path, before, nextRevision, assertActive), reapply: () => restoreCanvasTarget(owner, path, after, previous.revision, assertActive) } }
}
