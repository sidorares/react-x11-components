// <Html> — `filter`: its functions as computed and as they interpolate, the
// stacking context and the containing block a filter makes a box, and the
// colour functions run over what the box draws.
import { afterEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  expectPixel,
  pixelAt,
  renderX11,
  screen,
  waitFor,
  waitForPixel,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { animationClock } from '../../src/html/node.js';
import { FilterStore } from '../../src/html/filters.js';
import {
  applyMatrices,
  colourFilter,
  interpolateFilters,
} from '../../src/html/css/filter.js';
import { interpolateField } from '../../src/html/css/interpolate.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { holdClock } from '../held-clock.js';
import {
  FONTS,
  boxOf,
  h,
  render,
  render2x,
  renderWithBytes,
  solidPng,
  view,
} from './harness.js';

afterEach(cleanup);

/** The computed style of the element with `id`. */
function styleOf(node: Parameters<typeof view>[0], id: string): ComputedStyle {
  return (boxOf(view(node), id) as unknown as { style: ComputedStyle }).style;
}

/** A document on the in-process server, `width` wide, on white. */
async function drawn(source: string, width = 200) {
  return renderX11(
    h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, {
        source: '<body style="margin:0;background:#ffffff">' + source,
        partial: false,
        'data-testname': 'doc',
      }),
    ),
    { width: width + 40, height: 160, fonts: FONTS! },
  );
}

test('a filter list is read into its functions, an amount left out taking all of the effect, and what is no list is dropped', async () => {
  const { node } = await render(
    '<style>' +
      '#a { filter: grayscale() }' +
      '#b { filter: grayscale(50%) sepia(.25) hue-rotate(.5turn) }' +
      '#c { -webkit-filter: invert(1) }' +
      '#d { filter: brightness(2); filter: brightness(-1) }' +
      '#e { filter: blur(2px) drop-shadow(1px 2px 3px red) }' +
      '#f { filter: url(#f) opacity() }' +
      // Tailwind's: each part a `var()` with an empty fallback
      '#g { --tw-blur: blur(4px);' +
      ' filter: var(--tw-blur,) var(--tw-brightness,) var(--tw-grayscale,) }' +
      '#h { filter: var(--tw-blur,) var(--tw-brightness,) }' +
      '#i { filter: none }' +
      '</style>' +
      '<p id="a">a</p><p id="b">b</p><p id="c">c</p><p id="d">d</p>' +
      '<p id="e">e</p><p id="f">f</p><p id="g">g</p><p id="h">h</p>' +
      '<p id="i">i</p>',
  );
  assert.deepStrictEqual(styleOf(node, 'a').filter, [
    { fn: 'grayscale', amount: 1 },
  ]);
  assert.deepStrictEqual(styleOf(node, 'b').filter, [
    { fn: 'grayscale', amount: 0.5 },
    { fn: 'sepia', amount: 0.25 },
    { fn: 'hue-rotate', angle: 180 },
  ]);
  assert.deepStrictEqual(styleOf(node, 'c').filter, [
    { fn: 'invert', amount: 1 },
  ]);
  assert.deepStrictEqual(
    styleOf(node, 'd').filter,
    [{ fn: 'brightness', amount: 2 }],
    'a negative amount is no amount',
  );
  assert.deepStrictEqual(styleOf(node, 'e').filter, [
    { fn: 'blur', radius: 2 },
    { fn: 'drop-shadow', x: 1, y: 2, blur: 3, color: 'red' },
  ]);
  assert.deepStrictEqual(styleOf(node, 'f').filter, [
    { fn: 'url', url: '#f' },
    { fn: 'opacity', amount: 1 },
  ]);
  assert.deepStrictEqual(styleOf(node, 'g').filter, [
    { fn: 'blur', radius: 4 },
  ]);
  assert.strictEqual(styleOf(node, 'h').filter, null, 'every part empty');
  assert.strictEqual(styleOf(node, 'i').filter, null);
});

