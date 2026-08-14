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
that changed nothing. The pane meets the arrays with the same courtesy, per
element: `nodes={[…]}` and `edges={[…]}` written inline hand it fresh
objects every render, and anything value-identical keeps its built entry —
a keystroke into one node's `data` repaints that node, not the graph
(measured at ~115 requests a character where the structural fallback paid
~2,600). No memoisation is asked of the app. `addEdge(connection, edges)` derives the edge's id from
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

- **A move re-renders nothing, and cannot trail.** The pane recomposites
  body rects inside the gesture dispatch, and gesture-time emissions are
  committed synchronously — pointer motion dispatches at continuous
  priority, whose ordinary React updates the scheduler may hold across
  several frames while the pane paints each step, which showed as the body
  converging on the card a few updates late. The flush pins both to the
  same frame; the body component stays memoized on the node, its
  selection, the zoom and its size, so the per-step cost is one style-only
  commit on one box. `render` is re-invoked only when what it shows could
  have changed.
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
  (Filed upstream as ntk#264; a tiled fill would take the grid out of the
  question entirely — ntk#263.)

The second rule is the one worth remembering, because the obvious
optimisation is the wrong one below the threshold.

### Gestures repaint what moved, and nothing else

A drag step does not repaint the graph. The pane claims a damage rect — the
moved nodes old and new, plus the routed bounds of every edge on them — and
the paint pass culls to the rect the renderer hands back: grid, edges, nodes,
minimap and controls outside it are skipped, and their pixels survive on the
window from the previous frame. The window's backing is the composition
cache; the damage rect is the dirty state. Resize, the connection line,
hover and the selection box all claim the same way, and an animated edge's
dash timer invalidates the box the animated edges were last drawn in rather
than the pane.

The other half is the commit. The app applies each step's `position` change,
so the pane's props get a new `nodes` array per step — and a new identity for
every inline handler and object prop with it. `applyProps` identity-diffs the
array against its entries: a change that touches nothing but `position` is
folded in place (no re-measuring, no re-sorting, damage = the box it moved
through), object props like `background={{ … }}` are compared by value, and
handler churn repaints nothing at all. Anything structural — a label, a size,
a selection, an add or remove — falls back to the full rebuild it needs.

Measured on the 300-node scene, one drag step went from a full repaint
(~2470 requests, ~150 ms) to ~400 requests and ~30 ms, and the small scene's
step from ~380 ms (its animated edge was invalidating the pane per tick) to
~70 ms.

The seams this stands on are public API: `paintDamage()` and the
`selfDamagedProps` registration (react-x11#301), and `defaultWheel`/
`defaultMouseMove` (react-x11#302) — a bare `<flowgraph>` zooms and hovers
on its own.

**Panning blits.** A pan frame is `scrollContents` (react-x11#303) on the
pane with the furniture bands carved out, plus ordinary claims for the
strips — the blit gate tests foreign claims against the _rect_
(react-x11#309, landed as #310), so the strips sit edge to edge with the
copy and the frame stays a blit. Measured on the 300-node scene: **19
requests and 1.6 KB a frame** bare, **~550 requests and ~170 KB** with the
minimap and controls up (the strip repaints; it holds the minimap's three
hundred dots), from ~2,465 requests and ~1.8 MB when every pan frame
repainted the world. Mounted bodies still force the repaint path: their
gesture-time commits claim inside the rect, which declines a blit by
design.

**The grid tiles.** At an integral device pitch the background is one
`createPattern('repeat')` composite (ntk#263) — the phase baked into the
tile, so alignment with the graph's own coordinates is exact — and at a
fractional pitch it falls back to the batched runs, because a pixmap tile
cannot land on a fraction and a grid that drifts under `snapToGrid` is
worse than a slower exact one.

**The graph is accessible.** The pane describes every visible node to
assistive technology through `a11yScene()` (react-x11#304): named from its
label, placed at its drawn rect, `selected` carried as state, activation
falling back to a click at the item. The scene re-announces on graph
commits and gesture settles.

## Example

`npm run examples:flow` is a build-pipeline editor with both kinds of node
side by side — drawn `task` cards and a mounted, resizable `options` node made
of real checkboxes, buttons and a textarea.

`npm run examples:flow-stress` is the one to reach for when changing how the
pane draws: two scene buttons (20 nodes on a spiral, 300 nodes and 745 edges
in a fan), a **pan** button that drives the viewport continuously, and a live
readout from the trace — per pan frame while the loop runs, per drag step
while you drag a node. Pan measures the full-frame path; dragging measures
the damage-scoped one.
