// <Html> — container queries: `container-type`, `container-name`,
// `@container`, and the container units. Each case's answer is Chromium's
// for the same markup.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { parseStylesheet } from '../../src/html/css/parse.js';
import { parseContainerPrelude } from '../../src/html/css/containers.js';
import {
  FONTS,
  boxOf,
  findById,
  h,
  metric,
  render,
  render2x,
  treeOf,
  view,
} from './harness.js';
import type { HtmlViewNode } from '../../src/html/index.js';

afterEach(cleanup);

const BLUE = '#0000ff';

/** An element's computed colour, its box's. */
function colorOf(el: HtmlViewNode, id: string): string {
  return (boxOf(el, id) as unknown as { style: { color: string } }).style.color;
}

test('an @container prelude is a name, a condition, or both, and a list of them', () => {
  assert.deepStrictEqual(parseContainerPrelude('(min-width: 400px)'), [
    { name: null, condition: '(min-width: 400px)', axes: 1 },
  ]);
  assert.deepStrictEqual(parseContainerPrelude('card (height > 2em)'), [
    { name: 'card', condition: '(height > 2em)', axes: 2 },
  ]);
  assert.deepStrictEqual(
    parseContainerPrelude('style(--x: 1), side (orientation: portrait)'),
    [
      { name: null, condition: 'style(--x: 1)', axes: 0 },
      { name: 'side', condition: '(orientation: portrait)', axes: 3 },
    ],
  );
  assert.deepStrictEqual(parseContainerPrelude('card'), [
    { name: 'card', condition: '', axes: 0 },
  ]);
  // `not` is no name, and a feature nothing knows is no condition
  assert.strictEqual(parseContainerPrelude('not (width < 1px)')![0].name, null);
  assert.strictEqual(parseContainerPrelude('(colour: red)'), null);
  assert.strictEqual(parseContainerPrelude('none (width > 1px)'), null);
  assert.strictEqual(parseContainerPrelude('(a) and (b) or (c)'), null);
  // and a rule under one is the rule with its queries, nested or not
  const sheet = parseStylesheet(
    '@container card (width > 1px) { p { color: red } ' +
      '@container (height > 1px) { b { color: red } } } ' +
      '.x { @container (width > 1px) { color: red } } ' +
      '@container (bogus: 1) { i { color: red } }',
  );
  assert.strictEqual(sheet.containers, true);
  assert.deepStrictEqual(
    sheet.rules.map((r) => [r.selector, r.containers?.length ?? 0]),
    [
      ['p', 1],
      ['b', 2],
      ['.x', 1],
    ],
  );
});

metric(
  "a rule under @container holds where its query holds of the nearest container's content box",
  async () => {
    const { node } = await render(
      '<style>body { margin: 0; font: 16px/20px sans-serif }' +
        '.c { container-type: inline-size; width: 300px }' +
        '@container (min-width: 1px) { .q { color: #0000ff } }' +
        '@container (width > 299px) { .w { color: #0000ff } }' +
        '@container (width > 300px) { .w2 { color: #0000ff } }' +
        // a query's em is its container's
        '@container (min-width: 18em) { .em { color: #0000ff } }' +
        '.big { font-size: 32px }' +
        // a container is not its own, but its ::before's
        '@container (min-width: 1px) { .self { color: #0000ff } }' +
        '@container (min-width: 1px) { .pse::before { content: "x"; color: #0000ff } }' +
        // by name, past a nearer container of another
        '.named { container: named / inline-size; width: 200px }' +
        '@container named (min-width: 1px) { .nm { color: #0000ff } }' +
        // a height is a `size` container's to answer, and an inline-size
        // one does not
        '@container (height > 1px) { .h { color: #0000ff } }' +
        '@container (orientation: landscape) { .o { color: #0000ff } }' +
        '@container not (width < 100px) { .not { color: #0000ff } }' +
        '@container (width >= 300px) and (width <= 300px) { .and { color: #0000ff } }' +
        '@container (100px < width < 400px) { .rng { color: #0000ff } }' +
        // any element is a style container
        '@container style(--v: 1) { .st { color: #0000ff } }' +
        // an inline box is no size container, and no container is unknown
        '.inlc { display: inline; container-type: inline-size }' +
        // the content box: a 300px border box less 100px of padding
        '.pad { container-type: inline-size; width: 300px; padding: 0 50px; box-sizing: border-box }' +
        '@container (width = 200px) { .cb { color: #0000ff } }' +
        '</style>' +
        '<div class="c"><p class="q" id="q">q</p><p class="w" id="w">w</p>' +
        '<p class="w2" id="w2">w2</p><p class="em" id="em1">em1</p>' +
        '<div class="big"><p class="em" id="em2">em2</p></div></div>' +
        '<div class="c big"><p class="em" id="em3">em3</p></div>' +
        '<div class="c self" id="self">self</div>' +
        '<div class="c pse" id="pse">p</div>' +
        '<div class="named"><div class="c"><p class="nm" id="nm">nm</p></div></div>' +
        '<div class="c"><p class="h" id="h">h</p><p class="o" id="o">o</p>' +
        '<p class="not" id="not">not</p><p class="and" id="and">and</p>' +
        '<p class="rng" id="rng">rng</p></div>' +
        '<div style="--v: 1"><p class="st" id="st">st</p></div>' +
        '<span class="inlc"><span class="q" id="inl">inl</span></span>' +
        '<p class="q" id="noc">noc</p>' +
        '<div class="pad"><p class="cb" id="cb">cb</p></div>',
      600,
    );
    const el = view(node);
    const blue = [
      'q',
      'w',
      'w2',
      'em1',
      'em2',
      'em3',
      'self',
      'nm',
      'h',
      'o',
      'not',
      'and',
      'rng',
      'st',
      'inl',
      'noc',
      'cb',
    ].filter((id) => colorOf(el, id) === BLUE);
    assert.deepStrictEqual(blue, [
      'q',
      'w',
      'em1',
      'em2',
      'nm',
      'not',
      'and',
      'rng',
      'st',
      'cb',
    ]);
    const before = (treeOf(el) as { root: unknown }).root as unknown as Pseudo;
    assert.deepStrictEqual(pseudoColors(before), [BLUE]);
  },
);

