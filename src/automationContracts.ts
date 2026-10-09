import { canvasOperationSchema, objectSchema } from './operations'

const path = { type: 'string', minLength: 1, maxLength: 4096 }
const revision = { type: 'string', minLength: 1, maxLength: 512 }
const count = { type: 'integer', minimum: 0 }
export const canvasMutationOutput = objectSchema({ path, revision, verified: { const: true } }, ['path', 'revision', 'verified'])
export const canvasInspectInput = objectSchema({ path }, ['path'])
export const canvasObservedInput = objectSchema({ path, expectedRevision: revision }, ['path', 'expectedRevision'])
export const canvasInspectOutput = objectSchema({ path, revision, exists: { type: 'boolean' }, nodes: count, edges: count, preservedNodes: count, preservedEdges: count }, ['path', 'revision', 'exists', 'nodes', 'edges', 'preservedNodes', 'preservedEdges'])
const collection = { enum: ['nodes', 'edges', 'properties', 'preservedNodes', 'preservedEdges'] }
export const canvasReadInput = objectSchema({ path, expectedRevision: revision, collection, offset: count, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['path', 'expectedRevision', 'collection'])
export const canvasReadOutput = objectSchema({ path, revision, collection, offset: count, total: count, items: { type: 'array', maxItems: 100, items: {} }, nextOffset: { type: ['integer', 'null'], minimum: 0 } }, ['path', 'revision', 'collection', 'offset', 'total', 'items', 'nextOffset'])
export const canvasEditInput = objectSchema({ path, expectedRevision: revision, operations: { type: 'array', minItems: 1, maxItems: 100, items: canvasOperationSchema } }, ['path', 'expectedRevision', 'operations'])

export const canvasDataSchema = objectSchema({ nodes: { type: 'array', items: { type: 'object', additionalProperties: true } }, edges: { type: 'array', items: { type: 'object', additionalProperties: true } }, extra: { type: 'object', additionalProperties: true }, preserved: objectSchema({ nodes: { type: 'array', items: objectSchema({ index: count, raw: {} }, ['index', 'raw']) }, edges: { type: 'array', items: objectSchema({ index: count, raw: {} }, ['index', 'raw']) } }, ['nodes', 'edges']) }, ['nodes', 'edges'])
