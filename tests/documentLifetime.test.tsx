import * as React from 'react'
import { flushSync } from 'react-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1, WORKSPACE_DETAILS_V1 } from '@valley/plugin-sdk'
import type { MountedPluginView, PluginEditorProvider, PluginFileDraftSnapshot } from '@valley/plugin-sdk'
import { withHostUi } from './support/hostUi'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime, type CanvasOwner } from '../src/runtime'
import { canvasDocument, existingCanvasDocument } from '../src/document'
import { canvasDraft, canvasSession, canvasMountedSession, subscribeCanvas } from '../src/session'
import { editCanvasTarget, registerCanvasCommands } from '../src/commands'
import * as canvasCommands from '../src/commands'
import { registerCanvasSurfaces } from '../src/surfaces'
import { serializeCanvas, parseCanvas, type CanvasData } from '../src/canvasModel'
import CanvasEditor from '../src/CanvasEditor'

/** A workspace tab: the file view renders the editor, not the embedded minimap. */
const TAB = { id: 'tab-1', kind: 'file', path: 'Test.canvas' }
import { NodeView, type NodeViewProps } from '../src/CanvasNode'

const original: CanvasData = { nodes: [{ id: 'a', type: 'text', text: 'Original', x: 0, y: 0, width: 200, height: 100 }], edges: [] }
const scene = (text: string): CanvasData => ({ ...original, nodes: [{ ...original.nodes[0], text }] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
const owners: CanvasOwner[] = []
function setup(data: CanvasData = original) {
  const mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas(data), 'Other.canvas': serializeCanvas(scene('Other')) } }))
  vi.spyOn(mock.api.vault, 'readFileBaseline')
  const owner = initRuntime(mock.api); owners.push(owner)
  return { mock, owner }
}
afterEach(async () => { await act(async () => { await Promise.all(owners.splice(0).map((owner) => owner.dispose())) }) })

async function ready(owner: CanvasOwner) {
  const document = canvasDocument(owner, 'Test.canvas')
  const detach = document.attach()
  await vi.waitFor(() => expect(document.get().ready).toBe(true))
  return { document, detach }
}

describe('mounted Canvas draft admission', () => {
  const view = (mountId: string): MountedPluginView => ({ mountId, generation: 1, area: 'main', paneId: mountId, tabId: mountId, filePath: 'Test.canvas', pluginId: 'canvas' })
  it.each([false, true])('reports its actual terminal draft after unregister with final dirty=%s and rejects late setters', async dirty => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    let provider!: PluginEditorProvider
    Object.assign(mock.api.vault, { editors: { register: (_view: MountedPluginView, value: PluginEditorProvider) => { provider = value; return () => {} }, save: vi.fn() } })
    const mounted = view('terminal'), raw = { revision: 0, dirty: false, active: true }
    const off = document.attachEditor(mounted, () => raw, () => {})
    expect(await provider.getSnapshot()).toMatchObject({ dirty: false, readiness: 'ready' })
    if (dirty) document.setData(scene('Final unreported'), mounted)
    raw.active = false
    off(); detach()
    const terminal = await provider.getSnapshot()
    expect(terminal).toMatchObject({ dirty, readiness: 'ready' })
    const final = document.get().data
    document.setData(scene('Late'), mounted); document.schedule(scene('Late'), mounted)
    expect(document.get().data).toEqual(final)
    expect(await provider.getSnapshot()).toEqual(terminal)
    expect(() => provider.prepare(terminal.revision, { operationId: 'late', fenceId: 'late', deadline: Date.now() + 5000, ownSave: false })).toThrow('changed or is unavailable')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })
  it('refuses an independent raw alias and freezes every shared model mutation until release', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    let provider!: PluginEditorProvider
    Object.assign(mock.api.vault, { editors: { register: (_view: MountedPluginView, value: PluginEditorProvider) => { provider = value; return () => {} }, save: vi.fn() } })
    const raw = { revision: 0, dirty: true, active: true }
    const freeze = vi.fn()
    const off = document.attachEditor(view('left'), () => raw, freeze)
    const dirty = await provider.getSnapshot()
    expect(dirty).toMatchObject({ dirty: true, readiness: 'ready' })
    expect(() => provider.prepare(dirty.revision, { operationId: 'background', fenceId: 'fence', deadline: Date.now() + 5000, ownSave: false })).toThrow('changed or is unavailable')
    raw.dirty = false; raw.revision++
    const clean = await provider.getSnapshot()
    const published = vi.fn()
    const unsubscribe = subscribeCanvas(published, owner)
    const lease = await provider.prepare(clean.revision, { operationId: 'background', fenceId: 'fence', deadline: Date.now() + 5000, ownSave: false })
    expect(published).toHaveBeenCalledTimes(1)
    document.setData(scene('Blocked'), view('left')); document.schedule(scene('Blocked'), view('left'))
    expect(document.get().data).toEqual(original)
    await expect(document.commit(scene('Blocked'), serializeCanvas(original))).rejects.toThrow('read-only')
    expect(await lease.validate()).toEqual(clean)
    expect(freeze).toHaveBeenLastCalledWith(true)
    const beforeRelease = published.mock.calls.length
    await lease.release()
    expect(freeze).toHaveBeenLastCalledWith(false)
    // Controls derive from the frozen state, so a lease change republishes them; the host keeps the last published copy.
    expect(published.mock.calls.length).toBeGreaterThan(beforeRelease)
    unsubscribe()
    off(); detach()
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })
  it('saves the exact pending mounted payload while an unchanged shared copy stays clean', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    const providers = new Map<string, PluginEditorProvider>()
    const write = mock.api.vault.writeFileGuarded
    const save = vi.fn(async (target: MountedPluginView, content: string, expected: Parameters<typeof write>[2], revision: string) => {
      const source = providers.get(target.mountId)!
      const own = await source.prepare(revision, { operationId: 'save', fenceId: 'own', deadline: Date.now() + 5000, ownSave: true })
      const other = providers.get('right')!
      const observed = await other.getSnapshot()
      expect(observed).toMatchObject({ dirty: false, readiness: 'ready' })
      const opposite = await other.prepare(observed.revision, { operationId: 'save', fenceId: 'own', deadline: Date.now() + 5000, ownSave: false })
      try { await own.validate(); await opposite.validate(); return await write(target.filePath, content, expected) }
      finally { await opposite.release(); await own.release() }
    })
    Object.assign(mock.api.vault, { editors: { register: (target: MountedPluginView, value: PluginEditorProvider) => { providers.set(target.mountId, value); return () => { providers.delete(target.mountId) } }, save } })
    const left = view('left'), right = view('right')
    const offLeft = document.attachEditor(left, () => ({ revision: 0, dirty: false, active: true }), () => {})
    const offRight = document.attachEditor(right, () => ({ revision: 0, dirty: false, active: true }), () => {})
    document.setData(scene('Exact pending'), left); document.schedule(document.get().data, left)
    await document.flush()
    expect(save).toHaveBeenCalledOnce()
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ text: 'Exact pending' })
    expect(await providers.get('left')!.getSnapshot()).toMatchObject({ dirty: false })
    offLeft(); offRight(); detach()
  })
})

describe('durable Canvas recovery', () => {
  it('holds fresh API hydration until the predecessor journal physically settles', async () => {
    const fileDrafts = new Map<string, PluginFileDraftSnapshot>()
    const options = { manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas(original) }, fileDrafts }
    const first = withHostUi(createMockValleyApi(options))
    const owner = initRuntime(first.api); owners.push(owner)
    const { document, detach } = await ready(owner)
    const held = deferred<void>()
    const write = first.api.vault.drafts.write
    const journal = vi.spyOn(first.api.vault.drafts, 'write').mockImplementationOnce(async (...args) => { await held.promise; return write(...args) })
    document.setData(scene('Held recovery')); document.schedule(document.get().data)
    await vi.waitFor(() => expect(journal).toHaveBeenCalledOnce())
    const fresh = withHostUi(createMockValleyApi(options))
    const read = vi.spyOn(fresh.api.vault.drafts, 'read')
    const replacement = initRuntime(fresh.api); owners.push(replacement)
    const recovered = canvasDocument(replacement, 'Test.canvas')
    const close = recovered.attach()
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
    expect(recovered.get().ready).toBe(false)
    held.resolve()
    await vi.waitFor(() => expect(recovered.get().ready).toBe(true))
    expect(recovered.get().data.nodes[0]).toMatchObject({ text: 'Held recovery' })
    detach(); close()
  })

  it('recovers a fresh runtime with its original baseline and clears after saving exact content', async () => {
    const fileDrafts = new Map<string, PluginFileDraftSnapshot>()
    const options = { manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas(original) }, fileDrafts }
    const first = withHostUi(createMockValleyApi(options))
    const owner = initRuntime(first.api); owners.push(owner)
    const { document, detach } = await ready(owner)
    document.setData(scene('Recovered ä ö ü')); document.schedule(document.get().data)
    detach(); await owner.dispose()
    expect(fileDrafts.size).toBe(1)
    expect(first.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    const fresh = withHostUi(createMockValleyApi(options))
    const replacement = initRuntime(fresh.api); owners.push(replacement)
    const { document: recovered, detach: close } = await ready(replacement)
    expect(recovered.get().data.nodes[0]).toMatchObject({ text: 'Recovered ä ö ü' })
    await recovered.flushPending()
    expect(await fresh.api.vault.readFile('Test.canvas')).toContain('Recovered ä ö ü')
    expect(fileDrafts.size).toBe(0)
    close()
  })

  it('coalesces the newest accepted edit into durable recovery before its owner drains', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    const held = deferred<void>()
    const write = mock.api.vault.drafts.write
    const journal = vi.spyOn(mock.api.vault.drafts, 'write').mockImplementationOnce(async (...args) => { await held.promise; return write(...args) })
    document.setData(scene('First')); document.schedule(document.get().data)
    await vi.waitFor(() => expect(journal).toHaveBeenCalledOnce())
    for (let index = 0; index < 20; index++) { document.setData(scene(`Newest ${index}`)); document.schedule(document.get().data) }
    detach()
    const ended = vi.fn()
    const disposing = owner.dispose().then(ended)
    await Promise.resolve()
    expect(ended).not.toHaveBeenCalled()
    held.resolve()
    await disposing
    expect(journal).toHaveBeenCalledTimes(2)
    expect((await mock.api.vault.drafts.read('Test.canvas', 'editor'))?.draft.content).toContain('Newest 19')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('never enables edits or file writes when recovery cannot be read', async () => {
    const { mock, owner } = setup()
    vi.spyOn(mock.api.vault.drafts, 'read').mockRejectedValue(new Error('Journal unavailable'))
    const document = canvasDocument(owner, 'Test.canvas')
    const detach = document.attach()
    await vi.waitFor(() => expect(document.get().error).toContain('Journal unavailable'))
    document.setData(scene('Unsafe')); document.schedule(document.get().data)
    expect(document.get().ready).toBe(false)
    expect(mock.api.vault.readFileBaseline).not.toHaveBeenCalled()
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    detach()
  })

  it('retains newer journal data and blocks automatic retries after conflict', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    await mock.api.vault.drafts.write('Test.canvas', 'editor', { content: 'Another session', baseline: null }, null)
    const read = vi.spyOn(mock.api.vault.drafts, 'read')
    document.setData(scene('Local preserved')); document.schedule(document.get().data)
    await expect(document.flushPending()).rejects.toThrow('another session')
    await expect(document.flush()).rejects.toThrow('another session')
    expect(read).not.toHaveBeenCalled()
    expect(document.get().data.nodes[0]).toMatchObject({ text: 'Local preserved' })
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    detach()
  })

  it('blocks detached commands on persisted recovery from another runtime', async () => {
    const { mock } = setup()
    await mock.api.vault.drafts.write('Test.canvas', 'editor', { content: serializeCanvas(scene('Saved draft')), baseline: null }, null)
    await expect(editCanvasTarget(mock.api, 'Test.canvas', { type: 'delete-nodes', ids: ['a'] }, serializeCanvas(original))).rejects.toThrow('unsaved draft')
    expect(mock.api.vault.readFileBaseline).not.toHaveBeenCalled()
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('keeps an uncertain journal commit and never repeats it automatically', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    const write = mock.api.vault.drafts.write
    const journal = vi.spyOn(mock.api.vault.drafts, 'write').mockImplementationOnce(async (...args) => {
      await write(...args)
      throw Object.assign(new Error('Journal acknowledgement lost'), { outcomeUnknown: true, retryable: false })
    })
    document.setData(scene('Uncertain preserved')); document.schedule(document.get().data)
    await expect(document.flushPending()).rejects.toThrow('acknowledgement lost')
    await expect(document.flush()).rejects.toThrow('acknowledgement lost')
    expect(journal).toHaveBeenCalledOnce()
    expect((await mock.api.vault.drafts.read('Test.canvas', 'editor'))?.draft.content).toContain('Uncertain preserved')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    detach()
  })
})

