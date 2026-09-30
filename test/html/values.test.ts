// <Html> — lengths, units, colours, calc() and its kin, custom properties.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, pixelAt, waitFor } from 'react-x11/test';
import {
  isTransparent,
  parseColor,
  parseLength,
  parseNumber,
  resolve,
  resolveOrNull,
  splitValue,
} from '../../src/html/css/values.js';
import { boxOf, metric, render, renderWithBytes, view } from './harness.js';

afterEach(cleanup);

test('lengths resolve the units a computed style can, and keep the ones it cannot', () => {
  const ctx = { em: 20, rem: 16, vw: 1000, vh: 500, scale: 1 };
  assert.strictEqual(parseLength('10px', ctx), 10);
  assert.strictEqual(parseLength('2em', ctx), 40);
  assert.strictEqual(parseLength('2rem', ctx), 32);
  assert.strictEqual(parseLength('12pt', ctx), 16);
  assert.strictEqual(parseLength('10vw', ctx), 100);
  assert.deepStrictEqual(parseLength('50%', ctx), { pct: 50 });
  assert.strictEqual(parseLength('auto', ctx), 'auto');
  // a bare number is not a length, which is what keeps `line-height: 1.5`
  // from being read as 1.5 pixels
  assert.strictEqual(parseLength('1.5', ctx), null);
});

test('at a display scale of 2 the absolute units are two device pixels each', () => {
  // `em`, `rem` and the viewport arrive device already (react-x11's
  // docs/scale.md), so only the CSS-pixel units carry the factor.
  const ctx = { em: 40, rem: 32, vw: 2000, vh: 1000, scale: 2 };
  assert.strictEqual(parseLength('10px', ctx), 20);
  assert.strictEqual(parseLength('12pt', ctx), 32);
  assert.strictEqual(parseLength('1in', ctx), 192);
  assert.strictEqual(parseLength('2em', ctx), 80);
  assert.strictEqual(parseLength('2rem', ctx), 64);
  assert.strictEqual(parseLength('10vw', ctx), 200);
  assert.strictEqual(parseLength('600', ctx, true), 1200);
  assert.deepStrictEqual(parseLength('50%', ctx), { pct: 50 });
});

test('splitValue keeps functions and quotes whole', () => {
  assert.deepStrictEqual(splitValue('1px solid rgb(1, 2, 3)'), [
    '1px',
    'solid',
    'rgb(1, 2, 3)',
  ]);
  assert.deepStrictEqual(splitValue('url(a b.png) no-repeat'), [
    'url(a b.png)',
    'no-repeat',
  ]);
});

test('transparency is answered without parsing a colour', () => {
  assert.ok(isTransparent('transparent'));
  assert.ok(isTransparent(null));
  assert.ok(isTransparent('rgba(0,0,0,0)'));
  assert.ok(!isTransparent('#fff'));
  assert.ok(!isTransparent('rgba(0,0,0,0.5)'));
});

metric('a malformed colour does not reach paint', async () => {
  const { result } = await render(
    '<style>p{color:rgb(foo)} div{margin:0;color:rgb(0, 128, 0</style>' +
      '<p>ignored</p><div>green</div>',
  );
  // drawn at all is most of the assertion: it threw from paint before
  await waitFor(async () => {
    const ctx = result.ctx;
    let green = 0;
    for (let x = 8; x < 60; x += 1) {
      for (let y = 30; y < 90; y += 2) {
        const [r, g, b] = await pixelAt(ctx, x, y);
        if (g > 90 && r < 60 && b < 60) green += 1;
      }
    }
    assert.ok(green > 0, 'the unclosed rgb( drew its text green');
  });
});

metric(
  'a hex colour of five or seven digits is none, and does not throw from paint',
  async () => {
    const { el } = await renderWithBytes(
      '<p id="p" style="color:#ff000">five</p>' +
        '<div id="d" style="color:#00f;color:#ff00000;background:#ff00000">seven</div>' +
        '<div id="e" style="color:#0f08;background:#00ff0080">four, eight</div>',
      {},
    );
    // drawn at all is most of the assertion: both threw from paint before
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    assert.notStrictEqual(style('p').color, '#ff000');
    assert.strictEqual(style('d').color, '#00f');
    assert.strictEqual(style('d').backgroundColor, null);
    assert.strictEqual(style('e').color, '#0f08');
    assert.strictEqual(style('e').backgroundColor, '#00ff0080');
  },
);

