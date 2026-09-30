/**
 * What Canvas offers on the empty tab's start screen.
 *
 * Canvas declares no `uiSlots`, so core derives no row for it — and "open
 * Canvas" would be the wrong row anyway: there is no Canvas page, only `.canvas`
 * files. The useful offer is the action.
 *
 * A `.ts` file on purpose: `label` is the English fallback a host without a
 * catalog renders, and `tooling/architecture/localize-ui-literals.mjs` walks `.tsx` only — in
 * one of those it would be rewritten into a catalog lookup and the fallback
 * would be gone.
 */
import type { NewTabEntry } from '@valley/plugin-sdk'

/** The descriptor `register()` hands to the `newTab.entry` point. The action
 *  arrives as an argument so this module stays free of the plugin api and is
 *  unit-testable without one. */
export function canvasNewTabEntry(run: () => void | Promise<void>): NewTabEntry {
  return {
    id: 'canvas:create',
    labelKey: 'plugin.canvas.newTab.create',
    label: 'New canvas',
    icon: 'shapes',
    // The bare command id — the host prefixes it with the owner it recorded.
    hotkeyCommand: 'create',
    run
  }
}
