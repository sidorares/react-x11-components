// The GL map proof of concept (`src/maps/gl/`), without a GPU.
//
// Everything that decides what a frame draws is plain arithmetic over typed
// arrays — the bucket layout, the membership grouping, the cover's
// stand-ins, the scissor rounding — and is asserted here directly. The GL
// calls themselves are checked against a recording stand-in for the
// context, which is enough to pin the one GL-level decision that went wrong
// on a real surface: whether the framebuffer has a stencil buffer.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  userEvent,
  waitFor,
} from 'react-x11/test';

import { GeomType, parseTile } from '../src/maps/mvt.js';
import {
  project,
  transformFor,
  unproject,
  unprojectPoint,
} from '../src/maps/proj.js';
import { QUALITY_LADDER, chooseQuality } from '../src/maps/gl/view.js';
import { Map as MapView } from '../src/maps/index.js';
import type { MapHandle } from '../src/maps/index.js';
import {
  DEFAULT_RENDERER,
  capabilityBlockers,
  chooseRenderer,
  loadGlRenderer,
  rendererRequest,
} from '../src/maps/renderer.js';
import { prepareStyle } from '../src/maps/paint.js';
import type { MapStyleLayer } from '../src/maps/style.js';
import { attributionOf } from '../src/maps/sources.js';
import type { MapSource } from '../src/maps/sources.js';
import {
  attributionLayout,
  drawMarkers,
  drawOverlays,
  geoJsonOverlays,
  markerAt,
  markerOrder,
} from '../src/maps/overlay.js';
import type { MapMarker, MapOverlay } from '../src/maps/overlay.js';
import {
  BREAK,
  RECORD_BYTES,
  TILE_EXTENT,
  buildTileBuckets,
  rasterTileData,
} from '../src/maps/gl/buckets.js';
import type { GlTileData } from '../src/maps/gl/buckets.js';
import { parseColor, premultiplied } from '../src/maps/gl/color.js';
import { renderCover } from '../src/maps/gl/cover.js';
import {
  LABEL_STRIDE,
  LabelField,
  buildTileLabels,
  mergeParts,
  straightRuns,
  upright,
} from '../src/maps/anchors.js';
import type { GlLabelData } from '../src/maps/anchors.js';
import {
  LabelShaper,
  collectLabels,
  drawLabels,
  placeLabels,
} from '../src/maps/labels.js';
import { MARKER_INSTANCE, MarkerBatcher } from '../src/maps/gl/markers.js';
import {
  buildOverlayBucket,
  overlayRegion,
  regionPlacement,
} from '../src/maps/gl/overlays.js';
import {
  FADE_MS,
  LABEL_INSTANCE,
  LabelPlacer,
} from '../src/maps/gl/placement.js';
import type { PlacementFrame } from '../src/maps/gl/placement.js';
import {
  GlMapRenderer,
  dashPattern,
  scissorOf,
} from '../src/maps/gl/renderer.js';
import { GlTileStore } from '../src/maps/gl/store.js';
import { LabelAtlas } from '../src/maps/gl/text.js';
import type { TextEngine } from '../src/maps/gl/text.js';

test.afterEach(async () => {
  await cleanup();
});

// --- a minimal MVT encoder (the same shape as test/maps.test.ts's) ----------

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}
const zigzag = (v: number): number => (v < 0 ? -v * 2 - 1 : v * 2);
const field = (n: number, wire: number): number[] => varint((n << 3) | wire);
const bytes = (n: number, payload: number[]): number[] => [
  ...field(n, 2),
  ...varint(payload.length),
  ...payload,
];
const text = (n: number, s: string): number[] =>
  bytes(n, [...Buffer.from(s, 'utf8')]);
const command = (id: number, count: number): number[] =>
  varint((id & 0x7) | (count << 3));

/** Geometry commands for one part: MoveTo, LineTo… and ClosePath for a ring. */
function part(
  points: [number, number][],
  closed: boolean,
  cursor = { x: 0, y: 0 },
): number[] {
  const out = [
    ...command(1, 1),
    zigzag(points[0][0] - cursor.x),
    zigzag(points[0][1] - cursor.y),
  ];
  cursor.x = points[0][0];
  cursor.y = points[0][1];
  out.push(...command(2, points.length - 1));
  for (const [x, y] of points.slice(1)) {
    out.push(zigzag(x - cursor.x), zigzag(y - cursor.y));
    cursor.x = x;
    cursor.y = y;
  }
  if (closed) out.push(...command(7, 1));
  return out;
}

interface Feature {
  type: GeomType;
  tags: number[];
  geometry: number[];
}

function layer(
  name: string,
  extent: number,
  keys: string[],
  values: string[],
  features: Feature[],
): number[] {
  const out = [...text(1, name)];
  for (const f of features) {
    const body = [
      ...bytes(2, f.tags.flatMap(varint)),
      ...field(3, 0),
      ...varint(f.type),
      ...bytes(4, f.geometry.flatMap(varint)),
    ];
    out.push(...bytes(2, body));
  }
  for (const k of keys) out.push(...text(3, k));
  for (const v of values) out.push(...bytes(4, text(1, v)));
  out.push(...field(5, 0), ...varint(extent), ...field(15, 0), ...varint(2));
  return bytes(3, out);
}

/** Two roads at extent 2048 (like Shortbread's `streets`), one path, and a
 *  building with a courtyard at 4096. */
function fixtureTile() {
  const road = (kind: number, points: [number, number][]): Feature => ({
    type: GeomType.LineString,
    tags: [0, kind],
    geometry: part(points, false),
  });
  const cursor = { x: 0, y: 0 };
  const building: Feature = {
    type: GeomType.Polygon,
    tags: [],
    // Exterior clockwise on screen (positive area, y down), hole the other way.
    geometry: [
      ...part(
        [
          [100, 100],
          [900, 100],
          [900, 900],
          [100, 900],
        ],
        true,
        cursor,
      ),
      ...part(
        [
          [300, 300],
          [300, 700],
          [700, 700],
          [700, 300],
        ],
        true,
        cursor,
      ),
    ],
  };
  return parseTile(
    new Uint8Array([
      ...layer(
        'streets',
        2048,
        ['kind'],
        ['primary', 'residential', 'footway'],
        [
          road(0, [
            [0, 0],
            [300, 400],
            [600, 400],
          ]),
          road(1, [
            [10, 10],
            [20, 10],
          ]),
          road(2, [
            [50, 50],
            [60, 60],
          ]),
        ],
      ),
      ...layer('buildings', 4096, [], [], [building]),
    ]),
  );
}

const STYLE: MapStyleLayer[] = [
  { id: 'buildings', type: 'fill', sourceLayer: 'buildings', color: '#ccbbaa' },
  {
    id: 'primary-casing',
    type: 'line',
    sourceLayer: 'streets',
    filter: ['in', 'kind', 'primary'],
    color: '#806040',
    width: 4,
  },
  {
    id: 'minor-casing',
    type: 'line',
    sourceLayer: 'streets',
    filter: ['in', 'kind', 'residential'],
    color: '#999999',
    width: 3,
  },
  {
    id: 'primary',
    type: 'line',
    sourceLayer: 'streets',
    filter: ['in', 'kind', 'primary'],
    color: '#ffcc66',
    width: 2,
  },
  {
    id: 'minor',
    type: 'line',
    sourceLayer: 'streets',
    filter: ['in', 'kind', 'residential'],
    color: '#ffffff',
    width: 1,
  },
];

function records(buffer: ArrayBuffer): {
  i16: Int16Array;
  f32: Float32Array;
  count: number;
} {
  return {
    i16: new Int16Array(buffer),
    f32: new Float32Array(buffer),
    count: buffer.byteLength / RECORD_BYTES,
  };
}

// --- buckets ------------------------------------------------------------------

test('a road is its points plus one sentinel, normalised to the common extent', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const line = records(data.line);
  const draw = data.draws[3]!;
  assert.strictEqual(draw.kind, 'line');
  const [first, count] = draw.ranges;
  // Three points and a sentinel — no extrusion, no join geometry.
  assert.strictEqual(count, 4);
  const at = (i: number) => [
    line.i16[(first + i) * 4],
    line.i16[(first + i) * 4 + 1],
  ];
  // `streets` is cut at 2048, so every coordinate doubles on the way in.
  assert.strictEqual(TILE_EXTENT / 2048, 2);
  assert.deepStrictEqual(at(0), [0, 0]);
  assert.deepStrictEqual(at(1), [600, 800]);
  assert.deepStrictEqual(at(2), [1200, 800]);
  assert.deepStrictEqual(at(3), [BREAK, BREAK]);
  // The distance along the line, in normalised units, for dashes.
  assert.strictEqual(line.f32[(first + 1) * 2 + 1], 1000);
  assert.strictEqual(line.f32[(first + 2) * 2 + 1], 1600);
});

test('a casing and its fill share one copy of the geometry', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  // Same features selected, so the same group, so the same records.
  assert.deepStrictEqual(data.draws[1]!.ranges, data.draws[3]!.ranges);
  assert.deepStrictEqual(data.draws[2]!.ranges, data.draws[4]!.ranges);
  assert.notDeepStrictEqual(data.draws[1]!.ranges, data.draws[2]!.ranges);
  // Every layer is exactly one range: the grouping made them contiguous.
  for (const draw of data.draws.filter(Boolean))
    assert.strictEqual(draw!.ranges.length, 2);
  // The footway matches no layer and costs nothing: two roads' points
  // (3 + 2) and a sentinel each.
  assert.strictEqual(data.lineRecords, 3 + 1 + 2 + 1);
});

test('a ring is closed explicitly, carries its fan apex, and ends in a sentinel', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const fill = records(data.fill);
  const [first, count] = data.draws[0]!.ranges;
  // Two rings of four points, each closed (+1) and ended (+1).
  assert.strictEqual(count, 12);
  const rec = (i: number) =>
    Array.from(fill.i16.subarray((first + i) * 4, (first + i) * 4 + 4));
  assert.deepStrictEqual(rec(0), [100, 100, 100, 100]);
  assert.deepStrictEqual(rec(2), [900, 900, 100, 100]);
  // The closing point is the first again, then the sentinel.
  assert.deepStrictEqual(rec(4), [100, 100, 100, 100]);
  assert.deepStrictEqual(rec(5), [BREAK, BREAK, BREAK, BREAK]);
  // The courtyard is its own ring with its own apex — which is what lets
  // the winding count cut it out.
  assert.deepStrictEqual(rec(6), [300, 300, 300, 300]);
  assert.deepStrictEqual(rec(8).slice(2), [300, 300]);
  assert.deepStrictEqual(rec(11), [BREAK, BREAK, BREAK, BREAK]);
});

// --- the cover ------------------------------------------------------------------

const pyramid = { minZoom: 0, maxZoom: 14, tileSize: 512 };
const camera = { center: { lon: 0.35, lat: 0.35 }, zoom: 12 };
const pane = { width: 100, height: 100 };
const stub = { stats: { ms: 0 } } as unknown as GlTileData;

test('a hole is covered by its ancestor, clipped to the hole', () => {
  const { tiles: want } = renderCover(camera, pane, 1, pyramid, {
    get: () => stub,
  });
  assert.ok(want.length > 0);
  const target = want[0];
  const lookup = {
    get: (t: { z: number }) => (t.z === 10 ? stub : undefined),
  };
  const { tiles, missing } = renderCover(camera, pane, 1, pyramid, lookup);
  assert.strictEqual(missing.length, want.length);
  const stand = tiles[0];
  // Two levels up: four times the size, clipped to the level-12 square.
  assert.strictEqual(stand.size, target.size * 4);
  assert.deepStrictEqual(stand.clip, target.clip);
  assert.ok(stand.x <= target.x && stand.y <= target.y);
  assert.ok(stand.x + stand.size >= target.x + target.size);
});

