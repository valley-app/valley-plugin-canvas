import { describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { registerCanvasDocumentCommands } from '../src/backend/documents'
import { canvasEditInput, canvasInspectInput, canvasInspectOutput, canvasMutationOutput, canvasObservedInput, canvasReadInput, canvasReadOutput } from '../src/automationContracts'
import config from '../config.json'

const original = JSON.stringify({ nodes: [{ id: 'a', type: 'text', text: 'ä ö ü', x: 0, y: 0, width: 200, height: 100, custom: { retained: false } }, { id: 'future', type: 'future', opaque: [null, 0] }], edges: [], metadata: { zero: 0, empty: '', list: [], flag: false, nullable: null } })
function setup(files: Record<string, string> = { 'Board.canvas': original }) {
  const mock = createMockValleyApi({ manifest: { id: 'canvas' }, files })
  let handler!: Parameters<PluginBackendApi['rpc']['handleOperation']>[1]
  const api = { rpc: { handleOperation: vi.fn((_method, callback) => { handler = callback; return vi.fn() }) } } as unknown as PluginBackendApi
  const controller = new AbortController()
  const vault = { read: vi.fn((path: string) => mock.api.vault.readFileBaseline(path)), write: vi.fn((path: string, content: string, expected: Parameters<typeof mock.api.vault.writeFileGuarded>[2]) => mock.api.vault.writeFileGuarded(path, content, expected)) }
  const context = { id: 'owned-operation', cancellation: controller.signal, api: { vault } } as unknown as PluginBackendOperationContext
  const dispose = registerCanvasDocumentCommands(api)
  const invoke = async (action: string, input: object = {}) => (await handler({ input: { action, path: 'Board.canvas', ...input }, execution: { id: 'execution-original', correlationId: 'request-original' } }, context) as { value: Record<string, any> }).value
  return { mock, vault, invoke, controller, dispose }
}

describe('background Canvas document owner', () => {
  it('requires the observed unused path, creates without opening, and independently reads back the result', async () => {
    const { invoke, vault, mock } = setup({})
    await expect(invoke('create', { expectedRevision: 'made-up' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    expect(vault.write).not.toHaveBeenCalled()
    const observed = await invoke('inspect')
    expect(observed).toMatchObject({ exists: false })
    const saved = await invoke('create', { expectedRevision: observed.revision })
    expect(saved).toMatchObject({ path: 'Board.canvas', verified: true })
    expect(saved.revision).not.toBe(observed.revision)
    expect(vault.read).toHaveBeenCalledTimes(4)
    expect(JSON.parse(await mock.api.vault.readFile('Board.canvas') ?? '')).toEqual({ nodes: [], edges: [] })
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
    await expect(invoke('create', { expectedRevision: observed.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(vault.write).toHaveBeenCalledOnce()
  })

  it('preserves unknown document and card fields through a single atomic multi-operation commit', async () => {
    const { invoke, vault, mock } = setup()
    const { revision } = await invoke('inspect')
    const result = await invoke('edit', { expectedRevision: revision, operations: [{ type: 'update-node', id: 'a', values: { text: '', x: 0 } }, { type: 'add-node', node: { id: 'group', type: 'group', x: 100, y: 0, label: 'Grüppe' } }, { type: 'add-edge', edge: { id: 'connection', fromNode: 'a', toNode: 'group', label: '' } }, { type: 'reorder-nodes', ids: ['group'], to: 'back' }] })
    expect(result.verified).toBe(true)
    expect(vault.write).toHaveBeenCalledOnce()
    const saved = JSON.parse(await mock.api.vault.readFile('Board.canvas') ?? '')
    expect(saved.metadata).toEqual({ zero: 0, empty: '', list: [], flag: false, nullable: null })
    expect(saved.nodes.find((node: { id: string }) => node.id === 'future')).toEqual({ id: 'future', type: 'future', opaque: [null, 0] })
    expect(saved.nodes.find((node: { id: string }) => node.id === 'a')).toMatchObject({ text: '', custom: { retained: false } })
    expect(saved.edges[0]).toMatchObject({ label: '' })
  })

  it('rejects stale revisions and every invalid batch before any write', async () => {
    const { invoke, vault } = setup()
    const { revision } = await invoke('inspect')
    await expect(invoke('edit', { expectedRevision: 'stale', operations: [{ type: 'delete-nodes', ids: ['a'] }] })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(invoke('edit', { expectedRevision: revision, operations: [{ type: 'update-node', id: 'a', values: { text: 'valid first' } }, { type: 'update-node', id: 'a', values: { width: 0 } }] })).rejects.toMatchObject({ code: 'INVALID_INPUT', outcome: 'not-applied' })
    expect(vault.write).not.toHaveBeenCalled()
  })

  it('paginates unknown properties and refuses pages from another observed revision', async () => {
    const { invoke, mock } = setup()
    const { revision } = await invoke('inspect')
    expect(await invoke('read', { expectedRevision: revision, collection: 'properties', offset: 0, limit: 1 })).toMatchObject({ total: 1, nextOffset: null, items: [{ key: 'metadata', value: { flag: false, nullable: null } }] })
    expect(await invoke('read', { expectedRevision: revision, collection: 'preservedNodes' })).toMatchObject({ total: 1, items: [{ raw: { type: 'future' } }] })
    await mock.api.vault.writeFile('Board.canvas', '{"nodes":[],"edges":[]}')
    await expect(invoke('read', { expectedRevision: revision, collection: 'nodes' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it.each(['cancel', 'replace'] as const)('rechecks %s during the awaited read before effects', async action => {
    const { invoke, vault, controller, dispose } = setup()
    const { revision } = await invoke('inspect')
    const read = vault.read.getMockImplementation()!
    vault.read.mockImplementationOnce(async path => { const value = await read(path); if (action === 'cancel') controller.abort(); else dispose(); return value })
    await expect(invoke('edit', { expectedRevision: revision, operations: [{ type: 'delete-nodes', ids: ['a'] }] })).rejects.toMatchObject({ outcome: 'not-applied' })
    expect(vault.write).not.toHaveBeenCalled()
  })

  it('retains dirty-editor refusal from the host without claiming a write', async () => {
    const { invoke, vault, mock } = setup()
    const { revision } = await invoke('inspect')
    vault.write.mockRejectedValueOnce(Object.assign(new Error('The editor has a dirty draft'), { code: 'DIRTY_EDITOR', outcome: 'not-applied' }))
    await expect(invoke('edit', { expectedRevision: revision, operations: [{ type: 'delete-nodes', ids: ['a'] }] })).rejects.toMatchObject({ code: 'DIRTY_EDITOR', outcome: 'not-applied' })
    expect(await mock.api.vault.readFile('Board.canvas')).toBe(original)
  })

  it('never repeats a write after a lost acknowledgement or failed verification', async () => {
    const { invoke, vault, mock } = setup()
    const { revision } = await invoke('inspect')
    const write = vault.write.getMockImplementation()!
    vault.write.mockImplementationOnce(async (...args) => { await write(...args); throw new Error('Acknowledgement lost') })
    await expect(invoke('edit', { expectedRevision: revision, operations: [{ type: 'delete-nodes', ids: ['a'] }] })).rejects.toMatchObject({ outcome: 'unknown', code: 'OUTCOME_UNKNOWN' })
    expect(vault.write).toHaveBeenCalledOnce()
    expect(JSON.parse(await mock.api.vault.readFile('Board.canvas') ?? '').nodes).toEqual([{ id: 'future', type: 'future', opaque: [null, 0] }])
    await expect(invoke('edit', { expectedRevision: revision, operations: [{ type: 'delete-nodes', ids: ['a'] }] })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(vault.write).toHaveBeenCalledOnce()
  })

  it('publishes the same required schemas used by the owning implementation', () => {
    expect(config.permissions).toMatchObject({ storage: { vault: true } })
    const service = config.runtime.services.find(item => item.id === 'command.document')!
    const commands = (service.metadata as { commands: Array<{ id: string; inputSchema: unknown; outputSchema: unknown; atomic?: boolean }> }).commands
    for (const [id, inputSchema, outputSchema] of [['document-inspect', canvasInspectInput, canvasInspectOutput], ['document-read', canvasReadInput, canvasReadOutput], ['document-create', canvasObservedInput, canvasMutationOutput], ['document-edit', canvasEditInput, canvasMutationOutput]]) expect(commands.find(item => item.id === id)).toMatchObject({ inputSchema, outputSchema })
    expect(commands.filter(item => item.atomic).map(item => item.id)).toEqual(['document-create', 'document-edit'])
  })
})
