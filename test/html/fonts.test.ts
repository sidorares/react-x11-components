// <Html> — fonts: the font properties, families, features, and what a face is
// asked for.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { featuresOf } from '../../src/html/layout/inline.js';
import type { FontsLike } from '../../src/html/layout/inline.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import {
  FONTS,
  boxOf,
  findById,
  h,
  linesOf,
  metric,
  render,
  renderWithBytes,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

metric(
  "a letter-spacing percentage is of the font size, and a font's size loses to a later font-size",
  async () => {
    // CSS Text 4: `letter-spacing: 200%` is two ems. And the `font`
    // shorthand's size lost to a more specific `font-size` only until the
    // cascade's second pass applied the `font` again
    const { node } = await render(
      '<style>span{font:15px/1 sans-serif} .b > span{font-size:30px}</style>' +
        '<p id="p" style="font-size:10px;letter-spacing:200%">x</p>' +
        '<div class="b"><span id="s">x</span></div>',
    );
    const el = view(node);
    const styleOf = (id: string) =>
      (
        boxOf(el, id) as unknown as {
          style: { letterSpacing: number; fontSize: number };
        }
      ).style;
    assert.strictEqual(styleOf('p').letterSpacing, 20);
    assert.strictEqual(styleOf('s').fontSize, 30);
  },
);

test('the generic monospace on its own is smaller, as in a browser', async () => {
  // 13 to 16: an element whose family becomes `monospace` scales the size
  // it inherits, and one that leaves it scales it back; a keyword reads the
  // smaller scale; a size an element sets is its own, and a list with a
  // fallback in it keeps the size it had
  const { node } = await render(
    '<div style="font-size:16px">' +
      '<p id="a" style="font-family:monospace">a</p>' +
      '<p id="b" style="font-family:monospace, monospace">b</p>' +
      '<p id="c" style="font-family:monospace;font-size:20px">c</p>' +
      '<p id="m" style="font-size:medium">m</p>' +
      '<div style="font-family:monospace">' +
      '<p id="d" style="font-family:serif">d</p>' +
      '<p id="e" style="font-size:medium">e</p>' +
      '<p id="f" style="font:italic medium monospace">f</p>' +
      '<p id="g" style="font-size:2em">g</p></div></div>',
  );
  const el = view(node);
  const size = (id: string) =>
    (boxOf(el, id) as LaidBox & { style: { fontSize: number } }).style.fontSize;
  assert.strictEqual(size('a'), 13, 'inherited, scaled');
  assert.strictEqual(size('b'), 16, 'a fallback: no');
  assert.strictEqual(size('c'), 20, 'set: its own');
  assert.strictEqual(size('d'), 16, 'and back');
  assert.strictEqual(size('e'), size('m') * (13 / 16), 'medium, smaller');
  assert.strictEqual(size('f'), size('m') * (13 / 16), 'through `font` too');
  assert.strictEqual(size('g'), 26, "an em of the parent's");
});

test('the font shorthand resets what it does not name', async () => {
  // CSS 2.1 15.8: `font` sets the style, weight, size, line height and
  // family, and whatever it leaves out goes back to its initial value rather
  // than keeping the parent's. `p { font: 12pt serif }` in a document set at
  // `20px/1em` has lines of normal height; the suite's margin-collapse tests
  // are built on it, and 20px lines put their text a pixel low.
  const { node } = await render(
    '<div style="font: italic bold 20px/40px sans-serif">' +
      '<p id="plain" style="font: 12px sans-serif">reset</p>' +
      '<p id="named" style="font: oblique 600 14px / 2 sans-serif">named</p>' +
      '<p id="sizeless" style="font: bold 14px">kept</p>' +
      '<p id="inherits" style="font: 0 sans-serif; font: inherit">all</p></div>',
    300,
  );
  type S = {
    fontStyle: string;
    fontWeight: number;
    fontSize: number;
    lineHeight: number | 'normal';
    lineHeightIsLength: boolean;
  };
  const style = (id: string) => {
    const { fontStyle, fontWeight, fontSize, lineHeight, lineHeightIsLength } =
      (boxOf(view(node), id) as unknown as { style: S }).style;
    return { fontStyle, fontWeight, fontSize, lineHeight, lineHeightIsLength };
  };
  assert.deepStrictEqual(style('plain'), {
    fontStyle: 'normal',
    fontWeight: 400,
    fontSize: 12,
    lineHeight: 'normal',
    lineHeightIsLength: false,
  });
  assert.deepStrictEqual(style('named'), {
    fontStyle: 'oblique',
    fontWeight: 600,
    fontSize: 14,
    lineHeight: 2,
    lineHeightIsLength: false,
  });
  // a size and no family is not a font: the declaration goes whole, and
  // what the paragraph inherited stands
  const inherited = {
    fontStyle: 'italic',
    fontWeight: 700,
    fontSize: 20,
    lineHeight: 40,
    lineHeightIsLength: true,
  };
  assert.deepStrictEqual(style('sizeless'), inherited);
  // and `font: inherit` takes all of it, the line height's unit included —
  // 40 read as a multiple would be lines 800px tall
  assert.deepStrictEqual(style('inherits'), inherited);
});

