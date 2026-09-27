// `src/flow/draw.ts` — the painter, over a font engine and a context that
// only record: which strings are shaped, at what sizes, and what reaches the
// context when a label is drawn at a size it was not shaped at.
//
// A zoom step in the 2D renderer re-shaped every label on screen at a size
// the next step moved off, and that was half of what the step cost. Mid-zoom
// (`approximateText`) a label is drawn from the size nearest it that was
// shaped already, scaled through the context; outside one, every size is its
// own.
import { test } from 'node:test';
import assert from 'node:assert';

import { createPainter, measureText } from '../src/flow/draw.js';
import type { PainterOptions } from '../src/flow/draw.js';

type Call = [string, ...unknown[]];

/** Text as wide as half its size per character, and every shaping counted. */
function engine(): { fonts: PainterOptions['fonts']; shaped: number[] } {
  const shaped: number[] = [];
  const fonts = {
    layout(text: string, style: Record<string, unknown>) {
      const size = style.size as number;
      shaped.push(size);
      return {
        width: text.length * size * 0.5,
        height: size * 1.25,
        draw(ctx: unknown, x: number, y: number) {
          (ctx as { calls: Call[] }).calls.push(['draw', text, x, y]);
        },
      };
    },
  };
  return { fonts: fonts as unknown as PainterOptions['fonts'], shaped };
}

/** A context that records the calls a label makes, and no-ops the rest. */
function context(): { calls: Call[] } {
  const calls: Call[] = [];
  const ctx: Record<string, unknown> = { calls };
  for (const name of ['save', 'restore', 'translate', 'scale']) {
    ctx[name] = (...args: unknown[]) => calls.push([name, ...args]);
  }
  for (const name of [
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'rect',
    'arc',
    'fill',
    'stroke',
    'clip',
    'fillRect',
  ]) {
    ctx[name] = () => undefined;
  }
  return ctx as unknown as { calls: Call[] };
}

function options(fonts: PainterOptions['fonts']): PainterOptions {
  return { fonts, family: 'sans', color: '#000', scale: 1, cache: new Map() };
}

test('mid-zoom, a label is drawn from the size it was shaped at, scaled', () => {
  const { fonts, shaped } = engine();
  const opts = options(fonts);
  const ctx = context();
  createPainter(ctx, opts)!.text('hello', 10, 20, { size: 13 });
  assert.deepStrictEqual(shaped, [13]);

  ctx.calls.length = 0;
  createPainter(ctx, { ...opts, approximateText: true })!.text(
    'hello',
    10,
    20,
    {
      size: 26,
    },
  );
  assert.deepStrictEqual(shaped, [13], 'nothing shaped again');
  assert.deepStrictEqual(ctx.calls, [
    ['save'],
    ['translate', 10, 20],
    ['scale', 2, 2],
    ['draw', 'hello', 0, 0],
    ['restore'],
  ]);
  // and measured the way it is drawn: its own size's width, from the other
  assert.strictEqual(
    measureText({ ...opts, approximateText: true }, 'hello', { size: 26 })
      .width,
    2 * measureText(opts, 'hello', { size: 13 }).width,
  );
});

test('outside a zoom, every size is shaped at itself', () => {
  const { fonts, shaped } = engine();
  const opts = options(fonts);
  const ctx = context();
  const painter = createPainter(ctx, opts)!;
  painter.text('hello', 0, 0, { size: 13 });
  painter.text('hello', 0, 0, { size: 26 });
  assert.deepStrictEqual(shaped, [13, 26]);
  assert.ok(
    ctx.calls.every(([name]) => name === 'draw'),
    'no transform at all',
  );
});

test('a string never shaped is shaped at its own size, even mid-zoom', () => {
  const { fonts, shaped } = engine();
  const opts: PainterOptions = { ...options(fonts), approximateText: true };
  const ctx = context();
  const painter = createPainter(ctx, opts)!;
  painter.text('new', 0, 0, { size: 20 });
  assert.deepStrictEqual(shaped, [20], 'nothing nearer to draw from');
  painter.text('new', 0, 0, { size: 22 });
  assert.deepStrictEqual(shaped, [20], 'and then that is the nearest');
});

test('the nearest size shaped is the one drawn, by ratio', () => {
  const { fonts } = engine();
  const opts = options(fonts);
  const plain = createPainter(context(), opts)!;
  plain.text('x', 0, 0, { size: 10 });
  plain.text('x', 0, 0, { size: 20 });
  const scaleFor = (size: number): unknown => {
    const ctx = context();
    createPainter(ctx, { ...opts, approximateText: true })!.text('x', 0, 0, {
      size,
    });
    return ctx.calls.find(([name]) => name === 'scale')?.[1] ?? 1;
  };
  assert.strictEqual(scaleFor(18), 18 / 20);
  assert.strictEqual(scaleFor(13), 13 / 10, '13 is nearer 10 than 20 by ratio');
  assert.strictEqual(scaleFor(20), 1, 'a size of its own is drawn as it is');
});
