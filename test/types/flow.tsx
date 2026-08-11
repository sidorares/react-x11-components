// Type-level test: the declarations compile against react-x11's JSX
// namespace, the data generic flows from `nodes` into every callback, and
// the raw element the module augmentation adds is a typed tag.
import { useRef } from 'react';

import {
  addEdge,
  applyNodeChanges,
  Flow,
  useNodesState,
} from '../../src/index.js';
import type {
  Connection,
  FlowEdge,
  FlowInstance,
  FlowNode,
  FlowNodeType,
  NodeChange,
} from '../../src/index.js';

interface Job {
  label: string;
  cost: number;
}

const nodes: FlowNode<Job>[] = [
  { id: 'a', position: { x: 0, y: 0 }, data: { label: 'a', cost: 1 } },
];
const edges: FlowEdge[] = [
  { id: 'a-b', source: 'a', target: 'b', markerEnd: 'arrowclosed' },
];

const jobType: FlowNodeType<Job> = {
  size: { width: 120, height: 40 },
  handles: [
    { type: 'target', position: 'left' },
    { type: 'source', position: 'right', id: 'out' },
  ],
  paint({ node, rect, zoom, palette, painter }) {
    painter.rect(rect.x, rect.y, rect.width, rect.height, 4 * zoom, {
      fill: palette.nodeBackground,
    });
    // the generic reached the paint callback: `cost` is a number here
    painter.text(
      `${node.data?.label} ${(node.data?.cost ?? 0).toFixed(1)}`,
      rect.x,
      rect.y,
    );
  },
};

export const asComponent = (
  <box style={{ flexGrow: 1 }}>
    <Flow<Job>
      nodes={nodes}
      edges={edges}
      nodeTypes={{ job: jobType }}
      onNodesChange={(changes: NodeChange<Job>[]) => void changes}
      // the data generic reaches the node handlers
      onNodeClick={(_ev, node) => void node.data?.cost.toFixed(0)}
      onConnect={(connection: Connection) => void addEdge(connection, edges)}
      fitView
      minimap={{ position: 'top-right' }}
      background="lines"
      style={{ flexGrow: 1 }}
    />
  </box>
);

// `import`ing the component teaches JSX the element too
export const asElement = (
  <flowgraph nodes={[]} edges={[]} style={{ flexGrow: 1 }} />
);

export function WithRef(): React.ReactElement {
  const flow = useRef<FlowInstance>(null);
  const [current, , onNodesChange] = useNodesState<Job>(nodes);
  return (
    <Flow<Job>
      ref={flow}
      nodes={current}
      onNodesChange={onNodesChange}
      onPaneClick={() => flow.current?.fitView({ padding: 0.2 })}
    />
  );
}

export const changes: FlowNode<Job>[] = applyNodeChanges(
  [{ type: 'select', id: 'a', selected: true }],
  nodes,
);

// @ts-expect-error a node needs a position
export const noPosition: FlowNode = { id: 'a' };

// @ts-expect-error an edge needs both ends
export const noTarget: FlowEdge = { id: 'e', source: 'a' };

export const badEdgeType: FlowEdge = {
  id: 'e',
  source: 'a',
  target: 'b',
  // @ts-expect-error 'diagonal' is not an edge type
  type: 'diagonal',
};

export const badHandle: FlowNode = {
  id: 'a',
  position: { x: 0, y: 0 },
  // @ts-expect-error handles sit on a side, not at a corner
  handles: [{ type: 'source', position: 'top-left' }],
};

// @ts-expect-error the pane draws its own contents and takes no children
export const withChildren = <Flow nodes={[]}>nope</Flow>;
