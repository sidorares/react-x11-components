// `src/flow/gl/text.ts` — the GL renderer's label atlas, against a real text
// engine (the headless X server's: ntk's layouts, which answer their own
// coverage, and a staging surface for a test that hides it), with no GPU:
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

/** The quad a label is drawn from — null while its field is being set,
 *  when the quad is a placeholder the frame draws as nothing. */
const drawn = (q: GlyphQuad | null): GlyphQuad | null => (q?.ready ? q : null);

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
  assert.strictEqual(
    drawn(atlas.quad(label())),
    null,
    'nothing to draw it from yet',
  );
  assert.ok(atlas.wanting, 'and it is asked for');
  await settle(atlas);
  assert.ok(!atlas.wanting);
  const q = drawn(atlas.quad(label()));
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

test('a label still being set is packed where it will be drawn, as nothing', async () => {
  // A frame packs a box for it now — the size its field will have is known
  // from the measurement — and writes the field in when it lands, rather
  // than packing the world again.
  const { atlas } = await atlasAt(2);
  const t = label({ align: 'center', baseline: 'middle', maxWidth: 70 });
  const early = atlas.quad(t)!;
  assert.ok(early, 'a quad before its field exists');
  assert.strictEqual(early.ready, false);
  await settle(atlas);
  const set = atlas.quad(t)!;
  assert.strictEqual(set.ready, true);
  assert.strictEqual(set.key, early.key, 'the field it waited for');
  assert.deepStrictEqual(
    [early.x, early.y, early.w, early.h, early.margin, early.texel],
    [set.x, set.y, set.w, set.h, set.margin, set.texel],
    'in the place and at the size it is drawn once set',
  );
  const landed = atlas.landing(early.key, t)!;
  assert.deepStrictEqual(landed, set, 'and `landing` hands the same quad over');
});

test('a pack measures new strings for its budget, and the rest land with their whole quad', async () => {
  // Measuring a string is what its first appearance costs the frame that
  // packs it; past the budget a label is a box of no size, measured between
  // frames, and written in whole once its field lands.
  const { atlas } = await atlasAt(1);
  atlas.shapeBudgetMs = 0;
  atlas.beginPack();
  const first = label({ text: 'measured now', x: 10 });
  const later = label({ text: 'measured later', x: 200, maxWidth: 60 });
  const a = atlas.quad(first)!;
  const b = atlas.quad(later)!;
  assert.ok(a.w > 0, 'the first string of a pack is measured whatever');
  assert.strictEqual(b.ready, false);
  assert.strictEqual(b.w, 0, 'past the budget: no size yet');
  assert.ok(b.key.startsWith('?'), 'waiting on its request, not a field');
  assert.strictEqual(atlas.landing(b.key, later), null, 'nothing to draw yet');
  await settle(atlas);
  const landed = atlas.landing(b.key, later)!;
  assert.ok(landed, 'measured, cut and set between frames');
  assert.strictEqual(landed.ready, true);
  assert.deepStrictEqual(
    landed,
    drawn(atlas.quad(later)),
    'the quad a pack would give it now, whole',
  );
  assert.ok(!atlas.wanting);
});

test('a request answered by a field already set lands without a field of its own', async () => {
  const { atlas } = await atlasAt(1);
  atlas.beginPack();
  atlas.quad(label({ text: 'shared' }));
  await settle(atlas);
  // the same string on another card, past a pack's budget
  atlas.shapeBudgetMs = 0;
  atlas.beginPack();
  atlas.quad(label({ text: 'first of the pack' }));
  const other = label({ text: 'shared', x: 400, maxWidth: 200 });
  const q = atlas.quad(other)!;
  assert.strictEqual(q.ready, false, 'precondition: deferred');
  const before = atlas.generation;
  await settle(atlas);
  assert.ok(atlas.generation > before, 'a frame is owed: it writes it in');
  assert.ok(atlas.landing(q.key, other), 'drawn from the field it shares');
});

test('what is wanted is set nearest the focus first', async () => {
  const { atlas } = await atlasAt(1);
  atlas.beginPack();
  // a row of labels, the focus at the far end of it
  const texts = Array.from({ length: 8 }, (_, i) => `row ${i}`);
  texts.forEach((text, i) => atlas.quad(label({ text, x: i * 100 })));
  atlas.focus = { x: 700, y: 50 };
  atlas.fieldBudgetMs = 0;
  await atlas.pump();
  const set = texts.filter((text, i) =>
    drawn(atlas.quad(label({ text, x: i * 100 }))),
  );
  assert.deepStrictEqual(set, ['row 7'], 'the one at the focus');
});

