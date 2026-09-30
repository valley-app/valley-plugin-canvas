import { METADATA_PANEL_SEGMENT_V1, provideBookmarkSurface, type PluginInspectionSubject, type PluginProperty, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { PluginLinkState } from '@valley/plugin-sdk/paths'
import { React, captureCanvasOwner, type CanvasOwner } from './runtime'
import { canvasSession, restoreCanvasView, subscribeCanvas, notifyCanvas } from './session'
import { canvasEdgeFields, canvasNodeFields, editCanvasTarget, readCanvasTarget } from './commands'
import type { CanvasData } from './canvasModel'
import { uiText } from './localization'
import type { InteropValueSchema } from '@valley/plugin-sdk'

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



function target(subject?: PluginInspectionSubject, fallback = '', owner = captureCanvasOwner()) {
  const state = subject?.item?.state ?? subject?.view
  const path = typeof state?.path === 'string' ? state.path : fallback
  const current = canvasSession(path, owner)?.get()
  const nodeIds = Array.isArray(state?.nodeIds) ? state.nodeIds.filter((id): id is string => typeof id === 'string') : current?.nodeIds ?? []
  const edgeId = typeof state?.edgeId === 'string' ? state.edgeId : current?.edgeId ?? null
  return { path, nodeIds, edgeId }
}
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
function PropertyEditor({ subject, path: fallback, owner, assertActive }: { subject?: PluginInspectionSubject; path: string; owner: CanvasOwner; assertActive: () => void }): React.ReactElement {
  const selected = target(subject, fallback, owner)
  const [rows, setRows] = React.useState<PluginProperty[]>([])
  const [error, setError] = React.useState('')
  const [revision, setRevision] = React.useState('')
  const nodeIdsJson = JSON.stringify(selected.nodeIds)
  const context = React.useMemo(() => ({ active: true, revision: 0 }), [owner, selected.path, selected.edgeId, nodeIdsJson])
  const latest = React.useRef(context)
  latest.current = context
  const isActive = React.useCallback(() => context.active && latest.current === context && owner.isActive(), [context, owner])
  const refresh = React.useCallback(() => {
    if (!isActive()) return
    const request = ++context.revision
    void readCanvasTarget(owner.api, selected.path, owner, assertActive).then((value) => {
      if (!isActive() || request !== context.revision) return
      setRevision(value.revision); setRows(properties(value.data, JSON.parse(nodeIdsJson) as string[], selected.edgeId, canvasSession(selected.path, owner)?.get().readOnly)); setError('')
    }).catch((reason) => { if (isActive() && request === context.revision) setError(String(reason)) })
  }, [owner, assertActive, selected.path, selected.edgeId, nodeIdsJson, context, isActive])
  React.useEffect(() => { context.active = true; refresh(); const off = subscribeCanvas(refresh, owner); return () => { context.active = false; off() } }, [refresh, context, owner])
  return <div className="right-panel-body props-info">
    {error && <p role="alert">{error}</p>}
    <dl className="props-info-table">{rows.map((row) => <div className="props-info-row" key={`${selected.path}:${selected.edgeId ?? selected.nodeIds.join(',')}:${row.id}`}><dt className="props-info-key">{row.label}</dt><dd className="props-info-value">{row.readOnly || !['x', 'y', 'width', 'height', 'color', 'label', 'fromEnd', 'toEnd'].includes(row.id) ? typeof row.value === 'object' ? JSON.stringify(row.value) : String(row.value ?? '') : <CanvasPropertyInput row={row} selected={selected} revision={revision} refresh={refresh} owner={owner} assertActive={assertActive} isParentActive={isActive} />}</dd></div>)}</dl>
  </div>
}

interface PropertyDraft { value: string; revision: string; error: string; busy: boolean }
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
  const key = `${selected.path}:${selected.edgeId ?? selected.nodeIds.join(',')}:${row.id}`
  const drafts = React.useMemo(() => propertyDrafts(owner), [owner])
  const context = React.useMemo(() => ({ active: true }), [owner, key])
  React.useEffect(() => { context.active = true; return () => { context.active = false } }, [context])
  const read = React.useCallback(() => drafts.get(key), [drafts, key])
  const subscribe = React.useCallback((listener: () => void) => subscribeCanvas(listener, owner), [owner])
  const draft = React.useSyncExternalStore(subscribe, read, read)
  const value = draft?.value ?? String(row.value ?? '')
  const update = (next: PropertyDraft | undefined): void => { if (next) drafts.set(key, next); else drafts.delete(key); notifyCanvas(owner) }
  const save = async (): Promise<void> => {
    if (!context.active || !isParentActive() || !draft || draft.busy || draft.value === String(row.value ?? '')) return
    const busy = { ...draft, busy: true }
    try {
      assertActive()
      update(busy)
      const result = await editCanvasTarget(owner.api, selected.path, { type: selected.edgeId ? 'update-edge' : 'update-node', id: selected.edgeId ?? selected.nodeIds[0], values: { [row.id]: row.type === 'number' ? Number(draft.value) : draft.value } }, draft.revision, owner, assertActive)
      assertActive()
      owner.api.undo.push({ label: uiText('canvas.command.edit'), undo: async () => { try { await result.revert.run(); return { ok: true } } catch (reason) { return { ok: false, message: String(reason) } } }, redo: async () => { try { await result.revert.reapply(); return { ok: true } } catch (reason) { return { ok: false, message: String(reason) } } } })
      if (drafts.get(key) === busy) update(undefined)
      if (context.active && isParentActive()) refresh()
    } catch (reason) { if (drafts.get(key) === busy) update({ ...draft, busy: false, error: `${uiText('canvas.error.save')} ${String(reason)}` }) }
  }
  return <span><input className="canvas-property-input" aria-label={row.label} type={row.type === 'number' ? 'number' : 'text'} value={value} disabled={draft?.busy} onChange={(event) => { if (context.active && isParentActive()) { assertActive(); update({ value: event.currentTarget.value, revision: draft?.revision ?? revision, error: '', busy: false }) } }} onBlur={() => void save()} />{draft?.error && <span role="alert">{draft.error}</span>}</span>
}

