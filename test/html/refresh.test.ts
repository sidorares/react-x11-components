// <Html> — a refresh told what changed: what a selector that tests the
// change can reach is styled again, and nothing else is.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup } from 'react-x11/test';
import { Comment, Document } from 'domhandler';
import * as DomUtils from 'domutils';
import {
  appendChild,
  createHtmlElement as createElement,
  createText,
  removeNode,
} from '../../src/html/index.js';
import type {
  ChildNode,
  Element,
  HtmlChange,
  HtmlViewNode,
} from '../../src/html/index.js';
import {
  FONTS,
  bytesApart,
  findById,
  metric,
  rebuilt,
  render,
  snapshot,
  treeOf,
  view,
} from './harness.js';

afterEach(cleanup);

/** How many styles the cascade works out while `run` runs. */
async function stylesComputed(
  el: HtmlViewNode,
  run: () => unknown,
): Promise<number> {
  const cascade = (el as unknown as { _cascade: Record<string, unknown> })
    ._cascade;
  const compute = cascade._computeStyle as (...args: unknown[]) => unknown;
  let n = 0;
  cascade._computeStyle = function (this: unknown, ...args: unknown[]) {
    n += 1;
    return compute.apply(this, args);
  };
  try {
    await run();
  } finally {
    delete cascade._computeStyle;
  }
  return n;
}

/** The repaints `run` asks for: rects, and the element itself for all of
 *  it. */
async function damageOf(el: HtmlViewNode, run: () => unknown) {
  const damage: unknown[] = [];
  const invalidate = el.invalidate.bind(el);
  el.invalidate = ((layout?: boolean, rect?: unknown, reason?: string) => {
    damage.push(rect);
    return invalidate(layout, rect as never, reason);
  }) as typeof el.invalidate;
  try {
    await run();
  } finally {
    delete (el as { invalidate?: unknown }).invalidate;
  }
  return damage;
}

const byId = (el: HtmlViewNode, id: string) =>
  findById(el.document, id) as unknown as Element;

/** A class set on an element, with the record a `MutationObserver` keeps. */
function setClass(target: Element, value: string): HtmlChange {
  const oldValue = target.attribs.class ?? null;
  target.attribs.class = value;
  return { type: 'attributes', target, attributeName: 'class', oldValue };
}

