// `src/flow/gl/text.ts` — the GL renderer's label atlas, against a real text
// engine and a real staging surface (the headless X server's), with no GPU:
// what it hands the packer, and when.
import { test, after } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { cleanup, renderX11 } from 'react-x11/test';

import { fitText, measureText } from '../src/flow/draw.js';
import type { PainterOptions } from '../src/flow/draw.js';
import {
  LabelAtlas,
  QUAD_INSET,
  fieldBase,
  fieldPad,
} from '../src/flow/gl/text.js';
import type { GlyphQuad } from '../src/flow/gl/text.js';
import type { SceneText } from '../src/flow/scene.js';
import { SDF_EDGE } from '../src/internal/sdf.js';

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
  for (let i = 0; i < 200 && atlas.wanting; i++) await atlas.pump();
}

/** A field's size in the atlas, texels, margin included, from its quad. */
function fieldOf(q: GlyphQuad): { width: number; height: number } {
  return {
    width: Math.round(q.w / q.texel) + QUAD_INSET * 2,
    height: Math.round(q.h / q.texel) + QUAD_INSET * 2,
  };
}

/** The width a string sets in at the base size, device pixels — what the
 *  atlas measures a label with, whatever size it is drawn at. */
function baseWidth(options: PainterOptions, text: string): number {
  const base = fieldBase(options.scale);
  return measureText({ ...options, scale: 1, cache: new Map() }, text, {
    size: base,
    color: '#ffffff',
  }).width;
}

test('a label is wanted, then set, then drawn from its field', async () => {
  const { atlas, options } = await atlasAt(2);
  assert.strictEqual(atlas.quad(label()), null, 'nothing to draw it from yet');
  assert.ok(atlas.wanting, 'and it is asked for');
  await settle(atlas);
  assert.ok(!atlas.wanting);
  const q = atlas.quad(label());
  assert.ok(q, 'drawn once set');
  // Set at the base size — 32 at a scale of 2 — and scaled to 13.
  const base = fieldBase(2);
  assert.strictEqual(atlas.base, base);
  assert.ok(Math.abs(q.texel - 13 / base) < 1e-12, `texel ${q.texel}`);
  // The quad hangs its margin before the text's own corner, which is the
  // label's anchor: nothing is added to where the 2D painter puts it.
  assert.strictEqual(q.x, 100);
  assert.strictEqual(q.y, 50);
  const pad = fieldPad(base);
  assert.ok(Math.abs(q.margin - (pad - QUAD_INSET) * q.texel) < 1e-12);
  // The field is the string at the base size and its margin both sides.
  const { width } = fieldOf(q);
  assert.strictEqual(width, Math.ceil(baseWidth(options, 'node 12')) + pad * 2);
  assert.ok(q.u0 >= 0 && q.u1 <= 1 && q.u1 > q.u0);
  assert.ok(q.v0 >= 0 && q.v1 <= 1 && q.v1 > q.v0);
  assert.ok(!atlas.wanting, 'and drawing it asks for nothing');
});

