// <Html> — the cascade: inheritance, layers, nesting, logical properties, and
// what a restyle costs.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { HtmlViewNode } from '../../src/html/index.js';
import {
  parseStylesheet,
  supportsCondition,
} from '../../src/html/css/parse.js';
import { INHERITED, inherit, initialStyle } from '../../src/html/css/style.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import {
  boxOf,
  edgesOf,
  h,
  metric,
  render,
  renderWithBytes,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

test('inherit reaches the box model', async () => {
  const { node } = await render(
    '<div style="margin:0 7px;padding:3px"><p id="p" style="margin:inherit;' +
      'padding:inherit">x</p></div>',
  );
  const p = boxOf(view(node), 'p') as LaidBox & {
    marginLeft: number;
    padLeft: number;
  };
  assert.strictEqual(p.marginLeft, 7);
  assert.strictEqual(p.padLeft, 3);
});

test('initial is where a property starts, inherited or not', async () => {
  // `line-height: initial` in a box inside 200px lines was 200px still,
  // which it inherits, and `margin: initial` after a margin was that
  // margin: the keyword is the property's initial value, whatever came
  // before it (CSS Cascade 4, 7.3.1)
  const { node } = await render(
    '<style>#a { margin: 9px } #a { margin: initial }</style>' +
      '<div style="line-height:200px"><p id="p" style="line-height:initial">' +
      'x</p></div><p id="a">x</p>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { lineHeight: unknown; marginTop: number };
      }
    ).style;
  assert.strictEqual(style('p').lineHeight, 'normal');
  assert.strictEqual(style('a').marginTop, 0);
});

metric(
  'the body inherits its colour and font from the root, an html rule too',
  async () => {
    const doc = await renderWithBytes(
      '<html><style>html { color: #00ff00; font-family: serif }</style>' +
        '<body><p id="p">x</p></body></html>',
      {},
    );
    const style = (el: HtmlViewNode) =>
      (boxOf(el, 'p') as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(style(doc.el).color, '#00ff00');
    assert.strictEqual(style(doc.el).fontFamily, 'serif');
    cleanup();
    // a fragment's body inherits from the html a browser would imply
    const fragment = await renderWithBytes(
      '<style>html { color: #00ff00 }</style><p id="p">x</p>',
      {},
    );
    assert.strictEqual(style(fragment.el).color, '#00ff00');
    cleanup();
    // and so does a page with a <body> and no <html>, the usual shape of
    // one that starts `<!DOCTYPE html><title>`, where the rule matched
    // nothing and the page came out at the theme's size
    const page = await renderWithBytes(
      '<!DOCTYPE html><title>t</title><style>html { color: #00ff00; ' +
        'font-size: 10px }</style><body><p id="p">x</p></body>',
      {},
    );
    assert.strictEqual(style(page.el).color, '#00ff00');
    assert.strictEqual(style(page.el).fontSize, 10);
  },
);

metric(
  ':root is the html element, not every element at the top of a fragment',
  async () => {
    const { el } = await renderWithBytes(
      '<style>:root { --c: #00ff00; margin-left: 30px } p { color: var(--c) }</style>' +
        '<p id="p">x</p>',
      {},
    );
    const p = boxOf(el, 'p') as unknown as {
      x: number;
      style: Record<string, unknown>;
    };
    // the property reaches the paragraph through the html a browser implies
    assert.strictEqual(p.style.color, '#00ff00');
    // and the paragraph does not take the root's margin as its own
    assert.strictEqual(p.style.marginLeft, 0);
  },
);

test("logical properties are the physical ones of the element's direction", async () => {
  // CSS Logical Properties 1 in the horizontal writing mode: Tailwind 4
  // writes its spacing in them, `px-4` as `padding-inline` and `mx-auto`
  // as `margin-inline: auto`
  const { node } = await render(
    '<style>body{margin:0}.px-4{padding-inline:calc(4px * 4)}' +
      '.py-2{padding-block:8px}.mx-auto{margin-inline:auto}</style>' +
      '<div style="width:400px"><div id="a" class="px-4 py-2 mx-auto" ' +
      'style="inline-size:100px;border-inline-start:3px solid"></div>' +
      '<div id="r" dir="rtl" style="margin-inline-start:10px;' +
      'padding-inline:1px 2px;border-start-end-radius:6px"></div>' +
      '<div id="o" style="padding-left:5px;padding-inline-start:7px;' +
      'margin-inline-end:4px;margin-right:9px"></div>' +
      '<div id="x" style="padding-inline:10px -5px;padding-block:1px 2px 3px">' +
      '</div></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  const ae = edgesOf(a);
  assert.deepStrictEqual(
    [ae.padLeft, ae.padRight, ae.padTop, ae.padBottom, ae.borderLeft, a.width],
    [16, 16, 8, 8, 3, 135],
  );
  assert.strictEqual(a.x, (400 - 135) / 2, 'centred by its auto margins');
  const r = edgesOf(boxOf(el, 'r'));
  assert.deepStrictEqual(
    [r.marginRight, r.marginLeft, r.padRight, r.padLeft],
    [10, 0, 1, 2],
    'the start is the right, right to left',
  );
  assert.deepStrictEqual(r.style.borderRadius, [6, 0, 0, 0], 'and the corner');
  const o = edgesOf(boxOf(el, 'o'));
  assert.deepStrictEqual(
    [o.padLeft, o.marginRight],
    [7, 9],
    'whichever of the two comes later',
  );
  const x = edgesOf(boxOf(el, 'x'));
  assert.deepStrictEqual(
    [x.padLeft, x.padRight, x.padTop, x.padBottom],
    [0, 0, 0, 0],
    'a part that is no value takes the declaration with it',
  );
});

test('inset sets all four offsets, and a corner its radius', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="position:relative;width:200px;height:100px">' +
      '<div id="f" style="position:absolute;inset:0"></div>' +
      '<div id="g" style="position:absolute;inset:10px 20px"></div></div>' +
      '<div id="c" style="border-top-left-radius:8px;' +
      'border-bottom-right-radius:4px 2px"></div>',
  );
  const el = view(node);
  const [f, g] = [boxOf(el, 'f'), boxOf(el, 'g')];
  assert.deepStrictEqual([f.x, f.y, f.width, f.height], [0, 0, 200, 100]);
  assert.deepStrictEqual([g.x, g.y, g.width, g.height], [20, 10, 160, 80]);
  assert.deepStrictEqual(
    edgesOf(boxOf(el, 'c')).style.borderRadius,
    [8, 0, 4, 0],
  );
});