test('zooming out, four children in hand stand in for their parent', () => {
  const lookup = {
    get: (t: { z: number }) => (t.z === 13 ? stub : undefined),
  };
  const { tiles } = renderCover(camera, pane, 1, pyramid, lookup);
  const { tiles: want } = renderCover(camera, pane, 1, pyramid, {
    get: () => stub,
  });
  assert.strictEqual(tiles.length, want.length * 4);
  assert.strictEqual(tiles[0].size, want[0].size / 2);
});

test('a tile with no data is not missing, and is drawn from its ancestor', () => {
  const lookup = {
    get: (t: { z: number }) =>
      t.z === 12 ? null : t.z === 11 ? stub : undefined,
  };
  const { tiles, missing } = renderCover(camera, pane, 1, pyramid, lookup);
  assert.strictEqual(missing.length, 0);
  assert.ok(tiles.length > 0);
});

// --- scissors and colours -------------------------------------------------------

test('two tiles that share an edge round it to the same pixel column', () => {
  for (const x of [10.3, 10.5, 10.7, 99.49]) {
    const left = scissorOf(
      { x: 0.2, y: 0.4, width: x - 0.2, height: 50 },
      200,
      100,
    )!;
    const right = scissorOf({ x, y: 0.4, width: 40.6, height: 50 }, 200, 100)!;
    assert.strictEqual(left[0] + left[2], right[0], `edge at ${x}`);
  }
  // Bottom-left origin: a box at the top of a 100-high viewport starts at 50.
  assert.deepStrictEqual(
    scissorOf({ x: 0, y: 0, width: 10, height: 50 }, 100, 100),
    [0, 50, 10, 50],
  );
  assert.strictEqual(
    scissorOf({ x: 300, y: 0, width: 10, height: 10 }, 100, 100),
    null,
  );
});

test('colours parse to straight floats and premultiply once', () => {
  assert.deepStrictEqual(parseColor('#ff8000'), [1, 128 / 255, 0, 1]);
  assert.deepStrictEqual(parseColor('#f80'), [1, 0x88 / 255, 0, 1]);
  assert.deepStrictEqual(parseColor('rgba(255, 0, 0, 0.5)'), [1, 0, 0, 0.5]);
  assert.strictEqual(parseColor('not a colour'), null);
  assert.deepStrictEqual(
    premultiplied([1, 0.5, 0, 0.5], 0.5),
    [0.25, 0.125, 0, 0.25],
  );
});

// --- the store ------------------------------------------------------------------

test('the store loads, builds under the budget, and keeps buckets across a palette change', async () => {
  const tile = new Uint8Array([
    ...layer(
      'buildings',
      4096,
      [],
      [],
      [
        {
          type: GeomType.Polygon,
          tags: [],
          geometry: part(
            [
              [0, 0],
              [10, 0],
              [10, 10],
            ],
            true,
          ),
        },
      ],
    ),
  ]);
  let changes = 0;
  const source: MapSource = {
    load: ({ z }) => (z === 3 ? { kind: 'vector', data: tile } : null),
  };
  const light = prepareStyle({ layers: STYLE });
  const store = new GlTileStore({
    source,
    prepared: light,
    onChange: () => changes++,
  });
  assert.strictEqual(store.get({ z: 3, x: 1, y: 1 }), undefined);
  store.want([
    { z: 3, x: 1, y: 1 },
    { z: 3, x: 2, y: 1 },
    { z: 4, x: 0, y: 0 },
  ]);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(changes >= 3);
  assert.strictEqual(store.building, 2);
  // A deadline already passed still builds one tile.
  assert.strictEqual(store.pump(0), true);
  assert.strictEqual(store.pump(0), false);
  const built = store.get({ z: 3, x: 1, y: 1 });
  assert.ok(built && built.fillRecords > 0);
  assert.strictEqual(store.get({ z: 4, x: 0, y: 0 }), null);
  // A different colour is a uniform: nothing to rebuild.
  store.setStyle(
    prepareStyle({
      layers: STYLE.map((l) => ({ ...l, color: '#000000' })) as MapStyleLayer[],
    }),
  );
  assert.strictEqual(store.building, 0);
  // A different filter selects different features: rebuild, keep drawing.
  store.setStyle(prepareStyle({ layers: STYLE.slice(1) }));
  assert.strictEqual(store.building, 2);
  assert.strictEqual(store.get({ z: 3, x: 1, y: 1 }), built);
  store.dispose(() => {});
});

// --- the renderer, against a recording context ---------------------------------

/**
 * Enough of the WebGL-shaped table to run `GlMapRenderer`: every call is
 * recorded, every object is a number, and `readPixels` answers the stencil
 * probe the way a surface with or without a stencil buffer would.
 */
function recordingGl(stencil: boolean) {
  const calls: string[] = [];
  /** …with their arguments, for a test about what a call was given. */
  const log: { name: string; args: unknown[] }[] = [];
  let next = 1;
  const constants = new Map<string, number>();
  const target: Record<string, unknown> = {
    getParameter: () => 0,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => next++,
    readPixels: (
      x: number,
      y: number,
      w: number,
      h: number,
      f: number,
      t: number,
      out: Uint8Array,
    ) => {
      calls.push('readPixels');
      // Pixel 0 is the NOTEQUAL-0 draw over a cleared stencil: only a
      // framebuffer with no stencil buffer lets it through.
      const magenta = [255, 0, 255, 255];
      if (!stencil) out.set(magenta, 0);
      out.set(magenta, 4);
    },
  };
  return {
    calls,
    log,
    gl: new Proxy(target, {
      get(obj, name: string) {
        if (name in obj) return obj[name];
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
          if (!constants.has(name))
            constants.set(name, 0x1000 + constants.size);
          return constants.get(name);
        }
        return (...args: unknown[]) => {
          calls.push(name);
          log.push({ name, args });
          return name.startsWith('create')
            ? next++
            : args.length
              ? undefined
              : 0;
        };
      },
    }),
  };
}

function frameOver(data: GlTileData, style = STYLE) {
  return {
    width: 256,
    height: 256,
    zoom: 12,
    scale: 1,
    style: prepareStyle({ layers: style }),
    background: '#f0ece4',
    sources: [
      [
        {
          data,
          x: 0,
          y: 0,
          size: 256,
          clip: { x: 0, y: 0, width: 256, height: 256 },
        },
      ],
    ],
  };
}

test('a surface with no stencil buffer is found out, and drawn through an offscreen one', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const without = recordingGl(false);
  assert.strictEqual(
    new GlMapRenderer(without.gl).render(frameOver(data)).offscreen,
    true,
  );
  assert.ok(without.calls.includes('createFramebuffer'));
  const withStencil = recordingGl(true);
  assert.strictEqual(
    new GlMapRenderer(withStencil.gl).render(frameOver(data)).offscreen,
    false,
  );
  assert.ok(!withStencil.calls.includes('createFramebuffer'));
});

test('non-zero fills take two stencil passes, even-odd one', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const only = STYLE.slice(0, 1);
  const count = (rule: 'nonzero' | 'evenodd') => {
    const { gl, calls } = recordingGl(true);
    new GlMapRenderer(gl, { fillRule: rule, antialias: false }).render(
      frameOver(data, only),
    );
    return calls.filter((c) => c === 'drawArraysInstanced').length;
  };
  assert.strictEqual(count('nonzero'), 2);
  assert.strictEqual(count('evenodd'), 1);
});

test('on a table with stencilOpSeparate, a non-zero fill is one pass: front faces up, back faces down', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const only = STYLE.slice(0, 1);
  const { gl, log } = recordingGl(true);
  // x11-dri 0.8's table has the entry; the recording one answers every
  // name, so it is told which it has.
  const separate = new Proxy(gl as object, {
    has: (target, name) => name === 'stencilOpSeparate' || name in target,
  });
  const renderer = new GlMapRenderer(separate, { antialias: false });
  renderer.render(frameOver(data, only));
  assert.strictEqual(
    log.filter((c) => c.name === 'drawArraysInstanced').length,
    1,
  );
  const ops = log.filter((c) => c.name === 'stencilOpSeparate');
  assert.strictEqual(ops.length, 2);
  // And what the frame is priced at says so.
  const twoPass = new GlMapRenderer(recordingGl(true).gl, { antialias: false });
  assert.ok(
    renderer.estimate(frameOver(data, only)) <
      twoPass.estimate(frameOver(data, only)),
  );
});

test('a map that names no renderer is auto — the retained one on a connection with no direct GL, which it says', async () => {
  assert.strictEqual(DEFAULT_RENDERER, 'auto');
  assert.deepStrictEqual(rendererRequest(undefined, undefined), {
    asked: 'auto',
    forced: false,
  });
  // The environment still has the last word.
  assert.deepStrictEqual(rendererRequest(undefined, 'retained'), {
    asked: 'retained',
    forced: true,
  });
  const changes: [string, string][] = [];
  const result = await renderX11(
    React.createElement(MapView, {
      defaultCamera: { center: { lon: -0.1281, lat: 51.508 }, zoom: 12 },
      onRendererChange: (renderer, reason) => changes.push([renderer, reason]),
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 640, height: 480 },
  );
  await waitFor(() => {
    assert.deepStrictEqual(changes, [['retained', 'no-direct-gl']]);
  });
  assert.strictEqual(kindOf(result.getByTestName('map')), 'mapview');
});

test('what a frame is estimated to cost is what it draws', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  // A detail layer: the style brings the minor roads in at zoom 11.5.
  const style = STYLE.map((l) =>
    l.id.startsWith('minor') ? { ...l, minZoom: 11.5 } : l,
  ) as MapStyleLayer[];
  for (const [edges, detail] of [
    [true, 0],
    [false, 0],
    [false, 1],
  ] as const) {
    const { gl } = recordingGl(true);
    const renderer = new GlMapRenderer(gl);
    const frame = { ...frameOver(data, style), edges, detail };
    const drawn = renderer.render(frame).instances;
    assert.strictEqual(renderer.estimate(frame), drawn, `${edges} ${detail}`);
  }
  // Leaving the edge pass out is a pass fewer over the fill stream, and a
  // level of detail out drops the layers that begin within that level.
  const { gl } = recordingGl(true);
  const renderer = new GlMapRenderer(gl);
  const full = renderer.estimate(frameOver(data, style));
  const noEdges = renderer.estimate({
    ...frameOver(data, style),
    edges: false,
  });
  const lessDetail = renderer.estimate({
    ...frameOver(data, style),
    edges: false,
    detail: 1,
  });
  assert.ok(
    full > noEdges && noEdges > lessDetail,
    `${full} ${noEdges} ${lessDetail}`,
  );
});

test('a fade draws the arriving level whole, offscreen, and composites it once', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const plain = recordingGl(true);
  const alone = new GlMapRenderer(plain.gl).render(frameOver(data));
  const faded = recordingGl(true);
  const stats = new GlMapRenderer(faded.gl).render(frameOver(data), {
    fade: { frame: frameOver(data), alpha: 0.4 },
  });
  assert.strictEqual(stats.fade, 0.4);
  // Both scenes, whole: twice the work, not a translucent second pass.
  assert.strictEqual(stats.instances, alone.instances * 2);
  // One offscreen target for the arriving scene (the surface has stencil),
  // and nothing offscreen at all without a fade.
  const framebuffers = (calls: string[]) =>
    calls.filter((c) => c === 'createFramebuffer').length;
  assert.strictEqual(framebuffers(plain.calls), 0);
  assert.strictEqual(framebuffers(faded.calls), 1);
  // An alpha of 0 is no fade at all.
  const none = recordingGl(true);
  new GlMapRenderer(none.gl).render(frameOver(data), {
    fade: { frame: frameOver(data), alpha: 0 },
  });
  assert.strictEqual(framebuffers(none.calls), 0);
});

