import type { PluginBackendApi, PluginBackendOperationContext, PluginCommandInvocation } from '@valley/plugin-sdk'
import type { FileBaseline } from '@valley/plugin-sdk/types'
import { normalizeRelPathOpt } from '@valley/plugin-sdk/paths'
import { EMPTY_CANVAS, parseCanvasDocument, serializeCanvas, type CanvasData } from '../canvasModel'
import { applyCanvasOperation, record, requiredString } from '../operations'

export const MAX_CANVAS_BYTES = 512 * 1024
function fail(message: string, code = 'INVALID_INPUT', unknown = false): never { throw Object.assign(new Error(message), { code, outcome: unknown ? 'unknown' : 'not-applied', outcomeUnknown: unknown }) }
const revisionOf = (baseline: FileBaseline): string => `canvas:file:${baseline.hash}:${baseline.size}:${baseline.mtimeMs}`
function canvasPath(raw: unknown): string { const path = requiredString(raw); if (path.length > 4096 || !path.endsWith('.canvas') || normalizeRelPathOpt(path) !== path) fail('Expected a vault-relative canvas path.'); return path }
const budget = (content: string): void => { if (new TextEncoder().encode(content).byteLength > MAX_CANVAS_BYTES) fail('Canvas automation is limited to 512 KiB per document.', 'RESOURCE_LIMIT') }
const compare = (expected: unknown, current: string): void => { if (typeof expected !== 'string' || expected !== current) fail('The canvas changed. Inspect it again before editing.', 'REVISION_CONFLICT') }

export function registerCanvasDocumentCommands(api: PluginBackendApi): () => void {
  let active = true
  const missing = new Map<string, string>()
  let sequence = 0
  const assert = (context: PluginBackendOperationContext): void => {
    if (!active) fail('The canvas document owner is unavailable.', 'OWNER_UNAVAILABLE')
    if (context.cancellation.aborted) fail('The canvas operation was cancelled.', 'CANCELLED')
  }
  const load = async (path: string, context: PluginBackendOperationContext) => {
    assert(context)
    const file = await context.api.vault.read(path)
    assert(context)
    if (!file) fail('The canvas could not be read.', 'UNAVAILABLE')
    if (!file.baseline) {
      let revision = missing.get(path)
      if (!revision) {
        if (missing.size >= 256) missing.delete(missing.keys().next().value!)
        revision = `canvas:absent:${Date.now().toString(36)}:${++sequence}:${Math.random().toString(36).slice(2)}`
        missing.set(path, revision)
      }
      return { path, revision, baseline: null, data: null }
    }
    missing.delete(path)
    budget(file.content)
    const parsed = parseCanvasDocument(file.content)
    if (!parsed.valid) fail('The canvas file is invalid.', 'INVALID_DOCUMENT')
    return { path, revision: revisionOf(file.baseline), baseline: file.baseline, data: parsed.data }
  }
  const off = api.rpc.handleOperation('document.command', async (raw, context) => {
    assert(context)
    const envelope = record(raw) as unknown as PluginCommandInvocation
    const input = record(envelope.input)
    const action = requiredString(input.action)
    const allowed = action === 'inspect' ? ['action', 'path'] : action === 'read' ? ['action', 'path', 'expectedRevision', 'offset', 'limit', 'collection'] : action === 'create' ? ['action', 'path', 'expectedRevision'] : ['action', 'path', 'expectedRevision', 'operations']
    if (Object.keys(input).some(key => !allowed.includes(key)) || !['inspect', 'read', 'create', 'edit'].includes(action)) fail('Unsupported canvas command argument.')
    const path = canvasPath(input.path)
    const before = await load(path, context)
    if (action === 'inspect') return { value: { path, revision: before.revision, exists: Boolean(before.baseline), nodes: before.data?.nodes.length ?? 0, edges: before.data?.edges.length ?? 0, preservedNodes: before.data?.preserved?.nodes.length ?? 0, preservedEdges: before.data?.preserved?.edges.length ?? 0 } }
    compare(input.expectedRevision, before.revision)
    if (action === 'read') {
      if (!before.data) fail('The canvas does not exist.', 'NOT_FOUND')
      const offset = input.offset ?? 0, limit = input.limit ?? 50
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) fail('Invalid canvas page bounds.')
      const collections: Record<string, unknown[]> = { nodes: before.data.nodes, edges: before.data.edges, properties: Object.entries(before.data.extra ?? {}).map(([key, value]) => ({ key, value })), preservedNodes: before.data.preserved?.nodes ?? [], preservedEdges: before.data.preserved?.edges ?? [] }
      const items = Object.hasOwn(collections, String(input.collection)) ? collections[String(input.collection)] : undefined
      if (!items) fail('Expected a canvas collection.')
      const page = items.slice(Number(offset), Number(offset) + Number(limit))
      if (new TextEncoder().encode(JSON.stringify(page)).byteLength > 64 * 1024) fail('The canvas page exceeds 64 KiB; request fewer items.', 'RESOURCE_LIMIT')
      return { value: { path, revision: before.revision, collection: input.collection, offset, total: items.length, items: page, nextOffset: Number(offset) + page.length < items.length ? Number(offset) + page.length : null } }
    }
    let next: CanvasData
    if (action === 'create') {
      if (before.baseline) fail('The canvas path is occupied.', 'TARGET_OCCUPIED')
      next = parseCanvasDocument(EMPTY_CANVAS).data
    } else {
      if (!before.data) fail('The canvas does not exist.', 'NOT_FOUND')
      if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 100) fail('Expected 1 to 100 canvas operations.')
      try { next = input.operations.reduce<CanvasData>((data, operation) => applyCanvasOperation(data, operation), structuredClone(before.data)) }
      catch (error) { fail(error instanceof Error ? error.message : String(error)) }
    }
    const text = serializeCanvas(next!)
    budget(text)
    assert(context)
    let written
    try { written = await context.api.vault.write(path, text, before.baseline) }
    catch (error) {
      if (error && typeof error === 'object' && 'outcome' in error && error.outcome === 'not-applied') throw error
      fail('The canvas write acknowledgement was lost. Inspect the original execution; do not replay it.', 'OUTCOME_UNKNOWN', true)
    }
    if (!written.ok) fail(written.reason === 'conflict' ? 'The canvas changed before commit.' : 'The canvas write could not be confirmed.', written.reason === 'conflict' ? 'REVISION_CONFLICT' : 'OUTCOME_UNKNOWN', written.reason !== 'conflict')
    missing.delete(path)
    try {
      assert(context)
      const observed = await context.api.vault.read(path)
      assert(context)
      if (!observed?.baseline || observed.content !== text || revisionOf(observed.baseline) !== revisionOf(written.baseline)) fail('The resulting canvas could not be verified.', 'OUTCOME_UNKNOWN', true)
      return { value: { path, revision: revisionOf(observed.baseline), verified: true } }
    } catch { fail('The canvas was written but independent verification did not finish. Inspect the original execution; do not replay it.', 'OUTCOME_UNKNOWN', true) }
  })
  return () => { active = false; missing.clear(); off() }
}