test('a later cascade layer wins over an earlier one, and no layer over any', async () => {
  // CSS Cascade 5: Tailwind 4 writes all of its CSS in `@layer theme,
  // base, components, utilities`, which was dropped whole
  const colorOf = async (css: string, markup = '<p id="p" class="x">x</p>') => {
    const { node } = await render(`<style>${css}</style>${markup}`);
    const style = (
      boxOf(view(node), 'p') as unknown as { style: { color: string } }
    ).style;
    cleanup();
    return style.color;
  };
  const red = '#ff0000';
  const blue = '#0000ff';
  // the order the layers are first named in, not their specificity
  assert.strictEqual(
    await colorOf(
      '@layer a, b; @layer b { .x { color: #0000ff } } ' +
        '@layer a { p#p.x { color: #ff0000 } }',
    ),
    blue,
  );
  assert.strictEqual(
    await colorOf(
      '.x { color: #0000ff } @layer a { p#p.x { color: #ff0000 } }',
    ),
    blue,
    'a rule in no layer over one in any',
  );
  assert.strictEqual(
    await colorOf(
      '@layer a { .x { color: #ff0000 !important } } ' +
        '@layer b { .x { color: #0000ff !important } } .x { color: #008000 !important }',
    ),
    red,
    'and the other way round for !important',
  );
  assert.strictEqual(
    await colorOf(
      '@layer a { .x { color: #ff0000 } @layer b { p#p.x { color: #0000ff } } }',
    ),
    red,
    "a layer's own rules over the layers in it",
  );
  assert.strictEqual(
    await colorOf(
      '',
      '<style>@layer b, a;</style><style>@layer a { .x { color: #ff0000 } } ' +
        '@layer b { .x { color: #0000ff } }</style><p id="p" class="x">x</p>',
    ),
    red,
    "the order is the document's, across its sheets",
  );
  assert.strictEqual(
    await colorOf(
      '@layer { .x { color: #ff0000 } } @layer { .x { color: #0000ff } }',
    ),
    blue,
    'a layer with no name is one of its own',
  );
});

