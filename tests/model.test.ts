import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CANVAS_PRESET_PALETTE,
  fileSubpath,
  groupBackground,
  parseCanvasDocument,
  validEnd,
  validSide,
  type FileNode,
  type GroupNode,
  addEdge,
  addNode,
  createFileNode,
  createGroupNode,
  createLinkNode,
  createTextNode,
  genId,
  duplicateNodes,
  moveNodes,
  nextEdgeEnds,
  parseCanvas,
  removeEdges,
  removeNodes,
  reorderNodes,
  resolveColor,
  serializeCanvas,
  setEdgeColor,
  setEdgeEnds,
  setEdgeLabel,
  setNodePositions,
  setNodeRect,
  setNodeText,
  setNodesColor,
  sliceSubpath,
  updateNode,
  type CanvasData,
  type CanvasEdge,
  type TextNode
} from '../src/canvasModel'

const sample: CanvasData = {
  nodes: [
    { id: 'a', type: 'text', text: 'hello', x: 0, y: 0, width: 250, height: 120 },
    { id: 'b', type: 'file', file: 'Note.md', x: 400, y: 0, width: 400, height: 400, color: '4' }
  ],
  edges: [{ id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', toEnd: 'arrow' }]
}

describe('parseCanvas / serializeCanvas', () => {
  it('returns an empty canvas for empty or whitespace input', () => {
    expect(parseCanvas('')).toEqual({ nodes: [], edges: [] })
    expect(parseCanvas('   \n ')).toEqual({ nodes: [], edges: [] })
  })

  it('never throws on malformed JSON — degrades to empty', () => {
    expect(parseCanvas('{ this is not json')).toEqual({ nodes: [], edges: [] })
    expect(parseCanvas('42')).toEqual({ nodes: [], edges: [] })
    expect(parseCanvas('[1,2,3]')).toEqual({ nodes: [], edges: [] })
  })

  it('round-trips a model through serialize → parse', () => {
    const text = serializeCanvas(sample)
    expect(parseCanvas(text)).toEqual(sample)
  })

  it('writes the tab-indented, one-entry-per-line JSON Canvas layout', () => {
    const text = serializeCanvas(sample)
    expect(text.startsWith('{\n\t"nodes":[\n\t\t{')).toBe(true)
    expect(text.endsWith('\n\t]\n}')).toBe(true)
    expect(text.split('\n').filter((line) => line.startsWith('\t\t{'))).toHaveLength(sample.nodes.length + sample.edges.length)
    expect(serializeCanvas({ nodes: [], edges: [] })).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}')
  })

  it('drops nodes without an id or with an unknown type', () => {
    const data = parseCanvas(
      JSON.stringify({
        nodes: [
          { type: 'text', x: 0, y: 0, width: 10, height: 10 }, // no id
          { id: 'x', type: 'bogus', x: 0, y: 0, width: 10, height: 10 }, // bad type
          { id: 'ok', type: 'text', text: 'k', x: 1, y: 2, width: 3, height: 4 }
        ],
        edges: []
      })
    )
    expect(data.nodes.map((n) => n.id)).toEqual(['ok'])
  })

  it('drops edges missing endpoints', () => {
    const data = parseCanvas(
      JSON.stringify({ nodes: [], edges: [{ id: 'e', fromNode: 'a' }, { id: 'ok', fromNode: 'a', toNode: 'b' }] })
    )
    expect(data.edges.map((e) => e.id)).toEqual(['ok'])
  })

  it('preserves unknown node/edge fields written by other tools', () => {
    const raw = JSON.stringify({
      nodes: [{ id: 'a', type: 'text', text: 't', x: 0, y: 0, width: 9, height: 9, styleAttributes: { shape: 'pill' } }],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'a', customField: 7 }]
    })
    const data = parseCanvas(raw)
    expect((data.nodes[0] as Record<string, unknown>).styleAttributes).toEqual({ shape: 'pill' })
    expect((data.edges[0] as Record<string, unknown>).customField).toBe(7)
    // …and they survive a serialize round-trip.
    expect(parseCanvas(serializeCanvas(data))).toEqual(data)
  })

  it('coerces non-numeric coordinates to safe defaults', () => {
    const data = parseCanvas(JSON.stringify({ nodes: [{ id: 'a', type: 'text', x: 'NaN', width: null }], edges: [] }))
    expect(data.nodes[0].x).toBe(0)
    expect(data.nodes[0].width).toBe(250)
  })
})