type Pseudo = { pseudo?: string; style: { color: string }; children: Pseudo[] };

function pseudoColors(box: Pseudo): string[] {
  const out: string[] = [];
  const walk = (b: Pseudo): void => {
    if (b.pseudo === 'before') out.push(b.style.color);
    for (const child of b.children ?? []) walk(child);
  };
  walk(box);
  return out;
}

metric(
  'a size container is a formatting context of its own, sized without its content in its axes, and holds no positioned box',
  async () => {
    const { node } = await render(
      '<style>body { margin: 0; font: 16px/20px sans-serif }' +
        '.c { container-type: inline-size; width: 300px }' +
        '#abs { position: absolute; top: 0; left: 0; width: 10px; height: 10px }' +
        '#flt { float: left; width: 20px; height: 50px }' +
        '#mc { margin-top: 30px; height: 10px }' +
        '.shrink { display: inline-block; container-type: inline-size }' +
        '.shrink2 { float: left; container-type: size }' +
        '</style>' +
        '<div class="c" id="abs-host" style="margin-top: 100px"><div id="abs"></div></div>' +
        '<div class="c" id="float-host"><div id="flt"></div></div>' +
        '<div class="c" id="mc-host"><div id="mc"></div></div>' +
        '<div class="shrink" id="shr"><span>content here</span></div>' +
        '<div class="shrink2" id="shr2"><span>content here</span></div>',
      600,
    );
    const el = view(node);
    const rect = (id: string) => {
      const r = el.elementRect(findById(el.document, id)!)!;
      return [r.x, r.y, r.width, r.height];
    };
    // placed against the document, not the container
    assert.deepStrictEqual(rect('abs'), [0, 0, 10, 10]);
    // the float inside, and the margin not through the edge
    assert.deepStrictEqual(rect('float-host'), [0, 100, 300, 50]);
    assert.deepStrictEqual(rect('mc-host'), [0, 150, 300, 40]);
    assert.deepStrictEqual(rect('mc'), [0, 180, 300, 10]);
    // no content in an axis it answers for
    assert.strictEqual(rect('shr')[2], 0);
    assert.deepStrictEqual(rect('shr2').slice(2), [0, 0]);
  },
);

metric(
  "a container unit is a hundredth of the nearest container's content box in its axis, or the viewport's",
  async () => {
    const { node } = await render(
      '<style>body { margin: 0 }' +
        '.c { container-type: inline-size; width: 300px }' +
        '.s { container-type: size; width: 200px; height: 100px }' +
        '.u { width: 50cqw; height: 10cqi }' +
        // a block axis no inline-size container has: the next one out's
        '.b { width: 10px; height: 50cqh }' +
        '.m { width: 10cqmax; height: 10cqmin }' +
        '</style>' +
        '<div class="c"><div class="u" id="u"></div></div>' +
        '<div class="s"><div class="c"><div class="b" id="b"></div>' +
        '<div class="m" id="m"></div></div></div>' +
        '<div class="b" id="vb"></div>',
      400,
    );
    const el = view(node);
    const size = (id: string) => {
      const r = el.elementRect(findById(el.document, id)!)!;
      return [r.width, r.height];
    };
    assert.deepStrictEqual(size('u'), [150, 30]);
    assert.deepStrictEqual(size('b'), [10, 50]);
    // the inline axis the nearer container's, the block axis the outer's
    assert.deepStrictEqual(size('m'), [30, 10]);
    // and with no container, the viewport's: 600px tall
    assert.deepStrictEqual(size('vb'), [10, 300]);
  },
);

