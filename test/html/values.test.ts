// <Html> — lengths, units, colours, calc() and its kin, custom properties.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, pixelAt, waitFor } from 'react-x11/test';
import {
  inkColor,
  isTransparent,
  parseColor,
  parseLength,
  parseNumber,
  resolve,
  resolveOrNull,
  splitValue,
} from '../../src/html/css/values.js';
import {
  parseStylesheet,
  supportsCondition,
} from '../../src/html/css/parse.js';
import { parseShapeFunction } from '../../src/html/css/shape-function.js';
import { specifiedValue } from '../../src/html/css/specified.js';
import { interpolateField } from '../../src/html/css/interpolate.js';
import { cssomStyle } from '../../src/html/computed.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { substitute } from '../../src/html/css/vars.js';
import {
  boxOf,
  findById,
  metric,
  render,
  renderWithBytes,
  view,
} from './harness.js';

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
  // a function ends its part, as a minified sheet has it: the next one may
  // follow its `)` with no space, a comma or a slash may not be split off
  assert.deepStrictEqual(splitValue('calc(100% - 7px)0'), [
    'calc(100% - 7px)',
    '0',
  ]);
  assert.deepStrictEqual(splitValue('translate(1px,0)rotate(f(2))x'), [
    'translate(1px,0)',
    'rotate(f(2))',
    'x',
  ]);
  assert.deepStrictEqual(splitValue('rgb(1 2 3),red calc(1px)/2'), [
    'rgb(1 2 3),red',
    'calc(1px)/2',
  ]);
  assert.deepStrictEqual(splitValue('"a)b"c'), ['"a)b"c']);
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

metric(
  'an if() takes the first branch whose condition holds, as a var() is replaced',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>' +
        ':root { --one: 1; --n: 3; --mode: dark }' +
        'body { color: #00ff00 } p { color: #000000 }' +
        '#a { color: red; color: if(style(--one: 1): #0000ff; else: red) }' +
        // the first that holds, `else` holding always
        '#b { color: if(style(--one: 2): red; style(--one): #0000ff; else: red) }' +
        // none holds: nothing, which leaves the property unset
        '#c { color: if(style(--one: 2): red) }' +
        // white space around a value is no part of it, and inside one is,
        // as written; `initial` is a property nothing set
        '#d { --pair: a  b; color: if(style(--pair:a b): red; ' +
        'style(--pair: a  b ): #0000ff; else: red) }' +
        '#k { color: if(style(--none: initial): #0000ff; else: red) }' +
        // a branch's value has its var()s replaced, and a custom property
        // takes one as well
        '#e { --c: if(style(--mode: dark): var(--blue); else: red); ' +
        '--blue: #0000ff; color: var(--c) }' +
        // not, and, or; media() and supports(); a range — and a `not`
        // beside an `and` in no brackets is no condition, which makes its
        // if() none as it is parsed, and the declaration before it stands,
        // as one of a branch with no `:` does
        '#f { color: if((not style(--one: 2)) and media(width >= 1px): #0000ff; else: red) }' +
        '#j { color: #0000ff; color: if(not style(--one: 2) and media(width >= 1px): red; else: red) }' +
        '#l { color: #0000ff; color: if(style(--one: 1): red; else red) }' +
        '#g { color: if(media(width > 100000px) or style(--n > 4): red; ' +
        'supports(display: grid): #0000ff) }' +
        '#h { color: if(style(--n > 2): #0000ff; else: red) }' +
        // and if() inside a function
        '#i { background-color: rgb(if(style(--one: 1): 0 0 255; else: 255 0 0)) }' +
        '</style></head><body>' +
        '<p id="a">a</p><p id="b">b</p><p id="c">c</p><p id="d">d</p>' +
        '<p id="e">e</p><p id="f">f</p><p id="g">g</p><p id="h">h</p>' +
        '<p id="i">i</p><p id="j">j</p><p id="k">k</p><p id="l">l</p>' +
        '</body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(style('a').color, '#0000ff');
    assert.strictEqual(style('b').color, '#0000ff');
    // `color` inherits, so unset is the body's
    assert.strictEqual(style('c').color, '#00ff00');
    for (const id of ['d', 'e', 'f', 'g', 'h', 'j', 'k', 'l']) {
      assert.strictEqual(style(id).color, '#0000ff', id);
    }
    assert.strictEqual(style('i').backgroundColor, '#0000ff');
  },
);

