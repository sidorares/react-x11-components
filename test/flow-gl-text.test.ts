// `src/flow/gl/text.ts` — the GL renderer's label atlas, against a real text
// engine and a real staging surface (the headless X server's), with no GPU:
// what it hands the packer, and when.
import { test, after } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { cleanup, renderX11 } from 'react-x11/test';

import { fitText, measureText } from '../src/flow/draw.js';
import type { PainterOptions } from '../src/flow/draw.js';
import { LabelAtlas } from '../src/flow/gl/text.js';
import type { SceneText } from '../src/flow/scene.js';

after(() => cleanup());

async function atlasAt(
  scale: number,
  side?: number,
): Promise<{
  atlas: LabelAtlas;
  options: PainterOptions;
}> {
  const result = await renderX11(React.createElement('box'), {
    backend: 'xserver',
    width: 320,
    height: 240,
  });
  const app = result.app as unknown as { fonts: PainterOptions['fonts'] };
  assert.ok(app.fonts, 'precondition: the headless server has a text engine');
  const options: PainterOptions = {
    fonts: app.fonts,
    family: 'sans-serif',
    color: '#000000',
    scale,
    cache: new Map(),
  };
  return { atlas: new LabelAtlas({ app, options }, side), options };
}

function label(extra: Partial<SceneText> = {}): SceneText {
  return {
    kind: 'text',
    text: 'node 12',
    x: 100,
    y: 50,
    size: 13,
    color: '#1c2024',
    ...extra,
  };
}

/** Pump until nothing is wanted, as the surface does between frames. */
async function settle(atlas: LabelAtlas): Promise<void> {
  for (let i = 0; i < 10 && atlas.wanting; i++) await atlas.pump();
}

test('a label is wanted, then set, then drawn from its own raster', async () => {
  const { atlas } = await atlasAt(2);
  assert.strictEqual(atlas.quad(label()), null, 'nothing to draw it from yet');
  assert.ok(atlas.wanting, 'and it is asked for');
  await settle(atlas);
  assert.ok(!atlas.wanting);
  const q = atlas.quad(label());
  assert.ok(q, 'drawn once set');
  // Its raster at device size, margin included, back in logical pixels:
  // two pixels of margin at a scale of 2 is one logical pixel each side.
  assert.ok(Math.abs(q.x - 99) < 1e-9, `left edge ${q.x}`);
  assert.ok(Math.abs(q.y - 49) < 1e-9, `top edge ${q.y}`);
  assert.ok(q.u0 >= 0 && q.u1 <= 1 && q.u1 > q.u0);
  assert.ok(q.v0 >= 0 && q.v1 <= 1 && q.v1 > q.v0);
  assert.ok(!atlas.wanting, 'and an exact hit asks for nothing');
});

test('a size not set yet is drawn from the nearest one, scaled, while it is set', async () => {
  // The zoom case: every label changes size at once, and none may vanish
  // for the frames it takes to set them again.
  const { atlas } = await atlasAt(2);
  atlas.quad(label({ size: 12 }));
  await settle(atlas);
  const near = atlas.quad(label({ size: 13 }));
  assert.ok(near, 'drawn from the 12 while the 13 is set');
  const exact12 = atlas.quad(label({ size: 12 }))!;
  assert.ok(
    Math.abs(near.w / exact12.w - 13 / 12) < 1e-9,
    'scaled by the ratio of the sizes',
  );
  assert.ok(atlas.wanting, 'and the exact size is asked for');
  await settle(atlas);
  const exact13 = atlas.quad(label({ size: 13 }))!;
  assert.notDeepStrictEqual(
    [exact13.u0, exact13.v0],
    [exact12.u0, exact12.v0],
    'which is a raster of its own once set',
  );
});

test('nothing new is set while the zoom is moving', async () => {
  const { atlas } = await atlasAt(1);
  atlas.quad(label());
  atlas.admit = false;
  assert.strictEqual(await atlas.pump(), false);
  assert.ok(atlas.wanting, 'still wanted, for when it stops');
  atlas.admit = true;
  assert.strictEqual(await atlas.pump(), true);
});

