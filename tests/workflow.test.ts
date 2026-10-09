import { describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi, PluginBackendOperationContext, WorkflowContributionContract } from '@valley/plugin-sdk'
import { bindings, register } from '../src/backend'
import config from '../config.json'

async function fixture() {
  const handlers = new Map<string, (input: unknown, context: PluginBackendOperationContext) => Promise<unknown>>()
  const commands = {
    describe: vi.fn(async (command: string) => {
      const binding = bindings.find(entry => entry.command === command)!
      return { id: command, owner: { id: `renderer:${command}`, generation: 'generation' }, location: 'renderer', autonomous: true, effect: binding.effect, schemaFingerprint: binding.schemaFingerprint, catalogIdentity: 'a'.repeat(64), schemaValidation: { status: 'supported', dialect: '2020-12' } }
    }),
    execute: vi.fn(async () => ({ id: '33333333-3333-4333-8333-333333333333', status: 'completed', revision: 3, result: { inspected: true } })),
    status: vi.fn(async () => ({ id: '33333333-3333-4333-8333-333333333333', status: 'completed', revision: 3, result: { inspected: true } })),
    cancelRequest: vi.fn(async () => {})
  }
  const payloads = { create: vi.fn(async () => ({ uploadId: 'upload', offset: 0 })), write: vi.fn(async () => ({ offset: 1 })), seal: vi.fn(async () => ({ id: '22222222-2222-4222-8222-222222222222' })), release: vi.fn(async () => {}) }
  const api = { pluginId: 'canvas', commands, payloads, schema: { compile: vi.fn(async () => ({ handle: 'schema', digest: 'digest' })), validate: vi.fn(async () => ({ valid: true, issues: [] })), release: vi.fn(async () => {}) }, rpc: { handleOperation: (method: string, handler: (input: unknown, context: PluginBackendOperationContext) => Promise<unknown>) => { handlers.set(method, handler); return () => handlers.delete(method) } } } as unknown as PluginBackendApi
  const dispose = register(api)
  const context = { id: '11111111-1111-4111-8111-111111111111', cancellation: new AbortController().signal, api } as PluginBackendOperationContext
  const catalog = await handlers.get('workflow.catalog')!({}, context) as WorkflowContributionContract
  return { handlers, commands, payloads, catalog, context, dispose }
}

describe('explicit Workflow owner integration', () => {
  it('discovers only curated blocks without executing them and releases registrations', async () => {
    const f = await fixture()
    expect(f.catalog.providerId).toBe('canvas')
    expect(f.catalog.nodes.map(node => node.id)).toEqual(bindings.map(binding => binding.nodeId))
    expect(f.commands.execute).not.toHaveBeenCalled()
    expect(f.payloads.create).not.toHaveBeenCalled()
    expect(config.runtime.largeDataOperations).toContain('workflow.execute')
    f.dispose(); expect(f.handlers.size).toBe(0)
  })
  it('executes the explicit owner command in the chosen window and retains its receipt', async () => {
    const f = await fixture()
    const result = await f.handlers.get('workflow.execute')!({ nodeTypeId: 'canvas.get', parameters: { targetWindowId: 4, path: 'Fern.canvas' }, items: [{ json: {} }] }, f.context)
    expect(f.commands.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'canvas:get', target: { windowId: 4 }, input: { path: 'Fern.canvas' }, idempotencyKey: f.context.id, checkpointId: '22222222-2222-4222-8222-222222222222' }), { cancellation: f.context.cancellation })
    expect(result).toMatchObject({ items: [{ json: { result: { inspected: true }, receipt: { status: 'completed' } }, pairedItem: { itemIndex: 0 } }] })
    f.dispose()
  })
})