test('adaptive quality takes the lowest rung that fits, and climbs back only with room', () => {
  // A frame whose every rung costs half the one before it.
  const predict = (rung: number) => 16 / 2 ** rung;
  // 16 ms at rung 0; 12 ms budget: rung 1 (8 ms) fits.
  assert.strictEqual(chooseQuality(0, predict, 12), 1);
  // From rung 3 with a 12 ms budget, rung 2 (4 ms) and rung 1 (8 ms) are
  // both inside 75% of it (9 ms), so it climbs to 1 — and not to 0 (16 ms).
  assert.strictEqual(chooseQuality(3, predict, 12), 1);
  // At 10 ms a frame at rung 1 (8 ms) stays: rung 0 would not fit.
  assert.strictEqual(chooseQuality(1, predict, 10), 1);
  // Nothing fits: the last rung, which is as cheap as it gets.
  assert.strictEqual(
    chooseQuality(0, () => 100, 12),
    QUALITY_LADDER.length - 1,
  );
  // Everything fits with room: the full picture.
  assert.strictEqual(
    chooseQuality(4, () => 1, 12),
    0,
  );
});

test('a cover can be drawn from another level, holes still borrowing', () => {
  const { tiles: own } = renderCover(camera, pane, 1, pyramid, {
    get: () => stub,
  });
  const { tiles, level } = renderCover(
    camera,
    pane,
    1,
    pyramid,
    { get: () => stub },
    { level: 10 },
  );
  assert.strictEqual(level, 10);
  assert.strictEqual(tiles[0].size, own[0].size * 4);
});

// --- input, through the harness's X server ---------------------------------------

async function mountGlMap() {
  // Loaded before the render, so `<Map>` mounts the GL renderer at once
  // rather than a frame later, when its dynamic import lands.
  await loadGlRenderer();
  const ref = React.createRef<MapHandle>();
  const result = await renderX11(
    React.createElement(
      'window',
      { width: 640, height: 480 },
      React.createElement(MapView, {
        ref,
        renderer: 'gl',
        defaultCamera: { center: { lon: -0.1281, lat: 51.508 }, zoom: 12 },
        'data-testname': 'map',
        // The harness's server has no GLX: the surface reports that, and
        // the pane — which is what input reaches — is there regardless.
        onError: () => {},
        style: { flexGrow: 1 },
      }),
    ),
    { backend: 'xserver', width: 640, height: 480, wrap: false } as never,
  );
  const node = result.getByTestName('map');
  return { handle: ref.current as MapHandle, node };
}

/** Pane-local logical pixels to the ground, for a camera over a pane. */
function groundAt(
  handle: MapHandle,
  size: { width: number; height: number },
  x: number,
  y: number,
) {
  return unprojectPoint(transformFor(handle.getCamera(), size), x, y);
}

test('a drag on the map pans it with the pointer', async () => {
  const { handle, node } = await mountGlMap();
  const size = { width: node.abs.width, height: node.abs.height };
  // Pressed at the centre, the ground there follows the pointer.
  const pressed = groundAt(handle, size, size.width / 2, size.height / 2);
  fireEvent.mouseDown(node);
  fireEvent.mouseMove(node, { dx: 20, dy: 10 });
  fireEvent.mouseMove(node, { dx: 60, dy: 35 });
  fireEvent.mouseUp(node, { dx: 60, dy: 35 });
  await act(async () => {});
  const now = groundAt(handle, size, size.width / 2 + 60, size.height / 2 + 35);
  assert.ok(
    Math.abs(now.lon - pressed.lon) < 1e-6,
    `${pressed.lon} -> ${now.lon}`,
  );
  assert.ok(
    Math.abs(now.lat - pressed.lat) < 1e-6,
    `${pressed.lat} -> ${now.lat}`,
  );
});

test('a wheel zooms about the pointer, and a double click zooms in', async () => {
  const { handle, node } = await mountGlMap();
  const size = { width: node.abs.width, height: node.abs.height };
  const point = { x: size.width / 2 - 140, y: size.height / 2 + 90 };
  const before = groundAt(handle, size, point.x, point.y);
  await userEvent.wheel(node, { dx: -140, dy: 90, deltaY: -4 });
  assert.ok(handle.getCamera().zoom > 12, 'the wheel zoomed in');
  const after = groundAt(handle, size, point.x, point.y);
  assert.ok(
    Math.abs(after.lon - before.lon) < 1e-6,
    `${before.lon} -> ${after.lon}`,
  );
  assert.ok(
    Math.abs(after.lat - before.lat) < 1e-6,
    `${before.lat} -> ${after.lat}`,
  );

  const zoom = handle.getCamera().zoom;
  fireEvent.doubleClick(node, { dx: 30, dy: -20 });
  await act(async () => {});
  assert.ok(
    Math.abs(handle.getCamera().zoom - (zoom + 1)) < 1e-9,
    `double click: ${zoom} -> ${handle.getCamera().zoom}`,
  );
});

test('a wheel notch is eased rather than landing in one step', async () => {
  const { handle, node } = await mountGlMap();
  await userEvent.wheel(node, { deltaY: -1 });
  // A notch is 0.384 of a level, and the glide is the controller's, so the
  // GL renderer has it too: the event's own step is worth a frame, and the
  // steps after it carry the rest. They are the controller's own timer
  // rather than this view's frames, which is why they still happen here —
  // the harness's server has no GLX, so nothing is ever drawn.
  const first = handle.getCamera().zoom;
  assert.ok(first > 12, `the notch moved the map at once: ${first}`);
  assert.ok(first < 12.375, `but not all of it at once: ${first}`);
  await new Promise((resolve) => setTimeout(resolve, 260));
  const zoom = handle.getCamera().zoom;
  assert.ok(
    Math.abs(zoom - 12.375) < 1e-9,
    `and the rest arrived after it: ${zoom}`,
  );
});

test("a touchpad's fractions over the GL map are applied as they arrive", async () => {
  const { handle, node } = await mountGlMap();
  // The same accumulator as `<Map>`'s retained renderer, reached through
  // the GL renderer's pane — which is where core delivers a wheel over the
  // surface since react-x11#545, fractions and `ev.smooth` included. A
  // twenty-fourth of a notch is too small for the quantized camera; eight
  // of them are two steps, with no frame or timer in between.
  await userEvent.wheel(node, { deltaY: -1 / 24, smooth: true });
  assert.equal(handle.getCamera().zoom, 12, 'one fraction is too small');
  for (let i = 0; i < 7; i++) {
    await userEvent.wheel(node, { deltaY: -1 / 24, smooth: true });
  }
  const zoom = handle.getCamera().zoom;
  assert.ok(Math.abs(zoom - 12.125) < 1e-9, `eight of them are two: ${zoom}`);
});

// --- labels: anchors ---------------------------------------------------------------

const LABEL_STYLE: MapStyleLayer[] = [
  {
    id: 'places',
    type: 'symbol',
    sourceLayer: 'place_labels',
    textField: 'name',
    textSize: 14,
    rank: 100,
    textColor: '#222222',
    textHaloColor: '#ffffff',
    textHaloWidth: 1.5,
  },
  {
    id: 'streets',
    type: 'symbol',
    sourceLayer: 'street_labels',
    textField: 'name',
    textSize: 11,
    rank: 20,
    textColor: '#444444',
    textHaloColor: '#ffffff',
    textHaloWidth: 1,
  },
];

/**
 * A street cut into three pieces the way schemas cut them, one of them
 * reversed; a street crossing it at a shared vertex; a zig-zag with no
 * straight stretch; and two places, one of them in the tile's buffer.
 */
function labelTile() {
  const street = (name: number, kind: number, points: [number, number][]) => ({
    type: GeomType.LineString,
    tags: [0, name, 1, kind],
    geometry: part(points, false),
  });
  const zigzag: [number, number][] = [];
  for (let i = 0; i < 12; i++) zigzag.push([200 + i * 60, i % 2 ? 3060 : 3000]);
  const place = (name: number, x: number, y: number) => ({
    type: GeomType.Point,
    tags: [0, name],
    geometry: [...command(1, 1), zigzag_(x), zigzag_(y)],
  });
  return parseTile(
    new Uint8Array([
      ...layer(
        'street_labels',
        4096,
        ['name', 'kind'],
        ['Long Street', 'Cross Street', 'Zig Zag', 'primary', 'residential'],
        [
          street(0, 4, [
            [200, 1000],
            [800, 1000],
          ]),
          // Reversed: pieces meet end to end in either direction.
          street(0, 4, [
            [1600, 1000],
            [1200, 1000],
            [800, 1000],
          ]),
          street(0, 4, [
            [1600, 1000],
            [2400, 1004],
          ]),
          street(1, 3, [
            [1200, 400],
            [1200, 1000],
          ]),
          street(1, 3, [
            [1200, 1000],
            [1200, 1600],
          ]),
          street(2, 4, zigzag),
        ],
      ),
      ...layer(
        'place_labels',
        4096,
        ['name'],
        ['Townsville', 'Elsewhere'],
        [place(0, 2048, 2048), place(1, -50, 100)],
      ),
    ]),
  );
}
const zigzag_ = zigzag;

interface Anchor {
  text: string;
  x: number;
  y: number;
  angle: number;
  avail: number;
  clear: number;
  length: number;
  dev: number;
  priority: number;
}

function anchorsOf(data: GlLabelData): Anchor[] {
  const out: Anchor[] = [];
  for (let i = 0; i < data.count; i++) {
    const a = data.anchors.subarray(i * LABEL_STRIDE, (i + 1) * LABEL_STRIDE);
    out.push({
      text: data.texts[a[LabelField.text]],
      x: a[LabelField.x],
      y: a[LabelField.y],
      angle: a[LabelField.angle],
      avail: a[LabelField.avail],
      clear: a[LabelField.clear],
      length: a[LabelField.length],
      dev: a[LabelField.dev],
      priority: a[LabelField.priority],
    });
  }
  return out;
}

test('a street cut into pieces is labelled along its one straight run, and knows where it is crossed', () => {
  const data = buildTileLabels(
    labelTile(),
    prepareStyle({ layers: LABEL_STYLE }),
    TILE_EXTENT,
  );
  const anchors = anchorsOf(data);
  const long = anchors
    .filter((a) => a.text === 'Long Street')
    .sort((a, b) => a.x - b.x);
  // One run of 2200 units: its middle and the middle of each block either
  // side of the junction at x = 1200.
  assert.deepStrictEqual(
    long.map((a) => Math.round(a.x)),
    [700, 1300, 1800],
  );
  for (const a of long) {
    assert.ok(Math.abs(a.y - 1000) < 3, `on the centre line: ${a.y}`);
    assert.ok(Math.abs(a.angle) < 0.01, `along the street: ${a.angle}`);
    assert.ok(Math.abs(a.length - 2200) < 1, `one run: ${a.length}`);
    assert.ok(a.dev < 3, `straight: ${a.dev}`);
    assert.strictEqual(a.priority, 4, 'a residential street');
  }
  // How far each is from the crossing, and how much run either side.
  assert.deepStrictEqual(
    long.map((a) => Math.round(a.clear)),
    [500, 100, 600],
  );
  assert.deepStrictEqual(
    long.map((a) => Math.round(a.avail)),
    [500, 1100, 600],
  );
  // The crossing street runs down the screen and reads bottom to top.
  const cross = anchors.filter((a) => a.text === 'Cross Street');
  assert.ok(cross.length > 0);
  for (const a of cross) {
    assert.ok(Math.abs(a.angle + Math.PI / 2) < 1e-6, `upright: ${a.angle}`);
    assert.strictEqual(a.priority, 7, 'a primary road');
  }
  // A zig-zag has no stretch long enough to carry anything.
  assert.strictEqual(anchors.filter((a) => a.text === 'Zig Zag').length, 0);
  // A place is its point; one in the buffer is the neighbour's to offer.
  const places = anchors.filter((a) => a.avail < 0);
  assert.deepStrictEqual(
    places.map((a) => [a.text, a.x, a.y]),
    [['Townsville', 2048, 2048]],
  );
});

