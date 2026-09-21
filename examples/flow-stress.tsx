// Run with: npm run examples:flow-stress   (needs an X server / DISPLAY)
//
// The `<Flow>` example that exists to be measured rather than to look nice.
// Pick a scene and read the line under the buttons: it is always there, and
// always says how many frames a second the pane drew and what each cost
// this thread — whether you are panning, dragging a node, zooming, or doing
// nothing (both renderers draw on change and not otherwise, so an idle pane
// reads 0 and says it is idle). The numbers come from `<Flow onFrame>`.
//
//   pan   — drives the viewport continuously, each step asked for by the
//           frame that drew the last, so the loop runs at the rate the window
//           delivers rather than at a timer's 60/s.
//   drag  — grab any node; the line adds the gesture's steps a second.
//   gl    — switches the pane to `renderer="gl"` (docs/prd-flow-gl.md): the
//           graph drawn through a `<glarea>`, a pan a uniform write. Labels
//           at a new size arrive a frame or two after a zoom stops — the line
//           counts any a frame was still waiting on.
//   bodies ≤ N ms — `<Flow adaptive>`: what re-scaling mounted bodies may
//           add to one step of a zoom gesture. Over it they sit the gesture
//           out, off screen and still mounted, and come back at the new
//           scale when it rests; the line says which, and what the pane
//           predicted.
//
// On the 2D renderer the line also reports X requests and bytes per frame
// from `react-x11/debug`'s trace — everything that renderer draws is X
// protocol on an X server — and the opcode tally is printed on exit. See
// docs/components/flow.md, "What the pane batches".
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import { Button, Checkbox, Select, createRoot } from 'react-x11';
import { startTrace } from 'react-x11/debug';
import type { TraceSession } from 'react-x11/debug';

import { Flow, useEdgesState, useNodesState } from '../src/index.js';
import type {
  FlowEdge,
  FlowFrameStats,
  FlowInstance,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  HandlePosition,
} from '../src/index.js';

