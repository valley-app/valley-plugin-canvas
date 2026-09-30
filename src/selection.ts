import type { MutableRefObject } from 'react'
import { React } from './runtime'
import { nodeById, type CanvasData } from './canvasModel'
import { nodeRect, rectContains } from './geometry'

export function useCanvasSelection(modelRef: MutableRefObject<CanvasData>) {
  const [selection, setSelection] = React.useState<Set<string>>(new Set())
  const [selectedEdge, setSelectedEdge] = React.useState<string | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editingEdgeLabel, setEditingEdgeLabel] = React.useState<string | null>(null)
  const selectionRef = React.useRef(selection)
  const selectedEdgeRef = React.useRef<string | null>(null)
  const editingRef = React.useRef<string | null>(null)
  selectionRef.current = selection
  selectedEdgeRef.current = selectedEdge
  editingRef.current = editingId

  const replaceSelection = (ids: Set<string>): void => {
    selectionRef.current = ids
    setSelection(ids)
  }

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

  return { selection, setSelection, selectionRef, selectedEdge, setSelectedEdge, selectedEdgeRef, editingId, setEditingId, editingRef, editingEdgeLabel, setEditingEdgeLabel, replaceSelection, expandWithGroups }
}
