// <Html> — lengths, units, colours, calc() and its kin, custom properties.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { setFlagsFromString } from 'node:v8';
import { cleanup, pixelAt, waitFor } from 'react-x11/test';
import {
  inkColor,
  isTransparent,
  parseColor,
  parseLength,
  parseNumber,
  resolve,
  resolveOrNull,
  splitCommas,
  splitValue,
  trimValue,
} from '../../src/html/css/values.js';
import {
  parseDeclarations,
  parseStylesheet,
  supportsCondition,
} from '../../src/html/css/parse.js';
import { shapeFont, shapeValue } from '../../src/html/css/shapes.js';
import { fontQuery } from '../../src/html/css/style.js';
import { parseShapeFunction } from '../../src/html/css/shape-function.js';
import { parseAngle } from '../../src/html/css/transform.js';
import {
  composeShorthand,
  expandShorthand,
  specifiedValue,
} from '../../src/html/css/specified.js';
import { interpolateField } from '../../src/html/css/interpolate.js';
import {
  comesFromBox,
  cssomColor,
  cssomStyle,
} from '../../src/html/computed.js';
import { colorFormText } from '../../src/html/css/color.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { substitute } from '../../src/html/css/vars.js';
import {
  CALC_SIZE_BOXES,
  CALC_SIZE_DOCUMENT,
  CALC_SIZE_READS,
} from './calc-sizes.js';
import {
  COMPUTED_PLACED,
  COMPUTED_PLACED_DOCUMENT,
  COMPUTED_READS,
  COMPUTED_READS_DOCUMENT,
} from './computed-reads.js';
import {
  boxOf,
  drawnText,
  findById,
  metric,
  render,
  render2x,
  renderScrolled,
  renderWithBytes,
  treeOf,
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
  // a length over a length is a number (CSS Values 4, 10.9.1), where its
  // units are absolute: nothing says what an em is in a number
  assert.strictEqual(parseNumber('calc(22px / 192px)'), 22 / 192);
  assert.strictEqual(parseNumber('calc(1in / 1px + 1pt / 1pt)'), 97);
  assert.strictEqual(parseNumber('calc(1em / 1px)'), null);
  assert.strictEqual(parseNumber('calc(10% / 1px)'), null);
  assert.strictEqual(parseNumber('calc(1px / 0px)'), null);
  assert.strictEqual(parseNumber('calc(1px)'), null);
  // and a length again where another scales it
  assert.strictEqual(len('calc(100px / 4px * 1em)'), 500);
  assert.strictEqual(len('calc(100px / 4px)'), null);
  assert.strictEqual(len('calc(100% / 4px * 1px)'), null);
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
  // and `el.style` sets none of what is no colour, where it keeps any value
  // of one it has no grammar for as written
  for (const value of ['contrast-color()', 'contrast-color(white max bar)']) {
    assert.strictEqual(specifiedValue('background-color', value), null);
  }
  for (const value of [
    'contrast-color(buttonface)',
    'color-mix(contrast-color(blue) 100%, purple 0%)',
  ]) {
    assert.strictEqual(specifiedValue('background-color', value), undefined);
  }
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
  // a mix computes to the space it is mixed in, sRGB as `color()`
  assert.strictEqual(bg('mix'), 'color(srgb 0.5 0 0.5)');
});

test('a computed colour keeps the space it was written or mixed in, as CSS Color 4 serializes it', () => {
  // CSS Color 4, 15: lab(), lch(), oklab() and oklch() as themselves, their
  // calculations simplified, the lightness within its range, a chroma no
  // less than nought, a hue in a turn and the alpha within 0 and 1; color()
  // unclamped, its xyz as xyz-d65; and none kept as none
  const cases: [string, string | null][] = [
    ['oklch(62.3% 0.214 259.815)', 'oklch(0.623 0.214 259.815)'],
    ['lab(20 0 10/50%)', 'lab(20 0 10 / 0.5)'],
    ['lab(400 0 10/50%)', 'lab(100 0 10 / 0.5)'],
    ['lab(20% -50% 90%/0.5)', 'lab(20 -62.5 112.5 / 0.5)'],
    ['oklab(20% 70% -80%/0.5)', 'oklab(0.2 0.28 -0.32 / 0.5)'],
    [
      'lab(calc(50 * 3) calc(0.5 - 1) calc(1.5) / calc(-0.5 + 1))',
      'lab(100 -0.5 1.5 / 0.5)',
    ],
    ['lab(calc(NaN) 0 0)', 'lab(0 0 0)'],
    ['lch(10 20 1.28rad)', 'lch(10 20 73.3386)'],
    ['lch(10 20 -700deg)', 'lch(10 20 20)'],
    ['lch(20 -20 0)', 'lch(20 0 0)'],
    [
      'lch(calc(-50 * 3) calc(0.5 + 1) calc(-20deg * 2) / calc(-0.5 * 2))',
      'lch(0 1.5 320 / 0)',
    ],
    ['oklch(20% 60% 10/0.5)', 'oklch(0.2 0.24 10 / 0.5)'],
    ['lab(none none none / none)', 'lab(none none none / none)'],
    ['color(xyz 0.1 0.2 0.3)', 'color(xyz-d65 0.1 0.2 0.3)'],
    ['color(display-p3 200% 0 10 / 50%)', 'color(display-p3 2 0 10 / 0.5)'],
    ['color(srgb -200 -200 -200 / -200)', 'color(srgb -200 -200 -200 / 0)'],
    [
      'color(srgb calc(50% * 3) calc(-150% / 3) calc(50%) / calc(-50% * 3))',
      'color(srgb 1.5 -0.5 0.5 / 0)',
    ],
    ['color(srgb 10% none none / none)', 'color(srgb 0.1 none none / none)'],
    // a legacy function with a none in it says so in its own form
    ['hsl(120 80% none)', 'hsl(120 80% none)'],
    ['hsla(none none none / none)', 'hsl(none none none / none)'],
    // and any other legacy colour is rgb()'s, which says what it is
    ['hsl(120 100% 50%)', null],
    ['rgb(10 20 30 / 50%)', null],
    ['#abc', null],
    ['rebeccapurple', null],
    ['contrast-color(oklch(0.5 0.1 200))', null],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(colorFormText(value), want, value);
  }
});

test('a mix computes to the space it is mixed in, a missing component taken from the other colour', () => {
  // CSS Color 5, 3: in an RGB or an XYZ space as color(), in hsl() and
  // hwb() as color(srgb …) but where a none is left, and in the others as
  // themselves; a none on one side is the other's, and on both stays none
  const cases: [string, string][] = [
    ['color-mix(in srgb, red, blue)', 'color(srgb 0.5 0 0.5)'],
    [
      'color-mix(in srgb, red 30%, blue 40%)',
      'color(srgb 0.428571 0 0.571429 / 0.7)',
    ],
    [
      'color-mix(in srgb, color(srgb 2 3 4 / 5), color(srgb 4 6 8 / 10))',
      'color(srgb 3 4.5 6)',
    ],
    [
      'color-mix(in xyz, color(xyz .1 .2 .3), color(xyz .5 .6 .7))',
      'color(xyz-d65 0.3 0.4 0.5)',
    ],
    [
      'color-mix(in display-p3, color(display-p3 .1 .2 .3) 25%, color(display-p3 .5 .6 .7))',
      'color(display-p3 0.4 0.5 0.6)',
    ],
    [
      'color-mix(in hsl, hsl(120deg 10% 20%), hsl(30deg 30% 40%))',
      'color(srgb 0.33 0.36 0.24)',
    ],
    [
      'color-mix(in hsl, transparent, hsl(30deg 30% 40%))',
      'color(srgb 0.52 0.4 0.28 / 0.5)',
    ],
    [
      'color-mix(in hsl, hsl(120deg 40% 40% / none), hsl(0deg 40% 40% / none))',
      'hsl(60 40% 40% / none)',
    ],
    [
      'color-mix(in hwb, hwb(120deg 10% 20%), hwb(30deg 30% 40%))',
      'color(srgb 0.575 0.7 0.2)',
    ],
    ['color-mix(in lab, lab(10 20 30), lab(50 60 70))', 'lab(30 40 50)'],
    ['color-mix(in lab, transparent, lab(30 40 50))', 'lab(30 40 50 / 0.5)'],
    ['color-mix(in lch, lch(10 20 none), lch(50 60 70deg))', 'lch(30 40 70)'],
    // a grey's hue is powerless, and missing
    ['color-mix(in lch, lab(50 0 0), black)', 'lch(25 0 none)'],
    [
      'color-mix(in oklch, oklch(0.1 0.2 30deg) 25%, oklch(0.5 0.6 70deg))',
      'oklch(0.4 0.5 60)',
    ],
    // no space named is oklab
    ['color-mix(oklab(0.1 0.2 0.3), oklab(0.5 0.6 0.7))', 'oklab(0.3 0.4 0.5)'],
    [
      'color-mix(oklab(0.1 0.2 0.3 / none), oklab(0.5 0.6 0.7 / none))',
      'oklab(0.3 0.4 0.5 / none)',
    ],
    // Tailwind 4's `bg-blue-500/50`
    [
      'color-mix(in oklab, oklch(62.3% 0.214 259.815) 50%, transparent)',
      'oklab(0.623 -0.037841 -0.210628 / 0.5)',
    ],
    // over contrast-color(), which is white or black
    [
      'color-mix(in srgb, contrast-color(blue) 100%, purple)',
      'color(srgb 1 1 1)',
    ],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(colorFormText(value), want, value);
  }
  // and what is drawn is the sRGB colour it always was
  assert.strictEqual(parseColor('color-mix(in srgb, red, blue)'), '#800080');
  assert.strictEqual(
    parseColor('color-mix(in display-p3, red, blue)'),
    parseColor('color-mix(in display-p3, red 50%, blue 50%)'),
  );
});

test('a relative colour computes to its function, and rgb(), hsl() and hwb() to color(srgb …) unclamped', () => {
  // CSS Color 5, 4: the channels of a legacy function's relative form need
  // not be in sRGB's gamut, so it is kept as color(srgb …), or in its own
  // form where a channel is none; the others keep their own function, and
  // take an origin of their own space as it is kept, past what sRGB holds
  const cases: [string, string][] = [
    ['rgb(from rebeccapurple r g b)', 'color(srgb 0.4 0.2 0.6)'],
    ['rgb(from rebeccapurple r calc(g * 2) 255)', 'color(srgb 0.4 0.4 1)'],
    ['rgb(from red calc(r * 2) g b)', 'color(srgb 2 0 0)'],
    ['rgb(from rebeccapurple r g none / alpha)', 'color(srgb 0.4 0.2 none)'],
    [
      'rgb(from rgb(from rebeccapurple r g b / calc(alpha + 0.5)) r g b / calc(alpha - 0.5))',
      'color(srgb 0.4 0.2 0.6 / 0.5)',
    ],
    ['hsl(from rebeccapurple h s l)', 'color(srgb 0.4 0.2 0.6)'],
    ['hsl(from rebeccapurple h s none)', 'hsl(270 50% none)'],
    ['hwb(from rebeccapurple h w w / w)', 'color(srgb 0.5 0.2 0.8)'],
    ['lab(from lab(25 20 50) l a b)', 'lab(25 20 50)'],
    ['lab(from lab(200 300 400 / 500%) l a b / alpha)', 'lab(100 300 400)'],
    [
      'lch(from lch(0.7 45 30 / 40%) 50 120 -400deg / -500)',
      'lch(50 120 320 / 0)',
    ],
    ['oklab(from oklab(2 3 4 / 500%) l a b / alpha)', 'oklab(1 3 4)'],
    ['oklch(from blue .5 .3 calc(0.25turn + 100grad))', 'oklch(0.5 0.3 180)'],
    [
      'color(from color(xyz 7 -20.5 100) xyz x y z)',
      'color(xyz-d65 7 -20.5 100)',
    ],
    [
      'color(from color(srgb-linear 0.25 0.5 0.75) srgb r g b)',
      'color(srgb 0.537099 0.735357 0.880825)',
    ],
    ['rgb(from contrast-color(blue) r g b)', 'color(srgb 1 1 1)'],
    [
      'rgb(from color-mix(in srgb, red, red) r g b / alpha)',
      'color(srgb 1 0 0)',
    ],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(colorFormText(value), want, value);
  }
});

test('getComputedStyle reads each colour in the space its computed value keeps, through shorthands, inheritance and currentColor', async () => {
  const { node } = await render(
    '<style>' +
      '#a { color: oklch(62.3% 0.214 259.815); ' +
      'background-color: color-mix(in srgb, red, blue); ' +
      'border: 1px solid lab(50 20 -30); outline: 2px solid color(display-p3 1 0 0) }' +
      // a child inherits the colour as it is kept, and currentColor is it
      '#b { background-color: currentColor; border-top: 1px solid }' +
      '#c { color: color-mix(in srgb, currentColor, white) }' +
      // a shorthand, a keyword, a custom property, and the colours that
      // are legacy sRGB, which stay rgb()
      '#d { --brand: oklch(62.3% 0.214 259.815); ' +
      'background: color-mix(in oklab, var(--brand) 50%, transparent); ' +
      'border-color: #ff0000 hsl(120 100% 50%) rgb(from red r g b) lab(50 0 0); ' +
      'color: rebeccapurple; outline-color: color-mix(in lab, currentColor, white) }' +
      '#e { background-color: inherit; border-left-color: contrast-color(oklch(0.2 0.1 20)) }' +
      '#f { background-color: lab(50 20 -30); background-color: initial }' +
      '</style>' +
      '<div id="a"><div id="b"><p id="c">c</p></div></div>' +
      '<div id="d"><div id="e">e</div><div id="f">f</div></div>',
  );
  const el = view(node);
  const cs = (id: string) => el.computedStyle(findById(el.document, id)!)!;
  const a = cs('a');
  assert.strictEqual(a.color, 'oklch(0.623 0.214 259.815)');
  assert.strictEqual(a['background-color'], 'color(srgb 0.5 0 0.5)');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.strictEqual(a[`border-${side}-color`], 'lab(50 20 -30)', side);
  }
  assert.strictEqual(a['outline-color'], 'color(display-p3 1 0 0)');
  const b = cs('b');
  assert.strictEqual(b.color, 'oklch(0.623 0.214 259.815)');
  assert.strictEqual(b['background-color'], 'oklch(0.623 0.214 259.815)');
  assert.strictEqual(b['border-top-color'], 'oklch(0.623 0.214 259.815)');
  // currentColor in a mix in `color` is the inherited colour as it is
  // kept: that oklch() is past sRGB's blue, which its hex would have cut
  assert.strictEqual(cs('c').color, 'color(srgb 0.584666 0.749025 1.01142)');
  const d = cs('d');
  assert.strictEqual(
    d['background-color'],
    'oklab(0.623 -0.037841 -0.210628 / 0.5)',
  );
  assert.strictEqual(d['border-top-color'], 'rgb(255, 0, 0)');
  assert.strictEqual(d['border-right-color'], 'rgb(0, 255, 0)');
  assert.strictEqual(d['border-bottom-color'], 'color(srgb 1 0 0)');
  assert.strictEqual(d['border-left-color'], 'lab(50 0 0)');
  assert.strictEqual(d.color, 'rgb(102, 51, 153)');
  assert.match(
    d['outline-color'],
    /^lab\(\d+(\.\d+)? \d+(\.\d+)? -\d+(\.\d+)?\)$/,
  );
  const e = cs('e');
  assert.strictEqual(
    e['background-color'],
    'oklab(0.623 -0.037841 -0.210628 / 0.5)',
  );
  assert.strictEqual(e['border-left-color'], 'rgb(255, 255, 255)');
  assert.strictEqual(cs('f')['background-color'], 'rgba(0, 0, 0, 0)');
});

test('a colour field written alone, as an animation writes it, reads as the sRGB colour it holds', () => {
  // the source a field keeps is the field's only while it reads to the
  // field's value
  assert.strictEqual(
    cssomColor('#ff0000', 'oklch(0.5 0.1 200)', '#000000', null),
    'rgb(255, 0, 0)',
  );
  const drawn = parseColor('oklch(0.5 0.1 200)')!;
  assert.strictEqual(
    cssomColor(drawn, 'oklch(0.5 0.1 200)', '#000000', null),
    'oklch(0.5 0.1 200)',
  );
  // and currentColor in a mix is the element's colour as its own is kept
  assert.strictEqual(
    cssomColor(
      'color-mix(in lab, currentColor, currentColor)',
      null,
      parseColor('lab(40 10 20)')!,
      'lab(40 10 20)',
    ),
    'lab(40 10 20)',
  );
});