interface Scene {
  name: string;
  detail: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** Which side of a node faces a point — so a chain's handles follow the
 * chain instead of all pointing down. */
function facing(from: FlowNode, to: FlowNode): HandlePosition {
  const dx = to.position.x - from.position.x;
  const dy = to.position.y - from.position.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/**
 * 20 nodes on an Archimedean spiral, joined in one chain.
 *
 * A spiral rather than a row because it is the small scene's whole job to be
 * *readable*: every node is on screen at a zoom that draws labels and
 * handles, so this is the case where per-node cost shows up undiluted, and
 * every edge kind has to route between two nodes at an arbitrary angle.
 */
function spiral(): Scene {
  const count = 20;
  const width = 104;
  // One and a half turns, starting far enough out that the arc between two
  // consecutive nodes is wider than a node. Tighter than that and the inner
  // ring overlaps itself, which reads as a bug rather than as a spiral.
  const turns = 1.5;
  const step = (Math.PI * 2 * turns) / count;
  const inner = Math.ceil(width / step);
  const nodes: FlowNode[] = [];
  for (let i = 0; i < count; i++) {
    const theta = i * step;
    const radius = inner + 30 * theta;
    nodes.push({
      id: `s${i}`,
      position: {
        // stretched across, because the pane is wider than it is tall
        x: Math.round(Math.cos(theta) * radius * 1.25),
        y: Math.round(Math.sin(theta) * radius),
      },
      width,
      height: 38,
      data: { label: `step ${i + 1}` },
    });
  }
  for (let i = 0; i < count; i++) {
    const next = nodes[i + 1];
    if (!next) continue;
    nodes[i].sourcePosition = facing(nodes[i], next);
    next.targetPosition = facing(next, nodes[i]);
  }
  const edges: FlowEdge[] = [];
  for (let i = 0; i + 1 < count; i++) {
    edges.push({
      id: `s${i}-s${i + 1}`,
      source: `s${i}`,
      target: `s${i + 1}`,
      label: i % 4 === 0 ? `${i}` : undefined,
      animated: i === count - 2,
    });
  }
  return {
    name: '20 · spiral',
    detail: 'one chain, every node readable',
    nodes,
    edges,
  };
}

/**
 * 300 nodes in layers, each fanning out to two or three in the next — the
 * shape that makes edges rather than nodes the cost, and the one a fitted
 * viewport draws small enough that the pane's zoom thresholds start
 * dropping detail. Between them the two scenes bracket the interesting
 * range.
 */
function fanOut(): Scene {
  // A lens: layer widths follow a half sine, scaled so the whole thing is
  // 300 nodes. Eighteen layers rather than ten because the pane is a wide
  // rectangle, and a graph that is taller than it is wide gets fitted to its
  // height with most of the pane left empty — which measures the *grid*
  // rather than the graph.
  const depth = 18;
  const raw = Array.from({ length: depth }, (_, l) =>
    Math.sin((Math.PI * (l + 0.5)) / depth),
  );
  const scale = 300 / raw.reduce((a, b) => a + b, 0);
  const layers = raw.map((v) => Math.max(2, Math.round(v * scale)));
  // spend the rounding error on the widest layer, so the total is exact
  const widest = layers.indexOf(Math.max(...layers));
  layers[widest] += 300 - layers.reduce((a, b) => a + b, 0);

  const nodes: FlowNode[] = [];
  const ids: string[][] = [];
  let n = 0;
  for (let l = 0; l < layers.length; l++) {
    const row: string[] = [];
    for (let i = 0; i < layers[l]; i++) {
      const id = `f${n++}`;
      row.push(id);
      nodes.push({
        id,
        position: {
          x: l * 150,
          // centred on the widest layer, so the whole thing is a lens
          y: (i - layers[l] / 2) * 46,
        },
        width: 96,
        height: 34,
        data: { label: id },
        sourcePosition: 'right',
        targetPosition: 'left',
      });
    }
    ids.push(row);
  }
  const edges: FlowEdge[] = [];
  for (let l = 0; l + 1 < ids.length; l++) {
    const next = ids[l + 1];
    for (let i = 0; i < ids[l].length; i++) {
      // two or three children, spread across the next layer rather than
      // adjacent, so the edges cross the way a real dependency graph's do
      const fan = 2 + ((i + l) % 2);
      for (let k = 0; k < fan; k++) {
        const target = next[(i * 2 + k * 3 + l) % next.length];
        edges.push({
          id: `${ids[l][i]}-${target}-${k}`,
          source: ids[l][i],
          target,
          type: 'bezier',
        });
      }
    }
  }
  return {
    name: '300 · fan-out',
    detail: `${nodes.length} nodes, ${edges.length} edges`,
    nodes,
    edges,
  };
}

/**
 * 200 nodes in a lattice, two edges out of each, some labelled and some
 * marching — `scripts/bench/flow.ts`'s `grid` scene, so what this window
 * shows and what the bench measures are the same graph.
 */
function lattice(): Scene {
  const count = 200;
  const cols = Math.ceil(Math.sqrt(count * 1.6));
  const nodes: FlowNode[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `n${i}`,
      position: { x: (i % cols) * 170, y: Math.floor(i / cols) * 90 },
      width: 120,
      height: 48,
      data: { label: `node ${i}`, description: 'a second line' },
      sourcePosition: 'right',
      targetPosition: 'left',
    });
  }
  const edges: FlowEdge[] = [];
  for (let i = 0; i < count; i++) {
    for (let k = 1; k <= 2; k++) {
      const target = (i + cols + k * 3) % count;
      if (target === i) continue;
      edges.push({
        id: `e${i}-${k}`,
        source: `n${i}`,
        target: `n${target}`,
        type: 'bezier',
        label: i % 7 === 0 ? `w${i}` : undefined,
        animated: i % 23 === 0,
      });
    }
  }
  return {
    name: '200 · lattice',
    detail: `${nodes.length} nodes, ${edges.length} edges`,
    nodes,
    edges,
  };
}

