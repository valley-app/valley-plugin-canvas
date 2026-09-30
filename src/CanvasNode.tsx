import type { FileBaseline } from '@valley/plugin-sdk/types'
import { React, type CanvasOwner } from './runtime'
import { assetUrlForRelPath, classifyFilePath, displayFileTitle } from '@valley/plugin-sdk/fileTypes'
import {
  type CanvasNode,
  type EdgeSide,
  type FileNode,
  type GroupNode,
  type LinkNode,
  type TextNode,
  fileSubpath,
  groupBackground,
  resolveColor,
  resolveContrast,
  sliceSubpath
} from './canvasModel'
import { RESIZE_HANDLES, type ResizeHandle } from './geometry'
import { FileCardIcon, FileImageIcon, LinkCardIcon, TextAlignIcon } from './icons'
import { uiText } from './localization'

/** Side strips carry the connection point for their side; corners only resize. */
const HANDLE_SIDE: Partial<Record<ResizeHandle, EdgeSide>> = { n: 'top', e: 'right', s: 'bottom', w: 'left' }

/** Host widgets inside a card fill it; outside the focused card they let pointer input reach the board. */
const WIDGET_LAYOUT = 'data-plugin-widget-layout'
const WIDGET_PASSTHROUGH = 'data-plugin-widget-passthrough'
const WIDGET_LAYER = 'data-plugin-widget-layer'
const WIDGET_OCCLUDER = 'data-plugin-widget-occluder'
const WIDGET_GESTURES = 'data-plugin-widget-gestures'

/**
 * An `<img>` handed the same `src` string is never re-fetched, so a vault image
 * that changed on disk keeps serving stale pixels. `useAssetUrl` is renderer-only
 * — a plugin busts its own cache, the way `todo/AttachmentCard` does.
 */
function useAssetSrc(relPath: string, owner: CanvasOwner): string {
  const [epoch, setEpoch] = React.useState(0)
  React.useEffect(() => {
    if (!relPath || !owner.isActive()) return
    const off = owner.api.vault.onChanged(event => {
      if (owner.isActive() && (event.full || event.changes.some(change => change.relPath === relPath || change.kind.endsWith('Dir') && relPath.startsWith(`${change.relPath}/`)))) setEpoch(n => n + 1)
    })
    const offOwner = owner.onDispose(off)
    return () => { offOwner(); off() }
  }, [relPath, owner])
  return `${assetUrlForRelPath(relPath)}?v=${epoch}`
}

/** Whether `relPath` exists, re-checked when the vault changes it. `null` while unknown. */
function useFileExists(relPath: string, owner: CanvasOwner): boolean | null {
  const [exists, setExists] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    if (!relPath || !owner.isActive()) return
    let active = true
    const check = (): void => { void owner.run(() => owner.api.vault.fileInfo(relPath)).then(info => { if (active && owner.isActive()) setExists(Boolean(info)) }).catch(() => { if (active && owner.isActive()) setExists(false) }) }
    check()
    const off = owner.api.vault.onChanged(event => { if (event.full || event.changes.some(change => change.relPath === relPath || relPath.startsWith(`${change.relPath}/`))) check() })
    const offOwner = owner.onDispose(off)
    return () => { active = false; offOwner(); off() }
  }, [relPath, owner])
  return exists
}

export interface NodeViewProps {
  owner: CanvasOwner
  /** Render card content; false when zoomed out or scrolled off the pane. */
  previewEnabled: boolean
  node: CanvasNode
  sourcePath?: string
  /**
   * Position in `data.nodes`. The spec makes the array index the z-order
   * ("the first node in the array should be displayed below all other nodes"),
   * so the card's `z-index` is derived from it rather than from its type.
   */
  index: number
  selected: boolean
  /** The only selected card: its content is interactive and its resizers are live. */
  focused: boolean
  editing: boolean
  dragging: boolean
  /** Board zoom, handed to content that scales itself (web pages). */
  zoom: number
  /** Read-only mode: hide connection points + resizers (mutating gestures are gated in the editor). */
  readOnly: boolean
  onNodePointerDown: (e: React.PointerEvent, node: CanvasNode) => void
  onResizeStart: (e: React.PointerEvent, node: CanvasNode, handle: ResizeHandle) => void
  onConnectStart: (e: React.PointerEvent, node: CanvasNode, side: EdgeSide) => void
  onStartEdit: (node: CanvasNode) => void
  onCommit: (node: CanvasNode, patch: Partial<CanvasNode>) => void
  onCancelEdit: () => void
}

