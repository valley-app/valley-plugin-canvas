import { METADATA_PANEL_SEGMENT_V1, WORKSPACE_DETAILS_V1, provideBookmarkSurface, type MountedPluginView, type PluginInspectionSubject, type PluginProperty, type ValleyPluginApi, type WorkspaceDetailsProvider, type WorkspaceDetailsSnapshot } from '@valley/plugin-sdk'
import type { PluginLinkState } from '@valley/plugin-sdk/paths'
import { React, captureCanvasOwner, type CanvasOwner } from './runtime'
import { canvasSession, canvasMountedSession, findCanvasMountedSession, canvasInstanceSession, restoreCanvasView, subscribeCanvas, notifyCanvas } from './session'
import { canvasEdgeFields, canvasNodeFields, editCanvasTarget, readCanvasTarget } from './commands'
import { canvasDataSchema } from './automationContracts'
import { parseCanvasDocument, serializeCanvas, createTextNode, createLinkNode, genId, type CanvasData, type CanvasNode } from './canvasModel'
import { boundsOf } from './geometry'
import { normalizeRelPathOpt, isAllowedExternalUrl } from '@valley/plugin-sdk/paths'
import { uiText } from './localization'
import type { InteropValueSchema } from '@valley/plugin-sdk'
import { applyCanvasSelectionAction, canvasSelectionActions, objectSchema, record, requiredString } from './operations'
import { MIN_ZOOM, MAX_ZOOM } from './geometry'

const bookmarkStateSchema = {
  "type": "object",
  "properties": {
    "v": {
      "type": "literal",
      "value": 1
    },
    "path": {
      "type": "string"
    },
    "viewport": {
      "type": "object",
      "properties": {
        "x": {
          "type": "number"
        },
        "y": {
          "type": "number"
        },
        "zoom": {
          "type": "number"
        }
      },
      "required": [
        "x",
        "y",
        "zoom"
      ],
      "additionalProperties": false
    },
    "nodeIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 512
    },
    "edgeId": {
      "type": "union",
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "v",
    "path"
  ],
  "additionalProperties": false
} satisfies InteropValueSchema



function target(subject?: PluginInspectionSubject, fallback = '', owner = captureCanvasOwner(), mountedView = subject?.mountedView, requireExplicit = false) {
  const state = subject?.item?.state ?? subject?.view
  const path = mountedView?.filePath ?? (typeof state?.path === 'string' ? state.path : fallback)
  if (mountedView && typeof state?.path === 'string' && state.path !== path) throw new Error('The Canvas subject does not match its exact mounted view.')
  const current = mountedView ? canvasMountedSession(mountedView, owner).get() : requireExplicit ? undefined : canvasSession(path, owner)?.get()
  if (requireExplicit && !mountedView && !Array.isArray(state?.nodeIds) && typeof state?.edgeId !== 'string') throw new Error('Specify an exact mounted Canvas view or explicit card/connection ids.')
  const nodeIds = mountedView ? current?.nodeIds ?? [] : Array.isArray(state?.nodeIds) ? state.nodeIds.filter((id): id is string => typeof id === 'string') : current?.nodeIds ?? []
  const edgeId = mountedView ? current?.edgeId ?? null : typeof state?.edgeId === 'string' ? state.edgeId : current?.edgeId ?? null
  if (requireExplicit && mountedView && (Array.isArray(state?.nodeIds) && JSON.stringify(state.nodeIds) !== JSON.stringify(nodeIds) || state?.edgeId !== undefined && state.edgeId !== edgeId)) throw new Error('The exact Canvas selection changed. Inspect it again.')
  return { path, nodeIds, edgeId, mountedView }
}
function targetSession(selected: ReturnType<typeof target>, owner: CanvasOwner) { return selected.mountedView ? canvasMountedSession(selected.mountedView, owner) : canvasSession(selected.path, owner) }
function properties(data: CanvasData, nodeIds: string[], edgeId: string | null, readOnly = false): PluginProperty[] {
  const entry = edgeId ? data.edges.find((edge) => edge.id === edgeId) : nodeIds.length === 1 ? data.nodes.find((node) => node.id === nodeIds[0]) : undefined
  if (!entry) return [
    { id: 'cards', label: uiText('canvas.property.cards'), value: data.nodes.length, readOnly: true },
    { id: 'connections', label: uiText('canvas.property.connections'), value: data.edges.length, readOnly: true },
    { id: 'selected', label: uiText('canvas.property.selected'), value: nodeIds.length, readOnly: true }
  ]
  const editable = edgeId ? canvasEdgeFields : canvasNodeFields
  return Object.entries(entry).filter(([id]) => id === 'id' || id === 'type' || id in editable).map(([id, value]) => ({ id, label: uiText(`canvas.field.${id}`), value: JSON.parse(JSON.stringify(value ?? null)), readOnly: readOnly || !(id in editable), type: typeof value === 'number' ? 'number' : typeof value === 'string' ? 'text' : 'json' }))
}
function parseView(raw: PluginLinkState) {
  if (raw.v !== 1 || typeof raw.path !== 'string' || !raw.path.endsWith('.canvas')) throw new Error('Unsupported Canvas bookmark.')
  if (raw.nodeIds !== undefined && (!Array.isArray(raw.nodeIds) || raw.nodeIds.some((id) => typeof id !== 'string'))) throw new Error('Expected canvas card ids.')
  if (raw.edgeId !== undefined && raw.edgeId !== null && typeof raw.edgeId !== 'string') throw new Error('Expected a canvas connection id.')
  const nodeIds = Array.isArray(raw.nodeIds) ? raw.nodeIds.filter((id): id is string => typeof id === 'string') : []
  const edgeId = typeof raw.edgeId === 'string' && raw.edgeId ? raw.edgeId : null
  const value = raw.viewport as { x?: unknown; y?: unknown; zoom?: unknown } | undefined
  if (value && (typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y) || typeof value.zoom !== 'number' || !Number.isFinite(value.zoom) || value.zoom <= 0)) throw new Error('Invalid canvas viewport.')
  const viewport = value && typeof value.x === 'number' && Number.isFinite(value.x) && typeof value.y === 'number' && Number.isFinite(value.y) && typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom > 0 ? { x: value.x, y: value.y, zoom: Math.max(0.05, Math.min(8, value.zoom)) } : undefined
  return { path: raw.path, nodeIds, edgeId, viewport }
}
type PropertyEditorProps = { subject?: PluginInspectionSubject; path: string; owner: CanvasOwner; assertActive: () => void; mountedView?: MountedPluginView }
function PropertyEditor(props: PropertyEditorProps): React.ReactElement {
  const view = props.mountedView ?? props.subject?.mountedView
  const subscribe = React.useCallback((listener: () => void) => subscribeCanvas(listener, props.owner), [props.owner])
  const current = React.useCallback(() => props.owner.isActive() && (!view || findCanvasMountedSession(view, props.owner) !== undefined), [props.owner, view])
  const available = React.useSyncExternalStore(subscribe, current, current)
  return available ? <PropertyEditorContent {...props} /> : <div className="right-panel-body props-info"><p role="status">{uiText('canvas.error.viewUnavailable')}</p></div>
}
function PropertyEditorContent({ subject, path: fallback, owner, assertActive, mountedView }: PropertyEditorProps): React.ReactElement {
  const selected = target(subject, fallback, owner, mountedView)
  const [rows, setRows] = React.useState<PluginProperty[]>([])
  const [error, setError] = React.useState('')
  const [revision, setRevision] = React.useState('')
  const nodeIdsJson = JSON.stringify(selected.nodeIds)
  const context = React.useMemo(() => ({ active: true, revision: 0 }), [owner, selected.path, selected.edgeId, nodeIdsJson, selected.mountedView?.mountId, selected.mountedView?.generation])
  const latest = React.useRef(context)
  latest.current = context
  const isActive = React.useCallback(() => context.active && latest.current === context && owner.isActive(), [context, owner])
  const refresh = React.useCallback(() => {
    if (!isActive()) return
    const request = ++context.revision
    void readCanvasTarget(owner.api, selected.path, owner, assertActive).then((value) => {
      if (!isActive() || request !== context.revision) return
      const state = targetSession(selected, owner)?.get()
      const readOnly = state ? (state.locked ?? state.readOnly) || state.invalid === true || !state.ready : false
      setRevision(value.revision); setRows(properties(value.data, JSON.parse(nodeIdsJson) as string[], selected.edgeId, readOnly)); setError('')
    }).catch((reason) => { if (isActive() && request === context.revision) setError(String(reason)) })
  }, [owner, assertActive, selected.path, selected.edgeId, nodeIdsJson, context, isActive])
  React.useEffect(() => { context.active = true; refresh(); const off = subscribeCanvas(refresh, owner); return () => { context.active = false; off() } }, [refresh, context, owner])
  return <div className="right-panel-body props-info">
    {error && <p role="alert">{error}</p>}
    <dl className="props-info-table">{rows.map((row) => <div className="props-info-row" key={`${selected.path}:${selected.edgeId ?? selected.nodeIds.join(',')}:${row.id}`}><dt className="props-info-key">{row.label}</dt><dd className="props-info-value">{row.readOnly || !['x', 'y', 'width', 'height', 'color', 'label', 'fromEnd', 'toEnd'].includes(row.id) ? typeof row.value === 'object' ? JSON.stringify(row.value) : String(row.value ?? '') : <CanvasPropertyInput row={row} selected={selected} revision={revision} refresh={refresh} owner={owner} assertActive={assertActive} isParentActive={isActive} />}</dd></div>)}</dl>
  </div>
}