test('pieces merge end to end either way round, taking the straightest way on', () => {
  const chains = mergeParts([
    [0, 0, 10, 0],
    [20, 0, 10, 0],
    [10, 0, 10, 10],
  ]);
  assert.deepStrictEqual(chains, [
    [0, 0, 10, 0, 20, 0],
    [10, 0, 10, 10],
  ]);
  // A corner ends a run; a gentle bend inside the tolerance does not.
  assert.strictEqual(straightRuns([0, 0, 1000, 0, 1000, 1000]).length, 2);
  assert.strictEqual(straightRuns([0, 0, 500, 4, 1000, 0]).length, 1);
  assert.strictEqual(upright(Math.PI), 0);
  // Vertical reads upward, and so does anything within 10° of it, either
  // side — a slight lean is no reason to read a name the other way.
  const deg = Math.PI / 180;
  assert.strictEqual(upright(Math.PI / 2), -Math.PI / 2);
  assert.ok(Math.abs(upright(85 * deg) + 95 * deg) < 1e-9);
  assert.ok(Math.abs(upright(-95 * deg) + 95 * deg) < 1e-9);
  assert.ok(Math.abs(upright(70 * deg) - 70 * deg) < 1e-9);
});

// --- labels: the retained renderer's, from the same anchors -------------------------

test('both renderers set a tile’s labels on the same anchors, at the same angles', () => {
  const tile = labelTile();
  const prepared = prepareStyle({ layers: LABEL_STYLE });
  const gl = anchorsOf(buildTileLabels(tile, prepared, TILE_EXTENT));
  const id = { z: 14, x: 8185, y: 5448 };
  const n = 2 ** id.z;
  const retained = collectLabels(tile, id, prepared, 14);
  assert.strictEqual(retained.length, gl.length);
  gl.forEach((a, i) => {
    const c = retained[i];
    assert.strictEqual(c.text, a.text);
    assert.strictEqual(c.mx, (id.x + a.x / TILE_EXTENT) / n);
    assert.strictEqual(c.my, (id.y + a.y / TILE_EXTENT) / n);
    assert.strictEqual(c.angle, a.avail < 0 ? 0 : a.angle);
  });
  // The street cut into three pieces is named along its one run, a name a
  // block — where the retained renderer used to set one level at the middle
  // of whichever piece had the largest box.
  assert.strictEqual(
    retained.filter((c) => c.text === 'Long Street').length,
    3,
  );
  const cross = retained.find((c) => c.text === 'Cross Street')!;
  assert.ok(Math.abs(cross.angle + Math.PI / 2) < 1e-6, 'reads upward');
});

/** Fonts that set every character half an em wide, and draw nothing. */
const halfEmFonts = {
  layout: (text: string, style: Record<string, unknown>) => {
    const size = style.size as number;
    return { width: text.length * size * 0.5, height: size, draw: () => {} };
  },
};

test('the retained renderer fits a name to its straight stretch, and turns it along the street', () => {
  const prepared = prepareStyle({ layers: LABEL_STYLE });
  const candidates = collectLabels(
    labelTile(),
    { z: 14, x: 0, y: 0 },
    prepared,
    14,
  ).filter((c) => c.text !== 'Townsville');
  const shaper = new LabelShaper(halfEmFonts, 'sans-serif', 1);
  const placed = (zoom: number) =>
    placeLabels(candidates, 512 * 2 ** zoom, shaper);
  // Two levels out, no stretch of either street is long enough for its
  // name, and neither is set anywhere.
  assert.deepStrictEqual(placed(12), []);
  // At the tile's own zoom, the primary road first, down its middle and
  // reading upward, then the residential street, level, clear of it.
  const at14 = placed(14);
  assert.deepStrictEqual(
    at14.map((l) => l.text),
    ['Cross Street', 'Long Street'],
  );
  assert.ok(Math.abs(at14[0].angle + Math.PI / 2) < 1e-6);
  assert.strictEqual(at14[1].angle, 0, 'its street is level to a pixel');
  // What a turned name covers is its turned box: tall, not wide.
  assert.ok(at14[0].height > at14[0].width);
});

test('the retained renderer draws a street name turned about its centre, and a level one on whole pixels', () => {
  const calls: { name: string; args: number[] }[] = [];
  const ctx = recordingCanvas(calls);
  const shaped = {
    width: 60,
    height: 11,
    layout: {
      draw: (_ctx: unknown, x: number, y: number) =>
        calls.push({ name: 'text', args: [x, y] }),
    },
  };
  const label = {
    id: 'a',
    key: 'streets|Main Street',
    text: 'Main Street',
    mx: 0.5,
    my: 0.5,
    angle: -Math.PI / 2,
    avail: 100,
    clear: 100,
    length: 200,
    dev: 0,
    rank: 0,
    priority: 0,
    size: 11,
    color: '#000000',
    halo: undefined,
    haloWidth: 0,
    repeat: 0,
    wx: 256,
    wy: 256,
    width: 15,
    height: 64,
    shaped,
  };
  drawLabels(
    ctx as never,
    [label, { ...label, id: 'b', angle: 0, wx: 100.3, wy: 50.6 }],
    transformFor(
      { center: { lon: 0, lat: 0 }, zoom: 0 },
      { width: 512, height: 512 },
      512,
    ),
    { x: 0, y: 0, width: 512, height: 512 },
    2,
    null,
    new LabelShaper(null, 'sans-serif', 2),
  );
  assert.deepStrictEqual(
    calls.slice(0, 5).map((c) => c.name),
    ['save', 'translate', 'rotate', 'text', 'restore'],
  );
  // About its centre, in device pixels, from half its size back.
  assert.deepStrictEqual(calls[1].args, [512, 512]);
  assert.deepStrictEqual(calls[2].args, [-Math.PI / 2]);
  assert.deepStrictEqual(calls[3].args, [-60, -11]);
  // The level one: no transform, and whole pixels.
  assert.deepStrictEqual(
    calls.slice(5).map((c) => c.name),
    ['text'],
  );
  assert.ok(calls[5].args.every(Number.isInteger), `${calls[5].args}`);
});

// --- labels: placement ---------------------------------------------------------------

/** An atlas whose text is 0.5 em a character, set and rasterized at once. */
function instantAtlas(): LabelAtlas {
  const engine: TextEngine = {
    measure: (text, size) => ({
      width: text.length * size * 0.5,
      height: size,
    }),
    rasterize: async (items, pad) =>
      items.map((item) => {
        const width = item.text.length * item.size * 0.5 + pad * 2;
        const height = item.size + pad * 2;
        return { width, height, pixels: new Uint8Array(width * height * 4) };
      }),
    dispose: () => {},
  };
  return new LabelAtlas(engine, { pad: 6 });
}

/** A tile's worth of hand-made anchors: `[text, x, y, angle, avail]`,
 *  `avail` < 0 for a point, on the layer the text's name says. */
function handAnchors(
  list: [string, number, number, number, number][],
): GlLabelData {
  const texts: string[] = [];
  const anchors = new Float32Array(list.length * LABEL_STRIDE);
  list.forEach(([text, x, y, angle, avail], i) => {
    const at = i * LABEL_STRIDE;
    let t = texts.indexOf(text);
    if (t < 0) t = texts.push(text) - 1;
    anchors[at + LabelField.x] = x;
    anchors[at + LabelField.y] = y;
    anchors[at + LabelField.angle] = angle;
    anchors[at + LabelField.avail] = avail;
    anchors[at + LabelField.clear] = 1e9;
    anchors[at + LabelField.length] = Math.max(0, avail * 2);
    anchors[at + LabelField.dev] = 0;
    anchors[at + LabelField.text] = t;
    anchors[at + LabelField.layer] = text.endsWith('ville') ? 0 : 1;
    anchors[at + LabelField.priority] = 4;
  });
  return { texts, anchors, count: list.length, ms: 0 };
}

/** One 512-pixel tile that is the whole world, so screen pixels are tile
 *  units / 8 and the mercator arithmetic is the identity. */
function labelFrame(labels: GlLabelData, now = 0): PlacementFrame {
  return {
    width: 512,
    height: 512,
    scale: 1,
    zoom: 15,
    style: labelStyle,
    tiles: [
      {
        data: { labels },
        x: 0,
        y: 0,
        size: 512,
        clip: { x: 0, y: 0, width: 512, height: 512 },
      },
    ],
    centerX: 0.5,
    centerY: 0.5,
    world: 512,
    now,
  };
}
const labelStyle = prepareStyle({ layers: LABEL_STYLE });

/** Place, let the rasters land in the texture, and fade everything
 *  placed fully in: the centres drawn, in screen pixels. */
