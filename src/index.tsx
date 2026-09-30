/**
 * Canvas — an infinite board that owns the `.canvas` file type (JSON Canvas,
 * https://jsoncanvas.org). The plugin claims the extension via its manifest
 * `fileViews` map (`{ '.canvas': 'canvas.editor' }`); the host mounts the view
 * as a full workspace tab whenever a `.canvas` file is opened, and as its
 * minimap wherever the file is embedded. The editor reads/writes the file
 * through `api.vault` and owns its own debounced persistence + ⌘Z integration.
 *
 * Text, note, media, web page and group cards; connections (edges with
 * arrowheads + colours); pan/zoom/select/marquee/drag/resize/recolour/align.
 * Card content is shown by Valley's own viewers through the SDK. The surface
 * is fully event-driven — no perpetual rAF — so it profiles at 0% CPU idle.
 */
import type { ValleyPluginApi, ValleyPluginModule } from '@valley/plugin-sdk'
import { FILE_TREE_CONTEXT_ITEM_V1, NEW_TAB_ENTRY_V1 } from '@valley/plugin-sdk'
import { initRuntime } from './runtime'
import { injectStyles } from './styles'
import { registerCanvasSurfaces } from './surfaces'
import { registerCanvasCommands } from './commands'
import { canvasNewTabEntry } from './newTabEntry'
import CanvasView from './CanvasEditor'
import { initLocalization } from './localization'

export function register(api: ValleyPluginApi): () => Promise<void> {
  initLocalization(api)
  const owner = initRuntime(api)
  const disposeStyles = injectStyles()

  // The host mounts this file view with `relPath` (+ `tab` in a workspace tab,
  // `thisPath` when embedded); cast through the registry's propless slot.
  api.registerView('canvas.editor', CanvasView as unknown as Parameters<typeof api.registerView>[1])
  const offCommands = registerCanvasCommands(api, owner)
  const offSurfaces = registerCanvasSurfaces(api, owner)
  // The owner-scoped bus applies the same guard policy as the palette, CLI and
  // assistant without embedding this package's id in its own implementation.
  const offNewTab = api.interop.extensions.provide(
    NEW_TAB_ENTRY_V1,
    canvasNewTabEntry(() => { if (owner.isActive()) void api.commands.executeOwn('create') })
  )

  const offFileTree = api.interop.extensions.provide(FILE_TREE_CONTEXT_ITEM_V1, {
    id: 'new-canvas',
    label: 'New canvas',
    labelKey: 'plugin.canvas.newTab.create',
    icon: 'shapes',
    directories: true,
    run: async (path) => {
      const file = path ? await owner.run(() => api.vault.fileInfo(path)) : null
      owner.assertActive()
      const folder = file ? path.slice(0, Math.max(0, path.lastIndexOf('/'))) : path
      await api.commands.executeOwn('create', { folder })
    }
  })

  return () => {
    offFileTree()
    offNewTab()
    offCommands()
    offSurfaces()
    disposeStyles()
    return owner.dispose()
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