metric(
  'a custom function is called where a var() would be replaced, with its arguments, defaults and locals',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>' +
        '@function --double(--x) { result: calc(var(--x) * 2) }' +
        // a typed parameter takes its default where the argument is none
        // or not of its type
        '@function --pad(--x <length>: 4px) { result: var(--x) }' +
        // a local over a parameter of its name, and over what the caller
        // sees; a default may name another parameter
        '@function --scoped(--a, --b: var(--a)) {' +
        '  --a: 7px; result: calc(var(--a) + var(--b) + var(--outer)) }' +
        // the last result whose conditions hold stands, and a @supports
        // block is read as the sheet's are
        '@function --pick() { result: 1px; @media (width > 1px) { result: 2px }' +
        '  @media (width > 100000px) { result: 99px }' +
        '  @supports (display: grid) { --three: 3px } result: var(--three) }' +
        // a result not of the type the function returns is none
        '@function --colour() returns <color> { result: 10px }' +
        '@function --length() returns <length> { result: 12px }' +
        // a call of itself, however far round, is a cycle
        '@function --loop(--x) { result: --loop(var(--x)) }' +
        '@function --ping() { result: --pong() }' +
        '@function --pong() { result: --ping() }' +
        // a comma inside an argument is in braces
        '@function --fade(--c) { result: linear-gradient(var(--c), transparent) }' +
        '@function --first(--list) { result: var(--list) }' +
        // in a stronger layer, a function wins over a later one in a weaker
        '@layer low, high;' +
        '@layer high { @function --layered() { result: 21px } }' +
        '@layer low { @function --layered() { result: 99px } }' +
        // the later of two in one layer
        '@function --twice() { result: 99px } @function --twice() { result: 23px }' +
        'body { --outer: 100px } p { width: 1px }' +
        '#a { width: --double(20px) }' +
        '#b { width: --pad() } #c { width: --pad(red) } #d { width: --pad(6px) }' +
        '#e { width: --scoped(1px) } #f { width: --scoped(1px, 2px) }' +
        '#g { width: --pick() } #h { width: --colour() } #i { width: --length() }' +
        '#j { width: 5px; width: --loop(1px) } #k { width: --ping() }' +
        // too many arguments, or a function nobody declared, is none
        '#l { width: --double(1px, 2px) } #m { width: --nope(1px) }' +
        // calls in arguments, in custom properties, in a fallback
        '#n { width: --double(--double(5px)) }' +
        '#o { --w: --double(15px); width: var(--w) }' +
        '#q { width: var(--unset, --double(13px)) }' +
        '#r { background-image: --fade(red) }' +
        '#s { font-family: --first({monospace, serif}) }' +
        '#t { width: --layered() } #u { width: --twice() }' +
        '</style></head><body>' +
        '<p id="a">a</p><p id="b">b</p><p id="c">c</p><p id="d">d</p>' +
        '<p id="e">e</p><p id="f">f</p><p id="g">g</p><p id="h">h</p>' +
        '<p id="i">i</p><p id="j">j</p><p id="k">k</p><p id="l">l</p>' +
        '<p id="m">m</p><p id="n">n</p><p id="o">o</p><p id="q">q</p>' +
        '<p id="r">r</p><p id="s">s</p><p id="t">t</p><p id="u">u</p>' +
        '</body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    const widths: [string, unknown][] = [
      ['a', 40],
      ['b', 4],
      ['c', 4],
      ['d', 6],
      // 7 + 1 + 100: the local `--a` hides the parameter, `--b` is the
      // parameter's default, which reads `--a` as the default's caller does
      ['e', 108],
      ['f', 109],
      ['g', 3],
      // invalid at computed-value time: `width` does not inherit, so auto
      ['h', 'auto'],
      ['i', 12],
      ['j', 'auto'],
      ['k', 'auto'],
      ['l', 'auto'],
      ['m', 'auto'],
      ['n', 20],
      ['o', 30],
      ['q', 26],
      ['t', 21],
      ['u', 23],
    ];
    for (const [id, want] of widths) {
      assert.strictEqual(style(id).width, want, id);
    }
    assert.ok(style('r').backgroundGradient, 'the gradient is the background');
    assert.match(String(style('s').fontFamily), /^monospace,\s*serif$/);
  },
);