test('a line height below nought is none, alone or in the font shorthand', async () => {
  // the declaration goes (CSS 2.1 10.8.1): `font: 4em/-2em serif` set the
  // text at 4em, and `line-height: -2` stood its lines on one another
  const { node } = await render(
    '<div style="font: 20px/30px sans-serif">' +
      '<p id="a" style="font: 40px/-20px sans-serif">a</p>' +
      '<p id="b" style="line-height: -2">b</p>' +
      '<p id="c" style="line-height: -10px">c</p></div>',
  );
  const style = (id: string) =>
    (
      boxOf(view(node), id) as unknown as {
        style: { fontSize: number; lineHeight: number | 'normal' };
      }
    ).style;
  assert.deepStrictEqual(
    [style('a').fontSize, style('b').lineHeight, style('c').lineHeight],
    [20, 30, 30],
  );
});

test('an unquoted family name is its words with one space between', async () => {
  // `Courier    New` over two lines, or with a tab, is `Courier New`
  // (CSS 2.1 15.3); kept as written, it was a name no font has
  const { node } = await render(
    '<p id="a" style="font-family: Courier    New, serif">a</p>' +
      '<p id="b" style="font-family: \'Courier  New\'">b</p>',
  );
  const family = (id: string) =>
    (boxOf(view(node), id) as unknown as { style: { fontFamily: string } })
      .style.fontFamily;
  // and a list with no generic family at its end goes on to the document's
  assert.deepStrictEqual(
    [family('a'), family('b')],
    ['Courier New, serif', 'Courier  New, sans-serif'],
  );
});

metric(
  'a character the engine cannot shape costs itself, not the document',
  async () => {
    // A bitmap-only colour emoji font (CBDT) is what fontconfig answers first
    // for an emoji on most Linux desktops, and fontkit has no glyph to make
    // from it: its shaper threw on meetup.com's pin, and the page was left
    // blank. The character is drawn as U+FFFD instead, at the same length in
    // UTF-16, so every offset past it still lands.
    const pin = '\u{1F4CD}';
    const { result } = await render('<p id="p">x</p>');
    const engine = (result.app as unknown as { fonts: FontsLike }).fonts;
    const inner = engine.layout;
    const shaped: string[] = [];
    engine.layout = function (content, style, options) {
      const text = content.map((r) => r.text).join('');
      if (text.includes(pin)) {
        throw new TypeError("Cannot read properties of null (reading 'id')");
      }
      shaped.push(text);
      return inner.call(this, content, style, options);
    };
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (message: string) => void warned.push(String(message));
    try {
      await act(() =>
        result.rerender(
          h(
            'box',
            { style: { width: 400, flexDirection: 'column' } },
            h(Html, {
              source: `<p id="p">${pin} Melbourne, AU</p><p id="q">after</p>`,
              partial: false,
              'data-testname': 'doc',
            }),
          ),
        ),
      );
      await act();
    } finally {
      engine.layout = inner;
      console.warn = warn;
    }
    const el = view(screen.getByTestName('doc') as DrawnNode);
    assert.ok(el['_tree' as keyof typeof el], 'laid out, not left blank');
    assert.ok(boxOf(el, 'q').height > 0, 'and what follows is there');
    // the document is the page's; only what is drawn stands in
    assert.ok(el.textContent().startsWith(`${pin} Melbourne`));
    assert.ok(
      shaped.includes('\uFFFD\uFE0F Melbourne, AU'),
      `the stand-in is shaped: ${JSON.stringify(shaped)}`,
    );
    assert.strictEqual(warned.length, 1, 'said once');
    assert.match(warned[0], /U\+1F4CD/);
  },
);

test('a font-family with a name that is none is dropped (CSS 2.1 15.3)', async () => {
  const { node } = await render(
    '<div id="p" style="font-family: serif">' +
      '<div id="a" style="font-family: test!foo, monospace"></div>' +
      '<div id="b" style="font-family: 1996, monospace"></div>' +
      '<div id="c" style="font-family: Arial Black, \'Segoe UI\', -apple-system, monospace"></div>' +
      '</div>',
  );
  const el = view(node);
  const family = (id: string) =>
    (boxOf(el, id) as unknown as { style: { fontFamily: string } }).style
      .fontFamily;
  assert.strictEqual(family('a'), family('p'), 'inherited, not set');
  assert.strictEqual(family('b'), family('p'));
  assert.strictEqual(
    family('c'),
    'Arial Black, Segoe UI, -apple-system, monospace',
  );
});

