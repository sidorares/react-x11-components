// Run with: npm run examples:flow-map   (needs GL: macOS, or X11 with direct GL)
//
// A graph whose cards are live maps. Two of the nodes are OpenStreetMap
// vector tiles — London, and Westminster closer in — that pan with a drag
// inside them and zoom with the wheel, while their title bars drag the node
// and the pane around them pans and zooms the graph.
//
// The maps are drawn by the graph's own GL surface, in its paint order:
// `glBody` on the node type hands `<Flow>` a `GlMapLayer` (`useGlMapLayer`,
// from `@react-x11/components/maps`), which draws the map into a texture in
// `<Flow>`'s context, and `<Flow>` draws that texture as a quad in the card.
// A pan of the graph moves the texture and draws no map.
//
//   npm run examples:flow-map                  # GL bodies (the default)
//   npm run examples:flow-map -- --glarea      # each map a <Map renderer="gl">
//                                              # mounted through `render`: a
//                                              # second <glarea>, for comparison
//   npm run examples:flow-map -- --retained    # the 2D renderer, where `render`
//                                              # is the GL body's fallback
//   npm run examples:flow-map -- --dark
//
// Tiles come from OpenStreetMap through `./map-sources.ts`, kept on disk
// under the OS temp directory (the bench's cache, `scripts/bench/sweep/`),
// so a second run fetches nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useMemo } from 'react';
import type { ReactElement, Ref } from 'react';
import { createRoot } from 'react-x11';

import { Flow, useEdgesState, useNodesState } from '../src/flow/index.js';
import type {
  FlowEdge,
  FlowFrameStats,
  FlowInstance,
  FlowNode,
  FlowNodeType,
} from '../src/flow/index.js';
import { Map, shortbreadStyle, useGlMapLayer } from '../src/maps/index.js';
import type {
  GlMapLayer,
  LngLat,
  MapFrameStats,
  MapMarker,
  MapSource,
  MapStyle,
} from '../src/maps/index.js';
import { osmVector } from './map-sources.js';

/** Where the tiles are kept between runs — the maps bench's cache. */
const CACHE =
  process.env.BENCH_TILES ?? path.join(os.tmpdir(), 'react-x11-sweep-tiles');

/** OpenStreetMap's vector tiles, from the disk cache where they are there. */
export const cachedSource: MapSource = {
  id: 'osm-vector',
  minZoom: 0,
  maxZoom: 14,
  tileSize: 512,
  attribution: osmVector.attribution,
  load: async (request) => {
    const file = path.join(CACHE, `${request.z}-${request.x}-${request.y}.pbf`);
    if (fs.existsSync(file)) {
      return { kind: 'vector', data: new Uint8Array(fs.readFileSync(file)) };
    }
    const got = await osmVector.load(request);
    if (got && got.kind === 'vector' && got.data) {
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, got.data);
    }
    return got;
  },
};

/** How the maps are drawn. */
export type FlowMapMode = 'gl-body' | 'glarea' | 'retained';

interface PlaceData {
  label: string;
  description?: string;
  /** For a map node: where it looks. */
  centre?: LngLat;
  zoom?: number;
}

const TRAFALGAR: LngLat = { lon: -0.1281, lat: 51.508 };
const PINS: MapMarker[] = [
  { id: 'trafalgar', position: TRAFALGAR, title: 'Trafalgar Square' },
  {
    id: 'parliament',
    position: { lon: -0.1246, lat: 51.4995 },
    title: 'Parliament',
  },
  {
    id: 'stpauls',
    position: { lon: -0.0984, lat: 51.5138 },
    title: "St Paul's",
  },
];

/** The graph: a source, a style, two maps reading them, and a sink. */
export function flowMapScene(): {
  nodes: FlowNode<PlaceData>[];
  edges: FlowEdge[];
} {
  return {
    nodes: [
      {
        id: 'tiles',
        position: { x: 0, y: 40 },
        data: { label: 'OSM vector tiles', description: 'z0–14, Shortbread' },
        type: 'input',
      },
      {
        id: 'style',
        position: { x: 0, y: 300 },
        data: { label: 'shortbreadStyle()', description: 'labels on' },
        type: 'input',
      },
      {
        id: 'london',
        type: 'map',
        position: { x: 260, y: 0 },
        width: 380,
        height: 280,
        data: { label: 'London', centre: TRAFALGAR, zoom: 13.5 },
      },
      {
        id: 'westminster',
        type: 'map',
        position: { x: 260, y: 330 },
        width: 380,
        height: 280,
        data: {
          label: 'Westminster',
          centre: { lon: -0.1262, lat: 51.5025 },
          zoom: 15.5,
        },
      },
      {
        id: 'out',
        position: { x: 720, y: 280 },
        data: { label: 'report', description: 'what both maps show' },
        type: 'output',
      },
    ],
    edges: [
      { id: 't-l', source: 'tiles', target: 'london', animated: true },
      { id: 's-w', source: 'style', target: 'westminster' },
      { id: 't-w', source: 'tiles', target: 'westminster' },
      { id: 'l-o', source: 'london', target: 'out' },
      { id: 'w-o', source: 'westminster', target: 'out' },
    ],
  };
}