metric("ex is the font's x-height, or half an em", async () => {
  const { node } = await render(
    '<div id="d" style="width:10ex;height:10px;font-size:20px"></div>',
  );
  const el = view(node);
  const fonts = (
    el as unknown as {
      app: {
        fonts: {
          match(
            f: string,
            s: object,
          ): { metrics(size: number): { xHeight?: number | null } };
        };
      };
    }
  ).app.fonts;
  // DejaVu Sans, which the Linux runs find, has an OS/2 table too old to
  // state an x-height, and the engine answers NaN; an ex is half an em then
  const stated = fonts.match('sans-serif', { size: 20 }).metrics(20).xHeight;
  const x = typeof stated === 'number' && stated > 0 ? stated : 10;
  assert.ok(Math.abs(boxOf(el, 'd').width - 10 * x) < 0.01);
});

metric('a ch is the advance of the font\'s "0"', async () => {
  // CSS Values 4, 6.1.1. It was half an em, which is a monospace font's
  // "0" short by a sixth: Tailwind's `max-w-prose` is 65ch, and a `20ch`
  // column of code held seventeen characters
  const { node } = await render(
    '<style>body{margin:0} div{font:20px monospace}</style>' +
      '<div id="a" style="width:10ch;height:10px"></div>' +
      '<div><span id="b" style="display:inline-block">0000000000</span></div>',
  );
  const el = view(node);
  const b = boxOf(el, 'b').width;
  assert.ok(b > 100, `ten zeros are wider than ten half ems: ${b}`);
  // the zeros laid out are rounded up to a 64th, as a browser rounds an
  // element's text on a line, and a length is not: Chrome's 10ch at 20px
  // Menlo is 120.40625, its ten zeros 120.421875
  assert.ok(
    Math.abs(boxOf(el, 'a').width - b) <= 1 / 64 + 1e-9,
    `ten of a ch are ten zeros: ${boxOf(el, 'a').width}, ${b}`,
  );
});

test('a negative size is no size, and the declaration goes', async () => {
  // CSS 2.1 10.2, 10.4, 10.5, 10.7: -1px was taken as a maximum height
  const { node } = await render(
    '<div id="a" style="height:40px;max-height:-1px"></div>' +
      '<div id="b" style="width:30px;width:-10px;min-height:-5px;height:20px"></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 40);
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([b.width, b.height], [30, 20]);
});

test('calc() and its kin come down to pixels and a percentage of what layout knows', () => {
  const ctx = { em: 20, rem: 16, vw: 1000, vh: 500, scale: 1 };
  const len = (v: string) => parseLength(v, ctx);
  assert.deepStrictEqual(len('calc(100% - 20px)'), { pct: 100, px: -20 });
  assert.deepStrictEqual(len('calc((100% - 20px) / 2)'), { pct: 50, px: -10 });
  assert.deepStrictEqual(len('-webkit-calc(100% - 1px)'), { pct: 100, px: -1 });
  assert.strictEqual(len('calc(2em + 4px)'), 44);
  // `+` and `-` want white space on both sides
  assert.strictEqual(len('calc(1px+2px)'), null);
  assert.strictEqual(len('calc(100% -1px)'), null);
  // a number is no length, and a division by zero no value
  assert.strictEqual(len('calc(1 + 2)'), null);
  assert.strictEqual(len('calc(10px / 0)'), null);
  assert.strictEqual(parseNumber('calc(1 + 0.5)'), 1.5);
  // with no percentage in them, the comparisons come to a length
  assert.strictEqual(len('min(10px, 2em)'), 10);
  assert.strictEqual(len('max(10px, 2em)'), 40);
  assert.strictEqual(len('clamp(10px, 50px, 20px)'), 20);
  // with one, to a sum for each width: a column 600px at most
  const column = len('min(100%, 600px)')!;
  assert.strictEqual(resolve(column, 400), 400);
  assert.strictEqual(resolve(column, 1000), 600);
  const inset = len('calc(min(100%, 600px) - 20px)')!;
  assert.strictEqual(resolve(inset, 400), 380);
  assert.strictEqual(resolve(inset, 1000), 580);
  // taking a minimum away, or scaling it by less than nothing, turns it over
  assert.strictEqual(resolve(len('calc(100px - min(10%, 50px))')!, 1000), 50);
  assert.strictEqual(resolve(len('calc(-1 * min(100%, 50px))')!, 1000), -50);
  assert.strictEqual(len('calc(1px -(2px))'), null);
  // a percentage the sum cancels is still one against a height nothing sets
  const cancelled = len('calc(40px + 10% - 20% / 2)')!;
  assert.strictEqual(resolve(cancelled, 100), 40);
  assert.strictEqual(resolveOrNull(cancelled, NaN), null);
});

metric(
  'a calc() width, margin and padding are of the containing block',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>body { margin: 0; width: 400px }' +
        '#f { display: flex; width: 300px } #f > div { width: calc(50% - 10px) }' +
        '</style></head><body>' +
        '<div id="a" style="width: calc(100% - 40px); margin-left: calc(10px + 5%); ' +
        'padding-top: calc(30px - 10%); padding-left: calc(30px - 1%)">a</div>' +
        '<div id="f"><div id="f1">b</div><div>c</div></div></body></html>',
      {},
    );
    const a = boxOf(el, 'a') as unknown as {
      x: number;
      width: number;
      padTop: number;
      padLeft: number;
    };
    // the content box, less the padding the calc() on the left comes to
    assert.strictEqual(a.width, 360 + 26);
    assert.strictEqual(a.x, 30);
    // thirty pixels less forty is none: a padding is never negative
    assert.strictEqual(a.padTop, 0);
    // and one with a percentage has no sign until then
    assert.strictEqual(a.padLeft, 26);
    assert.strictEqual(boxOf(el, 'f1').width, 140);
  },
);

