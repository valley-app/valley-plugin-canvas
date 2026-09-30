import type { FileBaseline } from '@valley/plugin-sdk/types'
import type { PluginFileDraft } from '@valley/plugin-sdk'
import { parseCanvas, parseCanvasDocument, serializeCanvas, type CanvasData } from './canvasModel'
import { canvasState, notifyCanvas } from './session'
import { type CanvasOwner } from './runtime'
import { uiText } from './localization'

export interface CanvasDocumentSnapshot {
  data: CanvasData
  ready: boolean
  busy: boolean
  error: string
  /** The file is not a JSON Canvas document; it is shown read-only and never written. */
  invalid: boolean
}
const documents = new WeakMap<CanvasOwner, Map<string, CanvasDocument>>()
export function canvasDocument(owner: CanvasOwner, path: string): CanvasDocument {
  let entries = documents.get(owner)
  if (!entries) { entries = new Map(); documents.set(owner, entries) }
  let document = entries.get(path)
  if (!document) { document = new CanvasDocument(owner, path); entries.set(path, document) }
  return document
}
export function existingCanvasDocument(owner: CanvasOwner, path: string): CanvasDocument | undefined { return documents.get(owner)?.get(path) }

export class CanvasDocument {
  private readonly drafts
  private snapshot: CanvasDocumentSnapshot
  private baseline: FileBaseline | null = null
  private written: string | null = null
  private dirty = false
  private revision = 0
  private fileRevision = 0
  private listeners = new Set<() => void>()
  private leases = 0
  private writes = 0
  private offFlush: () => void
  private offDispose: () => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<unknown> = Promise.resolve()
  private loading: Promise<void> | undefined
  private offChanged: (() => void) | undefined
  private journalLoading: Promise<void> | undefined
  private journalLoaded = false
  private journalWriting: Promise<void> | undefined
  private journalPending: Promise<void> = Promise.resolve()
  private journalReceipt: string | null | undefined
  private journalFailure: unknown
  private journalRequested = 0

