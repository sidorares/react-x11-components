// The whole stack over indirect GLX, hermetically: node-x11's in-process X
// server with its GLX extension, ntk connected over a stream pair, a real
// react-x11 root, a real <Canvas> — and the assertions on the **encoded GLX
// command stream** the client writes. Geometry compiles into one
// server-side display list and a frame is matrices plus CallList, never the
// vertices again; a `useFrame` mutation moves matrices only. That is the
// protocol property the design exists for, so it is what the test reads.
//
// The harness is react-x11's own `test/scene3d.test.js` harness, carried
// over: this package is where the scene graph lives now, and the property
// it asserts moved with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';

import { createRoot } from 'react-x11';

import { Canvas, useFrame } from '../src/three/index.js';
import type { Mesh } from '../src/three/index.js';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const xserver = require('x11/lib/xserver/index.js') as any;
const { createGlxExtension, RecordingBackend } = require('x11/browser/glx') as {
  createGlxExtension: (options: object) => unknown;
  RecordingBackend: new () => { calls: unknown[] };
};
const { createClient, StaticFontSource } = require('ntk') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const h = React.createElement;

// GLX request minor opcodes (x11 lib/ext/glx.js)
const GLX_RENDER = 1;
const GLX_NEW_LIST = 101;

// GL render-command opcodes (x11 lib/ext/glxrender.js)
const GL = {
  CallList: 1,
  Begin: 4,
  End: 23,
  Normal3f: 30,
  Vertex3f: 70,
  MultMatrixf: 180,
  PopMatrix: 183,
  PushMatrix: 184,
};

interface Tap {
  reset(): void;
  glx(major: number): {
    requests(minor: number): number;
    count(opcode: number): number;
    total(): number;
  };
}

/** Record what the client writes and decode the GLX traffic out of it. */
function tapRequests(stream: {
  write: (chunk: Uint8Array, ...rest: unknown[]) => boolean;
}): Tap {
  const chunks: Buffer[] = [];
  const write = stream.write.bind(stream);
  stream.write = (chunk: Uint8Array, ...rest: unknown[]) => {
    chunks.push(Buffer.from(chunk));
    return write(chunk, ...rest);
  };
  return {
    reset: () => {
      chunks.length = 0;
    },
    glx(major: number) {
      const buffer = Buffer.concat(chunks);
      const minors: number[] = [];
      const commands = new Map<number, number>();
      let offset = 0;
      while (offset + 4 <= buffer.length) {
        const words = buffer.readUInt16LE(offset + 2);
        if (words === 0) break; // BigRequests form: not used here
        const end = offset + words * 4;
        if (end > buffer.length) break;
        if (buffer[offset] === major) {
          const minor = buffer[offset + 1];
          minors.push(minor);
          if (minor === GLX_RENDER) {
            // [major][minor][length][contextTag] then GL commands
            let at = offset + 8;
            while (at + 4 <= end) {
              const length = buffer.readUInt16LE(at);
              const opcode = buffer.readUInt16LE(at + 2);
              if (length < 4) break;
              commands.set(opcode, (commands.get(opcode) ?? 0) + 1);
              at += length;
            }
          }
        }
        offset = end;
      }
      return {
        requests: (minor: number) => minors.filter((m) => m === minor).length,
        count: (opcode: number) => commands.get(opcode) ?? 0,
        total: () => [...commands.values()].reduce((a, b) => a + b, 0),
      };
    },
  };
}

