// A page's canvas drawn on the host's native context
// (REACT_X11_NATIVE_CANVAS=1, `src/html/native-canvas.ts`) is recorded by
// the realm; what the host's context draws differently from a browser's — a
// shadow, a pattern, an operator that clears what a draw misses — sends the
// canvas on in the realm (`nativeBail`). These run with no Cocoa app, where
// the host never draws what was recorded: what they pin is the realm's side,
// that the canvas that goes on in JavaScript draws what the page asked for,
// cut by the clips it had been given while it was recorded.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test =
  SCRIPTS_CONTAINED && process.platform === 'darwin' ? nodeTest : nodeTest.skip;

async function inPage(code: string): Promise<unknown> {
  const was = [
    process.env.REACT_X11_NATIVE_CANVAS,
    process.env.REACT_X11_BACKEND,
  ];
  process.env.REACT_X11_NATIVE_CANVAS = '1';
  process.env.REACT_X11_BACKEND = 'cocoa';
  try {
    const page = await scriptedPage(
      `<script>console.log("out " + JSON.stringify((function () {
        var c = document.createElement('canvas'); c.width = 40; c.height = 30;
        var x = c.getContext('2d');
        var at = function (px, py) {
          return Array.from(x.getImageData(px, py, 1, 1).data);
        };
        ${code}
      })()));</script>`,
    );
    const out = JSON.parse(await page.until('out'));
    page.result.unmount();
    return out;
  } finally {
    if (was[0] === undefined) delete process.env.REACT_X11_NATIVE_CANVAS;
    else process.env.REACT_X11_NATIVE_CANVAS = was[0];
    if (was[1] === undefined) delete process.env.REACT_X11_BACKEND;
    else process.env.REACT_X11_BACKEND = was[1];
  }
}

test('a canvas that draws a shadow goes on in the realm, and draws it', async () => {
  const out = (await inPage(
    `x.fillStyle = 'rgb(255, 0, 0)';
     x.shadowColor = 'rgb(0, 0, 255)';
     x.shadowOffsetX = 10;
     x.fillRect(2, 2, 10, 10);
     return { shape: at(5, 5), shadow: at(15, 5), none: at(35, 25) };`,
  )) as Record<string, number[]>;
  assert.deepEqual(out.shape, [255, 0, 0, 255]);
  assert.deepEqual(out.shadow, [0, 0, 255, 255], 'the shadow is cast');
  assert.deepEqual(out.none, [0, 0, 0, 0]);
});

test('a clip given while the canvas was recorded still cuts what is drawn after it goes on in the realm', async () => {
  const out = (await inPage(
    `x.beginPath();
     x.rect(0, 0, 20, 30);
     x.clip();
     x.shadowColor = 'rgb(0, 0, 255)';
     x.shadowOffsetX = 1;
     x.fillStyle = 'rgb(255, 0, 0)';
     x.fillRect(0, 0, 40, 30);
     return { inside: at(10, 10), outside: at(30, 10) };`,
  )) as Record<string, number[]>;
  assert.deepEqual(out.inside, [255, 0, 0, 255]);
  assert.deepEqual(out.outside, [0, 0, 0, 0], 'cut by the clip');
});

test('a saved state with a clip is restored to it after the canvas goes on in the realm', async () => {
  const out = (await inPage(
    `x.save();
     x.beginPath();
     x.rect(0, 0, 20, 30);
     x.clip();
     x.shadowColor = 'rgb(0, 0, 255)';
     x.shadowOffsetX = 1;
     x.fillStyle = 'rgb(255, 0, 0)';
     x.fillRect(0, 0, 10, 10);
     x.restore();
     x.shadowOffsetX = 0;
     x.fillStyle = 'rgb(0, 255, 0)';
     x.fillRect(30, 0, 10, 10);
     return { was: at(5, 5), after: at(35, 5) };`,
  )) as Record<string, number[]>;
  assert.deepEqual(out.was, [255, 0, 0, 255]);
  assert.deepEqual(out.after, [0, 255, 0, 255], 'no clip left');
});
