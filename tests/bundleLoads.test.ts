// @vitest-environment node
// esbuild's Uint8Array invariant breaks under jsdom; this guard runs in node.
import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { buildPlugin } from '@valley/plugin-tools'

/**
 * Guard: the canvas bundle must *evaluate* (import) with the host's `React`
 * binding still unset — exactly the host's situation before `register()` runs.
 * A regression to eager module-scope JSX (an icon defined as a bare element
 * instead of a component) compiles to a `React.createElement(...)` call at import
 * time and rejects the whole bundle (no file view, no command). Uses the real
 * compile semantics (`src/shared/pluginBuildOptions.ts`), shared with the build
 * scripts and the in-app source compiler, so the guard cannot drift from them.
 */
const PLUGIN = resolve(__dirname, '..')

describe('canvas plugin bundle', () => {
  it('imports with React unset and exposes register()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canvas-bundle-'))
    const outfile = join(dir, 'index.js')
    await buildPlugin({ root: PLUGIN, outDir: dir, mode: 'development' })

    const mod = (await import(pathToFileURL(outfile).href)) as { register?: unknown }
    expect(typeof mod.register).toBe('function')
  })
})