async function settle(
  placer: LabelPlacer,
  atlas: LabelAtlas,
  labels: GlLabelData,
  from = 0,
): Promise<[number, number][]> {
  atlas.beginFrame(Infinity);
  placer.place(labelFrame(labels, from), atlas);
  atlas.pump();
  await new Promise((resolve) => setImmediate(resolve));
  // What a renderer does with them.
  for (const entry of atlas.takeUploads(Infinity)) entry.ready = true;
  placer.batch(labelFrame(labels, from), atlas);
  const batch = placer.batch(labelFrame(labels, from + FADE_MS), atlas);
  const out: [number, number][] = [];
  for (let i = 0; i < batch.count; i++) {
    out.push([
      batch.instances[i * LABEL_INSTANCE],
      batch.instances[i * LABEL_INSTANCE + 1],
    ]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

test('labels are placed by rank, never overlap, repeat only far apart, and stay whole in the view', async () => {
  const drawn = await settle(
    new LabelPlacer(),
    instantAtlas(),
    handAnchors([
      // A place, and a street name under it that must give way.
      ['Townsville', 2048, 2048, 0, -1],
      ['Main Street', 2048, 2060, 0, 2000],
      // The same street again 100 px along: inside the repeat distance.
      ['Main Street', 2848, 3200, 0, 2000],
      ['Main Street', 2048, 3200, 0, 2000],
      // Hard against the view's edge: it would be cut, so it is not drawn.
      ['Edge Road', 40, 1000, 0, 2000],
      // A run of 25 px cannot carry a 55 px name.
      ['Short Lane', 1000, 400, 0, 200],
    ]),
  );
  assert.deepStrictEqual(drawn, [
    [256, 256],
    [256, 400],
  ]);
});

test('a label keeps its place against a newcomer that would win a tie, and fades rather than pops', async () => {
  // Two names of one rank and class, equally far from the middle of the
  // view, overlapping.
  const zulu: [string, number, number, number, number] = [
    'Zulu Road',
    2016,
    2048,
    0,
    2000,
  ];
  const alpha: [string, number, number, number, number] = [
    'Alpha Road',
    2080,
    2048,
    0,
    2000,
  ];
  // Met together, the tie goes to the one that sorts first.
  const fresh = await settle(
    new LabelPlacer(),
    instantAtlas(),
    handAnchors([zulu, alpha]),
  );
  assert.deepStrictEqual(fresh, [[260, 256]]);
  // Shown first, the other one keeps its place when the rival arrives.
  const placer = new LabelPlacer();
  const atlas = instantAtlas();
  assert.deepStrictEqual(await settle(placer, atlas, handAnchors([zulu])), [
    [252, 256],
  ]);
  const both = handAnchors([zulu, alpha]);
  assert.deepStrictEqual(await settle(placer, atlas, both, 1000), [[252, 256]]);
  // Gone from the data, it fades out over FADE_MS rather than vanishing.
  placer.batch(labelFrame(both, 2000), atlas);
  const empty = handAnchors([]);
  placer.place(labelFrame(empty, 2000), atlas);
  const half = placer.batch(labelFrame(empty, 2000 + FADE_MS / 2), atlas);
  assert.strictEqual(half.count, 1);
  const inkAlpha = half.instances[11];
  assert.ok(inkAlpha > 0 && inkAlpha < 1, `half faded: ${inkAlpha}`);
  assert.ok(placer.animating);
  assert.strictEqual(
    placer.batch(labelFrame(empty, 2000 + FADE_MS), atlas).count,
    0,
  );
  assert.ok(!placer.animating);
});

// --- labels: the atlas and the draw ----------------------------------------------------

test('the atlas keeps what is drawn when it fills, and draws nothing the texture does not have', async () => {
  const engine: TextEngine = {
    measure: () => ({ width: 18, height: 2 }),
    rasterize: async (items) =>
      items.map(() => ({
        width: 30,
        height: 14,
        pixels: new Uint8Array(30 * 14 * 4),
      })),
    dispose: () => {},
  };
  // 64 × 64: shelves 16 high, two rasters a shelf, eight in all.
  const atlas = new LabelAtlas(engine, { size: 64, pad: 6 });
  const land = async (texts: string[]) => {
    atlas.beginFrame(Infinity);
    for (const t of texts) atlas.entry(t, 10);
    atlas.pump();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const upload = () => {
    const taken = atlas.takeUploads(Infinity);
    for (const entry of taken) entry.ready = true;
    return taken.length;
  };
  await land(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.strictEqual(atlas.entries, 8);
  // Landed is not drawable: not until the texture has it.
  assert.strictEqual(atlas.entry('a', 10), null);
  assert.strictEqual(upload(), 8);
  assert.ok(atlas.entry('a', 10));
  // Much later, only two of them still drawn; a ninth forces a compaction.
  for (let i = 0; i < 130; i++) atlas.beginFrame(Infinity);
  assert.ok(atlas.entry('a', 10) && atlas.entry('b', 10));
  await land(['i']);
  assert.strictEqual(atlas.entries, 3);
  // What was kept has moved: it goes up again before it is drawn again.
  assert.strictEqual(atlas.entry('a', 10), null);
  assert.strictEqual(upload(), 3);
  assert.ok(atlas.entry('a', 10) && atlas.entry('i', 10));
  // A new texture — a new context — has none of it, and gets all of it.
  atlas.restart();
  assert.strictEqual(atlas.entry('b', 10), null);
  assert.strictEqual(upload(), 3);
});

test('labels are one instanced draw over the scene, once their rasters are uploaded', async () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const atlas = instantAtlas();
  atlas.beginFrame(Infinity);
  assert.strictEqual(atlas.entry('Main Street', 11), null);
  atlas.pump();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(atlas.entry('Main Street', 11), null, 'not uploaded');
  const { gl, calls } = recordingGl(true);
  const renderer = new GlMapRenderer(gl);
  const instances = new Float32Array(LABEL_INSTANCE);
  // A frame with nothing to draw yet still takes the rasters in.
  const empty = renderer.render(frameOver(data), {
    labels: { atlas, instances, count: 0 },
  });
  assert.strictEqual(empty.labels, 0);
  assert.strictEqual(calls.filter((c) => c === 'texSubImage2D').length, 1);
  const entry = atlas.entry('Main Street', 11)!;
  assert.ok(entry, 'drawable once uploaded');
  instances.set([
    100,
    100,
    1,
    0,
    entry.x,
    entry.y,
    entry.width,
    entry.height,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    2,
    1,
  ]);
  calls.length = 0;
  const draws = () => calls.filter((c) => c === 'drawArraysInstanced').length;
  const plain = new GlMapRenderer(recordingGl(true).gl);
  const scene = plain.render(frameOver(data)).drawCalls;
  const stats = renderer.render(frameOver(data), {
    labels: { atlas, instances, count: 1 },
  });
  assert.strictEqual(stats.labels, 1);
  // Nothing new to upload, and the labels are one draw more than the scene.
  assert.ok(!calls.includes('texSubImage2D'));
  assert.strictEqual(stats.drawCalls, scene + 1);
  assert.ok(draws() > 0);
});

// --- more than one source ------------------------------------------------------

test('every source is drawn, in order, each whole before the next', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const other = buildTileBuckets(
    fixtureTile(),
    prepareStyle({ layers: STYLE }),
  );
  const frame = frameOver(data);
  const [first] = frame.sources[0];
  // A second pyramid over the first: another tile, at x 128.
  const two = {
    ...frame,
    sources: [
      [first],
      [
        {
          ...first,
          data: other,
          x: 128,
          clip: { x: 128, y: 0, width: 128, height: 256 },
        },
      ],
    ],
  };
  const { gl, log } = recordingGl(true);
  const stats = new GlMapRenderer(gl).render(two);
  const single = new GlMapRenderer(recordingGl(true).gl).render(frame);
  assert.strictEqual(stats.tiles, 2);
  assert.strictEqual(stats.uploads, 2);
  assert.strictEqual(stats.instances, single.instances * 2);
  // Every draw names its tile's origin in `u_tile`: all of the first
  // source's, then all of the second's — layer-major inside a source, and
  // one source over another the way the retained renderer lays them.
  const origins = log
    .filter((call) => call.name === 'uniform3f')
    .map((call) => call.args[2]);
  const turn = origins.indexOf(128);
  assert.ok(turn > 0, `the second source drew: ${origins.join(' ')}`);
  assert.ok(
    origins.slice(0, turn).every((x) => x === 0) &&
      origins.slice(turn).every((x) => x === 128),
    `interleaved: ${origins.join(' ')}`,
  );
});

// --- the tile store: failures and aborts ---------------------------------------

test('the GL store reports each failed load, retries on the backoff, and aborts what a frame stopped wanting', async () => {
  const errors: [unknown, unknown][] = [];
  const signals: ({ readonly aborted: boolean } | undefined)[] = [];
  let calls = 0;
  const source: MapSource = {
    id: 'flaky',
    load: ({ z, signal }) => {
      calls++;
      signals.push(signal);
      if (z === 3) throw new Error('down');
      // The other one never answers: it is in flight until aborted.
      return new Promise<never>(() => {});
    },
  };
  const store = new GlTileStore({
    source,
    prepared: prepareStyle({ layers: STYLE }),
    onChange: () => {},
    onError: (error, tile) => errors.push([error, tile]),
  });
  store.tick();
  store.want([
    { z: 3, x: 1, y: 1 },
    { z: 4, x: 0, y: 0 },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Reported once, named the way `onTileError` names a tile.
  assert.strictEqual(errors.length, 1);
  assert.strictEqual((errors[0][0] as Error).message, 'down');
  assert.deepStrictEqual(errors[0][1], { z: 3, x: 1, y: 1, sourceId: 'flaky' });
  assert.strictEqual(store.failedAmong([{ z: 3, x: 1, y: 1 }]), 1);
  // Asked for again at once, it is not asked of the source: the backoff.
  store.want([{ z: 3, x: 1, y: 1 }]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.strictEqual(calls, 2);
  // A frame that looks at the failed tile and not the one in flight lets
  // the second go: its load is aborted when the frame ends, and whatever it
  // answers after that is nobody's news.
  store.tick();
  store.get({ z: 3, x: 1, y: 1 });
  store.evict(() => {});
  assert.strictEqual(signals[1]?.aborted, true);
  assert.strictEqual(errors.length, 1);
  store.dispose(() => {});
});

// --- the renderer choice ------------------------------------------------------

test('the renderer decision: the environment, then the prop, then the connection, then the gate, then a failure', () => {
  const base = { shaders: true, blockers: [], failed: false };
  // Nothing said is 'auto': GL, on a connection with direct GL and a map
  // that uses nothing GL lacks.
  assert.deepStrictEqual(chooseRenderer(base), {
    renderer: 'gl',
    reason: null,
    asked: 'auto',
  });
  // A renderer asked for by name is what the map gets — GL with no direct
  // GL too, where it fails through `onError` rather than falling back.
  assert.strictEqual(
    chooseRenderer({ ...base, requested: 'gl', shaders: false }).renderer,
    'gl',
  );
  assert.strictEqual(
    chooseRenderer({ ...base, requested: 'gl', failed: true }).renderer,
    'gl',
  );
  assert.strictEqual(
    chooseRenderer({ ...base, requested: 'retained' }).renderer,
    'retained',
  );
  // 'auto': GL where there is direct GL and nothing is missing from it…
  assert.deepStrictEqual(chooseRenderer({ ...base, requested: 'auto' }), {
    renderer: 'gl',
    reason: null,
    asked: 'auto',
  });
  // …and the retained renderer everywhere else, with the reason.
  const auto = { ...base, requested: 'auto' as const };
  assert.deepStrictEqual(chooseRenderer({ ...auto, shaders: false }), {
    renderer: 'retained',
    reason: 'no-direct-gl',
    asked: 'auto',
  });
  assert.strictEqual(
    chooseRenderer({ ...auto, blockers: ['children'] }).reason,
    'capability',
  );
  assert.strictEqual(
    chooseRenderer({ ...auto, failed: true }).reason,
    'gl-failed',
  );
  // An answer still to come is waited for, not guessed at.
  assert.strictEqual(
    chooseRenderer({ ...auto, shaders: false, probing: true }).renderer,
    'pending',
  );
  // The environment over the prop, saying so only when it changed the
  // answer; anything that is not one of the three words is nobody's.
  assert.deepStrictEqual(
    chooseRenderer({ ...base, requested: 'gl', env: 'retained' }),
    { renderer: 'retained', reason: 'forced', asked: 'retained' },
  );
  assert.deepStrictEqual(
    chooseRenderer({ ...base, requested: 'retained', env: ' GL ' }),
    { renderer: 'gl', reason: 'forced', asked: 'gl' },
  );
  assert.strictEqual(
    chooseRenderer({ ...base, requested: 'gl', env: 'gl' }).reason,
    null,
  );
  assert.strictEqual(
    chooseRenderer({ ...base, requested: 'gl', env: 'vulkan' }).renderer,
    'gl',
  );
});

test('children keep an auto map off GL until core can draw over a GL surface', () => {
  assert.deepStrictEqual(capabilityBlockers({}), []);
  assert.deepStrictEqual(capabilityBlockers({ children: [null, false] }), []);
  const legend = React.createElement('box');
  assert.deepStrictEqual(capabilityBlockers({ children: legend }), [
    'children',
  ]);
  assert.deepStrictEqual(
    capabilityBlockers({ children: legend }, { glOverlay: true }),
    [],
  );
});

const kindOf = (node: unknown): string => (node as { kind: string }).kind;

/**
 * Say the harness's connection has direct GL.
 *
 * It has not — it is node-x11's in-process server, with no GLX at all — so
 * a map that believes it chooses GL under `'auto'` and meets a `<glarea>`
 * that can never get a surface: the run-time failure the fallback exists
 * for. The two fields are what `useSupports('shaders')` reads (react-x11
 * `src/glbackend.js`).
 */
function claimDirectGl(app: unknown): void {
  // `glPolicy` is a getter on ntk's app: an own property shadows it for
  // this one connection.
  Object.defineProperty(app, 'glPolicy', {
    value: { mode: 'auto' },
    configurable: true,
  });
  Object.defineProperty(app, '_glCapsResolved', {
    value: { direct: true },
    configurable: true,
    writable: true,
  });
}

test("an 'auto' map whose GL fails falls back to the retained renderer, with its camera and its handle", async () => {
  await loadGlRenderer();
  const changes: [string, string][] = [];
  const renderers: string[] = [];
  const ref = React.createRef<MapHandle>();
  const result = await renderX11(React.createElement('box'), {
    backend: 'xserver',
    width: 640,
    height: 480,
  });
  claimDirectGl(result.app);
  // …and a surface that is always about to arrive, so the failure is the
  // one forced below rather than the harness's own, which lands in the
  // commit that mounts the map — before anything could be done on GL.
  Object.defineProperty(result.app, 'chooseGLConfig', {
    value: () => new Promise(() => {}),
    configurable: true,
  });
  await result.rerender(
    React.createElement(MapView, {
      ref,
      renderer: 'auto',
      defaultCamera: { center: { lon: -0.1281, lat: 51.508 }, zoom: 12 },
      onRendererChange: (renderer, reason) => changes.push([renderer, reason]),
      onFrame: (stats) => renderers.push(stats.renderer),
      'data-testname': 'map',
    }),
  );
  const handle = ref.current as MapHandle;
  const pane = result.getByTestName('map');
  assert.strictEqual(kindOf(pane), 'mapglpane');
  assert.deepStrictEqual(changes, [], 'GL is what auto asked for');
  // Moved while GL has it.
  handle.panBy(120, -40);
  const moved = handle.getCamera();
  // Then a frame, on a GL whose programs will not link: the renderer cannot
  // be made, and that is a run-time failure like any other.
  const area = (
    pane as unknown as {
      children: { kind: string; props: Record<string, unknown> }[];
    }
  ).children.find((child) => child.kind === 'glarea');
  assert.ok(area, 'the surface is there');
  const { gl } = recordingGl(true);
  const unlinkable = new Proxy(gl as object, {
    get: (target, name) =>
      name === 'backend'
        ? 'direct'
        : name === 'getProgramParameter'
          ? () => false
          : (target as Record<string | symbol, unknown>)[name],
  });
  await act(async () => {
    (area.props.onDraw as (gl: unknown, info: object) => void)(unlinkable, {
      width: 640,
      height: 480,
      node: area,
    });
  });
  await waitFor(() => {
    assert.strictEqual(kindOf(result.getByTestName('map')), 'mapview');
  });
  assert.deepStrictEqual(changes, [['retained', 'gl-failed']], 'told once');
  assert.strictEqual(ref.current, handle, 'the same handle object');
  assert.deepStrictEqual(handle.getCamera(), moved, 'the same camera');
  await waitFor(() => {
    assert.ok(renderers.includes('retained'), 'drawn retained from then on');
  });
});

test("a 'gl' map whose GL fails says so through onError, and does not fall back", async () => {
  await loadGlRenderer();
  const errors: Error[] = [];
  const changes: unknown[] = [];
  const result = await renderX11(
    React.createElement(MapView, {
      renderer: 'gl',
      onError: (error) => errors.push(error),
      onRendererChange: (...args) => changes.push(args),
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 640, height: 480 },
  );
  await waitFor(() => {
    assert.strictEqual(errors.length, 1);
  });
  assert.strictEqual(kindOf(result.getByTestName('map')), 'mapglpane');
  assert.deepStrictEqual(changes, []);
});

test("an 'auto' map on a connection with no direct GL is drawn retained, and says why", async () => {
  const changes: [string, string][] = [];
  const result = await renderX11(
    React.createElement(MapView, {
      renderer: 'auto',
      onRendererChange: (renderer, reason) => changes.push([renderer, reason]),
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 640, height: 480 },
  );
  await act(async () => {});
  assert.strictEqual(kindOf(result.getByTestName('map')), 'mapview');
  assert.deepStrictEqual(changes, [['retained', 'no-direct-gl']]);
});

test('a map with children goes to GL under auto, on a core that draws over the surface', async () => {
  await loadGlRenderer();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  try {
    const changes: [string, string][] = [];
    const result = await renderX11(React.createElement('box'), {
      backend: 'xserver',
      width: 640,
      height: 480,
    });
    claimDirectGl(result.app);
    const map = () =>
      React.createElement(
        MapView,
        {
          renderer: 'auto',
          onRendererChange: (renderer, reason) =>
            changes.push([renderer, reason]),
          'data-testname': 'map',
        },
        React.createElement('box', {
          style: { position: 'absolute', left: 8, top: 8, width: 60 },
        }),
      );
    await result.rerender(map());
    await act(async () => {});
    // `children` used to hold an 'auto' map on the retained renderer: a
    // `<glarea>` was stacked over every 2D thing in its window, so a legend
    // laid over a GL map would have been hidden under it. react-x11#546
    // draws a surface's children above it, `useSupports('glOverlay')` says
    // so, and the map goes to GL with its legend. GL is what it *tried*:
    // 'gl-failed' is the one reason 'auto' gives only after choosing GL,
    // and the harness's server has no GLX to give it one.
    assert.strictEqual(kindOf(result.getByTestName('map')), 'mapview');
    assert.deepStrictEqual(changes, [['retained', 'gl-failed']]);
    await result.rerender(map());
    await act(async () => {});
    // …and nothing blamed the prop. (`capabilityBlockers` still answers for
    // a connection that cannot overlay — see the test above that asks it
    // directly.)
    const named = warnings.filter((w) => w.includes('`children`'));
    assert.strictEqual(named.length, 0, warnings.join('\n'));
  } finally {
    console.warn = warn;
  }
});

test("an 'auto' map falls back the same way when its surface cannot come up at all", async () => {
  await loadGlRenderer();
  const changes: [string, string][] = [];
  const result = await renderX11(React.createElement('box'), {
    backend: 'xserver',
    width: 640,
    height: 480,
  });
  claimDirectGl(result.app);
  // The harness's own `<glarea>`, which has no GLX to get a surface from
  // and says so through `onError`.
  await result.rerender(
    React.createElement(MapView, {
      renderer: 'auto',
      onRendererChange: (renderer, reason) => changes.push([renderer, reason]),
      'data-testname': 'map',
    }),
  );
  await waitFor(() => {
    assert.strictEqual(kindOf(result.getByTestName('map')), 'mapview');
  });
  assert.deepStrictEqual(changes, [['retained', 'gl-failed']]);
});

// --- attribution -----------------------------------------------------------------

test('the attribution is the prop, or each source’s own once, and an empty string is none', () => {
  const osm: MapSource = {
    load: () => null,
    attribution: '© OpenStreetMap contributors',
  };
  const esa: MapSource = { load: () => null, attribution: '© ESA WorldCover' };
  assert.strictEqual(
    attributionOf(undefined, [osm, esa, osm]),
    '© OpenStreetMap contributors · © ESA WorldCover',
  );
  assert.strictEqual(attributionOf('Data: mine', [osm]), 'Data: mine');
  assert.strictEqual(attributionOf('', [osm]), '');
  assert.strictEqual(attributionOf(undefined, [{ load: () => null }]), '');
});

test('the attribution sits where the retained renderer puts it, on whole pixels', () => {
  // 4 logical pixels of padding either side of the text and 2 above and
  // below it, in the pane's bottom-right corner: a 50×10 text in a 640×480
  // pane at scale 2.
  const at = attributionLayout(
    { width: 50, height: 10 },
    { x: 0, y: 0, width: 640, height: 480 },
    2,
  );
  assert.deepStrictEqual(at.box, { x: 1164, y: 932, width: 116, height: 28 });
  assert.deepStrictEqual([at.x, at.y], [1172, 936]);
  // A pane off the window's origin takes its attribution with it — the
  // retained renderer's case; the GL pane is its own origin — and a
  // fractional text box at a fractional scale still lands on whole pixels.
  const off = attributionLayout(
    { width: 50.3, height: 10.6 },
    { x: 100, y: 40, width: 640, height: 480 },
    1.5,
  );
  assert.deepStrictEqual(off.box, { x: 1023, y: 758, width: 88, height: 22 });
  assert.deepStrictEqual([off.x, off.y], [1029, 761]);
});

test('over the scene: the labels, the markers in one draw, then the attribution — its box, then its text', async () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const atlas = instantAtlas();
  atlas.beginFrame(Infinity);
  atlas.entry('Main Street', 11);
  atlas.entry('© OSM', 9);
  atlas.pump();
  await new Promise((resolve) => setImmediate(resolve));
  const { gl, calls, log } = recordingGl(true);
  const renderer = new GlMapRenderer(gl);
  // A frame with nothing to draw takes the rasters into the texture.
  renderer.render(frameOver(data), {
    labels: { atlas, instances: new Float32Array(LABEL_INSTANCE), count: 0 },
  });
  const label = atlas.entry('Main Street', 11)!;
  const text = atlas.entry('© OSM', 9)!;
  assert.ok(label && text, 'both rasters are in the texture');
  const quad = (
    entry: { x: number; y: number; width: number; height: number },
    cx: number,
    cy: number,
  ) =>
    Float32Array.of(
      ...[cx, cy, 1, 0, entry.x, entry.y, entry.width, entry.height],
      ...[0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    );
  // Three markers, one of them a disc, all in view.
  const pane = { width: 256, height: 256 };
  const markers = new MarkerBatcher().batch(
    [
      { id: 'a', position: { lon: 0, lat: 0 } },
      { id: 'b', position: { lon: 10, lat: 10 } },
      { id: 'c', position: { lon: -10, lat: -10 }, shape: 'circle' },
    ],
    transformFor({ center: { lon: 0, lat: 0 }, zoom: 3 }, pane, 512),
    pane,
    1,
    { accent: '#2d6cdf', background: '#ffffff', text: '#111111' },
  );
  assert.strictEqual(markers.count, 3);
  calls.length = 0;
  log.length = 0;
  const stats = renderer.render(frameOver(data), {
    labels: { atlas, instances: quad(label, 100, 100), count: 1 },
    markers,
    attribution: {
      box: { x: 200, y: 240, width: 56, height: 16 },
      boxColor: [0.72, 0.72, 0.72, 0.72],
      text: { atlas, instances: quad(text, 228, 248), count: 1 },
    },
  });
  // The frame's last four draws: the labels; the markers, all three in
  // one; the attribution's box; and its text — the retained renderer's
  // order.
  const drawsOf = () =>
    log.filter(
      (c) => c.name === 'drawArraysInstanced' || c.name === 'drawArrays',
    );
  const draws = drawsOf();
  assert.deepStrictEqual(
    draws.slice(-4).map((c) => c.name),
    [
      'drawArraysInstanced',
      'drawArraysInstanced',
      'drawArrays',
      'drawArraysInstanced',
    ],
  );
  assert.strictEqual(draws[draws.length - 3].args[3], 3);
  assert.strictEqual(stats.markers, 3);
  // The box is the cover program scissored to it: bottom-left origin.
  const scissors = log.filter((c) => c.name === 'scissor').map((c) => c.args);
  assert.deepStrictEqual(scissors[scissors.length - 1], [200, 0, 56, 16]);
  assert.strictEqual(stats.labels, 1, 'the attribution is not a label');
  // No attribution: the markers are the last thing drawn.
  log.length = 0;
  renderer.render(frameOver(data), {
    labels: { atlas, instances: quad(label, 100, 100), count: 1 },
    markers,
  });
  const plain = drawsOf();
  assert.strictEqual(plain.length, draws.length - 2);
  assert.strictEqual(plain[plain.length - 1].args[3], 3);
});

// --- markers -----------------------------------------------------------------------

const PALETTE = { accent: '#ff0000', background: '#ffffff', text: '#000000' };
const ORIGIN = { lon: 0, lat: 0 };

test('markers are drawn by zIndex, a selected one over its peers, and hit from the top', () => {
  const m = (id: string, extra: Partial<MapMarker> = {}): MapMarker => ({
    id,
    position: ORIGIN,
    ...extra,
  });
  assert.deepStrictEqual(
    markerOrder([
      m('a'),
      m('b', { selected: true }),
      m('c'),
      m('d', { zIndex: -1, selected: true }),
      m('e', { zIndex: 1 }),
    ]).map((marker) => marker.id),
    ['d', 'a', 'c', 'b', 'e'],
  );
  // All on one point: a press lands on the one drawn on top.
  const transform = transformFor(
    { center: ORIGIN, zoom: 10 },
    { width: 200, height: 200 },
    512,
  );
  const hit = (markers: MapMarker[]) =>
    markerAt(markers, transform, 100, 95)?.id;
  assert.strictEqual(hit([m('a'), m('b', { selected: true }), m('c')]), 'b');
  assert.strictEqual(
    hit([m('a'), m('b', { selected: true }), m('c', { zIndex: 1 })]),
    'c',
  );
  assert.strictEqual(hit([m('a'), m('b')]), 'b');
});

test('a pin’s straight sides meet its head where they are tangent to it', () => {
  const calls: { name: string; args: number[] }[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, name: string) =>
      name in target
        ? target[name]
        : (...args: number[]) => {
            calls.push({ name, args });
          },
    set: (target, name: string, value) => {
      target[name] = value;
      return true;
    },
  });
  const transform = transformFor(
    { center: ORIGIN, zoom: 10 },
    { width: 200, height: 200 },
    512,
  );
  drawMarkers(
    ctx as never,
    [{ id: 'pin', position: ORIGIN, size: 20 }],
    transform,
    { x: 0, y: 0, width: 200, height: 200 },
    2,
    PALETTE,
  );
  const [cx, cy, r, start, end] = calls.find((c) => c.name === 'arc')!.args;
  const [tx, ty] = calls.find((c) => c.name === 'lineTo')!.args;
  assert.deepStrictEqual([tx, ty], [200, 200], 'the tip is the position');
  for (const angle of [start, end]) {
    // Where a side leaves the head, the radius is at right angles to it.
    const px = cx + r * Math.cos(angle);
    const py = cy + r * Math.sin(angle);
    const dot = (px - cx) * (tx - px) + (py - cy) * (ty - py);
    assert.ok(Math.abs(dot) < 1e-6, `not tangent at ${angle}: ${dot}`);
  }
});

test('markers become an instance each — the point, the head, the paint — bottom first, and only those in view', () => {
  const pane = { width: 200, height: 100 };
  const batch = new MarkerBatcher().batch(
    [
      { id: 'sel', position: ORIGIN, selected: true },
      {
        id: 'dot',
        position: ORIGIN,
        shape: 'circle',
        size: 10,
        color: '#00ff00',
        outline: '#0000ff',
      },
      { id: 'far', position: { lon: 90, lat: 0 } },
    ],
    transformFor({ center: ORIGIN, zoom: 10 }, pane, 512),
    pane,
    2,
    PALETTE,
  );
  assert.strictEqual(batch.count, 2, 'the one off the pane is left out');
  const instance = (i: number) =>
    Array.from(
      batch.instances.subarray(i * MARKER_INSTANCE, (i + 1) * MARKER_INSTANCE),
    );
  // The selected pin is drawn over the disc.
  const [dot, sel] = [instance(0), instance(1)];
  // A disc: its centre in device pixels, its radius, no height; its own
  // fill and ring, the ring 1.5 logical pixels wide.
  assert.deepStrictEqual(dot.slice(0, 4), [200, 100, 10, 0]);
  assert.deepStrictEqual(dot.slice(4, 12), [0, 1, 0, 1, 0, 0, 1, 1]);
  assert.strictEqual(dot[12], 3);
  // A pin: its tip, a 14-pixel head at scale 2 whose centre is
  // 1.4 × 14 − 7 = 12.6 logical pixels above the tip; the theme's accent,
  // and the selected ring, 2.5 logical pixels of the theme's text colour.
  assert.deepStrictEqual(sel.slice(0, 3), [200, 100, 14]);
  assert.ok(Math.abs(sel[3] - 25.2) < 1e-4);
  assert.deepStrictEqual(sel.slice(4, 12), [1, 0, 0, 1, 0, 0, 0, 1]);
  assert.strictEqual(sel[12], 5);
});

test('a GL frame draws the markers in one draw, each where the hit test finds it', async () => {
  await loadGlRenderer();
  const ref = React.createRef<MapHandle>();
  const renderers: string[] = [];
  const result = await renderX11(React.createElement('box'), {
    backend: 'xserver',
    width: 640,
    height: 480,
  });
  // A surface always about to arrive, so the frame below is the only one.
  Object.defineProperty(result.app, 'chooseGLConfig', {
    value: () => new Promise(() => {}),
    configurable: true,
  });
  const markers: MapMarker[] = [
    { id: 'a', position: { lon: -0.1281, lat: 51.508 } },
    { id: 'b', position: { lon: -0.12, lat: 51.51 }, selected: true },
    { id: 'c', position: { lon: -0.14, lat: 51.5 }, shape: 'circle' },
    { id: 'gone', position: { lon: 100, lat: 0 } },
  ];
  await result.rerender(
    React.createElement(MapView, {
      ref,
      renderer: 'gl',
      markers,
      defaultCamera: { center: { lon: -0.1281, lat: 51.508 }, zoom: 12 },
      onFrame: (stats) => renderers.push(stats.renderer),
      'data-testname': 'map',
    }),
  );
  const pane = result.getByTestName('map') as unknown as {
    abs: { width: number; height: number };
    children: { kind: string; props: Record<string, unknown> }[];
  };
  const area = pane.children.find((child) => child.kind === 'glarea')!;
  const { gl, log } = recordingGl(true);
  (gl as Record<string, unknown>).backend = 'direct';
  await act(async () => {
    (area.props.onDraw as (gl: unknown, info: object) => void)(gl, {
      width: pane.abs.width,
      height: pane.abs.height,
      node: area,
    });
  });
  const draws = log.filter((c) => c.name === 'drawArraysInstanced');
  assert.strictEqual(draws.at(-1)?.args[3], 3, 'the three in view, at once');
  // What that draw read: bottom first, the selected one last, each tip
  // where the handle projects its position.
  const uploads = log.filter(
    (c) => c.name === 'bufferData' && c.args[1] instanceof Float32Array,
  );
  const instances = uploads.at(-1)!.args[1] as Float32Array;
  const handle = ref.current as MapHandle;
  ['a', 'c', 'b'].forEach((id, i) => {
    const at = handle.project(markers.find((m) => m.id === id)!.position);
    const tip = instances.subarray(
      i * MARKER_INSTANCE,
      i * MARKER_INSTANCE + 2,
    );
    assert.ok(Math.abs(tip[0] - at.x) < 1e-3, `${id}: ${tip[0]} vs ${at.x}`);
    assert.ok(Math.abs(tip[1] - at.y) < 1e-3, `${id}: ${tip[1]} vs ${at.y}`);
  });
  assert.strictEqual(renderers.at(-1), 'gl');
});

// --- overlays ----------------------------------------------------------------------

/** A 2D context that records every call it is given. */
function recordingCanvas(calls: { name: string; args: number[] }[]) {
  return new Proxy({} as Record<string, unknown>, {
    get: (target, name: string) =>
      name in target
        ? target[name]
        : (...args: number[]) => {
            calls.push({ name, args });
          },
    set: (target, name: string, value) => {
      target[name] = value;
      return true;
    },
  });
}

/** A stream's records as the vertex shader places them, a list of points
 *  per polyline or ring. */
function placedPaths(
  buffer: ArrayBuffer,
  at: { unit: number; x: number; y: number },
): [number, number][][] {
  const i16 = new Int16Array(buffer);
  const out: [number, number][][] = [];
  let path: [number, number][] = [];
  for (let r = 0; r < i16.length / 4; r++) {
    if (i16[r * 4] === BREAK) {
      if (path.length > 0) out.push(path);
      path = [];
      continue;
    }
    path.push([i16[r * 4] * at.unit + at.x, i16[r * 4 + 1] * at.unit + at.y]);
  }
  return out;
}

test('an overlay holds still at zoom 22: rebased in float64, never a world position in float32', () => {
  const pane = { width: 800, height: 600 };
  const scale = 2;
  const width = pane.width * scale;
  const world = 512 * 2 ** 22 * scale;
  const ground = { lon: 151.2093, lat: -33.8688 };
  const far = { lon: 151.20931, lat: -33.8688 };
  const m = project(ground);
  // A camera `dx` device pixels east of the ground point.
  const camera = (dx: number) => ({
    center: unproject({ x: m.x + dx / world, y: m.y }),
    zoom: 22,
  });
  const region = overlayRegion(camera(0), pane, scale);
  const bucket = buildOverlayBucket(
    [{ kind: 'line', id: 'l', path: [ground, far] }],
    region,
    PALETTE,
  );
  // The far end's record, about sixty logical pixels east.
  const rx = new Int16Array(bucket.data.line)[4];
  const f = Math.fround;
  let naiveWorst = 0;
  for (let step = 0; step <= 16; step++) {
    const dx = step / 16;
    const centre = project(camera(dx).center);
    const exact = width / 2 + (project(far).x - centre.x) * world;
    // The vertex shader's arithmetic, in float32: the record times the
    // unit, plus the region's origin — both worked out from the camera.
    const at = regionPlacement(
      region,
      camera(dx),
      width,
      pane.height * scale,
      scale,
    );
    const gpu = f(f(rx * f(at.unit)) + f(at.x));
    assert.ok(Math.abs(gpu - exact) < 0.07, `at ${dx}: ${gpu} vs ${exact}`);
    // What the vertex would be as a world position in float32, less the
    // camera's: the jitter the rebase is for.
    const naive =
      f(f(project(far).x * world) - f(centre.x * world)) + width / 2;
    naiveWorst = Math.max(naiveWorst, Math.abs(naive - exact));
  }
  assert.ok(naiveWorst > 1, `a float32 world position is ${naiveWorst} px off`);
});

test('an overlay is the same geometry on both renderers', () => {
  const pane = { x: 0, y: 0, width: 400, height: 300 };
  const camera = { center: { lon: -0.1281, lat: 51.508 }, zoom: 15 };
  const transform = transformFor(camera, pane, 512);
  const at = (x: number, y: number): [number, number] => {
    const p = unprojectPoint(transform, 200 + x, 150 + y);
    return [p.lon, p.lat];
  };
  const { overlays } = geoJsonOverlays({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            at(-150, -90),
            at(-20, -60.5),
            at(40.25, 30),
            at(160, 110),
          ],
        },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              at(-120, 20),
              at(-20, 30),
              at(-40, 120),
              at(-130, 100),
              at(-120, 20),
            ],
            [at(-90, 50), at(-60, 60), at(-80, 90), at(-90, 50)],
          ],
        },
      },
    ],
  });
  // The retained renderer's points: each subpath it strokes or fills.
  const calls: { name: string; args: number[] }[] = [];
  drawOverlays(
    recordingCanvas(calls) as never,
    overlays,
    transform,
    pane,
    1,
    PALETTE,
  );
  const retained: [number, number][][] = [];
  for (const { name, args } of calls) {
    if (name === 'moveTo') retained.push([[args[0], args[1]]]);
    else if (name === 'lineTo') retained.at(-1)!.push([args[0], args[1]]);
  }
  // The GL renderer's: every record, where the vertex shader puts it.
  const region = overlayRegion(camera, pane, 1);
  const bucket = buildOverlayBucket(overlays, region, PALETTE);
  const placed = regionPlacement(region, camera, 400, 300, 1);
  const gl = [
    ...placedPaths(bucket.data.line, placed),
    ...placedPaths(bucket.data.fill, placed),
  ];
  assert.strictEqual(retained.length, 3, 'a line, a ring and its hole');
  assert.strictEqual(gl.length, 3);
  retained.forEach((path, i) => {
    // A ring's record list ends with its first point again, closing it.
    const drawn = gl[i].slice(0, path.length);
    assert.strictEqual(drawn.length, path.length);
    path.forEach(([x, y], j) => {
      assert.ok(
        Math.abs(drawn[j][0] - x) < 0.05 && Math.abs(drawn[j][1] - y) < 0.05,
        `path ${i} point ${j}: ${drawn[j]} vs ${[x, y]}`,
      );
    });
  });
});