export function registerCanvasSurfaces(pluginApi: ValleyPluginApi, owner = captureCanvasOwner(pluginApi)): () => void {
  let registered = true
  const assertActive = (): void => { owner.assertActive(); if (!registered) throw new Error('The canvas surfaces are no longer registered.') }

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
  const offs = [provideBookmarkSurface(pluginApi, {
    id: 'canvas.editor', surface: 'main_workspace', subscribe: (listener) => { assertActive(); return subscribeCanvas(listener, owner) },
    getSnapshot: (instanceId) => {
      assertActive()
      const path = instanceId ?? pluginApi.getState().activePath ?? ''
      const snapshot = canvasSession(path, owner)?.get()
      const view: PluginLinkState = { v: 1, path, ...(snapshot ? { viewport: { ...snapshot.viewport } } : {}) }
      const selected = snapshot?.nodeIds ?? []
      const edgeId = snapshot?.edgeId ?? null
      return { title: path.split('/').pop() ?? uiText('manifest.name'), view, ...(selected.length || edgeId ? { item: { id: edgeId ?? selected.join(','), title: edgeId ? uiText('canvas.property.connection') : selected.length > 1 ? uiText('canvas.property.selection', { count: selected.length }) : uiText('canvas.property.card'), state: { ...view, nodeIds: selected, edgeId } } } : {}) }
    },
    restore
  }, { stateSchema: bookmarkStateSchema, itemStateSchema: { ...bookmarkStateSchema, required: [...bookmarkStateSchema.required, "nodeIds", "edgeId"] }, description: (snapshot, item) => typeof snapshot.view.path === 'string' && snapshot.view.path ? snapshot.view.path : uiText(item ? 'bookmark.item' : 'bookmark.view'), validate: state => { parseView(state); return true }, primary: snapshot => Array.isArray(snapshot.item?.state.nodeIds) && snapshot.item.state.nodeIds.length > 1 ? undefined : snapshot.item }), pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
    id: 'canvas.properties', label: 'Canvas', labelKey: 'manifest.name', icon: 'layout-dashboard', extensions: ['.canvas'], pluginSurfaces: ['main_workspace'], editCommand: 'properties-edit',
    inspect: async ({ subject, relPath }) => { assertActive(); const selected = target(subject, relPath, owner); const { data } = await readCanvasTarget(pluginApi, selected.path, owner, assertActive); return properties(data, selected.nodeIds, selected.edgeId, canvasSession(selected.path, owner)?.get().readOnly) },
    render: ({ subject, relPath }) => <PropertyEditor subject={subject} path={relPath} owner={owner} assertActive={assertActive} />
  }), pluginApi.commands.register({ id: 'properties-edit', label: 'Canvas: Edit properties', labelKey: 'canvas.command.editProperties', paletteSafe: false, sideEffect: 'write', input: {
    schema: { type: 'object', properties: { subject: { type: 'object' }, values: { type: 'object', properties: { ...canvasNodeFields, ...canvasEdgeFields }, additionalProperties: false } }, required: ['subject', 'values'], additionalProperties: false },
    parse: (raw) => { const input = raw as { subject?: PluginInspectionSubject; values?: unknown }; if (!input?.subject) throw new Error('Expected a canvas subject.'); const selected = target(input.subject, '', owner); if (!selected.path || (!selected.edgeId && selected.nodeIds.length !== 1)) throw new Error('Select one canvas card or connection.'); return { ...selected, values: input.values } }
  }, revision: async ({ path }) => (await readCanvasTarget(pluginApi, path, owner, assertActive)).revision, preview: ({ path, nodeIds, edgeId, values }) => ({ path, nodeIds, edgeId, values }), run: ({ path, nodeIds, edgeId, values }) => editCanvasTarget(pluginApi, path, { type: edgeId ? 'update-edge' : 'update-node', id: edgeId ?? nodeIds[0], values }, undefined, owner, assertActive) })]
  offs.push(pluginApi.commands.register({ id: 'open', label: 'Canvas: Open selection', labelKey: 'canvas.command.openSelection', paletteSafe: false, sideEffect: 'read', input: {
    schema: { type: 'object', properties: { path: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } }, edgeId: { type: ['string', 'null'] }, viewport: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, zoom: { type: 'number', exclusiveMinimum: 0 } }, required: ['x', 'y', 'zoom'], additionalProperties: false } }, required: ['path'], additionalProperties: false },
    parse: (raw) => { const input = raw as PluginLinkState; parseView({ ...input, v: 1 }); return { ...input, v: 1 } }
  }, run: async (view) => { await restore(view); return view } }))
  return () => { registered = false; offs.forEach((off) => off()) }
}