metric(
  "a child's width of its own is what it gives a float, and a minimum's percentage is of zero",
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>body { font-size: 10px } body > div { float: left; clear: left }' +
        '.wide { width: 200px; height: 1px } i { display: inline-block; width: 10px }' +
        '</style></head><body>' +
        '<div id="a"><div style="width: 47px"><div class="wide"></div></div></div>' +
        '<div id="b"><div style="width: 50%"><div class="wide"></div></div></div>' +
        '<div id="c"><div style="width: 1px; min-width: calc(5em - 0%)"><div class="wide"></div></div></div>' +
        '<div id="d" style="text-indent: calc(50% - 3px)"><i></i></div></body></html>',
      {},
    );
    // its content runs past a width of its own, and counts for nothing
    assert.strictEqual(boxOf(el, 'a').width, 47);
    // a percentage is cyclic here, and the content decides
    assert.strictEqual(boxOf(el, 'b').width, 200);
    assert.strictEqual(boxOf(el, 'c').width, 50);
    // the inline-block is where its line puts it, three pixels in the margin
    assert.strictEqual(boxOf(el, 'd').width, 7);
  },
);

metric(
  'a percentage offset or minimum is of a height the containing block sets',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>body { margin: 0 } .fixed { height: 100px }' +
        '.inner { height: 10px }</style></head><body>' +
        '<div class="fixed"><div id="r1" style="position: relative; top: 50%" class="inner"></div></div>' +
        '<div><div id="r2" style="position: relative; top: calc(25px + 50%)" class="inner"></div></div>' +
        '<div><div id="m" style="min-height: calc(25px + 50%)"><div class="inner"></div></div></div>' +
        '</body></html>',
      {},
    );
    const y = (id: string) => boxOf(el, id).y;
    assert.strictEqual(y('r1'), 50);
    // against a height its content decides, the offset is `auto`
    assert.strictEqual(y('r2'), 100);
    // and a minimum's percentage is none, which leaves the calc() its pixels
    assert.strictEqual(boxOf(el, 'm').height, 25);
  },
);

metric('z-index is an integer, and a calc() rounds to one', async () => {
  const { el } = await renderWithBytes(
    '<p id="a" style="z-index: 1.5">a</p>' +
      '<p id="b" style="z-index: calc(3 / 2)">b</p>' +
      '<p id="c" style="z-index: calc(-3 / 2)">c</p>',
    {},
  );
  const z = (id: string) =>
    (boxOf(el, id) as unknown as { style: { zIndex: unknown } }).style.zIndex;
  assert.strictEqual(z('a'), 'auto');
  assert.strictEqual(z('b'), 2);
  assert.strictEqual(z('c'), -1);
});

metric(
  'a custom property is inherited, and a var() reads it before the declaration is',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>' +
        ':root { --brand: #00ff00; --gap: 12px; --tw: 59 130 246 }' +
        '.card { --brand: #0000ff }' +
        'p { color: var(--brand); margin: var(--gap) 0; ' +
        'background-color: rgb(var(--tw) / 1); width: calc(var(--gap) * 10) }' +
        '#b { padding-left: var(--missing, 7px) }' +
        '</style></head><body><p id="a">a</p>' +
        '<div class="card"><p id="b">b</p></div></body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(style('a').color, '#00ff00');
    assert.strictEqual(style('a').marginTop, 12);
    // Tailwind 3 writes its colours this way, and `calc()` reads one too
    assert.strictEqual(style('a').backgroundColor, '#3b82f6');
    assert.strictEqual(style('a').width, 120);
    // the nearer one wins, and a fallback stands in for none
    assert.strictEqual(style('b').color, '#0000ff');
    assert.strictEqual(style('b').paddingLeft, 7);
  },
);

