// `<Html>`'s cascade hands one computed style to every element that must
// compute the same one (`Cascade.sharedStyleFor`). What that promises is
// checked against the cascade without it: the same document built twice,
// once with sharing and once with every style computed on its own, has to
// come out with the same style on every box. The document is chosen to have
// what sharing keys on — repeated shapes, ancestry, attributes, inline
// styles, flex parents, a table's cellpadding, the pointer — and what it must
// not share under: rules that read siblings, position or contents, including
// the ones css-select spells under other names.
import { test } from 'node:test';
import assert from 'node:assert';
import type { Element } from 'domhandler';

import { Cascade } from '../src/html/css/cascade.js';
import { parseStylesheet } from '../src/html/css/parse.js';
import type { ComputedStyle, RootLook } from '../src/html/css/style.js';
import { uaStylesheet } from '../src/html/css/ua.js';
import { HtmlSource } from '../src/html/dom.js';
import { buildBoxes } from '../src/html/layout/boxes.js';
import type { Box } from '../src/html/layout/boxes.js';

const LOOK: RootLook = {
  color: '#1d1d1f',
  fontFamily: 'sans-serif',
  fontSize: 14,
  monoFamily: 'monospace',
  linkColor: '#0a64c8',
  borderColor: '#d0d0d6',
  mutedColor: '#6e6e73',
  background: '#ffffff',
  colorScheme: 'light',
  surface: '#f5f5f7',
  controlPadY: 4,
  controlBorder: 1,
  controlRadius: 4,
};

const SHEET = `
body { font-size: 15px; }
h2 { font-size: 1.4em; margin: 1em 0 0.5em; }
.note p { color: #b00; }
ul > li { margin: 2px 0; }
a[href^="https"] { text-decoration: underline; }
code { font-family: monospace; font-size: 0.9em; }
div[data-kind=card] { padding: 8px; border: 1px solid #ccc; }
tr:hover td { background-color: #ffe; }
li:first-child { color: #070; }
p + p { text-indent: 2em; }
tr:nth-child(odd) td { background-color: #f4f4f4; }
div:empty { height: 3px; }
h2 ~ ul { margin-left: 12px; }
section:has(img) { border: 1px solid #333; }
b:contains(dropped) { color: #a00; }
a:hover { color: #c00; }
section:hover h2 { color: #00c; }
span.tag:parent { padding: 1px 4px; }
`;

/** A document of repeated shapes, with every kind of difference in it. */
function documentHtml(): string {
  const parts: string[] = [];
  for (let i = 0; i < 12; i++) {
    parts.push(
      `<section><h2>Section ${i}</h2>` +
        `<p>First paragraph with <code>code</code> and <a href="https://x.test/${i}">a link</a>.</p>` +
        `<p>Second paragraph, <strong>bold</strong> and <em>italic</em>.</p>` +
        `<p style="margin: 1em 0">Inline-styled, <span style="font-size: 2em">big <code>code</code></span>.</p>` +
        `<ul><li>one</li><li>two <ul><li>nested</li><li>again</li></ul></li><li>three</li></ul>` +
        (i % 3 === 0
          ? '<div class="note"><p>Noted.</p><p>Twice.</p></div>'
          : '') +
        (i % 4 === 0
          ? '<img src="x.png" width="20" height="10" alt="i">'
          : '') +
        `<div data-kind="card" style="display: flex"><p>flex child</p><span>inline in flex</span><div></div></div>` +
        `<table cellpadding="${3 + (i % 2)}" border="1"><tr><td align="right">a</td><td>b</td></tr><tr><td>c</td><td valign="top">d</td></tr><tr><td>e</td><td>f</td></tr></table>` +
        `<p><font color="#036" size="4" face="serif">font</font> <a href="http://y.test">plain link</a></p>` +
        `<div><b>kept</b> <b>dropped</b> <span class="tag"></span><span class="tag">tag</span></div>` +
        `</section>`,
    );
  }
  return `<html><head><style>${SHEET}</style></head><body>${parts.join('')}</body></html>`;
}