test('only the sizes the world on screen asks for are set, not every step of a zoom', async () => {
  const { atlas } = await atlasAt(2);
  atlas.beginPack();
  atlas.quad(label({ size: 11 }));
  await settle(atlas);
  // a zoom: each step's world asks for its own size, and none is set yet
  atlas.admit = false;
  for (const size of [12, 13, 14]) {
    atlas.beginPack();
    atlas.quad(label({ size }));
  }
  // it stops at 15
  atlas.admit = true;
  atlas.beginPack();
  atlas.quad(label({ size: 15 }));
  assert.strictEqual(await atlas.pump(), true);
  assert.ok(!atlas.wanting, 'one batch, and nothing left wanted');
  atlas.beginPack();
  atlas.quad(label({ size: 13 }));
  assert.ok(atlas.wanting, 'a size the zoom passed through was never set');
});

test('a full atlas keeps what the screen draws, moved, and drops only the rest', async () => {
  // A small atlas, so two dozen labels fill it. Before, a full atlas was
  // cleared: every label with no other size set vanished until its batch
  // came round again — text blinking out after a zoom.
  const { atlas } = await atlasAt(2, 256);
  const names = (prefix: string) =>
    Array.from({ length: 12 }, (_, i) => `${prefix} ${i}`);
  atlas.beginPack();
  for (const text of names('node')) atlas.quad(label({ text }));
  await settle(atlas);
  assert.ok(!atlas.relocated, 'precondition: twelve fit');

  // The next world draws `node 0` and asks for twelve more.
  atlas.beginPack();
  const before = atlas.quad(label({ text: 'node 0' }))!;
  assert.ok(before, 'precondition: node 0 is set');
  for (const text of names('edge')) atlas.quad(label({ text }));
  await settle(atlas);

  assert.ok(atlas.relocated, 'the rasters moved: the world must be repacked');
  assert.ok(!atlas.wanting, 'and every one asked for was set');
  atlas.beginPack();
  const after = atlas.quad(label({ text: 'node 0' }));
  assert.ok(after, 'the label on screen survived the atlas filling');
  assert.strictEqual(after.w, before.w, 'from its own raster, not a stand-in');
  for (const text of names('edge')) {
    assert.ok(atlas.quad(label({ text })), `${text} is drawn`);
  }
  const dropped = names('node')
    .slice(1)
    .filter((text) => atlas.quad(label({ text })) === null);
  assert.ok(dropped.length > 0, 'the labels off screen made the room');
});

test('a label cut to its card is cut where the 2D painter cuts it', async () => {
  const { atlas, options } = await atlasAt(1);
  const long = label({
    text: 'a label far too long for the card it sits on',
    maxWidth: 80,
  });
  atlas.quad(long);
  await settle(atlas);
  const q = atlas.quad(long)!;
  const shown = fitText(options, long.text, { size: 13 }, 80);
  assert.ok(shown.endsWith('…'), 'precondition: it does need cutting');
  const { width } = measureText(options, shown, { size: 13 });
  // the raster is the cut string's, plus its margin
  assert.ok(Math.abs(q.w - (Math.ceil(width) + 4)) <= 1, `raster ${q.w}`);
});

test('a centred label is centred on its anchor, as the 2D painter centres it', async () => {
  const { atlas, options } = await atlasAt(1);
  const centred = label({ align: 'center', baseline: 'middle' });
  atlas.quad(centred);
  await settle(atlas);
  const q = atlas.quad(centred)!;
  const { width, height } = measureText(options, centred.text, { size: 13 });
  assert.ok(Math.abs(q.x + 2 - (100 - width / 2)) < 1e-9, 'left edge');
  assert.ok(Math.abs(q.y + 2 - (50 - height / 2)) < 1e-9, 'top edge');
});