test('the colour functions come to the matrices Filter Effects 1 gives them, opacity() to an alpha, and a url() has the whole list ignored', () => {
  const run = (list: Parameters<typeof colourFilter>[0], rgba: number[]) => {
    const filter = colourFilter(list)!;
    const out = new Uint8ClampedArray(4);
    applyMatrices(Uint8ClampedArray.from(rgba), out, filter.matrices);
    return [...out];
  };
  const red = [255, 0, 0, 255];
  // Rec. 709's weights, which the spec's grayscale() and Chrome use
  assert.deepStrictEqual(
    run([{ fn: 'grayscale', amount: 1 }], red),
    [54, 54, 54, 255],
  );
  assert.deepStrictEqual(
    run([{ fn: 'grayscale', amount: 0.5 }], red),
    [155, 27, 27, 255],
  );
  // more than all of it is all of it
  assert.deepStrictEqual(
    run([{ fn: 'grayscale', amount: 3 }], red),
    [54, 54, 54, 255],
  );
  assert.deepStrictEqual(
    run([{ fn: 'invert', amount: 1 }], red),
    [0, 255, 255, 255],
  );
  assert.deepStrictEqual(
    run([{ fn: 'sepia', amount: 1 }], [255, 255, 255, 255]),
    [255, 255, 239, 255],
    'each channel clamped',
  );
  assert.deepStrictEqual(
    run([{ fn: 'brightness', amount: 0.5 }], [255, 255, 255, 128]),
    [128, 128, 128, 128],
    'alpha left as it is',
  );
  assert.deepStrictEqual(
    run([{ fn: 'contrast', amount: 0 }], [10, 200, 90, 255]),
    [128, 128, 128, 255],
  );
  // each function's result clamped before the next: brightness(2) of a
  // light grey is white, and white's inverse black
  assert.deepStrictEqual(
    run(
      [
        { fn: 'brightness', amount: 2 },
        { fn: 'invert', amount: 1 },
      ],
      [200, 200, 200, 255],
    ),
    [0, 0, 0, 255],
  );
  assert.deepStrictEqual(
    run(
      [
        { fn: 'hue-rotate', angle: 360 },
        { fn: 'invert', amount: 1 },
      ],
      red,
    ),
    [0, 255, 255, 255],
    'a full turn is none',
  );
  const faded = colourFilter([
    { fn: 'opacity', amount: 0.5 },
    { fn: 'opacity', amount: 0.5 },
  ])!;
  assert.deepStrictEqual([faded.matrices.length, faded.alpha], [0, 0.25]);
  assert.strictEqual(
    colourFilter([
      { fn: 'grayscale', amount: 0 },
      { fn: 'saturate', amount: 1 },
    ]),
    null,
    'nothing to run',
  );
  assert.strictEqual(
    colourFilter([
      { fn: 'url', url: '#missing' },
      { fn: 'invert', amount: 1 },
    ]),
    null,
  );
  assert.strictEqual(
    colourFilter([{ fn: 'blur', radius: 4 }])?.partial ?? null,
    null,
    'a blur alone is nothing the colour pass does',
  );
});

test('two filter lists interpolate function by function, `none` and a shorter list filled out with functions at nothing, and lists not alike go over at half-way', () => {
  const at = (a: unknown, b: unknown, q: number) =>
    interpolateField('filter', a, b, q);
  assert.deepStrictEqual(
    at(
      [{ fn: 'grayscale', amount: 1 }],
      [{ fn: 'grayscale', amount: 0 }],
      0.25,
    ),
    [{ fn: 'grayscale', amount: 0.75 }],
  );
  assert.deepStrictEqual(
    at(null, [{ fn: 'brightness', amount: 2 }], 0.5),
    [{ fn: 'brightness', amount: 1.5 }],
    'brightness() at nothing is 1',
  );
  assert.deepStrictEqual(
    at(
      [{ fn: 'invert', amount: 1 }],
      [
        { fn: 'invert', amount: 0 },
        { fn: 'hue-rotate', angle: 90 },
      ],
      0.5,
    ),
    [
      { fn: 'invert', amount: 0.5 },
      { fn: 'hue-rotate', angle: 45 },
    ],
  );
  assert.strictEqual(
    at([{ fn: 'invert', amount: 1 }], [{ fn: 'sepia', amount: 1 }], 0.5),
    undefined,
    'not alike',
  );
  assert.strictEqual(
    interpolateFilters(
      [{ fn: 'url', url: '#a' }],
      [{ fn: 'url', url: '#b' }],
      0.5,
      () => 0,
    ),
    undefined,
  );
});