describe('node factories + genId', () => {
  it('genId returns 16 lowercase hex chars and is unique', () => {
    const a = genId()
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(genId()).not.toBe(a)
  })

  it('factories build well-formed nodes', () => {
    expect(createTextNode(5, 6, 'hi')).toMatchObject({ type: 'text', text: 'hi', x: 5, y: 6 })
    expect(createFileNode(0, 0, 'A.md')).toMatchObject({ type: 'file', file: 'A.md' })
    expect(createLinkNode(0, 0, 'https://x')).toMatchObject({ type: 'link', url: 'https://x' })
    expect(createGroupNode(0, 0, 100, 80, 'G')).toMatchObject({ type: 'group', label: 'G', width: 100, height: 80 })
  })
})

describe('mutation helpers (immutable)', () => {
  it('moveNodes shifts only the named nodes and does not mutate the input', () => {
    const next = moveNodes(sample, new Set(['a']), 10, 20)
    expect(next.nodes[0]).toMatchObject({ x: 10, y: 20 })
    expect(next.nodes[1].x).toBe(400)
    expect(sample.nodes[0].x).toBe(0) // original untouched
  })

  it('setNodePositions sets absolute positions', () => {
    const next = setNodePositions(sample, new Map([['b', { x: 1, y: 2 }]]))
    expect(next.nodes[1]).toMatchObject({ x: 1, y: 2 })
  })

  it('setNodeRect replaces a node geometry', () => {
    const next = setNodeRect(sample, 'a', { x: 1, y: 2, width: 3, height: 4 })
    expect(next.nodes[0]).toMatchObject({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('removeNodes cascades to connected edges', () => {
    const next = removeNodes(sample, new Set(['b']))
    expect(next.nodes.map((n) => n.id)).toEqual(['a'])
    expect(next.edges).toHaveLength(0)
  })

  it('removeEdges removes only the named edges', () => {
    const next = removeEdges(sample, new Set(['e1']))
    expect(next.edges).toHaveLength(0)
    expect(next.nodes).toHaveLength(2)
  })

  it('addEdge / updateNode / setNodeText', () => {
    const edge: CanvasEdge = { id: 'e2', fromNode: 'b', toNode: 'a' }
    expect(addEdge(sample, edge).edges).toHaveLength(2)
    expect((updateNode(sample, 'a', { text: 'x' } as Partial<TextNode>).nodes[0] as TextNode).text).toBe('x')
    expect((setNodeText(sample, 'a', 'y').nodes[0] as TextNode).text).toBe('y')
  })

  it('setNodesColor applies and clears color', () => {
    const colored = setNodesColor(sample, new Set(['a']), '2')
    expect(colored.nodes[0].color).toBe('2')
    const cleared = setNodesColor(colored, new Set(['a']), undefined)
    expect('color' in cleared.nodes[0]).toBe(false)
  })

  it('setEdgeColor applies and clears color', () => {
    const colored = setEdgeColor(sample, 'e1', '5')
    expect(colored.edges[0].color).toBe('5')
    expect('color' in setEdgeColor(colored, 'e1', undefined).edges[0]).toBe(false)
  })
})

describe('resolveColor', () => {
  // The spec leaves preset values open ("intentionally not defined so that
  // applications can tailor the presets"), so a preset resolves to the palette
  // variable rather than a frozen hex — that is what lets it follow the theme
  // and a user's .valley/design/*.css override.
  it('maps presets to palette variables, passes hex through, rejects the rest', () => {
    expect(resolveColor('1')).toBe('var(--color-red)')
    expect(resolveColor('6')).toBe('var(--color-purple)')
    expect(resolveColor('#abcdef')).toBe('#abcdef')
    expect(resolveColor(undefined)).toBeNull()
    expect(resolveColor('99')).toBeNull()
  })

  it('covers all six presets with a real palette id', () => {
    const ids = Object.values(CANVAS_PRESET_PALETTE)
    expect(ids).toEqual(['red', 'orange', 'yellow', 'green', 'cyan', 'purple'])
    for (const key of Object.keys(CANVAS_PRESET_PALETTE)) {
      expect(resolveColor(key)).toMatch(/^var\(--color-[a-z]+\)$/)
    }
  })
})

/**
 * The one test that checks us against the format rather than against our own
 * idea of it. `sample.canvas` is adapted from the MIT-licensed spec sample with a neutral project link
 * and must round-trip byte-identically.
 */
describe('the official JSON Canvas sample', () => {
  const raw = readFileSync(
    resolve(__dirname, 'fixtures/sample.canvas'),
    'utf8'
  )

  it('parses every node and edge without dropping one', () => {
    const data = parseCanvas(raw)
    expect(data.nodes).toHaveLength(5)
    expect(data.edges).toHaveLength(1)
    expect(data.nodes.map((n) => n.type)).toEqual(['group', 'file', 'file', 'text', 'file'])
    const group = data.nodes[0] as { type: string; label?: string }
    expect(group.label).toBe('JSON Canvas')
    const colored = data.nodes[1] as { color?: string }
    expect(colored.color).toBe('6')
  })

  it('round-trips: serialize(parse(x)) re-parses to the same model', () => {
    const once = parseCanvas(raw)
    const twice = parseCanvas(serializeCanvas(once))
    expect(twice).toEqual(once)
    // Node order is z-order, so it must survive the round trip exactly.
    expect(twice.nodes.map((n) => n.id)).toEqual(once.nodes.map((n) => n.id))
    const edge = twice.edges[0]
    expect(edge.fromSide).toBe('right')
    expect(edge.toSide).toBe('left')
    expect(edge.fromNode).toBe('7efdbbe0c4742315')
  })
})

describe('group background', () => {
  const withBg = (style: unknown): Record<string, unknown> =>
    (parseCanvas(
      JSON.stringify({
        nodes: [
          { id: 'g', type: 'group', x: 0, y: 0, width: 10, height: 10, background: 'Images/a.png', backgroundStyle: style }
        ],
        edges: []
      })
    ).nodes[0] as unknown) as Record<string, unknown>

  it('keeps background and each valid backgroundStyle', () => {
    for (const style of ['cover', 'ratio', 'repeat']) {
      const g = withBg(style)
      expect(g.background).toBe('Images/a.png')
      expect(g.backgroundStyle).toBe(style)
    }
  })

  it('keeps an unknown backgroundStyle on disk and paints it as cover', () => {
    expect(withBg('parallax').backgroundStyle).toBe('parallax')
    expect(groupBackground(withBg('parallax') as unknown as GroupNode)).toEqual({ file: 'Images/a.png', style: 'cover' })
    expect(groupBackground(withBg(7) as unknown as GroupNode)).toEqual({ file: 'Images/a.png', style: 'cover' })
    expect(groupBackground(withBg('ratio') as unknown as GroupNode)).toEqual({ file: 'Images/a.png', style: 'ratio' })
  })
})

describe('file subpath', () => {
  const parseFile = (subpath: unknown): Record<string, unknown> =>
    (parseCanvas(
      JSON.stringify({
        nodes: [{ id: 'f', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'a.md', subpath }],
        edges: []
      })
    ).nodes[0] as unknown) as Record<string, unknown>

  it('reads a subpath that starts with # and keeps one that does not without using it', () => {
    expect(fileSubpath(parseFile('#Heading') as unknown as FileNode)).toBe('#Heading')
    expect(fileSubpath(parseFile('#^abc123') as unknown as FileNode)).toBe('#^abc123')
    expect(parseFile('Heading').subpath).toBe('Heading')
    expect(fileSubpath(parseFile('Heading') as unknown as FileNode)).toBeUndefined()
  })

  const doc = [
    '# Title',
    '',
    'Intro line.',
    '',
    '## Simplicity',
    '',
    'Say no to a thousand things.',
    'It is a judgment, not a subtraction.',
    '',
    '## Taste',
    '',
    'Editing is the work. ^edit-block',
    '',
    '# Other'
  ].join('\n')

  it('slices a heading down to the next heading of equal-or-higher level', () => {
    const out = sliceSubpath(doc, '#Simplicity')
    expect(out).toContain('## Simplicity')
    expect(out).toContain('Say no to a thousand things.')
    expect(out).not.toContain('## Taste')
    expect(out).not.toContain('Intro line.')
  })

  it('slices a block by its ^id and strips the anchor', () => {
    const out = sliceSubpath(doc, '#^edit-block')
    expect(out).toBe('Editing is the work.')
  })

  it('returns the whole text when there is no subpath or no match', () => {
    expect(sliceSubpath(doc, undefined)).toBe(doc)
    expect(sliceSubpath(doc, '#Nope')).toBe(doc)
    expect(sliceSubpath(doc, '#^missing')).toBe(doc)
    expect(sliceSubpath(doc, '#')).toBe(doc)
    expect(sliceSubpath('', '#Simplicity')).toBe('')
  })
})

/**
 * Regression: `Archive/notes/Broken Board.canvas` took the whole view down with
 * "Cannot read properties of undefined (reading 'x')". The parse was tolerant,
 * the render was not — `sideAnchor` fell off its exhaustive switch for a side
 * outside the enum and returned undefined. Both layers are guarded now.
 */
describe('edge enum tolerance', () => {
  const parseEdge = (patch: Record<string, unknown>): CanvasEdge =>
    parseCanvas(
      JSON.stringify({ nodes: [], edges: [{ id: 'e', fromNode: 'a', toNode: 'b', ...patch }] })
    ).edges[0]

  it('keeps a valid side and end', () => {
    const e = parseEdge({ fromSide: 'top', toSide: 'left', fromEnd: 'arrow', toEnd: 'none' })
    expect(e.fromSide).toBe('top')
    expect(e.toSide).toBe('left')
    expect(e.fromEnd).toBe('arrow')
    expect(e.toEnd).toBe('none')
  })

  it('keeps a side or end outside its enum on disk but never draws with it', () => {
    const e = parseEdge({ fromSide: 'sideways', toSide: 7, fromEnd: 'circle', toEnd: null })
    expect(validSide(e.fromSide)).toBeUndefined()
    expect(validSide(e.toSide)).toBeUndefined()
    expect(validEnd(e.fromEnd)).toBeUndefined()
    expect(validEnd(e.toEnd)).toBeUndefined()
    // Another tool's value survives a save.
    expect(serializeCanvas({ nodes: [], edges: [e] })).toContain('sideways')
  })
})

describe('z-order (node array order)', () => {
  const three: CanvasData = {
    nodes: [
      createTextNode(0, 0, 'a'),
      createTextNode(10, 10, 'b'),
      createTextNode(20, 20, 'c')
    ].map((n, i) => ({ ...n, id: ['a', 'b', 'c'][i] })) as CanvasData['nodes'],
    edges: []
  }

  it('reorderNodes front/back moves only the named ids and keeps the rest', () => {
    expect(reorderNodes(three, new Set(['a']), 'front').nodes.map((n) => n.id)).toEqual(['b', 'c', 'a'])
    expect(reorderNodes(three, new Set(['c']), 'back').nodes.map((n) => n.id)).toEqual(['c', 'a', 'b'])
    // Relative order inside the moved set survives.
    expect(reorderNodes(three, new Set(['a', 'b']), 'front').nodes.map((n) => n.id)).toEqual(['c', 'a', 'b'])
  })

  it('is a no-op for an empty or unknown selection', () => {
    expect(reorderNodes(three, new Set(), 'front')).toBe(three)
    expect(reorderNodes(three, new Set(['zzz']), 'front')).toBe(three)
  })

  it('addNode appends, so a new card lands on top', () => {
    const added = addNode(three, { ...createTextNode(0, 0, 'd'), id: 'd' } as CanvasData['nodes'][number])
    expect(added.nodes[added.nodes.length - 1].id).toBe('d')
  })
})

describe('edge label and arrow ends', () => {
  const one: CanvasData = {
    nodes: [],
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }]
  }

  it('setEdgeLabel sets a trimmed label and clears it on empty', () => {
    expect(setEdgeLabel(one, 'e1', '  cut  ').edges[0].label).toBe('cut')
    const labelled = setEdgeLabel(one, 'e1', 'cut')
    expect('label' in setEdgeLabel(labelled, 'e1', '   ').edges[0]).toBe(false)
  })

  it('setEdgeEnds omits the spec defaults so a plain arrow stays minimal', () => {
    const plain = setEdgeEnds(one, 'e1', 'none', 'arrow').edges[0]
    expect('fromEnd' in plain).toBe(false)
    expect('toEnd' in plain).toBe(false)

    const both = setEdgeEnds(one, 'e1', 'arrow', 'arrow').edges[0]
    expect(both.fromEnd).toBe('arrow')
    expect('toEnd' in both).toBe(false)

    const none = setEdgeEnds(one, 'e1', 'none', 'none').edges[0]
    expect('fromEnd' in none).toBe(false)
    expect(none.toEnd).toBe('none')
  })

  it('nextEdgeEnds walks the four states and returns to the start', () => {
    let edge = one.edges[0]
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      const next = nextEdgeEnds(edge)
      seen.push(`${next.fromEnd}/${next.toEnd}`)
      edge = { ...edge, ...next }
    }
    expect(seen).toEqual(['arrow/none', 'arrow/arrow', 'none/none', 'none/arrow'])
  })
})

it('duplicates internal connections with fresh ids and preserves their attributes', () => {
  const { data, ids } = duplicateNodes(sample, new Set(['a', 'b']))
  expect(data.nodes).toHaveLength(4)
  expect(data.edges).toHaveLength(2)
  expect(data.edges[1]).toMatchObject({ fromSide: 'right', toSide: 'left', toEnd: 'arrow' })
  expect(ids.has(data.edges[1].fromNode)).toBe(true)
  expect(ids.has(data.edges[1].toNode)).toBe(true)
  expect(data.edges[1].id).not.toBe(sample.edges[0].id)
  expect(duplicateNodes(sample, new Set(['a'])).data.edges).toHaveLength(1)
})

describe('lossless round trips', () => {
  it('reports text that is not a JSON Canvas document as invalid instead of an empty board', () => {
    expect(parseCanvasDocument('{"nodes":[').valid).toBe(false)
    expect(parseCanvasDocument('[1,2]').valid).toBe(false)
    expect(parseCanvasDocument('{"nodes":{}}').valid).toBe(false)
    expect(parseCanvasDocument('').valid).toBe(true)
    expect(parseCanvasDocument('{}')).toEqual({ valid: true, data: { nodes: [], edges: [] } })
  })

  it('keeps entries it cannot use, and unknown top-level keys, where they were', () => {
    const text = serializeCanvas({ nodes: [], edges: [] }).replace('"nodes":[]', '"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":10,"height":10,"text":"A"},{"id":"s","type":"sticker","x":0,"y":0,"width":5,"height":5},{"type":"text","text":"no id"},{"id":"a","type":"text","x":1,"y":1,"width":1,"height":1,"text":"duplicate"}]').replace('"edges":[]', '"edges":[{"fromNode":"a","toNode":"s"},{"id":"e","fromNode":"a","toNode":"s"}],"metadata":{"v":"1.1"}')
    const parsed = parseCanvasDocument(text)
    expect(parsed.valid).toBe(true)
    expect(parsed.data.nodes.map((node) => node.id)).toEqual(['a'])
    expect(parsed.data.edges.map((edge) => edge.id)).toEqual(['e'])
    const saved = JSON.parse(serializeCanvas(moveNodes(parsed.data, new Set(['a']), 5, 5)))
    expect(saved.nodes.map((node: { id?: string; text?: string }) => node.id ?? node.text)).toEqual(['a', 's', 'no id', 'a'])
    expect(saved.nodes[3].text).toBe('duplicate')
    expect(saved.nodes[0].x).toBe(5)
    expect(saved.edges).toHaveLength(2)
    expect(saved.metadata).toEqual({ v: '1.1' })
  })

  it('does not add a label to a group that has none', () => {
    const data = parseCanvas('{"nodes":[{"id":"g","type":"group","x":0,"y":0,"width":10,"height":10}],"edges":[]}')
    expect(JSON.parse(serializeCanvas(data)).nodes[0]).not.toHaveProperty('label')
  })

  it('writes the vendored spec sample back byte for byte', () => {
    const text = readFileSync(resolve(__dirname, 'fixtures/sample.canvas'), 'utf8')
    expect(serializeCanvas(parseCanvas(text))).toBe(text.replace(/\n$/, ''))
  })
})