metric(
  'a var() with no value leaves its property unset, and a malformed one is no declaration',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>body { color: #00ff00 } p { margin-top: 3px }' +
        '#a { color: red; color: var(--none) }' +
        '#b { margin-top: 9px; margin-top: var(--none) }' +
        // two words where a colour goes: invalid once substituted
        '#c { --x: red; --y: blue; color: red; color: var(--x) var(--y) }' +
        // a cycle has no value, whatever its fallbacks say
        '#d { --p: var(--q, red); --q: var(--p, red); color: var(--p, #0000ff) }' +
        // and a fallback with a `;` in it makes no declaration at all
        '#e { color: #0000ff; color: var(--x,;) }' +
        '</style></head><body><p id="a">a</p><p id="b">b</p><p id="c">c</p>' +
        '<p id="d">d</p><p id="e">e</p></body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    // `color` inherits, so unset is the body's
    assert.strictEqual(style('a').color, '#00ff00');
    // `margin` does not, so unset is its initial value
    assert.strictEqual(style('b').marginTop, 0);
    assert.strictEqual(style('c').color, '#00ff00');
    assert.strictEqual(style('d').color, '#0000ff');
    assert.strictEqual(style('e').color, '#0000ff');
  },
);

test('color-mix() mixes in the space it names, premultiplied and weighted', () => {
  const cases: [string, string | null][] = [
    ['color-mix(in srgb, red, blue)', '#800080'],
    ['color-mix(in srgb, red 25%, blue)', '#4000bf'],
    ['color-mix(in srgb, red, blue 75%)', '#4000bf'],
    // percentages that come to less than 100% take their share of the alpha
    ['color-mix(in srgb, red 20%, blue 20%)', 'rgba(128, 0, 128, 0.4)'],
    // premultiplied: transparent lends its alpha and not its black, which is
    // how Tailwind 4 writes `bg-blue-500/50`
    ['color-mix(in srgb, #ff0000 50%, transparent)', 'rgba(255, 0, 0, 0.5)'],
    [
      'color-mix(in oklab, oklch(0.623 0.214 259.815) 50%, transparent)',
      'rgba(43, 127, 255, 0.5)',
    ],
    ['color-mix(in oklab, white, black)', '#636363'],
    ['color-mix(in hsl, red, blue)', '#ff00ff'],
    ['color-mix(in hsl longer hue, red, blue)', '#00ff00'],
    ['color-mix(in srgb-linear, red, blue)', '#bc00bc'],
    ['color-mix(in nope, red, blue)', null],
    ['color-mix(in srgb, red 0%, blue 0%)', null],
    ['color-mix(in srgb, red 150%, blue)', null],
    ['color-mix(in srgb, red, nope)', null],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(parseColor(value), want, value);
  }
});

