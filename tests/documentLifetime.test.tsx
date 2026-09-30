import * as React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import type { PluginFileDraftSnapshot } from '@valley/plugin-sdk'
import { withHostUi } from './support/hostUi'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime, type CanvasOwner } from '../src/runtime'
import { canvasDocument, existingCanvasDocument } from '../src/document'
import { canvasDraft, canvasSession } from '../src/session'
import { editCanvasTarget, registerCanvasCommands } from '../src/commands'
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
function setup() {
  const mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas(original), 'Other.canvas': serializeCanvas(scene('Other')) } }))
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
    await expect(editCanvasTarget(mock.api, 'Test.canvas', { type: 'delete-nodes', ids: ['a'] })).rejects.toThrow('unsaved draft')
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
    await act(async () => { await editCanvasTarget(mock.api, 'Test.canvas', { type: 'update-node', id: 'a', values: { x: 72 } }) })
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
    const editing = editCanvasTarget(mock.api, 'Test.canvas', operation)
    operation.values.text = 'Aliased mutation'; held.resolve(file)
    const result = await editing
    expect(result.value.data.nodes[0]).toMatchObject({ text: 'Accepted input' })
    off(); vi.mocked(mock.api.vault.readFileBaseline).mockClear(); vi.mocked(mock.api.vault.writeFileGuarded).mockClear()
    await expect(command.run({ path: 'Test.canvas', operation }, { caller: 'plugin' })).rejects.toThrow('no longer registered')
    expect(mock.api.vault.readFileBaseline).not.toHaveBeenCalled(); expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('reports an accepted create effect after command revocation without opening or retrying it', async () => {
    const { mock, owner } = setup()
    const off = registerCanvasCommands(mock.api, owner)
    const write = mock.api.vault.writeFileGuarded
    const held = deferred<void>()
    vi.spyOn(mock.api.vault, 'writeFileGuarded').mockImplementationOnce(async (...args) => { await held.promise; return write(...args) })
    const create = mock.api.commands.execute('canvas:create')
    await vi.waitFor(() => expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1))
    off(); held.resolve()
    expect(await create).toEqual({ ok: true, value: { relPath: 'Untitled.canvas' } })
    expect(await mock.api.vault.readFile('Untitled.canvas')).toBeTruthy()
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
    await expect(mock.busUndo[0].undo()).rejects.toThrow('no longer registered')
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
