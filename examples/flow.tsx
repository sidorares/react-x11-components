// Run with: npm run examples:flow   (needs an X server / DISPLAY)
//
// A small pipeline editor: drag nodes, drag between handles to connect,
// Shift+drag to box-select, Delete to remove, the wheel to zoom. The custom
// `task` node type is the interesting part — a node's body is a `paint`
// here, not a React component, because zoom is drawn rather than
// transformed. See README.md, "The graph editor".
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { addEdge, Flow, useEdgesState, useNodesState } from '../src/index.js';
import type {
  Connection,
  FlowInstance,
  FlowNode,
  FlowNodeType,
  NodeChange,
} from '../src/index.js';

interface TaskData {
  label?: string;
  description?: string;
  kind: 'source' | 'transform' | 'sink';
}

const ACCENTS: Record<TaskData['kind'], string> = {
  source: '#3fa66a',
  transform: '#4b7bec',
  sink: '#d9822b',
};

/**
 * A node type: how big, where it connects, and how it draws. Everything the
 * `paint` is handed is in screen pixels already — a type multiplies its own
 * sizes by `zoom` and otherwise never thinks about the viewport.
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
    // the type stripe, clipped to the card so it keeps the rounded corner
    painter.save();
    painter.clipRect(rect.x, rect.y, rect.width, rect.height, radius);
    painter.rect(rect.x, rect.y, 4 * zoom, rect.height, 0, { fill: accent });
    painter.restore();

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
    id: 'bundle',
    type: 'task',
    position: { x: 480, y: 40 },
    data: { label: 'bundle', description: 'esbuild', kind: 'transform' },
  },
  {
    id: 'reload',
    type: 'task',
    position: { x: 720, y: 40 },
    data: { label: 'reload', description: 'the running app', kind: 'sink' },
  },
];

const initialEdges = [
  { id: 'w-p', source: 'watch', target: 'parse' },
  { id: 'w-t', source: 'watch', target: 'typecheck' },
  { id: 'p-b', source: 'parse', target: 'bundle', label: 'ast' },
  { id: 't-b', source: 'typecheck', target: 'bundle', label: 'ok' },
  { id: 'b-r', source: 'bundle', target: 'reload', animated: true },
];

function App(): ReactElement {
  const [nodes, , onNodesChange] = useNodesState<TaskData>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [status, setStatus] = useState('drag a handle to connect two steps');
  const flow = useRef<FlowInstance>(null);

  const nodeTypes = useMemo(() => ({ task }), []);

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
    },
    [onNodesChange],
  );

  return (
    <window width={880} height={560} title="@react-x11/components — Flow">
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
          <text style={{ fontSize: 12, color: '$dim', flexGrow: 1 }}>
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
            if (selected.length > 0) {
              setStatus(
                selected.length === 1
                  ? `selected ${selected[0].id} — Delete removes it`
                  : `${selected.length} selected`,
              );
            }
          }}
          defaultEdgeOptions={{ type: 'smoothstep' }}
          fitView
          minimap
          controls
          snapToGrid
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