function parse(html: string) {
  const source = new HtmlSource();
  source.setSource(html, true);
  return source.document;
}

function cascadeFor(pointer?: { hovered: Element[] }): Cascade {
  const cascade = new Cascade(
    [uaStylesheet(LOOK), parseStylesheet(SHEET, 0)],
    LOOK,
    800,
    600,
    1,
  );
  if (pointer) {
    cascade.setPointer({
      hovered: new Set(pointer.hovered),
      active: new Set(),
    });
  }
  return cascade;
}

function build(doc: ReturnType<typeof parse>, cascade: Cascade) {
  return buildBoxes(doc, {
    cascade,
    scale: 1,
    imageSize: () => null,
    controlSize: () => ({ width: 10, height: 10 }),
  });
}

/** The same build with every style computed on its own: what sharing has
 *  to be indistinguishable from. */
function buildUnshared(doc: ReturnType<typeof parse>, cascade: Cascade) {
  const proto = Cascade.prototype as unknown as {
    sharedStyleFor: Cascade['sharedStyleFor'];
  };
  const shared = proto.sharedStyleFor;
  let next = 1_000_000;
  proto.sharedStyleFor = function (
    this: Cascade,
    el,
    parentStyle,
    _key,
    inFlex,
  ) {
    return { style: this.styleFor(el, parentStyle, inFlex), key: next++ };
  };
  try {
    return build(doc, cascade);
  } finally {
    proto.sharedStyleFor = shared;
  }
}

function* boxes(box: Box): Generator<Box> {
  yield box;
  for (const child of box.children) yield* boxes(child);
}

function assertSameStyles(
  a: ReturnType<typeof build>,
  b: ReturnType<typeof build>,
): number {
  const left = [...boxes(a.root)];
  const right = [...boxes(b.root)];
  assert.strictEqual(left.length, right.length, 'the same boxes');
  for (let i = 0; i < left.length; i++) {
    assert.strictEqual(left[i].kind, right[i].kind, `box ${i}'s kind`);
    assert.deepStrictEqual(
      left[i].style,
      right[i].style,
      `box ${i} (<${left[i].el?.name ?? left[i].kind}>) has the style it computes alone`,
    );
  }
  return left.length;
}

function elementsNamed(doc: ReturnType<typeof parse>, name: string): Element[] {
  const out: Element[] = [];
  const walk = (node: { children?: unknown[] }): void => {
    for (const child of (node.children ?? []) as Element[]) {
      if (child.type === 'tag' && child.name === name) out.push(child);
      walk(child as unknown as { children?: unknown[] });
    }
  };
  walk(doc as unknown as { children?: unknown[] });
  return out;
}

test('a shared style is the style the element computes alone', () => {
  const doc = parse(documentHtml());
  const count = assertSameStyles(
    build(doc, cascadeFor()),
    buildUnshared(doc, cascadeFor()),
  );
  assert.ok(count > 500, `a document of ${count} boxes`);
});

test('under the pointer, too: a hovered row and the rows around it', () => {
  const doc = parse(documentHtml());
  const rows = elementsNamed(doc, 'tr');
  const hovered = [rows[4], rows[4].parent as Element];
  const shared = build(doc, cascadeFor({ hovered }));
  assertSameStyles(shared, buildUnshared(doc, cascadeFor({ hovered })));
  // and the hover did reach its row's cells, and only its row's
  const cells = [...boxes(shared.root)].filter((b) => b.el?.name === 'td');
  const byRow = new Map<Element, ComputedStyle[]>();
  for (const cell of cells) {
    const row = cell.el!.parent as Element;
    byRow.set(row, [...(byRow.get(row) ?? []), cell.style]);
  }
  const colour = (row: Element) => byRow.get(row)![0].backgroundColor;
  assert.notStrictEqual(
    colour(rows[4]),
    colour(rows[7]),
    'the row under the pointer',
  );
  assert.strictEqual(
    colour(rows[7]),
    colour(rows[10]),
    'two rows away from it',
  );
});

