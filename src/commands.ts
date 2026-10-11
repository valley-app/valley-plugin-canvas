import { guardedCreatedFileRevert, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { CommandContext } from '@valley/plugin-sdk/commands'
import { EMPTY_CANVAS, parseCanvasDocument, serializeCanvas, type CanvasData } from './canvasModel'
import { normalizeRelPathOpt } from '@valley/plugin-sdk/paths'
import { canvasDraft, canvasSession, type CanvasSession } from './session'
import { applyCanvasOperation, canvasOperationSchema, objectSchema, stringSchema, record, requiredString } from './operations'
export { applyCanvasOperation, canvasNodeFields, canvasEdgeFields } from './operations'
import { canvasDataSchema } from './automationContracts'
import { captureCanvasOwner, type CanvasOwner } from './runtime'

/** Parent folder of the active file (or vault root when nothing is open). */
function activeFolder(api: ValleyPluginApi): string {
  const active = api.getState().activePath
  if (!active) return ''
  const slash = active.lastIndexOf('/')
  return slash > 0 ? active.slice(0, slash) : ''
}

const absence = new WeakMap<CanvasOwner, Map<string, string>>()
function missingRevisions(owner: CanvasOwner): Map<string, string> { let values = absence.get(owner); if (!values) { values = new Map(); absence.set(owner, values) } return values }
const mutationOutput = objectSchema({ path: stringSchema, data: canvasDataSchema, revision: { type: 'string' } }, ['path', 'data', 'revision'])
async function observeCreation(api: ValleyPluginApi, path: string, owner: CanvasOwner, assertActive: () => void) {
  if (!path.endsWith('.canvas') || normalizeRelPathOpt(path) !== path) throw new Error('Expected a vault-relative canvas path.')
  const file = await owner.run(() => { assertActive(); return api.vault.readFileBaseline(path) })
  assertActive()
  if (!file || file.baseline || canvasSession(path, owner) || canvasDraft(path, owner)) throw new Error('The canvas path is occupied or has a retained draft.')
  const draft = await owner.run(() => api.vault.drafts.read(path, 'editor'))
  assertActive()
  if (draft) throw new Error('The canvas has an unsaved draft.')
  const entries = missingRevisions(owner)
  let expectedRevision = entries.get(path)
  if (!expectedRevision) {
    if (entries.size >= 256) entries.delete(entries.keys().next().value!)
    expectedRevision = `canvas:absent:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
    entries.set(path, expectedRevision)
  }
  return { path, expectedRevision }
}

async function freeCanvasPath(api: ValleyPluginApi, folder: string, owner: CanvasOwner): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    owner.assertActive()
    const path = `${folder ? `${folder}/` : ''}Untitled${n ? ` ${n}` : ''}.canvas`
    const file = await owner.run(() => api.vault.stat(path))
    owner.assertActive()
    if (!file) return path
  }
  throw new Error('Could not find a free canvas name.')
}

export async function createCanvasFromUi(api: ValleyPluginApi, folder = activeFolder(api), owner = captureCanvasOwner(api)): Promise<void> {
  const path = await freeCanvasPath(api, folder, owner)
  const observed = await api.commands.executeOwn('create-observe', { path })
  owner.assertActive()
  if (!observed.ok) throw new Error(observed.error.message)
  const created = await api.commands.executeOwn('create', { ...record(observed.value), open: true })
  if (!created.ok) throw new Error(created.error.message)
}

export function registerCanvasCommands(api: ValleyPluginApi, owner = captureCanvasOwner(api)): () => void {
  let registered = true
  const assertActive = (): void => { owner.assertActive(); if (!registered) throw new Error('The canvas commands are no longer registered.') }
  const guard = async (context: CommandContext): Promise<void> => { assertActive(); if (context.cancellation?.aborted) throw Object.assign(new Error('The canvas operation was cancelled.'), { outcome: 'not-applied', code: 'CANCELLED' }); if (context.validateBeforeRun && !await context.validateBeforeRun()) throw Object.assign(new Error('Canvas authorization is no longer current.'), { outcome: 'not-applied', code: 'AUTHORIZATION_CHANGED' }); assertActive(); if (context.cancellation?.aborted) throw Object.assign(new Error('The canvas operation was cancelled.'), { outcome: 'not-applied', code: 'CANCELLED' }) }
  const guardedVault = {
    ...api.vault,
    restoreTrashed: (...args: Parameters<typeof api.vault.restoreTrashed>) => owner.run(() => { assertActive(); return api.vault.restoreTrashed(...args) }),
    readFileBaseline: (path: string) => owner.run(() => { assertActive(); return api.vault.readFileBaseline(path) }),
    trashFileGuarded: (...args: Parameters<typeof api.vault.trashFileGuarded>) => owner.run(() => { assertActive(); return api.vault.trashFileGuarded(...args) }),
    writeFileGuarded: (...args: Parameters<typeof api.vault.writeFileGuarded>) => owner.run(() => { assertActive(); return api.vault.writeFileGuarded(...args) })
  }
  // create-new runs this in its own command context: a nested executeOwn('create') would queue a second write behind the running one until the renderer timeout.
  const createCanvas = async ({ path, expectedRevision, open }: { path: string; expectedRevision: string; open: boolean }, context: CommandContext) => {
    assertActive()
    if (missingRevisions(owner).get(path) !== expectedRevision) throw new Error('Inspect the unused canvas path before creating it.')
    const observed = await observeCreation(api, path, owner, assertActive)
    if (observed.expectedRevision !== expectedRevision) throw new Error('The canvas path changed.')
    await guard(context)
    const written = await owner.run(() => { assertActive(); return api.vault.writeFileGuarded(path, EMPTY_CANVAS, null) })
    if (!written.ok) throw Object.assign(new Error('The canvas could not be created.'), { outcome: written.reason === 'conflict' ? 'not-applied' : 'unknown', code: written.reason === 'conflict' ? 'REVISION_CONFLICT' : 'OUTCOME_UNKNOWN' })
    missingRevisions(owner).delete(path)
    try {
      const confirmed = await owner.run(() => api.vault.readFileBaseline(path))
      assertActive()
      if (confirmed?.content !== EMPTY_CANVAS || confirmed.baseline?.hash !== written.baseline.hash || confirmed.baseline.size !== written.baseline.size) throw new Error('The created canvas could not be verified.')
      if (open) { await guard(context); await owner.run(() => { assertActive(); return api.workspace.openFile(path) }) }
    } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'unknown', code: 'OUTCOME_UNKNOWN' }) }
    return { value: { relPath: path, revision: `canvas:file:${written.baseline.hash}:${written.baseline.size}:${written.baseline.mtimeMs}`, verified: true }, revert: guardedCreatedFileRevert(guardedVault, path, EMPTY_CANVAS, written.baseline, 'Create canvas') }
  }
  const offNew = api.commands.register({ id: 'create-new', label: 'Canvas: Create new canvas', labelKey: 'auto.7b18787efddd', sideEffect: 'write', agentVisibility: 'forbidden', recovery: 'non-replayable', idempotent: false, outputSchema: { type: 'null' }, revision: () => ({ folder: activeFolder(api) }), preview: () => ({ action: 'create-canvas', folder: activeFolder(api), open: true }), run: async (_input, context) => { await guard(context); const path = await freeCanvasPath(api, activeFolder(api), owner); const { expectedRevision } = await observeCreation(api, path, owner, assertActive); return { value: null, revert: (await createCanvas({ path, expectedRevision, open: true }, context)).revert } } })
  const offObserve = api.commands.register({ id: 'create-observe', label: 'Canvas: Observe an unused path', paletteSafe: false, sideEffect: 'read', recovery: 'observational', idempotent: true, input: { schema: objectSchema({ path: stringSchema }, ['path']), parse: raw => ({ path: requiredString(record(raw).path) }) }, outputSchema: objectSchema({ path: stringSchema, expectedRevision: stringSchema }, ['path', 'expectedRevision']), run: ({ path }) => observeCreation(api, path, owner, assertActive) })
  const offCreate = api.commands.register({
    id: 'create', label: 'Canvas: Create new canvas', labelKey: 'auto.7b18787efddd', paletteSafe: false, sideEffect: 'write',
    recovery: 'non-replayable', idempotent: false, limits: { files: 1 }, revisionRequirements: [{ argument: 'expectedRevision', inspectionCommand: 'canvas:create-observe', description: 'Use the observed absence revision for this exact canvas path in the current owner session.' }],
    input: { schema: objectSchema({ path: stringSchema, expectedRevision: stringSchema, open: { type: 'boolean' } }, ['path', 'expectedRevision']), parse: raw => { const input = record(raw); if (input.open !== undefined && typeof input.open !== 'boolean') throw new Error('Expected an explicit open preference.'); return { path: requiredString(input.path), expectedRevision: requiredString(input.expectedRevision), open: input.open === true } } },
    outputSchema: objectSchema({ relPath: stringSchema, revision: stringSchema, verified: { const: true } }, ['relPath', 'revision', 'verified']),
    revision: ({ path }) => observeCreation(api, path, owner, assertActive), preview: ({ path, open }) => ({ action: 'create-canvas', path, open }),
    run: (input, context) => createCanvas(input, context)
  })
  const offGet = api.commands.register({ id: 'get', label: 'Canvas: Inspect canvas', labelKey: 'canvas.command.get', paletteSafe: false, sideEffect: 'read', recovery: 'observational', idempotent: true, input: { schema: objectSchema({ path: stringSchema }, ['path']), parse: raw => ({ path: requiredString(record(raw).path) }) }, outputSchema: mutationOutput, run: async ({ path }) => { const target = await readCanvasTarget(api, path, owner, assertActive); return { path, data: target.data, revision: target.revision } } })
  const offEdit = api.commands.register({ id: 'edit', label: 'Canvas: Edit canvas', labelKey: 'canvas.command.edit', paletteSafe: false, sideEffect: 'write', recovery: 'non-replayable', idempotent: false, limits: { operations: 1 }, revisionRequirements: [{ argument: 'expectedRevision', inspectionCommand: 'canvas:get', description: 'Use the observed document or editor revision for this exact canvas path.' }], input: { schema: objectSchema({ path: stringSchema, operation: canvasOperationSchema, expectedRevision: { type: 'string', minLength: 1 } }, ['path', 'operation', 'expectedRevision']), parse: raw => { const input = record(raw); return { path: requiredString(input.path), operation: record(input.operation), expectedRevision: requiredString(input.expectedRevision) } } }, outputSchema: mutationOutput, revision: async ({ path }) => (await readCanvasTarget(api, path, owner, assertActive)).revision, preview: ({ path, operation }) => ({ path, operation }), run: ({ path, operation, expectedRevision }, context) => editCanvasTarget(api, path, operation, expectedRevision, owner, assertActive, () => guard(context)) })
  return () => { registered = false; missingRevisions(owner).clear(); offNew(); offObserve(); offCreate(); offGet(); offEdit() }
}

export async function readCanvasTarget(api: ValleyPluginApi, path: string, owner = captureCanvasOwner(api), assertActive = owner.assertActive, exactSession?: () => CanvasSession) {
  assertActive()
  if (!path.endsWith('.canvas') || normalizeRelPathOpt(path) !== path) throw new Error('Expected a vault-relative canvas path.')
  const session = exactSession ? exactSession() : canvasSession(path, owner)
  if (session) { const snapshot = session.get(); if (!snapshot.ready) throw new Error('The canvas is still loading.'); if (snapshot.invalid) throw new Error('The canvas file is invalid.'); return { data: snapshot.data, revision: snapshot.revision, baseline: null, session, exactSession } }
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
  return { data, revision: serializeCanvas(data), baseline: file.baseline, session: undefined, exactSession: undefined }
}
async function commitTarget(owner: CanvasOwner, path: string, data: CanvasData, previous: Awaited<ReturnType<typeof readCanvasTarget>>, assertActive: () => void, beforeWrite?: () => Promise<void>, beforeDispatch?: () => void): Promise<void> {
  assertActive()
  if ((previous.exactSession ? previous.exactSession() : canvasSession(path, owner)) !== previous.session) throw new Error('The canvas changed. Inspect its active draft before editing.')
  const assertDispatch = (): void => {
    try {
      assertActive()
      if ((previous.exactSession ? previous.exactSession() : canvasSession(path, owner)) !== previous.session) throw new Error('The canvas changed. Inspect its active draft before editing.')
      beforeDispatch?.()
    } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'not-applied' }) }
  }
  if (previous.session) await owner.run(() => { assertActive(); return previous.session!.commit(data, previous.revision, beforeWrite, assertDispatch) })
  else {
    const result = await owner.run(async () => {
      if (beforeWrite) await beforeWrite()
      assertActive()
      if (canvasSession(path, owner) || canvasDraft(path, owner)) throw new Error('The canvas changed. Inspect its active draft before editing.')
      assertDispatch()
      return owner.api.vault.writeFileGuarded(path, serializeCanvas(data), previous.baseline)
    })
    if (!result.ok) throw Object.assign(new Error('The canvas changed or could not be saved.'), { outcome: result.reason === 'conflict' ? 'not-applied' : 'unknown', code: result.reason === 'conflict' ? 'REVISION_CONFLICT' : 'OUTCOME_UNKNOWN' })
    try {
      const confirmed = await owner.api.vault.readFileBaseline(path)
      assertActive()
      if (confirmed?.content !== serializeCanvas(data) || confirmed.baseline?.hash !== result.baseline.hash) throw new Error('The resulting canvas could not be verified.')
    } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'unknown', code: 'OUTCOME_UNKNOWN' }) }
  }
}
export async function restoreCanvasTarget(owner: CanvasOwner, path: string, data: CanvasData, revision: string, assertActive = owner.assertActive): Promise<void> {
  const captured = structuredClone(data)
  const current = await readCanvasTarget(owner.api, path, owner, assertActive)
  if (current.revision !== revision) throw new Error('The canvas changed after this edit. Undo would overwrite newer work.')
  await commitTarget(owner, path, captured, current, assertActive)
}
export async function editCanvasTarget(api: ValleyPluginApi, path: string, operation: unknown, expectedRevision: string, owner = captureCanvasOwner(api), assertActive = owner.assertActive, beforeWrite?: () => Promise<void>, exactSession?: () => CanvasSession, beforeDispatch?: () => void) {
  assertActive()
  const accepted = structuredClone(operation)
  const previous = await readCanvasTarget(api, path, owner, assertActive, exactSession)
  if (!expectedRevision || expectedRevision !== previous.revision) throw new Error('The canvas changed. Inspect it again before editing.')
  const before = structuredClone(previous.data)
  const next = applyCanvasOperation(before, accepted)
  const nextRevision = serializeCanvas(next)
  await commitTarget(owner, path, next, previous, assertActive, beforeWrite, beforeDispatch)
  const after = structuredClone(next)
  return { value: { path, data: next, revision: nextRevision }, revert: { label: 'Edit canvas', run: () => restoreCanvasTarget(owner, path, before, nextRevision, assertActive), reapply: () => restoreCanvasTarget(owner, path, after, previous.revision, assertActive) } }
}
