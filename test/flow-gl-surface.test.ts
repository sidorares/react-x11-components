// `src/flow/gl/index.ts` — where the GL surface puts itself, from what
// `onDraw` is handed. Pure, and worth its own test because the way it failed
// was invisible: react-x11 2.17's `<glarea>` passes `{ width, height, x, y,
// node }` with no `scale`, though `DrawInfo` declares one
// (sidorares/react-x11#634). Dividing by it made every vertex `NaN` and the
// pane blank, while the renderer's own counters — draw calls, instances,
// frames a second — read exactly as a correct frame's do.
import { test } from 'node:test';
import assert from 'node:assert';

import { targetOf } from '../src/flow/gl/index.js';

test('the surface is placed from the node when onDraw carries no scale', () => {
  // exactly what core 2.17.1's `<glarea>` builds (src/glnodes.js)
  const info = {
    width: 2148,
    height: 1339,
    x: 0,
    y: 0,
    node: { abs: { x: 26, y: 75 }, scale: 2 },
  };
  assert.deepStrictEqual(targetOf(info), {
    origin: { x: 13, y: 37.5 },
    scale: 2,
    width: 2148,
    height: 1339,
  });
});

test('a scale on onDraw, once core passes one, is the one used', () => {
  const info = {
    width: 100,
    height: 50,
    scale: 1.5,
    node: { abs: { x: 30, y: 15 }, scale: 1.5 },
  };
  assert.deepStrictEqual(targetOf(info).origin, { x: 20, y: 10 });
});

test('a surface that cannot be placed fails loudly rather than drawing nothing', () => {
  // `<Flow>` answers a throw from the draw by falling back to the 2D renderer
  // and calling `onError` — a blank pane with healthy counters is the one
  // outcome this must never produce again.
  assert.throws(
    () =>
      targetOf({
        width: 100,
        height: 50,
        node: { abs: { x: Number.NaN, y: 0 }, scale: 2 },
      }),
    /cannot place the surface/,
  );
});
