# Flow

```jsx
import {
  Flow,
  useNodesState,
  useEdgesState,
  addEdge,
} from '@react-x11/components/flow';
```

```jsx
const [nodes, setNodes, onNodesChange] = useNodesState([
  { id: 'read', position: { x: 0, y: 0 }, data: { label: 'read' } },
  { id: 'parse', position: { x: 0, y: 120 }, data: { label: 'parse' } },
]);
const [edges, setEdges, onEdgesChange] = useEdgesState([
  { id: 'r-p', source: 'read', target: 'parse', label: 'bytes' },
]);

<Flow
  nodes={nodes}
  edges={edges}
  onNodesChange={onNodesChange}
  onEdgesChange={onEdgesChange}
  onConnect={(c) => setEdges((es) => addEdge(c, es))}
  fitView
  minimap
  controls
/>;
```

A directed graph you can edit — a pipeline, a state machine, a dependency map,
a node-based tool. The surface API is [react-flow][rf]'s, so a graph described
for that is described for this: the same `nodes`/`edges` pair, the same change
protocol, the same `applyNodeChanges` / `addEdge` / `useNodesState` helpers.

It registers one host element, `<flowgraph>`, and **that element draws the
whole graph**. Why, and what it costs, is [below](#why-the-pane-draws); it is
the decision everything else here follows from.

[rf]: https://reactflow.dev/

## Nodes

```js
{ id: 'parse', position: { x: 240, y: 0 }, data: { label: 'parse' } }
```

`id` and `position` are the whole requirement. `data` is yours; the built-in
types read `label` and `description` out of it and nothing else looks at it.

| Field                                                              | What it does                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `type`                                                             | Key into `nodeTypes`. `'default'`, `'input'` and `'output'` are built in and differ only in handles. |
| `width` / `height`                                                 | Explicit size. Left out, the node is measured from its label once and remembered.                    |
| `minWidth` / `minHeight`                                           | The floor a resize stops at. Default 48×32.                                                          |
| `selected`, `hidden`                                               | State, held in the array like everything else.                                                       |
| `draggable`, `selectable`, `connectable`, `deletable`, `resizable` | Per-node overrides of the pane-wide props.                                                           |
| `zIndex`                                                           | Higher paints later, and is hit first.                                                               |
| `sourcePosition` / `targetPosition`                                | Which side the built-in handles sit on. Defaults `'bottom'` and `'top'`, react-flow's.               |
| `handles`                                                          | Replaces the built-in pair outright, for a node whose ports are data.                                |
| `style`                                                            | Colours only — `background`, `borderColor`, `accent`, … Size lives in `width`/`height`.              |

A handle is `{ type: 'source' | 'target', position, id?, offset?, label? }`.
`offset` is where along that side it sits, `0` to `1`, which is how a node
grows a row of typed inputs.

## Edges

```js
{ id: 'r-p', source: 'read', target: 'parse', label: 'bytes', animated: true }
```

`sourceHandle`/`targetHandle` name a handle when a node has more than one of
that type; left out, the edge takes the one facing the other end.

`type` is `'bezier'` (default), `'smoothstep'`, `'step'` or `'straight'`.
`markerEnd` defaults to `'arrowclosed'` — this is a _directed_ graph, and an
edge you cannot read a direction off is a line; `null` opts out. `style` takes
`stroke`, `strokeWidth`, `dash`, `labelColor`, `labelBackground`.

`animated` marches the dash along the edge. It costs a repaint timer while an
animated edge is **on screen**, and nothing when none is.

`defaultEdgeOptions` is merged under every edge — where `type` and `markerEnd`
for a whole graph belong.

## Changes: the app owns the arrays

The pane never mutates what it was given. Every gesture arrives as a change
the app applies:

```js
onNodesChange={(changes) => setNodes((ns) => applyNodeChanges(changes, ns))}
```

That is what makes `nodes`/`edges` an ordinary controlled prop — and undo a
matter of not applying something.

| Change           | When                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `position`       | A drag. `dragging: true` for every step, `false` on the one that settles. |
| `dimensions`     | A resize, with the same `resizing` pair.                                  |
| `select`         | A click, a box selection, Ctrl+A.                                         |
| `remove`         | Delete, with the edges the removed nodes would leave dangling.            |
| `add`, `replace` | Not emitted by the pane; there for an app driving the same reducer.       |

`applyNodeChanges` and `applyEdgeChanges` return the array they were given
when nothing applied, so a `useMemo` above them is not defeated by an edit
that changed nothing. `addEdge(connection, edges)` derives the edge's id from
its endpoints, so connecting the same two handles twice is idempotent rather
than a duplicate nobody can tell apart. `connectedEdges(ids, edges)` is what a
delete usually wants to take with it.

`defaultNodes`/`defaultEdges` instead of `nodes`/`edges` give the uncontrolled
form, where the pane owns the arrays.

## Props

| Prop                                                                                                                                                                                      | What it does                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `nodes`, `edges` / `defaultNodes`, `defaultEdges`                                                                                                                                         | Controlled, or uncontrolled.                                                                          |
| `onNodesChange`, `onEdgesChange`                                                                                                                                                          | The change stream above.                                                                              |
| `onConnect`, `onConnectStart`, `onConnectEnd`                                                                                                                                             | A connection gesture. Turn it into an edge with `addEdge`; refuse it by doing nothing.                |
| `isValidConnection`                                                                                                                                                                       | Vetoes one before `onConnect`, and greys the line while the pointer is over a handle it would refuse. |
| `connectionMode`                                                                                                                                                                          | `'strict'` (default) joins a source to a target only; `'loose'` lets either end start.                |
| `nodeTypes`                                                                                                                                                                               | The registry. See below.                                                                              |
| `defaultEdgeOptions`                                                                                                                                                                      | Merged under every edge.                                                                              |
| `viewport` / `defaultViewport`, `onViewportChange`                                                                                                                                        | The pan and zoom transform. Uncontrolled is what keeps panning off React's render path.               |
| `fitView`, `fitViewOptions`                                                                                                                                                               | Frame the graph once, on the first layout that has a size.                                            |
| `minZoom`, `maxZoom`                                                                                                                                                                      | Default `0.2` and `2.5`.                                                                              |
| `nodesDraggable`, `nodesConnectable`, `elementsSelectable`, `panOnDrag`, `zoomOnScroll`, `zoomOnDoubleClick`                                                                              | All default to `true`.                                                                                |
| `nodesResizable`, `selectionOnDrag`                                                                                                                                                       | Default `false`.                                                                                      |
| `deleteOnKey`                                                                                                                                                                             | Delete/Backspace removes the selection. Default `true`.                                               |
| `snapToGrid`, `snapGrid`                                                                                                                                                                  | Default `false` and `[16, 16]`.                                                                       |
| `background`, `minimap`, `controls`                                                                                                                                                       | The pane's furniture. Props rather than child components, because the pane draws them.                |
| `palette`                                                                                                                                                                                 | Overrides the colours it took from the theme, a token at a time.                                      |
| `onNodeClick`, `onNodeDoubleClick`, `onNodeContextMenu`, `onNodeDragStart`, `onNodeDragStop`, `onEdgeClick`, `onEdgeContextMenu`, `onPaneClick`, `onPaneContextMenu`, `onSelectionChange` | `(event, node)` — react-flow's argument order.                                                        |
| `style`                                                                                                                                                                                   | The pane fills its parent unless this gives it a height or a `flexGrow`.                              |

## Node types

A node type says how big a node is, where it connects, and what it looks
like. There are two ways to answer the last one, and picking between them is
the only interesting decision here.

### `paint` — the default

```jsx
const nodeTypes = {
  task: {
    size: { width: 150, height: 52 },
    handles: [
      { type: 'target', position: 'left' },
      { type: 'source', position: 'right', id: 'ok', label: 'ok' },
    ],
    paint({ node, rect, zoom, selected, palette, painter }) {
      painter.rect(rect.x, rect.y, rect.width, rect.height, 6 * zoom, {
        fill: palette.nodeBackground,
        stroke: selected ? palette.accent : palette.nodeBorder,
      });
      painter.text(
        node.data.label,
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        {
          size: 13 * zoom,
          align: 'center',
          baseline: 'middle',
          color: palette.text,
        },
      );
    },
  },
};
```

Everything the callback is handed is in **screen pixels already** — a type
multiplies its own sizes by `zoom` and otherwise never thinks about the
viewport. `painter` is a facade over ntk's context (`rect`, `circle`,
`polyline`, `polygon`, `text`, `measureText`, batched `strokeRuns` and `dots`,
and `raw` for anything it does not cover), which is also what lets a node type
run on the mock backend headless tests use.