test('a filter makes a box the containing block of the absolute and the fixed boxes in it, an inline box as well', async () => {
  const { node } = await render(
    '<style>body { margin: 0 } .f { filter: grayscale(0) }' +
      '.at { position: absolute; left: 0; top: 0; width: 4px; height: 4px }' +
      '.fixed { position: fixed; left: 0; top: 0; width: 4px; height: 4px }' +
      '</style>' +
      '<div class="f" style="margin: 30px 0 0 50px; height: 10px">' +
      '<div id="a" class="at"></div><div id="b" class="fixed"></div></div>' +
      '<div style="margin: 30px 0 0 50px; height: 10px">' +
      '<div id="c" class="at"></div></div>' +
      '<p style="margin: 0 0 0 70px">x <span class="f">y' +
      '<span id="d" class="at"></span></span></p>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([a.x, a.y], [50, 30], 'the absolute box');
  assert.deepStrictEqual([b.x, b.y], [50, 30], 'the fixed box');
  const c = boxOf(el, 'c');
  assert.deepStrictEqual([c.x, c.y], [0, 0], 'no filter, no containing block');
  assert.ok(boxOf(el, 'd').x > 70, 'the inline box holds it');
});

test('a filter makes a box a stacking context, which paints a box with a negative z-index in it over its background', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  const result = await drawn(
    '<div style="filter:grayscale(0);height:20px;background:#0000ff">' +
      '<div style="position:absolute;z-index:-1;left:0;top:0;width:20px;' +
      'height:20px;background:#00ff00"></div></div>' +
      '<div style="height:20px;background:#0000ff">' +
      '<div style="position:absolute;z-index:-1;left:0;top:20px;width:20px;' +
      'height:20px;background:#00ff00"></div></div>',
  );
  await expectPixel(result.ctx, 10, 10, '#00ff00', {
    message: 'over the filtered box',
  });
  await expectPixel(result.ctx, 10, 30, '#0000ff', {
    message: 'and under one with no filter',
  });
});

test("a filter's colour functions are run over the box and all it draws, an absolute box in it as well", async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  const result = await drawn(
    '<div style="filter:grayscale();height:20px;background:#ff0000">' +
      '<div style="position:absolute;left:60px;top:0;width:20px;' +
      'height:20px;background:#ff0000"></div></div>' +
      '<div style="filter:invert(1);height:20px;background:#ff0000"></div>' +
      '<div style="filter:sepia(1);height:20px;background:#ffffff"></div>' +
      '<div style="filter:brightness(.5) opacity(.5);height:20px;' +
      'background:#000000"></div>' +
      '<div style="filter:url(#nothing) invert(1);height:20px;' +
      'background:#ff0000"></div>',
  );
  // drawn once unfiltered, read back, and drawn again from what was read
  await waitForPixel(result.ctx, 10, 10, '#363636', {
    message: 'grayscale() of red',
  });
  await expectPixel(result.ctx, 70, 10, '#363636', {
    message: 'the absolute box it holds',
  });
  await waitForPixel(result.ctx, 10, 30, '#00ffff', { message: 'invert(1)' });
  await waitForPixel(result.ctx, 10, 50, '#ffffef', { message: 'sepia(1)' });
  await waitForPixel(result.ctx, 10, 70, '#808080', {
    tolerance: 3,
    message: 'black at half over white',
  });
  await expectPixel(result.ctx, 10, 90, '#ff0000', {
    message: 'a list with a url() in it is ignored',
  });
});