metric(
  'an inherit() is the value the parent has, of a custom property, a property, or the one declared',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>' +
        // each level one deeper than its parent, from a fallback at the top
        '.nest { --depth: calc(inherit(--depth, 0) + 1);' +
        '  width: calc(var(--depth) * 10px) }' +
        // the parent's, not each other's: a swap
        '#swap { --a: 1px; --b: 2px }' +
        '#swap > p { --a: inherit(--b); --b: inherit(--a);' +
        '  margin-top: var(--a); margin-bottom: var(--b) }' +
        // a property's computed value, and with no name the one declared —
        // a shorthand included
        '#card { border-radius: 16px; padding: 8px 4px; width: 200px; color: #0000ff }' +
        '#inner { border-radius: calc(inherit() - 4px);' +
        '  padding-left: calc(inherit(padding-left) * 3);' +
        '  width: calc(inherit() / 2); background-color: inherit(color) }' +
        // nothing to find falls back, and with no fallback has no value
        '#none { width: 5px; width: inherit(--missing, 7px); height: inherit(--missing) }' +
        // a name that is no property's is none as it is parsed, and the
        // declaration before it stands
        '#bad { width: 9px; width: inherit(1px) }' +
        '</style></head><body>' +
        '<div class="nest" id="d1"><div class="nest" id="d2">' +
        '<div class="nest" id="d3">x</div></div></div>' +
        '<div id="swap"><p id="s">s</p></div>' +
        '<div id="card"><div id="inner">i</div></div>' +
        '<p id="none">n</p><p id="bad">b</p>' +
        '</body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(style('d1').width, 10);
    assert.strictEqual(style('d2').width, 20);
    assert.strictEqual(style('d3').width, 30);
    assert.strictEqual(style('s').marginTop, 2);
    assert.strictEqual(style('s').marginBottom, 1);
    assert.deepStrictEqual(style('inner').borderRadius, [12, 12, 12, 12]);
    assert.strictEqual(style('inner').paddingLeft, 12);
    assert.strictEqual(style('inner').width, 100);
    assert.strictEqual(style('inner').backgroundColor, '#0000ff');
    assert.strictEqual(style('none').width, 7);
    assert.strictEqual(style('none').height, 'auto');
    assert.strictEqual(style('bad').width, 9);
  },
);

test('a @function rule is parsed with its parameters, types, defaults and body', () => {
  const sheet = parseStylesheet(
    '@function --f(--a, --b <length>: 2px, --c type(<number> | auto)) returns <length> {' +
      '  --local: 1px; color: red; result: var(--a);' +
      '  @media (width > 40em) { result: var(--b) } }' +
      // a parameter named twice, a default not of its type, a type that is
      // no syntax, and a prelude with anything after its `returns` type
      '@function --twice(--a, --a) { result: 1 }' +
      '@function --typed(--a <length>: red) { result: 1 }' +
      '@function --bad(--a <nope>) { result: 1 }' +
      '@function --two(--a <length> | auto) { result: 1 }' +
      '@function no-dashes() { result: 1 }',
  );
  const fns = sheet.functions ?? [];
  assert.deepStrictEqual(
    fns.map((f) => f.name),
    ['--f'],
  );
  const [f] = fns;
  assert.deepStrictEqual(f.params, [
    { name: '--a', syntax: null, fallback: null },
    { name: '--b', syntax: '<length>', fallback: '2px' },
    { name: '--c', syntax: '<number> | auto', fallback: null },
  ]);
  assert.strictEqual(f.returns, '<length>');
  assert.strictEqual(f.readsMedia, true);
  // `color` is no descriptor of a function's, and goes
  assert.deepStrictEqual(
    f.body.map((item) => (item.kind === 'media' ? '@media' : item.name)),
    ['--local', 'result', '@media'],
  );
  // a resize across the body's media query restyles
  assert.ok(sheet.breakpoints.length > 0);
  // a call is a function token of its own, in no string
  const env = {
    media: () => false,
    supports: () => false,
    fn: () => ({ params: [], returns: null, body: [] }),
  };
  assert.strictEqual(
    substitute('"--f(1px)" a--f(1px)', null, env),
    '"--f(1px)" a--f(1px)',
  );
  // and one with no result has no value
  assert.strictEqual(substitute('--f()', null, env), null);
});

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

