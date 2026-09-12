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

import { act, fireEvent, renderX11, userEvent } from 'react-x11/test';

import { GeomType, parseTile } from '../src/maps/mvt.js';
import { transformFor, unprojectPoint } from '../src/maps/proj.js';
import { GlMap, QUALITY_LADDER, chooseQuality } from '../src/maps/gl/view.js';
import type { GlMapHandle } from '../src/maps/gl/view.js';
import { prepareStyle } from '../src/maps/paint.js';
import type { MapStyleLayer } from '../src/maps/style.js';
import type { MapSource } from '../src/maps/sources.js';
import {
  BREAK,
  RECORD_BYTES,
  TILE_EXTENT,
  buildTileBuckets,
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
} from '../src/maps/gl/labels.js';
import type { GlLabelData } from '../src/maps/gl/labels.js';
import {
  FADE_MS,
  LABEL_INSTANCE,
  LabelPlacer,
} from '../src/maps/gl/placement.js';
import type { PlacementFrame } from '../src/maps/gl/placement.js';
import { GlMapRenderer, scissorOf } from '../src/maps/gl/renderer.js';
import { GlTileStore } from '../src/maps/gl/store.js';
import { LabelAtlas } from '../src/maps/gl/text.js';
import type { TextEngine } from '../src/maps/gl/text.js';

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
    tiles: [
      {
        data,
        x: 0,
        y: 0,
        size: 256,
        clip: { x: 0, y: 0, width: 256, height: 256 },
      },
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
    frame: frameOver(data),
    alpha: 0.4,
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
    frame: frameOver(data),
    alpha: 0,
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
  const ref = React.createRef<GlMapHandle>();
  const result = await renderX11(
    React.createElement(
      'window',
      { width: 640, height: 480 },
      React.createElement(GlMap, {
        ref,
        sources: [],
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
  return { handle: ref.current as GlMapHandle, node };
}

/** Pane-local logical pixels to the ground, for a camera over a pane. */
function groundAt(
  handle: GlMapHandle,
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
  const empty = renderer.render(frameOver(data), null, {
    atlas,
    instances,
    count: 0,
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
  const stats = renderer.render(frameOver(data), null, {
    atlas,
    instances,
    count: 1,
  });
  assert.strictEqual(stats.labels, 1);
  // Nothing new to upload, and the labels are one draw more than the scene.
  assert.ok(!calls.includes('texSubImage2D'));
  assert.strictEqual(stats.drawCalls, scene + 1);
  assert.ok(draws() > 0);
});