test('a nested rule is relative to its parent, and a nested @media holds for it', () => {
  // CSS Nesting 1, as Tailwind 4 writes its variants: `md:flex` is a
  // `@media` inside the rule, and `hover:` is `&:hover`
  const sheet = parseStylesheet(
    '.md\\:flex { @media (width >= 48rem) { display: flex } }\n' +
      '.hover\\:x { &:hover { @media (hover: hover) { color: red } } }\n' +
      '.space { :where(& > :not(:last-child)) { margin: 1px } }\n' +
      '.card { color: blue; .title { color: red } > p { margin: 0 }' +
      ' &.on, &:focus { color: green } }\n' +
      '.a, .b { & + & { margin: 2px } }\n' +
      '.x { --x: { a: b }; div& { color: red } &div { color: red } }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => [r.selector, JSON.stringify(r.media)]),
    [
      ['.md\\:flex', '[[{"min":768}]]'],
      ['.hover\\:x:hover', '[[{"staticPass":true}]]'],
      [':where(:is(.space) > :not(:last-child))', 'null'],
      ['.card', 'null'],
      ['.card .title', 'null'],
      ['.card > p', 'null'],
      ['.card.on', 'null'],
      ['.card:focus', 'null'],
      [':is(.a) + :is(.a)', 'null'],
      [':is(.b) + :is(.b)', 'null'],
      ['.x', 'null'],
      // `&div` has its type after the rest of its compound, which is no
      // selector, and goes; `div&` is the way to write it
      ['div:is(.x)', 'null'],
    ],
  );
  // in the order they are written, after the parent's own declarations
  const orders = sheet.rules.map((r) => r.order);
  assert.deepStrictEqual(
    orders,
    [...orders].sort((a, b) => a - b),
  );
});

test('a nested rule and a media range reach the document', async () => {
  const { node } = await render(
    '<style>body{margin:0}.p { padding-left: 1px; & { padding-top: 2px }' +
      ' @media (width >= 300px) { padding-right: 3px }' +
      ' @media (width < 300px) { padding-bottom: 4px }' +
      ' .c { margin-left: 5px } }</style>' +
      '<div id="p" class="p"><div id="c" class="c"></div></div>',
  );
  const el = view(node);
  const p = edgesOf(boxOf(el, 'p'));
  assert.deepStrictEqual(
    [p.padLeft, p.padTop, p.padRight, p.padBottom],
    [1, 2, 3, 0],
  );
  assert.strictEqual(edgesOf(boxOf(el, 'c')).marginLeft, 5);
});

test('a style takes from its parent the fields INHERITED names, and no others', () => {
  // `inherit` writes them out one by one, where a loop over the list was
  // three quarters of each element's style: the list and the function
  // have to stay the same set
  const look = {
    color: '#010101',
    fontFamily: 'sans-serif',
    fontSize: 14,
    monoFamily: 'monospace',
    linkColor: '#020202',
    borderColor: '#030303',
    mutedColor: '#040404',
    background: '#050505',
    colorScheme: 'light' as const,
    surface: '#060606',
    controlPadY: 4,
    controlBorder: 1,
    controlRadius: 4,
  };
  const initial = initialStyle(look, 1);
  // a parent every field of which differs from the initial style's
  const parent = { ...initial } as Record<string, unknown>;
  for (const key of Object.keys(parent)) parent[key] = { marker: key };
  const out = inherit(
    parent as unknown as ComputedStyle,
    initial,
  ) as unknown as Record<string, unknown>;
  const taken = Object.keys(out)
    .filter((key) => out[key] === parent[key])
    .sort();
  const expected = [
    ...INHERITED,
    'underline',
    'underlineStyle',
    'underlineThickness',
    'underlineOffset',
    'lineThrough',
    'lineThroughStyle',
    'lineThroughThickness',
  ].sort();
  assert.deepStrictEqual(taken, expected);
});