test("a family list no face matches, with no generic family at its end, is set in the document's font", async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // CSS Fonts 4, 5.1: where no face in the list matches, the text is set in
  // the user agent's default font, which here is the document's. The text
  // engine answered a name nothing has with its own pick instead — its
  // first face here, fontconfig's Verdana on a desktop: the Zen Garden's
  // 216 sets its summary in Montserrat alone, which Chrome sets in its
  // standard font and ours set a fifth wider. The size is pinned, because
  // `monospace` on its own is set smaller than a list with more in it
  const span = (id: string, family: string) =>
    `<p style="margin:0"><span id="${id}" style="font-size:20px;` +
    `${family ? `font-family:${family}` : ''}">iiiiimmmmm</span></p>`;
  await renderX11(
    h(
      'box',
      { style: { width: 600, flexDirection: 'column' } },
      h(Html, {
        source:
          span('none', '') +
          span('own', 'NoSuchFamilyAnywhere') +
          span('generic', 'NoSuchFamilyAnywhere, serif'),
        partial: false,
        fontFamily: 'monospace',
        'data-testname': 'doc',
      }),
    ),
    { width: 640, height: 200, fonts: FONTS },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const width = (id: string) =>
    el.elementRect(findById(el.document, id)!)!.width;
  assert.ok(
    Math.abs(width('own') - width('none')) < 0.01,
    `a name nothing has is the document's monospace: ${width('own')} ${width('none')}`,
  );
  assert.ok(
    Math.abs(width('generic') - width('none')) > 1,
    `and a list that ends in a generic falls back through it: ${width('generic')}`,
  );
});

metric(
  'small capitals a face does not have are made of its capitals, smaller',
  async (t) => {
    // CSS Fonts 4, 6.2: a face with no `smcp` of its own has its small
    // capitals made of its capitals at a smaller size — 70%, rounded to a
    // pixel as Blink rounds it — where they drew as lower case. A space
    // keeps its size under `small-caps`, and is small under
    // `all-small-caps`, which makes the whole text small capitals.
    const { el } = await renderWithBytes(
      '<style>body{margin:0;font:16px sans-serif}span{white-space:pre}</style>' +
        '<p><span id="native" style="font-feature-settings:\'smcp\'">' +
        'abcdef</span> <span id="plain">abcdef</span></p>' +
        '<p><span id="sc" style="font-variant:small-caps">Abc def</span></p>' +
        '<p><span id="a">A</span><span id="bc" style="font-size:11px">BC' +
        '</span><span id="s"> </span><span id="def" style="font-size:11px">' +
        'DEF</span></p>' +
        '<p><span id="asc" style="font-variant-caps:all-small-caps">Abc def' +
        '</span></p>' +
        '<p><span id="all" style="font-size:11px">ABC DEF</span></p>',
      {},
    );
    const w = (id: string) => el.elementRect(findById(el.document, id)!)!.width;
    if (Math.abs(w('native') - w('plain')) > 0.01) {
      t.skip('the face has small capitals of its own');
      return;
    }
    const made = w('a') + w('bc') + w('s') + w('def');
    assert.ok(
      Math.abs(w('sc') - made) < 0.05,
      `small-caps ${w('sc')}, made of capitals ${made}`,
    );
    assert.ok(
      Math.abs(w('asc') - w('all')) < 0.05,
      `all-small-caps ${w('asc')}, capitals ${w('all')}`,
    );
  },
);