test('overlays draw in zIndex order — a casing under its line, a fill under its outline', () => {
  const region = overlayRegion(
    { center: ORIGIN, zoom: 10 },
    { width: 400, height: 300 },
    1,
  );
  const near = (x: number, y: number) => ({ lon: x * 0.01, lat: y * 0.01 });
  const bucket = buildOverlayBucket(
    [
      {
        kind: 'polygon',
        id: 'area',
        rings: [[near(0, 0), near(1, 0), near(1, 1), near(0, 0)]],
        outline: '#000000',
        zIndex: 2,
      },
      {
        kind: 'line',
        id: 'route',
        path: [near(0, 0), near(2, 1)],
        casing: '#ffffff',
        color: '#0000ff',
        width: 4,
      },
      {
        kind: 'circle',
        id: 'gone',
        center: ORIGIN,
        radiusMetres: 500,
        opacity: 0,
      },
      {
        kind: 'circle',
        id: 'ring',
        center: ORIGIN,
        radiusMetres: 500,
        zIndex: 1,
      },
    ],
    region,
    PALETTE,
  );
  assert.deepStrictEqual(
    bucket.passes.map((p) => [p.index, p.kind, p.color, p.width]),
    [
      [0, 'stroke', '#ffffff', 6],
      [0, 'stroke', '#0000ff', 4],
      [1, 'fill', '#ff0000', 0],
      [2, 'fill', '#ff0000', 0],
      [2, 'stroke', '#000000', 1],
    ],
  );
  assert.strictEqual(bucket.data.draws.length, 3, 'the invisible one has none');
});

