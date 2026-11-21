// `GlMapLayer` — a map drawn into a texture of its own, in a GL context
// somebody else owns (`<Flow>`'s, through `FlowNodeType.glBody`). The camera
// and the gestures are `<Map>`'s controller's and the drawing is its GL
// driver's, so what is new here is the framebuffer it draws into, the frames
// it asks its host for, and the input the host forwards — all of it driven
// against a recording GL table, as `maps-gl.test.ts` drives `GlMapDriver`.
import { test } from 'node:test';
import assert from 'node:assert';

import { GlMapLayer } from '../src/maps/index.js';
import type { FlowGlBody } from '../src/flow/index.js';
import { glRendererModule, loadGlRenderer } from '../src/maps/renderer.js';
import { glideClock, settleClock } from '../src/maps/controller.js';
import { holdClock } from './held-clock.js';

const FRAMEBUFFER_BINDING = 0x8ca6;
const VERTEX_ARRAY_BINDING = 0x85b5;

/** Enough of the WebGL-shaped table to draw a map: every call recorded,
 *  every object a number, the framebuffer and vertex array bound kept, and
 *  the stencil probe answered as a framebuffer with a stencil buffer. */
function recordingGl() {
  const log: { name: string; args: unknown[] }[] = [];
  let next = 1;
  let framebuffer: unknown = 'the host’s framebuffer';
  let vao: unknown = null;
  const constants = new Map<string, number>();
  const target: Record<string, unknown> = {
    backend: 'direct',
    getParameter: (p: number) =>
      p === FRAMEBUFFER_BINDING
        ? framebuffer
        : p === VERTEX_ARRAY_BINDING
          ? vao
          : 0,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => next++,
    bindFramebuffer: (t: unknown, fbo: unknown) => {
      log.push({ name: 'bindFramebuffer', args: [t, fbo] });
      framebuffer = fbo;
    },
    bindVertexArray: (v: unknown) => {
      log.push({ name: 'bindVertexArray', args: [v] });
      vao = v;
    },
    readPixels: (...args: unknown[]) => {
      const out = args[6] as Uint8Array;
      // pixel 1 drew, pixel 0 did not: a framebuffer with a stencil
      out.set([255, 0, 255, 255], 4);
    },
  };
  return {
    log,
    framebuffer: () => framebuffer,
    gl: new Proxy(target, {
      get(obj, name: string) {
        if (name in obj) return obj[name];
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
          if (!constants.has(name))
            constants.set(name, 0x1000 + constants.size);
          return constants.get(name);
        }
        return (...args: unknown[]) => {
          log.push({ name, args });
          return name.startsWith('create')
            ? next++
            : args.length
              ? undefined
              : 0;
        };
      },
    }) as Record<string, unknown> & object,
  };
}

const PROPS = {
  sources: [],
  mapStyle: { background: '#abcdef', layers: [] },
  defaultCamera: { center: { lon: -0.1281, lat: 51.508 }, zoom: 12 },
};

/** A layer whose GL half has loaded, attached to a host that counts the
 *  frames it is asked for. */
async function loaded(props: object = PROPS) {
  await loadGlRenderer();
  const layer = new GlMapLayer(props);
  let asked = 0;
  layer.attach({ requestFrame: () => void asked++ });
  return { layer, asked: () => asked };
}

test('a layer fits <Flow>’s GL body seam, structurally', () => {
  // the type is the test: `tsc` refuses this file if it does not fit
  const body: FlowGlBody = new GlMapLayer(PROPS);
  assert.strictEqual(typeof body.draw, 'function');
});

test('before its GL half has loaded a layer draws nothing, and asks for a frame once it has', async () => {
  // This file's first use of the module: nothing has loaded it yet.
  assert.strictEqual(glRendererModule(), null, 'precondition: not loaded');
  const layer = new GlMapLayer(PROPS);
  let asked = 0;
  layer.attach({ requestFrame: () => void asked++ });
  const { gl } = recordingGl();
  assert.strictEqual(
    layer.draw(gl, { width: 200, height: 100, scale: 1 }),
    null,
  );
  await loadGlRenderer();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(asked, 1, 'the host was asked for a frame');
  const drawn = layer.draw(gl, { width: 200, height: 100, scale: 1 });
  assert.ok(drawn, 'and the next one draws');
  layer.dispose();
});