test('an append to a streamed document keeps its stylesheet parsed', async () => {
  // a framework's stylesheet was parsed and its rules indexed again on
  // every append, and every width across a breakpoint
  const doc = (source: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, 'data-testname': 'doc' }),
    );
  const head = '<style>p { color: #0b0b0b }</style><p>one</p>';
  const result = await renderX11(doc(head), { backend: 'mock' });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const cascadeOf = () => (el() as unknown as { _cascade: unknown })._cascade;
  el().textContent();
  const before = cascadeOf();
  assert.ok(before, 'a cascade');
  await act(() => result.rerender(doc(head + '<p>two</p>')));
  assert.strictEqual(el().textContent(), 'onetwo');
  assert.strictEqual(cascadeOf(), before, 'the same cascade');
  // and the paragraph that arrived is styled by it
  const tree = (
    el() as unknown as {
      _tree: {
        root: { children: { children: { style: { color: string } }[] }[] };
      };
    }
  )._tree;
  const colors: string[] = [];
  const walk = (b: {
    style?: { color: string };
    children?: unknown[];
  }): void => {
    if (b.style && (b as { el?: { name: string } }).el?.name === 'p') {
      colors.push(b.style.color);
    }
    for (const c of (b.children ?? []) as (typeof b)[]) walk(c);
  };
  walk(tree.root as never);
  // each paragraph's box and its text's, the new one's among them
  assert.deepStrictEqual(colors, ['#0b0b0b', '#0b0b0b', '#0b0b0b', '#0b0b0b']);
  // a change to the sheet is a new cascade
  await act(() =>
    result.rerender(
      doc('<style>p { color: #0c0c0c }</style><p>one</p><p>two</p>'),
    ),
  );
  el().textContent();
  assert.notStrictEqual(cascadeOf(), before);
});

test('a pseudo-element no rule gives a content to is none, whatever reaches it', async () => {
  // Tailwind's `*, ::before, ::after` reaches both of every element's
  const count = async (css: string) => {
    const { node } = await render(
      `<style>${css}</style><p>a</p><p class="x">b</p>`,
    );
    let n = 0;
    const walk = (b: { children?: unknown[] }): void => {
      n += 1;
      for (const c of (b.children ?? []) as (typeof b)[]) walk(c);
    };
    walk((view(node) as unknown as { _tree: { root: object } })._tree.root);
    return n;
  };
  const bare = await count('');
  assert.strictEqual(
    await count('*, ::before, ::after { box-sizing: border-box; --x: 1 }'),
    bare,
  );
  assert.strictEqual(
    await count('.x::before { content: var(--label, "*") }'),
    bare + 2,
    'a ::before box and its text',
  );
});

test('`:focus` matches no element, and a rule that names it stays in the cascade', async () => {
  // css-select has no `:focus`, and threw on one: every rule naming it was
  // dropped, `:not(:focus)` among them, and Wikipedia's skip link stood in
  // the flow at the top of every page
  const { node } = await render(
    '<style>body,p{margin:0}' +
      '.skip:not(:focus){position:absolute;width:1px;height:1px;' +
      'overflow:hidden}' +
      'a:focus,p:focus-within,p:focus-visible{margin-left:50px}</style>' +
      '<a id="skip" class="skip" href="#p">Jump to content</a>' +
      '<p id="p"><a id="a" href="#">text</a></p>',
  );
  const el = view(node);
  const skip = boxOf(el, 'skip');
  assert.deepStrictEqual([skip.width, skip.height], [1, 1]);
  assert.strictEqual(boxOf(el, 'p').y, 0, 'and takes no room in the flow');
  assert.strictEqual(boxOf(el, 'p').x, 0, 'nothing is focused');
});

test('a @supports test of the mask is answered, and every other is entered', () => {
  // A page keeps a background image under `not` for an engine without
  // masks. Entered as every `@supports` block was, Wikipedia's chevron was
  // that image in black under its mask, over its blue
  assert.strictEqual(
    supportsCondition('not ((-webkit-mask-image:none) or (mask-image:none))'),
    false,
  );
  assert.strictEqual(supportsCondition('(mask-image: none)'), true);
  assert.strictEqual(
    supportsCondition('(mask-image: none) and (-webkit-mask-size: 1px)'),
    true,
  );
  // what it cannot answer it does not: Tailwind 4 keeps its variables'
  // starting values under a test for engines without `@property`
  for (const unknown of [
    '(display: grid)',
    'not (display: grid)',
    'selector(:focus-visible)',
    '(mask-image: none) and (display: grid)',
    '((-webkit-hyphens: none) and (not (margin-trim: inline))) or ' +
      '((-moz-orient: inline) and (not (color:rgb(from red r g b))))',
  ]) {
    assert.strictEqual(supportsCondition(unknown), null, unknown);
  }
  const sheet = parseStylesheet(
    '@supports not (mask-image: none) { .a { color: red } }' +
      '@supports (mask-image: none) { .b { color: red } }' +
      '@supports (display: grid) { .c { color: red } }' +
      '.d { @supports not (mask: none) { color: red } }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.selector),
    ['.b', '.c'],
  );
});
