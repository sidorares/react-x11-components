// `src/html/frame-store.ts`: frames a WebGL context kept in the process that
// owns the GPU, until the canvas they are for takes them.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discardFrame,
  keepFrame,
  peekFrame,
  takeFrame,
} from '../../src/html/frame-store.js';

const frame = (mb: number) => ({
  width: 1,
  height: 1,
  data: new Uint8ClampedArray(mb * 1024 * 1024),
});

test('a kept frame is taken once, and peeking leaves it', () => {
  const id = keepFrame(frame(1));
  assert.ok(peekFrame(id));
  assert.ok(peekFrame(id), 'still kept');
  assert.ok(takeFrame(id));
  assert.equal(takeFrame(id), null, 'taken once');
  assert.equal(peekFrame(id), null);
});

test('a discarded frame is let go', () => {
  const id = keepFrame(frame(1));
  discardFrame(id);
  assert.equal(takeFrame(id), null);
  discardFrame(id);
});

test('frames nobody takes are bounded, the oldest going first', () => {
  const ids = Array.from({ length: 12 }, () => keepFrame(frame(16)));
  // 192 MB offered, 128 MB kept: the first of them are gone, the last stays
  assert.equal(peekFrame(ids[0]), null);
  assert.ok(peekFrame(ids[11]), 'the newest is kept');
  for (const id of ids) discardFrame(id);
});

test('a frame is compared with the one before it for the box that moved, and its alpha', async () => {
  const { diffFrames } = await import('../../src/html/frame-store.js');
  const w = 7;
  const h = 5;
  const before = new Uint8ClampedArray(w * h * 4);
  const same = diffFrames(before, new Uint8ClampedArray(before), w, h);
  assert.equal(same.rect, null);
  assert.equal(same.alpha, false);
  const after = new Uint8ClampedArray(before);
  after[(1 * w + 2) * 4] = 9; // a colour at (2, 1)
  after[(3 * w + 5) * 4 + 3] = 255; // an alpha at (5, 3)
  const moved = diffFrames(before, after, w, h);
  assert.deepEqual(moved.rect, [2, 1, 6, 4]);
  assert.equal(moved.alpha, true);
  const colour = new Uint8ClampedArray(before);
  colour[(4 * w + 0) * 4 + 1] = 3;
  const only = diffFrames(before, colour, w, h);
  assert.deepEqual(only.rect, [0, 4, 1, 5]);
  assert.equal(only.alpha, false);
});
