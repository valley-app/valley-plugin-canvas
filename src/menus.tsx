import { React, type CanvasOwner } from './runtime'
import type { ResourceSearchResult } from '@valley/plugin-sdk/types'
import { CANVAS_PRESET_PALETTE, resolveColor, validEnd, type CanvasColor, type CanvasEdge, type CanvasNode, type CanvasNodeType } from './canvasModel'
import { uiText } from './localization'
import {
  ArrowRightIcon, EditIcon, FileImageIcon, FileTextIcon, GlobeIcon, GroupIcon, ImageIcon, LineHorizontalIcon, LockIcon, MaximizeIcon, MinusIcon,
  MoveHorizontalIcon, PaletteIcon, PlusIcon, RedoIcon, RemoveLabelIcon, RotateCwIcon, StickyNoteIcon, TrashIcon, UndoIcon,
  AlignStartVerticalIcon, ZoomToSelectionIcon
} from './icons'

/** Chrome drawn above host content: host widgets leave a hole wherever it overlaps them. */
export const OCCLUDER = { 'data-plugin-widget-occluder': '' }

/** Card kinds the bottom menu creates; `note` and `media` pick a vault file first. */
export type CreateKind = 'text' | 'note' | 'media' | 'link' | 'group'

/**
 * The create menu, bottom centre. Each button both clicks (card lands at the
 * viewport centre) and drags (card lands where you drop it).
 */
export const CardMenu = (props: {
  owner: CanvasOwner
  readOnly: boolean
  onCreateStart: (e: React.PointerEvent, kind: CreateKind) => void
  onCreateClick: (kind: CreateKind) => void
}): ReturnType<typeof React.createElement> | null => {
  if (props.readOnly) return null
  const entries: { kind: CreateKind; title: string; Icon: () => ReturnType<typeof React.createElement> }[] = [
    { kind: 'text', title: uiText('canvas.create.card'), Icon: StickyNoteIcon },
    { kind: 'note', title: uiText('canvas.create.note'), Icon: FileTextIcon },
    { kind: 'media', title: uiText('canvas.create.media'), Icon: FileImageIcon },
    { kind: 'link', title: uiText('canvas.create.web'), Icon: GlobeIcon },
    { kind: 'group', title: uiText('canvas.create.group'), Icon: GroupIcon }
  ]
  return (
    <div className="canvas-card-menu" {...OCCLUDER} onPointerDown={(e) => e.stopPropagation()}>
      {entries.map(({ kind, title, Icon }) => (
        [kind === 'link' ? <span key="sep" className="sep" /> : null,
        <button
          key={kind}
          type="button"
          className="canvas-card-menu-button mod-draggable"
          aria-label={title}
          {...props.owner.api.ui.tooltip(title, { placement: 'top' })}
          onPointerDown={(e) => props.onCreateStart(e, kind)}
          onClick={() => props.onCreateClick(kind)}
        >
          <Icon />
        </button>]
      ))}
    </div>
  )
}

const ControlItem = (props: { owner: CanvasOwner; label: string; active?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: ReturnType<typeof React.createElement> }): ReturnType<typeof React.createElement> => (
  <button type="button" className={`canvas-control-item${props.active ? ' is-active' : ''}`} aria-label={props.label} {...props.owner.api.ui.tooltip(props.label, { placement: 'left' })} onClick={props.onClick}>
    {props.children}
  </button>
)

/** Zoom and history controls, top right. */
export const Controls = (props: {
  owner: CanvasOwner
  readOnly: boolean
  onUnlock: () => void
  onZoomIn: () => void
  onReset: () => void
  onFit: () => void
  onZoomOut: () => void
  onUndo: () => void
  onRedo: () => void
}): ReturnType<typeof React.createElement> => {
  const { owner } = props
  return (
    <div className="canvas-controls" {...OCCLUDER} onPointerDown={(e) => e.stopPropagation()}>
      {props.readOnly && <div className="canvas-control-group">
        <ControlItem owner={owner} label={uiText('canvas.control.unlock')} active onClick={props.onUnlock}><LockIcon /></ControlItem>
      </div>}
      <div className="canvas-control-group">
        <ControlItem owner={owner} label={uiText('auto.4fc05f2763ba')} onClick={props.onZoomIn}><PlusIcon /></ControlItem>
        <ControlItem owner={owner} label={uiText('auto.a4ae4b24a1f5')} onClick={props.onZoomOut}><MinusIcon /></ControlItem>
        <ControlItem owner={owner} label={uiText('canvas.control.resetZoom')} onClick={props.onReset}><RotateCwIcon /></ControlItem>
        <ControlItem owner={owner} label={uiText('canvas.control.zoomToFit')} onClick={props.onFit}><MaximizeIcon /></ControlItem>
      </div>
      <div className="canvas-control-group">
        <ControlItem owner={owner} label={uiText('auto.39fc72124884')} onClick={props.onUndo}><UndoIcon /></ControlItem>
        <ControlItem owner={owner} label={uiText('canvas.control.redo')} onClick={props.onRedo}><RedoIcon /></ControlItem>
      </div>
    </div>
  )
}