/**
 * Bands that sit above every unselected card while still ordering within
 * themselves by array index — so raising a card never reorders its neighbours.
 */
const BAND_SELECTED = 100000
const BAND_EDITING = 200000

export const NodeView = (props: NodeViewProps): ReturnType<typeof React.createElement> => {
  const { node, index, selected, focused, editing, dragging, readOnly } = props
  const root = React.useRef<HTMLDivElement>(null)
  const [visible, setVisible] = React.useState(typeof IntersectionObserver === 'undefined')
  React.useEffect(() => {
    const element = root.current
    if (!element) return
    const document = element.ownerDocument
    const Observer = document.defaultView?.IntersectionObserver
    let intersecting = !Observer
    let active = true
    const update = (): void => { if (active) setVisible(props.owner.isActive() && intersecting && document.visibilityState !== 'hidden') }
    const observer = Observer ? new Observer(records => {
      const record = records.find(record => record.target === element)
      if (record) intersecting = record.isIntersecting
      update()
    }, { root: element.closest('.canvas-root'), rootMargin: '120px' }) : null
    observer?.observe(element)
    document.addEventListener('visibilitychange', update)
    const cleanup = (): void => { active = false; observer?.disconnect(); document.removeEventListener('visibilitychange', update) }
    const offOwner = props.owner.onDispose(() => { update(); cleanup() })
    update()
    return () => { cleanup(); offOwner() }
  }, [props.owner])
  const isGroup = node.type === 'group'
  // Zoomed out, content unmounts to its placeholder — except web pages and
  // media, which stay loaded so a zoomed-out board still shows its pictures.
  const keepLoaded = node.type === 'link' || node.type === 'file' && ['image', 'audio', 'video'].includes(classifyFilePath(node.file))
  const showBody = editing || node.type === 'file' && !node.file || node.type === 'link' && !node.url || (props.previewEnabled || keepLoaded) && visible
  const accent = resolveColor(node.color)
  const zIndex = (editing ? BAND_EDITING : selected ? BAND_SELECTED : 0) + index
  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
    width: Math.max(1, node.width),
    height: Math.max(1, node.height),
    zIndex
  }
  const styleVars = style as Record<string, string | number>
  if (accent) {
    styleVars['--canvas-color'] = accent
    const contrast = resolveContrast(node.color)
    if (contrast) styleVars['--canvas-color-contrast'] = contrast
  }
  styleVars['--canvas-node-height'] = `${Math.max(1, node.height)}px`

  const className =
    'canvas-node' +
    (isGroup ? ' canvas-node-group' : ` canvas-node-${node.type}`) +
    (accent ? ' is-themed' : '') +
    (selected ? ' is-selected' : '') +
    (focused ? ' is-focused' : '') +
    (editing ? ' is-editing' : '') +
    (dragging ? ' is-dragging' : '')
  // Cards are opaque, so a card stacked higher hides the host content of the
  // cards below it. Groups are translucent and never hide anything.
  const layer = { [WIDGET_LAYER]: zIndex, ...(isGroup ? {} : { [WIDGET_OCCLUDER]: zIndex }) }
  const interactive = focused && !dragging

  return (
    <div
      ref={root}
      className={className}
      style={style}
      data-node-id={node.id}
      {...layer}
      onPointerDown={(e) => props.onNodePointerDown(e, node)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (!readOnly && (node.type === 'text' || node.type === 'group' || node.type === 'link' || node.type === 'file' && isMarkdownFile(node))) props.onStartEdit(node)
      }}
    >
      {renderLabel(node, editing, props)}

      <div className="canvas-node-container">
        {showBody ? (
          <div
            className={`canvas-node-content ${contentClass(node)}`}
            {...{ [WIDGET_LAYOUT]: 'fill', [WIDGET_GESTURES]: '' }}
            {...(interactive || editing ? {} : { [WIDGET_PASSTHROUGH]: '' })}
          >
            {renderBody(node, editing, props)}
          </div>
        ) : isGroup ? <div className="canvas-node-content" /> : <Placeholder node={node} />}
        {!isGroup && !interactive && !editing && <div className="canvas-node-content-blocker" />}
      </div>

      {!editing && !readOnly && (
        <div className="canvas-node-interaction-layer">
          {RESIZE_HANDLES.map((handle) => {
            const side = HANDLE_SIDE[handle]
            return (
              <div
                key={handle}
                className="canvas-node-resizer"
                data-resize={handle}
                onPointerDown={(e) => props.onResizeStart(e, node, handle)}
              >
                {side && (
                  <div
                    className="canvas-node-connection-point"
                    data-side={side}
                    onPointerDown={(e) => props.onConnectStart(e, node, side)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function isMarkdownFile(node: FileNode): boolean {
  return Boolean(node.file) && /\.(md|markdown)$/i.test(node.file)
}

function contentClass(node: CanvasNode): string {
  if (node.type === 'text') return 'markdown-embed'
  if (node.type === 'file') {
    const kind = classifyFilePath(node.file)
    return kind === 'text' ? 'markdown-embed' : 'file-embed'
  }
  return node.type === 'link' ? 'link-embed' : ''
}

/** What a card shows when zoomed out: its title in large type, or a type glyph. */
const Placeholder = ({ node }: { node: CanvasNode }): ReturnType<typeof React.createElement> => {
  const title = node.type === 'file' ? displayFileTitle(node.file) : node.type === 'link' ? hostOf(node.url) : ''
  if (title) return <div className="canvas-node-placeholder">{title}</div>
  const Icon = node.type === 'file' && classifyFilePath(node.file) === 'image' ? FileImageIcon : node.type === 'link' ? LinkCardIcon : node.type === 'file' ? FileCardIcon : TextAlignIcon
  return <div className="canvas-node-placeholder"><div className="canvas-icon-placeholder"><Icon /></div></div>
}

/** Where opening a file card's note should land: its heading, when the card shows one. */
function headingAnchor(subpath: string | undefined): { type: 'markdown-heading'; heading: string } | undefined {
  return subpath && !subpath.startsWith('#^') ? { type: 'markdown-heading', heading: subpath.slice(1) } : undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** The card's title line, drawn above the card. */
function renderLabel(
  node: CanvasNode,
  editing: boolean,
  props: NodeViewProps
): ReturnType<typeof React.createElement> | null {
  if (node.type === 'group') {
    return <GroupLabel node={node} editing={editing} onCommit={props.onCommit} onCancel={props.onCancelEdit} />
  }
  if (node.type === 'file' && node.file) {
    const subpath = fileSubpath(node)
    return (
      <button
        type="button"
        className="canvas-node-label"
        title={subpath ? `${node.file}${subpath}` : node.file}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { if (props.owner.isActive()) void props.owner.api.workspace.openFile(node.file, headingAnchor(subpath), { newTab: props.owner.api.ui.hasModKey(e) }) }}
      >
        <FileCardIcon />
        <span>{displayFileTitle(node.file)}{subpath ? ` > ${subpath.replace(/^#\^?/, '')}` : ''}</span>
      </button>
    )
  }
  if (node.type === 'link' && node.url && !editing) {
    return <span className="canvas-node-label"><LinkCardIcon /><span>{hostOf(node.url)}</span></span>
  }
  return null
}

function renderBody(node: CanvasNode, editing: boolean, props: NodeViewProps): ReturnType<typeof React.createElement> | null {
  switch (node.type) {
    case 'text':
      return <TextBody owner={props.owner} node={node} editing={editing} sourcePath={props.sourcePath} onCommit={props.onCommit} onCancel={props.onCancelEdit} />
    case 'group':
      return <GroupBackground owner={props.owner} node={node} />
    case 'link':
      return <LinkBody owner={props.owner} node={node} editing={editing} zoom={props.zoom} onCommit={props.onCommit} onCancel={props.onCancelEdit} />
    case 'file':
      return <FileCard owner={props.owner} sourcePath={props.sourcePath} node={node} editing={editing} onCommit={props.onCommit} onCancel={props.onCancelEdit} />
  }
}

const TextBody = (props: {
  owner: CanvasOwner
  node: TextNode
  editing: boolean
  sourcePath?: string
  onCommit: (node: CanvasNode, patch: Partial<CanvasNode>) => void
  onCancel: () => void
}): ReturnType<typeof React.createElement> => {
  const { node, editing, owner } = props
  const context = React.useMemo(() => ({ sourcePath: props.sourcePath }), [props.sourcePath])
  if (editing) return <TextEditor {...props} context={context} />
  const MarkdownView = owner.api.ui.MarkdownView
  return <MarkdownView className="canvas-markdown" value={node.text} context={context} />
}

/**
 * The inline editor for a text card: Valley's plain note editor (syntax
 * highlighting, wikilink autocomplete, vim when enabled). The draft is
 * committed once, when editing ends, so a whole edit is one undo step — and
 * the unmount commit means leaving the card any way (click away, Escape,
 * closing the tab) keeps the text.
 */
const TextEditor = (props: {
  owner: CanvasOwner
  node: TextNode
  context: { sourcePath?: string }
  onCommit: (node: CanvasNode, patch: Partial<CanvasNode>) => void
  onCancel: () => void
}): ReturnType<typeof React.createElement> => {
  const host = React.useRef<HTMLDivElement>(null)
  const draft = React.useRef(props.node.text)
  const latest = React.useRef(props)
  latest.current = props
  React.useEffect(() => {
    const parent = host.current
    if (!parent || !props.owner.isActive()) return
    const editor = props.owner.api.ui.createMarkdownEditor(parent, {
      initialValue: props.node.text,
      context: props.context,
      autoFocus: true,
      onChange: (next) => { draft.current = next },
      onSave: () => latest.current.onCancel(),
      onCancel: () => latest.current.onCancel()
    })
    // The host shows the editor once its position arrives; focus it again then.
    const timers = [60, 250].map((delay) => setTimeout(() => { if (props.owner.isActive()) editor.focus() }, delay))
    return () => {
      timers.forEach(clearTimeout)
      editor.destroy()
      const { node, onCommit } = latest.current
      if (draft.current !== node.text) onCommit(node, { text: draft.current } as Partial<TextNode>)
    }
  }, [props.owner])
  return <div ref={host} className="canvas-markdown canvas-text-editor" />
}

const GroupLabel = (props: {
  node: GroupNode
  editing: boolean
  onCommit: (node: CanvasNode, patch: Partial<CanvasNode>) => void
  onCancel: () => void
}): ReturnType<typeof React.createElement> | null => {
  const { node, editing } = props
  if (editing) {
    return (
      <InlineInput
        className="canvas-group-label is-editing"
        placeholder={uiText('auto.ebb7e14b1c9c')}
        initial={typeof node.label === 'string' ? node.label : ''}
        onCommit={(label) => props.onCommit(node, { label } as Partial<GroupNode>)}
        onCancel={props.onCancel}
        allowEmpty
      />
    )
  }
  if (typeof node.label !== 'string' || !node.label) return null
  return <div className="canvas-group-label">{node.label}</div>
}

/** The group's optional background image, painted under its colour tint. */
const GroupBackground = (props: { node: GroupNode; owner: CanvasOwner }): ReturnType<typeof React.createElement> | null => {
  const background = groupBackground(props.node)
  const src = useAssetSrc(background?.file ?? '', props.owner)
  if (!background) return null
  return <div className={`canvas-group-background mod-${background.style}`} style={{ backgroundImage: `url("${src}")` }} />
}

/** A one-line editor used to set a URL or a group label. */
const InlineInput = (props: {
  className?: string
  placeholder: string
  initial: string
  allowEmpty?: boolean
  onCommit: (value: string) => void
  onCancel: () => void
}): ReturnType<typeof React.createElement> => {
  const [value, setValue] = React.useState(props.initial)
  const done = React.useRef(false)
  const commit = (): void => {
    if (done.current) return
    done.current = true
    const raw = value.trim()
    if (!raw && !props.allowEmpty) {
      props.onCancel()
      return
    }
    props.onCommit(raw)
  }
  return (
    <input
      className={props.className ?? 'canvas-input'}
      autoFocus
      placeholder={props.placeholder}
      value={value}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          done.current = true
          props.onCancel()
        }
      }}
    />
  )
}

/** Only web pages load inside a link card; anything else is shown as its address. */
function webUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

const LinkBody = (props: {
  owner: CanvasOwner
  node: LinkNode
  editing: boolean
  zoom: number
  onCommit: (node: CanvasNode, patch: Partial<CanvasNode>) => void
  onCancel: () => void
}): ReturnType<typeof React.createElement> => {
  const { node, editing, owner } = props
  if (!editing && !node.url) return <div className="canvas-node-placeholder canvas-link-invalid">{uiText('canvas.link.none')}</div>
  if (editing) {
    return (
      <div className="canvas-link-edit">
        <InlineInput
          placeholder="https://example.com"
          initial={node.url}
          onCommit={(url) => props.onCommit(node, { url } as Partial<LinkNode>)}
          onCancel={props.onCancel}
        />
      </div>
    )
  }
  const src = webUrl(node.url)
  if (!src) return <div className="canvas-node-placeholder canvas-link-invalid">{node.url}</div>
  const BrowserGuest = owner.api.ui.BrowserGuest
  return <BrowserGuest instanceId={`canvas-link-${node.id}`} src={src} partition="canvas-web" height="100%" zoomFactor={Math.max(0.25, Math.min(2, props.zoom))} />
}

const FileCard = (props: {
  owner: CanvasOwner
  sourcePath?: string
  node: FileNode
  editing: boolean
  onCommit: (node: CanvasNode, patch: Partial<CanvasNode>) => void
  onCancel: () => void
}): ReturnType<typeof React.createElement> => {
  const { node, owner } = props
  const exists = useFileExists(node.file, owner)
  if (!node.file) return <div className="canvas-node-placeholder canvas-file-missing">{uiText('canvas.file.none')}</div>
  if (exists === false) {
    return (
      <div className="canvas-file-missing">
        <FileCardIcon />
        <span>{uiText('canvas.file.missing', { path: node.file })}</span>
      </div>
    )
  }
  if (exists === null) return <div className="canvas-file-loading" />
  const kind = classifyFilePath(node.file)
  if (kind === 'text') return <MarkdownFileBody owner={owner} node={node} editing={props.editing && isMarkdownFile(node)} onDone={props.onCancel} />
  // Every other file — images, audio, video, PDF, Bases, maps, drawings — is
  // shown by Valley's own viewer for it, the same one a note embed uses.
  const Preview = owner.api.ui.FilePreview
  return <Preview relPath={node.file} sourcePath={props.sourcePath} subpath={fileSubpath(node)} />
}

/**
 * A note inside a card, rendered by the host's reading surface (properties,
 * embeds, plugin code blocks). Double-click edits
 * the whole note in place; writes are guarded, so an external change is never
 * overwritten and the draft is kept on conflict.
 */
const MarkdownFileBody = (props: { owner: CanvasOwner; node: FileNode; editing: boolean; onDone: () => void }): ReturnType<typeof React.createElement> => {
  const { owner, node } = props
  const api = owner.api
  const subpath = fileSubpath(node)
  const [markdown, setMarkdown] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const [epoch, setEpoch] = React.useState(0)
  React.useEffect(() => {
    if (!owner.isActive()) return
    const off = api.vault.onChanged(event => { if (event.full || event.changes.some(change => change.relPath === node.file)) setEpoch(n => n + 1) })
    const offOwner = owner.onDispose(off)
    return () => { offOwner(); off() }
  }, [api, owner, node.file])
  React.useEffect(() => {
    let cancelled = false
    setError('')
    void owner.run(() => api.vault.readFileBaseline(node.file)).then((file) => {
      if (!file?.baseline) throw new Error(uiText('canvas.error.preview'))
      if (!cancelled && owner.isActive()) setMarkdown(file.content)
    }).catch(reason => { if (!cancelled && owner.isActive()) setError(reason instanceof Error ? reason.message : uiText('canvas.error.preview')) })
    return () => { cancelled = true }
  }, [node.file, owner, api, epoch])
  const context = React.useMemo(() => ({ sourcePath: node.file }), [node.file])
  if (error) return <p className="canvas-file-error" role="alert">{error}</p>
  if (markdown === null) return <div className="canvas-file-loading" />
  if (props.editing && !subpath) return <MarkdownFileEditor owner={owner} path={node.file} initial={markdown} context={context} onDone={props.onDone} />
  const MarkdownView = api.ui.MarkdownView
  return (
    <div className="canvas-markdown-file">
      <div className="canvas-markdown-file-body" {...{ [WIDGET_LAYOUT]: 'fill' }}>
        <MarkdownView className="canvas-markdown" value={sliceSubpath(markdown, subpath)} context={context} />
      </div>
    </div>
  )
}

const MarkdownFileEditor = (props: { owner: CanvasOwner; path: string; initial: string; context: { sourcePath?: string }; onDone: () => void }): ReturnType<typeof React.createElement> => {
  const { owner, path } = props
  const [value, setValue] = React.useState(props.initial)
  const [error, setError] = React.useState('')
  const state = React.useRef<{ baseline: FileBaseline | null; saved: string; pending: string; timer?: ReturnType<typeof setTimeout>; writing: Promise<void>; failed: boolean }>({ baseline: null, saved: props.initial, pending: props.initial, writing: Promise.resolve(), failed: false })
  React.useEffect(() => {
    let active = true
    void owner.run(() => owner.api.vault.readFileBaseline(path)).then(file => {
      if (!active || !file) return
      if (file.content !== props.initial) { state.current.failed = true; setError(uiText('canvas.error.noteChanged')); return }
      state.current.baseline = file.baseline
    }).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [owner, path, props.initial])
  const save = React.useCallback((): Promise<void> => {
    const current = state.current
    clearTimeout(current.timer)
    current.writing = current.writing.then(async () => {
      if (current.failed || !current.baseline || current.pending === current.saved || !owner.isActive()) return
      const text = current.pending
      const result = await owner.run(() => owner.api.vault.writeFileGuarded(path, text, current.baseline))
      if (result.ok) { current.baseline = result.baseline; current.saved = text; return }
      current.failed = true
      setError(uiText(result.reason === 'conflict' ? 'canvas.error.noteChanged' : 'canvas.error.noteSave'))
    }).catch(reason => { current.failed = true; setError(String(reason)) })
    return current.writing
  }, [owner, path])
  React.useEffect(() => {
    const offUnload = owner.beforeUnload(() => save())
    return () => { offUnload(); void save() }
  }, [owner, save])
  const NoteInput = owner.api.ui.NoteInput
  return (
    <div className="canvas-markdown-file is-editing">
      {error && <p className="canvas-file-error" role="alert">{error}</p>}
      <div className="canvas-markdown-file-body" {...{ [WIDGET_LAYOUT]: 'fill' }}>
        <NoteInput
          className="canvas-markdown canvas-markdown-editor"
          value={value}
          context={props.context}
          autoFocus
          onChange={(next) => {
            setValue(next)
            state.current.pending = next
            clearTimeout(state.current.timer)
            state.current.timer = setTimeout(() => { void save() }, 400)
          }}
          onSave={() => { void save().then(props.onDone) }}
          onCancel={() => { void save().then(props.onDone) }}
        />
      </div>
    </div>
  )
}