test('contrast-color() is white or black, whichever reads better on its colour', () => {
  const cases: [string, string | null][] = [
    ['contrast-color(white)', '#000000'],
    ['contrast-color(black)', '#ffffff'],
    ['contrast-color(pink)', '#000000'],
    ['contrast-color(navy)', '#ffffff'],
    // out of gamut is clipped, and the alpha set aside
    ['contrast-color(color(srgb 10 10 10))', '#000000'],
    ['contrast-color(color(srgb -10 -10 -10))', '#ffffff'],
    ['contrast-color(rgba(255, 255, 255, 0.2))', '#000000'],
    // inside another colour function, and around one
    ['contrast-color(contrast-color(pink))', '#ffffff'],
    ['contrast-color(color-mix(blue, green))', '#ffffff'],
    ['rgb(from contrast-color(blue) r g b)', '#ffffff'],
    // one colour and nothing else
    ['contrast-color()', null],
    ['contrast-color(1)', null],
    ['contrast-color(max)', null],
    ['contrast-color(white white)', null],
    ['contrast-color(white max)', null],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(parseColor(value), want, value);
  }
  // with `currentColor` in it, it is kept as itself and worked out with the
  // colour of whichever element uses it, so it inherits as itself
  const kept = parseColor('contrast-color(currentcolor)');
  assert.strictEqual(kept, 'contrast-color(currentcolor)');
  assert.strictEqual(inkColor(kept!, '#000000'), '#ffffff');
  assert.strictEqual(inkColor(kept!, '#ffffff'), '#000000');
});

test('color-mix() with no space named mixes in oklab', () => {
  assert.strictEqual(
    parseColor('color-mix(white, black)'),
    parseColor('color-mix(in oklab, white, black)'),
  );
});

test("getComputedStyle reads a mix or a contrast of currentColor with the element's colour, and a child works an inherited one out again", async () => {
  const { node } = await render(
    '<style>#outer { color: black; background-color: contrast-color(currentcolor); }' +
      '#inner { color: white; background-color: inherit; }' +
      '#mix { color: red; background-color: color-mix(in srgb, currentcolor, blue); }</style>' +
      '<div id="outer"><div id="inner">x</div></div><div id="mix">y</div>',
  );
  const el = view(node);
  const bg = (id: string) =>
    el.computedStyle(findById(el.document, id)!)?.['background-color'];
  assert.strictEqual(bg('outer'), 'rgb(255, 255, 255)');
  assert.strictEqual(bg('inner'), 'rgb(0, 0, 0)');
  assert.strictEqual(bg('mix'), 'rgb(128, 0, 128)');
});

test('a relative colour takes its origin into its function and reads its channels', () => {
  const cases: [string, string | null][] = [
    ['rgb(from red r g b)', '#ff0000'],
    // the keywords are the origin's channels, in any order
    ['rgb(from #800000 g r b)', '#008000'],
    // in the function's own ranges: `r` up to 255, `h` in degrees
    ['rgb(from red calc(r / 2) g b)', '#800000'],
    ['hsl(from red calc(h + 120) s l)', '#00ff00'],
    ['oklch(from green l c h)', '#008000'],
    ['lab(from green l a b)', '#008000'],
    ['color(from green display-p3 r g b)', '#008000'],
    ['color(from green xyz-d50 x y z)', '#008000'],
    // an alpha left out is the origin's, and `alpha` is it too
    ['rgb(from rgb(0 128 0 / 0.5) r g b)', 'rgba(0, 128, 0, 0.5)'],
    ['rgb(from red r g b / calc(alpha / 2))', 'rgba(255, 0, 0, 0.5)'],
    ['oklch(from green l c h / 50%)', 'rgba(0, 128, 0, 0.5)'],
    // a channel the function does not have, or one too few
    ['rgb(from red x g b)', null],
    ['rgb(from red r g)', null],
    ['rgb(from nope r g b)', null],
    // and a calculation stands for a number in an absolute colour too
    ['rgb(calc(255 / 2) 0 0)', '#800000'],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(parseColor(value), want, value);
  }
});

test('a math function in a channel comes to a percentage or an angle as well as a number', () => {
  const cases: [string, string | null][] = [
    // a percentage of a percentage's own type, resolved with no basis
    ['hsl(140 clamp(30%,45%,60%) 42%)', '#3b9b5b'],
    ['hsl(140 min(45%, 60%) 42%)', '#3b9b5b'],
    ['rgb(calc(50% + 10%) 0 0)', '#990000'],
    ['rgb(calc(100% / 2) 0 0 / calc(50%))', 'rgba(128, 0, 0, 0.5)'],
    // an angle in any of its units, in degrees
    ['hsl(calc(90deg + 50deg) 45% 42%)', '#3b9b5b'],
    ['hsl(calc(0.25turn + 50deg) 45% 42%)', '#3b9b5b'],
    // a comma inside a function is not the legacy form's
    ['rgb(min(255, 300) 0 0)', '#ff0000'],
    ['hsl(140, max(10%, 45%), 42%)', '#3b9b5b'],
    // one type throughout, and none a length
    ['hsl(140 clamp(30%, 45, 60%) 42%)', null],
    ['hsl(calc(90deg + 50%) 45% 42%)', null],
    ['rgb(calc(10px) 0 0)', null],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(parseColor(value), want, value);
  }
});

