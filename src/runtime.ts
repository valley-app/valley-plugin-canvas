import type { ValleyPluginApi } from '@valley/plugin-sdk'

export let React!: typeof import('react')
export let api!: ValleyPluginApi

export interface CanvasOwner {
  readonly api: ValleyPluginApi
  readonly root: string | undefined
  isActive(): boolean
  assertActive(): void
  run<T>(operation: () => T | Promise<T>): Promise<T>
  get<T>(key: string, create: () => T): T
  onDispose(callback: () => void): () => void
  beforeUnload(callback: () => Promise<void>): () => void
  dispose(): Promise<void>
}
const owners = new WeakMap<ValleyPluginApi, CanvasOwner>()
let current: CanvasOwner | undefined

function createOwner(source: ValleyPluginApi, previous?: CanvasOwner): CanvasOwner {
  const root = source.getState().vault?.path
  let active = true
  const pending = new Set<Promise<unknown>>()
  const values = new Map<string, unknown>()
  const cleanups = new Set<() => void>()
  const flushers = new Set<() => Promise<void>>()
  const barrier = previous?.dispose()
  let waiting = Boolean(barrier)
  void barrier?.then(() => { waiting = false })
  let offState = (): void => {}
  let offUnload = (): void => {}
  const owner: CanvasOwner = {
    api: source, root,
    isActive: () => { if (!active) return false; try { return source.getState().vault?.path === root } catch { return false } },
    assertActive: () => { if (!owner.isActive()) throw new Error('The canvas session is no longer active.') },
    run: <T,>(operation: () => T | Promise<T>): Promise<T> => {
      const task = (async () => { if (waiting) await barrier; owner.assertActive(); return operation() })()
      pending.add(task)
      void task.then(() => pending.delete(task), () => pending.delete(task))
      return task
    },
    get: <T,>(key: string, create: () => T): T => {
      if (!values.has(key)) { owner.assertActive(); values.set(key, source.runtime.getOrCreate(key, create)) }
      return values.get(key) as T
    },
    onDispose: (callback) => { cleanups.add(callback); return () => { cleanups.delete(callback) } },
    beforeUnload: (callback) => { flushers.add(callback); return () => { flushers.delete(callback) } },
    dispose: async () => {
      if (active) { active = false; offState(); offUnload(); for (const cleanup of cleanups) cleanup(); cleanups.clear(); flushers.clear() }
      await barrier
      while (pending.size) await Promise.allSettled([...pending])
    }
  }
  offState = source.subscribeState(['vault'], () => { if (!owner.isActive()) void owner.dispose() })
  offUnload = source.runtime.onBeforeUnload(async () => {
    owner.assertActive()
    const results = await Promise.allSettled([...flushers].map((flush) => flush()))
    while (pending.size) await Promise.allSettled([...pending])
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  })
  owners.set(source, owner)
  return owner
}

export function captureCanvasOwner(source: ValleyPluginApi = api): CanvasOwner {
  return owners.get(source) ?? createOwner(source)
}
export function initRuntime(a: ValleyPluginApi): CanvasOwner {
  const previous = current
  if (previous) void previous.dispose()
  api = a
  React = a.React
  current = createOwner(a, previous?.root === a.getState().vault?.path ? previous : owners.get(a))
  return current
}