interface RawPropertyInput { mountedView: MountedPluginView; nodeIds: string[]; edgeId: string | null; field: string; expectedDraftRevision: string; value: string }
interface PropertyForm {
  revision(): string
  read(): { value: string; dirty: boolean; busy: boolean; error: string; documentRevision: string }
  patch(value: string): void
  apply(): Promise<void>
  discard(): void
  active(): boolean
}
const propertyForms = new WeakMap<CanvasOwner, Map<string, PropertyForm>>()
function forms(owner: CanvasOwner): Map<string, PropertyForm> { let value = propertyForms.get(owner); if (!value) { value = new Map(); propertyForms.set(owner, value) } return value }
const formKey = (view: MountedPluginView, nodeIds: string[], edgeId: string | null, field: string) => `${view.filePath}:${view.mountId}:${view.generation}:${edgeId ?? nodeIds.join(',')}:${field}`
interface PropertyDraft { value: string; revision: string; error: string; busy: boolean; mountedView?: MountedPluginView; field?: string }
const propertyStates = new WeakMap<CanvasOwner, Map<string, PropertyDraft>>()
function propertyDrafts(owner: CanvasOwner): Map<string, PropertyDraft> {
  const current = propertyStates.get(owner)
  if (current) return current
  const retained = owner.get<{ owner: CanvasOwner; drafts: Map<string, PropertyDraft> }>('canvas.propertyState', () => ({ owner, drafts: new Map() }))
  const drafts = retained.owner === owner ? retained.drafts : retained.owner.root === owner.root ? new Map([...retained.drafts].map(([key, value]) => [key, { ...value, busy: false }])) : new Map<string, PropertyDraft>()
  retained.owner = owner; retained.drafts = drafts
  propertyStates.set(owner, drafts)
  return drafts
}
function CanvasPropertyInput({ row, selected, revision, refresh, owner, assertActive, isParentActive }: { row: PluginProperty; selected: ReturnType<typeof target>; revision: string; refresh: () => void; owner: CanvasOwner; assertActive: () => void; isParentActive: () => boolean }): React.ReactElement {
  const field = `${selected.path}:${selected.edgeId ?? selected.nodeIds.join(',')}:${row.id}`
  const key = selected.mountedView ? formKey(selected.mountedView, selected.nodeIds, selected.edgeId, row.id) : `${selected.path}:legacy:0:${selected.edgeId ?? selected.nodeIds.join(',')}:${row.id}`
  const drafts = React.useMemo(() => propertyDrafts(owner), [owner])
  React.useMemo(() => {
    if (!selected.mountedView || drafts.has(key)) return
    const retained = [...drafts].find(([, draft]) => draft.field === field && draft.mountedView && (['area', 'paneId', 'tabId', 'filePath', 'pluginId'] as const).every(part => draft.mountedView![part] === selected.mountedView![part]) && !findCanvasMountedSession(draft.mountedView, owner))
    if (retained) { drafts.delete(retained[0]); drafts.set(key, { ...retained[1], busy: false, mountedView: selected.mountedView }) }
  }, [drafts, key, field, owner, selected.mountedView?.mountId, selected.mountedView?.generation])
  const context = React.useMemo<{ active: boolean; release?: () => void; sequence: number; signature: string; form?: PropertyForm }>(() => ({ active: true, sequence: 0, signature: '' }), [owner, key, selected.mountedView?.mountId, selected.mountedView?.generation])
  const release = (): void => { context.release?.(); context.release = undefined }
  const hold = (): void => { if (!context.release && context.active && isParentActive() && selected.mountedView && !canvasMountedSession(selected.mountedView, owner).frozen?.()) context.release = canvasMountedSession(selected.mountedView, owner).holdControls?.() }
  React.useEffect(() => { context.active = true; return () => { context.active = false; context.release?.(); context.release = undefined } }, [context])
  const read = React.useCallback(() => drafts.get(key), [drafts, key])
  const subscribe = React.useCallback((listener: () => void) => subscribeCanvas(listener, owner), [owner])
  const draft = React.useSyncExternalStore(subscribe, read, read)
  React.useEffect(() => {
    if (draft && selected.mountedView) findCanvasMountedSession(selected.mountedView, owner)?.draftChanged?.(key, true)
  }, [owner, key, selected.mountedView?.mountId, selected.mountedView?.generation])
  const value = draft?.value ?? String(row.value ?? '')
  const update = (next: PropertyDraft | undefined): void => {
    const session = selected.mountedView ? findCanvasMountedSession(selected.mountedView, owner) : canvasSession(selected.path, owner)
    if (session?.frozen?.()) throw new Error('The Canvas draft is prepared for another operation.')
    session?.draftChanged?.(key, Boolean(next))
    if (next) { next.mountedView = selected.mountedView; next.field = field; drafts.set(key, next) } else drafts.delete(key)
    notifyCanvas(owner)
  }
  const save = async (): Promise<void> => {
    if (!context.active || !isParentActive() || !draft || draft.busy) return
    if (draft.value === String(row.value ?? '')) { update(undefined); return }
    const busy = { ...draft, busy: true }
    try {
      assertActive()
      update(busy)
      const result = await owner.api.commands.executeOwn('properties-edit', { subject: { pluginId: owner.api.pluginId, surface: 'main_workspace', view: { path: selected.path, nodeIds: selected.nodeIds, edgeId: selected.edgeId }, ...(selected.mountedView ? { mountedView: selected.mountedView } : {}) }, values: { [row.id]: row.type === 'number' ? Number(draft.value) : draft.value }, expectedRevision: draft.revision })
      assertActive()
      if (!result.ok) throw new Error(result.error.message)
      if (drafts.get(key) === busy) update(undefined)
      if (context.active && isParentActive()) refresh()
    } catch (reason) { if (drafts.get(key) === busy) update({ ...draft, busy: false, error: `${uiText('canvas.error.save')} ${String(reason)}` }) }
  }
  const snapshot = (): ReturnType<PropertyForm['read']> => { const current = drafts.get(key); return { value: current?.value ?? String(row.value ?? ''), dirty: Boolean(current), busy: current?.busy ?? false, error: current?.error ?? '', documentRevision: current?.revision ?? revision } }
  const form = context.form ??= { revision: () => '', read: snapshot, patch: () => {}, apply: save, discard: () => {}, active: () => false }
  form.read = snapshot
  form.revision = () => { const signature = JSON.stringify([snapshot(), row.value, row.readOnly, isParentActive()]); if (signature !== context.signature) { context.signature = signature; context.sequence++ } return `canvas-property:${selected.mountedView?.mountId}:${selected.mountedView?.generation}:${context.sequence}` }
  form.active = () => context.active && isParentActive() && selected.mountedView !== undefined && findCanvasMountedSession(selected.mountedView, owner) !== undefined && !row.readOnly
  form.patch = next => { assertActive(); hold(); update({ value: next, revision: drafts.get(key)?.revision ?? revision, error: '', busy: false }) }
  form.apply = save
  form.discard = () => { update(undefined); release() }
  React.useEffect(() => { if (!selected.mountedView) return; forms(owner).set(key, form); return () => { if (forms(owner).get(key) === form) forms(owner).delete(key) } }, [owner, key, form])
  return <span><input className="canvas-property-input" aria-label={row.label} type={row.type === 'number' ? 'number' : 'text'} value={value} disabled={draft?.busy} onFocus={hold} onChange={(event) => { if (context.active && isParentActive() && !targetSession(selected, owner)?.frozen?.()) { assertActive(); hold(); update({ value: event.currentTarget.value, revision: draft?.revision ?? revision, error: '', busy: false }) } }} onBlur={() => void save().finally(release)} />{draft?.error && <span role="alert">{draft.error}</span>}</span>
}

