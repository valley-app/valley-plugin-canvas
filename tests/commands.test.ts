import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { registerCanvasSurfaces } from '../src/surfaces'
import { initRuntime } from '../src/runtime'
import { pendingCanvasView, registerCanvasSession, saveCanvasDraft, subscribeCanvas } from '../src/session'
import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { applyCanvasOperation, readCanvasTarget, editCanvasTarget, registerCanvasCommands } from '../src/commands'
import { EMPTY_CANVAS, serializeCanvas, type CanvasData } from '../src/canvasModel'

it('cleans up only the owning canvas session and subscriptions after revocation', () => {
  const mock = createMockValleyApi({ manifest: { id: 'canvas' } })
  initRuntime(mock.api)
  const session = { get: () => { throw new Error('Unexpected session read') }, commit: async () => {}, restore: () => {} }
  const offFirst = registerCanvasSession('Meadow.canvas', session)
  const next = { ...session }
  const offNext = registerCanvasSession('Meadow.canvas', next)
  const notify = vi.fn()
  const unsubscribe = subscribeCanvas(notify)
  const state = mock.api.runtime.getOrCreate('canvas.sessions', () => ({ sessions: new Map(), listeners: new Set() }))
  const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => { throw new Error('Plugin session is no longer active') })
  try {
    offFirst()
    expect(state.sessions.get('Meadow.canvas')).toBe(next)
    expect(notify).toHaveBeenCalledTimes(1)
    unsubscribe()
    offNext()
    expect(state.sessions.size).toBe(0)
    expect(state.listeners.size).toBe(0)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(runtime).not.toHaveBeenCalled()
  } finally { runtime.mockRestore() }
})

describe('canvas:create', () => {
  it('creates with guarded undo and redo', async () => {
    const mock = createMockValleyApi({
      manifest: { id: 'canvas' },
      activePath: 'Boards/Index.md',
      files: { 'Boards/Untitled.canvas': 'occupied' }
    })
    registerCanvasCommands(mock.api)

    expect(mock.commands.find((command) => command.id === 'create')?.sideEffect).toBe('write')
    const result = await mock.api.commands.execute('canvas:create')

    expect(result).toEqual({ ok: true, value: { relPath: 'Boards/Untitled 1.canvas' } })
    expect(mock.api.vault.writeFile).not.toHaveBeenCalled()
    expect(mock.api.vault.writeFileGuarded).toHaveBeenNthCalledWith(
      1,
      'Boards/Untitled.canvas',
      EMPTY_CANVAS,
      null
    )
    expect(mock.api.vault.writeFileGuarded).toHaveBeenNthCalledWith(
      2,
      'Boards/Untitled 1.canvas',
      EMPTY_CANVAS,
      null
    )
    expect(mock.api.workspace.openFile).toHaveBeenCalledWith('Boards/Untitled 1.canvas')
    expect(mock.busUndo).toHaveLength(1)
    await mock.busUndo[0].undo()
    expect(await mock.api.vault.stat('Boards/Untitled 1.canvas')).toBeNull()
    await mock.busUndo[0].redo?.()
    expect(await mock.api.vault.readFile('Boards/Untitled 1.canvas')).toBe(EMPTY_CANVAS)
  })

  it('does not open a file when the guarded write fails', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'canvas' } })
    vi.mocked(mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'error' })
    registerCanvasCommands(mock.api)

    const result = await mock.api.commands.execute('canvas:create')

    expect(result).toMatchObject({ ok: false, error: { kind: 'threw' } })
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
  })

  it('refuses undo after the created file was edited', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'canvas' } })
    registerCanvasCommands(mock.api)
    await mock.api.commands.execute('canvas:create')
    await mock.api.vault.writeFile('Untitled.canvas', 'edited')

    await expect(mock.busUndo[0].undo()).rejects.toThrow('Refusing to remove edited file')
    expect(await mock.api.vault.readFile('Untitled.canvas')).toBe('edited')
  })
})


