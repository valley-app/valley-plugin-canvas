import * as React from 'react'
import { registerCanvasSurfaces } from '../src/surfaces'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { canvasSession, canvasDraft } from '../src/session'
import { editCanvasTarget } from '../src/commands'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { withHostUi } from './support/hostUi'
import { createMockValleyApi, type MockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import CanvasEditor from '../src/CanvasEditor'

/** A workspace tab: the file view renders the editor, not the embedded minimap. */
const TAB = { id: 'tab-1', kind: 'file', path: 'Test.canvas' }
import { parseCanvas, serializeCanvas, type CanvasData } from '../src/canvasModel'

const oneCard: CanvasData = {
  nodes: [{ id: 'a', type: 'text', text: 'Hello canvas', x: 0, y: 0, width: 250, height: 120 }],
  edges: []
}

// Two cards wired by three edges exercising every arrowhead combination.
const wired: CanvasData = {
  nodes: [
    { id: 'a', type: 'text', text: 'Node A', x: 0, y: 0, width: 200, height: 100 },
    { id: 'b', type: 'text', text: 'Node B', x: 400, y: 0, width: 200, height: 100 }
  ],
  edges: [
    { id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left' }, // default → 1 arrow (to)
    { id: 'e2', fromNode: 'a', toNode: 'b', fromSide: 'bottom', toSide: 'bottom', fromEnd: 'arrow', toEnd: 'arrow' }, // 2
    { id: 'e3', fromNode: 'a', toNode: 'b', fromSide: 'top', toSide: 'top', toEnd: 'none' } // 0
  ]
}

describe('CanvasEditor', () => {
  let mock: MockValleyApi

  function mountWith(files: Record<string, string>): ReturnType<typeof render> {
    mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files }))
    initRuntime(mock.api)
    return render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
  }

  beforeEach(() => {
    // The editor mounts a non-passive wheel listener via addEventListener.
    // jsdom supports it; nothing else to stub.
  })

  it('keeps a command selection queued before the file editor first mounts', async () => {
    mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas(oneCard) } }))
    initRuntime(mock.api)
    const off = registerCanvasSurfaces(mock.api)
    const result = await mock.api.commands.execute('canvas:open', { path: 'Test.canvas', nodeIds: ['a'] })
    expect(result.ok).toBe(true)
    render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    await waitFor(() => expect(canvasSession('Test.canvas')?.get().nodeIds).toEqual(['a']))
    const provider = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
    expect(provider.getSnapshot('Test.canvas').item).toMatchObject({ id: 'a', state: { path: 'Test.canvas', nodeIds: ['a'] } })
    off()
  })

  it('renders the cards from a .canvas file', async () => {
    mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    expect(await screen.findByText('Hello canvas')).toBeTruthy()
  })

  it('keeps compatibility double-clicks on the card until a drag actually starts', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const root = container.querySelector('.canvas-root') as HTMLElement
    const card = container.querySelector('[data-node-id="a"]') as HTMLElement
    let compatibilityTarget = card
    root.setPointerCapture = vi.fn(() => { compatibilityTarget = root })
    for (let detail = 1; detail <= 2; detail++) {
      fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 100, clientY: 60 })
      fireEvent.pointerMove(compatibilityTarget, { pointerId: 1, buttons: 1, clientX: 103, clientY: 60 })
      fireEvent.pointerUp(compatibilityTarget, { pointerId: 1, clientX: 103, clientY: 60 })
      fireEvent.click(compatibilityTarget, { detail })
    }
    fireEvent.doubleClick(compatibilityTarget)
    expect(root.setPointerCapture).not.toHaveBeenCalled()
    const input = await screen.findByDisplayValue('Hello canvas')
    fireEvent.change(input, { target: { value: 'Edited by double-click' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await act(async () => { await mock.runBeforeUnload() })
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ id: 'a', text: 'Edited by double-click', x: 0, y: 0 })
  })

  // jsdom reports no platform, so cloning uses the non-macOS key (Ctrl).
  it.each([false, true])('cancels a pending card drag released outside the canvas before later hover (duplicate=%s)', async (ctrlKey) => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const root = container.querySelector('.canvas-root') as HTMLElement
    const card = container.querySelector('[data-node-id="a"]') as HTMLElement
    root.setPointerCapture = vi.fn()
    fireEvent.pointerDown(card, { button: 0, pointerId: 6, clientX: 10, clientY: 10, ctrlKey })
    fireEvent.pointerUp(document.body, { pointerId: 6, clientX: 12, clientY: 10 })
    fireEvent.pointerMove(card, { pointerId: 6, buttons: 0, clientX: 90, clientY: 90 })
    fireEvent.pointerMove(card, { pointerId: 6, buttons: 0, clientX: 110, clientY: 110 })
    expect(root.setPointerCapture).not.toHaveBeenCalled()
    expect(canvasSession('Test.canvas')!.get().data).toEqual(oneCard)
    expect(container.querySelector('.canvas-node.is-dragging')).toBeNull()
    await act(async () => { await mock.runBeforeUnload() })
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas'))).toEqual(oneCard)
  })

  it.each([false, true])('captures and saves a real card drag after the movement threshold (duplicate=%s)', async (ctrlKey) => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const root = container.querySelector('.canvas-root') as HTMLElement
    const card = container.querySelector('[data-node-id="a"]') as HTMLElement
    root.setPointerCapture = vi.fn()
    fireEvent.pointerDown(card, { button: 0, pointerId: 8, clientX: 10, clientY: 10, ctrlKey })
    expect(root.setPointerCapture).not.toHaveBeenCalled()
    const selected = canvasSession('Test.canvas')!.get().nodeIds
    expect(selected).toHaveLength(1)
    if (ctrlKey) expect(selected[0]).not.toBe('a')
    fireEvent.pointerMove(card, { pointerId: 8, buttons: 1, clientX: 14, clientY: 10 })
    expect(root.setPointerCapture).toHaveBeenCalledTimes(1)
    expect(root.setPointerCapture).toHaveBeenCalledWith(8)
    fireEvent.pointerMove(root, { pointerId: 8, buttons: 1, clientX: 80, clientY: 50 })
    expect(root.setPointerCapture).toHaveBeenCalledTimes(1)
    expect(container.querySelector(`[data-node-id="${selected[0]}"]`)).toHaveClass('is-dragging')
    fireEvent.pointerUp(root, { pointerId: 8, clientX: 80, clientY: 50 })
    await act(async () => { await mock.runBeforeUnload() })
    const saved = parseCanvas(await mock.api.vault.readFile('Test.canvas'))
    expect(saved.nodes).toHaveLength(ctrlKey ? 2 : 1)
    expect(saved.nodes.find(node => node.id === selected[0])).toMatchObject({ x: 70, y: 40 })
    if (ctrlKey) expect(saved.nodes.find(node => node.id === 'a')).toEqual(oneCard.nodes[0])
    expect(container.querySelector('.canvas-node.is-dragging')).toBeNull()
  })

  it('rereads a file changed while its initial canvas load is pending', async () => {
    mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas(oneCard) } }))
    const original = await mock.api.vault.readFileBaseline('Test.canvas')
    let complete!: (file: typeof original) => void
    const read = vi.spyOn(mock.api.vault, 'readFileBaseline')
    read.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const newest = { ...oneCard, nodes: [{ ...oneCard.nodes[0], text: 'Newest initial canvas' }] }
    read.mockResolvedValueOnce({ ...original!, content: serializeCanvas(newest) })
    initRuntime(mock.api)
    render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    act(() => mock.emitVaultChanged({ changes: [{ relPath: 'Test.canvas', kind: 'change' }] }))
    await act(async () => { complete(original) })
    await screen.findByText('Newest initial canvas')
    expect(read).toHaveBeenCalledTimes(2)
    expect(canvasSession('Test.canvas')?.get().data).toEqual(newest)
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('scopes reloads to its file and merges an external change burst without publishing the stale canvas', async () => {
    mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const original = await mock.api.vault.readFileBaseline('Test.canvas')
    const read = vi.spyOn(mock.api.vault, 'readFileBaseline')
    act(() => mock.emitVaultChanged({ changes: [{ relPath: 'Other.canvas', kind: 'change' }] }))
    expect(read).not.toHaveBeenCalled()
    let complete!: (file: typeof original) => void
    read.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const newest = { ...oneCard, nodes: [{ ...oneCard.nodes[0], text: 'Newest canvas' }] }
    read.mockResolvedValueOnce({ ...original!, content: serializeCanvas(newest) })
    act(() => {
      for (let index = 0; index < 20; index++) mock.emitVaultChanged({ changes: [{ relPath: 'Test.canvas', kind: 'change' }] })
    })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => { complete({ ...original!, content: serializeCanvas({ ...oneCard, nodes: [] }) }) })
    await screen.findByText('Newest canvas')
    expect(read).toHaveBeenCalledTimes(2)
    expect(canvasSession('Test.canvas')?.get().data).toEqual(newest)
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('discards a pending external reload when its editor is unmounted', async () => {
    const mounted = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const original = await mock.api.vault.readFileBaseline('Test.canvas')
    let complete!: (file: typeof original) => void
    const read = vi.spyOn(mock.api.vault, 'readFileBaseline')
    read.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    act(() => mock.emitVaultChanged({ full: true }))
    mounted.unmount()
    const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => { throw new Error('Session revoked') })
    try {
      await act(async () => { complete({ ...original!, content: serializeCanvas({ nodes: [], edges: [] }) }) })
      expect(runtime).not.toHaveBeenCalled()
      expect(read).toHaveBeenCalledTimes(1)
    } finally { runtime.mockRestore() }
  })

  it('keeps a card edited during a pending external reload and its original guarded baseline', async () => {
    mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    const body = await screen.findByText('Hello canvas')
    const original = await mock.api.vault.readFileBaseline('Test.canvas')
    let complete!: (file: typeof original) => void
    vi.spyOn(mock.api.vault, 'readFileBaseline').mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    act(() => mock.emitVaultChanged({ full: true }))
    fireEvent.doubleClick(body)
    const textarea = await screen.findByDisplayValue('Hello canvas')
    fireEvent.change(textarea, { target: { value: 'Retained edit' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    await act(async () => { complete({ ...original!, content: serializeCanvas({ nodes: [], edges: [] }) }) })
    expect(canvasSession('Test.canvas')?.get().data.nodes[0]).toMatchObject({ text: 'Retained edit' })
    expect(canvasDraft('Test.canvas')?.baseline).toEqual(original?.baseline)
    await act(async () => { await mock.runBeforeUnload() })
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledWith('Test.canvas', expect.stringContaining('Retained edit'), original?.baseline)
  })

  it('offers eight border resize targets before selection and cancels a gesture without writing', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const handles = container.querySelectorAll('.canvas-node-resizer')
    expect(handles).toHaveLength(8)
    const root = container.querySelector('.canvas-root')!
    fireEvent.pointerDown(handles[0], { button: 0, pointerId: 1, clientX: 20, clientY: 20 })
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 60, clientY: 60 })
    fireEvent.pointerCancel(root, { pointerId: 1 })
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    expect(canvasSession('Test.canvas')?.get().data).toEqual(oneCard)
  })

  it('pans with Space over a card without moving it and releases the cursor on blur', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const root = container.querySelector('.canvas-root')!
    const card = container.querySelector('[data-node-id="a"]')!
    fireEvent.keyDown(root, { code: 'Space', key: ' ' })
    expect(root.classList.contains('canvas-pan-ready')).toBe(true)
    fireEvent.pointerDown(card, { button: 0, pointerId: 2, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(root, { pointerId: 2, clientX: 80, clientY: 50 })
    fireEvent.pointerUp(root, { pointerId: 2, clientX: 80, clientY: 50 })
    expect(canvasSession('Test.canvas')?.get().data).toEqual(oneCard)
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    fireEvent.blur(window)
    expect(root.classList.contains('canvas-pan-ready')).toBe(false)
  })

  it('tracks pan keys and blur in the visible iframe and removes its listeners on unmount', async () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const owner = frame.contentWindow!
    const container = frame.contentDocument!.body.appendChild(frame.contentDocument!.createElement('div'))
    mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas(oneCard) } }))
    initRuntime(mock.api)
    const remove = vi.spyOn(owner, 'removeEventListener')
    const mounted = render(<CanvasEditor relPath="Test.canvas" tab={TAB} />, { container })
    try {
      await waitFor(() => expect(container.textContent).toContain('Hello canvas'))
      const root = container.querySelector('.canvas-root')!
      fireEvent.keyDown(root, { code: 'Space', key: ' ' })
      expect(root).toHaveClass('canvas-pan-ready')
      fireEvent.blur(window)
      expect(root).toHaveClass('canvas-pan-ready')
      fireEvent.blur(owner)
      expect(root).not.toHaveClass('canvas-pan-ready')
      fireEvent.keyDown(root, { code: 'Space', key: ' ' })
      fireEvent.keyUp(owner, { code: 'Space', key: ' ' })
      expect(root).not.toHaveClass('canvas-pan-ready')
      mounted.unmount()
      expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['blur', 'keydown', 'keyup']))
    } finally { mounted.unmount(); remove.mockRestore(); frame.remove() }
  })

  it('uses local dimensions when panning inside a scaled parent Canvas', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const root = container.querySelector('.canvas-root') as HTMLElement
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 800 })
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 400 })
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON: () => ({}) })
    const before = canvasSession('Test.canvas')!.get().viewport
    fireEvent.keyDown(root, { code: 'Space', key: ' ' })
    fireEvent.pointerDown(root, { button: 0, pointerId: 7, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(root, { pointerId: 7, clientX: 30, clientY: 20 })
    fireEvent.pointerUp(root, { pointerId: 7, clientX: 30, clientY: 20 })
    expect(canvasSession('Test.canvas')!.get().viewport).toMatchObject({ x: before.x + 40, y: before.y + 20 })
    expect(canvasSession('Test.canvas')!.get().data).toEqual(oneCard)
  })

  it('keeps one wheel subscription across rerenders and reads current scaled geometry for zoom pivots', async () => {
    const { container, rerender, unmount } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const root = container.querySelector('.canvas-root') as HTMLElement
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 800 })
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 400 })
    let left = 10
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ x: left, y: 20, left, top: 20, right: left + 400, bottom: 220, width: 400, height: 200, toJSON: () => ({}) }))
    const add = vi.spyOn(root, 'addEventListener')
    const remove = vi.spyOn(root, 'removeEventListener')
    for (const offset of [10, 100]) {
      left = offset
      rerender(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
      const before = canvasSession('Test.canvas')!.get().viewport
      fireEvent.wheel(root, { clientX: left + 50, clientY: 45, ctrlKey: true, deltaY: 30 })
      const after = canvasSession('Test.canvas')!.get().viewport
      expect((100 - after.x) / after.zoom).toBeCloseTo((100 - before.x) / before.zoom)
      expect((50 - after.y) / after.zoom).toBeCloseTo((50 - before.y) / before.zoom)
    }
    expect(add.mock.calls.filter(([type]) => type === 'wheel')).toHaveLength(0)
    expect(remove.mock.calls.filter(([type]) => type === 'wheel')).toHaveLength(0)
    unmount()
    expect(remove.mock.calls.filter(([type]) => type === 'wheel')).toHaveLength(1)
  })

  it('passes the containing Canvas as the context of an embedded Base', async () => {
    const data: CanvasData = { nodes: [{ id: 'base', type: 'file', file: 'Context.base', subpath: '#Same date', x: 0, y: 0, width: 500, height: 300 }], edges: [] }
    mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas(data), 'Context.base': 'views: []\n' } }))
    const preview = vi.fn((_props: { relPath: string; sourcePath?: string; subpath?: string }) => React.createElement('div', null, 'Base preview'))
    mock.api.ui.FilePreview = preview
    initRuntime(mock.api)
    render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    await screen.findByText('Base preview')
    expect(preview.mock.calls[0][0]).toMatchObject({ relPath: 'Context.base', sourcePath: 'Test.canvas', subpath: '#Same date' })
  })

  it.each(['from', 'to'] as const)('reconnects the %s endpoint, preserves edge attributes, and can detach and undo', async (end) => {
    const data: CanvasData = { ...wired, nodes: [...wired.nodes, { id: 'c', type: 'text', text: 'Node C', x: 800, y: 0, width: 200, height: 100 }] }
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(data) })
    await screen.findByText('Node C')
    const root = container.querySelector('.canvas-root')!
    const hit = vi.fn(() => container.querySelector('[data-node-id="c"]'))
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit })
    // Dragging a connection moves its nearer end: press beside the end, then drag.
    const path = container.querySelector('[data-edge-id="e1"] .canvas-interaction-path')!
    const near = end === 'from' ? { clientX: 205, clientY: 50 } : { clientX: 395, clientY: 50 }
    fireEvent.pointerDown(path, { button: 0, pointerId: 3, ...near })
    fireEvent.pointerMove(root, { pointerId: 3, buttons: 1, clientX: 600, clientY: 30 })
    fireEvent.pointerUp(root, { pointerId: 3, clientX: 800, clientY: 20 })
    expect(canvasSession('Test.canvas')?.get().data.edges[0]).toMatchObject({ ...data.edges[0], [end + 'Node']: 'c', [end + 'Side']: 'left' })
    hit.mockReturnValue(null)
    const moved = canvasSession('Test.canvas')!.get().data.edges[0]
    const again = end === 'from' ? { clientX: 805, clientY: 50 } : { clientX: 395, clientY: 50 }
    fireEvent.pointerDown(container.querySelector(`[data-edge-id="${moved.id}"] .canvas-interaction-path`)!, { button: 0, pointerId: 4, ...again })
    fireEvent.pointerMove(root, { pointerId: 4, buttons: 1, clientX: 900, clientY: 900 })
    fireEvent.pointerUp(root, { pointerId: 4, clientX: 1000, clientY: 1000 })
    expect(canvasSession('Test.canvas')?.get().data.edges).toHaveLength(2)
    await act(async () => { expect(await mock.undoActions.at(-1)!.undo()).toMatchObject({ ok: true }) })
    expect(canvasSession('Test.canvas')?.get().data.edges).toHaveLength(3)
  })

  it('resolves a connection target in its own document when the editor is mounted in a frame', async () => {
    mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas({ nodes: wired.nodes, edges: [] }) } }))
    initRuntime(mock.api)
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const frameDocument = frame.contentDocument!
    Object.defineProperty(frame.contentWindow!, 'PointerEvent', { configurable: true, value: window.PointerEvent })
    const container = frameDocument.createElement('div')
    frameDocument.body.append(container)
    const mounted = render(<CanvasEditor relPath="Test.canvas" tab={TAB} />, { container, baseElement: frameDocument.body })
    const parentDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
    const parentHit = vi.fn(() => null)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: parentHit })
    try {
      await mounted.findByText('Node A')
      const target = container.querySelector('[data-node-id="b"]')!
      const frameHit = vi.fn(() => target)
      Object.defineProperty(frameDocument, 'elementFromPoint', { configurable: true, value: frameHit })
      fireEvent.pointerDown(container.querySelector('[data-node-id="a"] .canvas-node-connection-point[data-side="right"]')!, { button: 0, pointerId: 9 })
      fireEvent.pointerUp(container.querySelector('.canvas-root')!, { pointerId: 9, clientX: 420, clientY: 20 })
      expect(canvasSession('Test.canvas')?.get().data.nodes).toHaveLength(2)
      expect(canvasSession('Test.canvas')?.get().data.edges).toEqual([expect.objectContaining({ fromNode: 'a', toNode: 'b' })])
      expect(frameHit).toHaveBeenCalledWith(420, 20)
      expect(parentHit).not.toHaveBeenCalled()
      await act(async () => { await mock.runBeforeUnload() })
    } finally {
      mounted.unmount()
      frame.remove()
      if (parentDescriptor) Object.defineProperty(document, 'elementFromPoint', parentDescriptor)
      else Reflect.deleteProperty(document, 'elementFromPoint')
    }
  })

  it('creates a card and connection together when releasing a port onto empty space', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null })
    await act(async () => {
      fireEvent.pointerDown(container.querySelector('.canvas-node-connection-point[data-side="right"]')!, { button: 0, pointerId: 5 })
      fireEvent.pointerUp(container.querySelector('.canvas-root')!, { pointerId: 5, clientX: 800, clientY: 400 })
    })
    const data = canvasSession('Test.canvas')!.get().data
    expect(data.nodes).toHaveLength(2)
    expect(data.edges).toMatchObject([{ fromNode: 'a', toNode: data.nodes[1].id }])
    expect(mock.undoActions).toHaveLength(1)
  })

  it('embeds HTTP pages in the host browser guest and never loads executable URLs', async () => {
    mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas({ nodes: [
      { id: 'web', type: 'link', url: 'https://example.org/wetland', x: 0, y: 0, width: 400, height: 300 },
      { id: 'invalid', type: 'link', url: 'javascript:alert(1)', x: 500, y: 0, width: 400, height: 300 },
      { id: 'empty', type: 'link', url: '', x: 1000, y: 0, width: 400, height: 300 }
    ], edges: [] }) } }))
    const guest = vi.fn((props: { src: string; partition?: string; instanceId: string }) => React.createElement('div', { 'data-testid': 'guest' }, props.src))
    ;(mock.api.ui as unknown as { BrowserGuest: unknown }).BrowserGuest = guest
    initRuntime(mock.api)
    render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    await waitFor(() => expect(screen.getAllByTestId('guest')).toHaveLength(1))
    expect(guest.mock.calls.at(-1)![0]).toMatchObject({ src: 'https://example.org/wetland', instanceId: 'canvas-link-web' })
    expect(screen.getByText('javascript:alert(1)')).toBeTruthy()
    // An empty web card waits for an explicit edit instead of taking focus when the board opens.
    expect(screen.getByText('No web address')).toBeTruthy()
    expect(document.querySelector('input')).toBeNull()
  })

  it('renders note cards through the host Markdown view with their own file context', async () => {
    mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files: { 'Test.canvas': serializeCanvas({ nodes: [{ id: 'note', type: 'file', file: 'Review.md', x: 0, y: 0, width: 400, height: 300 }], edges: [] }), 'Review.md': '# Review\nEmbedded content' } }))
    const view = vi.fn((props: { value: string; context: { sourcePath?: string } }) => React.createElement('div', null, props.value))
    mock.api.ui.MarkdownView = view
    initRuntime(mock.api)
    render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
    await screen.findByText(/Embedded content/)
    expect(view.mock.calls.at(-1)![0]).toMatchObject({ value: '# Review\nEmbedded content', context: { sourcePath: 'Review.md' } })
  })

  it('awaits the newest dirty scene before allowing unload and performs no revoked-session save', async () => {
    const mounted = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    const editText = async (previous: string, next: string): Promise<void> => {
      fireEvent.doubleClick(await screen.findByText(previous))
      const textarea = await screen.findByDisplayValue(previous)
      await act(async () => {
        fireEvent.change(textarea, { target: { value: next } })
        fireEvent.keyDown(textarea, { key: 'Escape' })
      })
      expect(await screen.findByText(next)).toBeTruthy()
    }
    await editText('Hello canvas', 'Pending scene')
    const write = vi.mocked(mock.api.vault.writeFileGuarded).getMockImplementation()!
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => { finish = resolve })
    vi.mocked(mock.api.vault.writeFileGuarded).mockImplementationOnce(async (...args) => { await blocked; return write(...args) })
    let completed = false
    const unload = mock.runBeforeUnload().then(() => { completed = true })
    await waitFor(() => expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1))
    expect(completed).toBe(false)
    await editText('Pending scene', 'Newest scene')
    await act(async () => { finish(); await unload })
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ text: 'Newest scene' })
    expect(canvasDraft('Test.canvas')).toBeUndefined()
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(2)
    const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => { throw new Error('Plugin session is no longer active') })
    try { mounted.unmount(); expect(runtime).not.toHaveBeenCalled() } finally { runtime.mockRestore() }
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(2)
  })

  it('rejects unload on a save conflict and keeps the editable draft without an implicit retry', async () => {
    mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    fireEvent.doubleClick(await screen.findByText('Hello canvas'))
    const textarea = await screen.findByDisplayValue('Hello canvas')
    fireEvent.change(textarea, { target: { value: 'Retained scene' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    vi.mocked(mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'conflict', current: null })
    await act(async () => { await expect(mock.runBeforeUnload()).rejects.toThrow('changed on disk') })
    expect(canvasDraft('Test.canvas')?.data.nodes[0]).toMatchObject({ text: 'Retained scene' })
    expect(screen.getByText('Retained scene')).toBeTruthy()
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas'))).toEqual(oneCard)
    await expect(mock.runBeforeUnload()).rejects.toThrow('changed on disk')
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Retry save'))
    await waitFor(() => expect(canvasDraft('Test.canvas')).toBeUndefined())
    await expect(mock.runBeforeUnload()).resolves.toBeUndefined()
  })

  it('renders edges with arrowheads that honor fromEnd/toEnd', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(wired) })
    await screen.findByText('Node A')

    // Every edge draws a visible line with a real path.
    const lines = container.querySelectorAll('path.canvas-display-path')
    expect(lines).toHaveLength(3)
    lines.forEach((line) => expect(line.getAttribute('d')).toBeTruthy())

    // Arrowheads: default(1) + double(2) + none(0) = 3 — direction is honored.
    expect(container.querySelectorAll('polygon.canvas-path-end')).toHaveLength(3)

    // The edge SVG is sized to the node bounds with a viewBox (not the old 0×0
    // box that culled every edge) — this is the invisible-edges bug fix.
    const svg = container.querySelector('svg.canvas-edges') as SVGSVGElement
    expect(svg.getAttribute('viewBox')).toBeTruthy()
    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(0)
  })

  it('persists an edited text card back to the file as valid JSONCanvas', async () => {
    mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    const body = await screen.findByText('Hello canvas')

    // Double-click enters edit mode (a textarea seeded with the card text).
    fireEvent.doubleClick(body)
    const textarea = (await screen.findByDisplayValue('Hello canvas')) as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'Updated text' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })

    // The debounced save writes parseable JSONCanvas with the new text.
    await waitFor(async () => {
      const text = await mock.api.vault.readFile('Test.canvas')
      const data = parseCanvas(text)
      expect(data.nodes).toHaveLength(1)
      expect((data.nodes[0] as { text: string }).text).toBe('Updated text')
    })
  })

  it('applies an API edit through the live guarded session and refuses read-only writes', async () => {
    mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    await act(async () => { await editCanvasTarget(mock.api, 'Test.canvas', { type: 'update-node', id: 'a', values: { text: 'Agent edit' } }) })
    expect(await screen.findByText('Agent edit')).toBeTruthy()
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0]).toMatchObject({ text: 'Agent edit' })
    const menu = vi.spyOn(mock.api.ui, 'openMenu')
    fireEvent.contextMenu(document.querySelector('.canvas-root')!)
    const items = menu.mock.calls.at(-1)?.[0] ?? []
    const lock = items.find((item) => 'label' in item && item.label === 'Read-only')
    await act(async () => { if (lock && 'onSelect' in lock) await lock.onSelect?.() })
    await expect(editCanvasTarget(mock.api, 'Test.canvas', { type: 'delete-nodes', ids: ['a'] })).rejects.toThrow('read-only')
  })

  it('keeps the live scene and external file intact when an API save conflicts', async () => {
    mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    vi.mocked(mock.api.vault.writeFileGuarded).mockResolvedValueOnce({ ok: false, reason: 'conflict', current: null })
    await act(async () => { await expect(editCanvasTarget(mock.api, 'Test.canvas', { type: 'delete-nodes', ids: ['a'] })).rejects.toThrow('changed on disk') })
    expect(canvasSession('Test.canvas')?.get().data).toEqual(oneCard)
    expect(canvasDraft('Test.canvas')?.data).toEqual(oneCard)
    expect(parseCanvas(await mock.api.vault.readFile('Test.canvas'))).toEqual(oneCard)
    expect(screen.getByRole('alert').textContent).toContain('draft is preserved')
    expect(mock.api.vault.writeFileGuarded).toHaveBeenCalledTimes(1)
  })

  it('adds a card from the create menu and edits it straight away', async () => {
    const { container } = mountWith({ 'Test.canvas': '{ "nodes": [], "edges": [] }' })
    await waitFor(() => expect(canvasSession('Test.canvas')?.get().ready).toBe(true))
    fireEvent.click(screen.getByLabelText('Drag to add card'))
    await waitFor(() => expect(container.querySelector('.canvas-node.is-editing')).toBeTruthy())
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(canvasSession('Test.canvas')?.get().data.nodes[0]).toMatchObject({ type: 'text', width: 250, height: 60 })
  })

  it('creates a text card where the empty board is double-clicked', async () => {
    const { container } = mountWith({ 'Test.canvas': '{ "nodes": [], "edges": [] }' })
    await waitFor(() => expect(canvasSession('Test.canvas')?.get().ready).toBe(true))
    fireEvent.doubleClick(container.querySelector('.canvas-root')!, { clientX: 300, clientY: 200 })
    await waitFor(() => expect(canvasSession('Test.canvas')?.get().data.nodes).toHaveLength(1))
    expect(canvasSession('Test.canvas')!.get().data.nodes[0]).toMatchObject({ type: 'text', x: 175, y: 170 })
  })

  it('keeps an invalid file read-only and never writes it', async () => {
    const { container } = mountWith({ 'Test.canvas': '{ "nodes": [ broken' })
    await screen.findByRole('alert')
    expect(container.querySelector('.canvas-root')).toHaveClass('is-readonly')
    fireEvent.doubleClick(container.querySelector('.canvas-root')!, { clientX: 300, clientY: 200 })
    await expect(editCanvasTarget(mock.api, 'Test.canvas', { type: 'delete-nodes', ids: ['a'] })).rejects.toThrow()
    await act(async () => { await mock.runBeforeUnload() })
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    expect(await mock.api.vault.readFile('Test.canvas')).toBe('{ "nodes": [ broken')
  })
})

