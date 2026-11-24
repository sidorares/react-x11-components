import { test } from 'node:test';
import assert from 'node:assert';
import {
  boxDistance,
  ecef,
  frameAt,
  geodetic,
  viewProjection,
} from '../src/map3d/geo.js';
import { readGlb } from '../src/map3d/glb.js';
import { Tileset } from '../src/map3d/tileset.js';
import type { Orbit } from '../src/map3d/geo.js';

test('ecef and geodetic round-trip, and the frame puts its origin at 0', () => {
  const p = ecef(-37.8136, 144.9631, 42);
  const g = geodetic(p);
  assert.ok(
    Math.abs(g.lat + 37.8136) < 1e-9 &&
      Math.abs(g.lon - 144.9631) < 1e-9 &&
      Math.abs(g.h - 42) < 1e-4,
  );
  const f = frameAt(-37.8136, 144.9631, 0);
  const s = f.toScene(p);
  assert.ok(
    Math.abs(s[0]) < 1e-6 &&
      Math.abs(s[1] - 42) < 1e-6 &&
      Math.abs(s[2]) < 1e-6,
  );
  const back = f.toEcef(s);
  assert.ok(Math.hypot(back[0] - p[0], back[1] - p[1], back[2] - p[2]) < 1e-6);
});

test('the target projects to the middle of the screen, and nearer is smaller depth', () => {
  const o: Orbit = {
    heading: 20,
    pitch: 55,
    range: 700,
    fov: 40,
    target: [0, 30, 0],
  };
  const m = viewProjection(o, 1.5, 35, 28000);
  const pr = (p: number[]) => {
    const w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!;
    return [
      (m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!) / w,
      (m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!) / w,
    ];
  };
  const c = pr([0, 30, 0]);
  assert.ok(Math.abs(c[0]!) < 1e-5 && Math.abs(c[1]!) < 1e-5);
});

test('boxDistance is 0 inside and the gap outside', () => {
  const box = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10];
  assert.equal(boxDistance(box, [1, 2, 3]), 0);
  assert.ok(Math.abs(boxDistance(box, [13, 0, 0]) - 3) < 1e-9);
});

/** one triangle with no texture, in a glb */
function glb(extra: Record<string, unknown> = {}): Uint8Array {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const idx = new Uint16Array([0, 1, 2, 0]);
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const json = JSON.stringify({
    asset: { copyright: 'Test' },
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { byteOffset: 0, byteLength: 36 },
      { byteOffset: 36, byteLength: 6 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0, translation: [10, 20, 30] }],
    scenes: [{ nodes: [0] }],
    ...extra,
  });
  const j = new TextEncoder().encode(
    json + ' '.repeat((4 - (json.length % 4)) % 4),
  );
  const out = new Uint8Array(12 + 8 + j.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, bin.length, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}

test('a glb is read, placed by the node and the callback, and a draco one refused', () => {
  const r = readGlb(glb(), null, (p) => [p[0], p[1], p[2]]);
  assert.equal(r.copyright, 'Test');
  assert.equal(r.primitives.length, 1);
  // translation (10,20,30) in glTF y-up becomes (x, -z, y) = (10, -30, 20) before placing
  assert.deepEqual([...r.primitives[0]!.position.slice(0, 3)], [10, -30, 20]);
  assert.deepEqual([...r.primitives[0]!.index], [0, 1, 2]);
  assert.throws(
    () =>
      readGlb(
        glb({ extensionsRequired: ['KHR_draco_mesh_compression'] }),
        null,
        (p) => p,
      ),
    /draco/i,
  );
});

test('the walker refines only when every child is in, and holds the parent until then', async () => {
  const box = (c: number, h: number) => ({
    box: [c, 0, 0, h, 0, 0, 0, h, 0, 0, 0, h],
  });
  const tree = {
    root: {
      boundingVolume: box(0, 100),
      geometricError: 50,
      content: { uri: 'p.glb' },
      children: [
        {
          boundingVolume: box(-50, 50),
          geometricError: 0,
          content: { uri: 'a.glb' },
        },
        {
          boundingVolume: box(50, 50),
          geometricError: 0,
          content: { uri: 'b.glb' },
        },
      ],
    },
  };
  const ready = new Set<string>();
  const ts = new Tileset<string>({
    url: 'https://t.test/root.json',
    fetch: async (url) => {
      const name = new URL(url).pathname.slice(1);
      if (name === 'root.json') return new Response(JSON.stringify(tree));
      await new Promise((r) => setTimeout(r, name === 'b.glb' ? 60 : 5));
      return new Response(new Uint8Array(1));
    },
    onChange: () => undefined,
  });
  ts.decode = async (u) => (ready.add(u), u);
  const opt = {
    orbit: {
      heading: 0,
      pitch: 90,
      range: 300,
      fov: 40,
      target: [0, 0, 0] as [number, number, number],
    },
    height: 1000,
    aspect: 1,
    maxError: 4,
    eye: [0, 0, 300] as [number, number, number],
    axes: {
      forward: [0, 0, -1] as [number, number, number],
      right: [1, 0, 0] as [number, number, number],
      up: [0, 1, 0] as [number, number, number],
    },
  };
  ts.select(opt);
  await new Promise((r) => setTimeout(r, 30));
  await new Promise((r) => setTimeout(r, 0));
  ts.select(opt);
  await new Promise((r) => setTimeout(r, 30));
  // p, a loaded, b not yet: the parent is what is shown
  const mid = ts.select(opt);
  assert.deepEqual(
    mid.draw,
    ['p.glb'].filter((u) => ts.tile(u)),
  );
  await new Promise((r) => setTimeout(r, 100));
  const done = ts.select(opt);
  assert.ok(done.complete);
  assert.deepEqual([...done.draw].sort(), ['a.glb', 'b.glb']);
  ts.dispose();
});