test('the font-variant longhands, font-kerning and font-feature-settings are read', async () => {
  const { node } = await render(
    '<p id="a" style="font-variant-numeric:tabular-nums slashed-zero">a</p>' +
      '<p id="b" style="font-variant:small-caps oldstyle-nums">b</p>' +
      '<p id="c" style="font-variant-ligatures:none;font-kerning:none">c</p>' +
      '<p id="d" style="font-feature-settings:&quot;liga&quot; 0, ' +
      '&quot;ss01&quot;">d</p>' +
      '<p id="e" style="font-variant-numeric:tabular-nums small-caps">e</p>' +
      '<div style="font-variant-numeric:tabular-nums">' +
      '<p id="f" style="font:small-caps 12px serif">f</p><p id="g">g</p></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
  assert.strictEqual(style('a').fontVariantNumeric, 'tnum=1,zero=1');
  assert.strictEqual(style('b').fontVariantCaps, 'smcp=1');
  assert.strictEqual(style('b').fontVariantNumeric, 'onum=1');
  assert.strictEqual(
    style('c').fontVariantLigatures,
    'liga=0,clig=0,dlig=0,hlig=0,calt=0',
  );
  assert.strictEqual(style('c').fontKerning, 'kern=0');
  assert.strictEqual(style('d').fontFeatureSettings, 'liga=0,ss01=1');
  // a keyword of another longhand is no value of this one
  assert.strictEqual(style('e').fontVariantNumeric, '');
  // the `font` shorthand sets the variants back, save its small capitals,
  // and what it does not set is inherited
  assert.strictEqual(style('f').fontVariantNumeric, '');
  assert.strictEqual(style('f').fontVariantCaps, 'smcp=1');
  assert.strictEqual(style('g').fontVariantNumeric, 'tnum=1');
});

test("a style's features: the variants', then the settings', one object for each set", () => {
  // the six fields it reads
  const style = (fields: Partial<ComputedStyle>) =>
    ({
      fontVariantNumeric: '',
      fontVariantCaps: '',
      fontVariantLigatures: '',
      fontVariantPosition: '',
      fontKerning: '',
      fontFeatureSettings: '',
      ...fields,
    }) as ComputedStyle;
  assert.strictEqual(featuresOf(style({})), null, 'none at all');
  const tabular = featuresOf(
    style({
      fontVariantNumeric: 'tnum=1',
      fontFeatureSettings: 'tnum=0,ss01=1',
    }),
  );
  assert.deepStrictEqual(tabular, { tnum: 0, ss01: 1 }, 'the settings last');
  assert.strictEqual(
    featuresOf(
      style({
        fontVariantNumeric: 'tnum=1',
        fontFeatureSettings: 'tnum=0,ss01=1',
      }),
    ),
    tabular,
    'the same object, so that a run is found by it',
  );
});

metric('text is shaped with the features its style asks for', async () => {
  const { node } = await render(
    '<p id="p" style="font-variant-numeric:tabular-nums">1234</p>' +
      '<p id="q">1234</p>',
  );
  const el = view(node);
  type Spans = { lines: { runs: { span?: { features?: unknown } }[] }[] };
  const features = (id: string) => {
    const [line] = linesOf(el, id);
    const layout = line.texts[0].layout as unknown as Spans;
    return layout.lines[line.texts[0].layoutLine].runs[0].span?.features;
  };
  assert.deepStrictEqual(features('p'), { tnum: 1 });
  assert.strictEqual(features('q'), undefined);
});

metric(
  "a document's faces are asked for before its layout sets text in them",
  async () => {
    // a `th` at 600 is none of the four faces a family is warmed in, and its
    // match was a synchronous fc-match inside the layout: 38 ms of the
    // benchmark report's first paint. The boxes say which faces the text is
    // set in before anything is laid out, and those are asked for then.
    const probe = await render('<p>x</p>');
    const proto = Object.getPrototypeOf(
      (probe.result.app as unknown as { fonts: object }).fonts,
    ) as {
      prewarm(
        family: string,
        faces?: { weight: number; style: string }[],
      ): void;
      match(
        family: string,
        opts?: { weight?: unknown; style?: string },
      ): unknown;
    };
    const { prewarm, match } = proto;
    const asked: string[] = [];
    proto.prewarm = function (family, faces) {
      for (const f of faces ?? []) asked.push(`warm ${f.weight} ${f.style}`);
      return prewarm.call(this, family, faces);
    };
    proto.match = function (family, opts) {
      asked.push(
        `match ${String(opts?.weight ?? 400)} ${opts?.style ?? 'normal'}`,
      );
      return match.call(this, family, opts);
    };
    try {
      await render(
        '<style>th { font-weight: 600 } em { font-style: italic }</style>' +
          '<table><tr><th>Heading</th></tr><tr><td>a <em>cell</em></td></tr></table>',
      );
    } finally {
      proto.prewarm = prewarm;
      proto.match = match;
    }
    const warmed = asked.indexOf('warm 600 normal');
    assert.ok(warmed >= 0, `the heading's face is warmed: ${asked.join(', ')}`);
    const matched = asked.indexOf('match 600 normal');
    assert.ok(
      matched === -1 || warmed < matched,
      'before the layout asks for it',
    );
    assert.ok(asked.includes('warm 400 italic'), 'and the emphasis');
    // a face is asked once, however many boxes are set in it
    assert.strictEqual(asked.filter((a) => a === 'warm 600 normal').length, 1);
  },
);
