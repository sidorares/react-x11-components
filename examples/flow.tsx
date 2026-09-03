// Run with: npm run examples:flow   (needs an X server / DISPLAY)
//
// A small pipeline editor: drag nodes by anything that is not a widget, drag
// between handles to connect, Shift+drag to box-select, Delete to remove,
// the wheel to zoom.
//
// The two custom node types are the point, because they are the two halves
// of the seam:
//
//   `task`  — a `paint`. The pane draws it, so it costs nothing to pan past
//             a thousand of them and it scales with the zoom.
//   `notes` — a `render`. Real `<Checkbox>`, `<Button>` and `<textarea>`,
//             laid out by yoga inside a box the pane places over the node.
//             It is interactive, it re-renders as the viewport moves, and
//             it zooms with the pane — the box carries core's `scale`, so
//             everything below is written in graph units and never mentions
//             the zoom. See README.md, "The graph editor".
//
// The `notes` node is also `resizable`: drag any of the eight grips on its
// border while it is selected, and the textarea inside grows with it.
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Checkbox, createRoot } from 'react-x11';

import { addEdge, Flow, useEdgesState, useNodesState } from '../src/index.js';
import type {
  Connection,
  FlowInstance,
  FlowNode,
  FlowNodeType,
  NodeChange,
} from '../src/index.js';

/** One data type for every node here; each node type reads its own half. */
interface TaskData {
  label?: string;
  description?: string;
  /** `task` only. */
  kind?: 'source' | 'transform' | 'sink';
  /** `notes` only. */
  text?: string;
  strict?: boolean;
  sourcemaps?: boolean;
}

const ACCENTS: Record<NonNullable<TaskData['kind']>, string> = {
  source: '#3fa66a',
  transform: '#4b7bec',
  sink: '#d9822b',
};

/**
 * The drawn node type: how big, where it connects, and how it draws.
 * Everything the `paint` is handed is in screen pixels already — a type
 * multiplies its own sizes by `zoom` and otherwise never thinks about the
 * viewport.
 */
const task: FlowNodeType<TaskData> = {
  size: { width: 168, height: 56 },
  handles: (node) => [
    ...(node.data?.kind === 'source'
      ? []
      : ([{ type: 'target', position: 'left' }] as const)),
    ...(node.data?.kind === 'sink'
      ? []
      : ([{ type: 'source', position: 'right' }] as const)),
  ],
  paint({ node, rect, zoom, selected, hovered, palette, painter }) {
    const accent = ACCENTS[node.data?.kind ?? 'transform'];
    const radius = 7 * zoom;
    painter.rect(rect.x, rect.y, rect.width, rect.height, radius, {
      fill: palette.nodeBackground,
      stroke: selected ? accent : hovered ? palette.dim : palette.nodeBorder,
      lineWidth: (selected ? 2 : 1) * Math.max(1, zoom),
    });
    // The type stripe, inset past the rounded corners rather than clipped
    // to them — a non-rectangular clip forfeits ntk's rounded-box fast path
    // for every fill under it, which priced this stripe at a pixmap and a
    // trapezoid pass per card per repaint.
    painter.rect(
      rect.x + Math.max(1, zoom),
      rect.y + radius,
      4 * zoom,
      rect.height - radius * 2,
      0,
      { fill: accent },
    );

    if (zoom < 0.4) return;
    const left = rect.x + 14 * zoom;
    const width = rect.width - 24 * zoom;
    painter.text(node.data?.label ?? node.id, left, rect.y + 11 * zoom, {
      size: 13 * zoom,
      weight: 'bold',
      color: palette.text,
      maxWidth: width,
    });
    if (zoom >= 0.6 && node.data?.description) {
      painter.text(node.data.description, left, rect.y + 30 * zoom, {
        size: 11 * zoom,
        color: palette.dim,
        maxWidth: width,
      });
    }
  },
};

/**
 * The mounted node type. `render` returns an ordinary react-x11 tree, so
 * everything in it behaves the way it does anywhere else: the checkboxes
 * take clicks, the textarea takes the keyboard (Delete deletes *text* while
 * it has the focus, not the node), and the buttons draw their own hover and
 * pressed states.
 *
 * `headerHeight` is what keeps the node draggable: the body starts below the
 * title strip, so there is always somewhere to grab that is not a field.
 *
 * It takes the state setter because the node's data *is* the widget state —
 * there is nowhere else for a controlled input to keep it, which is exactly
 * how it would be in a react-flow node component.
 */
