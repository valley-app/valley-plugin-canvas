import type { FileBaseline } from '@valley/plugin-sdk/types'
import type { MountedPluginView } from '@valley/plugin-sdk'
import type { CanvasData } from './canvasModel'
import type { Viewport } from './geometry'
import { captureCanvasOwner, type CanvasOwner } from './runtime'

export interface CanvasSnapshot {
  data: CanvasData
  viewport: Viewport
  nodeIds: string[]
  edgeId: string | null
  readOnly: boolean
  locked?: boolean
  ready: boolean
  invalid?: boolean
  revision: string
  error: string
  viewRevision?: string
  controlsBlocked?: boolean
}
export interface CanvasSession {
  get(): CanvasSnapshot
  commit(data: CanvasData, revision: string, beforeWrite?: () => Promise<void>, beforeDispatch?: () => void): Promise<void>
  restore(view: { viewport?: Viewport; nodeIds?: string[]; edgeId?: string | null }): void
  control?(id: string, value: string | number | boolean | undefined, expectedRevision: string, beforeEffect: () => Promise<void>): Promise<void>
  persistence?(): Promise<{ draftRevision: string; diskRevision: string; dirty: boolean; uncertain: boolean; error: string }>
  lifecycle?(action: 'reload-disk' | 'retry-save', draftRevision: string, diskRevision: string, beforeEffect: () => Promise<void>, beforeDispatch: () => void): Promise<void>
  history?(): { revision: string; undo: number; redo: number }
  historyApply?(direction: 'undo' | 'redo', expectedRevision: string, beforeWrite: () => Promise<void>, beforeDispatch: () => void): Promise<void>
  recordHistory?(before: CanvasData, after: CanvasData): void
  holdControls?(): () => void
  frozen?(): boolean
  draftChanged?(key?: string, dirty?: boolean): void
}
export interface CanvasRuntime {
  owner?: CanvasOwner
  panes: Map<string, CanvasSession[]>
  sessions: Map<string, CanvasSession>
  mountedSessions?: Map<string, { view: MountedPluginView; session: CanvasSession }>
  drafts: Map<string, { data: CanvasData; baseline: FileBaseline | null; lastWritten: string | null; error: string; journalRevision?: string | null }>
  views: Map<string, { viewport?: Viewport; nodeIds?: string[]; edgeId?: string | null }>
  listeners: Set<() => void>
}
const states = new WeakMap<CanvasOwner, CanvasRuntime>()
export function canvasState(owner: CanvasOwner = captureCanvasOwner()): CanvasRuntime {
  const found = states.get(owner)
  if (found) return found
  const retained = owner.get<CanvasRuntime>('canvas.sessions', () => ({ sessions: new Map(), panes: new Map(), drafts: new Map(), views: new Map(), listeners: new Set() }))
  const recovery = owner.get('canvas.recovery', () => new Map([[retained.owner?.root ?? owner.root, retained.drafts]]))
  let drafts = recovery.get(owner.root)
  if (!drafts) { drafts = new Map(); recovery.set(owner.root, drafts) }
  const current: CanvasRuntime = !retained.owner ? retained : { sessions: new Map(), panes: new Map(), drafts, views: new Map(), listeners: new Set() }
  current.owner = owner
  states.set(owner, current)
  return current
}
export function canvasSession(path: string, owner = captureCanvasOwner()): CanvasSession | undefined { return canvasState(owner).sessions.get(path) }
export function findCanvasMountedSession(view: MountedPluginView, owner = captureCanvasOwner()): CanvasSession | undefined {
  if (!owner.isActive()) return undefined
  const entry = canvasState(owner).mountedSessions?.get(view.mountId)
  if (!entry || (['mountId', 'generation', 'area', 'paneId', 'tabId', 'filePath', 'pluginId'] as const).some(key => entry.view[key] !== view[key]) || view.pluginId !== owner.api.pluginId) return undefined
  return entry.session
}
export function canvasMountedSession(view: MountedPluginView, owner = captureCanvasOwner()): CanvasSession {
  owner.assertActive()
  const session = findCanvasMountedSession(view, owner)
  if (!session) throw new Error('The exact Canvas viewer was replaced or is unavailable.')
  return session
}
export function canvasInstanceSession(instanceId: string, owner = captureCanvasOwner()) {
  const entries = [...(canvasState(owner).mountedSessions?.values() ?? [])].filter(entry => entry.view.tabId === instanceId || entry.view.mountId === instanceId)
  return entries.length === 1 ? entries[0] : undefined
}
export function canvasDraft(path: string, owner = captureCanvasOwner()) { return canvasState(owner).drafts.get(path) }
export function saveCanvasDraft(path: string, draft: NonNullable<ReturnType<typeof canvasDraft>> | null, owner = captureCanvasOwner()): void { const drafts = canvasState(owner).drafts; if (draft) drafts.set(path, draft); else drafts.delete(path) }
export function notifyCanvas(owner = captureCanvasOwner()): void { if (owner.isActive()) for (const listener of canvasState(owner).listeners) listener() }
export function subscribeCanvas(listener: () => void, owner = captureCanvasOwner()): () => void {
  const listeners = canvasState(owner).listeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function registerCanvasSession(path: string, session: CanvasSession, owner = captureCanvasOwner(), view?: MountedPluginView): () => void {
  owner.assertActive()
  if (view && (view.filePath !== path || view.pluginId !== owner.api.pluginId)) throw new Error('Invalid Canvas mount identity.')
  const current = canvasState(owner)
  const panes = current.panes.get(path) ?? []
  panes.push(session); current.panes.set(path, panes)
  current.sessions.set(path, session)
  const mounted = view ? { view, session } : undefined
  if (view && mounted) (current.mountedSessions ??= new Map()).set(view.mountId, mounted)
  notifyCanvas(owner)
  let active = true
  return () => {
    if (!active) return
    active = false
    if (view && current.mountedSessions?.get(view.mountId) === mounted) current.mountedSessions?.delete(view.mountId)
    const index = panes.indexOf(session)
    if (index >= 0) panes.splice(index, 1)
    if (current.sessions.get(path) === session) {
      if (panes.length) current.sessions.set(path, panes[panes.length - 1]); else current.sessions.delete(path)
    }
    if (!panes.length) current.panes.delete(path)
    for (const listener of current.listeners) listener()
  }
}
export function restoreCanvasView(path: string, view: { viewport?: Viewport; nodeIds?: string[]; edgeId?: string | null }, owner = captureCanvasOwner()): void {
  owner.assertActive()
  const state = canvasState(owner)
  state.views.set(path, view)
  const session = state.sessions.get(path)
  if (session?.get().ready) { session.restore(view); state.views.delete(path) }
  notifyCanvas(owner)
}
export function pendingCanvasView(path: string, owner = captureCanvasOwner()) { const state = canvasState(owner); const view = state.views.get(path); state.views.delete(path); return view }