test('a translucent stroke is drawn each pixel once: its whole pixels, then its fringe, under the stencil', () => {
  const data = buildTileBuckets(fixtureTile(), prepareStyle({ layers: STYLE }));
  const camera = { center: ORIGIN, zoom: 10 };
  const region = overlayRegion(camera, { width: 256, height: 256 }, 1);
  const placed = regionPlacement(region, camera, 256, 256, 1);
  const drawsWith = (opacity: number | null) => {
    const { gl, log } = recordingGl(true);
    const renderer = new GlMapRenderer(gl);
    const bucket = buildOverlayBucket(
      [
        {
          kind: 'line',
          id: 'l',
          path: [
            { lon: -0.1, lat: 0 },
            { lon: 0.05, lat: 0.05 },
            { lon: 0.1, lat: 0 },
          ],
          opacity: opacity ?? 1,
        },
      ],
      region,
      PALETTE,
    );
    const stats = renderer.render(frameOver(data), {
      overlays:
        opacity === null
          ? null
          : { data: bucket.data, passes: bucket.passes, ...placed },
    });
    const count = (name: string) => log.filter((c) => c.name === name).length;
    return {
      instanced: count('drawArraysInstanced'),
      covers: count('drawArrays'),
      passes: stats.overlays,
    };
  };
  const none = drawsWith(null);
  const opaque = drawsWith(1);
  const translucent = drawsWith(0.5);
  assert.strictEqual(opaque.passes, 1);
  assert.strictEqual(opaque.instanced - none.instanced, 1, 'one draw');
  assert.strictEqual(opaque.covers, none.covers);
  // The whole pixels, then the fringe; then the stencil cleared again.
  assert.strictEqual(translucent.instanced - none.instanced, 2);
  assert.strictEqual(translucent.covers - none.covers, 1);
});