test("el.style keeps a contrast-color()'s colour with its calculations simplified", () => {
  assert.strictEqual(
    specifiedValue(
      'background-color',
      'contrast-color(color(srgb calc(0.5) calc(1 + 1 / 1) 1 / .5))',
    ),
    'contrast-color(color(srgb calc(0.5) calc(2) 1 / 0.5))',
  );
  assert.strictEqual(
    specifiedValue(
      'background-color',
      'contrast-color(HSL(calc(90deg + 50deg) 45% 42%))',
    ),
    'contrast-color(hsl(calc(140deg) 45% 42%))',
  );
  // and one with nothing to simplify is kept as written
  for (const value of [
    'contrast-color(lab(0.2 0.5 0.2))',
    'contrast-color(color(srgb 10 10 10))',
    'contrast-color(rgba(255, 255, 255, 0.2))',
    'contrast-color(rgb(from blue r g b))',
  ]) {
    assert.strictEqual(specifiedValue('background-color', value), undefined);
  }
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

test('the stepped, trigonometric, exponential and sign functions come to a value where no percentage is in them', async () => {
  // CSS Values 4, 10.4–10.8. Apple's hero is as wide as its height times
  // `tan(atan2(var(--p-width), 1px)) / tan(atan2(var(--p-height), 1px))`,
  // a length turned into a number, and was 0px wide
  const ctx = { em: 20, rem: 16, vw: 1000, vh: 500, scale: 1 };
  const len = (v: string) => parseLength(v, ctx);
  const near = (a: number | null | unknown, b: number, what: string) =>
    assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${what}: ${a}`);
  near(len('calc(100px * sin(30deg))'), 50, 'sin');
  near(len('calc(100px * cos(0.5turn))'), -100, 'cos');
  near(len('calc(100px * tan(atan(1)))'), 100, 'tan of an atan');
  near(len('calc(1px * tan(atan2(30px, 1px)))'), 30, 'a length made a number');
  near(len('calc(1px * tan(atan2(3em, 4px)))'), 15, 'of two units');
  near(
    parseNumber('calc(tan(atan2(1440px, 1px)) / tan(atan2(546px, 1px)))'),
    1440 / 546,
    'a ratio',
  );
  assert.strictEqual(len('hypot(30px, 40px)'), 50);
  assert.strictEqual(len('abs(-12px)'), 12);
  assert.strictEqual(len('calc(10px * sign(3em))'), 10);
  assert.strictEqual(len('calc(100px * pow(2, 3) / sqrt(4))'), 400);
  near(len('calc(10px * log(8, 2))'), 30, 'log');
  near(len('calc(10px * exp(0))'), 10, 'exp');
  // a step: nearest by default, the tie going up; and the four strategies
  assert.strictEqual(len('round(7.5px, 5px)'), 10);
  assert.strictEqual(len('round(up, 10.2px, 5px)'), 15);
  assert.strictEqual(len('round(down, 14px, 5px)'), 10);
  assert.strictEqual(len('round(to-zero, -14px, 5px)'), -10);
  assert.strictEqual(len('calc(10px * round(2.5))'), 30, 'a number steps by 1');
  assert.strictEqual(len('round(12px)'), null, 'a length says its step');
  assert.strictEqual(len('mod(-7px, 5px)'), 3, 'mod takes the sign of B');
  assert.strictEqual(len('rem(-7px, 5px)'), -2, 'rem the sign of A');
  // an angle is no length, a length times one is no value, and a
  // percentage is a different value at every width
  assert.strictEqual(len('atan2(1px, 1px)'), null);
  assert.strictEqual(len('calc(1px * atan(1))'), null);
  assert.strictEqual(len('abs(-10%)'), null);
  assert.strictEqual(len('hypot(3px, 4)'), null, 'of two types');
  assert.strictEqual(len('round(nearest 1px, 2px)'), null);
  // an angle where the caller reads angles: a transform's turn
  near(parseAngle('atan2(1, 1)'), 45, 'atan2 as an angle');
  near(parseAngle('calc(asin(1) / 2)'), 45, 'half of asin');
  near(parseAngle('calc(90deg * sin(30deg))'), 45, 'its own angle taken');
  // and a page's chain of custom properties, as Apple writes it
  const { node } = await render(
    '<body style="margin:0"><style>#m{height:5px;--p-width:1440px;' +
      '--p-height:546px;--hu:tan(atan2(var(--p-height),1px));' +
      '--wu:tan(atan2(var(--p-width),1px));--ar:calc(var(--wu)/var(--hu));' +
      'width:calc(var(--p-height)*var(--ar))}</style><div id="m"></div></body>',
    2000,
  );
  near(boxOf(view(node), 'm').width, 1440, "Apple's hero");
});

test('attr() reads an attribute into any property: as a string, a number with a unit, or a value of a type, with its fallback', async () => {
  // CSS Values 5, 7.7: a substitution as var() is, of the element's
  // attribute. Untyped it is a string; a unit makes a number a dimension;
  // type() parses it, var()s in it and all, and holds it to the syntax.
  // What it is not, or an attribute it does not have, is the fallback, and
  // a typed one with none leaves the property as though unset
  const { node } = await render(
    '<body style="margin:0"><style>@property --w {syntax: "<length>"; inherits: false; initial-value: 21px}' +
      ' div{height:5px} #s::before{content:"(" attr(data-x) ")"}</style>' +
      '<div id="u" data-w="12" style="width:attr(data-w px)"></div>' +
      '<div id="t" data-w="calc(10px + 3px)" style="width:attr(data-w type(<length>))"></div>' +
      '<div id="v" data-w="var(--w)" style="width:attr(data-w type(<length>), 1px)"></div>' +
      '<div id="f" data-w="red" style="width:attr(data-w type(<length>), 9px)"></div>' +
      '<div id="m" style="width:attr(gone px, 11px)"></div>' +
      '<div id="n" data-w="red" style="width:50px;width:attr(data-w type(<length>))"></div>' +
      '<p id="s" data-x="hi" style="margin:0"></p></body>',
  );
  const el = view(node);
  const width = (id: string) => boxOf(el, id).width;
  assert.strictEqual(width('u'), 12, 'a unit');
  assert.strictEqual(width('t'), 13, 'a type, its calc() computed');
  assert.strictEqual(width('v'), 21, 'a var() in the attribute');
  assert.strictEqual(width('f'), 9, 'not of the type: the fallback');
  assert.strictEqual(width('m'), 11, 'no attribute: the fallback');
  assert.strictEqual(width('n'), 400, 'none of either: as though unset');
  assert.strictEqual(
    el.computedStyle(findById(el.document, 's')!, 'before')?.['font-size'],
    el.computedStyle(findById(el.document, 's')!)?.['font-size'],
  );
  assert.match(drawnText(el), /\(hi\)/, 'a string in content');
});

test("env() is the user agent's variable, its fallback where there is none, and invalid at computed-value time with neither", async () => {
  // CSS Environment Variables 1: a substitution as var() is, of what the
  // user agent defines — a safe area's inset, nothing on a desktop's
  // screen. Apple's header pads its content by `max(22px, var(--sk, env(
  // safe-area-inset-left)))`, and the whole declaration was dropped
  const { node } = await render(
    '<body style="margin:0"><style>div{height:5px}' +
      ' #pad{padding-left:max(22px, env(safe-area-inset-left))}' +
      ' #apple{--inset:var(--sk-inset, env(safe-area-inset-left));padding-left:max(22px, var(--inset))}' +
      ' #zero{width:30px;width:env(safe-area-inset-left, 50px)}' +
      ' #fallback{width:env(unknown, 30px)}' +
      ' #nested{width:env(unknown, env(other, var(--w)));--w:31px}' +
      ' #indexed{width:env(safe-area-inset-left 0, 12px)}' +
      ' #custom{--w:env(test, 100px);width:var(--w)}' +
      ' #none{width:40px;width:env(unknown)}' +
      ' #bad{width:15px;width:env(10px)}' +
      ' #bad2{width:16px;width:env(test -1, 5px)}' +
      ' #invalid{--v:env(nonexistent)}' +
      '</style><div id="pad"></div><div id="apple"></div><div id="zero"></div>' +
      '<div id="fallback"></div><div id="nested"></div><div id="indexed"></div>' +
      '<div id="custom"></div><div id="none"></div><div id="bad"></div>' +
      '<div id="bad2"></div><div id="invalid"></div></body>',
  );
  const el = view(node);
  const style = (id: string) => el.computedStyle(findById(el.document, id)!)!;
  assert.strictEqual(style('pad')['padding-left'], '22px');
  assert.strictEqual(style('apple')['padding-left'], '22px', "Apple's header");
  assert.strictEqual(boxOf(el, 'zero').width, 0, 'a safe area is 0px');
  assert.strictEqual(boxOf(el, 'fallback').width, 30, 'no such variable');
  assert.strictEqual(boxOf(el, 'nested').width, 31, 'a fallback substituted');
  assert.strictEqual(boxOf(el, 'indexed').width, 12, 'indices it has none of');
  assert.strictEqual(boxOf(el, 'custom').width, 100, 'in a custom property');
  assert.strictEqual(boxOf(el, 'none').width, 400, 'neither: unset');
  assert.strictEqual(boxOf(el, 'bad').width, 15, 'no name: never parsed');
  assert.strictEqual(boxOf(el, 'bad2').width, 16, 'a negative index');
  assert.strictEqual(style('invalid')['--v'] ?? '', '', 'guaranteed-invalid');
  // what WPT's css-env/at-supports and supports-script ask: a value with an
  // env() in it is not parsed until it is substituted, and is supported
  // where its env()s are well formed (null, which an @supports enters)
  assert.notStrictEqual(supportsCondition('(color: env(test))'), false);
  assert.notStrictEqual(supportsCondition('(top: env(test 0 1, 1px))'), false);
  assert.notStrictEqual(supportsCondition('(top: env(test,))'), false);
  assert.strictEqual(supportsCondition('(top: env())'), false);
  assert.strictEqual(supportsCondition('(top: env(test1 test2))'), false);
  assert.strictEqual(supportsCondition('(top: env(test 0.1))'), false);
});

test("a typed attr()'s units are lowercase, and an attr() in a container's style() query reads the container", async () => {
  // a value parsed as a type is serialized as it was parsed: `3EM` is
  // `3em`; and what a `style()` feature compares with is the container's,
  // its attributes as much as its custom properties
  const { node } = await render(
    '<style>#d { --l: attr(data-l type(<length>)); --s: attr(data-l) }' +
      ' #c { --foo: bar }' +
      ' @container style(--foo: attr(data-foo type(<custom-ident>))) { #t { color: #008000 } }' +
      '</style><div id="d" data-l="3EM"></div>' +
      '<div id="c" data-foo="bar"><p id="t">t</p></div>' +
      '<div data-foo="baz" style="--foo: bar"><p id="f">f</p></div>',
  );
  const el = view(node);
  const style = (id: string) => el.computedStyle(findById(el.document, id)!)!;
  const tree = treeOf(el) as {
    styles: Map<unknown, { style: ComputedStyle }>;
  };
  const custom = (name: string) =>
    tree.styles.get(findById(el.document, 'd'))!.style.custom?.get(name);
  assert.strictEqual(custom('--l'), '3em');
  assert.strictEqual(custom('--s'), '"3EM"', 'a string as written');
  assert.strictEqual(style('t').color, 'rgb(0, 128, 0)');
  assert.notStrictEqual(style('f').color, 'rgb(0, 128, 0)', "another's");
});

test('what an attr() reads is tainted, and a tainted value as or in a URL makes its declaration invalid, through var(), a fallback, if() and a registered property', async () => {
  // CSS Values 5, 8.7.2: a style sheet cannot send an attribute's value
  // anywhere. The value an attr() substitutes is tainted, and so is the
  // whole of a substitution made with one — a custom property, a var(),
  // its fallback, an if() whose condition read one. As or in a url(), a
  // src(), or a string an image() or an image-set() takes as a URL, it
  // leaves the property as though unset, and nothing is asked for;
  // anywhere else it stands
  const u = 'https://does-not-exist.test/404.png';
  const leak = 'https://leak.test/token.png';
  const asked: string[] = [];
  const rows: [string, string][] = [
    ['set', 'background-image: image-set(attr(data-foo))'],
    ['shorthand', 'background: image-set(attr(data-foo))'],
    ['src', 'background-image: src(attr(data-foo))'],
    ['image', 'background-image: image(attr(data-foo))'],
    ['string', 'background-image: attr(data-foo)'],
    ['typed', 'background-image: attr(data-url type(*))'],
    ['var', 'background-image: image-set(var(--s))'],
    ['registered', 'background-image: image-set(var(--r))'],
    ['fallback', 'background-image: image-set(var(--none, attr(data-foo)))'],
    ['if', `background-image: if(style(--s): url(${leak}); else: none)`],
    [
      'whole',
      `--w: url("${leak}") type(attr(data-foo)); background-image: var(--w)`,
    ],
    [
      'list',
      `--l: linear-gradient(red, blue), image-set(attr(data-foo)); background-image: var(--l)`,
    ],
    [
      'untouched',
      `background-image: if(style(--t): url(${u}); else: attr(data-foo))`,
    ],
    ['beside', `background-image: url(${u}), attr(data-g type(<image>))`],
    ['colour', `background-image: image("${u}", attr(data-c type(<color>)))`],
  ];
  const { node } = await render(
    '<style>@property --r {syntax: "<string>"; inherits: false; initial-value: "x"}' +
      ` div { --s: attr(data-foo); --r: attr(data-foo); --t: 1;` +
      ` --x: image-set(attr(data-foo)) }</style>` +
      rows
        .map(
          ([id, css]) =>
            `<div id="${id}" data-foo="${leak}" data-url="url(${leak})"` +
            ` data-g="linear-gradient(#000000, #ffffff)" data-c="blue"` +
            ` style='${css}'></div>`,
        )
        .join(''),
    400,
    {
      onResource: (r: { url: string }) => {
        asked.push(r.url);
        return null;
      },
    },
  );
  const el = view(node);
  const image = (id: string) =>
    el.computedStyle(findById(el.document, id)!)!['background-image'];
  for (const id of [
    'set',
    'shorthand',
    'src',
    'image',
    'string',
    'typed',
    'var',
    'registered',
    'fallback',
    'if',
    'whole',
    'list',
  ]) {
    assert.strictEqual(image(id), 'none', id);
  }
  // a branch not taken reads nothing, and an untainted url beside a
  // tainted image, or a tainted colour in an image(), is no tainted URL
  assert.strictEqual(image('untouched'), `url("${u}")`);
  assert.strictEqual(
    image('beside'),
    `url("${u}"), linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))`,
  );
  assert.strictEqual(image('colour'), `image(url("${u}"), rgb(0, 0, 255))`);
  // what a custom property holds is its own to show
  assert.strictEqual(
    el.customProperty(findById(el.document, 'set')!, '--x'),
    `image-set("${leak}")`,
  );
  assert.ok(asked.includes(u), 'the untainted url is asked for');
  assert.ok(!asked.includes(leak), 'no tainted one is');
});

test("a tainted custom property is tainted where an element inherits it or a rule wins over an untainted one's", async () => {
  // attr-universal-selector.html: `*` sets the property to the URL, `div`
  // to the attribute, and the attribute's is the one that stands
  const u = 'https://does-not-exist.test/404.png';
  const { node } = await render(
    '<style>@property --s {syntax: "<string>"; inherits: true; initial-value: "e"}' +
      ` * { --s: "${u}" } div { --s: attr(data-foo) }` +
      ' div, p { background-image: image-set(var(--s)) }' +
      ` #free { --s: "${u}" }</style>` +
      `<div id="d" data-foo="${u}"><p id="kid"></p><p id="free"></p></div>`,
  );
  const el = view(node);
  const image = (id: string) =>
    el.computedStyle(findById(el.document, id)!)!['background-image'];
  assert.strictEqual(image('d'), 'none');
  // `*` sets the child its own, untainted
  assert.strictEqual(image('kid'), `image-set(url("${u}") 1dppx)`);
  assert.strictEqual(image('free'), `image-set(url("${u}") 1dppx)`);
});

test('an inherited tainted custom property stays tainted, and an untainted one that reads a tainted one is tainted whole', async () => {
  const u = 'https://does-not-exist.test/404.png';
  const { node } = await render(
    '<style>#p { --s: attr(data-foo) } #c { --t: var(--s) }' +
      ' p { background-image: image-set(var(--s)) }' +
      ' #c { background-image: image-set(var(--t)) }</style>' +
      `<div id="p" data-foo="${u}"><p id="k"></p><span id="c"></span></div>`,
  );
  const el = view(node);
  const image = (id: string) =>
    el.computedStyle(findById(el.document, id)!)!['background-image'];
  assert.strictEqual(image('k'), 'none', 'inherited');
  assert.strictEqual(image('c'), 'none', 'through another');
});

test('background-image computes to the images as written, its urls, colours and resolutions serialized', async () => {
  // CSSOM, as Chrome answers getComputedStyle: a url as a url() of a
  // string, and so the strings image(), src() and image-set() take; a
  // gradient's colours computed and its default direction left out; an
  // image-set() option's resolution in dppx, 1dppx where it has none
  const u = 'https://does-not-exist.test/404.png';
  const rows: [string, string, string][] = [
    ['none', 'none', 'none'],
    ['url', `url(${u})`, `url("${u}")`],
    ['set', `image-set("${u}")`, `image-set(url("${u}") 1dppx)`],
    [
      'set2',
      `image-set("a.png" 1x, url(b.png) 2X type("image/png"), "c.png" 192dpi)`,
      'image-set(url("a.png") 1dppx, url("b.png") 2dppx type("image/png"), url("c.png") 2dppx)',
    ],
    ['src', `src("${u}")`, `src(url("${u}"))`],
    ['image', `image("${u}")`, `image(url("${u}"))`],
    [
      'linear',
      'linear-gradient(to bottom, black, WHITE 50%)',
      'linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255) 50%)',
    ],
    [
      'to',
      'linear-gradient(to right, #f00, transparent)',
      'linear-gradient(to right, rgb(255, 0, 0), rgba(0, 0, 0, 0))',
    ],
    [
      'radial',
      'radial-gradient(circle at center, red, currentColor)',
      'radial-gradient(circle at center, rgb(255, 0, 0), currentcolor)',
    ],
    [
      'layers',
      `url(a.png), linear-gradient(45deg, red 10PX, blue)`,
      'url("a.png"), linear-gradient(45deg, rgb(255, 0, 0) 10px, rgb(0, 0, 255))',
    ],
  ];
  const { node } = await render(
    rows
      .map(
        ([id, css]) => `<div id="${id}" style='background-image:${css}'></div>`,
      )
      .join('') +
      `<p id="short" style='background: url(${u}) no-repeat red'></p>` +
      `<p id="many" style='background: url(a.png), none, red'></p>` +
      '<p id="bad" style=\'background-image:url(a.png);background-image:"b.png"\'></p>',
  );
  const el = view(node);
  const image = (id: string) =>
    el.computedStyle(findById(el.document, id)!)!['background-image'];
  for (const [id, , want] of rows) assert.strictEqual(image(id), want, id);
  assert.strictEqual(image('short'), `url("${u}")`);
  assert.strictEqual(image('many'), 'url("a.png"), none, none');
  // a string alone is no image: the declaration is invalid
  assert.strictEqual(image('bad'), 'url("a.png")');
});

test('font-family reads as its list was written, serialized as Chrome serializes it', async () => {
  // Chrome 151's answers, each read back from that browser (WebKit quotes
  // less, and Firefox did not start where this was checked). Not its answer
  // for `BlinkMacSystemFont`, which on a Mac alone comes back `"system-ui"`:
  // here a page reads the name it wrote, as WebKit has it.
  const lists: [string, string][] = [
    // an identifier needs no quotes, whatever it was written with
    ['Inter', 'Inter'],
    [`'Inter'`, 'Inter'],
    ['"Inter"', 'Inter'],
    [`'a1'`, 'a1'],
    [`'a-b'`, 'a-b'],
    [`'_'`, '_'],
    ['-foo', '-foo'],
    [`'-apple-system'`, '-apple-system'],
    [`'日本語'`, '日本語'],
    ['F\\6Fo', 'Foo'],
    // anything else is a string
    ['Helvetica Neue', '"Helvetica Neue"'],
    ['Helvetica \t  Neue', '"Helvetica Neue"'],
    [`'Helvetica  Neue'`, '"Helvetica  Neue"'],
    [`'  Foo'`, '"  Foo"'],
    [`'Foo, Bar'`, '"Foo, Bar"'],
    [`'1996'`, '"1996"'],
    [`'1a'`, '"1a"'],
    [`'-1a'`, '"-1a"'],
    [`'-'`, '"-"'],
    [`'--'`, '"--"'],
    ['--foo', '"--foo"'],
    [`'a.b'`, '"a.b"'],
    ['Foo serif', '"Foo serif"'],
    ['inherit Foo', '"inherit Foo"'],
    [`''`, '""'],
    [`'', serif`, '"", serif'],
    // and escaped as one
    [`'Foo"Bar'`, '"Foo\\"Bar"'],
    [`"Foo\\"Bar"`, '"Foo\\"Bar"'],
    [`"Foo'Bar"`, `"Foo'Bar"`],
    [`"a\\\\b"`, '"a\\\\b"'],
    [`'a\\1 b'`, '"a\\1 b"'],
    [`"a\\A b"`, '"a\\a b"'],
    [`'a\\\nb'`, 'ab'],
    // a generic family is a keyword bare, in any case, and a name quoted
    ['monospace', 'monospace'],
    ['MONOSPACE', 'monospace'],
    ['Sans-Serif', 'sans-serif'],
    ['SYSTEM-UI', 'system-ui'],
    ['Math', 'math'],
    ['Cursive', 'cursive'],
    ['FANTASY', 'fantasy'],
    [`'monospace'`, '"monospace"'],
    ['"sans-serif"', '"sans-serif"'],
    [`'system-ui'`, '"system-ui"'],
    [`'math'`, '"math"'],
    [`serif, 'serif'`, 'serif, "serif"'],
    ['monospace, monospace', 'monospace, monospace'],
    // quoted in another case it is no generic family, and needs none
    [`'Serif'`, 'Serif'],
    [`'MONOSPACE'`, 'MONOSPACE'],
    [`'Sans-Serif'`, 'Sans-Serif'],
    // what is no keyword to Chrome is a name, in its own case
    ['UI-Sans-Serif', 'UI-Sans-Serif'],
    [`'ui-serif'`, 'ui-serif'],
    ['Emoji', 'Emoji'],
    [`'emoji'`, 'emoji'],
    [`'none'`, 'none'],
    // a CSS-wide keyword and `default` would mean that, in any case
    [`'inherit'`, '"inherit"'],
    [`'INHERIT'`, '"INHERIT"'],
    [`'Initial'`, '"Initial"'],
    ['"unset"', '"unset"'],
    [`'Revert-Layer'`, '"Revert-Layer"'],
    [`'default'`, '"default"'],
    [`'Default'`, '"Default"'],
    // and a list is its names, with nothing after them
    ['Inter , Arial,serif', 'Inter, Arial, serif'],
    [
      `'Inter', 'Helvetica Neue', Arial, sans-serif`,
      'Inter, "Helvetica Neue", Arial, sans-serif',
    ],
    [
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto',
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto',
    ],
  ];
  const { node } = await render(
    '<style>' +
      lists.map(([list], i) => `#l${i} { font-family: ${list} }`).join('') +
      '</style>' +
      lists.map((_, i) => `<i id="l${i}"></i>`).join(''),
  );
  const el = view(node);
  lists.forEach(([list, want], i) => {
    assert.strictEqual(
      el.computedStyle(findById(el.document, `l${i}`)!)?.['font-family'],
      want,
      list,
    );
  });
});

test('a host may name what no sheet could, and reads as it named it', async () => {
  // its family is no declaration, so nothing dropped it for being no name
  const { node } = await render('<p id="p">a</p>', 400, {
    fontFamily: `Host 9, 'Segoe UI', serif`,
  });
  const el = view(node);
  assert.strictEqual(
    el.computedStyle(findById(el.document, 'p')!)?.['font-family'],
    '"Host 9", "Segoe UI", serif',
  );
});

test('font-family takes what Chrome takes, and a name that is none drops the declaration', async () => {
  // Chrome 151's answers, each read back from that browser, by way of a sheet
  // and of `font`: null is a declaration it dropped, whose element kept the
  // rule before it. Each has a sheet of its own, since some leave a bracket
  // open
  const lists: [string, string | null][] = [
    // a generic family is a word alone, and only as the first word is it one
    ['serif Foo', null],
    ['monospace monospace', null],
    ['cursive serif', null],
    ['SERIF Foo', null],
    ['Foo, serif Bar', null],
    ['serif Foo, Bar', null],
    ['s\\65rif Foo', null],
    ['serif/**/Foo', null],
    ['-webkit-body Foo', null],
    ['Foo, -webkit-body Bar', null],
    ['Foo serif', '"Foo serif"'],
    ['Foo -webkit-body', '"Foo -webkit-body"'],
    ['serif\\ Foo', '"serif Foo"'],
    ['serif\\,Foo', '"serif,Foo"'],
    // what is no keyword to Chrome may have words after it
    ['emoji Foo', '"emoji Foo"'],
    ['fangsong Foo', '"fangsong Foo"'],
    ['ui-serif Foo', '"ui-serif Foo"'],
    ['-webkit-standard Foo', '"-webkit-standard Foo"'],
    ['-apple-system Foo', '"-apple-system Foo"'],
    ['-WEBKIT-BODY', '-webkit-body'],
    ['-Webkit-Body, Foo', '-webkit-body, Foo'],
    [`'-webkit-body'`, '-webkit-body'],
    // a CSS-wide keyword or `default` is no name in a list, or alone
    ['Inter, inherit', null],
    ['inherit, Foo', null],
    ['Foo, Initial', null],
    ['Foo, unset', null],
    ['Foo, revert', null],
    ['Foo, revert-layer', null],
    ['Foo, revert-rule', null],
    ['default', null],
    ['DEFAULT', null],
    ['Foo, default', null],
    ['default, Foo', null],
    ['d\\65 fault', null],
    ['Foo, \\69nherit', null],
    ['FirstName, Initial, LastName', null],
    // and it is one with a word beside it, or as a string
    ['initial Foo', '"initial Foo"'],
    ['revert-rule Foo', '"revert-rule Foo"'],
    ['Foo inherit', '"Foo inherit"'],
    ['default Foo', '"default Foo"'],
    ['Foo default', '"Foo default"'],
    ['inherit\\ Foo', '"inherit Foo"'],
    [`'inherit', Foo`, '"inherit", Foo'],
    [`Foo, 'default'`, 'Foo, "default"'],
    [`'revert-rule'`, '"revert-rule"'],
    [`'REVERT-RULE'`, '"REVERT-RULE"'],
    // a string is a name whole, with nothing beside it
    [`'Foo Bar' Baz`, null],
    [`Foo 'Bar'`, null],
    [`'Foo' 'Bar'`, null],
    [`'Foo''Bar'`, null],
    [`'Foo'Bar`, null],
    [`Foo'Bar'`, null],
    [`'Foo'/**/'Bar'`, null],
    ['"Lucida" Grande, sans-serif', null],
    [`'a\nb'`, null],
    [`"a\nb", Bar`, null],
    // nothing else makes a name
    ['Red/Black, sans-serif', null],
    ['Ahem!, sans-serif', null],
    ['test@foo, sans-serif', null],
    ['#POUND, sans-serif', null],
    ['Hawaii 5-0, sans-serif', null],
    ['1Foo', null],
    ['-1a', null],
    ['-', null],
    ['Foo-->', null],
    ['Foo(Bar)', null],
    ['generic(kai)', null],
    ['Foo,', null],
    [',Foo', null],
    ['Foo, , Bar', null],
    ['--foo', '"--foo"'],
    ['__foo', '__foo'],
    ['Foo/**/Bar', '"Foo Bar"'],
    // an escape is a name's, and may hold what would have ended it
    ['Foo\\ Bar', '"Foo Bar"'],
    ['Foo\\, Bar', '"Foo, Bar"'],
    ['Foo\\  Bar', '"Foo  Bar"'],
    ['Foo\\,Bar', '"Foo,Bar"'],
    ['Foo\\ Bar Baz', '"Foo Bar Baz"'],
    ['Foo\\ Bar, serif', '"Foo Bar", serif'],
    ['Foo\\ , Bar', '"Foo ", Bar'],
    ['Foo\\,,Bar', '"Foo,", Bar'],
    ['Foo\\ ', '"Foo "'],
    ['\\ Foo', '" Foo"'],
    ['\\,', '","'],
    ['Foo\\\\', '"Foo\\\\"'],
    ['Foo\\\\, Bar', '"Foo\\\\", Bar'],
    ['Foo\\\\\\, Bar', '"Foo\\\\, Bar"'],
    ['Foo\\"Bar', '"Foo\\"Bar"'],
    ['Foo\\/Bar', '"Foo/Bar"'],
    ['Foo\\.Bar', '"Foo.Bar"'],
    ['Foo\\!', '"Foo!"'],
    ['Foo\\;', '"Foo;"'],
    ['Foo\\{Bar', '"Foo{Bar"'],
    ['Foo\\}Bar', '"Foo}Bar"'],
    ['Foo\\(Bar\\)', '"Foo(Bar)"'],
    ['Foo\\\tBar', '"Foo\\9 Bar"'],
    ['Foo\\ Bar !important', '"Foo Bar"'],
    ['Foo\\  !important', '"Foo "'],
    ['\\1F600 Foo', '😀Foo'],
    // but for a line, which an escape cannot hold outside a string
    ['Foo\\\nBar', null],
    ['Foo\\\rBar', null],
    ['Foo\\\fBar', null],
    // an escaped digit starts a name, which a digit cannot, and so does a
    // hyphen where a name goes on after it
    ['\\31 996', '"1996"'],
    ['\\31 996 Foo', '"1996 Foo"'],
    ['Foo \\31 996', '"Foo 1996"'],
    ['-\\31 a', '"-1a"'],
    ['\\2d', '"-"'],
    ['\\2d foo', '-foo'],
    ['\\2d\\2d foo', '"--foo"'],
    // a string ends where its quote does, whatever comes before that
    [`'a\\'b'`, `"a'b"`],
    [`'a\\\\'`, '"a\\\\"'],
    [`'a\\\\', Bar`, '"a\\\\", Bar'],
    [`'a\\\\\\'b', Bar`, `"a\\\\'b", Bar`],
    [`'a\\,b'`, '"a,b"'],
    [`'Foo\\ Bar'`, '"Foo Bar"'],
    [`'a\\62'`, 'ab'],
    [`'a\\\fb'`, 'ab'],
    [`'a\\\rb'`, 'ab'],
    [`'a\\\r\nb'`, 'ab'],
    ['F\\000006Fo', '"F\\6 Fo"'],
  ];
  const { node } = await render(
    lists
      .map(
        ([list], i) =>
          `<style>#l${i} { font-family: Before; font-family: ${list};\n}</style>` +
          `<style>#s${i} { font: 20px Before; font: italic 12px ${list};\n}</style>`,
      )
      .join('') +
      lists.map((_, i) => `<i id="l${i}"></i><i id="s${i}"></i>`).join(''),
  );
  const el = view(node);
  const read = (id: string) => el.computedStyle(findById(el.document, id)!)!;
  lists.forEach(([list, want], i) => {
    assert.strictEqual(read(`l${i}`)['font-family'], want ?? 'Before', list);
    const short = read(`s${i}`);
    assert.strictEqual(short['font-family'], want ?? 'Before', `font: ${list}`);
    // and a family that is none is a `font` that is none, size and all
    assert.strictEqual(short['font-size'], want ? '12px' : '20px', list);
    assert.strictEqual(short['font-style'], want ? 'italic' : 'normal', list);
  });
});

test('the end of a style attribute closes a string left open, and a backslash escapes nothing there', async () => {
  // Chrome 151's answers, as `font-family` and through `font`. Not its answer
  // for `Foo\` itself, `Foo�`, which here is no name
  const lists: [string, string | null][] = [
    [`'Foo`, 'Foo'],
    ['"Foo', 'Foo'],
    [`'Foo, Bar`, '"Foo, Bar"'],
    [`Foo, 'Bar`, 'Foo, Bar'],
    [`'a\\`, 'a'],
    [`'\\'`, `"'"`],
    [`'`, '""'],
    [`'Foo' 'Bar`, null],
  ];
  const attribute = (text: string) => text.replace(/"/g, '&quot;');
  const { node } = await render(
    lists
      .map(
        ([list], i) =>
          `<i id="l${i}" style="font-family: Before; font-family: ${attribute(list)}"></i>` +
          `<i id="s${i}" style="font: 12px Before; font: 12px ${attribute(list)}"></i>`,
      )
      .join(''),
  );
  const el = view(node);
  lists.forEach(([list, want], i) => {
    for (const id of [`l${i}`, `s${i}`]) {
      assert.strictEqual(
        el.computedStyle(findById(el.document, id)!)?.['font-family'],
        want ?? 'Before',
        `${id}: ${list}`,
      );
    }
  });
});

test('a family reaches the text engine as what it names, and one with a comma in it not at all', async () => {
  // Chrome matches no face for `'Courier New, Arial'` and goes on to the next
  // name, which its widths say, where a list split at its commas had handed
  // the engine two families the page never wrote
  const lists: [string, string][] = [
    ['Foo\\ Bar, serif', 'Foo Bar, serif'],
    ['Foo\\  Bar, serif', 'Foo  Bar, serif'],
    [`'F\\6Fo', serif`, 'Foo, serif'],
    [`'a\\'b', serif`, `a'b, serif`],
    [`'Foo\\\nBar', serif`, 'FooBar, serif'],
    ['\\31 996, serif', '1996, serif'],
    ['Courier   New, serif', 'Courier New, serif'],
    ['SERIF', 'serif'],
    ['Foo, s\\65rif', 'Foo, serif'],
    // past a name with a comma in it, however it was written
    ['Foo\\, Bar, serif', 'serif'],
    [`'Courier New, Arial', serif`, 'serif'],
    [`Foo, 'a,b', serif`, 'Foo, serif'],
    // and to the document's own font where nothing else is left, as a list
    // that ends in no generic family goes
    ['Foo\\,Bar', 'Host Sans'],
    [`''`, 'Host Sans'],
    ['Foo\\ Bar', 'Foo Bar, Host Sans'],
    // a generic family in any case is the end of a list
    ['BlinkMacSystemFont', 'BlinkMacSystemFont'],
    ['UI-Serif', 'UI-Serif'],
    [`'serif'`, 'serif, Host Sans'],
  ];
  const { node } = await render(
    '<style>' +
      lists.map(([list], i) => `#l${i} { font-family: ${list} }`).join('') +
      '</style>' +
      lists.map((_, i) => `<i id="l${i}">a</i>`).join(''),
    400,
    { fontFamily: 'Host Sans' },
  );
  const el = view(node);
  lists.forEach(([list, want], i) => {
    const box = boxOf(el, `l${i}`) as unknown as { style: ComputedStyle };
    assert.strictEqual(box.style.fontFamily, want, list);
    assert.strictEqual(box.style.familyWritten, want, list);
  });
});

test('every reader of a family reads it the one way', () => {
  // a drawing's text
  const shape = {
    units: { em: 16, rem: 16, vw: 0, vh: 0, scale: 1 },
    color: '#000000',
    scheme: 'light' as const,
  };
  const family = (value: string) => shapeValue('font-family', value, shape);
  assert.strictEqual(family('Foo\\ Bar, serif'), '"Foo Bar", serif');
  // which a list trims, and an engine's name is the same
  assert.strictEqual(family('Foo\\ '), '"Foo"');
  assert.strictEqual(family(`'a\\'b'`), `"a'b"`);
  for (const list of ['serif Foo', 'Foo, inherit', `'Foo' Bar`, `'a'b'`]) {
    assert.strictEqual(family(list), null, list);
  }
  assert.strictEqual(shapeFont('12px Foo\\ ', shape)?.['font-family'], '"Foo"');
  // a page's `document.fonts`
  assert.strictEqual(fontQuery('12px serif Foo'), null);
  assert.strictEqual(fontQuery('12px Foo, default'), null);
  assert.strictEqual(fontQuery(`12px 'Foo' Bar`), null);
  assert.deepStrictEqual(
    fontQuery(`12px Foo\\ Bar, 'a\\'b', 'c, d', 'serif', SERIF`)?.families,
    ['Foo Bar', `a'b`, 'c, d', 'serif'],
  );
  // and a `@font-face`, whose name the list it is matched with has to read
  // the same
  const face = (name: string) =>
    parseStylesheet(`@font-face { font-family: ${name}; src: url(a.ttf) }`)
      .fontFaces[0]?.family;
  assert.strictEqual(face('Foo\\ Bar'), 'Foo Bar');
  assert.strictEqual(face('Foo  Bar'), 'Foo Bar');
  assert.strictEqual(face('Foo\\ '), 'Foo');
  assert.strictEqual(face(`'Foo Bar'`), 'Foo Bar');
  assert.strictEqual(face(`'a\\'b'`), `a'b`);
  assert.strictEqual(face('\\31 996'), '1996');
  // a generic family's name, a list, or none
  assert.strictEqual(face('serif'), undefined);
  assert.strictEqual(face('serif Foo'), undefined);
  assert.strictEqual(face('Foo, Bar'), undefined);
  assert.strictEqual(face(`'Foo, Bar'`), undefined);
  assert.strictEqual(face('Foo\\,Bar'), undefined);
  assert.strictEqual(face(`'Foo' Bar`), undefined);
  assert.strictEqual(face('inherit'), undefined);
});

test('an escape holds what it escapes wherever a value is split or trimmed', () => {
  assert.deepStrictEqual(splitCommas('Foo\\, Bar, Baz'), ['Foo\\, Bar', 'Baz']);
  assert.deepStrictEqual(splitCommas(`'a\\\\', b`), [`'a\\\\'`, 'b']);
  assert.deepStrictEqual(splitCommas(`'a\\', b', c`), [`'a\\', b'`, 'c']);
  assert.deepStrictEqual(splitCommas('Foo\\\\, Bar'), ['Foo\\\\', 'Bar']);
  assert.deepStrictEqual(splitValue('Foo\\ Bar Baz'), ['Foo\\ Bar', 'Baz']);
  assert.deepStrictEqual(splitValue(`'a\\\\' b`), [`'a\\\\'`, 'b']);
  assert.strictEqual(trimValue('  Foo\\  '), 'Foo\\ ');
  assert.strictEqual(trimValue('  Foo\\\\  '), 'Foo\\\\');
  assert.strictEqual(trimValue('  Foo\\\\\\  '), 'Foo\\\\\\ ');
  assert.strictEqual(trimValue('  Foo\\'), 'Foo\\');
  assert.strictEqual(trimValue('  Foo  '), 'Foo');
  assert.strictEqual(trimValue(' \n '), '');
});

test('an escaped digit that starts an identifier stays one, in any property', async () => {
  // Chrome 151's answers: a length is not an identifier that reads like one,
  // and what a digit after a `#` or a resolved hyphen starts is what it was
  const { node } = await render(
    '<style>' +
      '#a { width: 50px; width: \\31 00px }' +
      '#b { color: red; color: #\\31 23 }' +
      '#c { display: block; display: \\2d webkit-box }' +
      '</style><div id="a"></div><div id="b"></div><div id="c"></div>',
  );
  const el = view(node);
  const read = (id: string) => el.computedStyle(findById(el.document, id)!)!;
  assert.strictEqual(read('a').width, '50px');
  assert.strictEqual(read('b').color, 'rgb(17, 34, 51)');
  assert.strictEqual(read('c').display, '-webkit-box');
  assert.strictEqual(
    parseDeclarations('--x: \\31 a').find((d) => d.prop === '--x')?.value,
    '\\31 a',
  );
});

test('where no sheet named a family it reads as the host named one, and the host’s code face as what it stands for', async () => {
  // Chrome answers the font its settings name, `Times`, and `monospace` for
  // what its UA sheet sets in that generic, whichever face it comes to
  const { node } = await render(
    '<style>.shorthand { font: italic 12px/2 "Page Face" }' +
      '@font-face { font-family: Loaded; src: url(a.ttf) }</style>' +
      '<p id="p">a</p><a id="a" href="#">a</a><h1 id="h">a</h1>' +
      '<pre id="pre">a</pre><code id="code">a</code><kbd id="kbd">a</kbd>' +
      '<textarea id="field"></textarea>' +
      '<pre id="inherits" style="font-family: inherit">a</pre>' +
      '<pre id="initial" style="font-family: initial">a</pre>' +
      '<div style="font-family: Outer"><pre id="own">a</pre><b id="b">a</b></div>' +
      '<div class="shorthand" id="short">a</div>' +
      '<font id="face" face="Foo Bar, Arial">a</font>' +
      '<div id="declared" style="font-family: Loaded">a</div>' +
      '<div id="vars" style="--f: Inter, \'Helvetica Neue\'; font-family: var(--f)">a</div>',
    400,
    {
      fontFamily: `Host Sans, 'Segoe UI', serif`,
      monoFamily: `"Host Mono", monospace`,
    },
  );
  const el = view(node);
  const family = (id: string) =>
    el.computedStyle(findById(el.document, id)!)?.['font-family'];
  const host = '"Host Sans", "Segoe UI", serif';
  for (const id of ['p', 'a', 'h', 'inherits', 'initial']) {
    assert.strictEqual(family(id), host, id);
  }
  for (const id of ['pre', 'code', 'kbd', 'field', 'own']) {
    assert.strictEqual(family(id), 'monospace', id);
  }
  assert.strictEqual(family('b'), 'Outer', 'inherited');
  // a list the sheet ended goes on to the document's family, and reads as
  // it ended
  assert.strictEqual(
    (boxOf(el, 'b') as unknown as { style: ComputedStyle }).style.fontFamily,
    `Outer, Host Sans, 'Segoe UI', serif`,
  );
  assert.strictEqual(family('short'), '"Page Face"', 'through `font`');
  assert.strictEqual(family('face'), '"Foo Bar", Arial', 'through `face`');
  assert.strictEqual(family('vars'), 'Inter, "Helvetica Neue"');
  // a face of its own that has not loaded, which the list leaves out
  assert.strictEqual(family('declared'), 'Loaded');
  assert.ok(
    !(
      boxOf(el, 'declared') as unknown as { style: ComputedStyle }
    ).style.fontFamily.includes('Loaded'),
    'the engine is handed none of it yet',
  );
  assert.strictEqual(
    el.computedStyle(findById(el.document, 'p')!, 'before')?.['font-family'],
    host,
  );
});

/** What `font` reads of an element with `own` for its style, in a parent with
 *  `parent` for its, under `font: 16px Times`, which is what Chrome's unstyled
 *  element reads. */
async function fontsOf(
  cases: readonly (readonly [own: string, parent?: string])[],
): Promise<(string | undefined)[]> {
  const { node } = await render(
    '<div style="font: 16px Times">' +
      cases
        .map(
          ([own, parent = ''], i) =>
            `<div style="${parent}"><div id="f${i}" style="${own}">a</div></div>`,
        )
        .join('') +
      '</div>',
  );
  const el = view(node);
  return cases.map(
    (_, i) => el.computedStyle(findById(el.document, `f${i}`)!)?.font,
  );
}

test('font reads as its longhands come to, in the order every engine writes them', async () => {
  // what Chrome 151, Firefox 153 and WebKit 26 read of each, on a test page
  const cases: [string, string][] = [
    ['', '16px Times'],
    [
      'font: italic bold 16px/20px Inter, serif',
      'italic 700 16px / 20px Inter, serif',
    ],
    [`font: 13px 'Helvetica Neue'`, '13px "Helvetica Neue"'],
    ['font: 12px monospace', '12px monospace'],
    [`font-family: 'monospace'`, '16px "monospace"'],
    ['font-family: Inter, sans-serif', '16px Inter, sans-serif'],
    [
      'font: italic small-caps 700 condensed 12px/1.5 Georgia, serif',
      'italic small-caps 700 condensed 12px / 18px Georgia, serif',
    ],
    ['font: normal normal normal normal 12px serif', '12px serif'],
    ['font: 150% serif', '24px serif'],
    ['font: 12px/normal serif', '12px serif'],
    ['font-style: italic', 'italic 16px Times'],
    ['font-style: oblique', 'oblique 16px Times'],
    ['font-variant-caps: small-caps', 'small-caps 16px Times'],
    ['font-variant: small-caps', 'small-caps 16px Times'],
    ['font-weight: 400', '16px Times'],
    ['font-weight: 300', '300 16px Times'],
    ['font-weight: bold', '700 16px Times'],
    ['font-weight: bolder', '700 16px Times'],
    ['font-weight: 450', '450 16px Times'],
    // the width each keyword is, whichever way it was written
    ['font-stretch: ultra-condensed', 'ultra-condensed 16px Times'],
    ['font-stretch: 62.5%', 'extra-condensed 16px Times'],
    ['font-stretch: 75%', 'condensed 16px Times'],
    ['font-stretch: calc(50% + 25%)', 'condensed 16px Times'],
    ['font-stretch: 87.5%', 'semi-condensed 16px Times'],
    ['font-stretch: 100%', '16px Times'],
    ['font-stretch: normal', '16px Times'],
    ['font-stretch: 112.5%', 'semi-expanded 16px Times'],
    ['font-stretch: 125%', 'expanded 16px Times'],
    ['font-stretch: 150%', 'extra-expanded 16px Times'],
    ['font-stretch: 200%', 'ultra-expanded 16px Times'],
    ['font: semi-expanded 12px serif', 'semi-expanded 12px serif'],
    // a line height in pixels, whatever it was written in
    ['line-height: 1.5', '16px / 24px Times'],
    ['line-height: 150%', '16px / 24px Times'],
    ['line-height: 22px', '16px / 22px Times'],
    ['line-height: 2em', '16px / 32px Times'],
    ['line-height: calc(10px + 4px)', '16px / 14px Times'],
    ['line-height: 0', '16px / 0px Times'],
    ['line-height: normal', '16px Times'],
    ['font-size: 13px; line-height: 1.37', '13px / 17.81px Times'],
    ['font-size: 13.5px', '13.5px Times'],
    ['font-size: 0', '0px Times'],
    ['font-size: 1.25em', '20px Times'],
    // what it does not set
    ['letter-spacing: 1px', '16px Times'],
    ['text-rendering: optimizeLegibility', '16px Times'],
    ['font-synthesis: none', '16px Times'],
    ['font-palette: dark', '16px Times'],
    ['display: none; font: 12px serif', '12px serif'],
  ];
  const read = await fontsOf(cases.map(([own]) => [own]));
  cases.forEach(([own, want], i) => assert.strictEqual(read[i], want, own));
});

test('font reads nothing where a longhand has a value it has no way to say', async () => {
  // all three engines' answer, but for the two WebKit has no property for,
  // `font-variant-emoji` and `font-language-override`
  const own = [
    'font-stretch: 80%',
    'font-stretch: 110%',
    'font-stretch: 60%',
    'font-variant-numeric: tabular-nums',
    'font-variant-ligatures: none',
    'font-variant-ligatures: no-common-ligatures',
    'font-variant-ligatures: common-ligatures',
    'font-variant-position: sub',
    'font-variant-caps: all-small-caps',
    'font-variant-caps: petite-caps',
    'font-variant-caps: unicase',
    'font-variant-caps: titling-caps',
    'font-kerning: none',
    'font-kerning: normal',
    `font-feature-settings: 'tnum'`,
    `font-feature-settings: 'tnum' 0`,
    'font-variant-east-asian: jis78',
    'font-variant-east-asian: ruby full-width jis78',
    'font-variant-alternates: historical-forms',
    'font-variant-alternates: HISTORICAL-FORMS',
    'font-variant-alternates: stylistic(a) swash(b)',
    'font-variant-alternates: styleset(a, b)',
    'font-variant-emoji: text',
    'font-variant-emoji: emoji',
    'font-variant-emoji: unicode',
    'font-size-adjust: 0.5',
    'font-size-adjust: 0',
    'font-size-adjust: from-font',
    'font-size-adjust: cap-height 0.5',
    'font-size-adjust: cap-height from-font',
    'font-size-adjust: calc(0.25 + 0.25)',
    `font-variation-settings: 'wght' 500`,
    `font-variation-settings: 'wght' 500, 'wdth' 90`,
    `font-variation-settings: 'wght'500`,
    `font-variation-settings: 'wght' -1.5`,
    `font-variation-settings: 'wght' calc(1 + 1)`,
    'font-optical-sizing: none',
    'font-optical-sizing: NONE',
    `font-language-override: 'SRB'`,
    `font-language-override: 'S'`,
    'font-variant: none',
    'font-variant: jis78',
    'font-variant: emoji',
    'font-variant: small-caps tabular-nums',
    'font-variant: styleset(a, b) small-caps',
    // set after a `font`, which has no say then
    'font: 12px serif; font-variant-numeric: tabular-nums',
    'font: 12px serif; font-size-adjust: 0.5',
    // what `font-variant` leaves of a longhand it does not set
    'font-size-adjust: 0.5; font-variant: normal',
    // a bit of the field, and not all of it
    'font-size-adjust: 0.5; font-optical-sizing: none; font-size-adjust: initial',
  ];
  const read = await fontsOf(own.map((s) => [s]));
  own.forEach((s, i) => assert.strictEqual(read[i], '', s));
});

test('a value a longhand of font does not take, or its initial one, leaves font to read', async () => {
  const own = [
    'font-size-adjust: banana',
    'font-size-adjust: -1',
    'font-size-adjust: 0.5 cap-height',
    'font-size-adjust: cap-height',
    'font-size-adjust: banana 0.5',
    'font-size-adjust: cap-height 0.5 0.5',
    'font-size-adjust: none',
    'font-size-adjust: NONE',
    'font-optical-sizing: banana',
    'font-optical-sizing: auto',
    'font-optical-sizing: AUTO',
    `font-variation-settings: 'wght'`,
    `font-variation-settings: 'wg' 500`,
    `font-variation-settings: 'wght' on`,
    'font-variation-settings: normal',
    'font-variant-east-asian: banana',
    'font-variant-east-asian: jis78 jis83',
    'font-variant-east-asian: full-width proportional-width',
    'font-variant-east-asian: normal',
    'font-variant-alternates: banana',
    'font-variant-alternates: stylistic(1)',
    'font-variant-alternates: swash(a, b)',
    'font-variant-alternates: swash(a) swash(b)',
    'font-variant-alternates: swash()',
    'font-variant-alternates: normal',
    'font-variant-emoji: banana',
    'font-variant-emoji: normal',
    'font-language-override: SRB',
    `font-language-override: 'TOOLONG'`,
    `font-language-override: ''`,
    'font-language-override: normal',
    'font-variant: jis78 jis83',
    'font-variant: none jis78',
    'font-variant: normal jis78',
    'font-variant: normal',
    'font-variant-numeric: normal',
    'font-variant-ligatures: normal',
    'font-feature-settings: normal',
    'font-kerning: auto',
  ];
  const read = await fontsOf(own.map((s) => [s]));
  own.forEach((s, i) => assert.strictEqual(read[i], '16px Times', s));
});

test('font sets back all it cannot say, and those it cannot say inherit', async () => {
  const twelve = '12px serif';
  const sets = [
    `font-feature-settings: 'tnum'`,
    'font-kerning: none',
    'font-variant-numeric: tabular-nums',
    'font-variant-ligatures: none',
    'font-variant-position: sub',
    'font-variant-caps: all-small-caps',
    'font-stretch: 80%',
    'font-size-adjust: .5',
    `font-variation-settings: 'wght' 500`,
    'font-optical-sizing: none',
    'font-variant-east-asian: jis78',
    'font-variant-alternates: historical-forms',
    'font-variant-emoji: text',
    `font-language-override: 'SRB'`,
  ];
  const cases: [own: string, parent: string, want: string][] = [
    ...sets.flatMap((set): [string, string, string][] => [
      [`${set}; font: 12px serif`, '', twelve],
      ['font: 12px serif', set, twelve],
      ['', set, ''],
      ['font: inherit', set, ''],
      ['font: unset', set, ''],
    ]),
    // each property by itself, the others in the field left as they were
    ['font-size-adjust: none', 'font-size-adjust: .5', '16px Times'],
    ['font-size-adjust: initial', 'font-size-adjust: .5', '16px Times'],
    ['font-size-adjust: unset', 'font-size-adjust: .5', ''],
    ['font-size-adjust: inherit', 'font-size-adjust: .5', ''],
    ['font-variant-numeric: unset', 'font-variant-numeric: tabular-nums', ''],
    [
      'font-variant-numeric: initial',
      'font-variant-numeric: tabular-nums',
      '16px Times',
    ],
    ['font-kerning: unset', 'font-kerning: none', ''],
    ['font-feature-settings: unset', `font-feature-settings: 'tnum'`, ''],
    [
      'font-optical-sizing: auto; font-size-adjust: inherit',
      'font-optical-sizing: none',
      '16px Times',
    ],
    // what `inherit` has to bring back: a field an element inherited is the
    // parent's already, until something earlier on it says otherwise
    [
      `font-feature-settings: normal; font: inherit`,
      `font-feature-settings: 'tnum'`,
      '',
    ],
    ['font-size-adjust: none; font: inherit', 'font-size-adjust: .5', ''],
    ['font-size-adjust: .5; font: inherit', '', '16px Times'],
    [`font-feature-settings: 'tnum'; font: inherit`, '', '16px Times'],
    [
      'font-variant-east-asian: normal; font-variant: inherit',
      'font-variant-east-asian: jis78',
      '',
    ],
    ['font-variant-east-asian: jis78; font-variant: inherit', '', '16px Times'],
    // `font-variant` sets back the three it stands for and no others
    ['font-variant-east-asian: jis78; font-variant: normal', '', '16px Times'],
    [
      'font-variant: normal',
      'font-variant-numeric: tabular-nums',
      '16px Times',
    ],
    ['font-variant-east-asian: jis78; font-variant: none', '', ''],
    ['font-variant: inherit', 'font-variant-east-asian: jis78', ''],
    [
      'font-size-adjust: none; font-variant: inherit',
      'font-size-adjust: .5',
      '16px Times',
    ],
    ['font-size-adjust: .5; all: initial; font: 16px Times', '', '16px Times'],
    ['all: inherit', 'font-size-adjust: .5', ''],
  ];
  const read = await fontsOf(cases.map(([own, parent]) => [own, parent]));
  cases.forEach(([own, parent, want], i) =>
    assert.strictEqual(read[i], want, `${own} in ${parent}`),
  );
});

test('font reads the host’s family where no sheet named one, in CSS pixels whatever the zoom', async () => {
  const { node } = await render(
    '<style>#p::before { content: "x"; font: italic 700 12px/2 Inter, serif }' +
      '@font-face { font-family: Loaded; src: url(a.ttf) }</style>' +
      '<p id="plain">a</p><pre id="pre">a</pre><i id="i">a</i>' +
      '<div id="z" style="zoom: 2; font: 12px/20px serif">a</div>' +
      '<div id="n" style="zoom: 2; font: 12px/1.5 serif">a</div>' +
      '<div id="declared" style="font: 12px Loaded">a</div>' +
      '<div id="p">a</div>',
    400,
    { fontFamily: `Host Sans, 'Segoe UI', serif`, monoFamily: 'Host Mono' },
  );
  const el = view(node);
  const font = (id: string, pseudo?: 'before') =>
    el.computedStyle(findById(el.document, id)!, pseudo)?.font;
  const host = '"Host Sans", "Segoe UI", serif';
  const size = el.computedStyle(findById(el.document, 'plain')!)?.['font-size'];
  assert.strictEqual(font('plain'), `${size} ${host}`);
  assert.strictEqual(font('i'), `italic ${size} ${host}`);
  assert.match(font('pre')!, /^[\d.]+px monospace$/);
  assert.strictEqual(font('z'), '12px / 20px serif');
  assert.strictEqual(font('n'), '12px / 18px serif');
  // a face of its own that has not loaded, which the engine is handed none of
  assert.strictEqual(font('declared'), '12px Loaded');
  assert.strictEqual(
    font('p', 'before'),
    'italic 700 12px / 24px Inter, serif',
  );
});

metric(
  'font reads in CSS pixels on a display of two device pixels to one',
  async () => {
    const { node } = await render2x(
      '<div id="a" style="font: 12px/1.5 serif">a</div>' +
        '<div id="b" style="font: 12px/20px serif">a</div>',
    );
    const el = view(node);
    const font = (id: string) =>
      el.computedStyle(findById(el.document, id)!)?.font;
    assert.strictEqual(font('a'), '12px / 18px serif');
    assert.strictEqual(font('b'), '12px / 20px serif');
  },
);

test("attr()'s name may be a var(), and a type too, which are read once they are substituted", async () => {
  // attr-argument-grammar.html: `attr(var(--x))` is the attribute and the
  // type `--x` holds; one that is no name and type once it is substituted
  // is its fallback, or no value
  const { node } = await render(
    '<body style="margin:0"><style>div { height: 5px }' +
      ' #n { --x: data-w px; width: attr(var(--x)) }' +
      ' #t { --type: type(<length>); width: attr(data-l var(--type)) }' +
      ' #f { --x: data-w px; width: attr(var(--x), 9px) }' +
      ' #b { --x: data-w px, 1px; width: 50px; width: attr(var(--x), 8px) }' +
      ' #c { --y: data-c type(*); --c: attr(var(--y)) }' +
      '</style>' +
      '<div id="n" data-w="12"></div>' +
      '<div id="t" data-l="calc(10px + 3px)"></div>' +
      '<div id="f" data-w="wide"></div>' +
      '<div id="b" data-w="12"></div>' +
      '<div id="c" data-c="var(--c)"></div></body>',
  );
  const el = view(node);
  const width = (id: string) => boxOf(el, id).width;
  assert.strictEqual(width('n'), 12);
  assert.strictEqual(width('t'), 13);
  assert.strictEqual(width('f'), 9, 'not a number: the fallback');
  assert.strictEqual(width('b'), 8, 'no name and type: the fallback');
  // an attribute that reads the property its attr() is in is a cycle
  assert.strictEqual(el.customProperty(findById(el.document, 'c')!, '--c'), '');
});

test('attr() reads an attribute in a namespace a @namespace rule declares, and no prefix it does not, nor any', async () => {
  // CSS Values 5, 8.7: `attr(ns|name)` is the attribute in the namespace
  // the sheet's prefix stands for — as an XHTML document read as HTML
  // holds it, `prefix:name` under an `xmlns:prefix` — `|name` one in none,
  // an undeclared prefix none at all, and `*|name` no attr() at all
  const { node } = await render(
    '<style>@namespace color "http://www.example.com/";' +
      ' @namespace Other url(http://www.example.com/other);' +
      ' div { --a: attr(color|myAttr type(*), red);' +
      ' --b: attr(Other|myAttr type(*), red);' +
      ' --c: attr(foo|bar type(*), green);' +
      ' --d: attr(|bar type(*), red);' +
      ' --e: initial; --e: attr(*|bar type(*), green);' +
      ' --f: attr(other|myAttr type(*), none) }</style>' +
      '<section xmlns:color="http://www.example.com/" xmlns:o="http://www.example.com/other">' +
      '<div id="t" color:myAttr="green" o:myattr="blue" bar="lime"></div></section>',
  );
  const el = view(node);
  const prop = (name: string) =>
    el.customProperty(findById(el.document, 't')!, name);
  assert.strictEqual(prop('--a'), 'green');
  assert.strictEqual(prop('--b'), 'blue');
  assert.strictEqual(prop('--c'), 'green', 'undeclared: the fallback');
  assert.strictEqual(prop('--d'), 'lime', 'no namespace');
  assert.strictEqual(prop('--e'), '', 'a wildcard is no attr()');
  assert.strictEqual(prop('--f'), 'none', 'a prefix is case-sensitive');
});

test("a change of an attribute an attr() reads only by a var()'s name, or in a namespace, restyles the element", async () => {
  const { node } = await render(
    '<body style="margin:0"><style>div { height: 5px }' +
      ' #v { --x: data-w px; width: attr(var(--x)) }</style>' +
      '<div id="v" data-w="12"></div></body>',
  );
  const el = view(node);
  const v = findById(el.document, 'v')!;
  assert.strictEqual(boxOf(el, 'v').width, 12);
  v.attribs['data-w'] = '30';
  el.touchDocument([
    { type: 'attributes', target: v, attributeName: 'data-w', oldValue: '12' },
  ]);
  await waitFor(() => assert.strictEqual(boxOf(el, 'v').width, 30));
});

test('view-transition-name takes none, match-element, auto or a name, and view-transition-class names, none of them a keyword', () => {
  assert.strictEqual(specifiedValue('view-transition-name', 'Foo'), 'Foo');
  assert.strictEqual(
    specifiedValue('view-transition-name', 'maTch-element'),
    'match-element',
  );
  for (const bad of ['default', 'none none', '"foo"', '#fff', '12px']) {
    assert.strictEqual(specifiedValue('view-transition-name', bad), null, bad);
  }
  assert.strictEqual(specifiedValue('view-transition-class', 'a  b'), 'a b');
  assert.strictEqual(specifiedValue('view-transition-class', 'NONE'), 'none');
  for (const bad of ['default', 'foo none', 'foo 12px']) {
    assert.strictEqual(specifiedValue('view-transition-class', bad), null, bad);
  }
  assert.strictEqual(
    specifiedValue('view-transition-name', 'inherit'),
    undefined,
  );
});

test('the scroll-driven animation properties take their grammars, and are kept with their defaults left out', () => {
  const v = specifiedValue;
  assert.strictEqual(
    v('animation-timeline', 'scroll(y root)'),
    'scroll(root y)',
  );
  assert.strictEqual(
    v('animation-timeline', 'scroll(nearest block)'),
    'scroll()',
  );
  assert.strictEqual(
    v('animation-timeline', 'view(1px 2px y)'),
    'view(y 1px 2px)',
  );
  assert.strictEqual(v('animation-timeline', 'view(1px 1px)'), 'view(1px)');
  assert.strictEqual(
    v('animation-timeline', '--a, none, AUTO'),
    '--a, none, auto',
  );
  for (const bad of ['test1', 'auto auto', 'scroll(abc)', 'view(1px y 3px)']) {
    assert.strictEqual(v('animation-timeline', bad), null, bad);
  }
  assert.strictEqual(v('scroll-timeline-name', '--a, none'), '--a, none');
  assert.strictEqual(v('scroll-timeline-name', 'abc'), null);
  assert.strictEqual(
    v('view-timeline-inset', '1px 1px, auto auto'),
    '1px, auto',
  );
  assert.strictEqual(v('view-timeline-inset', '1px 2px 3px'), null);
  assert.strictEqual(v('timeline-scope', 'ALL'), 'all');
  assert.strictEqual(v('timeline-scope', 'none, --a'), null);
  assert.strictEqual(
    v('scroll-timeline', '--a inline, --b block'),
    '--a inline, --b',
  );
  assert.strictEqual(
    v('view-timeline', '--a 1px 2px inline'),
    '--a inline 1px 2px',
  );
  for (const bad of ['block none', '--a --a', '--a 500kg']) {
    assert.strictEqual(v('view-timeline', bad), null, bad);
  }
  // `el.style` keeps a shorthand as its longhands, and reads it back
  const longhands = expandShorthand('view-timeline', '--a inline 1px, --b')!;
  assert.deepStrictEqual(longhands, [
    ['view-timeline-name', '--a, --b'],
    ['view-timeline-axis', 'inline, block'],
    ['view-timeline-inset', '1px, auto'],
  ]);
  const kept = new Map(longhands);
  assert.strictEqual(
    composeShorthand('view-timeline', (n) => kept.get(n) ?? null),
    '--a inline 1px, --b',
  );
  kept.set('view-timeline-axis', 'inline');
  assert.strictEqual(
    composeShorthand('view-timeline', (n) => kept.get(n) ?? null),
    '',
    'lists of other lengths make none',
  );
});

/**
 * A `::before` or an `::after` of every kind of box, and the elements whose
 * margins are read the same way (`e-…`). Every value is what Chrome 156
 * answers for this document in a window 400 wide. No row reads the
 * viewport's height, which the two renders below differ in.
 */
const USED_PAGE =
  '<!doctype html><style>' +
  'body { margin: 0; font: 16px/20px serif }' +
  '.w { width: 200px }' +
  '#pct::after, #sizing::before, #centred::before, #over::before, #sum::before,' +
  ' #turned::before, #wide::before, #wide-end::before, #wide-start::before,' +
  ' #wide-rtl::before, #rel::before, #sticky::before, #upright::before, #rl::before,' +
  ' #lr::before, #rl-auto::before, #zoomed::before { content: ""; display: block }' +
  // a block
  '#fit::before { content: "xxxxxxxxxxxxxxxxxxxxxxxx"; display: block; width: fit-content; max-width: 8px; overflow: hidden; margin-left: 10% }' +
  '#fill::before { content: "x"; display: block }' +
  '#pct { height: 100px }' +
  '#pct::after { width: 50%; height: 25%; padding: 2% 5px; border: 3px solid; margin: 5% 10% 0 }' +
  '#sizing::before { box-sizing: border-box; width: 50%; height: 30px; padding: 0 10px; border: 1px solid }' +
  '#centred::before { width: 100px; margin: 0 auto }' +
  '#over::before { width: 100px; margin-right: 10%; margin-left: 5% }' +
  '#sum::before { width: calc(50% + 3px); margin-left: calc(10% - 1px) }' +
  '#turned::before { width: 100px; height: 40px; transform: translateX(50%) }' +
  '#wide::before { width: 300px; margin: 0 auto }' +
  '#wide-end::before { width: 300px; margin-left: 10%; margin-right: auto }' +
  '#wide-start::before { width: 300px; margin-left: auto; margin-right: 10% }' +
  '#wide-rtl { direction: rtl }' +
  '#wide-rtl::before { width: 300px; margin: 0 auto }' +
  '#float::before { content: ""; float: right; width: 25%; height: 10px; margin-right: 10%; margin-left: auto }' +
  // inline
  '#inline::before { content: "x"; margin-left: 10%; padding-left: 5%; margin-top: 10%; width: 50px; height: 50px }' +
  '#shifted::before { content: "x"; position: relative; top: 10px; left: 5% }' +
  '#ib::before, #ib-span::before { content: ""; display: inline-block; width: 25%; height: 10px; margin-left: 10%; padding-left: 5% }' +
  // flex and grid
  '#flex { display: flex; height: 40px }' +
  '#flex::before { content: ""; width: 50%; margin-left: 10% }' +
  '#flex::after { content: ""; flex: 1; padding-left: 5% }' +
  '#blockified { display: flex }' +
  '#blockified::before { content: "x"; display: inline; width: 50%; height: 10px }' +
  '#column { display: flex; flex-direction: column; height: 100px }' +
  '#column::before { content: ""; flex: 1; margin-top: 10% }' +
  '#grid { display: grid; grid-template-columns: 50px 100px; height: 40px }' +
  '#grid::before { content: ""; margin-left: 10%; padding-left: 10% }' +
  '#grid::after { content: ""; margin-left: 10% }' +
  // a table cell
  '#cell::before { content: ""; display: table-cell; width: 40px; height: 10px; padding: 5%; margin-left: 10% }' +
  '#cell-px::before { content: ""; display: table-cell; width: 40px; height: 10px; margin-left: 5px }' +
  // positioned
  '#abs { position: relative; height: 100px; padding: 10px }' +
  '#abs::before { content: ""; position: absolute; top: 10%; left: 5px; width: 50%; height: 25%; margin-left: 10% }' +
  '#abs-auto { position: relative; height: 100px }' +
  '#abs-auto::before { content: ""; position: absolute; left: 0; right: 0; width: 100px; height: 10px; margin: 0 auto }' +
  '#abs-far::before { content: ""; position: absolute; left: 0; width: 10%; margin-left: 10% }' +
  '#rel::before { position: relative; top: 10px; left: 5% }' +
  '#fixed::before { content: ""; position: fixed; right: 10px; top: 5px; width: 10% }' +
  '#sticky::before { position: sticky; top: 5px; height: 10px }' +
  // vertical
  '#rl, #lr, #rl-auto { width: 100px; height: 200px; writing-mode: vertical-rl }' +
  '#lr { writing-mode: vertical-lr }' +
  '#rl::before { width: 30px; height: 50%; margin-top: 10%; margin-left: 5px; padding-top: 2px; padding-left: 4px; border-right: 1px solid }' +
  '#lr::before { width: 30px; height: 50%; margin-top: 10%; margin-bottom: 5%; margin-left: 5%; margin-right: 2.5% }' +
  '#rl-auto::before { width: 30px; height: 100px; margin: auto 0 }' +
  '#upright::before { writing-mode: vertical-rl; width: 30px; height: 50px; margin-left: 10% }' +
  // zoomed
  '#zoomed { zoom: 2; width: 100px }' +
  '#zoomed::before { width: 50%; height: 10px; margin-left: 10% }' +
  // on an element with no box
  '#contents, #contents-nest, #contents-nest > div { display: contents }' +
  '#contents::before { content: ""; display: block; width: 50%; height: 7px; margin-left: 10% }' +
  '#contents-deep::after { content: ""; display: block; width: 25%; height: 3px }' +
  // the same of elements
  '.e-centred { width: 100px; margin: 0 auto }' +
  '.e-end { width: 100px; margin-left: 10%; margin-right: auto }' +
  '.e-inline { margin-left: 10%; padding-left: 5%; margin-top: 10% }' +
  '.e-shifted { position: relative; top: 10px; left: 5% }' +
  '.e-ib { display: inline-block; width: 25%; height: 10px; margin-left: 10% }' +
  '.e-grid { display: grid; grid-template-columns: 50px 100px }' +
  '.e-grid > div { margin-left: 10%; padding-left: 10% }' +
  '.e-abs { position: relative; padding: 10px; height: 50px }' +
  '.e-abs > div { position: absolute; left: 0; width: 50%; margin-left: 10% }' +
  '.e-held { margin-bottom: 10% }' +
  '.e-held > div { height: 5px; margin-bottom: 30px }' +
  '.e-lr { writing-mode: vertical-lr; height: 200px }' +
  '.e-lr > div { margin-left: 5%; margin-right: 2.5% }' +
  // the `auto` margins of flex items: 40×10 in a 200×40 row, a 200×100 column
  '.f, .fc { display: flex; width: 200px; height: 40px }' +
  '.fc { flex-direction: column; height: 100px }' +
  '.f > div, .fc > div { width: 40px; height: 10px; flex: none }' +
  '#f-after::after { content: ""; width: 40px; height: 10px; margin-left: auto }' +
  '#f-before::before { content: ""; width: 40px; height: 10px; margin: auto }' +
  '.m { margin: auto }' +
  '.ml { margin-left: auto }' +
  '.mr { margin-right: auto }' +
  '.mt { margin-top: auto }' +
  '.mb { margin-bottom: auto }' +
  '.gap { gap: 20px 30px }' +
  '#f-held { margin: auto 15px auto auto }' +
  '#f-pct { margin: 5% auto auto 10% }' +
  '#f-pct-b { margin: auto 10% 5% auto }' +
  '.reverse { flex-direction: row-reverse }' +
  '.up { flex-direction: column-reverse }' +
  '.rtl { direction: rtl }' +
  '.f > #f-wide { width: 300px; margin: auto }' +
  '.f > #f-tall { height: 50px; margin: auto }' +
  '.fc > #f-column-wide { width: 300px; margin: auto }' +
  '#f-grown { flex: 1; max-width: 50px }' +
  '#f-spread { justify-content: space-between }' +
  '.wrap { flex-wrap: wrap; height: 120px }' +
  '.wrap.fc { height: 60px }' +
  '.wrap > div { width: 120px }' +
  '.wrap.fc > div { width: 30px; height: 30px }' +
  '.wrap.pair > div { width: 70px; height: 20px }' +
  '.wrap.small > div { width: 30px; height: 20px }' +
  '.again { flex-wrap: wrap-reverse }' +
  '.packed { align-content: flex-start }' +
  '.centred { align-content: center }' +
  '.spaced { align-content: space-between }' +
  '.wrap > div.full { height: auto }' +
  '.wrap > .full > div { height: 100% }' +
  '.wrap > div.capped { height: auto; max-height: 30px }' +
  '.wrap > div.high { height: 30px }' +
  '.wrap > .shifted { position: relative; left: 300px; top: 50px }' +
  '.wrap > .first { order: -1 }' +
  '#f-least { height: auto; min-height: 60px }' +
  '#f-most { height: auto; max-height: 30px }' +
  '#f-most > div { height: 50px }' +
  '#f-most > .m { height: 10px }' +
  '#f-edges { padding: 5px 10px; border: 3px solid; box-sizing: border-box }' +
  '#f-lines, #f-lines-up { align-items: baseline; align-content: flex-start }' +
  '#f-lines > .text, #f-lines-up > .text { height: auto; width: 60px }' +
  '.low { padding-top: 30px }' +
  '.deep { padding-bottom: 30px }' +
  '#f-nested { flex: 1; height: 30px; margin-left: 20px; display: flex }' +
  '#f-nested > div { width: 40px; height: 10px }' +
  '#f-rl { writing-mode: vertical-rl; width: 100px; height: 200px }' +
  '#f-rl > div { display: flex; height: 100px; width: 40px }' +
  '#f-rl > div > div { width: 10px; height: 20px; flex: none; margin: auto }' +
  '</style>' +
  [
    'fit',
    'fill',
    'pct',
    'sizing',
    'centred',
    'over',
    'sum',
    'turned',
    'wide',
    'wide-end',
    'wide-start',
    'wide-rtl',
    'float',
    'ib',
    'flex',
    'blockified',
    'column',
    'grid',
    'cell',
    'cell-px',
    'abs',
    'abs-auto',
    'abs-far',
    'rel',
    'fixed',
    'sticky',
    'upright',
  ]
    .map((id) => `<div class="w" id="${id}"></div>`)
    .join('') +
  '<div class="w"><span id="inline"></span></div>' +
  '<div class="w"><span id="shifted"></span></div>' +
  '<div class="w"><span id="ib-span"></span></div>' +
  '<div id="rl"></div><div id="lr"></div><div id="rl-auto"></div>' +
  '<div id="zoomed"></div>' +
  '<div class="w"><div id="contents"></div></div>' +
  '<div class="w"><div id="contents-nest"><div id="contents-deep"></div></div></div>' +
  '<div class="w"><div class="e-centred" id="e-centred"></div></div>' +
  '<div class="w"><div class="e-end" id="e-end"></div></div>' +
  '<div class="w"><span><b class="e-inline" id="e-inline">x</b></span></div>' +
  '<div class="w"><span><b class="e-shifted" id="e-shifted">x</b></span></div>' +
  '<div class="w"><span><b class="e-ib" id="e-ib"></b></span></div>' +
  '<div class="w e-grid"><div id="e-grid"></div></div>' +
  '<div class="w e-abs"><div id="e-abs"></div></div>' +
  '<div class="w"><div class="e-held" id="e-held"><div></div></div><div></div></div>' +
  '<div class="w e-lr"><div id="e-lr"></div></div>' +
  '<table style="width: 200px"><tr><td id="e-cell" style="margin-left: 10%"></td></tr></table>' +
  '<div class="f" id="f-after"></div>' +
  '<div class="f" id="f-before"></div>' +
  '<div class="f"><div class="m" id="f-both"></div></div>' +
  '<div class="f"><div class="ml" id="f-share"></div><div class="mr" id="f-share-b"></div></div>' +
  '<div class="f"><div class="mr" id="f-three"></div><div class="m" id="f-three-b"></div></div>' +
  '<div class="f gap"><div class="ml" id="f-gap"></div><div></div><div></div></div>' +
  '<div class="f"><div class="ml mt" id="f-held"></div></div>' +
  '<div class="f"><div id="f-pct"></div></div>' +
  '<div class="f"><div id="f-pct-b"></div></div>' +
  '<div class="f"><div class="ml" id="f-grown"></div><div></div></div>' +
  '<div class="f" id="f-spread"><div class="mr" id="f-spread-a"></div><div></div><div></div></div>' +
  '<div class="f reverse"><div class="ml" id="f-reverse"></div></div>' +
  '<div class="f reverse gap"><div class="ml" id="f-reverse-a"></div><div class="ml" id="f-reverse-b"></div><div></div></div>' +
  '<div class="f rtl"><div class="ml" id="f-rtl"></div></div>' +
  '<div class="f rtl"><div class="m" id="f-rtl-both"></div></div>' +
  '<div class="f"><div id="f-wide"></div></div>' +
  '<div class="f"><div id="f-tall"></div></div>' +
  '<div class="fc"><div class="m" id="f-column"></div></div>' +
  '<div class="fc"><div class="mt" id="f-down"></div></div>' +
  '<div class="fc"><div class="mb" id="f-up"></div></div>' +
  '<div class="fc gap"><div class="mt" id="f-column-gap"></div><div></div></div>' +
  '<div class="fc up"><div class="mb" id="f-column-up"></div><div></div></div>' +
  '<div class="fc rtl"><div class="ml" id="f-column-rtl"></div></div>' +
  '<div class="fc rtl"><div class="mr" id="f-column-rtl-b"></div></div>' +
  '<div class="fc"><div id="f-column-wide"></div></div>' +
  '<div class="f wrap"><div class="ml" id="f-wrap"></div><div></div><div class="m" id="f-wrap-b"></div></div>' +
  '<div class="f wrap gap pair"><div class="ml" id="f-wrap-gap"></div><div></div><div></div><div class="m" id="f-wrap-gap-b"></div></div>' +
  '<div class="f wrap reverse"><div class="ml" id="f-wrap-reverse"></div><div class="m" id="f-wrap-reverse-b"></div></div>' +
  '<div class="f wrap rtl pair"><div class="ml" id="f-wrap-rtl"></div><div></div><div class="mr mt" id="f-wrap-rtl-b"></div></div>' +
  '<div class="f wrap again"><div class="mt" id="f-again"></div><div class="mb" id="f-again-b"></div><div></div></div>' +
  '<div class="f wrap pair packed"><div class="high"></div><div class="mt" id="f-packed"></div><div></div></div>' +
  '<div class="f wrap pair centred"><div class="high"></div><div class="mt" id="f-centred"></div><div></div></div>' +
  '<div class="f wrap pair spaced"><div class="high"></div><div class="m" id="f-spaced"></div><div></div></div>' +
  '<div class="f wrap"><div class="full"></div><div class="mt" id="f-stretched"></div></div>' +
  '<div class="f wrap pair"><div class="full"></div><div class="mt" id="f-stretched-beside"></div><div></div></div>' +
  '<div class="f wrap"><div class="full"><div></div></div><div class="mt" id="f-stretched-holds"></div></div>' +
  '<div class="f wrap"><div class="capped"></div><div class="mt" id="f-capped"></div></div>' +
  '<div class="f wrap"><div class="ml mt shifted" id="f-shifted"></div><div class="first mr" id="f-first"></div></div>' +
  '<div class="fc wrap"><div class="mt"></div><div></div><div class="ml" id="f-column-wrap"></div><div class="m" id="f-column-wrap-b"></div></div>' +
  '<div class="fc wrap up small"><div class="ml" id="f-column-wrap-up"></div><div></div><div></div><div class="mt" id="f-column-wrap-up-b"></div></div>' +
  '<div class="fc wrap rtl small"><div class="mr" id="f-column-wrap-rtl"></div><div></div><div></div><div class="mb" id="f-column-wrap-rtl-b"></div></div>' +
  '<div class="f" id="f-least"><div class="m" id="f-least-a"></div></div>' +
  '<div class="f" id="f-most"><div></div><div class="m" id="f-most-a"></div></div>' +
  '<div class="f" id="f-edges"><div class="m" id="f-edges-a"></div></div>' +
  '<div class="f wrap small" id="f-lines"><div class="text deep">x</div><div class="text low">y</div><div class="mt" id="f-lines-a"></div></div>' +
  '<div class="f wrap small again" id="f-lines-up"><div class="text deep">x</div><div class="text low">y</div><div class="mb" id="f-lines-up-a"></div></div>' +
  '<div class="f"><div id="f-nested"><div class="m" id="f-nested-a"></div></div><div></div></div>' +
  '<div id="f-rl"><div><div id="f-rl-a"></div></div></div>';

/** All four margins of a row, top first, as `getComputedStyle` reads them. */
function margins(sides: string): Record<string, string> {
  const [top, right, bottom, left] = sides.split(' ');
  return {
    'margin-top': top,
    'margin-right': right,
    'margin-bottom': bottom,
    'margin-left': left,
  };
}

const USED_ROWS: [string, 'before' | 'after' | null, Record<string, string>][] =
  [
    ['fit', 'before', { width: '8px', height: '20px', 'margin-left': '20px' }],
    ['fill', 'before', { width: '200px', height: '20px' }],
    [
      'pct',
      'after',
      {
        width: '100px',
        height: '25px',
        'margin-top': '10px',
        'margin-right': '20px',
        'margin-left': '20px',
        'padding-top': '4px',
        'padding-bottom': '4px',
        'padding-left': '5px',
        'border-left-width': '3px',
        'inline-size': '100px',
        'block-size': '25px',
        'margin-inline-start': '20px',
      },
    ],
    ['sizing', 'before', { width: '100px', height: '30px' }],
    [
      'centred',
      'before',
      { height: '0px', 'margin-left': '50px', 'margin-right': '50px' },
    ],
    ['over', 'before', { 'margin-left': '10px', 'margin-right': '20px' }],
    ['sum', 'before', { width: '103px', 'margin-left': '19px' }],
    ['turned', 'before', { transform: 'matrix(1, 0, 0, 1, 50, 0)' }],
    ['wide', 'before', { 'margin-left': '0px', 'margin-right': '-100px' }],
    ['wide-end', 'before', { 'margin-left': '20px', 'margin-right': '-120px' }],
    ['wide-start', 'before', { 'margin-left': '0px', 'margin-right': '20px' }],
    ['wide-rtl', 'before', { 'margin-left': '-100px', 'margin-right': '0px' }],
    [
      'float',
      'before',
      { width: '50px', 'margin-left': '0px', 'margin-right': '20px' },
    ],
    [
      'inline',
      'before',
      {
        width: '50px',
        height: '50px',
        'margin-left': '10%',
        'margin-top': '10%',
        'padding-left': '5%',
      },
    ],
    [
      'shifted',
      'before',
      { top: '10px', right: 'auto', bottom: '-10px', left: '5%' },
    ],
    [
      'ib',
      'before',
      { width: '50px', 'margin-left': '20px', 'padding-left': '10px' },
    ],
    [
      'ib-span',
      'before',
      { width: '50px', 'margin-left': '20px', 'padding-left': '10px' },
    ],
    [
      'flex',
      'before',
      { width: '100px', height: '40px', 'margin-left': '20px' },
    ],
    [
      'flex',
      'after',
      { width: '70px', height: '40px', 'padding-left': '10px' },
    ],
    ['blockified', 'before', { display: 'block', width: '100px' }],
    [
      'column',
      'before',
      { width: '200px', height: '80px', 'margin-top': '20px' },
    ],
    [
      'grid',
      'before',
      {
        width: '40px',
        height: '40px',
        'margin-left': '5px',
        'padding-left': '5px',
      },
    ],
    ['grid', 'after', { width: '90px', 'margin-left': '10px' }],
    [
      'cell',
      'before',
      { 'margin-left': '0px', 'padding-top': '2px', 'padding-left': '2px' },
    ],
    ['cell-px', 'before', { 'margin-left': '5px' }],
    [
      'abs',
      'before',
      {
        width: '110px',
        height: '30px',
        'margin-left': '22px',
        top: '12px',
        right: '83px',
        bottom: '78px',
        left: '5px',
      },
    ],
    [
      'abs-auto',
      'before',
      {
        'margin-left': '50px',
        'margin-right': '50px',
        top: '0px',
        bottom: '90px',
      },
    ],
    [
      'abs-far',
      'before',
      { width: '40px', 'margin-left': '40px', left: '0px', right: '320px' },
    ],
    [
      'rel',
      'before',
      {
        width: '200px',
        top: '10px',
        right: '-10px',
        bottom: '-10px',
        left: '10px',
      },
    ],
    ['fixed', 'before', { width: '40px', right: '10px', left: '350px' }],
    ['sticky', 'before', { width: '200px', top: '5px' }],
    [
      'rl',
      'before',
      {
        width: '30px',
        height: '100px',
        'margin-top': '20px',
        'margin-left': '5px',
        'padding-top': '2px',
        'padding-left': '4px',
        'border-right-width': '1px',
        'inline-size': '100px',
        'block-size': '30px',
      },
    ],
    [
      'lr',
      'before',
      {
        height: '100px',
        'margin-top': '20px',
        'margin-right': '5px',
        'margin-bottom': '10px',
        'margin-left': '10px',
      },
    ],
    ['rl-auto', 'before', { 'margin-top': '50px', 'margin-bottom': '50px' }],
    ['upright', 'before', { 'margin-left': '20px' }],
    ['zoomed', 'before', { width: '50px', 'margin-left': '10px' }],
    ['contents', 'before', { width: '100px', 'margin-left': '20px' }],
    ['contents-deep', 'after', { width: '50px', height: '3px' }],
    ['e-centred', null, { 'margin-left': '50px', 'margin-right': '50px' }],
    ['e-end', null, { 'margin-left': '20px', 'margin-right': '80px' }],
    [
      'e-inline',
      null,
      { 'margin-left': '10%', 'margin-top': '10%', 'padding-left': '5%' },
    ],
    [
      'e-shifted',
      null,
      { top: '10px', right: 'auto', bottom: '-10px', left: '5%' },
    ],
    ['e-ib', null, { 'margin-left': '20px' }],
    ['e-grid', null, { 'margin-left': '5px', 'padding-left': '5px' }],
    ['e-abs', null, { 'margin-left': '22px' }],
    ['e-held', null, { 'margin-bottom': '20px' }],
    ['e-lr', null, { 'margin-left': '10px', 'margin-right': '5px' }],
    ['e-cell', null, { 'margin-left': '0px' }],
    ['f-after', 'after', margins('0px 0px 0px 160px')],
    ['f-before', 'before', margins('15px 80px 15px 80px')],
    ['f-both', null, margins('15px 80px 15px 80px')],
    ['f-share', null, margins('0px 0px 0px 60px')],
    ['f-share-b', null, margins('0px 60px 0px 0px')],
    ['f-three', null, margins('0px 40px 0px 0px')],
    ['f-three-b', null, margins('15px 40px 15px 40px')],
    ['f-gap', null, margins('0px 0px 0px 20px')],
    ['f-held', null, margins('15px 15px 15px 145px')],
    ['f-pct', null, margins('10px 140px 20px 20px')],
    ['f-pct-b', null, margins('20px 20px 10px 140px')],
    ['f-grown', null, margins('0px 0px 0px 110px')],
    ['f-spread-a', null, margins('0px 80px 0px 0px')],
    ['f-reverse', null, margins('0px 0px 0px 160px')],
    ['f-reverse-a', null, margins('0px 0px 0px 10px')],
    ['f-reverse-b', null, margins('0px 0px 0px 10px')],
    ['f-rtl', null, margins('0px 0px 0px 160px')],
    ['f-rtl-both', null, margins('15px 80px 15px 80px')],
    ['f-wide', null, margins('15px 0px 15px 0px')],
    ['f-tall', null, margins('0px 80px 0px 80px')],
    ['f-column', null, margins('45px 80px 45px 80px')],
    ['f-down', null, margins('90px 0px 0px 0px')],
    ['f-up', null, margins('0px 0px 90px 0px')],
    ['f-column-gap', null, margins('60px 0px 0px 0px')],
    ['f-column-up', null, margins('0px 0px 80px 0px')],
    ['f-column-rtl', null, margins('0px 0px 0px 160px')],
    ['f-column-rtl-b', null, margins('0px 160px 0px 0px')],
    ['f-column-wide', null, margins('45px 0px 45px 0px')],
    ['f-wrap', null, margins('0px 0px 0px 80px')],
    ['f-wrap-b', null, margins('15px 40px 15px 40px')],
    ['f-wrap-gap', null, margins('0px 0px 0px 30px')],
    ['f-wrap-gap-b', null, margins('15px 15px 15px 15px')],
    ['f-wrap-reverse', null, margins('0px 0px 0px 80px')],
    ['f-wrap-reverse-b', null, margins('25px 40px 25px 40px')],
    ['f-wrap-rtl', null, margins('0px 0px 0px 60px')],
    ['f-wrap-rtl-b', null, margins('40px 130px 0px 0px')],
    ['f-again', null, margins('30px 0px 0px 0px')],
    ['f-again-b', null, margins('0px 0px 30px 0px')],
    ['f-packed', null, margins('10px 0px 0px 0px')],
    ['f-centred', null, margins('10px 0px 0px 0px')],
    ['f-spaced', null, margins('5px 30px 5px 30px')],
    ['f-stretched', null, margins('55px 0px 0px 0px')],
    ['f-stretched-beside', null, margins('40px 0px 0px 0px')],
    ['f-stretched-holds', null, margins('55px 0px 0px 0px')],
    ['f-capped', null, margins('55px 0px 0px 0px')],
    ['f-shifted', null, margins('50px 0px 0px 80px')],
    ['f-first', null, margins('0px 80px 0px 0px')],
    ['f-column-wrap', null, margins('0px 0px 0px 70px')],
    ['f-column-wrap-b', null, margins('0px 35px 0px 35px')],
    ['f-column-wrap-up', null, margins('0px 0px 0px 70px')],
    ['f-column-wrap-up-b', null, margins('40px 0px 0px 0px')],
    ['f-column-wrap-rtl', null, margins('0px 70px 0px 0px')],
    ['f-column-wrap-rtl-b', null, margins('0px 0px 40px 0px')],
    ['f-least-a', null, margins('25px 80px 25px 80px')],
    ['f-most-a', null, margins('10px 60px 10px 60px')],
    ['f-edges-a', null, margins('7px 67px 7px 67px')],
    ['f-lines-a', null, margins('60px 0px 0px 0px')],
    ['f-lines-up-a', null, margins('0px 0px 60px 0px')],
    ['f-nested-a', null, margins('10px 50px 10px 50px')],
    ['f-rl-a', null, margins('40px 15px 40px 15px')],
  ];

for (const [scale, rendered] of [
  ['1x', render],
  ['2x', render2x],
] as const) {
  metric(
    `getComputedStyle reads the box of a ::before as Chrome does, at ${scale}`,
    async () => {
      const { node } = await rendered(USED_PAGE, 400);
      const el = view(node);
      for (const [id, pseudo, want] of USED_ROWS) {
        const style = el.computedStyle(findById(el.document, id)!, pseudo)!;
        const read = Object.fromEntries(
          Object.keys(want).map((name) => [name, style[name]]),
        );
        assert.deepStrictEqual(read, want, `${id} ${pseudo ?? ''}`);
      }
    },
  );
}

test('the margins of the root box read as laid out', async () => {
  // Chrome 156, in a window 400 wide
  const { node } = await render(
    '<!doctype html><html id="r"><style>html { width: 200px; margin: 0 auto 5% }' +
      ' body { margin: 0 0 30px }</style>' +
      '<body><div style="height: 10px"></div></body></html>',
  );
  const el = view(node);
  const style = el.computedStyle(findById(el.document, 'r')!)!;
  assert.deepStrictEqual(
    [style['margin-left'], style['margin-right'], style['margin-bottom']],
    ['100px', '100px', '20px'],
  );
});

test('a ::before with no box reads as its rules compute it', async () => {
  const { node } = await render(
    '<!doctype html><style>' +
      '#none::before { content: "x"; display: none; width: 50%; height: 10%; margin-left: 10%;' +
      ' padding-left: 5%; top: 10%; position: relative }' +
      '#empty::before { width: 50%; height: 10%; margin-left: 10%; padding-left: 5% }' +
      '#gone::before { content: none; width: 50%; margin-left: 10% }' +
      '#normal::after { content: normal; width: 50%; margin-left: 10% }' +
      '#unseen { display: none }' +
      '#unseen::before { content: "x"; display: block; width: 50%; margin-left: 10% }' +
      '#held::before { content: "x"; display: block; width: 50%; margin-left: 10% }' +
      // what it holds is set in a box, and that box is none of its own
      '#contents::before { content: "x"; display: contents; width: 50%; height: 10%;' +
      ' margin-left: 10%; padding-left: 5%; top: 10%; position: relative }' +
      '#through { display: contents }' +
      '#through::before { content: "x"; display: contents; width: 50%; margin-left: 10% }' +
      '</style><div id="none"></div><div id="empty"></div><div id="gone"></div>' +
      '<div id="normal"></div><div id="unseen"></div>' +
      '<div id="contents"></div><div><div id="through"></div></div>' +
      '<div style="display: none"><div id="held"></div></div>',
  );
  const el = view(node);
  // Chrome 156: width, height, margin-left, padding-left, top
  const rows = [
    ['none', 'before', '50% 10% 10% 5% 10%'],
    ['empty', 'before', '50% 10% 10% 5% auto'],
    ['gone', 'before', '50% auto 10% 0px auto'],
    ['normal', 'after', '50% auto 10% 0px auto'],
    ['unseen', 'before', '50% auto 10% 0px auto'],
    ['held', 'before', '50% auto 10% 0px auto'],
    ['contents', 'before', '50% 10% 10% 5% 10%'],
    ['through', 'before', '50% auto 10% 0px auto'],
  ] as const;
  for (const [id, pseudo, want] of rows) {
    const style = el.computedStyle(findById(el.document, id)!, pseudo)!;
    const read = ['width', 'height', 'margin-left', 'padding-left', 'top'];
    assert.strictEqual(
      read.map((name) => style[name]).join(' '),
      want,
      `${id} ${pseudo}`,
    );
  }
});

test('the first frame of a ::before takes its computed width, where its style reads its box', async () => {
  const { node } = await render(
    '<!doctype html><style>@keyframes k { to { width: 100px } }' +
      '#a { width: 200px }' +
      '#a::before { content: ""; display: block; width: 50%; animation: k 100s paused }' +
      '</style><div id="a"></div>',
  );
  const el = view(node);
  const a = findById(el.document, 'a')!;
  // Chrome 156's `getKeyframes()` and `getComputedStyle()` of it
  const frames = el.cssKeyframesOf(a, 'before', 'k')!;
  assert.strictEqual(frames[0].values.width, '50%');
  assert.strictEqual(el.computedStyle(a, 'before')!.width, '100px');
});

test('what a computed style reads from a box says so, by name and in camel case', async () => {
  const { node } = await render(
    '<div id="a" style="position: absolute; top: 1px; left: 1px; ' +
      'border: 1px solid; transform: translateX(10%)"></div>' +
      '<div id="b" style="position: relative; top: 1px; border: 1px solid; ' +
      'transform: translateX(10%); writing-mode: vertical-rl; direction: rtl"></div>',
  );
  const el = view(node);
  const box = (at: number): Parameters<typeof cssomStyle>[2] => ({
    width: 100 + at,
    height: 200 + at,
    margin: [1 + at, 2 + at, 3 + at, 4 + at],
    border: [5 + at, 6 + at, 7 + at, 8 + at],
    padding: [9 + at, 10 + at, 11 + at, 12 + at],
    insets: [13 + at, 14 + at, 15 + at, 16 + at],
  });
  for (const id of ['a', 'b']) {
    const { style } = boxOf(el, id) as unknown as { style: ComputedStyle };
    const one = cssomStyle(style, 1, box(0));
    const other = cssomStyle(style, 1, box(30));
    const moved = Object.keys(one).filter((name) => one[name] !== other[name]);
    for (const name of Object.keys(one)) {
      assert.strictEqual(comesFromBox(name), moved.includes(name), name);
    }
  }
  assert.ok(comesFromBox('marginInlineEnd'));
  assert.ok(comesFromBox('insetBlockStart'));
  assert.ok(!comesFromBox('--width'));
  assert.ok(!comesFromBox('display'));
});

/** Every kind of box, for what a `min-width: auto` reads on it. */
const MIN_SIZE_PAGE =
  '<style>' +
  '.b::before, .a::after { content: "x" }' +
  '.o::before { content: "x"; position: absolute }' +
  '.h::before { content: "x"; display: none }' +
  '.k::before { content: "x"; min-width: min-content; min-height: stretch }' +
  '</style>' +
  '<div id="block"></div><span id="inline"></span>' +
  '<div id="inline-block" style="display: inline-block"></div>' +
  '<div id="float" style="float: left"></div>' +
  '<div id="absolute" style="position: absolute"></div>' +
  '<table><tr><td id="cell"></td></tr></table>' +
  '<div id="none" style="display: none"></div>' +
  '<div style="display: none"><span id="in-none"></span>' +
  '<div style="display: flex"><div id="item-in-none"></div></div></div>' +
  '<div id="contents" style="display: contents"></div>' +
  '<div id="flex" style="display: flex">' +
  '<div id="item"><div id="in-item"></div></div>' +
  '<span id="span-item"></span>' +
  '<div id="relative-item" style="position: relative"></div>' +
  '<div id="sticky-item" style="position: sticky"></div>' +
  '<div id="float-item" style="float: left"></div>' +
  '<div id="absolute-child" style="position: absolute"></div>' +
  '<div id="fixed-child" style="position: fixed"></div>' +
  '<div id="none-child" style="display: none"></div>' +
  '<div id="contents-child" style="display: contents">' +
  '<div id="through-contents"></div></div>' +
  '<div id="set" style="min-width: 5px; min-height: 10%"></div>' +
  // a browser takes no property's name here, so the declaration goes and
  // the item keeps its `auto`; here it finds the parent's computed `auto`
  '<div id="inherit" style="min-width: inherit(min-width)"></div>' +
  '</div>' +
  '<div style="display: inline-flex"><div id="inline-flex-item"></div></div>' +
  '<div id="grid" style="display: grid">' +
  '<div id="grid-item"></div><span id="span-grid-item"></span>' +
  '<div id="absolute-grid-child" style="position: absolute"></div>' +
  '<div id="none-grid-child" style="display: none"></div>' +
  '<div id="contents-grid-child" style="display: contents">' +
  '<div id="through-grid-contents"></div></div>' +
  '</div>' +
  '<div style="display: inline-grid"><div id="inline-grid-item"></div></div>' +
  '<div style="display: -webkit-box"><div id="webkit-box-child"></div></div>' +
  '<details open style="display: flex"><summary id="summary">s</summary>' +
  '<div id="details-content"></div></details>' +
  '<button style="display: flex"><div id="in-button"></div></button>' +
  '<div><template shadowrootmode="open"><div style="display: flex">' +
  '<slot></slot></div></template><b id="slotted"></b></div>' +
  '<div id="vertical" style="writing-mode: vertical-rl; min-height: 5px">' +
  '</div>' +
  '<div id="flex-before" class="b" style="display: flex"></div>' +
  '<div id="flex-after" class="a" style="display: flex"></div>' +
  '<div id="grid-before" class="b" style="display: grid"></div>' +
  '<div id="block-before" class="b"></div>' +
  '<div id="flex-absolute" class="o" style="display: flex"></div>' +
  '<div id="flex-hidden" class="h" style="display: flex"></div>' +
  '<div id="flex-no-content" style="display: flex"></div>' +
  '<div id="block-keyword" class="k"></div>';

/** Chrome's `getComputedStyle` on `MIN_SIZE_PAGE`: `min-width`, `min-height`,
 *  `min-inline-size` and `min-block-size`. */
const MIN_SIZE_READS: Record<string, string> = {
  block: '0px 0px 0px 0px',
  inline: '0px 0px 0px 0px',
  'inline-block': '0px 0px 0px 0px',
  float: '0px 0px 0px 0px',
  absolute: '0px 0px 0px 0px',
  cell: '0px 0px 0px 0px',
  none: '0px 0px 0px 0px',
  'in-none': '0px 0px 0px 0px',
  'item-in-none': '0px 0px 0px 0px',
  contents: '0px 0px 0px 0px',
  flex: '0px 0px 0px 0px',
  item: 'auto auto auto auto',
  'in-item': '0px 0px 0px 0px',
  'span-item': 'auto auto auto auto',
  'relative-item': 'auto auto auto auto',
  'sticky-item': 'auto auto auto auto',
  'float-item': 'auto auto auto auto',
  'absolute-child': '0px 0px 0px 0px',
  'fixed-child': '0px 0px 0px 0px',
  'none-child': '0px 0px 0px 0px',
  'contents-child': '0px 0px 0px 0px',
  'through-contents': 'auto auto auto auto',
  set: '5px 10% 5px 10%',
  inherit: 'auto auto auto auto',
  'inline-flex-item': 'auto auto auto auto',
  grid: '0px 0px 0px 0px',
  'grid-item': 'auto auto auto auto',
  'span-grid-item': 'auto auto auto auto',
  'absolute-grid-child': '0px 0px 0px 0px',
  'none-grid-child': '0px 0px 0px 0px',
  'contents-grid-child': '0px 0px 0px 0px',
  'through-grid-contents': 'auto auto auto auto',
  'inline-grid-item': 'auto auto auto auto',
  'webkit-box-child': '0px 0px 0px 0px',
  summary: 'auto auto auto auto',
  'details-content': '0px 0px 0px 0px',
  'in-button': 'auto auto auto auto',
  slotted: 'auto auto auto auto',
  vertical: '0px 5px 5px 0px',
  'flex-before': '0px 0px 0px 0px',
  'flex-before::before': 'auto auto auto auto',
  'flex-after': '0px 0px 0px 0px',
  'flex-after::after': 'auto auto auto auto',
  'grid-before': '0px 0px 0px 0px',
  'grid-before::before': 'auto auto auto auto',
  'block-before': '0px 0px 0px 0px',
  'block-before::before': '0px 0px 0px 0px',
  'flex-absolute': '0px 0px 0px 0px',
  'flex-absolute::before': '0px 0px 0px 0px',
  'flex-hidden': '0px 0px 0px 0px',
  'flex-hidden::before': '0px 0px 0px 0px',
  'flex-no-content': '0px 0px 0px 0px',
  'flex-no-content::before': '0px 0px 0px 0px',
  'block-keyword': '0px 0px 0px 0px',
  'block-keyword::before': 'min-content stretch min-content stretch',
};

test('a min-width or a min-height of auto reads as zero, but on a flex or a grid item with a box', async () => {
  const { node } = await render(MIN_SIZE_PAGE);
  const el = view(node);
  const read: Record<string, string> = {};
  for (const at of Object.keys(MIN_SIZE_READS)) {
    const [id, pseudo = null] = at.split('::');
    const cs = el.computedStyle(findById(el.document, id)!, pseudo)!;
    read[at] = [
      cs['min-width'],
      cs['min-height'],
      cs['min-inline-size'],
      cs['min-block-size'],
    ].join(' ');
  }
  assert.deepStrictEqual(read, MIN_SIZE_READS);
});

/** What each size keyword reads as, Chrome's `getComputedStyle` on every
 *  box of `keywordPage`: its prefixes go, and `-webkit-fill-available` is
 *  `stretch`. */
const SIZE_KEYWORDS: Record<string, string> = {
  'min-content': 'min-content',
  'max-content': 'max-content',
  'fit-content': 'fit-content',
  stretch: 'stretch',
  '-webkit-fill-available': 'stretch',
  '-webkit-min-content': 'min-content',
  '-webkit-max-content': 'max-content',
  '-webkit-fit-content': 'fit-content',
  'MAX-CONTENT': 'max-content',
};

/** The limits, which read as they compute on any box. */
const SIZE_LIMITS = [
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'min-inline-size',
  'min-block-size',
  'max-inline-size',
  'max-block-size',
];

/** The sizes, which read as they compute where no box takes them; on one
 *  that does, they read as the length it came to. */
const SIZES = ['width', 'height', 'inline-size', 'block-size'];

/** A box of each kind for each keyword on each property it reads as written,
 *  and the property and the keyword each `id` is for. */
function keywordPage(): {
  page: string;
  rows: Record<string, [property: string, keyword: string]>;
} {
  const flat = [...SIZE_LIMITS, ...SIZES];
  const kinds: [(style: string) => string, string[]][] = [
    [(style) => `<div style="${style}" ID></div>`, SIZE_LIMITS],
    [(style) => `<span style="${style}" ID></span>`, flat],
    [(style) => `<div style="display: none; ${style}" ID></div>`, flat],
    [(style) => `<div style="display: contents; ${style}" ID></div>`, flat],
    [
      (style) =>
        `<div style="display: flex"><div style="${style}" ID></div></div>`,
      SIZE_LIMITS,
    ],
    [
      (style) =>
        `<div style="display: grid"><div style="${style}" ID></div></div>`,
      SIZE_LIMITS,
    ],
  ];
  const rows: Record<string, [string, string]> = {};
  let page = '';
  for (const [box, properties] of kinds) {
    for (const property of properties) {
      for (const keyword of Object.keys(SIZE_KEYWORDS)) {
        const id = `k${Object.keys(rows).length}`;
        rows[id] = [property, keyword];
        page += box(`${property}: ${keyword}`).replace('ID', `id="${id}"`);
      }
    }
  }
  return { page, rows };
}

test('a size that is a keyword reads as the keyword, whatever length stands beside it', async () => {
  const { page, rows } = keywordPage();
  const { node } = await render(page);
  const el = view(node);
  const wrong: string[] = [];
  for (const [id, [property, keyword]] of Object.entries(rows)) {
    const cs = el.computedStyle(findById(el.document, id)!)!;
    if (cs[property] !== SIZE_KEYWORDS[keyword]) {
      wrong.push(`${id} ${property}: ${keyword} reads ${cs[property]}`);
    }
  }
  assert.deepStrictEqual(wrong, []);
});

test('what takes a computed value keeps a min-width of auto on any box, as getKeyframes() and commitStyles() read it', async () => {
  // Chrome's `getKeyframes()` on these, whose first frame is the style
  // under the animation, and its `commitStyles()` of the same two values
  const { node } = await render(
    '<style>@keyframes k { to { min-width: 10px; max-width: 10px } }' +
      '.k, .b::before { animation: k 100s paused }' +
      '.b::before { content: "x" }' +
      '.m, .b.m::before { min-width: min-content }</style>' +
      '<div id="block" class="k"></div><span id="inline" class="k"></span>' +
      '<div style="display: flex"><div id="item" class="k"></div></div>' +
      '<div id="flex" class="b" style="display: flex"></div>' +
      '<div id="block-before" class="b"></div>' +
      '<div id="keyword" class="k m"></div>' +
      '<div id="keyword-before" class="b m"></div>',
  );
  const el = view(node);
  const under = (id: string, pseudo: string) =>
    el.cssKeyframesOf(findById(el.document, id)!, pseudo, 'k')![0].values[
      'min-width'
    ];
  assert.strictEqual(under('block', ''), 'auto');
  assert.strictEqual(under('inline', ''), 'auto');
  assert.strictEqual(under('item', ''), 'auto');
  assert.strictEqual(under('flex', 'before'), 'auto');
  assert.strictEqual(under('block-before', 'before'), 'auto');
  assert.strictEqual(under('keyword', ''), 'min-content');
  assert.strictEqual(under('keyword-before', 'before'), 'min-content');
  for (const id of ['block', 'inline', 'item']) {
    assert.strictEqual(
      el.scriptAnimationValues(findById(el.document, id)!, 0, ['min-width']),
      'min-width\u0000auto',
      id,
    );
  }
  assert.strictEqual(
    el.scriptAnimationValues(findById(el.document, 'keyword')!, 0, [
      'min-width',
    ]),
    'min-width\u0000min-content',
  );
});

test('the scroll-timeline and view-timeline shorthands set their longhands, and getComputedStyle reads them back', async () => {
  const { node } = await render(
    '<div id="a" style="scroll-timeline: --s inline"></div>' +
      '<div id="b" style="view-timeline: --v x 1px 2px, --w"></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
  const a = cssomStyle(style('a'), 1, null);
  assert.strictEqual(a['scroll-timeline-name'], '--s');
  assert.strictEqual(a['scroll-timeline-axis'], 'inline');
  assert.strictEqual(a['scroll-timeline'], '--s inline');
  const b = cssomStyle(style('b'), 1, null);
  assert.strictEqual(b['view-timeline'], '--v x 1px 2px, --w');
  assert.strictEqual(b['view-timeline-inset'], '1px 2px, auto');
});

test('the anchor positioning properties take their grammars, and anchor() and anchor-size() their canonical order where each may be', () => {
  const v = specifiedValue;
  assert.strictEqual(v('left', 'anchor(inside --foo)'), 'anchor(--foo inside)');
  // and a math function around them simplified, as CSS Values 4, 10.10
  // and 10.12 have it: its children sorted, the number first and what no
  // calculation sees into last (WPT anchor-parse-valid)
  for (const [given, canonical] of [
    ['calc(anchor(top --a, 0) + 10px)', 'calc(10px + anchor(--a top, 0px))'],
    [
      'calc((anchor(--foo top) + anchor(--bar bottom)) / 2)',
      'calc(0.5 * (anchor(--foo top) + anchor(--bar bottom)))',
    ],
    [
      'calc(0.5 * (anchor(--foo top) + anchor(--bar bottom)))',
      'calc(0.5 * (anchor(--foo top) + anchor(--bar bottom)))',
    ],
    [
      'anchor(--foo top, calc(0.5 * anchor(--bar bottom)))',
      'anchor(--foo top, calc(0.5 * anchor(--bar bottom)))',
    ],
    [
      'min(100px, 10%, anchor(--foo top), anchor(--bar bottom))',
      'min(100px, 10%, anchor(--foo top), anchor(--bar bottom))',
    ],
    [
      'calc(anchor(--foo left, 1px) + 10%)',
      'calc(10% + anchor(--foo left, 1px))',
    ],
    ['calc(anchor(--foo left, 0))', 'anchor(--foo left, 0px)'],
    ['anchor(--foo min(50%, 100%))', 'anchor(--foo calc(50%))'],
    ['calc(anchor(top) - 1in + 4px)', 'calc(-92px + anchor(top))'],
    [
      'calc(anchor(top) - (anchor(bottom) * 2))',
      'calc(anchor(top) - (2 * anchor(bottom)))',
    ],
  ]) {
    assert.strictEqual(v('top', given), canonical, given);
  }
  assert.strictEqual(
    v('width', 'anchor-size(width --foo)'),
    'anchor-size(--foo width)',
  );
  assert.strictEqual(v('width', 'anchor-size(10px)'), 'anchor-size(10px)');
  assert.strictEqual(
    v('margin-left', 'anchor-size(--a height)'),
    'anchor-size(--a height)',
  );
  for (const [prop, bad] of [
    ['margin-top', 'anchor(--foo top)'],
    ['font-size', 'anchor-size(--foo width)'],
    ['top', 'anchor(--foo, top)'],
    ['top', 'anchor(--foo top bottom)'],
    ['top', 'anchor(foo top)'],
    ['width', 'anchor-size(, 10px)'],
  ]) {
    assert.strictEqual(v(prop, bad), null, `${prop}: ${bad}`);
  }
  assert.strictEqual(v('position-area', 'top left'), 'left top');
  assert.strictEqual(
    v('position-area', 'inline-start block-end'),
    'block-end inline-start',
  );
  assert.strictEqual(v('position-area', 'top span-all'), 'top');
  assert.strictEqual(v('position-area', 'center top'), 'center top');
  assert.strictEqual(v('position-area', 'start start'), 'start');
  for (const bad of [
    'none none',
    'top top',
    'left inline-start',
    'top left top',
  ]) {
    assert.strictEqual(v('position-area', bad), null, bad);
  }
  assert.strictEqual(
    v('position-try-fallbacks', 'flip-inline --foo'),
    '--foo flip-inline',
  );
  assert.strictEqual(
    v('position-try-fallbacks', 'top left, --a'),
    'left top, --a',
  );
  for (const bad of [
    'none, flip-start',
    'flip-inline --bar flip-block',
    'flip-y flip-y',
    '--foo left',
  ]) {
    assert.strictEqual(v('position-try-fallbacks', bad), null, bad);
  }
  assert.strictEqual(v('position-try', 'normal --foo'), '--foo');
  assert.strictEqual(
    v('position-try', 'most-width flip-x'),
    'most-width flip-x',
  );
  assert.strictEqual(v('position-try', 'flip-block most-height'), null);
  assert.strictEqual(v('anchor-scope', '--a, --b'), '--a, --b');
  assert.strictEqual(v('anchor-scope', 'none --a'), null);
  assert.strictEqual(v('position-anchor', 'NORMAL'), 'normal');
  assert.strictEqual(v('position-anchor', '--a, --b'), null);
  assert.strictEqual(v('anchor-name', 'foo'), null);
  // and `el.style` keeps `position-try` as its two longhands
  const kept = new Map(
    expandShorthand('position-try', 'most-width --a, flip-x')!,
  );
  assert.strictEqual(kept.get('position-try-order'), 'most-width');
  assert.strictEqual(
    composeShorthand('position-try', (n) => kept.get(n) ?? null),
    'most-width --a, flip-x',
  );
});

test('getComputedStyle reads the anchor positioning properties, a logical position-area said with start and end', async () => {
  const { node } = await render(
    '<div id="a" style="position-area: inline-start block-end; anchor-scope: all;' +
      ' position-try: most-height flip-y --t, top left; position-anchor: auto;' +
      ' anchor-name: --x, --y"></div>' +
      '<div id="b" style="position-area: start span-all"></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
  const a = cssomStyle(style('a'), 1, null);
  assert.strictEqual(a['position-area'], 'end start');
  assert.strictEqual(a['anchor-scope'], 'all');
  assert.strictEqual(a['position-try-order'], 'most-height');
  assert.strictEqual(a['position-try-fallbacks'], '--t flip-y, left top');
  assert.strictEqual(a['position-try'], 'most-height --t flip-y, left top');
  assert.strictEqual(a['position-anchor'], 'auto');
  assert.strictEqual(a['anchor-name'], '--x, --y');
  assert.strictEqual(
    cssomStyle(style('b'), 1, null)['position-area'],
    'block-start',
  );
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

test('a rem is the size of the <html> a document does not write, whatever is at its top', async () => {
  // A fragment's elements and a <body> written alone each have the document
  // for their parent, and each was taken for the root, so a rem came to the
  // size of the one styled before it. Chrome, Firefox and Safari have the
  // <html>'s size in all of these, 16px there and the palette's here
  const size = async (source: string): Promise<string | undefined> => {
    const { el } = await renderScrolled(source, 300);
    const found = el.computedStyle(findById(el.document, 't')!)?.['font-size'];
    await cleanup();
    return found;
  };
  const initial = await size('<p id="t">text</p>');
  assert.strictEqual(
    await size(
      '<div style="font-size:30px"><p id="t" style="font-size:1rem">b</p></div>',
    ),
    initial,
    'inside a large block',
  );
  assert.strictEqual(
    await size(
      '<body style="font-size:30px"><p id="t" style="font-size:1rem">b</p></body>',
    ),
    initial,
    'under a body with a size of its own',
  );
  assert.strictEqual(
    await size(
      '<style>html{font-size:20px}</style><div style="font-size:30px">' +
        '<p id="t" style="font-size:1rem">b</p></div>',
    ),
    '20px',
    'of a rule on the <html> the document does not write',
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

test('two custom property sets are the same where every link of them is, however often asked', async () => {
  const { sameValue } = await import('../../src/html/css/style.js');
  const { CustomProps } = await import('../../src/html/css/vars.js');
  const chain = (values: Record<string, string | null>[]) => {
    let at: InstanceType<typeof CustomProps> | null = null;
    for (const own of values) {
      const next: InstanceType<typeof CustomProps> = new CustomProps(at);
      for (const [k, v] of Object.entries(own)) next.own.set(k, v);
      at = next;
    }
    return at!;
  };
  const a = chain([{ '--x': '1' }, { '--y': 'red', '--z': null }]);
  const b = chain([{ '--x': '1' }, { '--z': null, '--y': 'red' }]);
  const shared = chain([{ '--x': '1' }]);
  const c = new CustomProps(shared);
  c.own.set('--y', 'red');
  c.own.set('--z', null);
  const d = chain([{ '--x': '2' }, { '--y': 'red', '--z': null }]);
  const e = chain([{ '--y': 'red', '--z': null }]);
  for (let round = 0; round < 2; round += 1) {
    assert.strictEqual(sameValue(a, b), true, 'the same links, apart');
    assert.strictEqual(sameValue(a, c), true, 'a link shared');
    assert.strictEqual(sameValue(a, d), false, 'a parent otherwise');
    assert.strictEqual(sameValue(a, e), false, 'a link short');
    assert.strictEqual(sameValue(d, e), false);
    assert.strictEqual(sameValue({ custom: a }, { custom: b }), true);
  }
});

test('calc-size() reads as Chromium reads it, and is taken where it takes it', async () => {
  const { node } = await render(CALC_SIZE_DOCUMENT, 800);
  const el = view(node);
  const wrong: string[] = [];
  CALC_SIZE_READS.forEach(([size, value, kept, computed], i) => {
    const read = el.computedStyle(findById(el.document, `r${i}`)!)!;
    if (read[size] !== computed) {
      wrong.push(`${size}: ${value} reads ${read[size]}, not ${computed}`);
    }
    // a declaration the size does not take leaves `el.style` as it was
    const specified = specifiedValue(size, value);
    if (specified !== (kept === '' ? null : kept)) {
      wrong.push(`${size}: ${value} is kept as ${specified}, not ${kept}`);
    }
  });
  assert.deepStrictEqual(wrong, []);
});

test('calc-size() sizes every kind of box as Chromium does', async () => {
  const { node } = await render(CALC_SIZE_DOCUMENT, 800);
  const el = view(node);
  const size = (id: string): string => {
    const element = findById(el.document, id);
    const rect = element && el.elementRect(element);
    return rect ? `${rect.width}×${rect.height}` : 'none';
  };
  const wrong: string[] = [];
  CALC_SIZE_BOXES.forEach(([kind, style, box, around], i) => {
    const want = (of: readonly [number, number]) => `${of[0]}×${of[1]}`;
    if (size(`b${i}`) !== want(box)) {
      wrong.push(`${kind} ${style}: ${size(`b${i}`)}, not ${want(box)}`);
    }
    if (around && size(`o${i}`) !== want(around)) {
      wrong.push(
        `${kind} ${style}: around it ${size(`o${i}`)}, not ${want(around)}`,
      );
    }
  });
  assert.deepStrictEqual(wrong, []);
});

/** What of `expected` a computed style reads otherwise, one line a read. */
function readsApart(
  label: string,
  read: Record<string, string>,
  expected: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(expected)
    .filter(([name, value]) => read[name] !== value)
    .map(([name, value]) => `${label}: ${name} ${read[name]}, not ${value}`);
}

test('the flex, alignment and other longhands read as Chromium reads them, a value a shorthand cannot read being refused whole', async () => {
  const { node } = await render(COMPUTED_READS_DOCUMENT, 800);
  const el = view(node);
  const wrong = COMPUTED_READS.flatMap(([style, expected], i) =>
    readsApart(
      style,
      el.computedStyle(findById(el.document, `r${i}`)!)!,
      expected,
    ),
  );
  assert.deepStrictEqual(wrong, []);
});

metric(
  'the same lengths read at 2x, which no read of a device pixel does',
  async () => {
    const { node } = await render2x(COMPUTED_READS_DOCUMENT, 800);
    const el = view(node);
    const wrong = COMPUTED_READS.flatMap(([style, expected], i) =>
      readsApart(
        style,
        el.computedStyle(findById(el.document, `r${i}`)!)!,
        expected,
      ),
    );
    assert.deepStrictEqual(wrong, []);
  },
);

test('what settling a box writes over reads as it was written, on a -webkit-box and on a box a position option flipped, and in what inherits or has no box', async () => {
  const { node } = await render(COMPUTED_PLACED_DOCUMENT, 800);
  const el = view(node);
  const wrong = COMPUTED_PLACED.flatMap(([id, pseudo, expected]) =>
    readsApart(
      `${id}${pseudo}`,
      el.computedStyle(
        findById(el.document, id)!,
        pseudo ? pseudo.slice(2) : null,
      )!,
      expected,
    ),
  );
  assert.deepStrictEqual(wrong, []);
});

test('a computed style is a fast object, which a page may read tens of thousands of times a load', async () => {
  // past what `cssomAt` says of its literal, V8 makes it a dictionary, three
  // times as long to make and to send, and nothing else says so
  setFlagsFromString('--allow-natives-syntax');
  const fast = new Function('o', 'return %HasFastProperties(o)') as (
    o: unknown,
  ) => boolean;
  setFlagsFromString('--no-allow-natives-syntax');
  const { node } = await render('<p id="a">a</p>');
  const el = view(node);
  const read = el.computedStyle(findById(el.document, 'a')!);
  assert.ok(fast(read), `${Object.keys(read!).length} properties`);
});