/** The glyph for an edge's current direction. */
export function lineDirection(edge: CanvasEdge): 'none' | 'one' | 'both' {
  const fromEnd = validEnd(edge.fromEnd) ?? 'none'
  const toEnd = validEnd(edge.toEnd) ?? 'arrow'
  if (fromEnd === 'arrow' && toEnd === 'arrow') return 'both'
  if (toEnd === 'none' && fromEnd === 'none') return 'none'
  return 'one'
}
const DIRECTION_ICON = { none: LineHorizontalIcon, one: ArrowRightIcon, both: MoveHorizontalIcon }

export interface SelectionMenuActions {
  onRemove(): void
  onColor(color: CanvasColor | undefined): void
  onZoomToSelection(): void
  onCreateGroup(): void
  onAlign(anchor: HTMLElement): void
  onLineDirection(anchor: HTMLElement): void
  onRemoveLabel(): void
  onEdit(): void
  onBackground(anchor: HTMLElement): void
}

/**
 * The actions floating above the selection. Its position is measured here so
 * it can sit above the selection and stay 10px inside the pane.
 */
export const SelectionMenu = (props: {
  owner: CanvasOwner
  /** Screen point the menu is centred over (bottom edge of the menu). */
  anchor: { x: number; y: number }
  pane: { width: number; height: number }
  nodes: CanvasNode[]
  edge: CanvasEdge | undefined
  readOnly: boolean
  actions: SelectionMenuActions
}): ReturnType<typeof React.createElement> => {
  const { nodes, edge, readOnly, actions, owner } = props
  const menu = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [submenu, setSubmenu] = React.useState<'color' | null>(null)
  React.useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const next = { width: element.offsetWidth, height: element.offsetHeight }
    if (next.width !== size.width || next.height !== size.height) setSize(next)
  })
  const single = nodes.length === 1 ? nodes[0] : undefined
  const current: CanvasColor | undefined = edge ? edge.color : nodes[nodes.length - 1]?.color
  const cards = nodes.filter((node) => node.type !== 'group')
  const button = (label: string, Icon: () => ReturnType<typeof React.createElement>, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, options: { readOnlyAllowed?: boolean; active?: boolean; danger?: boolean } = {}): ReturnType<typeof React.createElement> | null =>
    readOnly && !options.readOnlyAllowed ? null : (
      <button type="button" className={`clickable-icon${options.active ? ' is-active' : ''}${options.danger ? ' is-danger' : ''}`} aria-label={label} {...owner.api.ui.tooltip(label, { placement: 'top' })} onClick={onClick}>
        <Icon />
      </button>
    )
  const left = Math.max(10, Math.min(props.pane.width - size.width - 10, props.anchor.x - size.width / 2))
  const top = Math.max(10, Math.min(props.pane.height - size.height - 10, props.anchor.y - size.height))
  const editable = single && (single.type === 'text' || single.type === 'group' || single.type === 'link' || single.type === 'file' && /\.(md|markdown)$/i.test(single.file))
  return (
    <div className="canvas-menu-container" style={{ left, top, visibility: size.width ? undefined : 'hidden' }} {...OCCLUDER} onPointerDown={(e) => e.stopPropagation()}>
      <div className="canvas-menu" ref={menu}>
        {button(uiText('canvas.menu.setColor'), PaletteIcon, () => setSubmenu((open) => open === 'color' ? null : 'color'), { active: submenu === 'color' })}
        {button(uiText('canvas.menu.zoomToSelection'), ZoomToSelectionIcon, actions.onZoomToSelection, { readOnlyAllowed: true })}
        {!edge && nodes.length > 1 && button(uiText('auto.5a0b1c170fd5'), GroupIcon, actions.onCreateGroup)}
        {!edge && (cards.length > 1 || single?.type === 'group') && button(uiText('canvas.menu.align'), AlignStartVerticalIcon, (e) => actions.onAlign(e.currentTarget))}
        {edge && button(uiText('canvas.menu.lineDirection'), DIRECTION_ICON[lineDirection(edge)], (e) => actions.onLineDirection(e.currentTarget))}
        {edge?.label && button(uiText('canvas.menu.removeLabel'), RemoveLabelIcon, actions.onRemoveLabel)}
        {edge && button(uiText('auto.84e1c434e634'), EditIcon, actions.onEdit)}
        {!edge && editable && button(single.type === 'group' ? uiText('auto.84e1c434e634') : uiText('canvas.menu.edit'), EditIcon, actions.onEdit)}
        {!edge && single?.type === 'group' && button(single.background ? uiText('canvas.menu.editBackground') : uiText('canvas.menu.setBackground'), ImageIcon, (e) => actions.onBackground(e.currentTarget))}
        {!readOnly && <span className="sep" />}
        {button(uiText('canvas.menu.remove'), TrashIcon, actions.onRemove, { danger: true })}
        {submenu === 'color' && !readOnly && (
          <div className="canvas-submenu" {...OCCLUDER}>
            <ColorPicker current={current} onPick={(color, close) => { actions.onColor(color); if (close) setSubmenu(null) }} />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * No colour, the six presets and a seventh **custom** swatch. Presets render
 * through the palette, so they follow the theme and a user's design snippet;
 * the custom swatch writes a `#rrggbb` literal straight into the file.
 */
export const ColorPicker = (props: {
  current: CanvasColor | undefined
  onPick: (color: CanvasColor | undefined, close: boolean) => void
}): ReturnType<typeof React.createElement> => {
  const custom = props.current?.startsWith('#') ? props.current : undefined
  return (
    <>
      <button
        type="button"
        className={`canvas-color-picker-item is-none${props.current ? '' : ' is-active'}`}
        aria-label={uiText('auto.1d5c5b448862')}
        aria-pressed={!props.current}
        onClick={() => props.onPick(undefined, true)}
      />
      {Object.keys(CANVAS_PRESET_PALETTE).map((key) => (
        <button
          key={key}
          type="button"
          className={`canvas-color-picker-item${props.current === key ? ' is-active' : ''}`}
          style={{ ['--canvas-color' as string]: resolveColor(key) ?? undefined }}
          aria-label={uiText('auto.1c00478aa356', { p0: key })}
          aria-pressed={props.current === key}
          onClick={() => props.onPick(key, true)}
        />
      ))}
      <span
        className={`canvas-color-picker-item canvas-color-picker-custom${custom ? ' is-active' : ''}`}
        style={custom ? { ['--canvas-color' as string]: custom } : undefined}
        aria-label={uiText('auto.34cfc6448b9d')}
      >
        <input
          type="color"
          aria-label={uiText('auto.34cfc6448b9d')}
          value={custom ?? '#888888'}
          onInput={(e) => props.onPick((e.target as HTMLInputElement).value.toLowerCase(), false)}
          onChange={(e) => props.onPick(e.target.value.toLowerCase(), true)}
        />
      </span>
    </>
  )
}

/** Keyboard and pointer shortcuts, listed the way the board reads them. */
export const HelpContent = (props: { mac: boolean }): ReturnType<typeof React.createElement> => {
  const mod = props.mac ? '⌘' : 'Ctrl'
  const clone = props.mac ? '⌥' : 'Ctrl'
  const noSnap = props.mac ? '⌃' : 'Alt'
  const rows: [string, string[][]][] = [
    [uiText('canvas.help.pan'), [['Space', uiText('canvas.help.drag')], [uiText('canvas.help.scroll')]]],
    [uiText('canvas.help.panHorizontal'), [['⇧', uiText('canvas.help.scroll')]]],
    [uiText('canvas.help.zoom'), [[mod, uiText('canvas.help.scroll')], ['Space', uiText('canvas.help.scroll')]]],
    [uiText('canvas.control.zoomToFit'), [['⇧', '1']]],
    [uiText('canvas.menu.zoomToSelection'), [['⇧', '2']]],
    [uiText('canvas.help.selectAll'), [[mod, 'A']]],
    [uiText('canvas.help.toggleSelection'), [['⇧', uiText('canvas.help.click')], ['⇧', uiText('canvas.help.dragSelect')]]],
    [uiText('canvas.help.createWithSize'), [[mod, uiText('canvas.help.dragSelect')]]],
    [uiText('canvas.help.clone'), [[clone, uiText('canvas.help.drag')]]],
    [uiText('canvas.help.constrain'), [['⇧', uiText('canvas.help.drag')]]],
    [uiText('canvas.help.noSnap'), [[noSnap]]],
    [uiText('canvas.help.remove'), [['⌫'], ['Delete']]],
    [uiText('auto.39fc72124884'), [[mod, 'Z']]],
    [uiText('canvas.control.redo'), [[mod, '⇧', 'Z']]]
  ]
  return (
    <div className="canvas-help">
      {rows.map(([label, combos]) => (
        <div className="canvas-instruction" key={label}>
          <div className="canvas-instruction-label">{label}</div>
          <div className="canvas-instruction-desc">
            {combos.map((combo, index) => <span key={index} className="canvas-hotkey-combo">{combo.map((key) => <kbd key={key} className="canvas-hotkey">{key}</kbd>)}</span>)}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Suggest a vault file by name: notes/canvases/bases for `note`, attachments for `media`. */
export const FileSuggest = (props: {
  owner: CanvasOwner
  kind: 'note' | 'media'
  onPick: (path: string) => void
  onClose: () => void
}): ReturnType<typeof React.createElement> => {
  const { owner } = props
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<ResourceSearchResult[]>([])
  const [active, setActive] = React.useState(0)
  const list = React.useRef<HTMLDivElement>(null)
  const listId = React.useId()
  React.useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  React.useEffect(() => {
    let current = true
    const request = props.kind === 'note'
      ? { query, kinds: ['vault-file'], limit: 40, filters: { extensions: ['md', 'markdown', 'canvas', 'base'] } }
      : { query, kinds: ['attachment'], limit: 40, filters: { extensions: MEDIA_EXTENSIONS } }
    void owner.run(() => owner.api.resources.search(request)).then((found) => { if (current) { setResults(found); setActive(0) } }).catch(() => { if (current) setResults([]) })
    return () => { current = false }
  }, [owner, query, props.kind])
  const pick = (result: ResourceSearchResult | undefined): void => { if (result) props.onPick(result.value) }
  return (
    <div className="canvas-suggest">
      <input
        className="canvas-suggest-input"
        autoFocus
        role="combobox"
        aria-label={uiText(props.kind === 'note' ? 'canvas.suggest.note' : 'canvas.suggest.media')}
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        placeholder={uiText(props.kind === 'note' ? 'canvas.suggest.note' : 'canvas.suggest.media')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.max(0, Math.min(results.length - 1, i + 1))) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); pick(results[active]) }
          else if (e.key === 'Escape') { e.preventDefault(); props.onClose() }
        }}
      />
      <div ref={list} id={listId} className="canvas-suggest-list" role="listbox">
        {results.map((result, index) => (
          <button
            type="button"
            role="option"
            id={`${listId}-${index}`}
            tabIndex={-1}
            aria-selected={index === active}
            key={result.id}
            className={`canvas-suggest-item${index === active ? ' is-selected' : ''}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => pick(result)}
          >
            {props.kind === 'note' ? <FileTextIcon /> : <FileImageIcon />}
            <span className="canvas-suggest-copy">
              <span className="canvas-suggest-title">{result.label}</span>
              {result.description && <span className="canvas-suggest-note">{result.description}</span>}
            </span>
          </button>
        ))}
        {!results.length && <div className="canvas-suggest-empty">{uiText('canvas.suggest.empty')}</div>}
      </div>
    </div>
  )
}

const MEDIA_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'mp4', 'webm', 'mov', 'mkv', 'ogv', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'pdf', 'glb', 'gltf', 'stl', 'obj', 'epub']

export function isCardKind(kind: CreateKind | CanvasNodeType): kind is CanvasNodeType {
  return kind === 'text' || kind === 'file' || kind === 'link' || kind === 'group'
}