metric(
  'a relative colour from currentColor is worked out where it is used',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>body { margin: 0; color: #ff0000 }' +
        '#a { background-color: rgb(from currentColor g r b) }' +
        // an inherited one waits for the child's colour
        '#b { color: #800000; background-color: inherit }' +
        '#c { color: #ffff00; color: hsl(from currentColor 240 s l) }' +
        '</style></head><body><div id="a"><div id="b">b</div></div>' +
        '<p id="c">c</p></body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(
      inkColor(style('a').backgroundColor as string, '#ff0000'),
      '#00ff00',
    );
    assert.strictEqual(
      inkColor(style('b').backgroundColor as string, '#800000'),
      '#008000',
    );
    // in `color` itself, currentColor is the inherited colour
    assert.strictEqual(style('c').color, '#0000ff');
  },
);

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

test('zoom scales every length under it, rescales what is inherited from the parent’s zoom, and getComputedStyle answers unzoomed', async () => {
  // CSS Viewport 1, 5. A style's lengths are at its effective zoom, the
  // zooms from the root down multiplied, so a child sees its parent's at
  // its own: an `inherit`, an inherited font size and a `rem` are zoomed
  // where the element is, and a query reads them back as an unzoomed
  // element's, as Chrome answers
  const { node } = await render(
    '<html style="font-size:10px"><body style="margin:0">' +
      '<div style="width:50px;height:10px">' +
      '<div id="i" style="zoom:2;width:inherit;height:inherit"></div></div>' +
      '<div style="font-size:12px;line-height:1">' +
      '<p id="f" style="zoom:200%;margin:0">x</p></div>' +
      '<div style="zoom:2"><div id="n" style="zoom:2;width:1rem;height:5px">' +
      '</div></div>' +
      '<div id="z" style="zoom:0;width:7px;height:7px"></div></body></html>',
  );
  const el = view(node);
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('i'), [100, 20], 'an inherit at its own zoom');
  assert.strictEqual(boxOf(el, 'f').height, 24, 'an inherited 12px at 2');
  assert.deepStrictEqual(size('n'), [40, 20], 'a rem, and zooms multiply');
  assert.deepStrictEqual(size('z'), [7, 7], 'a zoom of 0 is 1');
  const css = (id: string) => el.computedStyle(findById(el.document, id)!)!;
  assert.strictEqual(css('i').width, '50px');
  assert.strictEqual(css('f')['font-size'], '12px');
  assert.strictEqual(css('n').width, '10px');
  assert.strictEqual(css('n').zoom, '2');
  assert.strictEqual(css('z').zoom, '1');
  // and a page reads and tests the property as it does any other
  assert.strictEqual(specifiedValue('zoom', ' 150% '), '150%');
  assert.strictEqual(specifiedValue('zoom', '-1'), null);
  assert.strictEqual(supportsCondition('(zoom: normal)'), true);
  assert.strictEqual(supportsCondition('(zoom: -2)'), false);
});