describe('captured Canvas document authority', () => {
  it('shares the draft and one guarded save across simultaneous panes, retaining the remaining bridge', async () => {
    const { mock } = setup()
    const first = render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    const second = render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    await waitFor(() => expect(screen.getAllByText('Original')).toHaveLength(2))
    expect(mock.api.vault.readFileBaseline).toHaveBeenCalledTimes(1)
    fireEvent.doubleClick(within(first.container).getByText('Original'))
    const input = within(first.container).getByDisplayValue('Original')
    fireEvent.change(input, { target: { value: 'Shared draft' } }); fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.getAllByText('Shared draft')).toHaveLength(2))
    second.unmount()
    expect(canvasSession('Test.canvas')?.get().data.nodes[0]).toMatchObject({ text: 'Shared draft' })
    await act(async () => { await editCanvasTarget(mock.api, 'Test.canvas', { type: 'update-node', id: 'a', values: { x: 72 } }, canvasSession('Test.canvas')!.get().revision) })
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ text: 'Shared draft', x: 72 })
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
    first.unmount()
    expect(canvasSession('Test.canvas')).toBeUndefined()
  })

  it('does not register an unapplied UI undo while a command has synchronously reserved the document', async () => {
    const { mock, owner } = setup()
    render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    await screen.findByText('Original')
    vi.spyOn(mock.api.ui, 'openMenu')
    fireEvent.contextMenu(document.querySelector('.canvas-root')!)
    const items = vi.mocked(mock.api.ui.openMenu).mock.calls.at(-1)![0]
    const add = items.find((item) => 'label' in item && item.label === 'Add card')!
    expect(add).toBeDefined()
    const held = deferred<void>()
    const write = mock.api.vault.writeFileGuarded
    vi.spyOn(mock.api.vault, 'writeFileGuarded').mockImplementationOnce(async (...args) => { await held.promise; return write(...args) })
    let commit!: Promise<void>
    act(() => {
      commit = canvasDocument(owner, 'Test.canvas').commit(scene('Command'), serializeCanvas(original))
      if ('onSelect' in add) void add.onSelect?.()
    })
    expect(mock.undoActions).toHaveLength(0)
    await act(async () => { held.resolve(); await commit })
    expect(await screen.findByText('Command')).toBeTruthy()
  })

  it('drains an accepted read but stops its invalidation loop and publication after repeated disposal', async () => {
    const { mock, owner } = setup()
    const file = await mock.api.vault.readFileBaseline('Test.canvas')
    const pending = deferred<typeof file>()
    vi.mocked(mock.api.vault.readFileBaseline).mockClear().mockImplementationOnce(() => pending.promise)
    const document = canvasDocument(owner, 'Test.canvas')
    const changed = vi.fn(); document.subscribe(changed)
    const detach = document.attach()
    await vi.waitFor(() => expect(mock.api.vault.readFileBaseline).toHaveBeenCalledTimes(1))
    mock.emitVaultChanged({ changes: [{ relPath: 'Test.canvas', kind: 'change' }] })
    let settled = false
    const closing = owner.dispose().then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    pending.resolve(file); await closing; await owner.dispose(); detach(); detach()
    expect(document.get().ready).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(mock.api.vault.readFileBaseline).toHaveBeenCalledTimes(1)
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('recovers a newer dirty edit through the new owner after its predecessor write settles and refuses queued saves', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    const write = mock.api.vault.writeFileGuarded
    const held = deferred<void>()
    vi.spyOn(mock.api.vault, 'writeFileGuarded').mockImplementationOnce(async (...args) => { await held.promise; return write(...args) })
    document.setData(scene('First')); document.schedule(document.get().data)
    const first = document.flush()
    await vi.waitFor(() => expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1))
    document.setData(scene('Newest')); document.schedule(document.get().data)
    const queued = document.flush().catch((reason: unknown) => reason)
    const replacement = initRuntime(mock.api); owners.push(replacement)
    const reopened = canvasDocument(replacement, 'Test.canvas'); const close = reopened.attach()
    expect(reopened.get().ready).toBe(false)
    held.resolve(); await first
    expect(String(await queued)).toContain('no longer active')
    await vi.waitFor(() => expect(reopened.get().ready).toBe(true))
    expect(reopened.get().data.nodes[0]).toMatchObject({ text: 'Newest' })
    expect(canvasDraft('Test.canvas', replacement)?.data.nodes[0]).toMatchObject({ text: 'Newest' })
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
    await reopened.flushPending()
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ text: 'Newest' })
    expect(canvasDraft('Test.canvas', replacement)).toBeUndefined()
    detach(); close()
  })

  it('retains recovery across a vault A to B to A generation without sending old work to B', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    document.setData(scene('Recovery')); document.schedule(document.get().data)
    const vault = mock.api.getState().vault
    mock.emitState({ vault: { ...vault, path: '/fixture-other' } as NonNullable<typeof vault> })
    mock.emitState({ vault })
    expect(owner.isActive()).toBe(false)
    await expect(document.flush()).rejects.toThrow('no longer active')
    const replacement = initRuntime(mock.api); owners.push(replacement)
    const { document: recovered, detach: close } = await ready(replacement)
    expect(recovered.get().data.nodes[0]).toMatchObject({ text: 'Recovery' })
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    detach(); close()
  })

  it('keeps a newer edit when reload confirmation or disk read settles late', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    document.setData(scene('Draft')); document.schedule(document.get().data)
    const confirm = deferred<string>()
    const reload = document.reload(() => confirm.promise, () => true)
    document.setData(scene('During confirmation')); document.schedule(document.get().data)
    confirm.resolve('reload'); expect(await reload).toBe(false)
    expect(mock.api.vault.readFileBaseline).toHaveBeenCalledTimes(1)
    const file = await mock.api.vault.readFileBaseline('Test.canvas')
    const held = deferred<typeof file>()
    vi.mocked(mock.api.vault.readFileBaseline).mockImplementationOnce(() => held.promise)
    const reading = document.reload(async () => 'reload', () => true)
    await vi.waitFor(() => expect(mock.api.vault.readFileBaseline).toHaveBeenCalledTimes(3))
    document.setData(scene('During read')); document.schedule(document.get().data)
    held.resolve(file); expect(await reading).toBe(false)
    expect(document.get().data.nodes[0]).toMatchObject({ text: 'During read' })
    detach()
  })

  it('invalidates a pending confirmation without making disposal wait for user input', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    const held = deferred<string>()
    let mounted = true
    const confirm = vi.fn(() => held.promise)
    const reload = document.reload(confirm, () => mounted)
    mounted = false; detach()
    await owner.dispose()
    held.resolve('reload')
    expect(await reload).toBe(false)
    expect(mock.api.vault.readFileBaseline).toHaveBeenCalledTimes(1)
    expect(await document.reload(confirm, () => false)).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('keeps uncertain write failures as recoverable drafts and never retries them during unload', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    document.setData(scene('Keep me')); document.schedule(document.get().data)
    vi.mocked(mock.api.vault.writeFileGuarded).mockRejectedValueOnce(new Error('Acknowledgement lost'))
    await expect(document.flush()).rejects.toThrow('Acknowledgement lost')
    await expect(mock.runBeforeUnload()).rejects.toThrow('Acknowledgement lost')
    detach()
    expect(existingCanvasDocument(owner, 'Test.canvas')).toBe(document)
    const reopened = document.attach()
    await vi.waitFor(() => expect(document.get().ready).toBe(true))
    expect(document.get().data.nodes[0]).toMatchObject({ text: 'Keep me' })
    expect(canvasDraft('Test.canvas', owner)?.error).toContain('Acknowledgement lost')
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
    reopened()
  })

  it('releases clean closed documents without blocking unload on an unedited missing file', async () => {
    const { mock, owner } = setup()
    const { detach } = await ready(owner)
    detach(); await Promise.resolve()
    expect(existingCanvasDocument(owner, 'Test.canvas')).toBeUndefined()
    vi.mocked(mock.api.vault.readFileBaseline).mockResolvedValueOnce(null)
    const missing = canvasDocument(owner, 'Missing.canvas'); const close = missing.attach()
    await vi.waitFor(() => expect(missing.get().error).not.toBe(''))
    await expect(mock.runBeforeUnload()).resolves.toBeUndefined()
    close(); await Promise.resolve()
    expect(existingCanvasDocument(owner, 'Missing.canvas')).toBeUndefined()
  })

  it('waits for replacement draft hydration before the new before-unload flush', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    document.setData(scene('Recovered')); document.schedule(document.get().data)
    const replacement = initRuntime(mock.api); owners.push(replacement)
    const file = await mock.api.vault.readFileBaseline('Test.canvas')
    const held = deferred<typeof file>()
    vi.mocked(mock.api.vault.readFileBaseline).mockImplementationOnce(() => held.promise)
    const reopened = canvasDocument(replacement, 'Test.canvas'); const close = reopened.attach()
    let settled = false
    const unloading = mock.runBeforeUnload().then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    held.resolve(file); await unloading
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ text: 'Recovered' })
    expect(canvasDraft('Test.canvas', replacement)).toBeUndefined()
    detach(); close()
  })

  it('preserves an accepted command write on revoke without later publication or retries', async () => {
    const { mock, owner } = setup()
    const { document, detach } = await ready(owner)
    const write = mock.api.vault.writeFileGuarded
    const held = deferred<void>()
    vi.spyOn(mock.api.vault, 'writeFileGuarded').mockImplementationOnce(async (...args) => { await held.promise; return write(...args) })
    const commit = document.commit(scene('Accepted'), serializeCanvas(original))
    await vi.waitFor(() => expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1))
    const listener = vi.fn(); document.subscribe(listener)
    const closing = owner.dispose()
    held.resolve(); await commit; await closing
    expect(listener).not.toHaveBeenCalled()
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ text: 'Accepted' })
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
    detach()
  })
})

