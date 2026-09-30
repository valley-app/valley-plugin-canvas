/**
 * Canvas plugin styles, injected once. Valley's design system first: every
 * colour, radius, font and shadow is a Notes design token (on `:root`, so it
 * resolves inside this plugin-injected <style>) — never an invented name, never
 * a restated palette hex. Verify both light and dark.
 *
 * Board mechanics — zoom range, zoomed-out placeholders, card sizes, resize
 * strips, connection points on the side being hovered — follow the common JSON
 * Canvas conventions; how they look is Valley's.
 *
 * ## `--zm`
 *
 * The world is one CSS-`transform`ed element, so everything inside it would
 * shrink with the board. Chrome inside the world (handles, labels, strokes)
 * multiplies by `--zm = sqrt(1/zoom)`: it gives back part of the scale, so
 * handles stay usable far out without growing huge. Screen-space chrome
 * (menus, controls) sits outside `.canvas-world` and needs none of it.
 *
 * Host content inside cards (notes, bases, players) is rendered by the host
 * over this frame, in Valley's own viewers; `.canvas-markdown` reaches it.
 */
const CSS = `
.canvas-root {
  --canvas-color-default: var(--text-tertiary);
  --canvas-card-border: var(--border-medium);
  --canvas-dot: var(--border-medium);
  --canvas-bg: var(--pane-bg);
  --canvas-card-bg: var(--container-color);
  --canvas-shadow-card: 0 .5px 1px .5px rgba(0, 0, 0, .1);
  --canvas-shadow-float: var(--shadow-menu);
  --canvas-color: var(--canvas-color-default);
  position: absolute;
  inset: 0;
  /* clip, not hidden: focusing a card off screen must never scroll the board and the chrome with it. */
  overflow: clip;
  contain: strict;
  background-color: var(--canvas-bg);
  background-image: radial-gradient(circle, var(--canvas-dot) .7px, transparent .8px);
  /* background-size and -position are set inline from the viewport: the world
     spacing steps with the zoom (gridSpacing), so the dots hold a roughly
     constant screen density. */
  user-select: none;
  touch-action: none;
  outline: none;
  color: var(--text-color);
  font-family: var(--interface-font);
}
.canvas-root.is-panning, .canvas-root.canvas-pan-ready, .canvas-root.canvas-pan-ready * { cursor: grab !important; }
.canvas-root.is-panning * { cursor: grabbing !important; }
.canvas-root.is-connecting { cursor: crosshair; }
.canvas-root.is-dragging iframe, .canvas-root.is-dragging webview { pointer-events: none; }

.canvas-world { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }

/* ── Edges ─────────────────────────────────────────────────────────────────── */
.canvas-edges { position: absolute; overflow: visible; pointer-events: none; }
.canvas-edges path.canvas-display-path {
  pointer-events: none;
  fill: none;
  stroke: var(--canvas-color);
  stroke-width: calc(2px * var(--zm));
  stroke-linecap: round;
  transition: stroke .1s, stroke-width 100ms ease-out;
}
.canvas-edges path.canvas-interaction-path {
  pointer-events: stroke;
  fill: none;
  stroke: transparent;
  stroke-width: calc(24px * var(--zm));
  stroke-linecap: round;
}
.canvas-root:not(.is-readonly) .canvas-edges path.canvas-interaction-path { cursor: pointer; }
.canvas-edges polygon.canvas-path-end {
  pointer-events: none;
  fill: var(--canvas-color);
  stroke: var(--canvas-color);
  stroke-width: calc(1px * var(--zm));
  stroke-linejoin: round;
  transition: fill .1s, stroke .1s;
}
.canvas-edges:not(.is-connecting) g:hover path.canvas-display-path,
.canvas-edges g.is-focused path.canvas-display-path { stroke-width: calc(4px * var(--zm)); }
.canvas-edges g.is-focused path.canvas-display-path { stroke: var(--accent-color); }
.canvas-edges g.is-focused polygon.canvas-path-end { fill: var(--accent-color); stroke: var(--accent-color); }
.canvas-edge-preview { fill: none; stroke: var(--accent-color); stroke-width: calc(2px * var(--zm)); stroke-dasharray: 5 4; }

.canvas-edge-labels { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 50000; }
.canvas-path-label-wrapper { position: absolute; width: 0; height: 0; }
.canvas-path-label {
  position: absolute;
  left: 0;
  top: 0;
  transform: translate(-50%, -50%);
  width: max-content;
  max-width: calc(17em * var(--zm));
  box-sizing: border-box;
  padding: calc(2px * var(--zm)) calc(6px * var(--zm));
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background-color: var(--canvas-card-bg);
  color: var(--text-color);
  font: inherit;
  font-size: calc(var(--small-font-size) * var(--zm));
  line-height: 1.3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-align: center;
  cursor: pointer;
}
.canvas-path-label-wrapper.is-focused .canvas-path-label { border-color: var(--accent-color); }
textarea.canvas-path-label { resize: none; outline: none; min-width: calc(4em * var(--zm)); field-sizing: content; }
.canvas-path-label.is-editing { border-color: var(--accent-color); cursor: text; }

/* ── Cards ─────────────────────────────────────────────────────────────────── */
.canvas-node { position: absolute; overflow: visible; }
.canvas-node-container {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--canvas-card-border);
  border-radius: var(--radius);
  background-color: var(--canvas-card-bg);
  box-shadow: var(--canvas-shadow-card);
  transition: box-shadow .12s ease, border-color .12s ease;
}
.canvas-root:not(.is-readonly) .canvas-node:not(.is-editing) .canvas-node-container { cursor: grab; }
.canvas-root:not(.is-readonly) .canvas-node:not(.is-editing) .canvas-node-container:active { cursor: grabbing; }
.canvas-node.is-dragging { pointer-events: none; }
.canvas-node.is-dragging .canvas-node-container { box-shadow: var(--shadow-drag); }
/* Themed card: a .7 border doubled as an inset hairline so the edge reads at
   any zoom, over a .07 tint of the same colour. */
.canvas-node.is-themed .canvas-node-container {
  border-color: color-mix(in srgb, var(--canvas-color) 70%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--canvas-color) 70%, transparent), var(--canvas-shadow-card);
}
/* Selection = a single, evenly-thick ring on all four sides; never shifts layout. */
.canvas-node.is-selected .canvas-node-container {
  border-color: var(--accent-color);
  box-shadow: var(--canvas-shadow-card), 0 0 0 2px var(--accent-color);
}
.canvas-node.is-selected.is-themed .canvas-node-container {
  border-color: var(--canvas-color);
  box-shadow: inset 0 0 0 1px var(--canvas-color), 0 0 0 2px var(--canvas-color);
}
.canvas-node.is-selected.is-dragging .canvas-node-container { box-shadow: var(--shadow-drag), 0 0 0 2px var(--accent-color); }

.canvas-node-content { position: relative; flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; overflow: hidden; }
.canvas-node.is-themed .canvas-node-content { background-color: color-mix(in srgb, var(--canvas-color) 7%, transparent); }
.canvas-node-content-blocker { position: absolute; inset: 0; z-index: 2; }

/* A card's title rides ABOVE the card, so a header row never eats its height. */
.canvas-node-label {
  position: absolute;
  left: 0;
  top: calc(-4px * var(--zm));
  transform: translate(0, -100%) scale(var(--zm));
  transform-origin: bottom left;
  max-width: calc(100% / var(--zm));
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-tertiary);
  font: inherit;
  font-size: var(--smaller-font-size, .75rem);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  --canvas-icon-size: 13px;
}
.canvas-node-label > span { overflow: hidden; text-overflow: ellipsis; }
.canvas-node-label:hover { color: var(--text-color); }
.canvas-node-label.mod-hover-label { opacity: 0; cursor: default; }
.canvas-node:hover .canvas-node-label.mod-hover-label, .canvas-node.is-focused .canvas-node-label.mod-hover-label { opacity: 1; }
.canvas-node.is-selected .canvas-node-label { color: var(--text-secondary); }

/* ── Groups ────────────────────────────────────────────────────────────────── */
.canvas-node-group:not(.is-focused):not(.is-selected) { pointer-events: none; }
.canvas-node-group .canvas-node-resizer, .canvas-node-group .canvas-group-label { pointer-events: auto; }
.canvas-node-group .canvas-node-container {
  background-color: transparent;
  border: 1px solid color-mix(in srgb, var(--canvas-color) 40%, transparent);
  border-radius: var(--radius-lg);
  box-shadow: none;
}
.canvas-node-group.is-themed .canvas-node-container { border-color: color-mix(in srgb, var(--canvas-color) 55%, transparent); box-shadow: none; }
.canvas-node-group.is-selected .canvas-node-container { border-color: var(--accent-color); box-shadow: 0 0 0 2px var(--accent-color); }
.canvas-node-group .canvas-node-content { background-color: color-mix(in srgb, var(--canvas-color) 7%, transparent); }
.canvas-group-label {
  position: absolute;
  left: 0;
  top: calc(-4px * var(--zm));
  transform: translate(0, -100%) scale(var(--zm));
  transform-origin: bottom left;
  max-width: calc(100% / var(--zm));
  box-sizing: border-box;
  padding: 3px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background-color: color-mix(in srgb, var(--canvas-color) 12%, transparent);
  color: var(--text-color);
  font: inherit;
  font-size: var(--normal-font-size);
  font-weight: var(--font-semi-bold, 600);
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.canvas-root:not(.is-readonly) .canvas-group-label { cursor: grab; }
/* A themed group fills its plate solid; the paired foreground comes from the palette. */
.canvas-node-group.is-themed .canvas-group-label:not(.is-editing) { background-color: var(--canvas-color); color: var(--canvas-color-contrast, var(--title-color)); }
.canvas-group-label.is-editing {
  min-width: 8em;
  outline: none;
  cursor: text;
  background-color: var(--control-bg);
  box-shadow: 0 0 0 1px var(--accent-color);
  color: var(--text-color);
}
.canvas-group-background { position: absolute; inset: 0; background-repeat: no-repeat; background-position: center; }
.canvas-group-background.mod-cover { background-size: cover; }
.canvas-group-background.mod-ratio { background-size: contain; }
.canvas-group-background.mod-repeat { background-repeat: repeat; background-position: 0 0; background-size: auto; }

/* ── Zoomed out: labels go, cards become their title or a type glyph. ─────── */
.canvas-root.is-zoomed-out .canvas-node-label { display: none; }
.canvas-node-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 24px;
  overflow: hidden;
  overflow-wrap: anywhere;
  text-align: center;
  font-family: var(--title-font, inherit);
  font-size: 2rem;
  font-weight: var(--font-semi-bold, 600);
  color: var(--title-color);
  background-color: color-mix(in srgb, var(--canvas-color) 10%, transparent);
}
.canvas-icon-placeholder { display: flex; width: 40%; height: 40%; }
.canvas-icon-placeholder .canvas-icon { width: 100%; height: 100%; opacity: .35; color: var(--canvas-color); stroke-width: 1.5; }

/* ── Resizers + connection points ──────────────────────────────────────────── */
.canvas-node-interaction-layer { position: absolute; inset: 0; pointer-events: none; }
.canvas-node-resizer { position: absolute; width: calc(20px * var(--zm)); height: calc(20px * var(--zm)); pointer-events: auto; z-index: 3; }
.canvas-node.is-selected:not(.is-focused) .canvas-node-resizer { pointer-events: none; }
.canvas-node-resizer[data-resize='n'] { left: 0; right: 0; width: auto; top: calc(-10px * var(--zm)); cursor: ns-resize; }
.canvas-node-resizer[data-resize='s'] { left: 0; right: 0; width: auto; bottom: calc(-10px * var(--zm)); cursor: ns-resize; }
.canvas-node-resizer[data-resize='w'] { top: 0; bottom: 0; height: auto; left: calc(-10px * var(--zm)); cursor: ew-resize; }
.canvas-node-resizer[data-resize='e'] { top: 0; bottom: 0; height: auto; right: calc(-10px * var(--zm)); cursor: ew-resize; }
.canvas-node-resizer[data-resize='ne'] { right: calc(-10px * var(--zm)); top: calc(-10px * var(--zm)); cursor: nesw-resize; }
.canvas-node-resizer[data-resize='se'] { right: calc(-10px * var(--zm)); bottom: calc(-10px * var(--zm)); cursor: nwse-resize; }
.canvas-node-resizer[data-resize='nw'] { left: calc(-10px * var(--zm)); top: calc(-10px * var(--zm)); cursor: nwse-resize; }
.canvas-node-resizer[data-resize='sw'] { left: calc(-10px * var(--zm)); bottom: calc(-10px * var(--zm)); cursor: nesw-resize; }
/* The connection point for a side appears while that side is hovered. */
.canvas-node-connection-point { position: absolute; width: calc(12px * var(--zm)); height: calc(12px * var(--zm)); cursor: crosshair; }
.canvas-node-connection-point[data-side='top'], .canvas-node-connection-point[data-side='bottom'] { top: calc(4px * var(--zm)); left: calc(50% - 6px * var(--zm)); }
.canvas-node-connection-point[data-side='left'], .canvas-node-connection-point[data-side='right'] { left: calc(4px * var(--zm)); top: calc(50% - 6px * var(--zm)); }
.canvas-node-connection-point::after {
  content: '';
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: calc(1.5px * var(--zm)) solid var(--border-medium);
  background-color: var(--canvas-card-bg);
  opacity: 0;
  transition: opacity .12s, background-color .12s, border-color .12s;
}
.canvas-node-resizer:hover .canvas-node-connection-point::after { opacity: 1; }
.canvas-node-connection-point:hover::after { background-color: var(--accent-color); border-color: var(--accent-color); }
.canvas-root.is-readonly .canvas-node-interaction-layer { display: none; }

/* ── Selection, snapping, the card being dragged out of the create menu ────── */
.canvas-selection { position: absolute; pointer-events: none; box-sizing: border-box; background-color: color-mix(in srgb, var(--accent-color) 12%, transparent); border: 1px solid var(--accent-color); z-index: 14; }
.canvas-selection.mod-group-selection {
  border: 1px dashed color-mix(in srgb, var(--accent-color) 60%, transparent);
  border-radius: var(--radius);
  background-color: color-mix(in srgb, var(--accent-color) 4%, transparent);
  z-index: 13;
}
.canvas-snap-guide { position: absolute; z-index: 14; pointer-events: none; background: var(--accent-color); opacity: .7; }
.canvas-drag-ghost {
  position: absolute;
  z-index: 22;
  pointer-events: none;
  box-sizing: border-box;
  border: 2px solid var(--accent-color);
  border-radius: var(--radius);
  background-color: color-mix(in srgb, var(--accent-color) 18%, transparent);
  box-shadow: var(--shadow-drag);
}

/* ── Screen-space chrome: Valley toolbars ──────────────────────────────────── */
.canvas-icon { width: var(--canvas-icon-size, 16px); height: var(--canvas-icon-size, 16px); stroke-width: var(--canvas-icon-stroke, 2px); flex: 0 0 auto; }
.canvas-toolbar, .canvas-card-menu, .canvas-control-group, .canvas-menu, .canvas-submenu {
  border: 1px solid var(--menu-border, var(--border-light));
  border-radius: var(--radius);
  background-color: var(--menu-bg, var(--container-color));
  box-shadow: var(--canvas-shadow-float);
}
.canvas-btn, .canvas-card-menu-button, .canvas-control-item, .canvas-menu .clickable-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--icon-color, var(--text-color));
  cursor: pointer;
}
.canvas-btn:hover, .canvas-card-menu-button:hover, .canvas-control-item:hover, .canvas-menu .clickable-icon:hover,
.canvas-menu .clickable-icon.is-active { background: var(--hover-bg); color: var(--text-color); }
.canvas-control-item.is-active { color: var(--accent-color); }
.canvas-menu .clickable-icon.is-danger { color: var(--negative-color); }
.canvas-menu .clickable-icon.is-danger:hover { background: color-mix(in srgb, var(--negative-color) 12%, transparent); }

.canvas-card-menu {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
}
.canvas-card-menu .sep, .canvas-menu .sep { width: 1px; align-self: stretch; margin: 2px 3px; background: var(--border-light); }
.canvas-card-menu-button { cursor: grab; }
.canvas-card-menu-button:active { cursor: grabbing; }

.canvas-controls {
  position: absolute;
  right: 12px;
  top: 12px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.canvas-control-group { display: flex; flex-direction: column; gap: 2px; padding: 3px; }

.canvas-menu-container { position: absolute; z-index: 24; }
.canvas-menu { position: relative; display: flex; align-items: center; gap: 1px; padding: 3px; }
.canvas-submenu {
  background: var(--container-color);
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
}
.canvas-color-picker-item {
  position: relative;
  width: 22px;
  height: 22px;
  padding: 0;
  box-sizing: border-box;
  border-radius: 50%;
  border: 2px solid var(--menu-bg, var(--container-color));
  background-color: var(--canvas-color);
  box-shadow: 0 0 0 1px var(--border-medium);
  cursor: pointer;
  overflow: hidden;
}
.canvas-color-picker-item.is-active { box-shadow: 0 0 0 2px var(--accent-color); }
.canvas-color-picker-item.is-none { background: var(--surface-color); }
.canvas-color-picker-item.is-none::after {
  content: '';
  position: absolute;
  left: -2px;
  right: -2px;
  top: 50%;
  height: 1.5px;
  background: var(--negative-color);
  transform: rotate(-45deg);
}
.canvas-color-picker-custom:not(.is-active) { background: conic-gradient(var(--color-red), var(--color-yellow), var(--color-green), var(--color-cyan), var(--color-purple), var(--color-red)); }
.canvas-color-picker-custom input[type='color'] { position: absolute; inset: -4px; width: calc(100% + 8px); height: calc(100% + 8px); opacity: 0; cursor: pointer; padding: 0; border: 0; }

/* ── Messages ──────────────────────────────────────────────────────────────── */
.canvas-banner {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  max-width: calc(100% - 140px);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--menu-border, var(--border-light));
  border-radius: var(--radius);
  background: var(--menu-bg, var(--container-color));
  color: var(--text-color);
  box-shadow: var(--shadow-popover);
  font-size: var(--small-font-size);
}
.canvas-banner button {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  background: var(--control-bg);
  color: var(--text-color);
  font: inherit;
  cursor: pointer;
}
.canvas-banner button:hover { background: var(--hover-bg); }

.canvas-file-missing, .canvas-file-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  margin: 0;
  padding: 16px;
  box-sizing: border-box;
  color: var(--text-tertiary);
  font-size: var(--small-font-size);
  text-align: center;
  overflow-wrap: anywhere;
  --canvas-icon-size: 28px;
  --canvas-icon-stroke: 1.5px;
}
.canvas-file-loading { height: 100%; }
.canvas-link-edit { display: flex; align-items: center; height: 100%; padding: 0 12px; box-sizing: border-box; }
.canvas-link-invalid { font-size: var(--small-font-size); font-weight: normal; color: var(--text-tertiary); }
.canvas-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  background: var(--control-bg);
  color: var(--text-color);
  font: inherit;
  font-size: var(--small-font-size);
  outline: none;
}

/* ── Notes inside cards (rendered by the host's Markdown surface) ──────────── */
.canvas-markdown-file { display: flex; flex-direction: column; height: 100%; }
.canvas-markdown-file-body { position: relative; flex: 1 1 auto; min-height: 0; }
.canvas-markdown-file .canvas-file-error { height: auto; }
.canvas-markdown { box-sizing: border-box; padding: 10px 14px; background: transparent; }
.canvas-text-editor { height: 100%; overflow: auto; cursor: text; }

/* ── The minimap an embedded board shows ───────────────────────────────────── */
.canvas-minimap-embed {
  --canvas-color-default: var(--text-tertiary);
  --canvas-color: var(--canvas-color-default);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 60px;
  box-sizing: border-box;
  cursor: pointer;
  color: var(--text-tertiary);
}
.canvas-minimap { display: block; width: 100%; height: 100%; max-height: 400px; padding: 4px; box-sizing: border-box; }
.canvas-minimap rect { stroke: var(--border-medium); fill: var(--border-medium); fill-opacity: .65; }
.canvas-minimap rect.is-themed { stroke: var(--canvas-color); fill: var(--canvas-color); fill-opacity: .5; }
.canvas-minimap path { fill: none; stroke: var(--canvas-color-default); }
.canvas-minimap path.is-themed { stroke: var(--canvas-color); }
.canvas-minimap-message { padding: 16px; font-size: var(--small-font-size); text-align: center; }

/* ── Help and the vault file picker (inside host modals) ───────────────────── */
.canvas-help { display: flex; flex-direction: column; gap: 10px; font-size: var(--small-font-size); }
.canvas-instruction { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.canvas-instruction-desc { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.canvas-hotkey-combo { display: inline-flex; gap: 2px; }
.canvas-hotkey { display: inline-block; padding: 2px 6px; border-radius: var(--radius-sm); background: var(--tooltip-key-bg, var(--hover-bg)); color: var(--tooltip-key-text, var(--text-color)); font: inherit; font-size: var(--smaller-font-size, .75rem); line-height: 1.2; }

.canvas-suggest { display: flex; flex-direction: column; gap: 8px; min-height: 320px; }
.canvas-suggest-input {
  width: 100%;
  box-sizing: border-box;
  min-height: var(--control-min-height, 30px);
  padding: var(--control-padding, 6px 10px);
  border: 1px solid var(--control-border, var(--border-medium));
  border-radius: var(--control-radius, var(--radius-sm));
  background: var(--control-bg);
  color: var(--control-text, var(--text-color));
  font: inherit;
  outline: none;
}
.canvas-suggest-input:focus { border-color: var(--control-focus-border, var(--accent-color)); box-shadow: none; }
.canvas-suggest-list { display: flex; flex-direction: column; gap: 2px; max-height: 360px; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 2px; }
.canvas-suggest .canvas-suggest-item {
  display: flex;
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: auto;
  min-height: 56px;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  box-shadow: none;
  color: var(--menu-text, var(--text-color));
  font: inherit;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
}
.canvas-suggest-item.is-selected, .canvas-suggest-item:hover { background: var(--menu-hover-bg, var(--hover-bg)); }
.canvas-suggest-item > .canvas-icon { color: var(--text-tertiary); }
.canvas-suggest-copy { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
.canvas-suggest-title, .canvas-suggest-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.canvas-suggest-title { font-weight: 500; }
.canvas-suggest-note { color: var(--text-tertiary); font-size: var(--smaller-font-size, .75rem); }
.canvas-suggest-empty { padding: 12px 10px; color: var(--text-tertiary); }

.canvas-property-input { width: 100%; min-width: 0; background: var(--input-background); color: var(--text-color); border: 1px solid var(--border-color); border-radius: var(--radius); padding: var(--space-2); }
`

export function injectStyles(): () => void {
  const id = 'canvas-plugin-styles'
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = CSS
  return () => {
    if (document.getElementById(id) === el) el.remove()
  }
}
