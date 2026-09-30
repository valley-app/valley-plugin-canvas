import * as React from 'react'
import type { MockValleyApi } from '@valley/plugin-testkit'

/**
 * Stand-ins for the host widgets a board renders: the reading surface shows its
 * value as text, the inline editor is a textarea that reports every change,
 * and a file preview names the file it would show. The real widgets are
 * host-rendered overlays that jsdom cannot mount.
 */
export function withHostUi<T extends MockValleyApi>(mock: T): T {
  const ui = mock.api.ui as unknown as Record<string, unknown>
  ui.MarkdownView = ({ value, className }: { value: string; className?: string }) => <div className={className} data-testid="markdown-view">{value}</div>
  ui.FilePreview = ({ relPath, subpath }: { relPath: string; subpath?: string }) => <div data-testid="file-preview">{`${relPath}${subpath ?? ''}`}</div>
  ui.createMarkdownEditor = (parent: HTMLElement, options: { initialValue: string; onChange(value: string): void; onSave(): void; onCancel(): void; autoFocus?: boolean }) => {
    const area = parent.ownerDocument.createElement('textarea')
    area.value = options.initialValue
    area.addEventListener('input', () => options.onChange(area.value))
    area.addEventListener('change', () => options.onChange(area.value))
    area.addEventListener('keydown', (event) => { if (event.key === 'Escape') options.onCancel(); else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) options.onSave() })
    parent.append(area)
    if (options.autoFocus) area.focus()
    return { destroy: () => area.remove(), focus: () => area.focus() }
  }
  return mock
}
