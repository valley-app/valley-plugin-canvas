import type { MutableRefObject } from 'react'
import { React } from './runtime'
import { nodeById, type CanvasData } from './canvasModel'
import { nodeRect, rectContains } from './geometry'

export function useCanvasSelection(modelRef: MutableRefObject<CanvasData>) {
  const [selection, publishSelection] = React.useState<Set<string>>(new Set())
  const [selectedEdge, publishSelectedEdge] = React.useState<string | null>(null)
  const [editingId, publishEditingId] = React.useState<string | null>(null)
  const [editingEdgeLabel, publishEditingEdgeLabel] = React.useState<string | null>(null)
  const selectionRef = React.useRef(selection)
  const selectedEdgeRef = React.useRef<string | null>(null)
  const editingRef = React.useRef<string | null>(null)
  const editingEdgeRef = React.useRef<string | null>(null)
  selectionRef.current = selection
  selectedEdgeRef.current = selectedEdge
  editingRef.current = editingId
  editingEdgeRef.current = editingEdgeLabel

  const setSelection = React.useCallback((ids: Set<string>): void => {
    selectionRef.current = ids
    publishSelection(ids)
  }, [])
  const setSelectedEdge = React.useCallback((id: string | null): void => { selectedEdgeRef.current = id; publishSelectedEdge(id) }, [])
  const setEditingId = React.useCallback((id: string | null): void => { editingRef.current = id; publishEditingId(id) }, [])
  const setEditingEdgeLabel = React.useCallback((id: string | null): void => { editingEdgeRef.current = id; publishEditingEdgeLabel(id) }, [])
  const selectSingleNode = (id: string): void => { setSelection(new Set([id])); setSelectedEdge(null) }
  const selectSingleEdge = (id: string): void => { setSelection(new Set()); setSelectedEdge(id) }
  const clearSelection = (): void => { setSelection(new Set()); setSelectedEdge(null) }

  const expandWithGroups = (ids: Set<string>): Set<string> => {
    const data = modelRef.current
    const out = new Set(ids)
    for (const id of ids) {
      const node = nodeById(data, id)
      if (node?.type !== 'group') continue
      const groupRect = nodeRect(node)
      for (const other of data.nodes) {
        if (other.id === id) continue
        if (rectContains(groupRect, nodeRect(other))) out.add(other.id)
      }
    }
    return out
  }

  return { selection, setSelection, selectionRef, selectedEdge, setSelectedEdge, selectedEdgeRef, editingId, setEditingId, editingRef, editingEdgeLabel, setEditingEdgeLabel, editingEdgeRef, replaceSelection: setSelection, selectSingleNode, selectSingleEdge, clearSelection, expandWithGroups }
}
