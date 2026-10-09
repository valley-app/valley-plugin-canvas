# Canvas

Infinite canvas for JSON Canvas `.canvas` files: text, note, media and web page cards, groups and connections on a pan/zoom board. Board mechanics follow the common JSON Canvas conventions; everything you see uses Valley's design, and file cards are shown by Valley's own viewers.

This repository owns the plugin’s interface, behavior, dependencies, schemas, tests, translations, and compiled releases. It uses Valley manifest API 5 and the injected SDK 6.

Valley ships this core plugin as a verified release artifact in its application resources. Core and external installations run with the same sandbox, permissions, and SDK/IPC contract. The core package and its locale files are never installed into `.valley`; ordinary vault documents and saved plugin data retain their existing locations.

## Package

- `manifest.json`: readable English identity, version, and paired `author` / `authorUrl` arrays.
- `config.json`: runtime entry points, permissions, contributions, and storage declarations.
- `src/`: plugin interface.
- `locales/`: English, German, Spanish, French, and Simplified Chinese catalogs.
- `tests/`: package-owned checks using the portable SDK testkit.
- `runtime/`: compiled installation artifact, including the package’s locale catalogs.
- `vendor/`: pinned SDK, testkit, and build-tool archives for independent development.

The package’s `manifest.name` and `manifest.description` catalog entries translate its identity, including while disabled. Missing translations fall back to this package’s English catalog. A plugin never falls back to Valley’s catalog or another plugin’s catalog.

## Development and releases

Use Node 24.19.0 and npm 11.17.0. From this repository, run:

```sh
npm ci
npm run check
```

The check validates types and package boundaries, runs the package tests, and rebuilds `runtime/`. It requires no Valley source checkout. Keep the rebuilt runtime, locale files, dependency lock, and vendored tools with each release. Increment the package and manifest versions together.

Valley release maintainers explicitly import the compiled artifact into the application’s `plugins.lock.json`; building Valley does not build or read this repository. All privileged work uses declared SDK capabilities, authenticated IPC, and explicit grants. Disabling or unloading the plugin releases its subscriptions and resources.

## Workflow integration

Explicit Workflow blocks reuse this package’s published owner commands through the authenticated SDK command bridge. Configure the application window and required targets before running. Schemas and owner identities are pinned; contract changes require reloading the integration. Writes retain existing grants, revision checks, undo behavior and authoritative receipts. Preview and block insertion perform no commands.

## Document automation

Canvas owns the background `canvas:document-inspect`, `canvas:document-read`,
`canvas:document-create` and `canvas:document-edit` commands. They use the injected
vault API and never open or focus a viewer. Inspect returns the required observed
revision, including an owner-issued absence revision for creation. Editing accepts
1–100 operations, validates the complete batch before one guarded write, preserves
unknown JSON fields, and independently reads the saved bytes before returning
`{path, revision, verified: true}`. Dirty editor protection remains in the host.

Read pages select `nodes`, `edges`, `properties`, `preservedNodes`, or
`preservedEdges`; every page requires the same observed revision. Automation is
bounded to 512 KiB documents, 100 items and 64 KiB per page. Stale revisions fail;
lost write acknowledgements remain uncertain and are never replayed by the plugin.

The renderer commands `canvas:edit` and `canvas:properties-edit` also require
`expectedRevision` from `canvas:get`. `canvas:create-observe` observes a specific
unused path before `canvas:create`; creation stays in the background unless
`open: true` is explicitly requested. The New canvas UI prepares this observation
and dispatches the same creation command. Existing background backend commands
provide durable transaction metadata; UI-only inverses remain tied to their owner.
Renderer mutation discovery names the required inspection command and declares
non-replayable recovery. `canvas:open` remains a human action and is unavailable
to autonomous callers until it has an exact viewer target contract.

Mounted Canvas views expose zoom, fit, lock, single-card/connection selection,
clear selection, per-axis pan and fit selection through `viewer:inspect` and
`viewer:control`. Each action requires the observed view revision and exact host
mount identity. Editing, gestures, dialogs, active Properties fields and pending
commits block viewer actions; history, arrangement and multi-selection automation
still require additional owning contracts.

The 2.1.6 Properties fix derives command editability from current document state
and keeps editable inputs mounted across transient saves. A focused field retains
its draft when a concurrent command changes the document; saving an older draft
fails its revision check and preserves the entered value. Persistent view locks
remain local to the addressed copy. Four owner regressions cover command saves
followed by UI editing, overlapping drafts, failure and cancellation, including
the opposite locked copy and unknown document fields. The package has 208 passing
tests; deployed CLI/MCP and Electron acceptance of this fix remains a separate gate.

The 2.1.7 Properties fix shows an unavailable state when its exact source view
closes or is replaced. It never borrows another open copy's selection or rows.
Stored field drafts survive until an explicitly addressed subject returns, and
late reads from the closed view cannot update the replacement. Two additional
owner regressions cover cleanup beside a locked copy, generation replacement,
strict stale-control refusal and retained drafts. The package has 210 passing
tests; clean deployed Electron teardown remains a separate acceptance gate.

The 2.1.8 Properties fix rechecks the exact session, selection, lock, cancellation
and source revision synchronously after the last awaited authorization step and
immediately before the existing guarded write. Command and native blur regressions
first reproduced a saved Width of 260 after its source view closed (fixture Width
200). Five new cases refuse that dispatch, selection changes, cancellation and
generation replacement while preserving the other copy and retained field drafts.
This is owner evidence for pre-dispatch refusal; deployed CLI/MCP and Electron
acceptance, and effects already dispatched before a disconnect, remain separate.

Verification evidence: focused Canvas source tests cover guarded creation, stale
revisions, atomic multi-edits, retained/dirty drafts, unknown JSON fields, bounded
reads, cancellation, owner replacement, lost acknowledgements and independent
readback. Deployed Electron and external CLI/MCP acceptance are separate gates.
Existing workflow adapter contracts are unchanged and are outside this change;
old pinned renderer input schemas do not imply compatibility with required revisions.
