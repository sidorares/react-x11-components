// <Html> — declarative shadow DOM: a `<template shadowrootmode>` is its
// host's shadow tree, drawn in the host's place with the host's own children
// in its slots, and styled by its own sheets, `:host`, `::slotted()` and
// `::part()` at its edges.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import type { Element } from 'domhandler';
import {
  HtmlSource,
  appendChild,
  attachShadow,
  createElement,
  createText,
  flatChildrenOf,
  parseFragment,
  shadowRootOf,
} from '../../src/html/dom.js';
import type { HtmlViewNode } from '../../src/html/index.js';
import { boxOf, documentText, metric, render, view } from './harness.js';

afterEach(cleanup);

/** An element's computed style, by its id, wherever its tree is. */
function styleOf(el: HtmlViewNode, id: string): Record<string, unknown> {
  return (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
}

/** Whether an element with the id made a box. */
function drawn(el: HtmlViewNode, id: string): boolean {
  type B = { el: { attribs: Record<string, string> } | null; children: B[] };
  const find = (box: B): boolean =>
    box.el?.attribs.id === id || box.children.some(find);
  return find((el as unknown as { _tree: { root: B } })._tree.root);
}

/** The element with an id, in the document or in any shadow tree in it. */
function deepById(node: unknown, id: string): Element | null {
  const n = node as Element;
  if (n.attribs?.id === id) return n;
  const shadow = n.attribs ? shadowRootOf(n) : null;
  for (const child of [...(shadow?.children ?? []), ...(n.children ?? [])]) {
    const found = deepById(child, id);
    if (found) return found;
  }
  return null;
}

test("a <template shadowrootmode> is its host's shadow root, in no tree", () => {
  const source = new HtmlSource();
  source.setSource(
    '<div id="host">a<template shadowrootmode="open"><p>in</p></template>' +
      '<b>b</b></div><x-card><template shadowrootmode="CLOSED">' +
      'shut</template></x-card>',
    true,
  );
  const [host, card] = source.document.children as Element[];
  // the host's children are its own, and the template is in neither tree
  assert.deepStrictEqual(
    host.children.map((c) => (c as Element).name ?? 'text'),
    ['text', 'b'],
  );
  const root = shadowRootOf(host)!;
  assert.strictEqual(root.mode, 'open');
  assert.strictEqual(root.host, host);
  assert.strictEqual((root.children[0] as Element).name, 'p');
  assert.strictEqual(root.children[0].parent, root);
  // the keyword is ASCII case-insensitive, and a closed root is reachable
  assert.strictEqual(shadowRootOf(card)!.mode, 'closed');
  assert.strictEqual(card.children.length, 0);
});

test('a second shadow root, one an element cannot host and one in a fragment stay templates', () => {
  const source = new HtmlSource();
  source.setSource(
    '<div><template shadowrootmode="open">one</template>' +
      '<template shadowrootmode="open">two</template></div>' +
      '<ul><li><template shadowrootmode="open">x</template></li></ul>' +
      '<div><template shadowrootmode="sideways">y</template></div>',
    true,
  );
  const [div, ul, other] = source.document.children as Element[];
  assert.deepStrictEqual(
    div.children.map((c) => (c as Element).name),
    ['template'],
  );
  const li = ul.children[0] as Element;
  assert.strictEqual(shadowRootOf(li), null);
  assert.strictEqual((li.children[0] as Element).name, 'template');
  assert.strictEqual(shadowRootOf(other), null);
  // parsed as `innerHTML` parses, which attaches none
  const [fragment] = parseFragment(
    '<div><template shadowrootmode="open">z</template></div>',
  ) as Element[];
  assert.strictEqual(shadowRootOf(fragment), null);
  assert.strictEqual((fragment.children[0] as Element).name, 'template');
});

test('a streamed shadow root holds what has arrived, and the same root grows', () => {
  const source = new HtmlSource();
  source.setSource('<div><template shadowrootmode="open"><p>one</p>', false);
  const host = source.document.children[0] as Element;
  const root = shadowRootOf(host)!;
  assert.strictEqual(root.children.length, 1);
  source.setSource(
    '<div><template shadowrootmode="open"><p>one</p><p>two</p></template>' +
      'light</div>',
    true,
  );
  assert.strictEqual(shadowRootOf(host), root);
  assert.strictEqual(root.children.length, 2);
  assert.strictEqual(host.children.length, 1);
});

test('a host draws its shadow tree, with its children in the slots that name them', async () => {
  // the light children in the order they are in, whichever slot comes first
  const text = await documentText(
    '<div>A<span slot="x">X</span><b>B</b><template shadowrootmode="open">' +
      '<p>[<slot name="x"></slot>]</p><p>(<slot></slot>)</p></template>' +
      '</div><p>after</p>',
  );
  assert.strictEqual(text, '[X](AB)after');
});

test('a slot draws its own content where nothing is assigned to it, and a child no slot takes is drawn nowhere', async () => {
  const { node } = await render(
    '<div><span slot="nowhere" id="gone">gone</span>' +
      '<template shadowrootmode="open"><slot name="a">fall<i id="f">back</i>' +
      '</slot></template></div>',
  );
  const el = view(node);
  assert.strictEqual(
    (el as unknown as { _tree: { text: string } })._tree.text,
    'fallback',
  );
  assert.ok(drawn(el, 'f'));
  assert.ok(!drawn(el, 'gone'));
});

test("a shadow tree's sheets style it, and the page's style what is outside it", async () => {
  const { node } = await render(
    '<style>p { color: #0000ff } .c { font-weight: 700 }</style>' +
      '<div><p id="light">light</p><template shadowrootmode="open">' +
      '<style>p { color: #00ff00 }</style><p id="inner" class="c">in</p>' +
      '<slot></slot></template></div><p id="outside">out</p>',
  );
  const el = view(node);
  assert.strictEqual(styleOf(el, 'inner').color, '#00ff00');
  // a class the page styles is the page's class, and not in the tree
  assert.strictEqual(styleOf(el, 'inner').fontWeight, 400);
  // a light child assigned to a slot is the page's, wherever it is drawn
  assert.strictEqual(styleOf(el, 'light').color, '#0000ff');
  assert.strictEqual(styleOf(el, 'outside').color, '#0000ff');
});

test('what is drawn inherits through the flat tree', async () => {
  const { node } = await render(
    '<div id="host" style="color: #ff0000; font-size: 20px">' +
      '<i id="slotted">slotted</i><template shadowrootmode="open">' +
      '<style>slot { color: #00ff00 }</style><b id="top">top</b>' +
      '<slot></slot></template></div>',
  );
  const el = view(node);
  // the top of the tree from the host, and an assigned child from its slot
  assert.strictEqual(styleOf(el, 'top').color, '#ff0000');
  assert.strictEqual(styleOf(el, 'slotted').color, '#00ff00');
  assert.strictEqual(styleOf(el, 'slotted').fontSize, 20);
});

test(':host, :host() and :host-context() style the host from inside', async () => {
  const shadow =
    '<template shadowrootmode="open"><style>' +
    ':host { display: block; margin-left: 5px }' +
    ':host(.wide) { padding-left: 7px }' +
    ':host-context(.dark) { color: #00ff00 }' +
    ':host::before { content: "H" }' +
    '</style>x</template>';
  const { node } = await render(
    `<x-card id="a">${shadow}</x-card>` +
      `<section class="dark"><x-card id="b" class="wide">${shadow}</x-card>` +
      '</section>',
  );
  const el = view(node);
  assert.strictEqual(styleOf(el, 'a').display, 'block');
  assert.strictEqual(styleOf(el, 'a').marginLeft, 5);
  assert.strictEqual(styleOf(el, 'a').paddingLeft, 0);
  assert.strictEqual(styleOf(el, 'b').paddingLeft, 7);
  assert.strictEqual(styleOf(el, 'b').color, '#00ff00');
  assert.notStrictEqual(styleOf(el, 'a').color, '#00ff00');
  assert.strictEqual(await documentText(`<x-card>${shadow}</x-card>`), 'Hx');
});

test("the page's rules outrank the host's :host rules, and the host's !important ones outrank the page's", async () => {
  // CSS Cascade 5, 6.1: context before specificity, reversed for important
  const { node } = await render(
    '<style>x-a { color: #0000ff } x-a { font-weight: 300 !important }</style>' +
      '<x-a id="h" class="k" style="margin-left: 3px">' +
      '<template shadowrootmode="open"><style>' +
      ':host(#h.k) { color: #ff0000; margin-left: 9px }' +
      ':host { font-weight: 800 !important }' +
      '</style>x</template></x-a>' +
      '<p id="p" align="right"><template shadowrootmode="open"><style>' +
      ':host { text-align: left }</style>x</template></p>',
  );
  const el = view(node);
  assert.strictEqual(styleOf(el, 'h').color, '#0000ff');
  assert.strictEqual(styleOf(el, 'h').fontWeight, 800);
  // the host's `style` is the page's, and over its `:host` rules
  assert.strictEqual(styleOf(el, 'h').marginLeft, 3);
  // a presentational hint is under every author rule, as in Chrome
  assert.strictEqual(styleOf(el, 'p').textAlign, 'left');
});

test("a shadow tree's rules reach past its top only through :host", async () => {
  const { node } = await render(
    '<x-a class="on"><template shadowrootmode="open"><style>' +
      ':host(.on) > .a { color: #00ff00 }' +
      ':host .b { color: #00ff00 }' +
      ':host(.off) .c { color: #ff0000 }' +
      '* > .d { color: #ff0000 }' +
      ':host + .e, .x :host .e { color: #ff0000 }' +
      '</style><b id="a" class="a">a</b><i><b id="nested" class="a">n</b></i>' +
      '<i><b id="b" class="b">b</b></i><b id="c" class="c">c</b>' +
      '<b id="d" class="d">d</b><b id="e" class="e">e</b></template></x-a>',
  );
  const el = view(node);
  assert.strictEqual(styleOf(el, 'a').color, '#00ff00');
  // a child of the host is at the top of the tree, and only there
  assert.notStrictEqual(styleOf(el, 'nested').color, '#00ff00');
  assert.strictEqual(styleOf(el, 'b').color, '#00ff00');
  for (const id of ['c', 'd', 'e']) {
    assert.notStrictEqual(styleOf(el, id).color, '#ff0000', id);
  }
});

test("::slotted() styles what is assigned to a slot, under the page's rules", async () => {
  const { node } = await render(
    '<style>.page { color: #0000ff }</style>' +
      '<x-a><b id="one">1</b><b id="two" class="page">2</b>' +
      '<span id="three" slot="s">3</span><i><b id="deep">d</b></i>' +
      '<template shadowrootmode="open"><style>' +
      '::slotted(b) { color: #00ff00 }' +
      'slot[name=s]::slotted(*) { font-weight: 700 }' +
      '::slotted(span)::after { content: "!" }' +
      '</style><slot></slot><slot name="s"></slot></template></x-a>',
  );
  const el = view(node);
  assert.strictEqual(styleOf(el, 'one').color, '#00ff00');
  // the page's normal rules outrank the tree's, whatever the specificity
  assert.strictEqual(styleOf(el, 'two').color, '#0000ff');
  assert.strictEqual(styleOf(el, 'three').fontWeight, 700);
  // what is in an assigned element is not itself assigned
  assert.notStrictEqual(styleOf(el, 'deep').color, '#00ff00');
  assert.ok(
    (el as unknown as { _tree: { text: string } })._tree.text.includes('3!'),
  );
});

test("::part() reaches a shadow tree's parts from outside, over the tree's own rules", async () => {
  const { node } = await render(
    '<style>' +
      'x-outer::part(label) { color: #00ff00 }' +
      'x-outer::part(inner-label) { font-weight: 700 }' +
      'x-outer::part(hidden) { color: #ff0000 }' +
      '</style>' +
      '<x-outer><template shadowrootmode="open"><style>' +
      '[part] { color: #0000ff }' +
      ':host::part(label) { text-decoration: underline }' +
      '</style><b id="label" part="label" style="color: #ffff00">l</b>' +
      '<x-inner exportparts="label: inner-label"><template ' +
      'shadowrootmode="open"><b id="inner" part="label">i</b>' +
      '<b id="hidden" part="hidden">h</b></template></x-inner>' +
      '</template></x-outer>',
  );
  const el = view(node);
  // the page's rule over the tree's, and over the part's own `style`
  assert.strictEqual(styleOf(el, 'label').color, '#00ff00');
  assert.ok(styleOf(el, 'label').underline, 'the tree styles its own parts');
  // a part of a tree inside is the page's by the name it is exported as
  assert.strictEqual(styleOf(el, 'inner').fontWeight, 700);
  assert.notStrictEqual(styleOf(el, 'inner').color, '#00ff00');
  // and one not exported is not
  assert.notStrictEqual(styleOf(el, 'hidden').color, '#ff0000');
});

test('a name in animation-name is looked for in the tree whose rule named it, then the trees around it', async () => {
  const anim = (id: string) =>
    `<div id="${id}" class="anim" style="animation-fill-mode: both"></div>`;
  const { node } = await render(
    '<style>' +
      '@keyframes doc { from, to { background-color: #00ff00 } }' +
      '@keyframes same { from, to { background-color: #0000ff } }' +
      '#outer::part(p) { animation-name: same; animation-duration: 1s }' +
      '#doc-inner { animation: inner 1s both }' +
      '</style>' +
      anim('doc-inner') +
      '<div id="outer"><template shadowrootmode="open"><style>' +
      '@keyframes same { from, to { background-color: #ff0000 } }' +
      '@keyframes inner { from, to { background-color: #00ffff } }' +
      '.anim { animation-duration: 1s }' +
      '#own { animation-name: same } #up { animation-name: doc }' +
      '</style><div id="own" class="anim" style="animation-fill-mode: both">' +
      '</div><div id="up" class="anim" style="animation-fill-mode: both">' +
      '</div><div id="part" part="p" style="animation-fill-mode: both">' +
      '</div></template></div>',
    400,
    { animate: false },
  );
  const el = view(node);
  const background = (id: string) => styleOf(el, id).backgroundColor;
  // its own tree's, over the page's of the same name
  assert.strictEqual(background('own'), '#ff0000');
  // the page's, found from inside
  assert.strictEqual(background('up'), '#00ff00');
  // a `::part()` rule of the page's names the page's
  assert.strictEqual(background('part'), '#0000ff');
  // and the page never finds a shadow tree's
  assert.notStrictEqual(background('doc-inner'), '#00ffff');
});

test('what a shadow tree holds is asked for, and its linked sheets style it alone', async () => {
  const asked: string[] = [];
  const { node } = await render(
    '<p id="outside">out</p><div><template shadowrootmode="open">' +
      '<link rel="stylesheet" href="inner.css"><img src="inner.png">' +
      '<p id="inside">in</p></template></div>',
    400,
    {
      onResource: (r: { url: string; kind: string }) => {
        asked.push(r.url);
        return r.kind === 'stylesheet'
          ? { kind: 'stylesheet', text: 'p { color: #00ff00 }' }
          : null;
      },
    },
  );
  await act();
  const el = view(node);
  assert.deepStrictEqual(asked.sort(), ['inner.css', 'inner.png']);
  assert.strictEqual(styleOf(el, 'inside').color, '#00ff00');
  assert.notStrictEqual(styleOf(el, 'outside').color, '#00ff00');
});

test("a shadow tree's sheet applies where its media holds", async () => {
  const { node } = await render(
    '<div><template shadowrootmode="open">' +
      '<style media="print">p { color: #ff0000 }</style>' +
      '<style media="(min-width: 2000px)">p { font-weight: 700 }</style>' +
      '<style media="screen and (min-width: 100px)">p { color: #00ff00 }</style>' +
      '<p id="p">x</p></template></div>',
  );
  const el = view(node);
  assert.strictEqual(styleOf(el, 'p').color, '#00ff00');
  assert.strictEqual(styleOf(el, 'p').fontWeight, 400);
});

test("a <title>, a <base> and a sheet in a shadow tree are not the document's", () => {
  const source = new HtmlSource();
  source.setSource(
    '<div><template shadowrootmode="open"><title>inner</title>' +
      '<base href="https://inner.example/"><style>p {}</style>' +
      '<script src="inner.js"></script></template></div><title>outer</title>',
    true,
  );
  const facts = source.facts();
  assert.strictEqual(facts.title, 'outer');
  assert.strictEqual(facts.base, null);
  assert.strictEqual(facts.sheets.length, 0);
  assert.strictEqual(facts.shadows.length, 1);
  assert.strictEqual(facts.shadows[0].sheets.length, 1);
  // a script is a script wherever it is, for the seam
  assert.strictEqual(facts.scripts.length, 1);
});

test(':has-slotted matches a slot something is assigned to, white space too', async () => {
  const shadow =
    '<template shadowrootmode="open"><style>' +
    'slot { display: block; color: #ff0000 } :has-slotted { color: #00ff00 }' +
    '</style><slot id="SLOT"></slot></template>';
  const { node } = await render(
    `<div id="a">${shadow.replace('SLOT', 'filled')}<b>x</b></div>` +
      `<div id="b">${shadow.replace('SLOT', 'empty')}</div>` +
      `<div id="c"> ${shadow.replace('SLOT', 'spaced')}</div>`,
  );
  const el = view(node);
  assert.strictEqual(styleOf(el, 'filled').color, '#00ff00');
  assert.strictEqual(styleOf(el, 'empty').color, '#ff0000');
  assert.strictEqual(styleOf(el, 'spaced').color, '#00ff00');
});

test(":lang() in a shadow tree reads its host's language", async () => {
  const { node } = await render(
    '<div lang="fr"><template shadowrootmode="open"><style>' +
      'b:lang(fr) { color: #00ff00 }</style><b id="b">x</b></template></div>',
  );
  assert.strictEqual(styleOf(view(node), 'b').color, '#00ff00');
});

test('an application attaches a shadow root, and refresh draws it', async () => {
  const { node } = await render('<div id="host"><b id="light">light</b></div>');
  const el = view(node);
  const host = deepById(el.document, 'host')!;
  const root = attachShadow(host, { mode: 'open' })!;
  assert.ok(root);
  // one is all an element can host
  assert.strictEqual(attachShadow(host, { mode: 'open' }), null);
  appendChild(root, createText('['));
  appendChild(root, createElement('slot'));
  appendChild(root, createText(']'));
  assert.deepStrictEqual(
    flatChildrenOf(root.children[1]).map((n) => (n as Element).name),
    ['b'],
  );
  // what `handle.refresh()` calls
  el.touchDocument();
  await act();
  assert.strictEqual(
    (el as unknown as { _tree: { text: string } })._tree.text,
    '[light]',
  );
});

metric(
  'the pointer over a shadow tree hovers its host and its slot',
  async () => {
    const { node } = await render(
      '<style>x-a:hover { color: #00ff00 } b:hover { font-weight: 700 }</style>' +
        '<x-a id="host"><b id="light">light</b><template shadowrootmode="open">' +
        '<style>:host(:hover) { text-decoration: underline }' +
        'slot:hover { font-style: italic }</style>' +
        '<p id="top">top</p><slot></slot></template></x-a>',
    );
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    // where an element is drawn, in a shadow tree or assigned to a slot
    const at = (id: string): [number, number] => {
      const rect = el.elementRect(deepById(el.document, id)!)!;
      return [abs.x + rect.x + 2, abs.y + rect.y + rect.height / 2];
    };
    el.setHover(...at('top'));
    await act();
    assert.strictEqual(styleOf(el, 'host').color, '#00ff00');
    assert.ok(styleOf(el, 'host').underline, ':host(:hover)');
    el.setHover(...at('light'));
    await act();
    // through the slot it is drawn in, which inherits it on
    assert.strictEqual(styleOf(el, 'light').fontWeight, 700);
    assert.strictEqual(styleOf(el, 'light').fontStyle, 'italic');
    assert.strictEqual(styleOf(el, 'host').color, '#00ff00');
    el.clearHover();
    await act();
    assert.notStrictEqual(styleOf(el, 'host').color, '#00ff00');
  },
);