/**
 * The board chrome. jsdom has no layout, so every assertion here is on classes,
 * attributes and what actually reaches the file — never on a measured rect
 * (AGENTS.md).
 */
describe('CanvasEditor chrome', () => {
  let mock: MockValleyApi

  function mountWith(files: Record<string, string>): ReturnType<typeof render> {
    mock = withHostUi(createMockValleyApi({ manifest: { id: 'canvas' }, files }))
    initRuntime(mock.api)
    return render(<CanvasEditor relPath="Test.canvas" tab={TAB} />)
  }

  const overlapping: CanvasData = {
    nodes: [
      { id: 'under', type: 'text', text: 'Under', x: 0, y: 0, width: 200, height: 100 },
      { id: 'over', type: 'text', text: 'Over', x: 20, y: 20, width: 200, height: 100 }
    ],
    edges: []
  }

  const labelled: CanvasData = {
    nodes: [
      { id: 'a', type: 'text', text: 'Node A', x: 0, y: 0, width: 200, height: 100 },
      { id: 'b', type: 'text', text: 'Node B', x: 400, y: 0, width: 200, height: 100 }
    ],
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', label: 'because' }]
  }

  const nodeEl = (container: HTMLElement, id: string): HTMLElement =>
    container.querySelector(`[data-node-id="${id}"]`) as HTMLElement

  it('puts the create menu bottom centre and zoom and history controls top right', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    // Create menu (bottom centre): card, note, media, web page and group, each draggable.
    const cardMenu = container.querySelector('.canvas-card-menu') as HTMLElement
    expect(cardMenu).toBeTruthy()
    expect(cardMenu.querySelectorAll('button.mod-draggable')).toHaveLength(5)
    // Controls: zoom in, reset, fit, zoom out; undo, redo.
    const groups = [...container.querySelectorAll('.canvas-controls .canvas-control-group')]
    expect(groups.map((group) => group.querySelectorAll('button').length)).toEqual([4, 2])
    // Chrome paints above host content, so host widgets leave room for it.
    expect(cardMenu.hasAttribute('data-plugin-widget-occluder')).toBe(true)
    // The old toolbar/zoom-cluster classes are gone for good.
    expect(container.querySelector('.canvas-toolbar')).toBeNull()
    expect(container.querySelector('.canvas-zoom-cluster')).toBeNull()
  })

  it('counteracts zoom on the world so chrome holds its on-screen size', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    const world = container.querySelector('.canvas-world') as HTMLElement
    expect(world.style.getPropertyValue('--zm')).toBe('1')
  })

  it('renders the card in its own container so the label can sit outside it', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    expect(container.querySelector('.canvas-node > .canvas-node-container')).toBeTruthy()
  })

  it('stacks nodes by array index, per the spec z-order rule', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(overlapping) })
    await screen.findByText('Over')
    const under = Number(nodeEl(container, 'under').style.zIndex)
    const over = Number(nodeEl(container, 'over').style.zIndex)
    expect(over).toBeGreaterThan(under)
  })

  it('brings a card to the front by moving it in the written file', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(overlapping) })
    await screen.findByText('Under')

    await act(async () => fireEvent.pointerDown(nodeEl(container, 'under'), { button: 0 }))
    await act(async () => fireEvent.contextMenu(nodeEl(container, 'under')))

    // `openMenu` is the host's shared presenter, so the mock records the items
    // rather than rendering them — drive the entry the way the presenter would.
    await waitFor(() => expect(mock.menus.length).toBeGreaterThan(0))
    const items = mock.menus[mock.menus.length - 1]
    const bringToFront = items.find((i) => i.label === 'Bring to front')
    expect(bringToFront).toBeTruthy()
    await act(async () => bringToFront!.onSelect!())

    await waitFor(async () => {
      const data = parseCanvas(await mock.api.vault.readFile('Test.canvas'))
      expect(data.nodes.map((n) => n.id)).toEqual(['over', 'under'])
    })
  })

  it('opens the colour swatches under the selection menu, with a custom swatch', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')

    fireEvent.pointerDown(nodeEl(container, 'a'), { button: 0 })
    fireEvent.click(screen.getByLabelText('Set color'))

    const picker = container.querySelector('.canvas-menu .canvas-submenu') as HTMLElement
    expect(picker.hasAttribute('data-plugin-widget-occluder')).toBe(true)
    // No colour + six presets + the custom swatch.
    expect(picker.querySelectorAll('.canvas-color-picker-item')).toHaveLength(8)
    expect(picker.querySelector('.canvas-color-picker-custom input[type="color"]')).toBeTruthy()

    // Presets render as palette variables, never a frozen hex.
    const preset = picker.querySelectorAll('.canvas-color-picker-item:not(.is-none):not(.canvas-color-picker-custom)')[0] as HTMLElement
    expect(preset.style.getPropertyValue('--canvas-color')).toContain('--color-red')

    fireEvent.click(preset)
    await waitFor(async () => {
      const data = parseCanvas(await mock.api.vault.readFile('Test.canvas'))
      expect(data.nodes[0].color).toBe('1')
    })
    fireEvent.click(screen.getByLabelText('Set color'))
    const custom = container.querySelector('.canvas-color-picker-custom input') as HTMLInputElement
    fireEvent.input(custom, { target: { value: '#2468ac' } })
    await waitFor(async () => expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0].color).toBe('#2468ac'))
    fireEvent.click(screen.getByLabelText('Set color'))
    fireEvent.click(container.querySelector('.canvas-color-picker-item.is-none')!)
    await waitFor(async () => expect(parseCanvas(await mock.api.vault.readFile('Test.canvas')).nodes[0].color).toBeUndefined())
  })

  it('shows a selection menu over the selected card, and none with nothing selected', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')
    expect(container.querySelector('.canvas-menu')).toBeNull()

    fireEvent.pointerDown(nodeEl(container, 'a'), { button: 0 })
    const menu = container.querySelector('.canvas-menu') as HTMLElement
    expect(menu).toBeTruthy()
    expect([...menu.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Set color', 'Zoom to selection', 'Edit', 'Remove'])
  })

  it('duplicates the selection into the file with a fresh id', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(oneCard) })
    await screen.findByText('Hello canvas')

    fireEvent.pointerDown(nodeEl(container, 'a'), { button: 0 })
    fireEvent.keyDown(container.querySelector('.canvas-root')!, { key: 'd', ctrlKey: true })

    await waitFor(async () => {
      const data = parseCanvas(await mock.api.vault.readFile('Test.canvas'))
      expect(data.nodes).toHaveLength(2)
      expect(new Set(data.nodes.map((n) => n.id)).size).toBe(2)
      expect((data.nodes[1] as { text: string }).text).toBe('Hello canvas')
    })
  })

  it('renders an edge label as DOM, not SVG text, and commits an edit', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(labelled) })
    await screen.findByText('Node A')

    const label = container.querySelector('.canvas-path-label') as HTMLElement
    expect(label.textContent).toBe('because')
    expect(container.querySelector('svg.canvas-edges text')).toBeNull()

    fireEvent.doubleClick(label)
    const input = (await screen.findByDisplayValue('because')) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'therefore' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(async () => {
      const data = parseCanvas(await mock.api.vault.readFile('Test.canvas'))
      expect(data.edges[0].label).toBe('therefore')
    })
  })

  it('sets an edge to no arrows, one way or both ways', async () => {
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(labelled) })
    await screen.findByText('Node A')

    fireEvent.pointerDown(container.querySelector('.canvas-interaction-path') as Element, { button: 0 })
    fireEvent.pointerUp(container.querySelector('.canvas-root')!)

    // The edge starts at the spec defaults (from: none, to: arrow), written as
    // neither key; a value equal to its spec default is omitted from the file.
    const ends = async (): Promise<[unknown, unknown]> => {
      const e = parseCanvas(await mock.api.vault.readFile('Test.canvas')).edges[0]
      return [e.fromEnd, e.toEnd]
    }
    const choose = async (id: string): Promise<void> => {
      fireEvent.click(screen.getByLabelText('Line direction'))
      await waitFor(() => expect(mock.menus.length).toBeGreaterThan(0))
      const item = mock.menus[mock.menus.length - 1].find((entry) => entry.id === id)!
      await act(async () => { await item.onSelect!() })
    }

    await choose('both')
    await waitFor(async () => expect(await ends()).toEqual(['arrow', undefined]))
    await choose('none')
    await waitFor(async () => expect(await ends()).toEqual([undefined, 'none']))
    await choose('one')
    await waitFor(async () => expect(await ends()).toEqual([undefined, undefined]))
  })

  it('paints a group background image in the declared style', async () => {
    const withGroup: CanvasData = {
      nodes: [
        {
          id: 'g',
          type: 'group',
          label: 'Frame',
          background: 'Images/braun.jpg',
          backgroundStyle: 'ratio',
          x: 0,
          y: 0,
          width: 400,
          height: 300
        }
      ],
      edges: []
    }
    const { container } = mountWith({ 'Test.canvas': serializeCanvas(withGroup) })
    await screen.findByText('Frame')
    const bg = container.querySelector('.canvas-group-background') as HTMLElement
    expect(bg).toBeTruthy()
    expect(bg.className).toContain('mod-ratio')
    // The asset URL percent-encodes the vault path, so match the encoded form.
    expect(bg.style.backgroundImage).toContain(encodeURIComponent('Images/braun.jpg'))
  })

  it('renders a file card title above the card, not as a header row inside it', async () => {
    const fileCard: CanvasData = {
      nodes: [{ id: 'f', type: 'file', file: 'Design/The Enclosure.md', x: 0, y: 0, width: 300, height: 200 }],
      edges: []
    }
    const { container } = mountWith({
      'Test.canvas': serializeCanvas(fileCard),
      'Design/The Enclosure.md': '# The Enclosure\n\nBody.\n'
    })
    const label = (await screen.findByTitle('Design/The Enclosure.md')) as HTMLElement
    expect(label.className).toContain('canvas-node-label')
    // The label is a sibling of the container, so nothing clips it.
    expect(label.parentElement?.className).toContain('canvas-node')
    expect(container.querySelector('.canvas-node-container .canvas-node-label')).toBeNull()
    expect(container.querySelector('.canvas-node-header')).toBeNull()
  })

  it('embeds only the addressed section when a file node carries a subpath', async () => {
    const subCard: CanvasData = {
      nodes: [
        {
          id: 'f',
          type: 'file',
          file: 'Note.md',
          subpath: '#Simplicity',
          x: 0,
          y: 0,
          width: 300,
          height: 200
        }
      ],
      edges: []
    }
    const { container } = mountWith({
      'Test.canvas': serializeCanvas(subCard),
      'Note.md': '# Note\n\nIntro.\n\n## Simplicity\n\nSay no.\n\n## Taste\n\nEdit.\n'
    })
    // The Markdown view stand-in renders its value as text.
    await waitFor(() => {
      const body = container.querySelector('[data-testid="markdown-view"]') as HTMLElement
      expect(body?.textContent).toContain('Say no.')
    })
    const body = container.querySelector('[data-testid="markdown-view"]') as HTMLElement
    expect(body.textContent).toContain('## Simplicity')
    expect(body.textContent).not.toContain('Intro.')
    expect(body.textContent).not.toContain('Edit.')
  })
})