// --- 400 nodes, each with a React body ---------------------------------------
//
// The heaviest scene: every node's type has a `render`, so every node on
// screen is a real react-x11 subtree — a status line, a progress bar, a
// checkbox and a button, laid out by yoga — mounted over its card. Two
// things bound how many exist at once, and both are the pane's design rather
// than this example's: bodies mount only at a zoom of 0.6 and above (below
// it a card is too small to hold a widget), and only while their card is in
// the pane. **0.6×** jumps to the densest view where they all mount.
//
// A body's state is its node's `data`, held in the example's graph state
// (`useNodesState`) — not in the body. A body is unmounted whenever its card
// leaves the pane or the zoom drops below 0.6, and a `useState` inside it
// goes with it; the graph's `data` does not, so a checkbox ticked, zoomed
// out and zoomed back in is still ticked.
//
// **tick** streams new values into a tenth of the nodes, ten times a second —
// a node's *content* changing with the graph's shape untouched, the case a
// value streaming in or a field typed into costs. The line counts every body
// render a second, and how many of them were handed the *same* `data` object
// as last time: a render that had nothing new to show, which is the number
// to watch when a pan or a drag should be moving boxes and nothing else.

/** Bodies mounted now, and body renders counted — module state, read by the
 *  readout, so counting costs no render of its own. */
export const mounted = { count: 0 };
export const renders = { total: 0, sameData: 0 };

export interface WidgetData {
  label: string;
  seed: number;
  enabled: boolean;
  runs: number;
  queue: number;
  progress: number;
}

/** How a body changes its own node: the example's setter, through context,
 *  so the node type can stay one stable object. */
export const PatchWidget = createContext<
  (id: string, patch: Partial<WidgetData>) => void
>(() => {});

function WidgetBody(props: { node: FlowNode<WidgetData> }): ReactElement {
  const patch = useContext(PatchWidget);
  const { node } = props;
  const data = node.data!;
  const seen = useRef<WidgetData | null>(null);
  renders.total++;
  if (seen.current === data) renders.sameData++;
  seen.current = data;
  useEffect(() => {
    mounted.count++;
    return () => {
      mounted.count--;
    };
  }, []);
  return (
    <box style={{ flexGrow: 1, padding: 6, gap: 5 }}>
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <box
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: data.enabled ? '#3fb950' : '$textMuted',
          }}
        />
        <text style={{ fontSize: 11 }}>
          {data.enabled ? `queue ${data.queue}` : 'paused'}
        </text>
      </box>
      <box
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: '$border',
          overflow: 'hidden',
        }}
      >
        <box
          style={{
            width: `${Math.round(data.progress * 100)}%`,
            height: 6,
            backgroundColor: '$accent',
          }}
        />
      </box>
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Checkbox
          label="on"
          checked={data.enabled}
          onChange={(ev) => patch(node.id, { enabled: ev.value })}
        />
        <Button
          label={`run ${data.runs}`}
          onPress={() => patch(node.id, { runs: data.runs + 1 })}
        />
      </box>
    </box>
  );
}

const widgetType: FlowNodeType<WidgetData> = {
  size: { width: 200, height: 124 },
  headerHeight: 26,
  handles: [
    { type: 'target', position: 'left' },
    { type: 'source', position: 'right' },
  ],
  render: ({ node }) => <WidgetBody node={node} />,
};

export const WIDGET_TYPES = { widget: widgetType } as Record<
  string,
  FlowNodeType<unknown>
>;

/** A streamed value for node `seed` at tick `tick`. */
function streamed(
  seed: number,
  tick: number,
): Pick<WidgetData, 'queue' | 'progress'> {
  return {
    queue: (seed * 7 + tick * 3) % 50,
    progress: ((seed * 13 + tick * 2) % 100) / 100,
  };
}

