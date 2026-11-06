// View transition capture clip: the ink a named element yields when it
// intersects the expanded viewport, and the near-edge strip when it does not
// (WPT massive-element-*-offscreen, far-away-capture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureClipRect } from '../../src/html/transition.js';

const vp = (w = 800, h = 600) => ({ x: 0, y: 0, width: w, height: h });

test('captureClipRect intersects ink with the viewport expanded by one viewport', () => {
  // element from y=0 to 40000, partially onscreen: band is [-600, 1200]
  const clip = captureClipRect({ x: 0, y: 0, width: 100, height: 40000 }, vp());
  assert.deepEqual(clip, { x0: 0, y0: 0, x1: 100, y1: 1200 });
});

test('captureClipRect takes a viewport strip from the near edge when fully below the band', () => {
  // fixed at inset-block-start: 20000 — past the band's bottom (1200)
  const clip = captureClipRect(
    { x: 0, y: 20000, width: 100, height: 40000 },
    vp(),
  );
  assert.deepEqual(clip, { x0: 0, y0: 20000, x1: 100, y1: 20600 });
});

test('captureClipRect takes a viewport strip from the near edge when fully above the band', () => {
  // ends at -1000, past the band's top (-600)
  const clip = captureClipRect(
    { x: 0, y: -41000, width: 100, height: 40000 },
    vp(),
  );
  assert.deepEqual(clip, { x0: 0, y0: -1600, x1: 100, y1: -1000 });
});

test('an element that ends just above the viewport still intersects the band', () => {
  // WPT on-top-offscreen: inset-block-start -40100, height 40000 → [-40100, -100]
  const clip = captureClipRect(
    { x: 0, y: -40100, width: 100, height: 40000 },
    vp(),
  );
  assert.deepEqual(clip, { x0: 0, y0: -600, x1: 100, y1: -100 });
});

test('captureClipRect takes a viewport strip from the near edge when fully to the right of the band', () => {
  const clip = captureClipRect(
    { x: 20000, y: 0, width: 40000, height: 100 },
    vp(),
  );
  assert.deepEqual(clip, { x0: 20000, y0: 0, x1: 20800, y1: 100 });
});

test('captureClipRect takes a viewport strip from the near edge when fully to the left of the band', () => {
  // ends at -1000, past the band's left (-800)
  const clip = captureClipRect(
    { x: -41000, y: 0, width: 40000, height: 100 },
    vp(),
  );
  assert.deepEqual(clip, { x0: -1800, y0: 0, x1: -1000, y1: 100 });
});

test('captureClipRect keeps a far-away element that fits in one viewport whole', () => {
  // far-away-capture: a 500-tall box well below the expanded band
  const clip = captureClipRect(
    { x: 0, y: 6500, width: 100, height: 500 },
    vp(),
  );
  assert.deepEqual(clip, { x0: 0, y0: 6500, x1: 100, y1: 7000 });
});

test('captureClipRect returns null for empty ink or viewport', () => {
  assert.equal(
    captureClipRect({ x: 0, y: 0, width: 0, height: 10 }, vp()),
    null,
  );
  assert.equal(
    captureClipRect(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
    ),
    null,
  );
});