metric(
  'a color-mix() with currentColor in it mixes the colour where it is used',
  async () => {
    const { el, result } = await renderWithBytes(
      '<html><head><style>body { margin: 0; color: #ff0000 }' +
        '#a { color: #0000ff; height: 20px; ' +
        'background-color: color-mix(in srgb, currentColor 50%, #ff0000) }' +
        '#b { color: color-mix(in srgb, currentColor, #0000ff) }' +
        // `currentColor` in `color` is the inherited colour
        '#c { color: #0000ff; color: currentColor }' +
        'table { border-collapse: collapse; color: #0000ff } ' +
        'td { border: 10px solid color-mix(in srgb, currentColor 50%, #ff0000); ' +
        'padding: 0; width: 10px; height: 10px }' +
        '</style></head><body><div id="a"></div><p id="b">b</p><p id="c">c</p>' +
        '<table id="t"><tr><td></td></tr></table></body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(style('b').color, '#800080');
    assert.strictEqual(style('c').color, '#ff0000');
    // drawn at all is part of it: an unread mix reaching the context throws
    const purple = async (x: number, y: number) => {
      const [r, g, b] = await pixelAt(result.ctx, x, y);
      return r > 110 && r < 145 && g < 20 && b > 110 && b < 145;
    };
    await waitFor(async () => assert.ok(await purple(5, 5), 'the background'));
    const table = boxOf(el, 't');
    assert.ok(await purple(3, Math.round(table.y) + 3), 'the collapsed border');
  },
);

metric(
  'custom properties set at every level of a deep tree read the nearest',
  async () => {
    // twenty levels, each setting one: the chain an element reads through is
    // folded once it is long, and has to answer as it did before
    let open = '';
    let close = '';
    for (let i = 0; i < 20; i += 1) {
      const set =
        i === 12
          ? '--gone: initial'
          : i === 3
            ? '--gone: 30px'
            : `--d${i}: ${i}px`;
      open += `<div style="${set}">`;
      close += '</div>';
    }
    const { el } = await renderWithBytes(
      '<html><head><style>:root { --top: #00ff00; --d5: 99px }</style></head><body>' +
        open +
        '<p id="p" style="color: var(--top); margin-left: var(--d5); ' +
        'margin-right: var(--d18); padding-left: var(--gone, 4px)">x</p>' +
        close +
        '</body></html>',
      {},
    );
    const style = (
      boxOf(el, 'p') as unknown as { style: Record<string, unknown> }
    ).style;
    assert.strictEqual(style.color, '#00ff00');
    // the nearer one wins over the root's
    assert.strictEqual(style.marginLeft, 5);
    assert.strictEqual(style.marginRight, 18);
    // and `initial` twelve levels down is none, over the one set at three
    assert.strictEqual(style.paddingLeft, 4);
  },
);

test("calc()'s constants: infinity, NaN, pi and e", () => {
  // CSS Values 4 names them, and Tailwind 4 writes a pill's radius as
  // `calc(infinity * 1px)`, which dropped the declaration: an infinity is
  // the largest length there is, and a NaN nought
  const ctx = { em: 20, rem: 16, vw: 1000, vh: 500, scale: 1 };
  const len = (v: string) => parseLength(v, ctx);
  assert.strictEqual(len('calc(infinity * 1px)'), 33554428);
  assert.strictEqual(len('calc(-infinity * 1px)'), -33554428);
  assert.strictEqual(len('calc(nan * 1px)'), 0);
  assert.ok(Math.abs((len('calc(pi * 1px)') as number) - Math.PI) < 1e-12);
  assert.ok(Math.abs((len('calc(e * 2px)') as number) - 2 * Math.E) < 1e-12);
  // a word that only starts like one is none
  assert.strictEqual(len('calc(ex * 1px)'), null);
  assert.strictEqual(len('calc(infinityx * 1px)'), null);
  assert.strictEqual(parseNumber('calc(infinity)'), 33554428);
});

test('an lh is the line height the cascade ends on, a font shorthand among them', async () => {
  // `lh` is read against the element's line height as the cascade settles
  // it, not as it stands when the rule holding the length is reached: a
  // `font` that outranks a `line-height` sets it, and so does a later
  // `line-height` that outranks the `font`.
  const { node } = await render(
    '<style>body{margin:0} p{margin:0;line-height:30px}' +
      ' .f{font:20px/2 serif} .l{line-height:25px} .h{height:1lh}</style>' +
      '<p id="a" class="f h">a</p><p id="b" class="h f l">b</p>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 40, "the font's line height");
  assert.strictEqual(boxOf(el, 'b').height, 25, 'the later line-height');
});

test("a rem is the root element's font size, and the initial one in the root's own font size", async () => {
  // CSS Values 4, 6.1.1: a `rem` is the root element's computed font size,
  // and where it is on the root's own `font-size`, the property's initial
  // value. It was the initial size everywhere, so `html { font-size:
  // 62.5% }`, which a page sets to write its sizes in tenths of a rem, did
  // nothing for them: the Zen Garden's 220 set its text 1.6 times Chrome's
  // size. A keyword's size is the initial size's, as it was
  const { node } = await render(
    '<html style="font-size:1.5rem;padding-top:1rem"><body style="margin:0">' +
      '<p id="r" style="margin:0;line-height:1;font-size:2rem">rem</p>' +
      '<p id="k" style="margin:0;line-height:1;font-size:small">small</p>' +
      '<p style="margin:0;font-size:10px"><span id="s" style="display:' +
      'inline-block;width:3rem;height:1em"></span></p></body></html>',
  );
  const el = view(node);
  // the initial size, from the keyword's paragraph: small is 13/16 of it
  const initial = boxOf(el, 'k').height / 0.8125;
  const root = 1.5 * initial;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  assert.ok(
    near(boxOf(el, 'r').y, root),
    "the root's padding of 1rem is its own size, 1.5rem of the initial " +
      `${initial}px: ${boxOf(el, 'r').y}`,
  );
  assert.ok(
    near(boxOf(el, 'r').height, 2 * root),
    `2rem in the body is twice the root's size: ${boxOf(el, 'r').height}`,
  );
  assert.ok(
    near(boxOf(el, 's').width, 3 * root),
    `and 3rem three times it, however deep: ${boxOf(el, 's').width}`,
  );
});