function notesType(
  patch: (id: string, data: Partial<TaskData>) => void,
): FlowNodeType<TaskData> {
  return {
    size: { width: 268, height: 212 },
    headerHeight: 26,
    handles: [{ type: 'source', position: 'right' }],
    render: ({ node }) => (
      <box style={{ flexGrow: 1, padding: 8, gap: 7 }}>
        <text style={{ fontSize: 11, color: '$textMuted' }}>
          Real widgets, laid out by yoga inside the node.
        </text>
        <box style={{ flexDirection: 'row', gap: 12 }}>
          <Checkbox
            label="strict"
            checked={node.data?.strict ?? false}
            onChange={(ev) => patch(node.id, { strict: ev.value })}
          />
          <Checkbox
            label="sourcemaps"
            checked={node.data?.sourcemaps ?? false}
            onChange={(ev) => patch(node.id, { sourcemaps: ev.value })}
          />
        </box>
        {/* `flexShrink` as well as `flexGrow`: a `<textarea>` measures
            itself at `rows` lines and yoga does not shrink a flex item
            below its own measurement unless it is told it may — which is
            what makes this field *fill* the node however it is resized. */}
        <textarea
          rows={2}
          value={node.data?.text ?? ''}
          onChange={(ev) => patch(node.id, { text: ev.value })}
          placeholder="build notes…"
          style={{
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 0,
            borderWidth: 1,
            borderColor: '$border',
            borderRadius: 4,
            padding: 4,
          }}
        />
        <box
          style={{ flexDirection: 'row', gap: 6, justifyContent: 'flex-end' }}
        >
          <Button label="Clear" onPress={() => patch(node.id, { text: '' })} />
          <Button
            primary
            label="Run"
            onPress={() =>
              patch(node.id, {
                text: `${node.data?.text ?? ''}${node.data?.text ? '\n' : ''}ran at ${new Date().toLocaleTimeString()}`,
              })
            }
          />
        </box>
      </box>
    ),
  };
}

const initialNodes: FlowNode<TaskData>[] = [
  {
    id: 'watch',
    type: 'task',
    position: { x: 0, y: 40 },
    data: { label: 'watch', description: 'inotify on src/', kind: 'source' },
  },
  {
    id: 'parse',
    type: 'task',
    position: { x: 240, y: 0 },
    data: { label: 'parse', description: 'lezer', kind: 'transform' },
  },
  {
    id: 'typecheck',
    type: 'task',
    position: { x: 240, y: 90 },
    data: {
      label: 'typecheck',
      description: 'tsc --noEmit',
      kind: 'transform',
    },
  },
  {
    id: 'options',
    type: 'notes',
    position: { x: 190, y: 180 },
    width: 268,
    height: 212,
    resizable: true,
    minWidth: 210,
    minHeight: 160,
    data: { label: 'options', text: 'watch mode', strict: true },
  },
  {
    id: 'bundle',
    type: 'task',
    position: { x: 540, y: 40 },
    data: { label: 'bundle', description: 'esbuild', kind: 'transform' },
  },
  {
    id: 'reload',
    type: 'task',
    position: { x: 780, y: 40 },
    data: { label: 'reload', description: 'the running app', kind: 'sink' },
  },
];

const initialEdges = [
  { id: 'w-p', source: 'watch', target: 'parse' },
  { id: 'w-t', source: 'watch', target: 'typecheck' },
  { id: 'p-b', source: 'parse', target: 'bundle', label: 'ast' },
  { id: 't-b', source: 'typecheck', target: 'bundle', label: 'ok' },
  { id: 'o-b', source: 'options', target: 'bundle', label: 'config' },
  { id: 'b-r', source: 'bundle', target: 'reload', animated: true },
];

function App(): ReactElement {
  const [nodes, setNodes, onNodesChange] =
    useNodesState<TaskData>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [status, setStatus] = useState('drag a handle to connect two steps');
  const flow = useRef<FlowInstance>(null);

  // A mounted node's widgets are controlled by the node's own `data`, so
  // this is the setter they all go through.
  const patch = useCallback(
    (id: string, data: Partial<TaskData>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, ...data } } : node,
        ),
      );
    },
    [setNodes],
  );

  const nodeTypes = useMemo(() => ({ task, notes: notesType(patch) }), [patch]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) => addEdge(connection, current));
      setStatus(`${connection.source} → ${connection.target}`);
    },
    [setEdges],
  );

  // Every gesture arrives as a change; this one only watches them go past.
  const handleNodesChange = useCallback(
    (changes: NodeChange<TaskData>[]) => {
      onNodesChange(changes);
      const dropped = changes.find(
        (c) => c.type === 'position' && c.dragging === false,
      );
      if (dropped && dropped.type === 'position' && dropped.position) {
        setStatus(
          `${dropped.id} at ${Math.round(dropped.position.x)}, ${Math.round(dropped.position.y)}`,
        );
      }
      const sized = changes.find(
        (c) => c.type === 'dimensions' && c.resizing === false,
      );
      if (sized && sized.type === 'dimensions') {
        setStatus(
          `${sized.id} is ${Math.round(sized.dimensions.width)}×${Math.round(sized.dimensions.height)}`,
        );
      }
    },
    [onNodesChange],
  );

  return (
    <window width={1000} height={660} title="@react-x11/components — Flow">
      <box style={{ flexGrow: 1, padding: 12, gap: 10 }}>
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            height: 24,
          }}
        >
          <text style={{ fontSize: 14, color: '$text' }}>build pipeline</text>
          <text style={{ fontSize: 12, color: '$textMuted', flexGrow: 1 }}>
            {status}
          </text>
        </box>
        <Flow<TaskData, unknown>
          ref={flow}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={({ nodes: selected }) => {
            if (selected.length === 1) {
              setStatus(
                selected[0].resizable
                  ? `${selected[0].id} — drag a grip to resize it`
                  : `selected ${selected[0].id} — Delete removes it`,
              );
            } else if (selected.length > 1) {
              setStatus(`${selected.length} selected`);
            }
          }}
          defaultEdgeOptions={{ type: 'smoothstep' }}
          fitView
          fitViewOptions={{ padding: 0.04, maxZoom: 1 }}
          minimap
          controls
          background={{ variant: 'dots', gap: 24 }}
          style={{
            flexGrow: 1,
            borderWidth: 1,
            borderColor: '$border',
            borderRadius: 6,
          }}
        />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