describe('command, Properties and undo lifetimes', () => {
  it('captures operation values before a delayed read and rejects revoked command callbacks without I/O', async () => {
    const { mock, owner } = setup()
    const off = registerCanvasCommands(mock.api, owner)
    const command = mock.commands.find((entry) => entry.id === 'edit')!
    const file = await mock.api.vault.readFileBaseline('Test.canvas')
    const held = deferred<typeof file>()
    vi.mocked(mock.api.vault.readFileBaseline).mockImplementationOnce(() => held.promise)
    const operation = { type: 'update-node', id: 'a', values: { text: 'Accepted input' } }
    const editing = editCanvasTarget(mock.api, 'Test.canvas', operation, serializeCanvas(original))
    operation.values.text = 'Aliased mutation'; held.resolve(file)
    const result = await editing
    expect(result.value.data.nodes[0]).toMatchObject({ text: 'Accepted input' })
    off(); vi.mocked(mock.api.vault.readFileBaseline).mockClear(); vi.mocked(mock.api.vault.writeFileGuarded).mockClear()
    await expect(command.run({ path: 'Test.canvas', operation }, { caller: 'plugin' })).rejects.toThrow('no longer registered')
    expect(mock.api.vault.readFileBaseline).not.toHaveBeenCalled(); expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('reports uncertain creation after owner revocation without opening or retrying it', async () => {
    const { mock, owner } = setup()
    const off = registerCanvasCommands(mock.api, owner)
    const write = mock.api.vault.writeFileGuarded
    const held = deferred<void>()
    vi.spyOn(mock.api.vault, 'writeFileGuarded').mockImplementationOnce(async (...args) => { await held.promise; return write(...args) })
    const observation = await mock.api.commands.execute('canvas:create-observe', { path: 'Untitled.canvas' })
    const command = mock.commands.find(entry => entry.id === 'create')!
    const create = Promise.resolve(command.run(command.input!.parse(observation.ok ? observation.value : {}), { caller: 'plugin' })).catch((error: unknown) => error)
    await vi.waitFor(() => expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1))
    off(); held.resolve()
    expect(await create).toMatchObject({ outcome: 'unknown', code: 'OUTCOME_UNKNOWN' })
    expect(await mock.api.vault.readFile('Untitled.canvas')).toBeTruthy()
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
    expect(mock.busUndo).toHaveLength(0)
  })

  it('does not dispatch a write or open from held command/surface reads after their registration is revoked', async () => {
    const { mock, owner } = setup()
    const offCommands = registerCanvasCommands(mock.api, owner)
    const offSurfaces = registerCanvasSurfaces(mock.api, owner)
    const command = mock.commands.find((entry) => entry.id === 'edit')!
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
    const file = await mock.api.vault.readFileBaseline('Test.canvas')
    const held = deferred<typeof file>()
    vi.mocked(mock.api.vault.readFileBaseline).mockImplementation(() => held.promise)
    const edit = Promise.resolve(command.run({ path: 'Test.canvas', operation: { type: 'delete-nodes', ids: ['a'] } }, { caller: 'plugin' })).catch((reason: unknown) => reason)
    const open = Promise.resolve(surface.restore!({ v: 1, path: 'Test.canvas' })).catch((reason: unknown) => reason)
    offCommands(); offSurfaces(); held.resolve(file)
    expect(String(await edit)).toContain('no longer registered'); expect(String(await open)).toContain('no longer registered')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled(); expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
  })

  it('routes UI undo to a reopened pane and refuses to overwrite intervening external work', async () => {
    const { mock } = setup()
    const first = render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    fireEvent.doubleClick(await screen.findByText('Original'))
    const input = screen.getByDisplayValue('Original')
    fireEvent.change(input, { target: { value: 'Edited' } }); fireEvent.keyDown(input, { key: 'Escape' })
    await act(async () => { await mock.runBeforeUnload() })
    const undo = mock.undoActions.at(-1)!
    first.unmount()
    const next = render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    await screen.findByText('Edited')
    await act(async () => { await undo.undo() })
    expect(await screen.findByText('Original')).toBeTruthy()
    next.unmount()
    await mock.api.vault.writeFile('Test.canvas', serializeCanvas(scene('External')))
    await expect(undo.redo!()).rejects.toThrow('newer work')
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ text: 'External' })
  })

  it('does not publish stale Properties results into a replacement target or allow saved inputs to write after revoke', async () => {
    const { mock, owner } = setup()
    const off = registerCanvasSurfaces(mock.api, owner)
    const metadata = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
    const file = await mock.api.vault.readFileBaseline('Test.canvas')
    const held = deferred<typeof file>()
    vi.mocked(mock.api.vault.readFileBaseline).mockImplementationOnce(() => held.promise)
    const subject = { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas', nodeIds: ['a'] } } as const
    const properties = render(<>{metadata.render!({ kind: 'unsupported', subject, relPath: 'Test.canvas' })}</>)
    properties.rerender(<>{metadata.render!({ kind: 'unsupported', subject: { ...subject, view: { path: 'Other.canvas', nodeIds: ['a'] } }, relPath: 'Other.canvas' })}</>)
    await screen.findByText('Other')
    await act(async () => { held.resolve(file) })
    expect(screen.queryByText('Original')).toBeNull()
    const input = screen.getByLabelText('X position')
    fireEvent.change(input, { target: { value: '22' } })
    off(); fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no longer registered'))
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    properties.unmount()
  })
})