describe('explicit canvas edits', () => {
  const original: CanvasData = { nodes: [{ id: 'card', type: 'text', text: 'Original', x: 0, y: 0, width: 200, height: 100, nativeExtra: 'preserved' }], edges: [] }
  const setup = () => { const mock = createMockValleyApi({ manifest: { id: 'canvas' }, activePath: 'Other.canvas', files: { 'Board.canvas': serializeCanvas(original), 'Other.canvas': EMPTY_CANVAS } }); initRuntime(mock.api); registerCanvasCommands(mock.api); return mock }

  it('targets a named file, preserves native fields, and guards undo against later edits', async () => {
    const mock = setup()
    const { revision } = await readCanvasTarget(mock.api, 'Board.canvas')
    const result = await editCanvasTarget(mock.api, 'Board.canvas', { type: 'update-node', id: 'card', values: { text: 'Edited' } }, revision)
    expect(result.value.data.nodes[0]).toMatchObject({ text: 'Edited', nativeExtra: 'preserved' })
    expect(await mock.api.vault.readFile('Other.canvas')).toBe(EMPTY_CANVAS)
    await result.revert.run()
    expect((await readCanvasTarget(mock.api, 'Board.canvas')).data).toEqual(original)
    await result.revert.reapply()
    await mock.api.vault.writeFile('Board.canvas', EMPTY_CANVAS)
    await expect(result.revert.run()).rejects.toThrow('newer work')
  })

  it('rejects stale, missing, invisible fields and unsafe links before writing', async () => {
    const mock = setup()
    await expect(editCanvasTarget(mock.api, 'Board.canvas', { type: 'delete-nodes', ids: ['card'] }, 'stale')).rejects.toThrow('changed')
    await expect(editCanvasTarget(mock.api, 'Board.canvas', { type: 'update-node', id: 'missing', values: { text: 'x' } })).rejects.toThrow('no longer exists')
    expect(() => applyCanvasOperation(original, { type: 'update-node', id: 'card', values: { file: 'Other.md' } })).toThrow('Unsupported')
    expect(() => applyCanvasOperation(original, { type: 'add-node', node: { type: 'link', x: 0, y: 0, url: 'javascript:alert(1)' } })).toThrow('Unsafe')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('uses the live session and never bypasses a refused editor commit', async () => {
    const mock = setup()
    const live = applyCanvasOperation(original, { type: 'update-node', id: 'card', values: { text: 'Unsaved live edit' } })
    const commit = vi.fn(async () => { throw new Error('read-only') })
    const off = registerCanvasSession('Board.canvas', { get: () => ({ data: live, revision: serializeCanvas(live), viewport: { x: 0, y: 0, zoom: 1 }, nodeIds: ['card'], edgeId: null, readOnly: true, ready: true, error: '' }), commit, restore: vi.fn() })
    expect((await readCanvasTarget(mock.api, 'Board.canvas')).data).toBe(live)
    await expect(editCanvasTarget(mock.api, 'Board.canvas', { type: 'delete-nodes', ids: ['card'] })).rejects.toThrow('read-only')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    off()
  })

  it('restores a background selection without opening another file and rejects missing cards', async () => {
    const mock = setup()
    const off = registerCanvasSurfaces(mock.api)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
    await surface.restore({ v: 1, path: 'Board.canvas', nodeIds: ['card'], viewport: { x: 12, y: 3, zoom: 2 } }, 'Board.canvas', { background: true })
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
    expect(pendingCanvasView('Board.canvas')).toMatchObject({ nodeIds: ['card'], viewport: { x: 12, y: 3, zoom: 2 } })
    await expect(surface.restore({ v: 1, path: 'Board.canvas', nodeIds: ['missing'] })).rejects.toThrow('no longer exists')
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
    off()
  })

  it('binds both edit command previews to the targeted scene revision', async () => {
    const mock = setup()
    registerCanvasSurfaces(mock.api)
    const edit = mock.commands.find((command) => command.id === 'edit')!
    const properties = mock.commands.find((command) => command.id === 'properties-edit')!
    const editInput = edit.input!.parse({ path: 'Board.canvas', operation: { type: 'update-node', id: 'card', values: { text: 'Proposed' } } })
    const propertyInput = properties.input!.parse({ subject: { pluginId: 'canvas', surface: 'main_workspace', view: { v: 1, path: 'Board.canvas' }, item: { id: 'card', state: { path: 'Board.canvas', nodeIds: ['card'] } } }, values: { color: '1' } })
    const before = await edit.revision!(editInput)
    expect(await properties.revision!(propertyInput)).toBe(before)
    expect(edit.preview!(editInput)).toMatchObject({ path: 'Board.canvas', operation: { type: 'update-node' } })
    expect(properties.preview!(propertyInput)).toMatchObject({ path: 'Board.canvas', values: { color: '1' } })
    await mock.api.vault.writeFile('Board.canvas', EMPTY_CANVAS)
    expect(await edit.revision!(editInput)).not.toBe(before)
    expect(await properties.revision!(propertyInput)).not.toBe(before)
  })

  it('does not overwrite a retained draft after its editor closes', async () => {
    const mock = setup()
    saveCanvasDraft('Board.canvas', { data: original, baseline: null, lastWritten: null, error: 'conflict' })
    await expect(editCanvasTarget(mock.api, 'Board.canvas', { type: 'delete-nodes', ids: ['card'] })).rejects.toThrow('unsaved draft')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })
})