export function registerCanvasSurfaces(pluginApi: ValleyPluginApi, owner = captureCanvasOwner(pluginApi)): () => void {
  let registered = true
  const assertActive = (): void => { owner.assertActive(); if (!registered) throw new Error('The canvas surfaces are no longer registered.') }
  const boundedId = { type: 'string', minLength: 1, maxLength: 256 }
  const mountedSchema = { type: 'object', properties: { mountId: boundedId, generation: { type: 'integer', minimum: 0 }, area: { type: 'string', enum: ['main', 'right'] }, paneId: boundedId, tabId: boundedId, filePath: { type: 'string', minLength: 1, maxLength: 4096 }, pluginId: { const: pluginApi.pluginId } }, required: ['mountId', 'generation', 'area', 'paneId', 'tabId', 'filePath', 'pluginId'], additionalProperties: false }
  const selectionSchema = { type: 'object', properties: { v: { const: 1 }, path: { type: 'string', minLength: 1, maxLength: 4096 }, nodeIds: { type: 'array', items: boundedId, maxItems: 512, uniqueItems: true }, edgeId: { type: ['string', 'null'], maxLength: 256 }, viewport: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, zoom: { type: 'number', minimum: MIN_ZOOM, maximum: MAX_ZOOM } }, required: ['x', 'y', 'zoom'], additionalProperties: false } }, required: ['path'], additionalProperties: false }
  const subjectSchema = { type: 'object', properties: { pluginId: { const: pluginApi.pluginId }, surface: { const: 'main_workspace' }, instanceId: boundedId, mountedView: mountedSchema, view: selectionSchema, item: { type: 'object', properties: { id: boundedId, title: { type: 'string', maxLength: 1024 }, state: selectionSchema }, required: ['id', 'title', 'state'], additionalProperties: false } }, required: ['pluginId', 'surface', 'view'], additionalProperties: false }
  const boundedRevision = { type: 'string', minLength: 1, maxLength: 1048576 }
  const explicitSelection = { nodeIds: { type: 'array', items: boundedId, maxItems: 512, uniqueItems: true }, edgeId: { type: ['string', 'null'], maxLength: 256 } }
  const viewportSchema = selectionSchema.properties.viewport
  const viewOutput = objectSchema({ path: { type: 'string' }, revision: boundedRevision, viewRevision: boundedRevision, ...explicitSelection, viewport: viewportSchema, locked: { type: 'boolean' }, history: objectSchema({ revision: boundedRevision, undo: { type: 'integer', minimum: 0 }, redo: { type: 'integer', minimum: 0 } }, ['revision', 'undo', 'redo']) }, ['path', 'revision', 'viewRevision', 'nodeIds', 'edgeId', 'viewport', 'locked', 'history'])
  const inspectView = (view: MountedPluginView) => {
    assertActive()
    const session = canvasMountedSession(view, owner), state = session.get()
    if (!state.ready || !state.viewRevision || !session.history) throw Object.assign(new Error('The Canvas view is not ready.'), { code: 'VIEWER_UNAVAILABLE', outcome: 'not-applied' })
    return { path: view.filePath, revision: state.revision, viewRevision: state.viewRevision, nodeIds: state.nodeIds, edgeId: state.edgeId, viewport: state.viewport, locked: state.locked ?? state.readOnly, history: session.history() }
  }
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 512 || value.some(id => typeof id !== 'string' || !id.length || id.length > 256) || new Set(value).size !== value.length) throw new Error('Expected bounded unique Canvas card ids.')
    return value as string[]
  }
  const edge = (value: unknown): string | null => { if (value === null) return null; if (typeof value !== 'string' || !value.length || value.length > 256) throw new Error('Expected a Canvas connection id or null.'); return value }
  const parseMounted = (raw: unknown): MountedPluginView => {
    const value = record(raw)
    if (Object.keys(value).some(key => !Object.hasOwn(mountedSchema.properties, key)) || value.pluginId !== pluginApi.pluginId || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0 || !['main', 'right'].includes(String(value.area)) || ['mountId', 'paneId', 'tabId'].some(key => typeof value[key] !== 'string' || !String(value[key]).length || String(value[key]).length > 256) || typeof value.filePath !== 'string' || value.filePath.length > 4096) throw new Error('Expected an exact Canvas mount.')
    const view = value as unknown as MountedPluginView
    canvasMountedSession(view, owner)
    return view
  }
  const exactInput = { mountedView: mountedSchema, expectedViewRevision: boundedRevision, expectedRevision: boundedRevision, ...explicitSelection }
  const actionOffs = [pluginApi.commands.register({ id: 'view-inspect', label: 'Canvas: Inspect exact view', paletteSafe: false, sideEffect: 'read', recovery: 'observational', idempotent: true, input: { schema: objectSchema({ mountedView: mountedSchema }, ['mountedView']), parse: raw => { const value = record(raw); if (Object.keys(value).some(key => key !== 'mountedView')) throw new Error('Unsupported Canvas inspection argument.'); return { mountedView: parseMounted(value.mountedView) } } }, outputSchema: viewOutput, run: ({ mountedView }) => inspectView(mountedView) })]
  const fileRevision = (baseline: { hash: string; size: number; mtimeMs: number }) => `canvas:file:${baseline.hash}:${baseline.size}:${baseline.mtimeMs}`
  const baseNames = (content: string): string[] => { const names: string[] = []; let inViews = false; for (const line of content.split('\n')) { if (/^views\s*:/.test(line)) { inViews = true; continue } if (inViews && /^\S/.test(line)) break; const match = inViews ? /^\s*(?:-\s*)?name\s*:\s*(.+?)\s*$/.exec(line) : null; if (match) names.push(match[1].replace(/^(['"])(.*)\1$/, '$2')) } if (names.length > 100 || names.some(name => name.length > 256)) throw new Error('Base view names exceed the automation limit.'); return names }
  const destinations = new Map<string, string>()
  actionOffs.push(pluginApi.commands.register({ id: 'convert-text-to-note-observe', label: 'Canvas: Observe note destination', paletteSafe: false, sideEffect: 'read', recovery: 'observational', idempotent: true, input: { schema: objectSchema({ destination: { type: 'string', minLength: 1, maxLength: 4096 } }, ['destination']), parse: raw => { const input = record(raw), destination = requiredString(input.destination); if (Object.keys(input).some(key => key !== 'destination') || !destination.endsWith('.md') || normalizeRelPathOpt(destination) !== destination) throw new Error('Expected a vault-relative note destination.'); return { destination } } }, outputSchema: objectSchema({ destination: { type: 'string' }, revision: boundedRevision }, ['destination', 'revision']), run: async ({ destination }) => { assertActive(); const file = await pluginApi.vault.readFileBaseline(destination); assertActive(); if (file?.baseline) throw Object.assign(new Error('The note destination is occupied.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }); if (destinations.size >= 100) destinations.delete(destinations.keys().next().value!); const revision = `canvas-note-absent:${Date.now()}:${Math.random().toString(36).slice(2)}`; destinations.set(destination, revision); return { destination, revision } } }))
  actionOffs.push(pluginApi.commands.register({ id: 'base-view-inspect', label: 'Canvas: Inspect referenced Base views', paletteSafe: false, sideEffect: 'read', recovery: 'observational', idempotent: true, input: { schema: objectSchema({ mountedView: mountedSchema }, ['mountedView']), parse: raw => ({ mountedView: parseMounted(record(raw).mountedView) }) }, outputSchema: objectSchema({ path: { type: 'string' }, revision: boundedRevision, names: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 256 } } }, ['path', 'revision', 'names']), run: async ({ mountedView }) => { const session = canvasMountedSession(mountedView, owner), current = session.get(), node = current.data.nodes.find(node => current.nodeIds.length === 1 && node.id === current.nodeIds[0]); if (!node || node.type !== 'file' || !node.file.endsWith('.base')) throw new Error('Select one Base card.'); const file = await pluginApi.vault.readFileBaseline(node.file); assertActive(); if (canvasMountedSession(mountedView, owner) !== session || session.get().viewRevision !== current.viewRevision || !file?.baseline) throw Object.assign(new Error('The Canvas or Base changed.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }); return { path: node.file, revision: fileRevision(file.baseline!), names: baseNames(file.content) } } }))
  const actionIds = [...canvasSelectionActions, 'selection-set', 'selection-all', 'viewport-set', 'history-undo', 'history-redo', 'clipboard-copy', 'clipboard-cut', 'clipboard-paste', 'base-view-default', 'base-view-select', 'convert-text-to-note']
  for (const action of actionIds) {
    const extra = action === 'clipboard-paste' ? { at: objectSchema({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']) } : action.startsWith('base-view-') ? { expectedBaseRevision: boundedRevision, ...(action === 'base-view-select' ? { name: { type: 'string', minLength: 1, maxLength: 256 } } : {}) } : action === 'convert-text-to-note' ? { destination: { type: 'string', minLength: 1, maxLength: 4096 }, expectedDestinationRevision: boundedRevision } : action === 'selection-set' ? { targetNodeIds: explicitSelection.nodeIds, targetEdgeId: explicitSelection.edgeId } : action === 'viewport-set' ? { viewport: viewportSchema } : action.startsWith('history-') ? { expectedHistoryRevision: boundedRevision } : {}
    const required = [...Object.keys(exactInput), ...Object.keys(extra)]
    actionOffs.push(pluginApi.commands.register({ id: action, label: `Canvas: ${action}`, paletteSafe: false, sideEffect: 'write', recovery: 'non-replayable', idempotent: false, limits: { operations: 1 }, revisionRequirements: [{ argument: 'expectedViewRevision', inspectionCommand: 'canvas:view-inspect', description: 'Use the current revision of this exact mounted Canvas view.' }, { argument: 'expectedRevision', inspectionCommand: 'canvas:view-inspect', description: 'Use the current Canvas document revision.' }, ...(action.startsWith('base-view-') ? [{ argument: 'expectedBaseRevision', inspectionCommand: 'canvas:base-view-inspect', description: 'Use the current revision of the exact referenced Base file.' }] : []), ...(action === 'convert-text-to-note' ? [{ argument: 'expectedDestinationRevision', inspectionCommand: 'canvas:convert-text-to-note-observe', description: 'Use the observed absence revision for this note destination.' }] : []), ...(action.startsWith('history-') ? [{ argument: 'expectedHistoryRevision', inspectionCommand: 'canvas:view-inspect', description: 'Use the current exact Canvas history cursor revision.' }] : [])],
      input: { schema: objectSchema({ ...exactInput, ...extra }, required), parse: raw => {
        const input = record(raw)
        if (Object.keys(input).some(key => !required.includes(key))) throw new Error('Unsupported Canvas action argument.')
        const mountedView = parseMounted(input.mountedView)
        const result = { ...input, at: input.at, expectedBaseRevision: input.expectedBaseRevision, name: input.name, destination: input.destination, expectedDestinationRevision: input.expectedDestinationRevision, targetNodeIds: input.targetNodeIds, targetEdgeId: input.targetEdgeId, viewport: input.viewport, expectedHistoryRevision: input.expectedHistoryRevision, mountedView, nodeIds: ids(input.nodeIds), edgeId: edge(input.edgeId), expectedViewRevision: requiredString(input.expectedViewRevision), expectedRevision: requiredString(input.expectedRevision) }
        if (action === 'selection-set') { ids(input.targetNodeIds); edge(input.targetEdgeId); if (input.targetEdgeId && (input.targetNodeIds as string[]).length) throw new Error('Select cards or a connection.') }
        if (action === 'viewport-set') { const value = record(input.viewport); if (Object.keys(value).sort().join(',') !== 'x,y,zoom' || ['x', 'y', 'zoom'].some(key => typeof value[key] !== 'number' || !Number.isFinite(value[key])) || Number(value.zoom) < MIN_ZOOM || Number(value.zoom) > MAX_ZOOM) throw new Error('Invalid Canvas viewport.') }
        if (action.startsWith('history-')) requiredString(input.expectedHistoryRevision)
        if (action === 'clipboard-paste') { const at = record(input.at); if (Object.keys(at).sort().join(',') !== 'x,y' || typeof at.x !== 'number' || !Number.isFinite(at.x) || typeof at.y !== 'number' || !Number.isFinite(at.y)) throw new Error('Expected a Canvas paste position.') }
        if (action.startsWith('base-view-')) { requiredString(input.expectedBaseRevision); if (action === 'base-view-select') { const name = requiredString(input.name); if (name.length > 256) throw new Error('Expected a bounded Base view name.') } }
        if (action === 'convert-text-to-note') { const destination = requiredString(input.destination); if (!destination.endsWith('.md') || normalizeRelPathOpt(destination) !== destination || destination.length > 4096) throw new Error('Expected a vault-relative note destination.'); requiredString(input.expectedDestinationRevision) }
        return result
      } }, outputSchema: viewOutput, revision: ({ mountedView }) => inspectView(mountedView), preview: input => ({ action, mountedView: input.mountedView, nodeIds: input.nodeIds, edgeId: input.edgeId }), run: async (input, context) => {
        const session = canvasMountedSession(input.mountedView, owner), original = session.get()
        const assertCurrent = (initial = false): void => {
          assertActive()
          if (context.cancellation?.aborted) throw Object.assign(new Error('Canvas operation cancelled.'), { code: 'CANCELLED', outcome: 'not-applied' })
          if (canvasMountedSession(input.mountedView, owner) !== session) throw Object.assign(new Error('The Canvas owner changed.'), { code: 'OWNER_UNAVAILABLE', outcome: 'not-applied' })
          const current = session.get()
          if (!current.ready || current.invalid || current.revision !== input.expectedRevision || JSON.stringify(current.nodeIds) !== JSON.stringify(input.nodeIds) || current.edgeId !== input.edgeId || JSON.stringify(current.viewport) !== JSON.stringify(original.viewport) || current.locked !== original.locked || initial && (current.viewRevision !== input.expectedViewRevision || current.controlsBlocked)) throw Object.assign(new Error('The exact Canvas view or document changed.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
          if (!['selection-set', 'selection-all', 'viewport-set', 'clipboard-copy'].includes(action) && current.locked) throw Object.assign(new Error('The Canvas is locked.'), { code: 'READ_ONLY', outcome: 'not-applied' })
        }
        const authorize = async (): Promise<void> => { if (context.validateBeforeRun && !await context.validateBeforeRun()) throw Object.assign(new Error('Canvas authorization changed.'), { code: 'DENIED', outcome: 'not-applied' }); assertCurrent() }
        assertCurrent(true)
        await authorize(); assertCurrent(true)
        if (action === 'selection-set' || action === 'selection-all' || action === 'viewport-set') {
          const selection = action === 'selection-all' ? original.data.nodes.map(node => node.id) : action === 'selection-set' ? ids(input.targetNodeIds) : original.nodeIds
          const edgeId = action === 'selection-set' ? edge(input.targetEdgeId) : action === 'selection-all' ? null : original.edgeId
          if (selection.some(id => !original.data.nodes.some(node => node.id === id)) || edgeId && !original.data.edges.some(edge => edge.id === edgeId)) throw Object.assign(new Error('The Canvas selection target is unavailable.'), { code: 'CANVAS_TARGET_NOT_FOUND', outcome: 'not-applied' })
          session.restore({ nodeIds: selection, edgeId, ...(action === 'viewport-set' ? { viewport: input.viewport as { x: number; y: number; zoom: number } } : {}) })
          return { value: inspectView(input.mountedView), revert: null }
        }
        if (action.startsWith('clipboard-')) {
          if (!navigator.clipboard) throw Object.assign(new Error('The native clipboard is unavailable.'), { code: 'CLIPBOARD_UNAVAILABLE', outcome: 'not-applied' })
          if (action === 'clipboard-paste') {
            const text = await navigator.clipboard.readText()
            assertCurrent(true)
            if (new TextEncoder().encode(text).byteLength > 512 * 1024) throw Object.assign(new Error('Canvas clipboard content exceeds 512 KiB.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
            if (!text.trim()) throw Object.assign(new Error('The clipboard has no Canvas content.'), { code: 'CLIPBOARD_EMPTY', outcome: 'not-applied' })
            const at = input.at as { x: number; y: number }, parsed = text.trim().startsWith('{') ? parseCanvasDocument(text) : null
            let nodes: CanvasNode[], edges: CanvasData['edges'] = []
            if (parsed?.valid && parsed.data.nodes.length) {
              const fragment = parsed.data, box = boundsOf(fragment.nodes)!, remap = new Map(fragment.nodes.map(node => [node.id, genId()]))
              const dx = at.x - box.x - box.width / 2, dy = at.y - box.y - box.height / 2
              nodes = fragment.nodes.map(node => ({ ...node, id: remap.get(node.id)!, x: node.x + dx, y: node.y + dy }))
              edges = fragment.edges.filter(edge => remap.has(edge.fromNode) && remap.has(edge.toNode)).map(edge => ({ ...edge, id: genId(), fromNode: remap.get(edge.fromNode)!, toNode: remap.get(edge.toNode)! }))
            } else nodes = [/^https?:\/\/\S+$/i.test(text.trim()) && isAllowedExternalUrl(text.trim()) ? createLinkNode(at.x, at.y, text.trim()) : createTextNode(at.x, at.y, text.trim())]
            if (nodes.length > 512) throw Object.assign(new Error('Canvas paste exceeds 512 cards.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
            const next = { ...original.data, nodes: [...original.data.nodes, ...nodes], edges: [...original.data.edges, ...edges] }
            if (new TextEncoder().encode(serializeCanvas(next)).byteLength > 512 * 1024) throw Object.assign(new Error('The resulting Canvas exceeds 512 KiB.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
            await session.commit(next, input.expectedRevision, authorize, assertCurrent)
            session.recordHistory?.(original.data, next); session.restore({ nodeIds: nodes.map(node => node.id), edgeId: null })
          } else {
            if (!input.nodeIds.length || input.edgeId) throw Object.assign(new Error('Select Canvas cards to copy.'), { code: 'INVALID_SELECTION', outcome: 'not-applied' })
            const selection = new Set(input.nodeIds), content = serializeCanvas({ nodes: original.data.nodes.filter(node => selection.has(node.id)), edges: original.data.edges.filter(edge => selection.has(edge.fromNode) && selection.has(edge.toNode)) })
            if (new TextEncoder().encode(content).byteLength > 512 * 1024) throw Object.assign(new Error('Canvas clipboard content exceeds 512 KiB.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
            await navigator.clipboard.writeText(content)
            try {
              assertCurrent(true)
              if (action === 'clipboard-cut') {
                const next = { ...original.data, nodes: original.data.nodes.filter(node => !selection.has(node.id)), edges: original.data.edges.filter(edge => !selection.has(edge.fromNode) && !selection.has(edge.toNode)) }
                await session.commit(next, input.expectedRevision, authorize, assertCurrent)
                session.recordHistory?.(original.data, next); session.restore({ nodeIds: [], edgeId: null })
              }
            } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'unknown', outcomeUnknown: true, retryable: false }) }
          }
          try { return { value: inspectView(input.mountedView), revert: null } } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'unknown', outcomeUnknown: true }) }
        }
        if (action.startsWith('base-view-')) {
          const node = original.data.nodes.find(node => input.nodeIds.length === 1 && node.id === input.nodeIds[0])
          if (!node || node.type !== 'file' || !node.file.endsWith('.base')) throw Object.assign(new Error('Select one Base card.'), { code: 'INVALID_SELECTION', outcome: 'not-applied' })
          const observe = async () => { const file = await pluginApi.vault.readFileBaseline(node.file); assertCurrent(); if (!file?.baseline || fileRevision(file.baseline) !== input.expectedBaseRevision) throw Object.assign(new Error('The referenced Base changed.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }); if (action === 'base-view-select' && !baseNames(file.content).includes(requiredString(input.name))) throw Object.assign(new Error('The selected Base view no longer exists.'), { code: 'TARGET_NOT_FOUND', outcome: 'not-applied' }) }
          await observe()
          const next = { ...original.data, nodes: original.data.nodes.map(entry => { if (entry.id !== node.id) return entry; const copy = { ...node }; if (action === 'base-view-default') delete copy.subpath; else copy.subpath = `#${requiredString(input.name)}`; return copy }) }
          await session.commit(next, input.expectedRevision, async () => { await authorize(); await observe() }, assertCurrent)
          session.recordHistory?.(original.data, next)
          return { value: inspectView(input.mountedView), revert: null }
        }
        if (action === 'convert-text-to-note') {
          const destination = requiredString(input.destination), observed = destinations.get(destination)
          const node = original.data.nodes.find(node => input.nodeIds.length === 1 && node.id === input.nodeIds[0])
          if (!node || node.type !== 'text' || !observed || observed !== input.expectedDestinationRevision) throw Object.assign(new Error('Observe an unused note destination and select one text card.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
          const file = await pluginApi.vault.readFileBaseline(destination); assertCurrent(true)
          if (file?.baseline) throw Object.assign(new Error('The note destination is occupied.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
          await authorize(); assertCurrent(true)
          const written = await pluginApi.vault.writeFileGuarded(destination, node.text, null)
          if (!written.ok) throw Object.assign(new Error('The note could not be created.'), { outcome: written.reason === 'conflict' ? 'not-applied' : 'unknown', outcomeUnknown: written.reason !== 'conflict' })
          destinations.delete(destination)
          try {
            const next = { ...original.data, nodes: original.data.nodes.map(entry => { if (entry.id !== node.id) return entry; const { text: _text, ...rest } = node; return { ...rest, type: 'file' as const, file: destination } }) }
            await session.commit(next, input.expectedRevision, authorize, assertCurrent)
            session.recordHistory?.(original.data, next)
            const confirmed = await pluginApi.vault.readFileBaseline(destination)
            if (confirmed?.content !== node.text || confirmed.baseline?.hash !== written.baseline.hash) throw new Error('The created note could not be verified.')
            return { value: inspectView(input.mountedView), revert: null }
          } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'unknown', outcomeUnknown: true, retryable: false }) }
        }
        if (action.startsWith('history-')) {
          if (!session.historyApply) throw new Error('The exact Canvas history owner is unavailable.')
          await session.historyApply(action === 'history-undo' ? 'undo' : 'redo', requiredString(input.expectedHistoryRevision), authorize, assertCurrent)
          const restored = session.get().data
          session.restore({ nodeIds: input.nodeIds.filter(id => restored.nodes.some(node => node.id === id)), edgeId: input.edgeId && restored.edges.some(edge => edge.id === input.edgeId) ? input.edgeId : null })
          return { value: inspectView(input.mountedView), revert: null }
        }
        const next = applyCanvasSelectionAction(original.data, action, input.nodeIds, input.edgeId, original.viewport.zoom)
        if (serializeCanvas(next.data) === input.expectedRevision) return { value: inspectView(input.mountedView), revert: null }
        if (new TextEncoder().encode(serializeCanvas(next.data)).byteLength > 512 * 1024) throw Object.assign(new Error('The resulting Canvas exceeds 512 KiB.'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
        await session.commit(next.data, input.expectedRevision, authorize, assertCurrent)
        try { assertActive(); if (canvasMountedSession(input.mountedView, owner) !== session) throw new Error('The exact Canvas owner changed after commit.'); session.recordHistory?.(original.data, next.data); session.restore({ nodeIds: next.nodeIds, edgeId: next.edgeId }); return { value: inspectView(input.mountedView), revert: null } }
        catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'unknown', outcomeUnknown: true, retryable: false }) }
      }
    }))
  }
  const persistenceOutput = objectSchema({ draftRevision: boundedRevision, diskRevision: boundedRevision, dirty: { type: 'boolean' }, uncertain: { type: 'boolean' }, error: { type: 'string' } }, ['draftRevision', 'diskRevision', 'dirty', 'uncertain', 'error'])
  actionOffs.push(pluginApi.commands.register({ id: 'disk-inspect', label: 'Canvas: Inspect disk and retained draft', paletteSafe: false, sideEffect: 'read', recovery: 'observational', idempotent: true, input: { schema: objectSchema({ mountedView: mountedSchema }, ['mountedView']), parse: raw => ({ mountedView: parseMounted(record(raw).mountedView) }) }, outputSchema: persistenceOutput, run: async ({ mountedView }) => { const session = canvasMountedSession(mountedView, owner), initial = session.get().viewRevision; if (!session.persistence) throw new Error('The Canvas persistence owner is unavailable.'); const result = await session.persistence(); assertActive(); if (canvasMountedSession(mountedView, owner) !== session || session.get().viewRevision !== initial) throw Object.assign(new Error('The exact Canvas view changed during inspection.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }); return result } }))
  for (const action of ['reload-disk', 'retry-save'] as const) {
    const properties = { ...exactInput, expectedDraftRevision: boundedRevision, expectedDiskRevision: boundedRevision, ...(action === 'reload-disk' ? { discardDraft: { const: true } } : {}) }
    actionOffs.push(pluginApi.commands.register({ id: action, label: `Canvas: ${action}`, paletteSafe: false, sideEffect: 'write', recovery: 'non-replayable', idempotent: false, limits: { operations: 1 }, revisionRequirements: [{ argument: 'expectedViewRevision', inspectionCommand: 'canvas:view-inspect', description: 'Use the current exact mounted Canvas revision.' }, { argument: 'expectedRevision', inspectionCommand: 'canvas:view-inspect', description: 'Use the current Canvas document revision.' }, { argument: 'expectedDraftRevision', inspectionCommand: 'canvas:disk-inspect', description: 'Use the current retained Canvas draft revision.' }, { argument: 'expectedDiskRevision', inspectionCommand: 'canvas:disk-inspect', description: 'Use the current physical Canvas file revision.' }], input: { schema: objectSchema(properties, Object.keys(properties)), parse: raw => { const input = record(raw); if (Object.keys(input).some(key => !Object.hasOwn(properties, key)) || action === 'reload-disk' && input.discardDraft !== true) throw new Error('Reload requires explicit draft discard.'); return { mountedView: parseMounted(input.mountedView), nodeIds: ids(input.nodeIds), edgeId: edge(input.edgeId), expectedViewRevision: requiredString(input.expectedViewRevision), expectedRevision: requiredString(input.expectedRevision), expectedDraftRevision: requiredString(input.expectedDraftRevision), expectedDiskRevision: requiredString(input.expectedDiskRevision) } } }, outputSchema: viewOutput, revision: ({ mountedView }) => inspectView(mountedView), preview: input => ({ action, mountedView: input.mountedView }), run: async (input, context) => {
      const session = canvasMountedSession(input.mountedView, owner)
      const assert = (initial = false) => { assertActive(); const state = session.get(); if (canvasMountedSession(input.mountedView, owner) !== session || state.locked || session.frozen?.() || !state.ready || JSON.stringify(state.nodeIds) !== JSON.stringify(input.nodeIds) || state.edgeId !== input.edgeId || state.revision !== input.expectedRevision || initial && (state.viewRevision !== input.expectedViewRevision || state.controlsBlocked)) throw Object.assign(new Error('The exact Canvas draft owner changed or is busy.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }); if (context.cancellation?.aborted) throw Object.assign(new Error('Canvas operation cancelled.'), { code: 'CANCELLED', outcome: 'not-applied' }) }
      const authorize = async () => { if (context.validateBeforeRun && !await context.validateBeforeRun()) throw Object.assign(new Error('Canvas authorization changed.'), { code: 'DENIED', outcome: 'not-applied' }); assert() }
      assert(true)
      if (!session.lifecycle) throw new Error('The Canvas persistence owner is unavailable.')
      await session.lifecycle(action, input.expectedDraftRevision, input.expectedDiskRevision, authorize, assert)
      if (action === 'reload-disk') session.restore({ nodeIds: [], edgeId: null })
      try { return { value: inspectView(input.mountedView), revert: null } } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'unknown', outcomeUnknown: true }) }
    } }))
  }
  const rawFields = ['x', 'y', 'width', 'height', 'color', 'label', 'fromEnd', 'toEnd']
  const rawOutput = objectSchema({ field: { enum: rawFields }, revision: boundedRevision, documentRevision: boundedRevision, value: { type: 'string', maxLength: 65536 }, dirty: { type: 'boolean' }, busy: { type: 'boolean' }, error: { type: 'string' } }, ['field', 'revision', 'documentRevision', 'value', 'dirty', 'busy', 'error'])
  for (const action of ['inspect', 'patch', 'apply', 'discard'] as const) {
    const mutation = action !== 'inspect'
    const rawInput = { mountedView: mountedSchema, ...explicitSelection, field: { enum: rawFields }, ...(mutation ? { expectedDraftRevision: boundedRevision } : {}), ...(action === 'patch' ? { value: { type: 'string', maxLength: 65536 } } : {}) }
    actionOffs.push(pluginApi.commands.register<RawPropertyInput, unknown, 'read' | 'write'>({ id: `raw-properties-${action}`, label: `Canvas: ${action} raw property`, paletteSafe: false, sideEffect: mutation ? 'write' : 'read', recovery: mutation ? 'non-replayable' : 'observational', idempotent: !mutation, ...(mutation ? { limits: { operations: 1 }, revisionRequirements: [{ argument: 'expectedDraftRevision', inspectionCommand: 'canvas:raw-properties-inspect', description: 'Use the current revision of this exact retained raw Properties field.' }], revision: input => { const form = forms(owner).get(formKey(input.mountedView, input.nodeIds, input.edgeId, input.field)); return form?.revision() ?? 'unavailable' }, preview: input => ({ action, field: input.field, mountedView: input.mountedView }) } : {}), input: { schema: objectSchema(rawInput, Object.keys(rawInput)), parse: raw => {
      const input = record(raw)
      if (Object.keys(input).some(key => !Object.hasOwn(rawInput, key)) || typeof input.field !== 'string' || !rawFields.includes(input.field) || action === 'patch' && (typeof input.value !== 'string' || input.value.length > 65536)) throw new Error('Unsupported Canvas raw property argument.')
      return { mountedView: parseMounted(input.mountedView), nodeIds: ids(input.nodeIds), edgeId: edge(input.edgeId), field: input.field, expectedDraftRevision: mutation ? requiredString(input.expectedDraftRevision) : '', value: input.value as string }
    } }, outputSchema: rawOutput, run: async (input, context) => {
      const key = formKey(input.mountedView, input.nodeIds, input.edgeId, input.field), form = forms(owner).get(key)
      const assert = () => {
        assertActive()
        const session = canvasMountedSession(input.mountedView, owner), current = session.get()
        if (!form || forms(owner).get(key) !== form || !form.active() || JSON.stringify(current.nodeIds) !== JSON.stringify(input.nodeIds) || current.edgeId !== input.edgeId) throw Object.assign(new Error('The exact Canvas Properties field is unavailable.'), { code: 'PROPERTY_UNAVAILABLE', outcome: 'not-applied' })
        if (mutation && (form.revision() !== input.expectedDraftRevision || current.locked || current.invalid || !current.ready || form.read().busy || session.frozen?.())) throw Object.assign(new Error('The exact Canvas Properties draft changed or is read-only.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
        if (context.cancellation?.aborted) throw Object.assign(new Error('Canvas operation cancelled.'), { code: 'CANCELLED', outcome: 'not-applied' })
      }
      assert()
      if (mutation) { if (context.validateBeforeRun && !await context.validateBeforeRun()) throw Object.assign(new Error('Canvas authorization changed.'), { code: 'DENIED', outcome: 'not-applied' }); assert() }
      if (action === 'patch') form!.patch(input.value)
      if (action === 'discard') form!.discard()
      if (action === 'apply') { await form!.apply(); if (form!.read().dirty) throw Object.assign(new Error(form!.read().error || 'The Canvas Properties draft could not be applied.'), { code: 'PROPERTY_APPLY_FAILED', outcome: 'unknown', outcomeUnknown: true }) }
      const value = { field: input.field, revision: form!.revision(), ...form!.read() }
      return mutation ? { value, revert: null } : value
    } }))
  }
  const details: WorkspaceDetailsProvider = {
    id: 'canvas.controls', label: uiText('manifest.name'), fileExtensions: ['.canvas'], defaultItems: [],
    items: [{ id: 'zoom', label: uiText('canvas.help.zoom'), kind: 'range' }, { id: 'fit', label: uiText('canvas.control.zoomToFit'), kind: 'button' }, { id: 'locked', label: uiText('auto.9b19a5a212de'), kind: 'toggle' }, { id: 'selected', label: uiText('canvas.property.selected'), kind: 'text' }, { id: 'select-node', label: uiText('canvas.control.selectedCard'), kind: 'text' }, { id: 'select-edge', label: uiText('canvas.control.selectedConnection'), kind: 'text' }, { id: 'clear-selection', label: uiText('canvas.control.clearSelection'), kind: 'button' }, { id: 'viewport-x', label: uiText('canvas.control.viewportX'), kind: 'text' }, { id: 'viewport-y', label: uiText('canvas.control.viewportY'), kind: 'text' }, { id: 'fit-selection', label: uiText('canvas.menu.zoomToSelection'), kind: 'button' }],
    automation: { actions: { zoom: { type: 'number' }, fit: { type: 'button' }, locked: { type: 'boolean' }, 'select-node': { type: 'string', maxLength: 256 }, 'select-edge': { type: 'string', maxLength: 256 }, 'clear-selection': { type: 'button' }, 'viewport-x': { type: 'number' }, 'viewport-y': { type: 'number' }, 'fit-selection': { type: 'button' } } },
    getSnapshot: (context): WorkspaceDetailsSnapshot => {
      assertActive()
      if (!context.mountedView) return { items: {} }
      let state
      try { state = canvasMountedSession(context.mountedView, owner).get() } catch { return { items: {} } }
      const disabled = !state.ready || state.controlsBlocked === true
      return { revision: state.viewRevision, items: { zoom: { value: state.viewport.zoom, min: MIN_ZOOM, max: MAX_ZOOM, disabled }, fit: { disabled: disabled || !state.data.nodes.length }, locked: { value: state.locked ?? state.readOnly, disabled }, selected: { value: state.nodeIds.length }, 'select-node': { value: state.nodeIds.length === 1 ? state.nodeIds[0] : '', disabled }, 'select-edge': { value: state.edgeId ?? '', disabled }, 'clear-selection': { disabled }, 'viewport-x': { value: state.viewport.x, disabled }, 'viewport-y': { value: state.viewport.y, disabled }, 'fit-selection': { disabled: disabled || !state.nodeIds.length && !state.edgeId } } }
    },
    subscribe: listener => subscribeCanvas(listener, owner),
    invokeAutomation: async (context, id, value, invocation) => {
      assertActive()
      if (!context.mountedView) throw new Error('Canvas controls require an exact mounted view.')
      const session = canvasMountedSession(context.mountedView, owner)
      if (!session.control) throw new Error('The Canvas view has no control owner.')
      await session.control(id, value, invocation.expectedRevision, async () => { await invocation.validateBeforeEffect(); assertActive(); if (canvasMountedSession(context.mountedView!, owner) !== session) throw new Error('The Canvas view owner changed before the effect.') })
      try { assertActive() } catch { throw Object.assign(new Error('The Canvas control owner changed after dispatch.'), { outcome: 'unknown', outcomeUnknown: true, retryable: false }) }
    }
  }

  const restore = async (raw: PluginLinkState, _instanceId?: string, options?: { background?: boolean }): Promise<void> => {
    assertActive()
    const background = options?.background
    const view = parseView(raw)
    const { data } = await readCanvasTarget(pluginApi, view.path, owner, assertActive)
    if (view.nodeIds.some((id) => !data.nodes.some((node) => node.id === id)) || (view.edgeId && !data.edges.some((edge) => edge.id === view.edgeId))) throw new Error('The bookmarked canvas selection no longer exists.')
    assertActive()
    restoreCanvasView(view.path, view, owner)
    if (!background) await owner.run(() => { assertActive(); return pluginApi.workspace.openFile(view.path) })
  }
  const offs = [...actionOffs, pluginApi.interop.extensions.provide(WORKSPACE_DETAILS_V1, details), provideBookmarkSurface(pluginApi, {
    id: 'canvas.editor', surface: 'main_workspace', subscribe: (listener) => { assertActive(); return subscribeCanvas(listener, owner) },
    getSnapshot: (instanceId) => {
      assertActive()
      const exact = instanceId ? canvasInstanceSession(instanceId, owner) : undefined
      const path = exact?.view.filePath ?? instanceId ?? pluginApi.getState().activePath ?? ''
      const snapshot = exact?.session.get() ?? canvasSession(path, owner)?.get()
      const view: PluginLinkState = { v: 1, path, ...(snapshot ? { viewport: { ...snapshot.viewport } } : {}) }
      const selected = snapshot?.nodeIds ?? []
      const edgeId = snapshot?.edgeId ?? null
      return { filePath: path, title: path.split('/').pop() ?? uiText('manifest.name'), view, ...(selected.length || edgeId ? { item: { id: edgeId ?? selected.join(','), title: edgeId ? uiText('canvas.property.connection') : selected.length > 1 ? uiText('canvas.property.selection', { count: selected.length }) : uiText('canvas.property.card'), state: { ...view, nodeIds: selected, edgeId } } } : {}) }
    },
    restore
  }, { stateSchema: bookmarkStateSchema, itemStateSchema: { ...bookmarkStateSchema, required: [...bookmarkStateSchema.required, "nodeIds", "edgeId"] }, description: (snapshot, item) => typeof snapshot.view.path === 'string' && snapshot.view.path ? snapshot.view.path : uiText(item ? 'bookmark.item' : 'bookmark.view'), validate: state => { parseView(state); return true }, primary: snapshot => Array.isArray(snapshot.item?.state.nodeIds) && snapshot.item.state.nodeIds.length > 1 ? undefined : snapshot.item }), pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
    id: 'canvas.properties', label: 'Canvas', labelKey: 'manifest.name', icon: 'layout-dashboard', extensions: ['.canvas'], pluginSurfaces: ['main_workspace'], editCommand: 'properties-edit',
    inspect: async ({ subject, relPath, mountedView }) => { assertActive(); const selected = target(subject, relPath, owner, mountedView); const { data } = await readCanvasTarget(pluginApi, selected.path, owner, assertActive); return properties(data, selected.nodeIds, selected.edgeId, targetSession(selected, owner)?.get().readOnly) },
    render: ({ subject, relPath, mountedView }) => <PropertyEditor subject={subject} path={relPath} mountedView={mountedView} owner={owner} assertActive={assertActive} />
  }), pluginApi.commands.register({ id: 'properties-edit', label: 'Canvas: Edit properties', labelKey: 'canvas.command.editProperties', paletteSafe: false, sideEffect: 'write', recovery: 'non-replayable', idempotent: false, limits: { operations: 1 }, revisionRequirements: [{ argument: 'expectedRevision', inspectionCommand: 'canvas:get', description: 'Use the observed document or editor revision for the canvas containing this subject.' }], input: {
    schema: { type: 'object', properties: { subject: subjectSchema, expectedRevision: { type: 'string', minLength: 1 }, values: { type: 'object', properties: { ...canvasNodeFields, ...canvasEdgeFields }, additionalProperties: false } }, required: ['subject', 'values', 'expectedRevision'], additionalProperties: false },
    parse: (raw) => { const input = raw as { subject?: PluginInspectionSubject; values?: unknown; expectedRevision?: unknown }; if (!input?.subject || input.subject.pluginId !== pluginApi.pluginId || input.subject.surface !== 'main_workspace') throw new Error('Expected an owned canvas subject.'); if (typeof input.expectedRevision !== 'string' || !input.expectedRevision) throw new Error('Expected an observed canvas revision.'); const selected = target(input.subject, '', owner, input.subject.mountedView, true); if (!selected.path || (!selected.edgeId && selected.nodeIds.length !== 1)) throw new Error('Select one canvas card or connection.'); return { ...selected, values: input.values, expectedRevision: input.expectedRevision } }
  }, outputSchema: { type: 'object', properties: { path: { type: 'string' }, data: canvasDataSchema, revision: { type: 'string' } }, required: ['path', 'data', 'revision'], additionalProperties: false }, revision: async ({ path }) => (await readCanvasTarget(pluginApi, path, owner, assertActive)).revision, preview: ({ path, nodeIds, edgeId, values }) => ({ path, nodeIds, edgeId, values }), run: ({ path, nodeIds, edgeId, values, expectedRevision, mountedView }, context) => {
    const assertCurrent = (): void => {
      assertActive()
      if (mountedView) {
        const current = canvasMountedSession(mountedView, owner).get()
        if (current.locked || current.invalid || !current.ready || JSON.stringify(current.nodeIds) !== JSON.stringify(nodeIds) || current.edgeId !== edgeId) throw Object.assign(new Error('The exact Canvas selection changed.'), { outcome: 'not-applied' })
      }
      if (context.cancellation?.aborted) throw Object.assign(new Error('Canvas operation cancelled.'), { outcome: 'not-applied' })
    }
    return editCanvasTarget(pluginApi, path, { type: edgeId ? 'update-edge' : 'update-node', id: edgeId ?? nodeIds[0], values }, expectedRevision, owner, assertActive, async () => {
      if (context.validateBeforeRun && !await context.validateBeforeRun()) throw Object.assign(new Error('Canvas authorization changed.'), { outcome: 'not-applied' })
      assertCurrent()
    }, mountedView ? () => canvasMountedSession(mountedView, owner) : undefined, assertCurrent)
  } })]
  offs.push(pluginApi.commands.register<PluginLinkState & { path: string }, PluginLinkState, 'write'>({ id: 'open', label: 'Canvas: Open selection', labelKey: 'canvas.command.openSelection', paletteSafe: false, sideEffect: 'write', agentVisibility: 'forbidden', recovery: 'non-replayable', idempotent: false, revision: async ({ path }) => (await readCanvasTarget(pluginApi, path, owner, assertActive)).revision, preview: view => ({ action: 'open-canvas', view }), input: {
    schema: { type: 'object', properties: { path: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } }, edgeId: { type: ['string', 'null'] }, viewport: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, zoom: { type: 'number', exclusiveMinimum: 0 } }, required: ['x', 'y', 'zoom'], additionalProperties: false } }, required: ['path'], additionalProperties: false },
    parse: (raw) => { const input = raw as PluginLinkState; const view = parseView({ ...input, v: 1 }); return { ...input, v: 1, path: view.path } }
  }, outputSchema: { type: 'object', properties: { v: { const: 1 }, path: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } }, edgeId: { type: ['string', 'null'] }, viewport: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, zoom: { type: 'number', exclusiveMinimum: 0 } }, required: ['x', 'y', 'zoom'], additionalProperties: false } }, required: ['v', 'path'], additionalProperties: false }, run: async (view) => { await restore(view); return { value: view, revert: null } } }))
  return () => { registered = false; offs.forEach((off) => off()) }
}