test('a filtered image is drawn through the colour functions, and so is a filter inside a filter', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  const { result } = await renderWithBytes(
    '<body style="margin:0;background:#ffffff">' +
      '<img src="red.png" style="display:block;filter:grayscale()">' +
      '<div style="filter:grayscale(1)"><div style="filter:invert(1);' +
      'height:20px;background:#ff0000"></div></div>',
    { 'red.png': solidPng(40, 20, [255, 0, 0]) },
  );
  await waitForPixel(result.ctx, 10, 10, '#363636', {
    message: 'the image in grey',
  });
  // red inverted is cyan, and cyan in grey Rec. 709's green and blue
  await waitForPixel(result.ctx, 10, 30, '#c9c9c9', {
    message: 'grayscale(invert(red))',
  });
});

test('a filter at 2x is run over the device pixels the box covers, and no more', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  const { result } = await render2x(
    '<body style="margin:0;background:#ffffff">' +
      '<div style="filter:invert(1);width:40px;height:20px;' +
      'background:#ff0000"></div>',
  );
  // the document is at 20 logical pixels in, 40 device
  await waitForPixel(result.ctx, 40 + 78, 40 + 38, '#00ffff', {
    message: 'inside the box',
  });
  await expectPixel(result.ctx, 40 + 82, 40 + 38, '#ffffff', {
    message: 'past its right edge, 80 device pixels in',
  });
});

test('a hover that transitions a filter draws each frame through the filter it has then, from what was read once', async (t: TestContext) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  const clock = holdClock(t, animationClock);
  const result = await drawn(
    '<style>#a { height: 20px; background: #ff0000; filter: grayscale();' +
      ' transition: filter 160ms linear }' +
      '#a:hover { filter: grayscale(0) }</style><div id="a"></div>',
  );
  const ctx = result.ctx;
  await waitForPixel(ctx, 10, 10, '#363636', { message: 'at rest' });
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const abs = (el as unknown as DrawnNode).abs;
  el.setHover(abs.x + 4, abs.y + 4);
  await act();
  const at = async (ms: number) => {
    while (animationClock.now() + 16 <= ms) {
      if (!(await clock.frame())) break;
    }
    await act();
  };
  await at(80);
  // half-way, painted in the frame itself rather than a read later
  await expectPixel(ctx, 10, 10, '#9b1b1b', {
    tolerance: 4,
    message: 'grayscale(.5) of red',
  });
  await at(176);
  await expectPixel(ctx, 10, 10, '#ff0000', {
    message: 'grayscale(0) is red',
  });
  assert.strictEqual(clock.pending, false, 'over');
  const [r] = await pixelAt(ctx, 10, 10);
  assert.strictEqual(r, 255);
});