test('one field draws a label at every size, so a zoom asks for nothing', async () => {
  const { atlas } = await atlasAt(2);
  atlas.beginPack();
  atlas.quad(label({ size: 11 }));
  await settle(atlas);
  const at11 = atlas.quad(label({ size: 11 }))!;
  assert.ok(at11, 'precondition: set');
  // every step of a zoom, and where it comes to rest
  for (const size of [12, 13, 14, 26, 5]) {
    atlas.beginPack();
    const q = atlas.quad(label({ size }));
    assert.ok(q, `drawn at ${size}`);
    assert.deepStrictEqual(
      [q.u0, q.v0, q.u1, q.v1],
      [at11.u0, at11.v0, at11.u1, at11.v1],
      'from the one field',
    );
    assert.ok(
      Math.abs(q.w / at11.w - size / 11) < 1e-9,
      'scaled by the ratio of the sizes',
    );
    assert.ok(!atlas.wanting, `and ${size} asks for nothing new`);
  }
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

test('a batch makes its fields in slices, so no one task holds a frame back', async () => {
  const { atlas } = await atlasAt(1);
  const names = Array.from({ length: 12 }, (_, i) => `label ${i}`);
  const drawable = () =>
    names.filter((text) => atlas.quad(label({ text })) !== null).length;
  atlas.beginPack();
  for (const text of names) atlas.quad(label({ text }));
  // No budget past the first field: a slice is one field.
  atlas.fieldBudgetMs = 0;
  assert.strictEqual(await atlas.pump(), true, 'the first field landed');
  assert.strictEqual(drawable(), 1, 'one field, whatever the batch read back');
  assert.ok(atlas.wanting, 'and the rest are still wanted');
  assert.strictEqual(await atlas.pump(), true);
  assert.strictEqual(drawable(), 2, 'the next slice, the next field');
  atlas.fieldBudgetMs = 3;
  await settle(atlas);
  assert.strictEqual(drawable(), names.length, 'every one in the end');
});

/** The shelf packer's arithmetic, to size an atlas for a test. */
function fits(side: number, fields: { width: number; height: number }[]) {
  let x = 0;
  let y = 0;
  let row = 0;
  for (const f of fields) {
    if (x + f.width > side) {
      x = 0;
      y += row;
      row = 0;
    }
    if (y + f.height > side) return false;
    x += f.width;
    row = Math.max(row, f.height);
  }
  return true;
}

test('a full atlas keeps what the screen draws, moved, and drops only the rest', async () => {
  // Before, a full atlas was cleared: every label on screen vanished until
  // its batch came round again — text blinking out after a pan.
  const names = (prefix: string) =>
    Array.from({ length: 12 }, (_, i) => `${prefix} ${i}`);
  // The fields' sizes, from an atlas with room for all of them…
  const probe = (await atlasAt(1)).atlas;
  probe.beginPack();
  for (const text of [...names('node'), ...names('edge')]) {
    probe.quad(label({ text }));
  }
  await settle(probe);
  const size = (text: string) => fieldOf(probe.quad(label({ text }))!);
  const nodes = names('node').map(size);
  const edges = names('edge').map(size);
  // …then the smallest side that holds twelve and not twenty-four, and
  // still holds the one on screen with the twelve new ones.
  let side = 16;
  while (!(
    fits(side, nodes) &&
    !fits(side, [...nodes, ...edges]) &&
    fits(
      side,
      [nodes[0], ...edges].sort((a, b) => b.height - a.height),
    )
  )) {
    side += 4;
    assert.ok(side < 2048, 'precondition: a side exists');
  }

  const { atlas } = await atlasAt(1, side);
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

  assert.ok(atlas.relocated, 'the fields moved: the world must be repacked');
  assert.ok(!atlas.wanting, 'and every one asked for was set');
  atlas.beginPack();
  const after = atlas.quad(label({ text: 'node 0' }));
  assert.ok(after, 'the label on screen survived the atlas filling');
  assert.strictEqual(after.w, before.w, 'from its own field');
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
  // The 2D painter cuts at the size it draws; the atlas at its base size,
  // to the width that size allows.
  const shown = fitText(options, long.text, { size: 13 }, 80);
  assert.ok(shown.endsWith('…'), 'precondition: it does need cutting');
  const pad = fieldPad(fieldBase(1));
  assert.strictEqual(
    fieldOf(q).width,
    Math.ceil(baseWidth(options, shown)) + pad * 2,
    'the field is the cut string',
  );
  // …and at another zoom, the same cut: one field.
  const zoomed = atlas.quad({ ...long, size: 13 * 1.7, maxWidth: 80 * 1.7 });
  assert.ok(zoomed, 'drawn at 1.7x from the field it has');
  assert.deepStrictEqual([zoomed.u0, zoomed.v0], [q.u0, q.v0]);
});

test('a centred label is centred on its anchor, as the 2D painter centres it', async () => {
  const { atlas, options } = await atlasAt(1);
  const centred = label({ align: 'center', baseline: 'middle' });
  atlas.quad(centred);
  await settle(atlas);
  const q = atlas.quad(centred)!;
  const { width, height } = measureText(options, centred.text, { size: 13 });
  // Measured at the base size and scaled: within a fraction of a pixel of
  // the 2D painter's own measure at 13.
  assert.ok(Math.abs(q.x - (100 - width / 2)) < 0.5, `left edge ${q.x}`);
  assert.ok(Math.abs(q.y - (50 - height / 2)) < 0.5, `top edge ${q.y}`);
});

test('the texture holds fields: white, the distance in alpha', async () => {
  const { atlas } = await atlasAt(1);
  atlas.quad(label());
  await settle(atlas);
  const q = atlas.quad(label())!;
  const uploads: { w: number; h: number; data: Uint8Array }[] = [];
  const gl = {
    TEXTURE_2D: 1,
    RGBA: 2,
    UNSIGNED_BYTE: 3,
    TEXTURE0: 4,
    createTexture: () => ({}),
    bindTexture() {},
    texImage2D() {},
    texParameteri() {},
    activeTexture() {},
    pixelStorei() {},
    texSubImage2D(
      _t: number,
      _l: number,
      _x: number,
      _y: number,
      w: number,
      h: number,
      _f: number,
      _ty: number,
      data: Uint8Array,
    ) {
      uploads.push({ w, h, data: data.slice() });
    },
  };
  atlas.bind(gl, true);
  assert.strictEqual(uploads.length, 1, 'one field uploaded');
  const { w, h, data } = uploads[0];
  assert.deepStrictEqual({ width: w, height: h }, fieldOf(q));
  let inside = 0;
  let outside = 0;
  for (let i = 0; i < w * h; i++) {
    assert.deepStrictEqual(
      [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]],
      [255, 255, 255],
    );
    if (data[i * 4 + 3] > 255 * SDF_EDGE) inside++;
    if (data[i * 4 + 3] === 0) outside++;
  }
  assert.ok(inside > 0, 'texels inside the glyphs');
  assert.ok(outside > 0, 'and texels as far outside as the field reaches');
  // Bound again with nothing new: nothing uploaded.
  atlas.bind(gl, false);
  assert.strictEqual(uploads.length, 1);
});