describe('Canvas preview ownership', () => {
  function preview() {
    const mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Fern.md': 'Fern preview' } }))
    const owner = initRuntime(mock.api); owners.push(owner)
    let intersect!: (value: boolean) => void
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { intersect = value => this.callback([{ target, isIntersecting: value } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
    })
    const props: NodeViewProps = {
      owner, previewEnabled: true,
      node: { id: 'fern', type: 'file', file: 'Fern.md', x: 0, y: 0, width: 200, height: 100 },
      index: 0, selected: false, focused: false, editing: false, dragging: false, zoom: 1, readOnly: false,
      onNodePointerDown: vi.fn(), onResizeStart: vi.fn(), onConnectStart: vi.fn(), onStartEdit: vi.fn(), onCommit: vi.fn(), onCancelEdit: vi.fn()
    }
    return { mock, owner, props, intersect: (value: boolean) => intersect(value) }
  }

  it('loads only visible rich previews and refreshes only relevant vault changes', async () => {
    const { mock, props, intersect } = preview()
    const read = vi.spyOn(mock.api.vault, 'readFileBaseline')
    const mounted = render(<NodeView {...props} />)
    try {
      expect(read).not.toHaveBeenCalled()
      await act(async () => intersect(true))
      expect(await screen.findByText('Fern preview')).toBeTruthy()
      expect(read).toHaveBeenCalledOnce()
      await act(async () => mock.emitVaultChanged({ changes: [{ relPath: 'Other.md', kind: 'change' }] }))
      expect(read).toHaveBeenCalledOnce()
      act(() => intersect(false))
      await act(async () => mock.emitVaultChanged({ changes: [{ relPath: 'Fern.md', kind: 'change' }] }))
      expect(read).toHaveBeenCalledOnce()
      mounted.rerender(<NodeView {...props} previewEnabled={false} />)
      await act(async () => intersect(true))
      expect(read).toHaveBeenCalledOnce()
      mounted.rerender(<NodeView {...props} />)
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
      read.mockRejectedValueOnce(new Error('Preview read failed'))
      await act(async () => mock.emitVaultChanged({ changes: [{ relPath: 'Fern.md', kind: 'change' }] }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Preview read failed')
    } finally { mounted.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks() }
  })

  it('joins accepted preview reads after hiding the card and disposing its owner', async () => {
    const { mock, owner, props, intersect } = preview()
    const held = deferred<void>()
    const readFile = mock.api.vault.readFileBaseline
    const read = vi.spyOn(mock.api.vault, 'readFileBaseline').mockImplementationOnce(async path => { await held.promise; return readFile(path) })
    const mounted = render(<NodeView {...props} />)
    try {
      act(() => intersect(true))
      await waitFor(() => expect(read).toHaveBeenCalledOnce())
      act(() => intersect(false))
      const ended = vi.fn()
      let closing!: Promise<void>
      await act(async () => { closing = owner.dispose().then(ended); await Promise.resolve() })
      expect(ended).not.toHaveBeenCalled()
      await act(async () => { held.resolve(); await closing })
      expect(screen.queryByText('Fern preview')).toBeNull()
      expect(read).toHaveBeenCalledOnce()
    } finally { held.resolve(); mounted.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks() }
  })

  it('keeps the active text draft across visibility and detail-level changes', async () => {
    const { props, intersect } = preview()
    const node = { id: 'text', type: 'text' as const, text: 'Saved text', x: 0, y: 0, width: 200, height: 100 }
    const mounted = render(<NodeView {...props} node={node} editing />)
    try {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsaved ä ö ü draft' } })
      act(() => intersect(false))
      mounted.rerender(<NodeView {...props} node={node} editing previewEnabled={false} />)
      expect(screen.getByRole('textbox')).toHaveValue('Unsaved ä ö ü draft')
      mounted.rerender(<NodeView {...props} node={node} editing />)
      await act(async () => intersect(true))
      expect(screen.getByRole('textbox')).toHaveValue('Unsaved ä ö ü draft')
    } finally { mounted.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks() }
  })
})

it('fits a previously hidden editor on resize and preserves subsequent user pan and zoom', async () => {
  const { owner } = setup()
  let resize!: () => void
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  const mounted = render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
  try {
    await waitFor(() => expect(canvasSession('Test.canvas', owner)?.get().ready).toBe(true))
    expect(canvasSession('Test.canvas', owner)?.get().viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    const root = mounted.container.querySelector('.canvas-root')!
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, toJSON: () => ({}) })
    act(() => resize())
    expect(canvasSession('Test.canvas', owner)?.get().viewport).toEqual({ x: 300, y: 250, zoom: 1 })
    act(() => canvasSession('Test.canvas', owner)?.restore({ viewport: { x: 15, y: 20, zoom: 2 } }))
    act(() => resize())
    expect(canvasSession('Test.canvas', owner)?.get().viewport).toEqual({ x: 15, y: 20, zoom: 2 })
  } finally { mounted.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks() }
})

describe('exact Canvas mounted controls', () => {
  const left: MountedPluginView = { mountId: 'left-mount', generation: 1, area: 'main', paneId: 'left-pane', tabId: 'left-tab', filePath: 'Test.canvas', pluginId: 'canvas' }
  const right: MountedPluginView = { ...left, mountId: 'right-mount', paneId: 'right-pane', tabId: 'right-tab' }
  async function controls(data: CanvasData = original) {
    const { mock, owner } = setup(data)
    const off = registerCanvasSurfaces(mock.api, owner)
    const mounted = render(<><CanvasEditor key={left.mountId} relPath="Test.canvas" tab={{ id: left.tabId }} mountedView={left} /><CanvasEditor key={right.mountId} relPath="Test.canvas" tab={{ id: right.tabId }} mountedView={right} /></>)
    await waitFor(() => expect(canvasMountedSession(left, owner).get().ready && canvasMountedSession(right, owner).get().ready).toBe(true))
    const provider = mock.api.interop.extensions.providers(WORKSPACE_DETAILS_V1)[0].extension
    const context = (view: MountedPluginView) => ({ instanceId: view.tabId, filePath: view.filePath, selectedItemIds: ['zoom', 'fit', 'locked'], mountedView: view })
    return { mock, owner, provider, context, mounted, revoke: off, close: () => { mounted.unmount(); off() } }
  }
  const connected: CanvasData = { nodes: [...original.nodes, { id: 'b', type: 'text', text: 'Forest', x: 400, y: 0, width: 200, height: 100 }], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }] }
  async function change(fixture: Awaited<ReturnType<typeof controls>>, view: MountedPluginView, id: string, value?: string | number | boolean) {
    const observed = fixture.provider.getSnapshot(fixture.context(view))
    await act(async () => { await fixture.provider.invokeAutomation!(fixture.context(view), id, value, { expectedRevision: observed.revision!, validateBeforeEffect: async () => {} }) })
    return fixture.provider.getSnapshot(fixture.context(view))
  }
  it('selects exact cards and connections, pans each axis and clears without moving focus, changing bytes or the other locked copy', async () => {
    const fixture = await controls(connected)
    const push = vi.spyOn(fixture.mock.api.undo, 'push')
    const writing = render(<input aria-label="Writing" defaultValue="Unsaved ä ö ü" />)
    try {
      await change(fixture, right, 'locked', true)
      const other = canvasMountedSession(right, fixture.owner).get(), bytes = await fixture.mock.api.vault.readFile('Test.canvas')
      const input = screen.getByLabelText('Writing') as HTMLInputElement
      input.focus(); input.setSelectionRange(2, 7)
      expect(fixture.provider.automation?.actions).toMatchObject({ 'select-node': { type: 'string', maxLength: 256 }, 'select-edge': { type: 'string', maxLength: 256 }, 'clear-selection': { type: 'button' }, 'viewport-x': { type: 'number' }, 'viewport-y': { type: 'number' }, 'fit-selection': { type: 'button' } })
      const node = await change(fixture, left, 'select-node', 'b')
      expect(node.items['select-node'].value).toBe('b')
      expect(fixture.mounted.container.querySelectorAll('.canvas-root')[0].querySelector('[data-node-id="b"]')).toHaveClass('is-selected')
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      expect(await metadata.inspect!({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'id', value: 'b' })]))
      await change(fixture, left, 'viewport-x', -23.5)
      await change(fixture, left, 'viewport-y', 0)
      expect(canvasMountedSession(left, fixture.owner).get().viewport).toEqual({ x: -23.5, y: 0, zoom: 1 })
      expect(fixture.mounted.container.querySelector('.canvas-world')).toHaveStyle({ transform: 'translate(-23.5px, 0px) scale(1)' })
      const edge = await change(fixture, left, 'select-edge', 'ab')
      expect(edge.items['select-edge'].value).toBe('ab'); expect(edge.items.selected.value).toBe(0)
      expect(fixture.mounted.container.querySelector('.canvas-edge[data-edge-id="ab"]')).toHaveClass('is-focused')
      expect(await metadata.inspect!({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'id', value: 'ab' })]))
      await change(fixture, left, 'clear-selection')
      expect(canvasMountedSession(left, fixture.owner).get()).toMatchObject({ nodeIds: [], edgeId: null })
      expect(fixture.provider.getSnapshot(fixture.context(left)).items['fit-selection'].disabled).toBe(true)
      expect(canvasMountedSession(right, fixture.owner).get()).toEqual(other)
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(bytes)
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(7); expect(input.value).toBe('Unsaved ä ö ü')
    } finally { writing.unmount(); fixture.close() }
  })
  it('fits exact card and connection selections through the same owner as the existing selection menu', async () => {
    const fixture = await controls(connected)
    try {
      const root = fixture.mounted.container.querySelector('.canvas-root')!
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, toJSON: () => ({}) })
      await change(fixture, left, 'select-node', 'b')
      await change(fixture, left, 'fit-selection')
      expect(canvasMountedSession(left, fixture.owner).get().viewport).toEqual({ x: -100, y: 250, zoom: 1 })
      await change(fixture, left, 'select-edge', 'ab')
      await change(fixture, left, 'fit-selection')
      expect(canvasMountedSession(left, fixture.owner).get().viewport).toEqual({ x: 100, y: 250, zoom: 1 })
      await change(fixture, left, 'viewport-x', 5)
      fireEvent.click(within(root as HTMLElement).getByLabelText('Zoom to selection'))
      expect(canvasMountedSession(left, fixture.owner).get().viewport).toEqual({ x: 100, y: 250, zoom: 1 })
      expect(canvasMountedSession(right, fixture.owner).get().viewport).toEqual({ x: 0, y: 0, zoom: 1 })
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    } finally { fixture.close(); vi.restoreAllMocks() }
  })
  it('controls an unfocused copy while the other card keeps its editor, selection and unsaved text', async () => {
    const fixture = await controls(connected)
    try {
      const other = fixture.mounted.container.querySelectorAll('.canvas-root')[1] as HTMLElement
      fireEvent.doubleClick(within(other).getByText('Forest'))
      const input = await within(other).findByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(input, { target: { value: 'Still typing ä ö ü' } }); input.setSelectionRange(2, 8)
      const editor = input, before = canvasMountedSession(right, fixture.owner).get()
      await change(fixture, left, 'select-node', 'a')
      await change(fixture, left, 'viewport-x', 19)
      await change(fixture, left, 'viewport-y', -31)
      await change(fixture, left, 'clear-selection')
      expect(within(other).getByRole('textbox')).toBe(editor)
      expect(document.activeElement).toBe(editor); expect(editor.selectionStart).toBe(2); expect(editor.selectionEnd).toBe(8)
      expect(editor.value).toBe('Still typing ä ö ü'); expect(canvasMountedSession(right, fixture.owner).get()).toEqual(before)
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(connected))
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled(); expect(fixture.mock.undoActions).toHaveLength(0)
    } finally { fixture.close() }
  })
  it('publishes current editability after a command settles and returns editable Properties beside a locked copy', async () => {
    const data: CanvasData = { ...connected, nodes: connected.nodes.map(node => ({ ...node, untouched: { enabled: false, value: null } })), extra: { untouched: ['ä', 0, ''] } }
    const fixture = await controls(data)
    let inspector: ReturnType<typeof render> | undefined, lockedInspector: ReturnType<typeof render> | undefined
    let off = () => {}
    const held = deferred<void>(), entered = deferred<void>(), controller = new AbortController()
    let pending: Promise<unknown> | undefined
    try {
      await change(fixture, left, 'select-node', 'a')
      await change(fixture, right, 'locked', true)
      act(() => canvasMountedSession(right, fixture.owner).restore({ nodeIds: ['a'] }))
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      inspector = render(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left }))
      lockedInspector = render(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: right }))
      const width = await within(inspector.container).findByLabelText('Width')
      await within(lockedInspector.container).findByText('200')
      await act(async () => { width.focus() })
      const command = fixture.mock.commands.find(entry => entry.id === 'properties-edit')!
      const input = command.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas', nodeIds: ['a'], edgeId: null }, mountedView: left }, expectedRevision: canvasMountedSession(left, fixture.owner).get().revision, values: { x: 17 } })
      await act(async () => { pending = Promise.resolve(command.run(input, { caller: 'agent', cancellation: controller.signal, validateBeforeRun: async () => { entered.resolve(); await held.promise; return true } })); await entered.promise })
      expect(canvasDocument(fixture.owner, 'Test.canvas').get().busy).toBe(true)
      expect(canvasMountedSession(left, fixture.owner).get().readOnly).toBe(true)
      expect(within(inspector.container).queryByLabelText('Width')).toBe(width)
      expect(document.activeElement).toBe(width)
      const settled: boolean[] = []
      off = subscribeCanvas(() => { if (!canvasDocument(fixture.owner, 'Test.canvas').get().busy) settled.push(canvasMountedSession(left, fixture.owner).get().readOnly) }, fixture.owner)
      await act(async () => { held.resolve(); await pending })
      expect(settled.length).toBeGreaterThan(0)
      expect(settled).not.toContain(true)
      expect(await within(inspector.container).findByLabelText('Width')).toBe(width)
      expect(width).not.toBeDisabled()
      expect(document.activeElement).toBe(width)
      expect(within(lockedInspector.container).queryByLabelText('Width')).toBeNull()
      expect(canvasMountedSession(right, fixture.owner).get()).toMatchObject({ locked: true, readOnly: true, nodeIds: ['a'] })
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ x: 17, width: 200 })
      expect(fixture.mock.api.vault.writeFileGuarded).toHaveBeenCalledOnce()
      await act(async () => { fireEvent.change(width, { target: { value: '260' } }); fireEvent.blur(width) })
      await waitFor(async () => expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ x: 17, width: 260 }))
      await waitFor(() => expect(width).not.toBeDisabled())
      expect(await within(inspector.container).findByLabelText('Width')).toBe(width)
      expect(within(inspector.container).queryByRole('alert')).toBeNull()
      expect(fixture.mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(2)
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas'))).toEqual({ ...data, nodes: data.nodes.map(node => node.id === 'a' ? { ...node, x: 17, width: 260 } : node) })
    } finally { controller.abort(); held.resolve(); await pending?.catch(() => {}); off(); inspector?.unmount(); lockedInspector?.unmount(); fixture.close() }
  })
  it('leaves the last published controls equal to the settled state after a Properties command edit', async () => {
    const fixture = await controls(connected)
    const published: boolean[] = []
    const off = subscribeCanvas(() => { published.push(fixture.provider.getSnapshot(fixture.context(left)).items.zoom.disabled === true) }, fixture.owner)
    try {
      await change(fixture, left, 'select-node', 'a')
      const command = fixture.mock.commands.find(entry => entry.id === 'properties-edit')!
      const input = command.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas', nodeIds: ['a'], edgeId: null }, mountedView: left }, expectedRevision: canvasMountedSession(left, fixture.owner).get().revision, values: { x: 17 } })
      published.length = 0
      await act(async () => { await command.run(input, { caller: 'agent', cancellation: new AbortController().signal, validateBeforeRun: async () => true }) })
      await waitFor(() => expect(fixture.provider.getSnapshot(fixture.context(left)).items.zoom.disabled).toBe(false))
      expect(published).toContain(true)
      expect(published.at(-1)).toBe(false)
    } finally { off(); fixture.close() }
  })
  it('preserves an edited Properties field through an overlapping command and refuses its stale save', async () => {
    const fixture = await controls(connected)
    let inspector: ReturnType<typeof render> | undefined
    const held = deferred<void>(), entered = deferred<void>(), controller = new AbortController()
    let pending: Promise<unknown> | undefined
    try {
      await change(fixture, left, 'select-node', 'a')
      await change(fixture, right, 'locked', true)
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      inspector = render(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left }))
      const width = await within(inspector.container).findByLabelText('Width') as HTMLInputElement
      await act(async () => { width.focus(); fireEvent.change(width, { target: { value: '260' } }) })
      const command = fixture.mock.commands.find(entry => entry.id === 'properties-edit')!
      const input = command.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas', nodeIds: ['a'], edgeId: null }, mountedView: left }, expectedRevision: canvasMountedSession(left, fixture.owner).get().revision, values: { width: 240 } })
      await act(async () => { pending = Promise.resolve(command.run(input, { caller: 'agent', cancellation: controller.signal, validateBeforeRun: async () => { entered.resolve(); await held.promise; return true } })); await entered.promise })
      expect(within(inspector.container).getByLabelText('Width')).toBe(width)
      expect(document.activeElement).toBe(width); expect(width).toHaveValue(260)
      await act(async () => { held.resolve(); await pending })
      expect(within(inspector.container).getByLabelText('Width')).toBe(width)
      expect(document.activeElement).toBe(width); expect(width).toHaveValue(260)
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0].width).toBe(240)
      await act(async () => { fireEvent.blur(width) })
      await within(inspector.container).findByRole('alert')
      expect(within(inspector.container).getByLabelText('Width')).toBe(width)
      expect(width).toHaveValue(260); expect(width).not.toBeDisabled()
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0].width).toBe(240)
      expect(canvasMountedSession(right, fixture.owner).get()).toMatchObject({ locked: true, readOnly: true })
      expect(canvasMountedSession(right, fixture.owner).get().data.nodes[0].width).toBe(240)
      expect(fixture.mock.api.vault.writeFileGuarded).toHaveBeenCalledOnce()
    } finally { controller.abort(); held.resolve(); await pending?.catch(() => {}); inspector?.unmount(); fixture.close() }
  })
  it.each(['failure', 'cancellation'] as const)('restores current Properties editability after command %s and retains a focused draft and locked copy', async (outcome) => {
    const fixture = await controls(connected)
    let inspector: ReturnType<typeof render> | undefined, lockedInspector: ReturnType<typeof render> | undefined
    let off = () => {}
    const held = deferred<void>(), entered = deferred<void>(), controller = new AbortController()
    let pending: Promise<unknown> | undefined
    try {
      await change(fixture, left, 'select-node', 'a')
      await change(fixture, right, 'locked', true)
      act(() => canvasMountedSession(right, fixture.owner).restore({ nodeIds: ['a'] }))
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      inspector = render(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left }))
      lockedInspector = render(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: right }))
      const width = await within(inspector.container).findByLabelText('Width') as HTMLInputElement
      await within(lockedInspector.container).findByText('200')
      await act(async () => { width.focus(); fireEvent.change(width, { target: { value: '260' } }) })
      const command = fixture.mock.commands.find(entry => entry.id === 'properties-edit')!
      const input = command.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas', nodeIds: ['a'], edgeId: null }, mountedView: left }, expectedRevision: canvasMountedSession(left, fixture.owner).get().revision, values: { x: 17 } })
      if (outcome === 'failure') vi.spyOn(fixture.mock.api.vault, 'writeFileGuarded').mockRejectedValueOnce(new Error('Save unavailable'))
      await act(async () => { pending = Promise.resolve(command.run(input, { caller: 'agent', cancellation: controller.signal, validateBeforeRun: async () => { entered.resolve(); await held.promise; return true } })).catch(error => error); await entered.promise })
      expect(canvasDocument(fixture.owner, 'Test.canvas').get().busy).toBe(true)
      expect(within(inspector.container).queryByLabelText('Width')).toBe(width)
      expect(document.activeElement).toBe(width); expect(width).toHaveValue(260)
      const settled: boolean[] = []
      off = subscribeCanvas(() => { if (!canvasDocument(fixture.owner, 'Test.canvas').get().busy) settled.push(canvasMountedSession(left, fixture.owner).get().readOnly) }, fixture.owner)
      if (outcome === 'cancellation') controller.abort()
      let result: unknown
      await act(async () => { held.resolve(); result = await pending })
      expect(String(result)).toContain(outcome === 'failure' ? 'Save unavailable' : 'cancelled')
      expect(settled.length).toBeGreaterThan(0); expect(settled).not.toContain(true)
      expect(await within(inspector.container).findByLabelText('Width')).toBe(width)
      expect(document.activeElement).toBe(width); expect(width).toHaveValue(260); expect(width).not.toBeDisabled()
      const observed = fixture.provider.getSnapshot(fixture.context(left))
      await expect(fixture.provider.invokeAutomation!(fixture.context(left), 'clear-selection', undefined, { expectedRevision: observed.revision!, validateBeforeEffect: async () => {} })).rejects.toMatchObject({ code: 'VIEWER_BUSY', outcome: 'not-applied' })
      expect(within(lockedInspector.container).queryByLabelText('Width')).toBeNull()
      expect(canvasMountedSession(right, fixture.owner).get()).toMatchObject({ locked: true, readOnly: true, nodeIds: ['a'] })
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(connected))
      expect(fixture.mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0)
    } finally { controller.abort(); held.resolve(); await pending?.catch(() => {}); off(); inspector?.unmount(); lockedInspector?.unmount(); fixture.close() }
  })
  it('retains an exact Properties draft and blocks controls until its accepted save settles', async () => {
    const fixture = await controls(connected)
    let inspector: ReturnType<typeof render> | undefined
    try {
      await change(fixture, left, 'select-node', 'a')
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      inspector = render(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left }))
      const width = await within(inspector.container).findByLabelText('Width') as HTMLInputElement
      await act(async () => { width.focus(); fireEvent.change(width, { target: { value: '260' } }) })
      const refused = fixture.provider.getSnapshot(fixture.context(left))
      expect(refused.items['select-node'].disabled).toBe(true)
      await expect(fixture.provider.invokeAutomation!(fixture.context(left), 'select-node', 'b', { expectedRevision: refused.revision!, validateBeforeEffect: async () => {} })).rejects.toMatchObject({ code: 'VIEWER_BUSY', outcome: 'not-applied' })
      expect(document.activeElement).toBe(width); expect(width).toHaveValue(260)
      await change(fixture, right, 'viewport-x', 32)
      const held = deferred<void>(), entered = deferred<void>(), execute = fixture.mock.api.commands.executeOwn
      const saving = vi.spyOn(fixture.mock.api.commands, 'executeOwn').mockImplementationOnce(async (...args) => { entered.resolve(); await held.promise; return execute(...args) })
      await act(async () => { fireEvent.blur(width); await entered.promise })
      const busy = fixture.provider.getSnapshot(fixture.context(left))
      expect(width).toBeDisabled()
      await expect(fixture.provider.invokeAutomation!(fixture.context(left), 'viewport-y', 12, { expectedRevision: busy.revision!, validateBeforeEffect: async () => {} })).rejects.toMatchObject({ code: 'VIEWER_BUSY', outcome: 'not-applied' })
      expect(canvasMountedSession(left, fixture.owner).get()).toMatchObject({ nodeIds: ['a'], viewport: { y: 0 } })
      await act(async () => { held.resolve(); await saving.mock.results[0].value })
      await waitFor(() => expect(width).not.toBeDisabled())
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0].width).toBe(260)
      expect(canvasMountedSession(right, fixture.owner).get().viewport.x).toBe(32)
      await change(fixture, left, 'select-node', 'b')
    } finally { inspector?.unmount(); fixture.close() }
  })
  it('rejects stale control revisions and deleted targets without changing another copy or replaying a selection', async () => {
    const fixture = await controls(connected)
    try {
      const first = fixture.provider.getSnapshot(fixture.context(left))
      await change(fixture, left, 'select-node', 'b')
      const selected = canvasMountedSession(left, fixture.owner).get()
      await expect(fixture.provider.invokeAutomation!(fixture.context(left), 'clear-selection', undefined, { expectedRevision: first.revision!, validateBeforeEffect: async () => {} })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
      expect(canvasMountedSession(left, fixture.owner).get()).toEqual(selected)
      const held = deferred<void>(), entered = deferred<void>()
      const pending = Promise.resolve(fixture.provider.invokeAutomation!(fixture.context(right), 'select-node', 'b', { expectedRevision: fixture.provider.getSnapshot(fixture.context(right)).revision!, validateBeforeEffect: async () => { entered.resolve(); await held.promise } })).catch(error => error)
      act(() => canvasDocument(fixture.owner, 'Test.canvas').setData(original))
      await entered.promise; held.resolve()
      expect(await pending).toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
      expect(canvasMountedSession(right, fixture.owner).get().nodeIds).toEqual([])
      await expect(fixture.provider.invokeAutomation!(fixture.context(left), 'fit-selection', undefined, { expectedRevision: fixture.provider.getSnapshot(fixture.context(left)).revision!, validateBeforeEffect: async () => {} })).rejects.toMatchObject({ code: 'CANVAS_TARGET_NOT_FOUND', outcome: 'not-applied' })
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    } finally { fixture.close() }
  })
  it.each([['select-node', 'missing', 'CANVAS_TARGET_NOT_FOUND'], ['select-edge', 'missing', 'CANVAS_TARGET_NOT_FOUND'], ['select-node', '', 'INVALID_ARGUMENT'], ['select-edge', 'x'.repeat(257), 'INVALID_ARGUMENT'], ['viewport-x', Infinity, 'INVALID_ARGUMENT'], ['viewport-y', NaN, 'INVALID_ARGUMENT'], ['clear-selection', false, 'INVALID_ARGUMENT'], ['fit-selection', undefined, 'CANVAS_TARGET_NOT_FOUND']] as const)('refuses invalid %s input before authorization or effects', async (id, value, code) => {
    const fixture = await controls(connected)
    try {
      const before = canvasMountedSession(left, fixture.owner).get(), validateBeforeEffect = vi.fn(async () => {})
      await expect(fixture.provider.invokeAutomation!(fixture.context(left), id, value, { expectedRevision: before.viewRevision!, validateBeforeEffect })).rejects.toMatchObject({ code, outcome: 'not-applied' })
      expect(validateBeforeEffect).not.toHaveBeenCalled(); expect(canvasMountedSession(left, fixture.owner).get()).toEqual(before)
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    } finally { fixture.close() }
  })
  it.each([null, Object.assign(new Error('Uncertain host validation'), { outcomeUnknown: true })])('preserves a host validation refusal without changing the view', async rejection => {
    const fixture = await controls(connected)
    try {
      const before = canvasMountedSession(left, fixture.owner).get()
      const result = Promise.resolve(fixture.provider.invokeAutomation!(fixture.context(left), 'select-node', 'b', { expectedRevision: before.viewRevision!, validateBeforeEffect: async () => { throw rejection } })).catch(error => error)
      expect(await result).toMatchObject(rejection ? { outcomeUnknown: true } : { outcome: 'not-applied' })
      expect(canvasMountedSession(left, fixture.owner).get()).toEqual(before)
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    } finally { fixture.close() }
  })
  it('refuses card edits, pointer gestures, dialogs and an accepted document commit without discarding their state', async () => {
    const fixture = await controls(connected)
    try {
      const root = fixture.mounted.container.querySelector('.canvas-root')!
      const refuse = async () => {
        const before = canvasMountedSession(left, fixture.owner).get()
        expect(fixture.provider.getSnapshot(fixture.context(left)).items['select-node'].disabled).toBe(true)
        for (const [id, value] of [['select-node', 'b'], ['viewport-x', 24], ['clear-selection', undefined], ['fit-selection', undefined]] as const) await expect(fixture.provider.invokeAutomation!(fixture.context(left), id, value, { expectedRevision: before.viewRevision!, validateBeforeEffect: async () => {} })).rejects.toMatchObject({ code: 'VIEWER_BUSY', outcome: 'not-applied' })
        expect(canvasMountedSession(left, fixture.owner).get()).toEqual(before)
      }
      fireEvent.doubleClick(within(root as HTMLElement).getByText('Original'))
      const draft = await within(root as HTMLElement).findByRole('textbox')
      fireEvent.change(draft, { target: { value: 'Retained local ä ö ü draft' } })
      await refuse(); expect(draft).toHaveValue('Retained local ä ö ü draft')
      fireEvent.keyDown(draft, { key: 'Escape' })
      fireEvent.pointerDown(root, { button: 0, pointerId: 21, clientX: 20, clientY: 20 })
      await refuse(); expect(canvasMountedSession(left, fixture.owner).get().controlsBlocked).toBe(true)
      fireEvent.pointerCancel(root, { pointerId: 21 })
      await act(async () => { fireEvent.click(within(root as HTMLElement).getByLabelText('Drag to add note from vault')) })
      await refuse(); expect(within(root as HTMLElement).getByRole('dialog')).toBeTruthy()
      fireEvent.click(within(root as HTMLElement).getByLabelText('Close'))
      const data = canvasMountedSession(left, fixture.owner).get().data, held = deferred<void>(), entered = deferred<void>()
      let pending!: Promise<unknown>
      await act(async () => { pending = canvasDocument(fixture.owner, 'Test.canvas').commit(data, serializeCanvas(data), async () => { entered.resolve(); await held.promise }); await entered.promise })
      await refuse(); held.resolve(); await act(async () => { await pending })
    } finally { fixture.close() }
  })
  it.each(['editing', 'gesture', 'modal', 'selection', 'pan', 'cancel', 'authorization', 'mount', 'provider', 'owner'] as const)('rechecks %s after the host validation await before changing the exact selection', async reason => {
    const fixture = await controls(connected)
    try {
      const before = fixture.provider.getSnapshot(fixture.context(left)), held = deferred<void>(), entered = deferred<void>()
      const pending = fixture.provider.invokeAutomation!(fixture.context(left), 'select-node', 'b', { expectedRevision: before.revision!, validateBeforeEffect: async () => { entered.resolve(); await held.promise; if (reason === 'cancel' || reason === 'authorization') throw new Error(reason) } })
      const result = Promise.resolve(pending).catch(error => error)
      await entered.promise
      const root = fixture.mounted.container.querySelector('.canvas-root')!
      if (reason === 'editing') fireEvent.doubleClick(within(root as HTMLElement).getByText('Original'))
      if (reason === 'gesture') fireEvent.pointerDown(root, { button: 0, pointerId: 22, clientX: 20, clientY: 20 })
      if (reason === 'modal') await act(async () => { fireEvent.click(within(root as HTMLElement).getByLabelText('Drag to add note from vault')) })
      if (reason === 'selection') act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      if (reason === 'pan') act(() => canvasMountedSession(left, fixture.owner).restore({ viewport: { x: 10, y: 20, zoom: 1 } }))
      if (reason === 'mount') fixture.close()
      if (reason === 'provider') fixture.revoke()
      if (reason === 'owner') await act(async () => { await fixture.owner.dispose() })
      held.resolve()
      expect(await result).toMatchObject({ outcome: 'not-applied' })
      if (!['mount', 'provider', 'owner'].includes(reason)) expect(canvasMountedSession(left, fixture.owner).get().nodeIds).not.toEqual(['b'])
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    } finally { fixture.close() }
  })
  it('changes only the observed copy and preserves shared unsaved content', async () => {
    const fixture = await controls()
    try {
      const document = canvasDocument(fixture.owner, 'Test.canvas')
      act(() => { document.setData(scene('Unsaved shared ä ö ü')); document.schedule(document.get().data) })
      const observed = fixture.provider.getSnapshot(fixture.context(left))
      const validateBeforeEffect = vi.fn(async () => {})
      await act(async () => { await fixture.provider.invokeAutomation!(fixture.context(left), 'zoom', 1.5, { expectedRevision: observed.revision!, validateBeforeEffect }) })
      expect(validateBeforeEffect).toHaveBeenCalledOnce()
      expect(canvasMountedSession(left, fixture.owner).get().viewport.zoom).toBe(1.5)
      expect(canvasMountedSession(right, fixture.owner).get().viewport.zoom).toBe(1)
      expect(canvasMountedSession(right, fixture.owner).get().data.nodes[0]).toMatchObject({ text: 'Unsaved shared ä ö ü' })
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
      await expect(fixture.provider.invokeAutomation!(fixture.context(left), 'zoom', 1, { expectedRevision: observed.revision!, validateBeforeEffect })).rejects.toThrow('changed')
      await expect(fixture.provider.invokeAutomation!(fixture.context({ ...left, generation: 2 }), 'zoom', 1, { expectedRevision: observed.revision!, validateBeforeEffect })).rejects.toThrow('exact Canvas')
    } finally { fixture.close() }
  })
  it('rechecks exact owner, local state and authorization after asynchronous validation', async () => {
    const fixture = await controls()
    try {
      const observed = fixture.provider.getSnapshot(fixture.context(left))
      const held = deferred<void>(), entered = deferred<void>()
      const pending = fixture.provider.invokeAutomation!(fixture.context(left), 'zoom', 2, { expectedRevision: observed.revision!, validateBeforeEffect: async () => { entered.resolve(); await held.promise } })
      await entered.promise
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      held.resolve()
      await expect(pending).rejects.toThrow('changed')
      expect(canvasMountedSession(left, fixture.owner).get().viewport.zoom).toBe(1)
      const current = fixture.provider.getSnapshot(fixture.context(left))
      await expect(fixture.provider.invokeAutomation!(fixture.context(left), 'locked', true, { expectedRevision: current.revision!, validateBeforeEffect: async () => { throw new Error('Revoked') } })).rejects.toThrow('Revoked')
      expect(canvasMountedSession(left, fixture.owner).get().locked).toBe(false)
      const waiting = deferred<void>(), dispatched = deferred<void>()
      const closing = fixture.provider.invokeAutomation!(fixture.context(left), 'zoom', 2, { expectedRevision: current.revision!, validateBeforeEffect: async () => { dispatched.resolve(); await waiting.promise } })
      await dispatched.promise
      fixture.close(); waiting.resolve()
      await expect(closing).rejects.toThrow()
    } finally { fixture.close() }
  })
  it('renders an unavailable exact Properties view after only its source closes and retains its field draft for the new subject', async () => {
    const fixture = await controls(connected)
    let inspector: ReturnType<typeof render> | undefined
    class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false }
      static getDerivedStateFromError() { return { failed: true } }
      render() { return this.state.failed ? <p role="alert">Properties render failed</p> : this.props.children }
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await change(fixture, left, 'select-node', 'a')
      await change(fixture, right, 'locked', true)
      act(() => canvasMountedSession(right, fixture.owner).restore({ nodeIds: ['b'] }))
      const rightBefore = canvasMountedSession(right, fixture.owner).get()
      const observed = fixture.provider.getSnapshot(fixture.context(left))
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      const content = (view: MountedPluginView) => <Boundary>{metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: view })}</Boundary>
      inspector = render(content(left))
      const width = await within(inspector.container).findByLabelText('Width') as HTMLInputElement
      await act(async () => { width.focus(); fireEvent.change(width, { target: { value: '260' } }) })
      await act(async () => { fixture.mounted.rerender(<><CanvasEditor key={right.mountId} relPath="Test.canvas" tab={{ id: right.tabId }} mountedView={right} /></>) })
      expect(await within(inspector.container).findByRole('status')).toHaveTextContent('The exact Canvas view is unavailable.')
      expect(within(inspector.container).queryByLabelText('Width')).toBeNull()
      expect(within(inspector.container).queryByText('Forest')).toBeNull()
      expect(canvasMountedSession(right, fixture.owner).get()).toMatchObject({ viewport: rightBefore.viewport, nodeIds: ['b'], locked: true })
      await expect(fixture.provider.invokeAutomation!(fixture.context(left), 'zoom', 2, { expectedRevision: observed.revision!, validateBeforeEffect: async () => {} })).rejects.toThrow('exact Canvas')
      const replacement = { ...left, mountId: `${left.mountId}-replacement`, generation: left.generation + 1 }
      await act(async () => { fixture.mounted.rerender(<><CanvasEditor key={left.mountId} relPath="Test.canvas" tab={{ id: left.tabId }} mountedView={replacement} /><CanvasEditor key={right.mountId} relPath="Test.canvas" tab={{ id: right.tabId }} mountedView={right} /></>) })
      await waitFor(() => expect(canvasMountedSession(replacement, fixture.owner).get().ready).toBe(true))
      act(() => canvasMountedSession(replacement, fixture.owner).restore({ nodeIds: ['a'] }))
      expect(within(inspector.container).getByRole('status')).toHaveTextContent('The exact Canvas view is unavailable.')
      inspector.rerender(content(replacement))
      const restored = await within(inspector.container).findByLabelText('Width') as HTMLInputElement
      expect(restored).toHaveValue(260)
      const registrations = vi.mocked(fixture.mock.api.vault.editors.register).mock.calls
      expect(await registrations.find(([view]) => view.mountId === left.mountId)![1].getSnapshot()).toMatchObject({ dirty: true })
      expect(await registrations.find(([view]) => view.mountId === replacement.mountId)![1].getSnapshot()).toMatchObject({ dirty: true })
      expect(canvasMountedSession(right, fixture.owner).get()).toMatchObject({ nodeIds: ['b'], locked: true })
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(connected))
      expect(errors).not.toHaveBeenCalled()
    } finally { inspector?.unmount(); fixture.close(); errors.mockRestore() }
  })
  it.each(['command', 'native-blur'] as const)('refuses a stale Properties %s when its exact source closes after the awaited final guard', async route => {
    const fixture = await controls(connected)
    let inspector: ReturnType<typeof render> | undefined
    let armed = false, closed = false
    let failure: unknown
    const command = fixture.mock.commands.find(entry => entry.id === 'properties-edit')!
    const run = command.run
    const admitted = vi.spyOn(command, 'run').mockImplementation(async (input, context) => {
      try { return await run(input, { ...context, validateBeforeRun: async () => { armed = true; return true } }) }
      catch (reason) { failure = reason; throw reason }
    })
    const dispatched = vi.spyOn(fixture.mock.api.commands, 'executeOwn')
    const write = fixture.mock.api.vault.writeFileGuarded, mountedAtWrite: boolean[] = []
    const writes = vi.spyOn(fixture.mock.api.vault, 'writeFileGuarded').mockImplementation((...args) => {
      try { canvasMountedSession(left, fixture.owner); mountedAtWrite.push(true) } catch { mountedAtWrite.push(false) }
      return write(...args)
    })
    const session = canvasMountedSession(left, fixture.owner), get = session.get
    const reads = vi.spyOn(session, 'get').mockImplementation(() => {
      const state = get()
      if (armed && canvasDocument(fixture.owner, 'Test.canvas').get().busy) {
        armed = false
        queueMicrotask(() => {
          flushSync(() => fixture.mounted.rerender(<><CanvasEditor key={right.mountId} relPath="Test.canvas" tab={{ id: right.tabId }} mountedView={right} /></>))
          closed = true
        })
      }
      return state
    })
    try {
      await change(fixture, left, 'select-node', 'a')
      await change(fixture, right, 'locked', true)
      const rightBefore = canvasMountedSession(right, fixture.owner).get()
      if (route === 'native-blur') {
        const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
        inspector = render(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left }))
        const width = await within(inspector.container).findByLabelText('Width')
        await act(async () => { width.focus(); fireEvent.change(width, { target: { value: '260' } }) })
        await act(async () => { fireEvent.blur(width); await dispatched.mock.results[0].value })
      } else {
        const input = command.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas', nodeIds: ['a'], edgeId: null }, mountedView: left }, expectedRevision: session.get().revision, values: { width: 260 } })
        await act(async () => { await Promise.resolve(command.run(input, { caller: 'agent' })).catch(reason => { failure = reason }) })
      }
      const source = await fixture.mock.api.vault.readFile('Test.canvas')
      expect(closed).toBe(true)
      expect({ mountedAtWrite, persistedWidth: parseCanvas(source).nodes[0].width, completed: failure === undefined }).toEqual({ mountedAtWrite: [], persistedWidth: connected.nodes[0].width, completed: false })
      expect(failure).toMatchObject({ outcome: 'not-applied' })
      expect(writes).not.toHaveBeenCalled()
      expect(source).toBe(serializeCanvas(connected))
      expect(canvasMountedSession(right, fixture.owner).get()).toMatchObject({ viewport: rightBefore.viewport, nodeIds: rightBefore.nodeIds, locked: true })
      if (route === 'native-blur') {
        const replacement = { ...left, mountId: `${left.mountId}-replacement`, generation: left.generation + 1 }
        await act(async () => { fixture.mounted.rerender(<><CanvasEditor key={left.mountId} relPath="Test.canvas" tab={{ id: left.tabId }} mountedView={replacement} /><CanvasEditor key={right.mountId} relPath="Test.canvas" tab={{ id: right.tabId }} mountedView={right} /></>) })
        await waitFor(() => expect(canvasMountedSession(replacement, fixture.owner).get().ready).toBe(true))
        act(() => canvasMountedSession(replacement, fixture.owner).restore({ nodeIds: ['a'] }))
        const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
        inspector!.rerender(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: replacement }))
        expect(await within(inspector!.container).findByLabelText('Width')).toHaveValue(260)
        expect(writes).not.toHaveBeenCalled()
        expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(source)
      }
    } finally { armed = false; reads.mockRestore(); writes.mockRestore(); dispatched.mockRestore(); admitted.mockRestore(); inspector?.unmount(); fixture.close() }
  })
  it.each(['selection', 'cancellation', 'generation'] as const)('rechecks Properties %s synchronously after the final awaited guard', async changed => {
    const fixture = await controls(connected)
    const cancellation = new AbortController()
    let armed = false, invalidated = false
    const session = canvasMountedSession(left, fixture.owner), get = session.get
    const reads = vi.spyOn(session, 'get').mockImplementation(() => {
      const state = get()
      if (armed && canvasDocument(fixture.owner, 'Test.canvas').get().busy) {
        armed = false
        queueMicrotask(() => {
          if (changed === 'cancellation') cancellation.abort()
          else flushSync(() => {
            if (changed === 'selection') session.restore({ nodeIds: ['b'] })
            else fixture.mounted.rerender(<><CanvasEditor key={left.mountId} relPath="Test.canvas" tab={{ id: left.tabId }} mountedView={{ ...left, mountId: `${left.mountId}-replacement`, generation: left.generation + 1 }} /><CanvasEditor key={right.mountId} relPath="Test.canvas" tab={{ id: right.tabId }} mountedView={right} /></>)
          })
          invalidated = true
        })
      }
      return state
    })
    try {
      await change(fixture, left, 'select-node', 'a')
      await change(fixture, right, 'locked', true)
      const rightBefore = canvasMountedSession(right, fixture.owner).get()
      const command = fixture.mock.commands.find(entry => entry.id === 'properties-edit')!
      const input = command.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas', nodeIds: ['a'], edgeId: null }, mountedView: left }, expectedRevision: session.get().revision, values: { width: 260 } })
      let failure: unknown
      await act(async () => { await Promise.resolve(command.run(input, { caller: 'agent', cancellation: cancellation.signal, validateBeforeRun: async () => { armed = true; return true } })).catch(reason => { failure = reason }) })
      expect(invalidated).toBe(true)
      expect(failure).toMatchObject({ outcome: 'not-applied' })
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(connected))
      expect(canvasMountedSession(right, fixture.owner).get()).toMatchObject({ viewport: rightBefore.viewport, nodeIds: rightBefore.nodeIds, locked: true })
    } finally { armed = false; reads.mockRestore(); fixture.close() }
  })
  it('ignores a late Properties refresh from a closed mount after a new exact subject has rendered', async () => {
    const data = { ...connected, nodes: connected.nodes.map(node => node.id === 'b' ? { ...node, width: 320 } : node) }
    const fixture = await controls(data)
    let inspector: ReturnType<typeof render> | undefined
    const held = deferred<void>(), entered = deferred<void>(), read = canvasCommands.readCanvasTarget
    const refresh = vi.spyOn(canvasCommands, 'readCanvasTarget').mockImplementationOnce(async (...args) => { const value = await read(...args); entered.resolve(); await held.promise; return value })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await change(fixture, left, 'select-node', 'a')
      await change(fixture, right, 'locked', true)
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      inspector = render(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left }))
      await entered.promise
      await act(async () => { fixture.mounted.rerender(<><CanvasEditor key={right.mountId} relPath="Test.canvas" tab={{ id: right.tabId }} mountedView={right} /></>) })
      expect(await within(inspector!.container).findByRole('status')).toHaveTextContent('The exact Canvas view is unavailable.')
      const replacement = { ...left, mountId: `${left.mountId}-replacement`, generation: left.generation + 1 }
      await act(async () => { fixture.mounted.rerender(<><CanvasEditor key={left.mountId} relPath="Test.canvas" tab={{ id: left.tabId }} mountedView={replacement} /><CanvasEditor key={right.mountId} relPath="Test.canvas" tab={{ id: right.tabId }} mountedView={right} /></>) })
      await waitFor(() => expect(canvasMountedSession(replacement, fixture.owner).get().ready).toBe(true))
      act(() => canvasMountedSession(replacement, fixture.owner).restore({ nodeIds: ['b'] }))
      inspector!.rerender(metadata.render({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: replacement }))
      const width = await within(inspector!.container).findByLabelText('Width')
      expect(width).toHaveValue(320)
      await act(async () => { held.resolve(); await refresh.mock.results[0].value })
      expect(within(inspector!.container).getByLabelText('Width')).toBe(width)
      expect(width).toHaveValue(320)
      expect(canvasMountedSession(right, fixture.owner).get().locked).toBe(true)
      expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(data))
      expect(errors).not.toHaveBeenCalled()
    } finally { held.resolve(); refresh.mockRestore(); inspector?.unmount(); fixture.close(); errors.mockRestore() }
  })
  it('inspects the exact Properties selection and rejects implicit path-only mutation', async () => {
    const fixture = await controls()
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      expect(await metadata.inspect!({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'id', value: 'a' })]))
      expect(await metadata.inspect!({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: right })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'selected', value: 0 })]))
      act(() => canvasMountedSession(right, fixture.owner).restore({ nodeIds: ['a'] }))
      const rightState = fixture.provider.getSnapshot(fixture.context(right))
      await act(async () => { await fixture.provider.invokeAutomation!(fixture.context(right), 'locked', true, { expectedRevision: rightState.revision!, validateBeforeEffect: async () => {} }) })
      act(() => canvasMountedSession(right, fixture.owner).restore({ nodeIds: ['a'] }))
      expect(await metadata.inspect!({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'x', readOnly: false })]))
      expect(await metadata.inspect!({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: right })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'x', readOnly: true })]))
      const command = fixture.mock.commands.find(entry => entry.id === 'properties-edit')!
      const input = command.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas', nodeIds: ['a'], edgeId: null }, mountedView: left }, expectedRevision: canvasMountedSession(left, fixture.owner).get().revision, values: { x: 3 } })
      await act(async () => { expect(await command.run(input, { caller: 'agent', validateBeforeRun: async () => true })).toMatchObject({ value: { data: { nodes: [{ x: 3 }] } } }) })
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0].x).toBe(3)
      expect(canvasMountedSession(right, fixture.owner).get().data.nodes[0].x).toBe(3)
      const lockedInput = command.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas', nodeIds: ['a'], edgeId: null }, mountedView: right }, expectedRevision: canvasMountedSession(right, fixture.owner).get().revision, values: { x: 4 } })
      await expect(command.run(lockedInput, { caller: 'agent', validateBeforeRun: async () => true })).rejects.toThrow()
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0].x).toBe(3)
      expect(() => command.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { path: 'Test.canvas' } }, expectedRevision: canvasMountedSession(left, fixture.owner).get().revision, values: { x: 3 } })).toThrow('exact mounted')
    } finally { fixture.close() }
  })
  async function action(fixture: Awaited<ReturnType<typeof controls>>, id: string, extra: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
    const state = canvasMountedSession(left, fixture.owner).get()
    const command = fixture.mock.commands.find(entry => entry.id === id)!
    const input = command.input!.parse({ mountedView: left, nodeIds: state.nodeIds, edgeId: state.edgeId, expectedViewRevision: state.viewRevision, expectedRevision: state.revision, ...extra })
    let result: unknown
    await act(async () => { result = await command.run(input, { caller: 'agent', validateBeforeRun: async () => true, ...context }) })
    return result
  }
  const layoutScene: CanvasData = { nodes: [
    { id: 'a', type: 'text', text: 'Meadow', x: 0, y: 0, width: 100, height: 60, color: '1', nativeExtra: { retained: true } },
    { id: 'b', type: 'text', text: 'Forest', x: 150, y: 20, width: 80, height: 40 },
    { id: 'c', type: 'text', text: 'Coast', x: 400, y: 150, width: 50, height: 30 }
  ], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', color: '2' }], extra: { untouched: true } }
  it.each([
    ['align-left', 'b', { x: 0 }], ['align-center', 'b', { x: 185 }], ['align-right', 'b', { x: 370 }],
    ['align-top', 'b', { y: 0 }], ['align-middle', 'b', { y: 70 }], ['align-bottom', 'b', { y: 140 }],
    ['arrange-horizontal', 'b', { x: 120, y: 0 }], ['arrange-vertical', 'b', { x: 0, y: 80 }], ['arrange-grid', 'b', { x: 120, y: 0 }],
    ['distribute-horizontal', 'b', { x: 210 }], ['distribute-vertical', 'b', { y: 85 }],
    ['justify-horizontal', 'b', { x: 0, width: 450 }], ['justify-vertical', 'b', { y: 0, height: 180 }]
  ])('persists the exact existing %s algorithm atomically and preserves unrelated bytes/state', async (id, target, expected) => {
    const fixture = await controls(layoutScene)
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a', 'b', 'c'] }))
      await change(fixture, right, 'locked', true)
      const other = canvasMountedSession(right, fixture.owner).get()
      await action(fixture, id as string)
      const saved = parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas'))
      expect(saved.nodes.find(node => node.id === target)).toMatchObject(expected as Record<string, unknown>)
      expect(saved.nodes[0].nativeExtra).toEqual({ retained: true }); expect(saved.extra).toEqual(layoutScene.extra); expect(saved.edges).toEqual(layoutScene.edges)
      expect(fixture.mock.api.vault.editors.save).toHaveBeenCalledOnce()
      expect(canvasMountedSession(right, fixture.owner).get()).toMatchObject({ viewport: other.viewport, nodeIds: other.nodeIds, locked: true })
    } finally { fixture.close() }
  })
  it('groups before its first member and exact history undo/redo preserves the shared document', async () => {
    const fixture = await controls(layoutScene)
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a', 'b'] }))
      await action(fixture, 'group-selection')
      const grouped = parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas'))
      expect(grouped.nodes[0]).toMatchObject({ type: 'group', x: -20, y: -20, width: 270, height: 100 })
      expect(grouped.nodes.slice(1).map(node => node.id)).toEqual(['a', 'b', 'c'])
      const session = canvasMountedSession(left, fixture.owner)
      await action(fixture, 'history-undo', { expectedHistoryRevision: session.history!().revision })
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas'))).toEqual(layoutScene)
      await action(fixture, 'history-redo', { expectedHistoryRevision: session.history!().revision })
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas'))).toEqual(grouped)
      await expect(action(fixture, 'history-undo', { expectedHistoryRevision: 'stale' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    } finally { fixture.close() }
  })
  it.each(['order-front', 'order-back', 'color-remove', 'line-direction-none', 'line-direction-one', 'line-direction-both', 'background-remove', 'background-style-cover', 'background-style-ratio', 'background-style-repeat'])('applies the selected %s native menu action without changing unknown fields', async id => {
    const data: CanvasData = { ...layoutScene, nodes: [...layoutScene.nodes, { id: 'group', type: 'group', x: -40, y: -40, width: 600, height: 300, background: 'Media/scene.png', backgroundStyle: 'ratio', opaque: 'preserved' }] }
    const fixture = await controls(data)
    try {
      const edgeAction = id.startsWith('line-'), background = id.startsWith('background-')
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: edgeAction ? [] : [background ? 'group' : 'a'], edgeId: edgeAction ? 'ab' : null }))
      await action(fixture, id)
      const saved = parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas'))
      if (id === 'order-front') expect(saved.nodes.at(-1)!.id).toBe('a')
      if (id === 'order-back') expect(saved.nodes[0].id).toBe('a')
      if (id === 'color-remove') expect(saved.nodes.find(node => node.id === 'a')).not.toHaveProperty('color')
      if (edgeAction) expect(saved.edges[0]).toMatchObject({ fromEnd: id.endsWith('both') ? 'arrow' : 'none', toEnd: id.endsWith('none') ? 'none' : 'arrow' })
      const group = saved.nodes.find(node => node.id === 'group')!
      if (id === 'background-remove') { expect(group).not.toHaveProperty('background'); expect(group).not.toHaveProperty('backgroundStyle') }
      if (id.startsWith('background-style-')) expect(group.backgroundStyle).toBe(id.slice(17))
      expect(group.opaque).toBe('preserved'); expect(saved.nodes.find(node => node.id === 'a')!.nativeExtra).toEqual({ retained: true })
    } finally { fixture.close() }
  })
  it('sets atomic multiple selection/full viewport, selects all and leaves focus/disk/opposite view unchanged', async () => {
    const fixture = await controls(layoutScene), writing = render(<input aria-label="Independent editor" defaultValue="Draft" />)
    try {
      const input = screen.getByLabelText('Independent editor') as HTMLInputElement; input.focus(); input.setSelectionRange(1, 3)
      const other = canvasMountedSession(right, fixture.owner).get(), bytes = await fixture.mock.api.vault.readFile('Test.canvas')
      await action(fixture, 'selection-set', { targetNodeIds: ['a', 'c'], targetEdgeId: null })
      expect(canvasMountedSession(left, fixture.owner).get().nodeIds).toEqual(['a', 'c'])
      await action(fixture, 'viewport-set', { viewport: { x: -21, y: 0, zoom: 2 } })
      expect(canvasMountedSession(left, fixture.owner).get().viewport).toEqual({ x: -21, y: 0, zoom: 2 })
      await action(fixture, 'selection-all')
      expect(canvasMountedSession(left, fixture.owner).get().nodeIds).toEqual(['a', 'b', 'c'])
      expect(canvasMountedSession(right, fixture.owner).get()).toEqual(other)
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(bytes)
      expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3])
      expect(fixture.mock.api.vault.editors.save).not.toHaveBeenCalled()
    } finally { writing.unmount(); fixture.close() }
  })
  it.each(['stale', 'denied', 'cancelled', 'locked', 'late-selection', 'late-viewport'])('refuses %s selection edits before any disk effect', async reason => {
    const fixture = await controls(layoutScene)
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a', 'b'] }))
      if (reason === 'locked') await change(fixture, left, 'locked', true)
      const command = fixture.mock.commands.find(entry => entry.id === 'align-left')!, state = canvasMountedSession(left, fixture.owner).get()
      const input = command.input!.parse({ mountedView: left, nodeIds: state.nodeIds, edgeId: state.edgeId, expectedRevision: state.revision, expectedViewRevision: reason === 'stale' ? 'stale' : state.viewRevision })
      const cancellation = new AbortController(); if (reason === 'cancelled') cancellation.abort()
      await act(async () => { await expect(command.run(input, { caller: 'agent', cancellation: cancellation.signal, validateBeforeRun: async () => { if (reason === 'late-selection') canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['b'] }); if (reason === 'late-viewport') canvasMountedSession(left, fixture.owner).restore({ viewport: { x: 9, y: 0, zoom: 1 } }); return reason !== 'denied' } })).rejects.toMatchObject({ outcome: 'not-applied' }) })
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene)); expect(fixture.mock.api.vault.editors.save).not.toHaveBeenCalled()
    } finally { fixture.close() }
  })
  it('exposes the actual raw Width draft through inspect/patch/discard/apply with exact revisions', async () => {
    const fixture = await controls(layoutScene)
    let inspector: ReturnType<typeof render> | undefined
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      inspector = render(metadata.render!({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left }))
      const width = await within(inspector.container).findByLabelText('Width')
      const raw = async (id: string, extra: Record<string, unknown> = {}) => { const command = fixture.mock.commands.find(entry => entry.id === `raw-properties-${id}`)!; const input = command.input!.parse({ mountedView: left, nodeIds: ['a'], edgeId: null, field: 'width', ...extra }); let result: any; await act(async () => { result = await command.run(input, { caller: 'agent', validateBeforeRun: async () => true }) }); return result }
      const first = await raw('inspect')
      expect(first).toMatchObject({ value: '100', dirty: false })
      const patched = await raw('patch', { expectedDraftRevision: first.revision, value: '260' })
      expect(width).toHaveValue(260); expect(patched.value).toMatchObject({ dirty: true, value: '260' })
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene))
      await expect(raw('discard', { expectedDraftRevision: first.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      await raw('discard', { expectedDraftRevision: patched.value.revision }); expect(width).toHaveValue(100)
      const next = await raw('inspect'), pending = await raw('patch', { expectedDraftRevision: next.revision, value: '260' })
      await raw('apply', { expectedDraftRevision: pending.value.revision })
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ width: 260, nativeExtra: { retained: true } })
      expect(await raw('inspect')).toMatchObject({ value: '260', dirty: false })
    } finally { inspector?.unmount(); fixture.close() }
  })

  it('copies/cuts explicit cards and pastes remapped internal edges through the host clipboard owner', async () => {
    const fixture = await controls(layoutScene)
    let clipboard = ''
    const native = { writeText: vi.fn(async () => { throw new Error('Iframe clipboard used') }), readText: vi.fn(async () => { throw new Error('Iframe clipboard used') }) }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: native })
    Object.assign(fixture.mock.api.ui, { writeClipboardText: vi.fn(async (text: string) => { clipboard = text }), readClipboardText: vi.fn(async () => clipboard) })
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a', 'b'] }))
      await action(fixture, 'clipboard-copy')
      expect(parseCanvas(clipboard).nodes.map(node => node.id)).toEqual(['a', 'b']); expect(parseCanvas(clipboard).edges.map(edge => edge.id)).toEqual(['ab'])
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene))
      await action(fixture, 'clipboard-paste', { at: { x: 600, y: 400 } })
      const saved = parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')), pasted = saved.nodes.slice(3)
      expect(pasted).toHaveLength(2); expect(pasted.map(node => node.id)).not.toEqual(['a', 'b'])
      expect(saved.edges[1]).toMatchObject({ fromNode: pasted[0].id, toNode: pasted[1].id })
      expect(pasted[0]).toMatchObject({ x: 485, y: 370, nativeExtra: { retained: true } })
      await action(fixture, 'clipboard-cut')
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas'))).toEqual(layoutScene)
      expect(parseCanvas(clipboard).nodes).toEqual(pasted)
      expect(native.writeText).not.toHaveBeenCalled(); expect(native.readText).not.toHaveBeenCalled()
    } finally { delete (navigator as { clipboard?: unknown }).clipboard; fixture.close() }
  })
  it('refuses Canvas clipboard actions as not applied when the host clipboard is absent or refuses', async () => {
    const fixture = await controls(layoutScene)
    const ui = fixture.mock.api.ui as { readClipboardText?: unknown; writeClipboardText?: unknown }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}), readText: vi.fn(async () => serializeCanvas(layoutScene)) } })
    try {
      delete ui.readClipboardText; delete ui.writeClipboardText
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      for (const id of ['clipboard-copy', 'clipboard-cut']) await expect(action(fixture, id)).rejects.toMatchObject({ code: 'CLIPBOARD_UNAVAILABLE', outcome: 'not-applied' })
      await expect(action(fixture, 'clipboard-paste', { at: { x: 0, y: 0 } })).rejects.toMatchObject({ code: 'CLIPBOARD_UNAVAILABLE', outcome: 'not-applied' })
      ui.writeClipboardText = vi.fn(async () => { throw Object.assign(new Error('Unfocused'), { code: 'CLIPBOARD_UNAVAILABLE', outcome: 'not-applied' }) })
      ui.readClipboardText = vi.fn(async () => { throw Object.assign(new Error('Unfocused'), { code: 'CLIPBOARD_UNAVAILABLE', outcome: 'not-applied' }) })
      await expect(action(fixture, 'clipboard-cut')).rejects.toMatchObject({ code: 'CLIPBOARD_UNAVAILABLE', outcome: 'not-applied' })
      await expect(action(fixture, 'clipboard-paste', { at: { x: 0, y: 0 } })).rejects.toMatchObject({ code: 'CLIPBOARD_UNAVAILABLE', outcome: 'not-applied' })
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene))
      expect(canvasMountedSession(left, fixture.owner).get().nodeIds).toEqual(['a'])
    } finally { delete (navigator as { clipboard?: unknown }).clipboard; fixture.close() }
  })
  it('reports an unknown cut if selection changes after the clipboard effect and preserves disk bytes', async () => {
    const fixture = await controls(layoutScene)
    Object.assign(fixture.mock.api.ui, { writeClipboardText: vi.fn(async () => { canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['b'] }) }) })
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      await expect(action(fixture, 'clipboard-cut')).rejects.toMatchObject({ outcome: 'unknown', outcomeUnknown: true })
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene))
    } finally { delete (navigator as { clipboard?: unknown }).clipboard; fixture.close() }
  })
  it('binds Base menu choices to the actual referenced revision and rejects stale/missing views', async () => {
    const data: CanvasData = { nodes: [{ id: 'a', type: 'file', file: 'Gallery.base', x: 0, y: 0, width: 200, height: 100, opaque: true }], edges: [] }
    const fixture = await controls(data)
    try {
      await fixture.mock.api.vault.writeFile('Gallery.base', 'views:\n  - name: Forest\n  - name: Coast\n')
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      const command = fixture.mock.commands.find(entry => entry.id === 'base-view-inspect')!, input = command.input!.parse({ mountedView: left })
      const observed = await command.run(input, { caller: 'agent' }) as { revision: string; names: string[] }
      expect(observed.names).toEqual(['Forest', 'Coast'])
      await action(fixture, 'base-view-select', { expectedBaseRevision: observed.revision, name: 'Forest' })
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ subpath: '#Forest', opaque: true })
      await action(fixture, 'base-view-default', { expectedBaseRevision: observed.revision })
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0]).not.toHaveProperty('subpath')
      await expect(action(fixture, 'base-view-select', { expectedBaseRevision: observed.revision, name: 'Missing' })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
      await fixture.mock.api.vault.writeFile('Gallery.base', 'views:\n  - name: Meadow\n')
      await expect(action(fixture, 'base-view-select', { expectedBaseRevision: observed.revision, name: 'Forest' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    } finally { fixture.close() }
  })
  it('converts exactly one text card using observed absent note bytes and preserves custom fields', async () => {
    const fixture = await controls(layoutScene)
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      const command = fixture.mock.commands.find(entry => entry.id === 'convert-text-to-note-observe')!, observed = await command.run(command.input!.parse({ destination: 'Meadow.md' }), { caller: 'agent' }) as { revision: string }
      await action(fixture, 'convert-text-to-note', { destination: 'Meadow.md', expectedDestinationRevision: observed.revision })
      expect(await fixture.mock.api.vault.readFile('Meadow.md')).toBe('Meadow')
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ id: 'a', type: 'file', file: 'Meadow.md', color: '1', x: 0, y: 0, width: 100, height: 60, nativeExtra: { retained: true } })
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0]).not.toHaveProperty('text')
    } finally { fixture.close() }
  })
  it('reloads an explicitly observed dirty draft and refuses stale draft/disk revisions', async () => {
    const fixture = await controls(layoutScene)
    try {
      const document = canvasDocument(fixture.owner, 'Test.canvas')
      await act(async () => { document.setData(scene('Retained')); document.schedule(document.get().data) })
      const command = fixture.mock.commands.find(entry => entry.id === 'disk-inspect')!, observed = await command.run(command.input!.parse({ mountedView: left }), { caller: 'agent' }) as { draftRevision: string; diskRevision: string }
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene))
      await expect(action(fixture, 'reload-disk', { expectedDraftRevision: 'stale', expectedDiskRevision: observed.diskRevision, discardDraft: true })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      await action(fixture, 'reload-disk', { expectedDraftRevision: observed.draftRevision, expectedDiskRevision: observed.diskRevision, discardDraft: true })
      expect(canvasMountedSession(left, fixture.owner).get().data).toEqual(layoutScene)
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene))
      expect(fixture.mock.api.vault.editors.save).not.toHaveBeenCalled()
    } finally { fixture.close() }
  })

  it('retains created note bytes and returns unknown when authorization is revoked before the Canvas conversion effect', async () => {
    const fixture = await controls(layoutScene)
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      const command = fixture.mock.commands.find(entry => entry.id === 'convert-text-to-note-observe')!, observed = await command.run(command.input!.parse({ destination: 'Meadow.md' }), { caller: 'agent' }) as { revision: string }
      let checks = 0
      await expect(action(fixture, 'convert-text-to-note', { destination: 'Meadow.md', expectedDestinationRevision: observed.revision }, { validateBeforeRun: async () => ++checks < 3 })).rejects.toMatchObject({ outcome: 'unknown', outcomeUnknown: true })
      expect(await fixture.mock.api.vault.readFile('Meadow.md')).toBe('Meadow')
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene))
    } finally { fixture.close() }
  })
  it('classifies a refused save as definitely not applied only while the disk baseline is unchanged', async () => {
    const fixture = await controls(layoutScene)
    try {
      const document = canvasDocument(fixture.owner, 'Test.canvas'), inspect = fixture.mock.commands.find(entry => entry.id === 'disk-inspect')!
      const state = async () => await inspect.run(inspect.input!.parse({ mountedView: left }), { caller: 'agent' }) as { uncertain: boolean; dirty: boolean; error: string }
      vi.mocked(fixture.mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'conflict', current: null })
      await act(async () => { document.setData(scene('Conflict'), left); await expect(document.flush(document.get().data, true, left)).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' }) })
      vi.mocked(fixture.mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'error' })
      await act(async () => { await expect(document.flush(document.get().data, true, left)).rejects.toMatchObject({ code: 'WRITE_FAILED', outcome: 'not-applied' }) })
      expect(await state()).toMatchObject({ uncertain: false, dirty: true })
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene))
      vi.mocked(fixture.mock.api.vault.writeFileGuarded).mockImplementationOnce(async (path, text) => { await fixture.mock.api.vault.writeFile(path, text); return { ok: false, reason: 'error' } })
      await act(async () => { await expect(document.flush(document.get().data, true, left)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', outcome: 'unknown', outcomeUnknown: true }) })
      expect(await state()).toMatchObject({ uncertain: true, dirty: true })
      const calls = vi.mocked(fixture.mock.api.vault.writeFileGuarded).mock.calls.length
      await act(async () => { await expect(document.flush(document.get().data, true, left)).rejects.toThrow() })
      expect(vi.mocked(fixture.mock.api.vault.writeFileGuarded).mock.calls).toHaveLength(calls)
    } finally { fixture.close() }
  })
  it('retries the exact retained draft after a known refused save, binding its current disk/draft revisions', async () => {
    const fixture = await controls(layoutScene)
    try {
      const document = canvasDocument(fixture.owner, 'Test.canvas')
      vi.mocked(fixture.mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'error' })
      await act(async () => { document.setData(scene('Retry'), left); await expect(document.flush(document.get().data, true, left)).rejects.toThrow() })
      const command = fixture.mock.commands.find(entry => entry.id === 'disk-inspect')!, observed = await command.run(command.input!.parse({ mountedView: left }), { caller: 'agent' }) as { draftRevision: string; diskRevision: string }
      await action(fixture, 'retry-save', { expectedDraftRevision: observed.draftRevision, expectedDiskRevision: observed.diskRevision })
      expect(parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ text: 'Retry' })
      expect((await command.run(command.input!.parse({ mountedView: left }), { caller: 'agent' })) as { dirty: boolean }).toMatchObject({ dirty: false })
    } finally { fixture.close() }
  })

  it.each([['x', 'X position', '0', 0], ['y', 'Y position', '0', 0], ['width', 'Width', '260', 260], ['height', 'Height', '160', 160], ['color', 'Color', '6', '6'], ['label', 'Label', 'ä ö ü', 'ä ö ü'], ['fromEnd', 'Start arrow', 'arrow', 'arrow'], ['toEnd', 'End arrow', 'none', 'none']] as const)('applies raw %s through the visible same field and owning guarded save', async (field, label, draft, expected) => {
    const data: CanvasData = { nodes: [{ id: 'a', type: 'group', label: 'Forest', color: '1', x: 5, y: 8, width: 200, height: 100, retained: false }, { id: 'b', type: 'text', text: 'Coast', x: 300, y: 0, width: 100, height: 100 }], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', fromEnd: 'none', toEnd: 'arrow', retained: [] }] }
    const fixture = await controls(data)
    let inspector: ReturnType<typeof render> | undefined
    const edgeTarget = field === 'fromEnd' || field === 'toEnd', nodeIds = edgeTarget ? [] : ['a'], edgeId = edgeTarget ? 'ab' : null
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds, edgeId }))
      const metadata = fixture.mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      inspector = render(metadata.render!({ relPath: 'Test.canvas', kind: 'unsupported', mountedView: left }))
      const input = await within(inspector.container).findByLabelText(label)
      const run = async (id: string, extra: Record<string, unknown> = {}) => { const command = fixture.mock.commands.find(entry => entry.id === `raw-properties-${id}`)!; let result: any; await act(async () => { result = await command.run(command.input!.parse({ mountedView: left, nodeIds, edgeId, field, ...extra }), { caller: 'agent', validateBeforeRun: async () => true }) }); return result }
      const initial = await run('inspect'), patched = await run('patch', { expectedDraftRevision: initial.revision, value: draft })
      expect(input).toHaveValue(typeof expected === 'number' ? expected : draft)
      await run('apply', { expectedDraftRevision: patched.value.revision })
      const saved = parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas'))
      expect((edgeTarget ? saved.edges[0] : saved.nodes[0])[field]).toBe(expected)
      expect(saved.nodes[0].retained).toBe(false); expect(saved.edges[0].retained).toEqual([])
    } finally { inspector?.unmount(); fixture.close() }
  })
  it('aligns only group-contained cards and leaves external cards untouched', async () => {
    const data: CanvasData = { ...layoutScene, nodes: [...layoutScene.nodes, { id: 'group', type: 'group', x: -20, y: -20, width: 300, height: 120 }] }
    const fixture = await controls(data)
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['group'] }))
      await action(fixture, 'align-right')
      const saved = parseCanvas(await fixture.mock.api.vault.readFile('Test.canvas'))
      expect(saved.nodes.find(node => node.id === 'a')).toMatchObject({ x: 160 })
      expect(saved.nodes.find(node => node.id === 'b')).toMatchObject({ x: 180 })
      expect(saved.nodes.find(node => node.id === 'c')).toEqual(layoutScene.nodes[2])
      expect(saved.nodes.find(node => node.id === 'group')).toEqual(data.nodes[3])
    } finally { fixture.close() }
  })

  it('keeps a no-op ordering action out of persistence and both history stacks', async () => {
    const fixture = await controls(layoutScene)
    try {
      act(() => canvasMountedSession(left, fixture.owner).restore({ nodeIds: ['a'] }))
      const history = canvasMountedSession(left, fixture.owner).history!(), push = vi.spyOn(fixture.mock.api.undo, 'push')
      await action(fixture, 'order-back')
      expect(canvasMountedSession(left, fixture.owner).history!()).toEqual(history)
      expect(fixture.mock.api.vault.editors.save).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled()
      expect(await fixture.mock.api.vault.readFile('Test.canvas')).toBe(serializeCanvas(layoutScene))
    } finally { fixture.close() }
  })

})