test('a filter transition on a page an animation builds again at every frame draws each frame at the amount it has then', async (t: TestContext) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // ekazinich.com: its hero's screenshots go from grey to colour as a card
  // is hovered, on a page whose other animations build the document again.
  // A build left the pixels read for the box behind, and those frames drew
  // what was filtered last, at the amount it had then: the hover flashed
  // between grey and colour.
  const clock = holdClock(t, animationClock);
  const result = await drawn(
    '<style>#a { height: 20px; background: #ff0000; filter: grayscale();' +
      ' transition: filter 320ms linear }' +
      '#a:hover { filter: grayscale(0) }' +
      '@keyframes grow { from { width: 10px } to { width: 50px } }' +
      '#b { height: 4px; background: #0000ff; animation: grow 1s infinite }' +
      '</style><div id="a"></div><div id="b"></div>',
  );
  const ctx = result.ctx;
  await waitForPixel(ctx, 10, 10, '#363636', { message: 'at rest' });
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const abs = (el as unknown as DrawnNode).abs;
  el.setHover(abs.x + 4, abs.y + 4);
  await act();
  const red = Uint8ClampedArray.of(255, 0, 0, 255);
  for (let frame = 0; frame < 12; frame += 1) {
    await clock.frame();
    await act();
    const amount = (
      boxOf(el, 'a') as unknown as { style: ComputedStyle }
    ).style.filter!.map((f) => ('amount' in f ? f.amount : 0))[0];
    const want = new Uint8ClampedArray(4);
    const colour = colourFilter([{ fn: 'grayscale', amount }]);
    if (colour) applyMatrices(red, want, colour.matrices);
    else want.set(red);
    const [r, g] = await pixelAt(ctx, 10, 10);
    assert.ok(
      Math.abs(r - want[0]) <= 4 && Math.abs(g - want[1]) <= 4,
      `frame ${frame}, grayscale(${amount.toFixed(3)}): ` +
        `drew ${r},${g}, wanted ${want[0]},${want[1]}`,
    );
  }
});

test('a filtered box a hover moves a fraction of a pixel at a time is drawn at every frame, at the amount it has then', async (t: TestContext) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // ekazinich.com's card is lifted as it turns to colour: its corner fell
  // on a new fraction of a pixel each frame, the box came to one height
  // and the next alternately, and a frame whose read was the other height
  // drew nothing
  const clock = holdClock(t, animationClock);
  const sizes = new Set<string>();
  const at = FilterStore.prototype.at;
  t.mock.method(
    FilterStore.prototype,
    'at',
    function (this: FilterStore, ...args: Parameters<typeof at>) {
      sizes.add(`${args[3]}x${args[4]}`);
      return at.apply(this, args);
    },
  );
  let reads = 0;
  const read = FilterStore.prototype.read;
  t.mock.method(
    FilterStore.prototype,
    'read',
    function (this: FilterStore, ...args: Parameters<typeof read>) {
      reads += 1;
      return read.apply(this, args);
    },
  );
  const result = await drawn(
    '<style>#a { height: 20px; background: #ff0000; filter: grayscale();' +
      ' transition: filter 320ms linear, transform 320ms linear }' +
      '#a:hover { filter: grayscale(0.5); transform: translateY(-3.7px) }' +
      '</style><div style="height:7px"></div><div id="a"></div>',
  );
  const ctx = result.ctx;
  await waitForPixel(ctx, 10, 17, '#363636', { message: 'at rest' });
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const abs = (el as unknown as DrawnNode).abs;
  el.setHover(abs.x + 4, abs.y + 12);
  await act();
  const red = Uint8ClampedArray.of(255, 0, 0, 255);
  let started = 0;
  for (let frame = 0; frame < 12; frame += 1) {
    await clock.frame();
    await act();
    // the transition's start builds the boxes again, which reads
    if (frame === 1) started = reads;
    const style = (boxOf(el, 'a') as unknown as { style: ComputedStyle }).style;
    const amount = style.filter!.map((f) => ('amount' in f ? f.amount : 0))[0];
    const want = new Uint8ClampedArray(4);
    const colour = colourFilter([{ fn: 'grayscale', amount }]);
    if (colour) applyMatrices(red, want, colour.matrices);
    else want.set(red);
    const [r, g] = await pixelAt(ctx, 10, 17);
    assert.ok(
      Math.abs(r - want[0]) <= 4 && Math.abs(g - want[1]) <= 4,
      `frame ${frame}, grayscale(${amount.toFixed(3)}): ` +
        `drew ${r},${g}, wanted ${want[0]},${want[1]}`,
    );
  }
  assert.deepStrictEqual([...sizes], ['201x21'], 'one size, moving or not');
  // a move a fraction of a pixel at a time asks for no read: each frame
  // drew the box from the last read, resampled, where reads landing between
  // frames drew it crisp between them and it shimmered
  const moving = reads;
  assert.strictEqual(moving - started, 0, 'no read as it moved');
  // and once it has been still a while it is read where it is
  await clock.finish();
  await act();
  const store = (el as unknown as { _filtered: FilterStore })._filtered;
  const kept = store.at(
    boxOf(el, 'a').el as object,
    '',
    boxOf(el, 'a'),
    201,
    21,
    (
      store as unknown as { kept: Map<object, Map<string, { key: string }>> }
    ).kept
      .get(boxOf(el, 'a').el as object)!
      .get('')!.key,
  );
  await waitFor(() => assert.ok(reads > moving, 'read again once still'));
  await waitFor(() => assert.ok(kept.fresh, 'and drawn from it'));
  assert.deepStrictEqual(
    [kept.rawX, kept.rawY],
    [kept.phaseX, kept.phaseY],
    'from pixels at its own fraction',
  );
});