export function widgets(): Scene {
  const count = 400;
  const cols = 25;
  const nodes: FlowNode[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `w${i}`,
      type: 'widget',
      position: { x: (i % cols) * 250, y: Math.floor(i / cols) * 180 },
      data: {
        label: `worker ${i}`,
        seed: i,
        enabled: i % 3 !== 0,
        runs: 0,
        ...streamed(i, 0),
      } as unknown as FlowNode['data'],
    });
  }
  const edges: FlowEdge[] = [];
  for (let i = 0; i < count; i++) {
    for (let k = 1; k <= 2; k++) {
      const target = (i + cols + k * 3) % count;
      if (target === i) continue;
      edges.push({
        id: `we${i}-${k}`,
        source: `w${i}`,
        target: `w${target}`,
        animated: i % 29 === 0,
      });
    }
  }
  return {
    name: '400 · widgets',
    detail: `${count} nodes with React bodies, ${edges.length} edges`,
    nodes,
    edges,
  };
}

/** The body budgets the dropdown offers (`<Flow adaptive>`): what re-scaling
 *  mounted bodies may add to one step of a zoom gesture before they sit it
 *  out. `live` never holds them; `0` always does. */
const BUDGETS = [
  { value: '4', label: 'bodies ≤ 4 ms' },
  { value: '8', label: 'bodies ≤ 8 ms' },
  { value: '16', label: 'bodies ≤ 16 ms' },
  { value: '32', label: 'bodies ≤ 32 ms' },
  { value: '0', label: 'bodies: always hold' },
  { value: 'live', label: 'bodies: always live' },
];

const EMPTY: Scene = { name: 'empty', detail: 'nothing', nodes: [], edges: [] };