async function createGlApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const backend = new RecordingBackend();
  server.registerExtension(
    'GLX',
    createGlxExtension({ backend, getDrawableSurface: () => null }),
  );
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const xErrors: Error[] = [];
  const app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    onXError: (err: Error) => xErrors.push(err),
  });
  return { app, backend, xErrors, tap: tapRequests(clientEnd) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const render = (element: React.ReactNode, x11Root: any): Promise<any> =>
  new Promise((resolve) => x11Root.render(element, resolve));

const settle = async (app: any, roundTrips = 3) => {
  for (let i = 0; i < roundTrips; i++) {
    await new Promise<void>((resolve, reject) =>
      app.X.GetInputFocus((err: Error | null) =>
        err ? reject(err) : resolve(),
      ),
    );
  }
};

async function waitFor(check: () => boolean, what: string, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The <glarea> node under a rendered window instance. */
function findSurface(node: any): any {
  if (node?.isGlArea) return node;
  for (const child of node?.children ?? []) {
    const found = findSurface(child);
    if (found) return found;
  }
  return null;
}

/**
 * From here on frames happen only when the test asks for one, so command
 * counts are exact. Noop-ing requestFrame blocks *new* schedules, but a
 * frame the loop already queued through the window's rAF still fires —
 * `_frameScheduled` is that queue's flag, so the counts are only exact once
 * it has drained (it cannot re-arm: re-arming goes through the noop). Then
 * settle the wire so a tap reset removes whole frames. Without the drain
 * this races, and on Node 20's timing it lost: a stale frame landed inside
 * the counted window as a third CallList.
 */
async function quiesce(surface: any, app: any) {
  surface.requestFrame = () => {};
  await waitFor(
    () => surface._frameScheduled !== true,
    'the frame clock to drain',
  );
  await settle(app);
}

/** Draw one frame the way an animation tick or an expose would. */
async function drawFrame(surface: any, app: any) {
  surface._drawFrame();
  await settle(app);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

test('a mesh compiles once, then every frame is one CallList', async () => {
  const { app, tap, xErrors } = await createGlApp();
  const x11Root = await createRoot({ app });
  try {
    const scene = (rotation: [number, number, number]) =>
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas,
          { style: { flexGrow: 1 }, camera: { position: [0, 0, 6] } },
          h(
            'mesh',
            { rotation },
            h('boxGeometry', { args: [1, 1, 1] }),
            h('meshBasicMaterial', { color: '#2980b9' }),
          ),
        ),
      );

    const instance = await render(scene([0, 0, 0]), x11Root);
    const surface = findSurface(instance._reactX11Node);
    assert.ok(surface, 'the Canvas realized a <glarea>');
    await waitFor(() => surface.gl?.contextTag > 0, 'the GL context');
    // counts are cumulative from the mount: a frame the mount scheduled may
    // already have compiled the list, and that is part of "once"
    await quiesce(surface, app);
    await drawFrame(surface, app);

    const first = tap.glx(app.display.GLX.majorOpcode);
    assert.equal(first.requests(GLX_NEW_LIST), 1, 'one display list compiled');
    // a unit box is 12 triangles: 36 vertices, sent once
    assert.equal(first.count(GL.Vertex3f), 36, 'the geometry, sent once');
    assert.ok(first.count(GL.CallList) >= 1, 'and replayed by CallList');

    // a transform change re-sends matrices, never geometry
    tap.reset();
    await render(scene([0, 0.4, 0]), x11Root);
    await drawFrame(surface, app);

    const moved = tap.glx(app.display.GLX.majorOpcode);
    assert.equal(moved.count(GL.Vertex3f), 0, 'no geometry re-sent');
    assert.equal(moved.requests(GLX_NEW_LIST), 0, 'no recompile');
    assert.equal(moved.count(GL.CallList), 1, 'one CallList for the mesh');
    assert.ok(
      moved.count(GL.MultMatrixf) >= 3,
      'projection, view and the model matrix',
    );
    assert.equal(xErrors.length, 0, xErrors.map((e) => e.message).join(', '));

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('a useFrame mutation animates without re-sending geometry', async () => {
  const { app, tap } = await createGlApp();
  const x11Root = await createRoot({ app });
  try {
    let ticks = 0;
    function Spinner() {
      const ref = React.useRef<Mesh>(null);
      useFrame((_state, delta) => {
        ticks += 1;
        if (ref.current) ref.current.rotation.y += delta + 0.01;
      });
      return h(
        'mesh',
        { ref },
        h('sphereGeometry', { args: [1, 12, 8] }),
        h('meshLambertMaterial', { color: 'tomato' }),
      );
    }

    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas,
          { style: { flexGrow: 1 } },
          h('ambientLight', { intensity: 0.4 }),
          h('pointLight', { position: [4, 5, 3] }),
          h(Spinner),
        ),
      ),
      x11Root,
    );
    const surface = findSurface(instance._reactX11Node);
    await waitFor(() => surface.gl?.contextTag > 0, 'the GL context');
    await quiesce(surface, app);

    await drawFrame(surface, app);
    const first = tap.glx(app.display.GLX.majorOpcode);
    assert.ok(first.count(GL.Vertex3f) > 0, 'the sphere compiled');
    assert.ok(ticks >= 1, 'the frame callback ran');

    tap.reset();
    await drawFrame(surface, app);
    await drawFrame(surface, app);
    const animated = tap.glx(app.display.GLX.majorOpcode);
    assert.ok(ticks >= 3, 'the callback keeps running');
    assert.equal(animated.count(GL.Vertex3f), 0, 'mutation re-sends nothing');
    assert.equal(animated.count(GL.CallList), 2, 'one CallList per frame');

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('per-frame cost does not grow with triangle count', async () => {
  const { app, tap } = await createGlApp();
  const x11Root = await createRoot({ app });
  try {
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas,
          { style: { flexGrow: 1 } },
          h(
            'mesh',
            {},
            h('sphereGeometry', { args: [1, 32, 32] }),
            h('meshBasicMaterial', { color: 'tomato' }),
          ),
        ),
      ),
      x11Root,
    );
    const surface = findSurface(instance._reactX11Node);
    await waitFor(() => surface.gl?.contextTag > 0, 'the GL context');
    await quiesce(surface, app);
    await drawFrame(surface, app);

    const compile = tap.glx(app.display.GLX.majorOpcode);
    assert.ok(
      compile.count(GL.Vertex3f) > 6000,
      'a 32x32 sphere is thousands of vertices, once',
    );

    tap.reset();
    await drawFrame(surface, app);
    const steady = tap.glx(app.display.GLX.majorOpcode);
    assert.equal(steady.count(GL.Vertex3f), 0);
    assert.ok(
      steady.total() < 30,
      `a steady frame is a handful of commands, got ${steady.total()}`,
    );

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});
