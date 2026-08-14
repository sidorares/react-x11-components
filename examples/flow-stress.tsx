// Run with: npm run examples:flow-stress   (needs an X server / DISPLAY)
//
// The `<Flow>` example that exists to be measured rather than to look nice.
// Pick a scene, press **pan** to drive the viewport continuously, and read
// the counters: nodes, edges, X requests per frame, bytes per frame, and the
// rate the pan loop actually achieved.
//
// Everything the pane draws ends up as X protocol, so `react-x11/debug`'s
// trace is the measurement: `requests` and `bytesOut`, and `byOpcode` for
// where a regression came from. Two numbers, two interactive paths:
//
//   pan   — repaints everything (the whole scene translated), so it measures
//           the full-frame cost per scene. Press **pan** for the loop.
//   drag  — repaints only the box the node moved through: the pane claims
//           damage for the moved node and its edges, and everything outside
//           it survives on the window from the last frame. Grab any node and
//           the readout shows what each step actually cost.
//
// The readout is per pan frame while the loop runs, and per drag step while
// you drag. See docs/components/flow.md, "What the pane batches".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, createRoot } from 'react-x11';
import { startTrace } from 'react-x11/debug';
import type { TraceSession } from 'react-x11/debug';

import { Flow } from '../src/index.js';
import type {
  FlowEdge,
  FlowInstance,
  FlowNode,
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

const EMPTY: Scene = { name: 'empty', detail: 'nothing', nodes: [], edges: [] };

/** One pan step per tick. 16ms asks for 60/s; what the readout shows is what
 * the loop *achieved*, so a frame that costs more than the interval drags the
 * measured rate down — which is the whole point of the number. */
const TICK_MS = 16;

function App(): ReactElement {
  const [scene, setScene] = useState<Scene>(EMPTY);
  const [panning, setPanning] = useState(false);
  const [stats, setStats] = useState(
    'press a scene, then drag a node — or pan for the full-frame loop',
  );
  const flow = useRef<FlowInstance>(null);
  const trace = useRef<TraceSession | null>(null);

  const scenes = useMemo(() => [spiral(), fanOut()], []);

  const load = useCallback((next: Scene) => {
    setScene(next);
    setStats(`${next.nodes.length} nodes, ${next.edges.length} edges`);
  }, []);

  // One trace for the whole run: the readout below reports deltas out of it,
  // so it measures the pan loop and a manual drag alike.
  const frames = useRef(0);
  const steps = useRef(0);
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
    let dx = 2;
    const tick = setInterval(() => {
      const viewport = flow.current?.getViewport();
      if (!viewport) return;
      // reverse at the edges so the graph stays on screen
      if (viewport.x < -400 || viewport.x > 400) dx = -dx;
      flow.current?.setViewport({ x: viewport.x + dx });
      frames.current++;
    }, TICK_MS);
    return () => clearInterval(tick);
  }, [panning]);

  useEffect(() => {
    const last = { requests: 0, bytes: 0, frames: 0, steps: 0, at: Date.now() };
    const seed = trace.current?.stats;
    if (seed) {
      last.requests = seed.requests;
      last.bytes = seed.bytesOut;
    }
    const report = setInterval(() => {
      const stats = trace.current?.stats;
      if (!stats) return;
      const now = Date.now();
      const dt = (now - last.at) / 1000;
      const requests = stats.requests - last.requests;
      const kb = (stats.bytesOut - last.bytes) / 1024;
      const panned = frames.current - last.frames;
      const dragged = steps.current - last.steps;
      last.requests = stats.requests;
      last.bytes = stats.bytesOut;
      last.frames = frames.current;
      last.steps = steps.current;
      last.at = now;
      const head = `${scene.nodes.length} nodes · ${scene.edges.length} edges — `;
      if (panned > 0) {
        setStats(
          head +
            `pan: ${(requests / panned).toFixed(0)} req/frame · ` +
            `${(kb / panned).toFixed(1)} KB/frame · ` +
            `${(panned / dt).toFixed(0)} frames/s`,
        );
      } else if (dragged > 0) {
        setStats(
          head +
            `drag: ${(requests / dragged).toFixed(0)} req/step · ` +
            `${(kb / dragged).toFixed(1)} KB/step · ` +
            `${(dragged / dt).toFixed(0)} steps/s`,
        );
      }
    }, 600);
    return () => clearInterval(report);
  }, [scene]);

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
        </box>
        <text style={{ fontSize: 12, color: '$textMuted' }}>{stats}</text>
        <Flow
          // A remount per scene: `defaultNodes` is read once, and the
          // uncontrolled pane owning the arrays is what makes every node
          // draggable with no state wiring up here.
          key={scene.name}
          ref={flow}
          defaultNodes={scene.nodes}
          defaultEdges={scene.edges}
          onNodesChange={() => {
            // one batch per gesture step — counted, never stored: a setState
            // here would re-render this component per pointer move, and the
            // pane's own cost is what is being measured
            steps.current++;
          }}
          fitView
          fitViewOptions={{ padding: 0.06 }}
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