test('the overlays are one bucket, built again when the array changes or the view leaves its region', async () => {
  await loadGlRenderer();
  const ref = React.createRef<MapHandle>();
  const result = await renderX11(React.createElement('box'), {
    backend: 'xserver',
    width: 640,
    height: 480,
  });
  Object.defineProperty(result.app, 'chooseGLConfig', {
    value: () => new Promise(() => {}),
    configurable: true,
  });
  const route = (): MapOverlay[] => [
    {
      kind: 'line',
      id: 'route',
      path: [
        { lon: -0.13, lat: 51.507 },
        { lon: -0.12, lat: 51.51 },
      ],
    },
  ];
  const mount = (overlays: MapOverlay[]) =>
    result.rerender(
      React.createElement(MapView, {
        ref,
        renderer: 'gl',
        overlays,
        defaultCamera: { center: { lon: -0.1281, lat: 51.508 }, zoom: 14 },
        'data-testname': 'map',
      }),
    );
  await mount(route());
  const pane = result.getByTestName('map') as unknown as {
    abs: { width: number; height: number };
    children: { kind: string; props: Record<string, unknown> }[];
  };
  const area = pane.children.find((child) => child.kind === 'glarea')!;
  const { gl, log } = recordingGl(true);
  (gl as Record<string, unknown>).backend = 'direct';
  // Uploads of geometry: with no sources on the map, the overlays' alone.
  const uploads = () =>
    log.filter(
      (c) => c.name === 'bufferData' && c.args[1] instanceof Uint8Array,
    ).length;
  const frame = () =>
    act(async () => {
      (area.props.onDraw as (gl: unknown, info: object) => void)(gl, {
        width: pane.abs.width,
        height: pane.abs.height,
        node: area,
      });
    });
  await frame();
  assert.strictEqual(uploads(), 1, 'built and uploaded');
  await frame();
  const handle = ref.current as MapHandle;
  handle.panBy(80, -40);
  await frame();
  assert.strictEqual(uploads(), 1, 'the same bucket, placed again');
  await mount(route());
  await frame();
  assert.strictEqual(uploads(), 2, 'a new array is a new bucket');
  handle.zoomTo(16.5);
  await frame();
  assert.strictEqual(uploads(), 3, 'two levels in, built again');
  assert.ok(
    log.some((c) => c.name === 'deleteBuffer'),
    'the old ones let go',
  );
});

// --- circle layers and raster tiles -------------------------------------------------

/** A layer of points at extent 4096: a multipoint, then one point. */
function pointTile(points: [number, number][]) {
  const multi = [...command(1, points.length)];
  let x = 0;
  let y = 0;
  for (const [px, py] of points) {
    multi.push(zigzag(px - x), zigzag(py - y));
    x = px;
    y = py;
  }
  const one = [...command(1, 1), zigzag(3000), zigzag(3000)];
  return parseTile(
    new Uint8Array(
      layer(
        'pois',
        4096,
        [],
        [],
        [
          { type: GeomType.Point, tags: [], geometry: multi },
          { type: GeomType.Point, tags: [], geometry: one },
        ],
      ),
    ),
  );
}

const CIRCLES: MapStyleLayer[] = [
  {
    id: 'pois',
    type: 'circle',
    sourceLayer: 'pois',
    radius: 4,
    color: '#ff0000',
    strokeColor: '#ffffff',
    strokeWidth: 1,
  },
];

test('a circle layer is its points, a record each, drawn as a disc each in one draw', () => {
  const data = buildTileBuckets(
    pointTile([
      [100, 200],
      [400, 800],
    ]),
    prepareStyle({ layers: CIRCLES }),
  );
  const draw = data.draws[0]!;
  assert.strictEqual(draw.kind, 'circle');
  // Three points and the sentinel after them: three instances.
  assert.deepStrictEqual(draw.ranges, [0, 4]);
  const i16 = new Int16Array(data.line);
  assert.deepStrictEqual(
    [i16[0], i16[1], i16[4], i16[5], i16[8], i16[9], i16[12]],
    [100, 200, 400, 800, 3000, 3000, BREAK],
  );
  const { gl, log } = recordingGl(true);
  const stats = new GlMapRenderer(gl).render(frameOver(data, CIRCLES));
  const draws = log.filter((c) => c.name === 'drawArraysInstanced');
  assert.deepStrictEqual(
    draws.map((c) => c.args[3]),
    [3],
    'three discs, one draw',
  );
  assert.strictEqual(stats.layers, 1);
});

test('a raster tile is kept as its image, with nothing to build', async () => {
  const pixels = new Uint8Array(4 * 4 * 4).fill(255);
  const source: MapSource = {
    id: 'image',
    minZoom: 0,
    maxZoom: 3,
    tileSize: 256,
    load: () => ({ kind: 'raster', width: 4, height: 4, data: pixels }),
  };
  let changes = 0;
  const store = new GlTileStore({
    source,
    prepared: prepareStyle({ layers: STYLE }),
    onChange: () => changes++,
  });
  store.tick();
  store.want([{ z: 1, x: 0, y: 0 }]);
  await new Promise((resolve) => setImmediate(resolve));
  const data = store.get({ z: 1, x: 0, y: 0 });
  assert.strictEqual(data?.raster?.pixels, pixels);
  assert.strictEqual(store.building, 0, 'nothing waits for a build');
  assert.ok(changes > 0, 'and a frame was asked for');
  // A restyle has nothing to rebuild in it.
  store.rebuild();
  assert.strictEqual(store.building, 0);
  assert.strictEqual(store.get({ z: 1, x: 0, y: 0 }), data);
});

test('past a raster source’s depth its tile is drawn whole over its own square', () => {
  const image = rasterTileData(4, 4, new Uint8Array(64));
  const cover = renderCover(
    { center: { lon: 10, lat: 20 }, zoom: 7 },
    { width: 800, height: 600 },
    2,
    { minZoom: 0, maxZoom: 3, tileSize: 256 },
    { get: () => image },
  );
  assert.strictEqual(cover.level, 3);
  assert.ok(cover.tiles.length > 0);
  // Level 3 at zoom 7, on the 512-pixel world, at scale 2.
  const size = 512 * 2 ** (7 - 3) * 2;
  for (const tile of cover.tiles) {
    assert.strictEqual(tile.size, size);
    assert.deepStrictEqual(tile.clip, {
      x: tile.x,
      y: tile.y,
      width: size,
      height: size,
    });
  }
});

test('raster tiles are textures: uploaded once, a quad each, let go with their tile', () => {
  const image = rasterTileData(2, 2, new Uint8Array(16).fill(200));
  const { gl, log } = recordingGl(true);
  const renderer = new GlMapRenderer(gl);
  const square = (x: number) => ({
    data: image,
    x,
    y: 0,
    size: 128,
    clip: { x, y: 0, width: 128, height: 128 },
  });
  const frame = { ...frameOver(image), sources: [[square(0), square(128)]] };
  renderer.render(frame);
  const count = (name: string) => log.filter((c) => c.name === name).length;
  assert.strictEqual(count('texImage2D'), 1, 'one image, one upload');
  log.length = 0;
  const stats = renderer.render(frame);
  assert.strictEqual(count('texImage2D'), 0, 'already there');
  assert.strictEqual(count('drawArrays'), 2, 'a quad each');
  assert.strictEqual(count('drawArraysInstanced'), 0, 'and no style');
  assert.strictEqual(stats.tiles, 2);
  renderer.release(image);
  assert.strictEqual(count('deleteTexture'), 1);
});

// --- dashes ---------------------------------------------------------------------------

test('a dash array is read as a canvas reads one: odd ones repeated, bad ones solid, four dashes at most', () => {
  assert.deepStrictEqual(dashPattern([4, 2], 2), [8, 4]);
  assert.deepStrictEqual(dashPattern([4, 2, 1], 1), [4, 2, 1, 4, 2, 1]);
  assert.strictEqual(dashPattern([4, -1], 1), null);
  assert.strictEqual(dashPattern([4, Number.NaN], 1), null);
  assert.strictEqual(dashPattern([0, 0], 1), null);
  assert.strictEqual(dashPattern([], 1), null);
  assert.strictEqual(dashPattern(undefined, 1), null);
  assert.deepStrictEqual(
    dashPattern([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test('a line layer’s whole dash pattern reaches the line program', () => {
  const dashed: MapStyleLayer[] = [
    {
      id: 'rail',
      type: 'line',
      sourceLayer: 'streets',
      color: '#333333',
      width: 2,
      dash: [4, 2, 1],
    },
  ];
  const data = buildTileBuckets(
    fixtureTile(),
    prepareStyle({ layers: dashed }),
  );
  const { gl, log } = recordingGl(true);
  new GlMapRenderer(gl).render({ ...frameOver(data, dashed), scale: 2 });
  const fours = log
    .filter((c) => c.name === 'uniform4f')
    .map((c) => c.args.slice(1).join());
  // [4, 2, 1] is [4, 2, 1, 4, 2, 1], in device pixels at scale 2.
  assert.ok(fours.includes('8,4,2,8'), fours.join(' | '));
  assert.ok(fours.includes('4,2,0,0'), fours.join(' | '));
  const ones = log.filter((c) => c.name === 'uniform1f').map((c) => c.args[1]);
  assert.ok(ones.includes(28), 'and the pattern is 28 pixels long');
});