metric(
  'a class that changes only ink is restyled in place, one element of a long document',
  async () => {
    const paragraphs = Array.from(
      { length: 400 },
      (_, i) => `<p id="p${i}">Paragraph ${i}, long enough to wrap once.</p>`,
    ).join('');
    const { result, node } = await render(
      '<style>body{margin:0} p{margin:0} .on{color:#ff0000}</style>' +
        paragraphs,
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const tree = treeOf(el);
    let damage: unknown[] = [];
    const computed = await stylesComputed(el, async () => {
      damage = await damageOf(el, () =>
        el.touchDocument([setClass(byId(el, 'p7'), 'on')]),
      );
    });
    assert.ok(treeOf(el) === tree, 'the boxes were built again');
    assert.ok(computed > 0 && computed < 5, `${computed} styles worked out`);
    assert.ok(damage.length > 0 && !damage.includes(el), 'all of it repainted');
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

test('an attribute set to what it was, or set and set back, restyles nothing', async () => {
  const { result, node } = await render(
    '<style>body{margin:0} [class*=on]{color:#ff0000} .open{display:none}</style>' +
      '<div id="a" class="on" style="--gap: 0px">a</div><p id="b">b</p>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const tree = treeOf(el);
  const a = byId(el, 'a');
  const style = (value: string): HtmlChange => {
    const oldValue = a.attribs.style ?? null;
    a.attribs.style = value;
    return { type: 'attributes', target: a, attributeName: 'style', oldValue };
  };
  const b = byId(el, 'b');
  // a page's frame that writes what is there: the same class, the same
  // custom property, and a class put on and taken off again
  const changes = [setClass(a, 'on'), style('--gap: 0px'), setClass(b, 'open')];
  changes.push({
    type: 'attributes',
    target: b,
    attributeName: 'class',
    oldValue: b.attribs.class,
  });
  delete b.attribs.class;
  let damage: unknown[] = [];
  const computed = await stylesComputed(el, async () => {
    damage = await damageOf(el, async () => {
      el.touchDocument(changes);
      await snapshot(result, el);
    });
  });
  assert.strictEqual(computed, 0, `${computed} styles worked out`);
  assert.ok(treeOf(el) === tree, 'the boxes were built again');
  assert.deepStrictEqual(damage, [], 'something was repainted');
  // and one that does change is still told
  el.touchDocument([setClass(b, 'open')]);
  await snapshot(result, el);
  assert.ok(treeOf(el) !== tree, 'a box that went is still drawn');
});

metric(
  'a class that moves something builds the boxes again, styling only what it reaches',
  async () => {
    const menus = Array.from(
      { length: 100 },
      (_, i) =>
        `<div class="menu" id="m${i}"><b>Menu ${i}</b>` +
        '<ul><li>one</li><li>two</li></ul></div>',
    ).join('');
    const { result, node } = await render(
      '<style>body{margin:0} ul{display:none;margin:0}' +
        ' .menu.open > ul{display:block}</style>' +
        menus,
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const tree = treeOf(el);
    const computed = await stylesComputed(el, async () => {
      el.touchDocument([setClass(byId(el, 'm3'), 'menu open')]);
      await snapshot(result, el);
    });
    assert.ok(treeOf(el) !== tree, 'a box appeared without a build');
    // the menu, its heading, its list and the list's two items
    assert.ok(computed > 0 && computed < 12, `${computed} styles worked out`);
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'an inline style that moves a box out of the flow repaints where it was and is',
  async () => {
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) => `<p>Paragraph ${i}</p>`,
    ).join('');
    const { result, node } = await render(
      '<style>body{margin:0;position:relative} p{margin:0}</style>' +
        '<div id="dot" style="position:absolute;left:10px;top:10px;' +
        'width:20px;height:20px;background:#ff0000"></div>' +
        paragraphs,
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const dot = byId(el, 'dot');
    const damage = await damageOf(el, () => {
      const oldValue = dot.attribs.style;
      dot.attribs.style = oldValue.replace('left:10px', 'left:120px');
      el.touchDocument([
        { type: 'attributes', target: dot, attributeName: 'style', oldValue },
      ]);
    });
    assert.ok(damage.length > 0, 'nothing repainted');
    assert.ok(!damage.includes(el), 'the whole document repainted');
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'a change nothing tests, under an element nothing draws, or of a comment restyles nothing',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} [data-on]{color:#ff0000}</style>' +
        '<p id="a">a</p><div id="hidden" style="display:none">' +
        '<p id="b" class="x">b</p></div><p id="c">c</p>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const tree = treeOf(el);
    const a = byId(el, 'a');
    const b = byId(el, 'b');
    const damage = await damageOf(el, () => {
      a.attribs['data-other'] = '1';
      b.attribs['data-on'] = '';
      const note = new Comment('x');
      appendChild(a, note);
      el.touchDocument([
        { type: 'attributes', target: a, attributeName: 'data-other' },
        { type: 'attributes', target: b, attributeName: 'data-on' },
        { type: 'childList', target: a, addedNodes: [note], removedNodes: [] },
      ]);
    });
    // a count: a failure would print the element it repainted, cycles and all
    assert.strictEqual(damage.length, 0, `${damage.length} repaints`);
    assert.ok(treeOf(el) === tree, 'built again');
  },
);

metric(
  'a list item added restyles the items a :last-child read, and draws as a build does',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} li{color:#000000} li:last-child{color:#ff0000}' +
        ' li:first-child + li{font-weight:bold}</style>' +
        '<ul id="u"><li>one</li><li>two</li></ul>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const ul = byId(el, 'u');
    const li = createElement('li', {}, [createText('three')]);
    appendChild(ul, li);
    el.touchDocument([
      { type: 'childList', target: ul, addedNodes: [li], removedNodes: [] },
    ]);
    // the document is a line taller: laid out before its pixels are read
    await act();
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
    // and one taken away
    const first = ul.children.find((n) => (n as Element).name === 'li')!;
    removeNode(first);
    el.touchDocument([
      { type: 'childList', target: ul, addedNodes: [], removedNodes: [first] },
    ]);
    await act();
    const after = await snapshot(result, el);
    assert.strictEqual(bytesApart(after, await rebuilt(result, el)), 0);
  },
);

metric(
  'an element moved is styled where it is now, and what is in it too',
  async () => {
    // what is in it was styled under other ancestors, which a selector
    // that reads them answers otherwise for
    const { result, node } = await render(
      '<style>body{margin:0} .x .y{color:#ff0000}</style>' +
        '<div id="out"><div id="m"><span class="y" id="s">moved</span>' +
        '</div></div><div class="x" id="in"></div>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const moved = byId(el, 'm');
    const from = byId(el, 'out');
    const into = byId(el, 'in');
    appendChild(into, moved as unknown as ChildNode);
    el.touchDocument([
      {
        type: 'childList',
        target: from,
        addedNodes: [],
        removedNodes: [moved],
      },
      {
        type: 'childList',
        target: into,
        addedNodes: [moved],
        removedNodes: [],
      },
    ]);
    assert.strictEqual(
      el.computedStyle(byId(el, 's'))?.color,
      'rgb(255, 0, 0)',
    );
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'an element added before another restyles what a sibling combinator reaches in it',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} .a + .b .c{color:#ff0000}</style>' +
        '<div id="p"><div class="b" id="b"><span class="c" id="c">c</span>' +
        '</div></div>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const parent = byId(el, 'p');
    const a = createElement('div', { class: 'a' }, [createText('a')]);
    DomUtils.prepend(byId(el, 'b') as unknown as ChildNode, a);
    el.touchDocument([
      { type: 'childList', target: parent, addedNodes: [a], removedNodes: [] },
    ]);
    assert.strictEqual(
      el.computedStyle(byId(el, 'c'))?.color,
      'rgb(255, 0, 0)',
    );
    await act();
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  "an attribute a hint reads restyles what the hint styles: a table's cells",
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0}</style><table id="t" cellpadding="1">' +
        '<tr><td id="d">cell</td></tr></table>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const table = byId(el, 't');
    table.attribs.cellpadding = '9';
    el.touchDocument([
      {
        type: 'attributes',
        target: table,
        attributeName: 'cellpadding',
        oldValue: '1',
      },
    ]);
    assert.strictEqual(el.computedStyle(byId(el, 'd'))?.['padding-top'], '9px');
    await act();
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'a fragment built outside the document restyles nothing until it comes in',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} .x .y{color:#ff0000}</style>' +
        '<p>above</p><div id="p"></div>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const tree = treeOf(el);
    // what a script does before it appends: a fragment, built and filled
    const fragment = new Document([]);
    const holder = createElement('div', { class: 'x' });
    const item = createElement('span');
    const damage = await damageOf(el, () => {
      appendChild(fragment, holder);
      appendChild(holder, item);
      item.attribs.class = 'y';
      el.touchDocument([
        {
          type: 'childList',
          target: fragment,
          addedNodes: [holder],
          removedNodes: [],
        },
        {
          type: 'childList',
          target: holder,
          addedNodes: [item],
          removedNodes: [],
        },
        {
          type: 'attributes',
          target: item,
          attributeName: 'class',
          oldValue: null,
        },
      ]);
    });
    assert.strictEqual(damage.length, 0, `${damage.length} repaints`);
    assert.ok(treeOf(el) === tree, 'built again');
    const p = byId(el, 'p');
    appendChild(p, holder);
    el.touchDocument([
      {
        type: 'childList',
        target: fragment,
        addedNodes: [],
        removedNodes: [holder],
      },
      { type: 'childList', target: p, addedNodes: [holder], removedNodes: [] },
    ]);
    assert.strictEqual(el.computedStyle(item)?.color, 'rgb(255, 0, 0)');
    await act();
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric('a stylesheet added styles every element again', async () => {
  const { result, node } = await render(
    '<style>body{margin:0}</style><p id="a">a</p><p id="b">b</p>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const body = byId(el, 'a').parent as unknown as Element;
  const sheet = createElement('style', {}, [createText('p{color:#ff0000}')]);
  appendChild(body, sheet);
  el.touchDocument([
    { type: 'childList', target: body, addedNodes: [sheet], removedNodes: [] },
  ]);
  const drawn = await snapshot(result, el);
  assert.strictEqual(
    el.computedStyle(byId(el, 'b'))?.color,
    'rgb(255, 0, 0)',
    'the new sheet',
  );
  assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
});

metric(
  'an inline drawing whose insides changed is drawn again, and nothing else',
  async () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, i) => `<p>Paragraph ${i}</p>`,
    ).join('');
    const { result, node } = await render(
      '<style>body{margin:0} p{margin:0}</style>' +
        '<svg width="60" height="40"><circle id="c" cx="10" cy="20" r="8"' +
        ' fill="#ff0000"/></svg>' +
        paragraphs,
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const tree = treeOf(el);
    const circle = byId(el, 'c');
    const damage = await damageOf(el, () => {
      circle.attribs.cx = '45';
      el.touchDocument([
        {
          type: 'attributes',
          target: circle,
          attributeName: 'cx',
          oldValue: '10',
        },
      ]);
    });
    assert.ok(treeOf(el) === tree, 'built again');
    assert.ok(damage.length > 0 && !damage.includes(el));
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

// --- every change, held to every element styled again ---------------------
//
// Random documents, random rules and random changes, on the mock backend: a
// refresh told what changed has to come to the styles a refresh of the
// whole document does, element by element. The rules are the shapes whose
// reach the scope reads — each combinator, `:not()`, `:is()`, `:has()` at
// a subject and inside one, the structural pseudo-classes, attributes, ids,
// inherited properties, a `::before` — and the changes each kind of record.

/** mulberry32: the same document for the same seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASSES = ['a', 'b', 'c', 'd'];
const TAGS = ['div', 'p', 'span', 'li', 'section'];
const INKS = ['#ff0000', '#00aa00', '#0000ff', '#aa00aa'];

function rulesFor(next: () => number): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const c = () => pick(CLASSES);
  const shapes: (() => string)[] = [
    () => `.${c()}`,
    () => `.${c()} .${c()}`,
    () => `.${c()} > .${c()}`,
    () => `.${c()} + .${c()}`,
    () => `.${c()} ~ .${c()}`,
    () => `.${c()} + .${c()} .${c()}`,
    () => `.${c()} ~ * > .${c()}`,
    () => `.${c()}:not(.${c()})`,
    () => `:is(.${c()}, .${c()}) > *`,
    () => `.${c()}:has(.${c()})`,
    () => `.${c()}:has(> .${c()})`,
    () => `:not(.${c()}) > .${c()}:first-child`,
    () => `${pick(TAGS)}:last-child`,
    () => `div:empty`,
    () => `.${c()}:nth-child(2n+1)`,
    () => `[data-x] .${c()}`,
    () => `[data-x=y]`,
    () => `#e${Math.floor(next() * 6)} .${c()}`,
    () => `#e${Math.floor(next() * 6)}`,
  ];
  // what a `:has()` reaches past its anchors, which is everything around
  // them: such a sheet styles every element again, as one in a few does
  const around: (() => string)[] = [
    () => `.${c()}:has(+ .${c()})`,
    () => `.${c()}:has(.${c()}) span`,
    () => `section:has(.${c()}) + *`,
  ];
  const declarations: (() => string)[] = [
    () => `color: ${pick(INKS)}`,
    () => `background-color: ${pick(INKS)}`,
    () => 'font-weight: bold',
    () => `display: ${pick(['none', 'block', 'inline-block', 'flex'])}`,
    () => `padding-left: ${Math.floor(next() * 20)}px`,
    () => 'border-top: 2px solid',
  ];
  const rules: string[] = [];
  const count = 6 + Math.floor(next() * 8);
  for (let i = 0; i < count; i += 1) {
    const shape = next() < 0.04 ? pick(around) : pick(shapes);
    rules.push(`${shape()} { ${pick(declarations)()} }`);
  }
  if (next() < 0.5) {
    rules.push(`.${c()}::before { content: "*"; color: ${pick(INKS)} }`);
  }
  return rules.join('\n');
}

function markupFor(next: () => number): string {
  let id = 0;
  const element = (depth: number): string => {
    const tag = TAGS[Math.floor(next() * TAGS.length)];
    const classes = CLASSES.filter(() => next() < 0.3).join(' ');
    let attrs = classes ? ` class="${classes}"` : '';
    if (next() < 0.3) attrs += ` id="e${id++}"`;
    if (next() < 0.2) attrs += ` data-x="${next() < 0.5 ? 'y' : 'z'}"`;
    let inner = next() < 0.5 ? `t${Math.floor(next() * 9)}` : '';
    if (depth < 3) {
      const kids = Math.floor(next() * 4);
      for (let i = 0; i < kids; i += 1) inner += element(depth + 1);
    }
    return `<${tag}${attrs}>${inner}</${tag}>`;
  };
  let body = '';
  for (let i = 0; i < 4; i += 1) body += element(0);
  return body;
}

/** The body's elements, in document order. */
function elementsIn(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    out.push(el);
    for (const child of el.children) {
      if ((child as Element).attribs) walk(child as Element);
    }
  };
  walk(root);
  return out;
}

/** Every element's style as a script reads it, and its `::before`'s. */
function stylesOf(el: HtmlViewNode, body: Element): string[] {
  return elementsIn(body).map((e, i) => {
    const own = el.computedStyle(e);
    const before = el.computedStyle(e, 'before');
    return `${i} <${e.name} ${JSON.stringify(e.attribs)}> ${JSON.stringify(own)} ${JSON.stringify(before)}`;
  });
}

/** A change a script might make, done, and its records. */
function changeOne(
  next: () => number,
  body: Element,
  forgetOld: boolean,
): HtmlChange[] {
  const all = elementsIn(body);
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const inside = all.slice(1);
  const kind = Math.floor(next() * 8);
  if (kind === 0 || kind === 1) {
    // a class toggled
    const target = pick(all);
    const was = target.attribs.class ?? null;
    const has = new Set((was ?? '').split(' ').filter(Boolean));
    const c = pick(CLASSES);
    if (has.has(c)) has.delete(c);
    else has.add(c);
    target.attribs.class = [...has].join(' ');
    return [
      {
        type: 'attributes',
        target,
        attributeName: 'class',
        ...(forgetOld ? {} : { oldValue: was }),
      },
    ];
  }
  if (kind === 2) {
    // an attribute set or taken away
    const target = pick(all);
    const was = target.attribs['data-x'] ?? null;
    if (was !== null && next() < 0.5) delete target.attribs['data-x'];
    else target.attribs['data-x'] = next() < 0.5 ? 'y' : 'z';
    return [
      { type: 'attributes', target, attributeName: 'data-x', oldValue: was },
    ];
  }
  if (kind === 3) {
    // an id moved
    const target = pick(all);
    const was = target.attribs.id ?? null;
    target.attribs.id = `e${Math.floor(next() * 6)}`;
    return [
      {
        type: 'attributes',
        target,
        attributeName: 'id',
        ...(forgetOld ? {} : { oldValue: was }),
      },
    ];
  }
  if (kind === 4) {
    // an element added, at the end or before one of its parent's
    const parent = pick(all);
    const classes = CLASSES.filter(() => next() < 0.4).join(' ');
    const child = createElement(pick(TAGS), classes ? { class: classes } : {});
    if (next() < 0.5) appendChild(child, createText('n'));
    if (next() < 0.5) {
      const grand = createElement('span', { class: pick(CLASSES) });
      appendChild(child, grand);
    }
    const before = parent.children.filter((n) => (n as Element).attribs);
    if (before.length && next() < 0.5) {
      DomUtils.prepend(pick(before), child);
    } else appendChild(parent, child);
    return [
      {
        type: 'childList',
        target: parent,
        addedNodes: [child],
        removedNodes: [],
      },
    ];
  }
  if (kind === 5 && inside.length) {
    // one taken out
    const target = pick(inside);
    const parent = target.parent as unknown as Element;
    removeNode(target as unknown as ChildNode);
    return [
      {
        type: 'childList',
        target: parent,
        addedNodes: [],
        removedNodes: [target],
      },
    ];
  }
  if (kind === 6 && inside.length) {
    // one moved somewhere outside itself
    const target = pick(inside);
    const into = pick(all.filter((e) => !elementsIn(target).includes(e)));
    const from = target.parent as unknown as Element;
    const before = into.children.filter((n) => (n as Element).attribs);
    if (before.length && next() < 0.5) {
      removeNode(target as unknown as ChildNode);
      DomUtils.prepend(pick(before), target as unknown as ChildNode);
    } else appendChild(into, target as unknown as ChildNode);
    return [
      {
        type: 'childList',
        target: from,
        addedNodes: [],
        removedNodes: [target],
      },
      {
        type: 'childList',
        target: into,
        addedNodes: [target],
        removedNodes: [],
      },
    ];
  }
  // a text changed, or an inline style set
  const target = pick(all);
  if (next() < 0.5) {
    const text = target.children.find((n) => n.type === 'text') as
      { data: string } | undefined;
    if (text) {
      text.data = next() < 0.5 ? '' : 'changed';
      return [{ type: 'characterData', target: text as never }];
    }
  }
  const was = target.attribs.style ?? null;
  target.attribs.style = `color: ${pick(INKS)}`;
  return [
    { type: 'attributes', target, attributeName: 'style', oldValue: was },
  ];
}

test('a refresh told what changed comes to the styles of a refresh of everything', async () => {
  // which way each refresh went, so the comparison is known to be of the
  // scoped ways and not only of the refresh of everything they fall back to
  const ways = { whole: 0, inPlace: 0, frame: 0, build: 0 };
  for (let seed = 1; seed <= 40; seed += 1) {
    const next = random(seed);
    const css = rulesFor(next);
    const source = `<style>body{margin:0}\n${css}</style><body>${markupFor(next)}</body>`;
    // real fonts where the machine has them: the mock backend lays out no
    // text, and a restyle in place remakes the text it inks
    const { result, node } = await render(source, 320);
    const el = view(node);
    await act();
    const bodyEl = el.document.children.find(
      (n) => (n as Element).name === 'body',
    ) as Element;
    for (let step = 0; step < 8; step += 1) {
      const changes: HtmlChange[] = [];
      const batch = 1 + Math.floor(next() * 3);
      for (let i = 0; i < batch; i += 1) {
        changes.push(...changeOne(next, bodyEl, next() < 0.25));
      }
      const node = el as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      const scope = node._changeScope.call(el, changes) as {
        boxes: boolean;
      } | null;
      if (!scope) ways.whole += 1;
      const inPlace = node._restyleInPlace;
      const frame = node._rebuildFrame;
      let way: keyof typeof ways = scope ? 'build' : 'whole';
      node._restyleInPlace = function (this: unknown, ...a: unknown[]) {
        const done = inPlace.apply(this, a);
        if (done) way = 'inPlace';
        return done;
      };
      node._rebuildFrame = function (this: unknown, ...a: unknown[]) {
        way = 'frame';
        return frame.apply(this, a);
      };
      el.touchDocument(changes);
      delete node._restyleInPlace;
      delete node._rebuildFrame;
      if (scope) ways[way] += 1;
      const scoped = stylesOf(el, bodyEl);
      el.touchDocument();
      const whole = stylesOf(el, bodyEl);
      const at = scoped.findIndex((s, i) => s !== whole[i]);
      assert.ok(
        at < 0 && scoped.length === whole.length,
        `seed ${seed}, step ${step}: told what changed\n${scoped[at]}\n` +
          `styled whole\n${whole[at]}\nrules\n${css}\nchanges ` +
          changes.map((c) => c.type).join(', '),
      );
    }
    result.unmount();
  }
  const scoped = ways.inPlace + ways.frame + ways.build;
  assert.ok(scoped > ways.whole, `${JSON.stringify(ways)}`);
  for (const way of ['inPlace', 'frame', 'build'] as const) {
    if (way === 'inPlace' && !FONTS) continue;
    assert.ok(ways[way] > 0, `no refresh went ${way}: ${JSON.stringify(ways)}`);
  }
});