test('under the pointer: a hovered link, and a heading under a hovered section', () => {
  // Two things only the key can tell apart, since neither element matches
  // anything a rule makes it compute alone: a link whose own state a rule
  // reads, and a heading whose section's state one does.
  const doc = parse(documentHtml());
  const links = elementsNamed(doc, 'a').filter(
    (a) => a.attribs.href === 'http://y.test',
  );
  const chain = (el: Element): Element[] => {
    const out: Element[] = [];
    for (let n: Element | null = el; n && n.type === 'tag';) {
      out.push(n);
      n = n.parent as Element | null;
    }
    return out;
  };
  const hovered = chain(links[3]);
  const shared = build(doc, cascadeFor({ hovered }));
  assertSameStyles(shared, buildUnshared(doc, cascadeFor({ hovered })));
  const styleOf = (el: Element) =>
    [...boxes(shared.root)].find((b) => b.el === el)!.style;
  assert.notStrictEqual(styleOf(links[3]).color, styleOf(links[2]).color);
  assert.strictEqual(styleOf(links[2]).color, styleOf(links[5]).color);
  const headings = elementsNamed(doc, 'h2');
  assert.notStrictEqual(styleOf(headings[3]).color, styleOf(headings[2]).color);
  assert.strictEqual(styleOf(headings[2]).color, styleOf(headings[5]).color);
});

test('a long document computes a style per kind of element, not per element', () => {
  const doc = parse(documentHtml());
  const cascade = cascadeFor();
  // every style computed, shared or not, is computed here
  const inner = cascade as unknown as {
    _computeStyle: (...args: unknown[]) => ComputedStyle;
  };
  const compute = inner._computeStyle;
  let computed = 0;
  inner._computeStyle = function (this: Cascade, ...args: unknown[]) {
    computed++;
    return compute.apply(this, args);
  };
  const tree = build(doc, cascade);
  const elements = [...boxes(tree.root)].filter(
    (b) => b.el && b.kind !== 'text',
  );
  assert.ok(
    computed < elements.length / 3,
    `${computed} styles computed for ${elements.length} element boxes`,
  );
});

test('a rule that reads siblings, position or contents keeps its elements to their own styles', () => {
  const doc = parse(documentHtml());
  const tree = build(doc, cascadeFor());
  const styleOf = (el: Element) =>
    [...boxes(tree.root)].find((b) => b.el === el)!.style;
  // `li:first-child`: the first item of every list, and no other
  const items = elementsNamed(doc, 'li');
  const firsts = items.filter(
    (li) =>
      (li.parent as Element).children.find((c) => c.type === 'tag') === li,
  );
  const others = items.filter((li) => !firsts.includes(li));
  assert.ok(firsts.length > 0 && others.length > 0);
  const green = styleOf(firsts[0]).color;
  for (const li of firsts) assert.strictEqual(styleOf(li).color, green);
  for (const li of others) assert.notStrictEqual(styleOf(li).color, green);
  // `p + p`: a paragraph after a paragraph, not the first of a run
  const paragraphs = elementsNamed(doc, 'p');
  const indents = new Set(
    paragraphs.map((p) => JSON.stringify(styleOf(p).textIndent)),
  );
  assert.ok(indents.size > 1, 'some paragraphs are indented and some are not');
  // `section:has(img)`: every fourth section has the image, and the border
  const sections = elementsNamed(doc, 'section');
  const bordered = sections.map((s) => styleOf(s).borderTopWidth);
  assert.notStrictEqual(bordered[0], bordered[1]);
  assert.strictEqual(bordered[0], bordered[4]);
  // css-select's own names for contents: `:contains()` and `:parent`
  const [kept, dropped] = elementsNamed(doc, 'b');
  assert.notStrictEqual(styleOf(kept).color, styleOf(dropped).color);
  const [empty, full] = elementsNamed(doc, 'span').filter(
    (el) => el.attribs.class === 'tag',
  );
  assert.notStrictEqual(
    JSON.stringify(styleOf(empty).paddingLeft),
    JSON.stringify(styleOf(full).paddingLeft),
  );
});