test('one field draws a label at every size, so a zoom asks for nothing', async () => {
  const { atlas } = await atlasAt(2);
  atlas.beginPack();
  atlas.quad(label({ size: 11 }));
  await settle(atlas);
  const at11 = drawn(atlas.quad(label({ size: 11 })))!;
  assert.ok(at11, 'precondition: set');
  // every step of a zoom, and where it comes to rest
  for (const size of [12, 13, 14, 26, 5]) {
    atlas.beginPack();
    const q = drawn(atlas.quad(label({ size })));
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
    names.filter((text) => drawn(atlas.quad(label({ text }))) !== null).length;
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
  const before = drawn(atlas.quad(label({ text: 'node 0' })))!;
  assert.ok(before, 'precondition: node 0 is set');
  for (const text of names('edge')) atlas.quad(label({ text }));
  await settle(atlas);

  assert.ok(atlas.relocated, 'the fields moved: the world must be repacked');
  assert.ok(!atlas.wanting, 'and every one asked for was set');
  atlas.beginPack();
  const after = drawn(atlas.quad(label({ text: 'node 0' })));
  assert.ok(after, 'the label on screen survived the atlas filling');
  assert.strictEqual(after.w, before.w, 'from its own field');
  for (const text of names('edge')) {
    assert.ok(drawn(atlas.quad(label({ text }))), `${text} is drawn`);
  }
  const dropped = names('node')
    .slice(1)
    .filter((text) => drawn(atlas.quad(label({ text }))) === null);
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
  const q = drawn(atlas.quad(long))!;
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
  const zoomed = drawn(
    atlas.quad({ ...long, size: 13 * 1.7, maxWidth: 80 * 1.7 }),
  );
  assert.ok(zoomed, 'drawn at 1.7x from the field it has');
  assert.deepStrictEqual([zoomed.u0, zoomed.v0], [q.u0, q.v0]);
});

test('a centred label is centred on its anchor, as the 2D painter centres it', async () => {
  const { atlas, options } = await atlasAt(1);
  const centred = label({ align: 'center', baseline: 'middle' });
  atlas.quad(centred);
  await settle(atlas);
  const q = drawn(atlas.quad(centred))!;
  const { width, height } = measureText(options, centred.text, { size: 13 });
  // Measured at the base size and scaled: within a fraction of a pixel of
  // the 2D painter's own measure at 13.
  assert.ok(Math.abs(q.x - (100 - width / 2)) < 0.5, `left edge ${q.x}`);
  assert.ok(Math.abs(q.y - (50 - height / 2)) < 0.5, `top edge ${q.y}`);
});

test('a layout that answers its own coverage is set with no readback, a field the same slice', async () => {
  const { atlas, options } = await atlasAt(1);
  // The engine's coverage (react-x11#673), stood in for over the headless
  // server's layouts: the box covered, the pad clear.
  const fonts = options.fonts as unknown as {
    layout(...args: unknown[]): Record<string, unknown>;
  };
  const own = fonts.layout.bind(fonts);
  const asked: number[] = [];
  fonts.layout = (...args: unknown[]) => {
    const layout = own(...args) as { width: number; height: number };
    return Object.assign(layout, {
      coverage({ pad = 0 }: { pad?: number } = {}) {
        asked.push(pad);
        const width = Math.ceil(layout.width) + pad * 2;
        const height = Math.ceil(layout.height) + pad * 2;
        const data = new Uint8Array(width * height);
        for (let y = pad; y < height - pad; y++)
          for (let x = pad; x < width - pad; x++) data[y * width + x] = 255;
        return { width, height, data };
      },
    });
  };
  const names = ['node 1', 'node 2', 'node 3'];
  atlas.beginPack();
  for (const text of names) atlas.quad(label({ text }));
  // One slice whatever the machine: the budget is wall-clock, and a slow
  // runner spent 3 ms before the third field.
  atlas.fieldBudgetMs = Infinity;
  assert.strictEqual(await atlas.pump(), true, 'one slice');
  for (const text of names) {
    assert.ok(
      drawn(atlas.quad(label({ text }))),
      `${text} is drawable after it`,
    );
  }
  assert.ok(!atlas.wanting);
  assert.deepStrictEqual(
    asked,
    names.map(() => fieldPad(fieldBase(1))),
  );
  const q = drawn(atlas.quad(label({ text: 'node 1' })))!;
  assert.strictEqual(
    fieldOf(q).width,
    Math.ceil(baseWidth(options, 'node 1')) + fieldPad(fieldBase(1)) * 2,
    'the field is the layout box with its margin',
  );
});

test('a layout with no coverage of its own is set by drawing it and reading it back', async () => {
  // Every engine that cannot answer coverage — CoreText today, and any
  // engine before the release that added it — takes the staging surface.
  const { atlas, options } = await atlasAt(1);
  const fonts = options.fonts as unknown as {
    layout(...args: unknown[]): Record<string, unknown>;
  };
  const own = fonts.layout.bind(fonts);
  fonts.layout = (...args: unknown[]) => {
    const layout = own(...args);
    layout.coverage = undefined;
    return layout;
  };
  const names = ['node 1', 'node 2', 'node 3'];
  atlas.beginPack();
  for (const text of names) atlas.quad(label({ text }));
  await settle(atlas);
  for (const text of names) {
    const q = drawn(atlas.quad(label({ text })));
    assert.ok(q, `${text} is drawn`);
    assert.strictEqual(
      fieldOf(q).width,
      Math.ceil(baseWidth(options, text)) + fieldPad(fieldBase(1)) * 2,
      'from a field the size of the layout box and its margin',
    );
  }
});

test('the texture holds fields: white, the distance in alpha', async () => {
  const { atlas } = await atlasAt(1);
  atlas.quad(label());
  await settle(atlas);
  const q = drawn(atlas.quad(label()))!;
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