  constructor(readonly owner: CanvasOwner, readonly path: string) {
    this.drafts = canvasState(owner).drafts
    const draft = this.drafts.get(path)
    this.journalReceipt = draft?.journalRevision
    this.baseline = draft?.baseline ?? null; this.written = draft?.lastWritten ?? null; this.dirty = Boolean(draft)
    this.snapshot = { data: draft?.data ?? { nodes: [], edges: [] }, ready: false, busy: false, error: draft?.error ?? '', invalid: false }
    this.offFlush = owner.beforeUnload(() => this.flushPending())
    this.offDispose = owner.onDispose(() => { clearTimeout(this.timer); this.offChanged?.(); this.offChanged = undefined; this.listeners.clear() })
  }
  private release(): void {
    queueMicrotask(() => {
      if (this.leases || this.dirty || this.loading || this.writes) return
      if (documents.get(this.owner)?.get(this.path) === this) documents.get(this.owner)!.delete(this.path)
      this.offFlush(); this.offDispose()
    })
  }
  get = (): CanvasDocumentSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<CanvasDocumentSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    if (!this.owner.isActive()) return
    for (const listener of this.listeners) listener()
    notifyCanvas(this.owner)
  }
  private retain(): void {
    if (this.dirty || this.snapshot.error) this.drafts.set(this.path, { data: this.snapshot.data, baseline: this.baseline, lastWritten: this.written, error: this.snapshot.error, journalRevision: this.journalReceipt })
    else this.drafts.delete(this.path)
  }
  private loadJournal(): Promise<void> {
    if (this.journalLoading) return this.journalLoading
    return this.journalLoading = this.owner.run(async () => {
      const local = this.drafts.get(this.path)
      const expected = local?.journalRevision
      const saved = await this.owner.api.vault.drafts.read(this.path, 'editor')
      this.owner.assertActive()
      if (expected !== undefined && expected !== (saved?.revisionToken ?? null)) throw new Error('The canvas recovery journal changed elsewhere. Your local draft is preserved.')
      if (local) {
        this.baseline = local.baseline; this.written = local.lastWritten; this.dirty = true
        this.snapshot = { ...this.snapshot, data: local.data, error: local.error }
      } else this.dirty = false
      if (saved) {
        const state = JSON.parse(saved.draft.state ?? '')
        const data = JSON.parse(saved.draft.content)
        if (state?.version !== 1 || (state.lastWritten !== null && typeof state.lastWritten !== 'string') || typeof state.error !== 'string' || !data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('The canvas recovery journal could not be read.')
        if (local && expected === undefined && serializeCanvas(local.data) !== saved.draft.content) throw new Error('The canvas recovery journal conflicts with the retained local draft.')
        if (!local) {
          this.baseline = saved.draft.baseline; this.written = state.lastWritten; this.dirty = true
          this.snapshot = { ...this.snapshot, data: parseCanvas(saved.draft.content), error: state.error }
        }
      }
      this.journalReceipt = saved?.revisionToken ?? null
      this.journalLoaded = true
      this.retain()
    }).catch(reason => { this.journalFailure = reason; throw reason })
  }
  private checkpoint(accepted = false): Promise<void> {
    this.journalRequested++
    if (this.journalWriting) return this.journalWriting
    const ready = this.loadJournal()
    let finished = false
    const persist = async (): Promise<void> => {
      try {
        if (!this.journalLoaded) await ready
        if (this.journalFailure) throw this.journalFailure
        let completed = -1
        while (completed !== this.journalRequested) {
          const version = this.journalRequested
          if (this.owner.api.getState().vault?.path !== this.owner.root) throw new Error('The canvas session is no longer active.')
          if (this.dirty) {
            const draft: PluginFileDraft = { content: serializeCanvas(this.snapshot.data), baseline: this.baseline, state: JSON.stringify({ version: 1, lastWritten: this.written, error: this.snapshot.error }) }
            const saved = await this.owner.api.vault.drafts.write(this.path, 'editor', draft, this.journalReceipt ?? null)
            this.journalReceipt = saved.revisionToken
          } else {
            if (this.journalReceipt) await this.owner.api.vault.drafts.clear(this.path, 'editor', this.journalReceipt)
            this.journalReceipt = null
          }
          this.retain()
          completed = version
        }
      } catch (reason) { this.journalFailure = reason; throw reason }
      finally { finished = true; this.journalWriting = undefined }
    }
    const operation = accepted ? persist() : this.owner.run(persist)
    this.journalPending = operation.catch(reason => {
      this.journalFailure = reason
      this.publish({ error: String(reason) }); this.retain()
      throw reason
    })
    if (!finished) this.journalWriting = this.journalPending
    void this.journalPending.catch(() => {})
    return this.journalPending
  }
  attach(): () => void {
    this.owner.assertActive()
    this.leases++
    if (this.leases === 1) {
      this.offChanged = this.owner.api.vault.onChanged((info) => {
        if (!info.full && !info.changes.some((change) => change.relPath === this.path || this.path.startsWith(`${change.relPath}/`))) return
        this.fileRevision++
        if (!this.dirty) void this.load()
      })
      void this.load()
    }
    let mounted = true
    return () => {
      if (!mounted) return
      mounted = false
      if (--this.leases === 0) { this.offChanged?.(); this.offChanged = undefined; this.fileRevision++; this.release() }
    }
  }
  private load(): Promise<void> {
    if (this.loading) return this.loading
    const task = this.owner.run(async () => {
      while (this.owner.isActive() && this.leases) {
        const requested = this.fileRevision
        const revision = this.revision
        const written = this.written
        try {
          if (!this.journalLoaded) await this.loadJournal()
          if (!this.owner.isActive() || !this.leases) return
          const file = await this.owner.api.vault.readFileBaseline(this.path)
          if (!this.owner.isActive() || !this.leases) return
          if (requested !== this.fileRevision) continue
          if (revision !== this.revision || (this.snapshot.ready && written !== this.written)) return
          if (!file) throw new Error(uiText('canvas.error.missing'))
          const draft = this.drafts.get(this.path)
          if (!this.snapshot.ready && draft) {
            this.baseline = draft.baseline; this.written = draft.lastWritten; this.dirty = true
            this.publish({ data: draft.data, ready: true, error: draft.error })
          } else if (!this.dirty || !this.snapshot.ready) {
            this.dirty = false
            this.baseline = file.baseline; this.written = file.content; this.revision++
            const parsed = parseCanvasDocument(file.content)
            this.publish({ data: parsed.data, ready: true, error: '', invalid: !parsed.valid })
          }
          return
        } catch (reason) {
          if (!this.owner.isActive() || !this.leases || revision !== this.revision) return
          if (requested !== this.fileRevision) continue
          this.publish({ error: String(reason) }); return
        }
      }
    }).catch(() => {})
    this.loading = task
    void task.then(() => { if (this.loading === task) { this.loading = undefined; this.release() } })
    return task
  }
  setData(data: CanvasData): void {
    if (!this.owner.isActive() || this.snapshot.busy || !this.snapshot.ready || this.snapshot.invalid) return
    this.revision++
    this.publish({ data })
    if (this.dirty) this.retain()
  }
  schedule(data: CanvasData): void {
    if (!this.owner.isActive() || this.snapshot.busy || !this.snapshot.ready || this.snapshot.invalid) return
    this.dirty = true; this.retain()
    void this.checkpoint().catch(() => {})
    clearTimeout(this.timer)
    if (!this.snapshot.error) this.timer = setTimeout(() => { void this.flush(data, false).catch(() => {}) }, 350)
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.saving
    this.writes++
    const task = this.owner.run(async () => { await previous; this.owner.assertActive(); return operation() })
    this.saving = task.then(() => {}, () => {}).finally(() => { this.writes--; this.release() })
    return task
  }
  private async write(data: CanvasData, text: string, adopt: boolean): Promise<void> {
    await this.checkpoint(true)
    this.owner.assertActive()
    let result
    try { result = await this.owner.api.vault.writeFileGuarded(this.path, text, this.baseline) }
    catch (reason) {
      this.dirty = true
      this.publish({ error: `${uiText('canvas.error.save')} ${String(reason)}` }); this.retain()
      throw reason
    }
    if (!result.ok) {
      this.dirty = true
      this.publish({ error: uiText(result.reason === 'conflict' ? 'canvas.error.conflict' : 'canvas.error.save') })
      this.retain()
      throw new Error(this.snapshot.error)
    }
    this.baseline = result.baseline; this.written = text
    if (adopt) { this.revision++; this.publish({ data }) }
    this.dirty = serializeCanvas(this.snapshot.data) !== text
    this.publish({ error: '' }); this.retain()
    await this.checkpoint(true)
  }
  flush(data = this.snapshot.data, retry = true): Promise<void> {
    if (!this.snapshot.ready || this.snapshot.invalid) return Promise.reject(new Error(this.snapshot.error || uiText('canvas.error.readOnly')))
    const captured = structuredClone(data)
    const text = serializeCanvas(captured)
    clearTimeout(this.timer)
    return this.enqueue(async () => {
      if (this.snapshot.error && !retry) throw new Error(this.snapshot.error)
      await this.write(captured, text, false)
    })
  }
  async flushPending(): Promise<void> {
    clearTimeout(this.timer)
    await this.loading
    await this.saving
    await this.journalPending
    this.owner.assertActive()
    if (this.journalFailure) throw this.journalFailure
    if (this.dirty && this.snapshot.error) throw new Error(this.snapshot.error)
    while (this.dirty) await this.flush(this.snapshot.data, false)
  }
  commit(data: CanvasData, revision: string): Promise<void> {
    this.owner.assertActive()
    if (!this.snapshot.ready || this.snapshot.busy || this.snapshot.invalid) return Promise.reject(new Error(uiText('canvas.error.readOnly')))
    if (serializeCanvas(this.snapshot.data) !== revision) return Promise.reject(new Error(uiText('canvas.error.changed')))
    const captured = structuredClone(data)
    clearTimeout(this.timer)
    this.publish({ busy: true })
    return this.enqueue(async () => {
      if (serializeCanvas(this.snapshot.data) !== revision) throw new Error(uiText('canvas.error.changed'))
      await this.write(captured, serializeCanvas(captured), true)
    }).finally(() => { this.publish({ busy: false }) })
  }
  async reload(confirm: () => Promise<string | null>, active: () => boolean): Promise<boolean> {
    const revision = this.revision
    const current = (): boolean => this.owner.isActive() && active() && revision === this.revision
    let clearing = false
    try {
      this.owner.assertActive()
      if (!active()) return false
      const choice = await confirm()
      if (choice !== 'reload' || !current()) return false
      clearTimeout(this.timer)
      await this.saving
      await this.journalPending
      if (!current()) return false
      const file = await this.owner.run(() => this.owner.api.vault.readFileBaseline(this.path))
      if (!current()) return false
      if (!file) throw new Error(uiText('canvas.error.missing'))
      const parsed = parseCanvasDocument(file.content)
      clearing = true
      this.publish({ busy: true })
      const receipt = this.journalReceipt
      if (receipt) await this.owner.run(() => this.owner.api.vault.drafts.clear(this.path, 'editor', receipt))
      if (!current()) return false
      this.journalReceipt = null
      this.baseline = file.baseline; this.written = file.content; this.dirty = false; this.revision++
      this.publish({ data: parsed.data, ready: true, error: '', invalid: !parsed.valid }); this.retain()
      return true
    } catch (reason) { if (current()) this.publish({ error: String(reason) }); return false }
    finally { if (clearing) this.publish({ busy: false }) }
  }
}
