import type { FileBaseline } from '@valley/plugin-sdk/types'
import type { CanvasData } from './canvasModel'
import type { Viewport } from './geometry'
import { captureCanvasOwner, type CanvasOwner } from './runtime'

export interface CanvasSnapshot {
  data: CanvasData
  viewport: Viewport
  nodeIds: string[]
  edgeId: string | null
  readOnly: boolean
  ready: boolean
  invalid?: boolean
  revision: string
  error: string
}
export interface CanvasSession {
  get(): CanvasSnapshot
  commit(data: CanvasData, revision: string): Promise<void>
  restore(view: { viewport?: Viewport; nodeIds?: string[]; edgeId?: string | null }): void
}
export interface CanvasRuntime {
  owner?: CanvasOwner
  panes: Map<string, CanvasSession[]>
  sessions: Map<string, CanvasSession>
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
export function canvasDraft(path: string, owner = captureCanvasOwner()) { return canvasState(owner).drafts.get(path) }
export function saveCanvasDraft(path: string, draft: NonNullable<ReturnType<typeof canvasDraft>> | null, owner = captureCanvasOwner()): void { const drafts = canvasState(owner).drafts; if (draft) drafts.set(path, draft); else drafts.delete(path) }
export function notifyCanvas(owner = captureCanvasOwner()): void { if (owner.isActive()) for (const listener of canvasState(owner).listeners) listener() }
export function subscribeCanvas(listener: () => void, owner = captureCanvasOwner()): () => void {
  const listeners = canvasState(owner).listeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function registerCanvasSession(path: string, session: CanvasSession, owner = captureCanvasOwner()): () => void {
  owner.assertActive()
  const current = canvasState(owner)
  const panes = current.panes.get(path) ?? []
  panes.push(session); current.panes.set(path, panes)
  current.sessions.set(path, session)
  notifyCanvas(owner)
  let mounted = true
  return () => {
    if (!mounted) return
    mounted = false
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