test("a context that runs a filter itself is handed the group, kept and drawn through canvas's filter again only as it or the filter changes, and one that does not is remembered", () => {
  // react-x11's native context runs the colour functions as canvas's
  // `filter`; ntk's has none. A context records what it was asked.
  const drawn: string[] = [];
  let made = 0;
  const surface = (runs: boolean) => {
    const name = `surface ${++made}`;
    const ctx: Record<string, unknown> = {
      save() {},
      restore() {},
      clearRect: () => drawn.push(`clear ${name}`),
      drawImage: (image: { name: string }) =>
        drawn.push(`draw ${image.name} on ${name} through ${ctx.filter}`),
    };
    let filter = 'none';
    if (runs) {
      Object.defineProperty(ctx, 'filter', {
        get: () => filter,
        set: (v: string) => {
          // as the native context: blur does not stick
          if (!/blur/.test(v)) filter = v;
        },
      });
    }
    return { name, getContext: () => ctx, destroy() {} };
  };
  const runs = new FilterStore(
    null,
    () => {},
    undefined,
    () => surface(true),
  );
  const el = {};
  const kept = runs.at(el, '', {}, 30, 20, 'k');
  const colour = colourFilter([
    { fn: 'grayscale', amount: 0.5 },
    { fn: 'hue-rotate', angle: 90 },
    { fn: 'opacity', amount: 0.5 },
  ])!;
  assert.strictEqual(colour.css, 'grayscale(0.5) hue-rotate(90deg)');
  assert.ok(runs.group(kept), 'the group, for the caller to paint');
  assert.strictEqual(kept.fresh, true);
  const out = runs.through(kept, colour.css);
  assert.ok(out);
  assert.strictEqual(runs.through(kept, colour.css), out, 'nothing changed');
  assert.ok(runs.through(kept, 'invert(1)'), 'another filter');
  assert.deepStrictEqual(drawn, [
    'clear surface 2',
    'draw surface 1 on surface 2 through grayscale(0.5) hue-rotate(90deg)',
    'clear surface 2',
    'draw surface 1 on surface 2 through invert(1)',
  ]);
  runs.stale(el, '');
  assert.strictEqual(kept.fresh, false, 'painted again as the box changes');
  assert.ok(runs.group(kept));
  assert.deepStrictEqual(drawn.at(-1), 'clear surface 1', 'the same surface');
  assert.strictEqual(runs.through(kept, 'blur(2px)'), null);
  assert.strictEqual(runs.unfiltered, true, 'a list that did not stick');
  assert.strictEqual(kept.fresh, false, 'and a read is asked for');
  const none = new FilterStore(
    null,
    () => {},
    undefined,
    () => surface(false),
  );
  const other = none.at(el, '', {}, 30, 20, 'k');
  assert.ok(none.group(other));
  assert.strictEqual(none.through(other, colour.css), null);
  assert.strictEqual(none.unfiltered, true, 'no filter at all');
});