This costs nothing to pan past and scales with the zoom. It is the right
answer for the nodes there are a lot of.

### `render` — real widgets

It is not the right answer for a node whose body is a form. Such a type
returns an ordinary react-x11 tree instead, mounted in a box the pane
positions and sizes over the node:

```jsx
const nodeTypes = {
  options: {
    size: { width: 268, height: 212 },
    headerHeight: 26,
    handles: [{ type: 'source', position: 'right' }],
    render: ({ node }) => (
      <box style={{ flexGrow: 1, padding: 8, gap: 7 }}>
        <text style={{ fontSize: 11, color: '$textMuted' }}>build options</text>
        <Checkbox
          label="strict"
          checked={node.data.strict}
          onChange={(ev) => patch(node.id, { strict: ev.value })}
        />
        <textarea
          value={node.data.text}
          onChange={(ev) => patch(node.id, { text: ev.value })}
          style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
        />
      </box>
    ),
  },
};
```

Everything in there behaves the way it does anywhere else: the checkbox takes
clicks, the textarea takes the keyboard — Delete deletes _text_ while it has
the focus, not the node. Three things follow, and all three are the point:

- **It re-renders as the viewport moves.** That is the cost the drawn path
  exists to avoid, so it is paid by the nodes that ask for it and no others.