test('an lh in line-height is the parent’s line height, and a container query reads its container unzoomed', async () => {
  // CSS Values 4, 6.1.1, as an `em` in `font-size` is the parent's size:
  // read as the element's, `2lh` doubled itself in each pass that set it.
  // And a query is in the container's CSS pixels (CSS Viewport 1, 5)
  const { node } = await render(
    '<body style="margin:0"><div style="line-height:20px">' +
      '<p id="l" style="margin:0;line-height:2lh">x</p>' +
      '<p id="z" style="margin:0;zoom:2;line-height:2lh">x</p></div>' +
      '<style>.c{container-type:inline-size;width:100px}' +
      ' .q{height:5px} @container (width > 120px) {.q{height:50px}}</style>' +
      '<div class="c" style="zoom:2"><div id="q" class="q"></div></div></body>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'l').height, 40);
  assert.strictEqual(boxOf(el, 'z').height, 80, "the parent's, zoomed");
  assert.strictEqual(
    boxOf(el, 'q').height,
    10,
    'a 100px container is no wider than 120px',
  );
});

test('shape() is read as CSS Shapes 2 has it, and written back as its specified value', () => {
  const ctx = { em: 16, rem: 16, vw: 8, vh: 6, scale: 1 };
  const text = (value: string) => parseShapeFunction(value, ctx)?.text ?? null;
  // positions across first, a zero with a unit, the defaults left out
  assert.strictEqual(
    text(
      'shape(from top left, curve to center with 0 1px from origin / 2px 3px from end)',
    ),
    'shape(from left top, curve to center center with 0px 1px / 2px 3px from end)',
  );
  assert.strictEqual(
    text(
      'shape(from 1px 2px, curve by 3px 4px with 5px 6px from start, smooth by 1px 1px)',
    ),
    'shape(from 1px 2px, curve by 3px 4px with 5px 6px, smooth by 1px 1px)',
  );
  assert.strictEqual(
    text(
      'shape(evenodd from 0 0, arc by 1px 1px of 10% rotate 0deg large cw, close)',
    ),
    'shape(evenodd from 0px 0px, arc by 1px 1px of 10% cw large, close)',
  );
  for (const invalid of [
    'shape(from 0 0)',
    'shape(from 0 0 line to 1px 1px)',
    'shape(from 0 0, line to 1px 1px,)',
    'shape(from 0 0, hline to top)',
    'shape(from 0 0, curve by top left with 1px 1px)',
    'shape(from 0 0, curve to 1px 1px with 1px 2px 3px 4px)',
    'shape(from 0 0, arc by 1px 1px of 1px small large)',
  ]) {
    assert.strictEqual(text(invalid), null, invalid);
  }
});

test('a value el.style keeps is checked where its grammar is read, and kept as written where it is not', () => {
  // CSSOM 6.7: a value the property does not take is not set
  assert.strictEqual(
    specifiedValue('clip-path', 'shape(from 0 0, line to 1px 1px) content-box'),
    'shape(from 0px 0px, line to 1px 1px) content-box',
  );
  assert.strictEqual(specifiedValue('clip-path', 'shape(from 0 0)'), null);
  // what is only known once substituted, and what has no grammar here
  assert.strictEqual(
    specifiedValue('clip-path', 'shape(from var(--x) 0, close)'),
    undefined,
  );
  assert.strictEqual(specifiedValue('clip-path', 'circle(10px)'), undefined);
  assert.strictEqual(specifiedValue('mask-type', 'luminance'), undefined);
  // `user-select` is one keyword (CSS UI 4, 6.1)
  assert.strictEqual(specifiedValue('user-select', ' NONE '), 'none');
  assert.strictEqual(specifiedValue('user-select', 'visible'), null);
  assert.strictEqual(specifiedValue('user-select', 'text contain'), null);
  assert.strictEqual(specifiedValue('user-select', 'inherit'), undefined);
  // and @supports, and CSS.supports, ask the same
  assert.strictEqual(
    supportsCondition('(clip-path: shape(from 0 0, line to 1px 1px))'),
    true,
  );
  assert.strictEqual(supportsCondition('(clip-path: shape(from 0 0))'), false);
});

test("clip-path's computed value is its shape's lengths and percentages, and a path() interpolates with a shape() command by command", async () => {
  const { node } = await render(
    '<style>div{width:100px;height:100px;font-size:16px}</style>' +
      '<div id="a" style="clip-path:shape(from center, hline to right, ' +
      'curve to top right with 10px 30px from origin / 1em 2px, arc by 1px 1px of 10% rotate 3.14159265rad)"></div>' +
      '<div id="b" style="clip-path:shape(from 0 0, hline by 50%, vline by 20px, close)"></div>' +
      '<div id="c" style="clip-path:path(&quot;M10 10 h50 v40 z&quot;)"></div>' +
      '<div id="d" style="clip-path:url(#c) "></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
  assert.strictEqual(
    cssomStyle(style('a'), 1, null)['clip-path'],
    'shape(from 50% 50%, hline to 100%, curve to 100% 0% with 10px 30px / 16px 2px, ' +
      'arc by 1px 1px of 10% rotate 180deg)',
  );
  assert.strictEqual(cssomStyle(style('d'), 1, null)['clip-path'], 'url("#c")');
  // half way from a shape to a path read as the shape it is
  const half = interpolateField(
    'clipPath',
    style('b').clipPath,
    style('c').clipPath,
    0.5,
  ) as ComputedStyle['clipPath'];
  assert.strictEqual(
    cssomStyle({ ...style('b'), clipPath: half }, 1, null)['clip-path'],
    'shape(from 5px 5px, hline by calc(25% + 25px), vline by 30px, close)',
  );
});