metric(
  'a container sized by another container’s query answers for the size that gave it, however deep',
  async () => {
    const { node } = await render(
      '<style>body { margin: 0 }' +
        '.c { container-type: inline-size }' +
        '#outer { width: 600px }' +
        '#mid { width: 100px } #inner { width: 100px }' +
        '@container (min-width: 500px) { #mid { width: 450px } }' +
        '@container (min-width: 400px) { #inner { width: 350px } }' +
        '@container (min-width: 300px) { #leaf { color: #0000ff } }' +
        '</style>' +
        '<div class="c" id="outer"><div class="c" id="mid">' +
        '<div class="c" id="inner"><p id="leaf">leaf</p></div></div></div>',
      700,
    );
    const el = view(node);
    assert.strictEqual(colorOf(el, 'leaf'), BLUE);
    assert.strictEqual(
      el.elementRect(findById(el.document, 'inner')!)!.width,
      350,
    );
  },
);

metric(
  'two elements alike in every way take what their own containers answer, and their own units',
  async () => {
    // two cells of one grid, alike in every attribute, which the grid
    // makes one narrow and one wide: everything in them shares a key, and
    // the first one styled is the one whose query fails
    const cell =
      '<div class="cell"><div class="card"><p class="title">t</p>' +
      '<div class="bar"></div></div></div>';
    const { node } = await render(
      '<style>body { margin: 0 }' +
        '.grid { display: grid; grid-template-columns: 200px 400px }' +
        '.card { container-type: inline-size }' +
        '@container (min-width: 300px) { .title { color: #0000ff } }' +
        '.bar { width: 50cqw; height: 1px }' +
        '</style>' +
        `<div class="grid">${cell}${cell}</div>`,
      700,
    );
    const el = view(node);
    const all = (cls: string): HtmlViewNode['document'][] => {
      const out: unknown[] = [];
      const walk = (n: {
        attribs?: Record<string, string>;
        children?: unknown[];
      }): void => {
        if (n.attribs?.class === cls) out.push(n);
        for (const c of n.children ?? []) walk(c as typeof n);
      };
      walk(el.document as never);
      return out as never;
    };
    const styles = (
      el as unknown as {
        _tree: { styles: Map<unknown, { style: { color: string } }> };
      }
    )._tree.styles;
    assert.deepStrictEqual(
      all('title').map((t) => styles.get(t)!.style.color === BLUE),
      [false, true],
    );
    assert.deepStrictEqual(
      all('bar').map((b) => el.elementRect(b as never)!.width),
      [100, 200],
    );
  },
);

metric(
  'a resize that moves a container across its query restyles what it answers for',
  async () => {
    const doc = (width: number) =>
      h(
        'box',
        { style: { width, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body { margin: 0 }' +
            '.c { container-type: inline-size; width: 50% }' +
            '@container (min-width: 300px) { p { color: #0000ff } }' +
            '.u { width: 10cqw; height: 1px }' +
            '</style><div class="c"><p id="p">p</p><div class="u" id="u"></div></div>',
          partial: false,
          'data-testname': 'doc',
        }),
      );
    const result = await renderX11(doc(400), {
      width: 900,
      height: 300,
      fonts: FONTS!,
    });
    const el = () => view(screen.getByTestName('doc') as DrawnNode);
    const unit = () => el().elementRect(findById(el().document, 'u')!)!.width;
    await act();
    assert.notStrictEqual(colorOf(el(), 'p'), BLUE);
    assert.strictEqual(unit(), 20);
    await act(() => result.rerender(doc(800)));
    await act();
    assert.strictEqual(colorOf(el(), 'p'), BLUE);
    assert.strictEqual(unit(), 40);
    await act(() => result.rerender(doc(400)));
    await act();
    assert.notStrictEqual(colorOf(el(), 'p'), BLUE);
    assert.strictEqual(unit(), 20);
  },
);

metric(
  "at a display scale of 2 a query's lengths are CSS pixels, as the container's box is",
  async () => {
    const { node } = await render2x(
      '<style>body { margin: 0 }' +
        '.c { container-type: inline-size; width: 200px }' +
        '@container (width > 199px) { .a { color: #0000ff } }' +
        '@container (width > 200px) { .b { color: #0000ff } }' +
        '@container (min-width: 12.5em) { .e { color: #0000ff } }' +
        '.u { width: 50cqw; height: 1px }' +
        '</style><div class="c" style="font-size: 16px"><p class="a" id="a">a</p>' +
        '<p class="b" id="b">b</p><p class="e" id="e">e</p>' +
        '<div class="u" id="u"></div></div>',
    );
    const el = view(node);
    assert.strictEqual(colorOf(el, 'a'), BLUE);
    assert.notStrictEqual(colorOf(el, 'b'), BLUE);
    assert.strictEqual(colorOf(el, 'e'), BLUE);
    // logical, as `elementRect` answers
    assert.strictEqual(el.elementRect(findById(el.document, 'u')!)!.width, 100);
  },
);