test('a frame draws the map into a framebuffer of its own, with a stencil, and binds the host’s back', async () => {
  const { layer } = await loaded();
  const recording = recordingGl();
  const drawn = layer.draw(recording.gl, { width: 300, height: 150, scale: 2 });
  assert.ok(drawn);
  assert.deepStrictEqual([drawn.width, drawn.height], [300, 150]);
  const k = recording.gl as Record<string, number>;
  const storage = recording.log.find((c) => c.name === 'renderbufferStorage');
  assert.deepStrictEqual(storage?.args.slice(1), [
    k.DEPTH24_STENCIL8,
    300,
    150,
  ]);
  const colour = recording.log.find((c) => c.name === 'framebufferTexture2D');
  assert.strictEqual(
    colour?.args[3],
    drawn.texture,
    'its colour is the texture',
  );
  // the map cleared and drew with its own framebuffer bound
  let bound: unknown = null;
  let cleared = false;
  for (const c of recording.log) {
    if (c.name === 'bindFramebuffer') bound = c.args[1];
    if (c.name === 'clear' && bound !== 'the host’s framebuffer')
      cleared = true;
  }
  assert.ok(cleared, 'the map was drawn into its own framebuffer');
  assert.strictEqual(
    recording.framebuffer(),
    'the host’s framebuffer',
    'and the host’s is bound again',
  );
  // the same size again is the same texture; another is a new one
  const again = layer.draw(recording.gl, { width: 300, height: 150, scale: 2 });
  assert.strictEqual(again?.texture, drawn.texture);
  const bigger = layer.draw(recording.gl, {
    width: 400,
    height: 150,
    scale: 2,
  });
  assert.notStrictEqual(bigger?.texture, drawn.texture);
  layer.dispose();
});

test('the map is laid out in the host’s units: a press and a drag pan it by what the pointer moved', async (t) => {
  holdClock(t, settleClock);
  const { layer } = await loaded();
  const { gl } = recordingGl();
  // 400 × 200 device pixels at 2 a unit: the map is 200 × 100 of its own
  layer.draw(gl, { width: 400, height: 200, scale: 2 });
  const before = layer.handle.getCamera();
  assert.strictEqual(
    layer.pointer({ type: 'down', x: 100, y: 50, button: 1 }),
    true,
  );
  layer.pointer({ type: 'drag', x: 140, y: 50, button: 1 });
  layer.pointer({ type: 'up', x: 140, y: 50, button: 1 });
  const after = layer.handle.getCamera();
  assert.ok(
    after.center.lon < before.center.lon,
    'dragged right, the map moved east',
  );
  // 40 units at zoom 12 on a 512 world: 40 / (512 · 2¹²) of 360°
  const moved = before.center.lon - after.center.lon;
  const expected = (40 / (512 * 2 ** 12)) * 360;
  assert.ok(
    Math.abs(moved - expected) < expected * 0.05,
    `${moved} ≈ ${expected}`,
  );
  // the middle of the map is the middle of the host's box
  const centre = layer.handle.project(after.center);
  assert.ok(Math.abs(centre.x - 100) < 1 && Math.abs(centre.y - 50) < 1);
  layer.dispose();
});

test('a wheel over the layer zooms the map, and is the layer’s', async (t) => {
  const glide = holdClock(t, glideClock);
  holdClock(t, settleClock);
  const { layer, asked } = await loaded();
  const { gl } = recordingGl();
  layer.draw(gl, { width: 400, height: 200, scale: 2 });
  const before = layer.handle.getCamera().zoom;
  const was = asked();
  assert.strictEqual(
    layer.pointer({ type: 'wheel', x: 100, y: 50, deltaY: -48 }),
    true,
  );
  await glide.finish();
  assert.ok(layer.handle.getCamera().zoom > before, 'zoomed in');
  assert.ok(asked() > was, 'and asked its host for the frames that show it');
  layer.dispose();
});

test('a map that does not move leaves the press to its host', async () => {
  const { layer } = await loaded({ ...PROPS, interactive: false });
  const { gl } = recordingGl();
  layer.draw(gl, { width: 400, height: 200, scale: 2 });
  assert.strictEqual(
    layer.pointer({ type: 'down', x: 10, y: 10, button: 1 }),
    false,
  );
  assert.strictEqual(
    layer.pointer({ type: 'wheel', x: 10, y: 10, deltaY: -48 }),
    false,
  );
  layer.dispose();
});

test('detached, a layer lets go of what it made in the host’s context and asks for nothing', async () => {
  const { layer, asked } = await loaded();
  const recording = recordingGl();
  layer.draw(recording.gl, { width: 300, height: 150, scale: 1 });
  layer.detach();
  for (const name of [
    'deleteFramebuffer',
    'deleteRenderbuffer',
    'deleteTexture',
  ]) {
    assert.ok(
      recording.log.some((c) => c.name === name),
      `${name} — its target is gone`,
    );
  }
  const was = asked();
  layer.handle.panBy(10, 0);
  assert.strictEqual(asked(), was, 'no host to ask');
  // attached again, it draws again
  layer.attach({ requestFrame: () => {} });
  assert.ok(layer.draw(recording.gl, { width: 300, height: 150, scale: 1 }));
  layer.dispose();
});

test('a context the layer has not drawn in is one it starts again in', async () => {
  const { layer } = await loaded();
  const one = recordingGl();
  const two = recordingGl();
  const a = layer.draw(one.gl, { width: 300, height: 150, scale: 1 });
  const b = layer.draw(two.gl, { width: 300, height: 150, scale: 1 });
  assert.ok(a && b);
  assert.ok(
    two.log.some((c) => c.name === 'createFramebuffer'),
    'a framebuffer of its own in the new context',
  );
  assert.ok(
    !one.log.some((c) => c.name === 'deleteFramebuffer'),
    'and nothing deleted in the old one from the new',
  );
  layer.dispose();
});