function App(): ReactElement {
  const [scene, setScene] = useState<Scene>(EMPTY);
  // The graph lives here, not in the pane, so a body's state — its node's
  // `data` — outlives the body.
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const patchWidget = useCallback(
    (id: string, patch: Partial<WidgetData>) =>
      setNodes((current) =>
        current.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, ...patch } as FlowNodeData }
            : n,
        ),
      ),
    [setNodes],
  );
  const [panning, setPanning] = useState(false);
  const [stats, setStats] = useState(
    'press a scene, then drag a node — or pan for the full-frame loop',
  );
  const flow = useRef<FlowInstance>(null);
  const trace = useRef<TraceSession | null>(null);

  const scenes = useMemo(() => [spiral(), lattice(), fanOut(), widgets()], []);
  const [ticking, setTicking] = useState(false);
  useEffect(() => {
    if (!ticking) return;
    let tick = 0;
    const timer = setInterval(() => {
      tick++;
      // A tenth of the widgets a tick, each a new `data`; the rest keep
      // theirs, identity and all — which is what lets a render with
      // nothing new in it be told apart.
      setNodes((current) =>
        current.map((n, i) => {
          if (n.type !== 'widget' || (i + tick) % 10 !== 0) return n;
          const data = n.data as unknown as WidgetData;
          return {
            ...n,
            data: {
              ...data,
              ...streamed(data.seed, tick),
            } as unknown as FlowNodeData,
          };
        }),
      );
    }, 100);
    return () => clearInterval(timer);
  }, [ticking, setNodes]);
  const [gl, setGl] = useState(false);
  const [budget, setBudget] = useState('8');
  // Every frame the pane drew, on either renderer, from `onFrame`, drained by
  // the readout below. A ref, not state: setting state per frame would
  // re-render this component 120 times a second, and that is not what is
  // being measured.
  const drawn = useRef<FlowFrameStats[]>([]);
  const panningRef = useRef(false);
  panningRef.current = panning;
  const dx = useRef(2);
  const steps = useRef(0);
  const onFrame = useCallback((stats: FlowFrameStats) => {
    drawn.current.push(stats);
    if (!panningRef.current) return;
    // The next pan step, asked for by the frame that drew the last one — on
    // both renderers, so the loop runs at whatever rate the window delivers
    // rather than the 60/s a 16 ms timer can ask for.
    setImmediate(() => {
      const viewport = flow.current?.getViewport();
      if (!viewport) return;
      // reverse at the edges so the graph stays on screen
      if (viewport.x < -400 || viewport.x > 400) dx.current = -dx.current;
      flow.current?.setViewport({ x: viewport.x + dx.current });
    });
  }, []);

  const load = useCallback((next: Scene) => {
    setScene(next);
    setNodes(next.nodes);
    setEdges(next.edges);
    setStats(`${next.nodes.length} nodes, ${next.edges.length} edges`);
  }, []);

  // One trace for the whole run: the readout reports deltas out of it.
  useEffect(() => {
    const session = startTrace({ sink: 'summary' });
    trace.current = session;
    return () => {
      trace.current = null;
      const totals = session.stop();
      // The opcode tally is where a regression names itself — one line, on
      // exit, so the terminal is not a firehose while it runs.
      const top = [...totals.byOpcode.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, count]) => `${name} ${count}`)
        .join(', ');
      console.log(`[flow-stress] ${top}`);
    };
  }, []);

  useEffect(() => {
    if (!panning) return;
    // one nudge; every frame after asks for the next (`onFrame`)
    const viewport = flow.current?.getViewport();
    if (viewport) flow.current?.setViewport({ x: viewport.x + 1 });
  }, [panning, gl]);

  // The readout: every 600 ms, whatever is happening — a pan, a drag, a
  // zoom, or nothing. Both renderers draw on change and not otherwise, so an
  // idle pane is 0 frames/s and says so rather than going quiet.
  useEffect(() => {
    const last = {
      requests: 0,
      bytes: 0,
      steps: 0,
      renders: renders.total,
      sameData: renders.sameData,
      at: Date.now(),
    };
    const seed = trace.current?.stats;
    if (seed) {
      last.requests = seed.requests;
      last.bytes = seed.bytesOut;
    }
    const report = setInterval(() => {
      const now = Date.now();
      const dt = (now - last.at) / 1000;
      const wire = trace.current?.stats;
      const requests = wire ? wire.requests - last.requests : 0;
      const kb = wire ? (wire.bytesOut - last.bytes) / 1024 : 0;
      const dragged = steps.current - last.steps;
      if (wire) {
        last.requests = wire.requests;
        last.bytes = wire.bytesOut;
      }
      last.steps = steps.current;
      const rendered = renders.total - last.renders;
      const wasted = renders.sameData - last.sameData;
      last.renders = renders.total;
      last.sameData = renders.sameData;
      last.at = now;

      const frames = drawn.current.splice(0, drawn.current.length);
      const renderer =
        frames[frames.length - 1]?.renderer ?? (gl ? 'gl' : 'retained');
      const parts = [
        `${scene.nodes.length} nodes · ${scene.edges.length} edges`,
        `${renderer}: ${(frames.length / dt).toFixed(0)} fps`,
      ];
      if (frames.length === 0) {
        parts.push('idle — draws only on change');
      } else {
        const cpu = frames
          .map((f) => f.sceneMs + f.packMs + f.drawMs)
          .sort((a, b) => a - b);
        parts.push(
          `${cpu[cpu.length >> 1].toFixed(2)} ms/frame on this thread`,
        );
        if (renderer === 'gl') {
          parts.push(`${frames.filter((f) => f.worldRebuilt).length} rebuilds`);
          const text = frames[frames.length - 1].gaps.text;
          if (text) parts.push(`${text} labels still being set`);
        } else if (requests > 0) {
          // X protocol per frame — what the 2D renderer costs on the wire
          parts.push(
            `${(requests / frames.length).toFixed(0)} req/frame`,
            `${(kb / frames.length).toFixed(1)} KB/frame`,
          );
        }
      }
      if (dragged > 0) parts.push(`drag ${(dragged / dt).toFixed(0)} steps/s`);
      if (mounted.count > 0) parts.push(`${mounted.count} bodies mounted`);
      // what the budget made of the last zoom step
      const held = frames[frames.length - 1]?.bodies;
      if (held && held.count > 0) {
        parts.push(
          `${held.held ? 'held' : 'live'}: ${held.predictedMs.toFixed(1)} ms ` +
            `predicted (${held.perBodyMs.toFixed(2)} ms/body)` +
            (Number.isFinite(held.budgetMs) ? ` vs ${held.budgetMs}` : ''),
        );
      }
      if (rendered > 0) {
        parts.push(
          `${(rendered / dt).toFixed(0)} body renders/s ` +
            `(${(wasted / dt).toFixed(0)}/s with data unchanged)`,
        );
      }
      setStats(parts.join(' · '));
    }, 600);
    return () => clearInterval(report);
  }, [scene, gl]);

  return (
    <window
      width={1100}
      height={720}
      title="@react-x11/components — Flow stress"
    >
      <box style={{ flexGrow: 1, padding: 12, gap: 10 }}>
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {scenes.map((s) => (
            <Button
              key={s.name}
              label={s.name}
              primary={scene.name === s.name}
              onPress={() => load(s)}
            />
          ))}
          <Button label="clear" onPress={() => load(EMPTY)} />
          <Button
            label={panning ? 'stop' : 'pan'}
            primary={panning}
            onPress={() => setPanning((on) => !on)}
          />
          <Button label="fit" onPress={() => flow.current?.fitView()} />
          <Button label="gl" primary={gl} onPress={() => setGl((on) => !on)} />
          <Button
            label="0.6×"
            onPress={() => {
              // the densest view that still mounts bodies (RENDER_ZOOM)
              const v = flow.current?.getViewport();
              if (v) flow.current?.setViewport({ ...v, zoom: 0.6 });
            }}
          />
          <Select
            value={budget}
            options={BUDGETS}
            onChange={(event) => setBudget(event.value)}
            // drawn rather than AppKit's popup — sidorares/react-x11#552, as
            // in maps-gl: a native menu this near the window's top closes on
            // the readout's next layout pass
            native={false}
            style={{ width: 170 }}
          />
          <Button
            label={ticking ? 'stop tick' : 'tick'}
            primary={ticking}
            onPress={() => setTicking((on) => !on)}
          />
        </box>
        <text style={{ fontSize: 12, color: '$textMuted' }}>{stats}</text>
        <PatchWidget.Provider value={patchWidget}>
          <Flow
            // A remount per scene: `defaultNodes` is read once, and the
            // uncontrolled pane owning the arrays is what makes every node
            // draggable with no state wiring up here.
            key={scene.name}
            ref={flow}
            nodes={nodes}
            edges={edges}
            onEdgesChange={onEdgesChange}
            nodeTypes={WIDGET_TYPES}
            onNodesChange={(changes) => {
              // Stored, as an application holding its graph stores it — which
              // re-renders this component each step, and that is part of what
              // a controlled graph costs, so it is in the numbers.
              onNodesChange(changes);
              steps.current++;
            }}
            fitView
            fitViewOptions={{ padding: 0.06 }}
            renderer={gl ? 'gl' : 'retained'}
            adaptive={budget === 'live' ? false : { budgetMs: Number(budget) }}
            onFrame={onFrame}
            onError={(error) => setStats(`gl failed: ${error.message}`)}
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
        </PatchWidget.Provider>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  // `glPolicy: 'auto'` so an X11 server with direct GL gets it; the Cocoa
  // backend draws through the GPU either way.
  const root = await createRoot({ glPolicy: 'auto' });
  root.render(<App />);
}