- **It does not scale with the zoom.** The box does; there is no transform
  here. Content is laid out to the zoomed box at its natural size and clipped,
  and below `zoom` 0.6 it is not mounted at all — the pane draws the card
  instead.
- **`headerHeight` is what keeps the node draggable.** The body starts below
  the strip, so there is always somewhere to grab that is not a text field.
  `0` hands the whole box over, and then only the keyboard can move the node.

`flexShrink` beside `flexGrow` on the textarea is not decoration: a
`<textarea>` measures itself at `rows` lines, and yoga will not shrink a flex
item below its own measurement unless it is told it may.

## Resizing

`resizable` on a node (or `nodesResizable` on the pane) grows eight grips on
its border while it is selected. Dragging one emits a `dimensions` change,
plus a `position` change when the grip moved the node's origin;
`minWidth`/`minHeight` are the floor, and `snapToGrid` applies.

A grip that would sit under a connection handle is not drawn. The handle wins
the hit test where the two overlap, so a grip there would be a control that
does not work — the corners, which is what a resize reaches for, are never the
ones lost.

## Interaction

| Gesture                 | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| Drag a node             | Moves it, and the rest of the selection with it.               |
| Drag a handle           | Draws a connection; drop on a handle or anywhere on a node.    |
| Drag the pane           | Pans. Shift+drag draws a selection box instead.                |
| Wheel                   | Zooms about the pointer. Shift or `zoomOnScroll={false}` pans. |
| Click, Shift/Ctrl+click | Selects, and adds to the selection.                            |
| Delete / Backspace      | Removes the selection, with the edges it would leave dangling. |
| Ctrl+A, Escape          | Everything; nothing.                                           |
| Arrows                  | Nudge the selection, or pan when there is none. Shift is ×10.  |
| `+` / `-`, `0` or Home  | Zoom; frame the graph.                                         |

The pane is a tab stop, and its keys run through react-x11's default-action
seam — an app's own `onKeyDown` runs first and `preventDefault()` vetoes.

## `FlowInstance`

`ref` hands back react-flow's `useReactFlow()`, as a ref rather than a context
hook, because a ref needs no provider above the pane and there is exactly one
pane to talk to.

```jsx
const flow = useRef(null);
<Flow ref={flow} … />;
flow.current.fitView({ padding: 0.2 });
```

`getViewport` / `setViewport`, `zoomIn` / `zoomOut` / `zoomTo`, `fitView`,
`setCenter`, `screenToFlowPosition` / `flowToScreenPosition`, `getNodeBounds`,
`getNodesBounds`.

## Why the pane draws

react-flow gives every node a DOM subtree and pans and zooms with a CSS
transform, so the browser moves ten thousand boxes for free. This renderer has
no transform — `style` is yoga plus paint — so the same design here would
re-render every node through React and re-lay-out every node through yoga on
every pointer step of a pan, and zoom could not scale text at all.

So one element draws the graph, the way `<codeeditor>` draws a whole text
editor. Panning is two numbers and one node's damage rect, zoom is arithmetic,
and React is not involved until the graph itself changes. What the pane pays
for that is bounded deliberately: two coarse rejects per edge before any path
is built, culling against the viewport, a measured-text cache, the background
grid batched into one path and one X request, detail dropped below a zoom
threshold, and a repaint timer that exists only while an animated edge is
actually visible.

The mounted-body escape hatch is a **sibling** of the pane rather than a child
of it, and that is not arbitrary either: a node's children are painted before
its own drawing, so a body mounted inside the pane would be painted over by
the graph.

### What the pane batches, and what it deliberately does not

Everything drawn ends up as X protocol, and the trace in
`react-x11/debug` is how that is kept honest. Two rules came out of
measuring, and they pull in opposite directions:

- **Geometry lands on whole pixels.** ntk draws a rounded box as cached
  corner glyphs plus `FillRectangles` when its coordinates are integral, and
  rasterizes a mask it has to upload when they are not — and any zoom that
  is not 1 makes every box fractional. Rounding moved three hundred mask
  uploads a frame onto the fast path.
- **Batching pays for edges and for nothing else.** A path's mask is its
  bounding box, so collapsing many draws into one path trades many small
  masks for one the size of the pane — about three quarters of a megabyte.
  For seven hundred edges, which already span that box, it is a large win
  (3.9 MB a frame down to 1.3). For twenty edges, or for handles and cards,
  which are small and scattered, it is a loss. So edges and arrowheads
  batch **above a threshold** and everything else is drawn one at a time.

The second rule is the one worth remembering, because the obvious
optimisation is the wrong one below the threshold.

## Example

`npm run examples:flow` is a build-pipeline editor with both kinds of node
side by side — drawn `task` cards and a mounted, resizable `options` node made
of real checkboxes, buttons and a textarea.

`npm run examples:flow-stress` is the one to reach for when changing how the
pane draws: two scene buttons (20 nodes on a spiral, 300 nodes and 745 edges
in a fan), a **pan** button that drives the viewport continuously, and a live
readout of requests, bytes and frames per second taken from the trace.