const MAP_HANDLES = [
  { type: 'target', position: 'left' },
  { type: 'source', position: 'right' },
] as const;

export interface FlowMapAppProps {
  mode?: FlowMapMode;
  dark?: boolean;
  flowRef?: Ref<FlowInstance>;
  onFrame?: (stats: FlowFrameStats) => void;
  /** Every frame either map drew, whichever way it is drawn. */
  onMapFrame?: (id: string, stats: MapFrameStats) => void;
  /** The layers, once made — for a bench that drives them. */
  onLayers?: (layers: Readonly<Record<string, GlMapLayer>>) => void;
}

export function FlowMapApp(props: FlowMapAppProps): ReactElement {
  const mode = props.mode ?? 'gl-body';
  const dark = props.dark ?? false;
  const scene = useMemo(flowMapScene, []);
  const [nodes, , onNodesChange] = useNodesState(scene.nodes);
  const [edges, , onEdgesChange] = useEdgesState(scene.edges);
  const mapStyle: MapStyle = useMemo(
    () => shortbreadStyle({ dark, labels: true }),
    [dark],
  );
  const onMapFrame = props.onMapFrame;
  const mapProps = (id: string) => {
    const data = scene.nodes.find((n) => n.id === id)!.data!;
    return {
      sources: [cachedSource],
      mapStyle,
      defaultCamera: { center: data.centre!, zoom: data.zoom! },
      markers: PINS,
      onFrame: onMapFrame
        ? (stats: MapFrameStats) => onMapFrame(id, stats)
        : undefined,
    };
  };
  // One layer per map node, made once and kept as long as the app is: the
  // node type looks them up, it does not make them.
  const london = useGlMapLayer(mapProps('london'));
  const westminster = useGlMapLayer(mapProps('westminster'));
  const layers = useMemo(
    () => ({ london, westminster }) as Record<string, GlMapLayer>,
    [london, westminster],
  );
  props.onLayers?.(layers);

  const nodeTypes = useMemo(() => {
    const map: FlowNodeType<PlaceData> = {
      headerHeight: 26,
      handles: MAP_HANDLES,
      // The GL renderer draws this; the 2D renderer mounts `render` instead.
      glBody:
        mode === 'gl-body' ? ({ node }) => layers[node.id] ?? null : undefined,
      render: ({ node }) =>
        (
          <Map
            {...mapProps(node.id)}
            renderer={mode === 'glarea' ? 'gl' : 'retained'}
            style={{ flexGrow: 1 }}
          />
        ) as ReactElement,
    };
    return { map };
  }, [mode, layers, mapStyle]);

  return (
    <Flow<PlaceData>
      ref={props.flowRef}
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      renderer={mode === 'retained' ? 'retained' : 'gl'}
      onFrame={props.onFrame}
      onError={(error) => console.warn('flow GL:', error.message)}
      fitView
      minimap
      controls
      background={{ variant: 'dots', gap: 24 }}
      style={{ flexGrow: 1 }}
    />
  );
}

if (!process.env.REACT_X11_NO_AUTORUN) {
  const args = process.argv.slice(2);
  const mode: FlowMapMode = args.includes('--glarea')
    ? 'glarea'
    : args.includes('--retained')
      ? 'retained'
      : 'gl-body';
  const root = await createRoot({ glPolicy: 'auto' });
  root.render(
    <window
      title={`flow + map (${mode})`}
      width={1100}
      height={720}
      theme={
        args.includes('--dark')
          ? { background: '#14161a', text: '#d7dae0' }
          : undefined
      }
    >
      <FlowMapApp mode={mode} dark={args.includes('--dark')} />
    </window>,
  );
}
