// <Html> — a refresh told what changed: what a selector that tests the
// change can reach is styled again, and nothing else is.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, expectPixel } from 'react-x11/test';
import { Comment, Document } from 'domhandler';
import * as DomUtils from 'domutils';
import {
  appendChild,
  createHtmlElement as createElement,
  createText,
  removeNode,
  shadowRootOf,
} from '../../src/html/index.js';
import { attachShadow } from '../../src/html/dom.js';
import {
  FormState,
  controlChange,
  setCustomError,
  setIndeterminate,
  setUserValidity,
} from '../../src/html/form.js';
import type {
  ChildNode,
  Element,
  HtmlChange,
  HtmlViewNode,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';
import {
  CHANGES_BELOW,
  Cascade,
  ChangeAnchors,
} from '../../src/html/css/cascade.js';
import { parseStylesheet } from '../../src/html/css/parse.js';
import type { RootLook } from '../../src/html/css/style.js';
import { HtmlSource } from '../../src/html/dom.js';
import { Html } from '../../src/index.js';
import { mulberry32 } from '../mulberry32.js';
import {
  FONTS,
  boxOf,
  bytesApart,
  drawnText,
  findById,
  h,
  metric,
  rebuilt,
  render,
  snapshot,
  treeOf,
  view,
  withForeignObjects,
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

/** What a test asks of the cascade in force about its indexes. */
interface IndexesOf {
  _index: {
    all(): Iterable<{ rule: { order: number; declarations: object } }>;
  };
  _pseudo: Record<string, IndexesOf['_index']>;
  _highlights: Map<string, IndexesOf['_index']>;
  _transitionRules: IndexesOf['_index'];
  _document: { parts: { rule: { order: number; declarations: object } }[] };
  _latest: unknown[];
  _noted: Set<unknown>;
  _changeRules: object;
  _keyframeMedia: unknown[];
  _mediaOutsideRules: unknown[];
  _sheets: { rules: { order: number; declarations: object }[] }[];
}
const cascadeOf = (el: HtmlViewNode) =>
  (el as unknown as { _cascade: IndexesOf })._cascade;

/** All a cascade's walk of its sheets leaves on it, as numbers and names. */
function walkOf(cascade: IndexesOf): unknown {
  const c = cascade as unknown as Record<string, never>;
  const sizes = (map: Map<string, { size: number }>) =>
    [...map].map(([name, { size }]) => [name, size]).sort();
  const lengths = (map: Map<string, unknown[]>) =>
    [...map].map(([name, { length }]) => [name, length]).sort();
  const tree = c._document as unknown as {
    keyframes: Map<string, unknown[]>;
    positionTries: Map<string, unknown>;
    host: unknown[];
    slotted: unknown[];
    parts: unknown[];
  };
  return {
    index: (c._index as { size: number }).size,
    pseudo: sizes(new Map(Object.entries(c._pseudo as object))),
    highlights: sizes(c._highlights),
    transitions: (c._transitionRules as { size: number }).size,
    shapes: (c._shapes as { size: number }).size,
    flags: [c._vars, c._lh, c.snaps, c._zoom, c._writing],
    uaProps: (c._uaProps as Set<string>).size,
    outside: (c._mediaOutsideRules as unknown[]).length,
    keyframeMedia: (c._keyframeMedia as unknown[]).length,
    scopedPseudos: [...(c._scopedPseudos as Set<string>)].sort(),
    scopedId: c._scopedId,
    nextTree: c._nextTree,
    trees: (c._byKey as Map<string, unknown>).size,
    keyframes: lengths(tree.keyframes),
    tries: [...tree.positionTries.keys()].sort(),
    edges: [tree.host.length, tree.slotted.length, tree.parts.length],
    filed: (c._filed as Map<unknown, unknown>).size,
    restated: (c._restated as unknown[]).length,
    asked: [
      [...(c._askedIds as Set<string>)].sort(),
      [...(c._askedClasses as Set<string>)].sort(),
    ],
  };
}

const byId = (el: HtmlViewNode, id: string) =>
  findById(el.document, id) as unknown as Element;

/** A drawing's size, and a shape that fills it, for what writes one out. */
const SIZE = 'width="24" height="24"';
const RECT = `<rect id="r" ${SIZE}/>`;

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

test('getComputedStyle of what nothing draws works its style out once, and again once a change can have moved it', async () => {
  // Apple's product pages read the styles of their closed dialogs a
  // property at a time, and each read styled the chain down from the
  // nearest box again: three and a half seconds of a load
  const { node } = await render(
    '<style>body{margin:0} #d{display:none} .on{color:#ff0000}' +
      ' .big{font-size:30px}</style><body><div id="d"><section id="s">' +
      '<p id="p">p</p></section></div><p id="q">q</p></body>',
    300,
  );
  const el = view(node);
  await act();
  const p = byId(el, 'p');
  assert.strictEqual(el.computedStyle(p)?.display, 'block');
  const read = await stylesComputed(el, () => {
    for (let i = 0; i < 5; i += 1) el.computedStyle(p);
  });
  assert.strictEqual(read, 0, `${read} styles worked out again`);
  // a class set under `display: none` restyles nothing the tree holds,
  // and is read
  el.touchDocument([setClass(p, 'on')]);
  assert.strictEqual(el.computedStyle(p)?.color, 'rgb(255, 0, 0)');
  // and so is one on what it inherits from
  el.touchDocument([setClass(byId(el, 's'), 'big')]);
  assert.strictEqual(el.computedStyle(p)?.['font-size'], '30px');
});

metric(
  "a class changed in a foreignObject's HTML builds the boxes, and is drawn",
  async (t) => {
    withForeignObjects(t);
    // what an object holds is a tree of boxes of its own, which a restyle
    // in place finds nothing of: taken in place, the change left the
    // object drawn as it was
    const { result, node } = await render(
      '<style>body{margin:0} svg{display:block}' +
        '.d{height:40px;background:#00ff00} .d.on{background:#ff0000}</style>' +
        '<svg width="100" height="40"><foreignObject width="100" height="40">' +
        '<div id="d" class="d"></div></foreignObject></svg>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const tree = treeOf(el);
    el.touchDocument([setClass(byId(el, 'd'), 'd on')]);
    const drawn = await snapshot(result, el);
    assert.ok(treeOf(el) !== tree, 'the boxes were built again');
    const { width } = (el as unknown as { abs: { width: number } }).abs;
    const at = (10 * width + 10) * 4;
    assert.deepStrictEqual(
      [drawn[at], drawn[at + 1], drawn[at + 2]],
      [255, 0, 0],
      'the object drawn in its new class',
    );
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

test('the root’s font-size changed reaches a rem anywhere, though every parent’s style comes out as it was', async () => {
  const { result, node } = await render(
    '<html id="root" style="font-size:16px"><body style="margin:0;font-size:16px">' +
      '<div><div id="t" style="width:2rem;height:4px"></div></div></body></html>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const t = byId(el, 't');
  assert.strictEqual(el.computedStyle(t)?.width, '32px');
  const root = byId(el, 'root');
  const oldValue = root.attribs.style ?? null;
  root.attribs.style = 'font-size:10px';
  el.touchDocument([
    { type: 'attributes', target: root, attributeName: 'style', oldValue },
  ]);
  await snapshot(result, el);
  assert.strictEqual(el.computedStyle(t)?.width, '20px');
});

test('the root’s line-height changed reaches an rlh anywhere, and a style() comparison in one', async () => {
  // style-query-registered-custom-root-relative-units-change.html: the
  // root's line height is what an `rlh` is, as its font size is a `rem`
  const { result, node } = await render(
    '<html id="root" style="line-height:20px"><body style="margin:0;line-height:20px">' +
      '<style>@property --len { syntax: "<length>"; inherits: false; initial-value: 0px }' +
      '#c { --len: 100px } @container style(--len: 10rlh) { #q { color: #008000 } }</style>' +
      '<div id="c"><div id="t" style="width:2rlh;height:4px"></div><p id="q">q</p></div>' +
      '</body></html>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const t = byId(el, 't');
  const q = byId(el, 'q');
  assert.strictEqual(el.computedStyle(t)?.width, '40px');
  assert.notStrictEqual(el.computedStyle(q)?.color, 'rgb(0, 128, 0)');
  const root = byId(el, 'root');
  const oldValue = root.attribs.style ?? null;
  root.attribs.style = 'line-height:10px';
  el.touchDocument([
    { type: 'attributes', target: root, attributeName: 'style', oldValue },
  ]);
  await snapshot(result, el);
  assert.strictEqual(el.computedStyle(t)?.width, '20px');
  assert.strictEqual(el.computedStyle(q)?.color, 'rgb(0, 128, 0)');
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
  "a splitter's change of its panes' flex keeps their boxes, and lays them out again where a build puts them",
  async () => {
    // joshwcomeau.com's playgrounds set `flex` on two panes at every step
    // of a drag of the divider between them, and each step built the
    // panes' boxes: a code editor's worth of spans
    // as many as the narrowest pane holds: what overflows a pane that
    // clips it is in its ink, and repainted with it
    const tokens = Array.from(
      { length: 12 },
      (_, i) => `<span>token${i}</span> `,
    ).join('');
    const { result, node } = await render(
      '<style>body{margin:0} .row{display:flex;height:120px}' +
        ' .l{background:#ddeeff;overflow:hidden} .r{background:#ffeedd}' +
        ' .d{width:8px;background:#444444}</style><div class="row">' +
        `<div class="l" id="l" style="flex: 200">${tokens}</div>` +
        '<div class="d"></div>' +
        '<div class="r" id="r" style="flex: 100"><p>result</p></div></div>' +
        '<p id="after">below the playground</p>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const l = byId(el, 'l');
    const r = byId(el, 'r');
    const flex = (target: Element, value: number): HtmlChange => {
      const oldValue = target.attribs.style ?? null;
      target.attribs.style = `flex: ${value}`;
      return { type: 'attributes', target, attributeName: 'style', oldValue };
    };
    for (const [left, right] of [
      [120, 180],
      [250, 50],
    ]) {
      const tree = treeOf(el);
      const before = el.elementRect(r)!;
      // what the layout moved and reshaped, which is the row: the
      // paragraph below it is where it was
      const damage = await damageOf(el, () =>
        el.touchDocument([flex(l, left), flex(r, right)]),
      );
      assert.ok(damage.length > 0, 'nothing repainted');
      assert.ok(!damage.includes(el), 'the whole document repainted');
      const below = el.elementRect(byId(el, 'after'))!;
      for (const rect of damage as { y: number; height: number }[]) {
        const { abs } = el as unknown as { abs: { y: number } };
        assert.ok(
          rect.y + rect.height <= abs.y + below.y + 1,
          'repainted below the row',
        );
      }
      const drawn = await snapshot(result, el);
      assert.ok(treeOf(el) === tree, `built again for flex ${left}/${right}`);
      assert.notStrictEqual(
        el.elementRect(r)!.x,
        before.x,
        'the right pane did not move',
      );
      assert.strictEqual(
        bytesApart(drawn, await rebuilt(result, el)),
        0,
        `flex ${left}/${right} is not as a build draws it`,
      );
    }
  },
);

metric(
  'a box a margin taken in place moves is repainted where it was and where it is, and nowhere else',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} p{margin:0} .row{height:40px;' +
        'background:#ffffff}</style><div class="row"><div id="m" style="' +
        'width:40px;height:40px;background:#ff0000;margin-left:10px"></div>' +
        '</div><p id="after">below it</p>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const m = byId(el, 'm');
    const tree = treeOf(el);
    const damage = await damageOf(el, () => {
      const oldValue = m.attribs.style;
      m.attribs.style = oldValue.replace(
        'margin-left:10px',
        'margin-left:200px',
      );
      el.touchDocument([
        { type: 'attributes', target: m, attributeName: 'style', oldValue },
      ]);
    });
    assert.ok(damage.length > 0, 'nothing repainted');
    assert.ok(!damage.includes(el), 'the whole document repainted');
    const drawn = await snapshot(result, el);
    assert.ok(treeOf(el) === tree, 'built again');
    assert.strictEqual(
      bytesApart(drawn, await rebuilt(result, el)),
      0,
      'not as a build draws it',
    );
  },
);

metric(
  'a width taken in place that makes the document taller repaints all of it, as a build draws it',
  async () => {
    // what moves below a box that grows is the rest of the document, and
    // the element is another height for core to measure
    const { result, node } = await render(
      '<style>body{margin:0} p{margin:0}</style>' +
        '<div id="d" style="width: 280px">a paragraph that wraps once it is' +
        ' narrower than it is now, onto more lines</div>' +
        '<p id="after">below it</p>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const d = byId(el, 'd');
    const tall = el.elementRect(d)!.height;
    const damage = await damageOf(el, () => {
      const oldValue = d.attribs.style;
      d.attribs.style = 'width: 90px';
      el.touchDocument([
        { type: 'attributes', target: d, attributeName: 'style', oldValue },
      ]);
    });
    assert.ok(damage.includes(el), 'the document was not repainted whole');
    // the size it came to, which a snapshot taken as it changes is not of
    await snapshot(result, el);
    const drawn = await snapshot(result, el);
    assert.ok(el.elementRect(d)!.height > tall, 'it did not grow');
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

metric(
  'a link broken around a block takes a colour a script sets it on every piece of it, restyled where it is',
  async () => {
    // A link around a `<div>` is the pieces of it before and after the
    // block (`breakInlines`), each run of them in an anonymous block of its
    // own; the restyle in place looked in the first piece's block alone,
    // and the text after the block kept its old colour
    const { result, node } = await render(
      '<style>body{margin:0} a{color:#0000ee}</style><p>x</p>' +
        '<a id="a" href="#a">before<div>block</div>after</a>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const tree = treeOf(el);
    el.touchDocument([setAttr(byId(el, 'a'), 'style', 'color: #ff0000')]);
    const drawn = await snapshot(result, el);
    assert.ok(treeOf(el) === tree, 'the document was built again');
    assert.strictEqual(
      bytesApart(drawn, await rebuilt(result, el)),
      0,
      'a piece kept its colour',
    );
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

const shape = '<rect width="24" height="24"/>';
const drawing = (id: string, inside = shape) =>
  `<svg id="${id}" width="24" height="24">${inside}</svg>`;

/** What each drawing's shapes are given is asked again: how many drawings
 *  ask while `run` runs. */
async function drawingsAsked(el: HtmlViewNode, run: () => unknown) {
  const cascade = (el as unknown as { _cascade: Cascade })._cascade;
  const ask = cascade.shapeStyles;
  const asked: (string | undefined)[] = [];
  cascade.shapeStyles = function (this: Cascade, ...a) {
    asked.push(a[0].attribs.id);
    return ask.apply(this, a);
  };
  try {
    await run();
  } finally {
    delete (cascade as { shapeStyles?: unknown }).shapeStyles;
  }
  return asked;
}

metric(
  'a change outside an inline drawing that a rule reaches a shape in it by draws it again, and nothing else',
  async () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, i) => `<p>Paragraph ${i}</p>`,
    ).join('');
    const { result, node } = await render(
      '<style>body{margin:0} p{margin:0} .on #s rect{fill:#0000ff}</style>' +
        `<div id="top">${drawing('s')}</div>${paragraphs}`,
      300,
    );
    const el = view(node);
    const was = await snapshot(result, el);
    const tree = treeOf(el);
    const top = byId(el, 'top');
    const styled = await stylesComputed(el, async () => {
      const damage = await damageOf(el, () => {
        top.attribs.class = 'on';
        el.touchDocument([
          {
            type: 'attributes',
            target: top,
            attributeName: 'class',
            oldValue: null,
          },
        ]);
      });
      assert.ok(treeOf(el) === tree, 'built again');
      assert.ok(damage.length > 0 && !damage.includes(el));
    });
    assert.strictEqual(styled, 0);
    const drawn = await snapshot(result, el);
    assert.ok(bytesApart(drawn, was) > 0, 'drawn as it was');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'whatever a selector reaches a shape by, a change draws what a build draws',
  async () => {
    const gradient =
      '<linearGradient id="g"><stop stop-color="#ff0000"/></linearGradient>';
    const named = drawing('s', '<rect width="24" height="24" fill="url(#g)"/>');
    const rows: [string, string, string, string?][] = [
      [
        'a class above',
        '.on rect{fill:#0000ff}',
        `<a id="t">${drawing('s')}</a>`,
      ],
      [
        'a class on the shape',
        '.on .p{fill:#0000ff}',
        `<a id="t">${drawing('s', '<rect class="p" width="24" height="24"/>')}</a>`,
      ],
      [
        'an attribute above',
        '[data-on] rect{fill:#0000ff}',
        `<a id="t">${drawing('s')}</a>`,
        'data-on',
      ],
      [
        'what names nothing',
        '.on svg *{fill:#0000ff}',
        `<a id="t">${drawing('s')}</a>`,
      ],
      [
        'a later sibling',
        '.on ~ svg rect{fill:#0000ff}',
        `<a id="t"></a>${drawing('s')}`,
      ],
      [
        'the next sibling',
        '.on + svg rect{fill:#0000ff}',
        `<a id="t"></a>${drawing('s')}`,
      ],
      [
        'a :has() around it',
        'b:has(.on) rect{fill:#0000ff}',
        `<b><a id="t"></a>${drawing('s')}</b>`,
      ],
      [
        'the root of the drawing',
        '.on rect{fill:#0000ff}',
        '<svg id="t" width="24" height="24"><rect width="24" height="24"/></svg>',
      ],
      [
        'what its root is given and has no style for',
        '.on{clip-rule:evenodd}',
        '<svg id="t" width="24" height="24"><clipPath id="c">' +
          '<path d="M0 0h24v24H0zM6 6h12v12H6z"/></clipPath><rect width="24"' +
          ' height="24" fill="#0000ff" clip-path="url(#c)"/></svg>',
      ],
      [
        'what its root gives it',
        '.on svg{fill:#0000ff} .on rect{stroke:#00aa00;stroke-width:8}',
        `<a id="t">${drawing('s')}</a>`,
      ],
      [
        "a drawing's own gradient",
        '.on stop{stop-color:#0000ff}',
        `<a id="t">${drawing('s', `${gradient}<rect width="24" height="24" fill="url(#g)"/>`)}</a>`,
      ],
      [
        "another drawing's gradient",
        '.on stop{stop-color:#0000ff}',
        `<a id="t">${drawing('d', gradient)}</a>${named}`,
      ],
      [
        'a gradient in a hidden drawing',
        '.on stop{stop-color:#0000ff}',
        `<a id="t"><svg style="display:none">${gradient}</svg></a>${named}`,
      ],
    ];
    for (const [name, css, markup, attribute = 'class'] of rows) {
      const { result, node } = await render(
        `<style>body{margin:0} svg,a,b{display:block}${css}</style>${markup}`,
        300,
      );
      const el = view(node);
      const was = await snapshot(result, el);
      const tree = treeOf(el);
      const target = byId(el, 't');
      target.attribs[attribute] = attribute === 'class' ? 'on' : '';
      el.touchDocument([
        {
          type: 'attributes',
          target,
          attributeName: attribute,
          oldValue: null,
        },
      ]);
      const drawn = await snapshot(result, el);
      assert.ok(treeOf(el) === tree, `${name}: built again`);
      assert.ok(bytesApart(drawn, was) > 0, `${name}: drawn as it was`);
      assert.strictEqual(
        bytesApart(drawn, await rebuilt(result, el)),
        0,
        `${name}: not as a build draws it`,
      );
      await cleanup();
    }
  },
);

metric(
  'a shape a change reaches builds the boxes of a drawing with a <foreignObject>, whose HTML is styled from its elements down',
  async (t) => {
    withForeignObjects(t);
    const { result, node } = await render(
      '<style>body{margin:0} svg{display:block} .on g{color:#0000ff}' +
        'div{height:20px;background:currentColor}</style>' +
        '<div id="top" style="background:none;height:auto">' +
        '<svg width="60" height="20"><g><foreignObject width="60" height="20">' +
        '<div id="inner"></div></foreignObject></g></svg></div>',
      300,
    );
    const el = view(node);
    const was = await snapshot(result, el);
    const top = byId(el, 'top');
    top.attribs.class = 'on';
    el.touchDocument([
      {
        type: 'attributes',
        target: top,
        attributeName: 'class',
        oldValue: null,
      },
    ]);
    const drawn = await snapshot(result, el);
    assert.ok(bytesApart(drawn, was) > 0, 'drawn as it was');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

test('what is taken out at the root of a drawing goes from what it draws', async () => {
  const { result, node } = await render(
    '<style>body{margin:0}</style>' +
      drawing('s', '<rect id="r" width="24" height="24" fill="#ff0000"/>'),
    300,
  );
  const el = view(node);
  const was = await snapshot(result, el);
  const tree = treeOf(el);
  const target = byId(el, 's');
  const shape = byId(el, 'r');
  removeNode(shape);
  el.touchDocument([
    {
      type: 'childList',
      target,
      addedNodes: [],
      removedNodes: [shape],
    },
  ]);
  const drawn = await snapshot(result, el);
  assert.ok(treeOf(el) === tree, 'built again');
  assert.ok(bytesApart(drawn, was) > 0, 'drawn as it was');
  assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
});

metric(
  'a shape a change reaches builds nothing around its drawing where something else builds the boxes',
  async () => {
    // beside a rule of what is built: a shape was a seed of the build, and
    // its nearest block was built for a box it has not got
    const { result, node } = await render(
      '<style>body{margin:0} .on #o{display:flex}' +
        '.on ~ div rect{fill:#0000ff}</style>' +
        `<div id="top"><div id="o">o</div></div><div id="around">${drawing('s')}</div>`,
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const tree = treeOf(el);
    const box = boxOf(el, 's');
    const top = byId(el, 'top');
    top.attribs.class = 'on';
    el.touchDocument([
      {
        type: 'attributes',
        target: top,
        attributeName: 'class',
        oldValue: null,
      },
    ]);
    const drawn = await snapshot(result, el);
    assert.ok(treeOf(el) !== tree, 'no build');
    assert.ok(boxOf(el, 's') === box, 'its box built again');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'a shape a change reaches past where the drawing was drawn is painted there, where it shows what it draws past its box',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} svg{overflow:visible;display:block;margin:30px}' +
        `.on rect{stroke:#0000ff;stroke-width:40}</style><div id="top">${drawing('s')}</div>`,
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const top = byId(el, 'top');
    for (const [value, was] of [
      ['on', null],
      ['', 'on'],
    ]) {
      top.attribs.class = value!;
      el.touchDocument([
        {
          type: 'attributes',
          target: top,
          attributeName: 'class',
          oldValue: was,
        },
      ]);
      const drawn = await snapshot(result, el);
      assert.strictEqual(
        bytesApart(drawn, await rebuilt(result, el)),
        0,
        `class "${value}"`,
      );
    }
  },
);

metric(
  'a class on the root asks only the drawings a rule reaches into, and repaints only those it gives something else',
  async () => {
    const { result, node } = await render(
      '<!doctype html><html id="root"><head><style>body{margin:0} p{margin:0}' +
        '.on .p{fill:#0000ff} .plain .q{background:#ff0000}' +
        '.para p{color:#00aa00}</style></head><body>' +
        drawing('reached', '<rect class="p" width="24" height="24"/>') +
        drawing('named', '<rect class="q" width="24" height="24"/>') +
        drawing('other') +
        drawing('another') +
        '<p>Paragraph</p></body></html>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const root = byId(el, 'root');
    const set = async (value: string, was: string | null) => {
      let damage: unknown[] = [];
      const asked = await drawingsAsked(el, async () => {
        damage = await damageOf(el, () => {
          root.attribs.class = value;
          el.touchDocument([
            {
              type: 'attributes',
              target: root,
              attributeName: 'class',
              oldValue: was,
            },
          ]);
        });
      });
      await act();
      return { asked, damage };
    };
    const given = await set('on', null);
    assert.deepStrictEqual(given.asked, ['reached']);
    assert.ok(given.damage.length > 0 && !given.damage.includes(el));
    // a rule whose subject names a shape, and gives it nothing it draws
    const named = await set('on plain', 'on');
    assert.deepStrictEqual(named.asked, ['named']);
    assert.deepStrictEqual(named.damage, []);
    // and one that reaches none
    const none = await set('on plain para', 'on plain');
    assert.deepStrictEqual(none.asked, []);
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

test('a change that reaches a shape asks nothing where no rule gives a shape anything', async () => {
  const { result, node } = await render(
    `<style>.on rect{background:#ff0000}</style><div id="top">${drawing('s')}</div>`,
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const top = byId(el, 'top');
  const asked = await drawingsAsked(el, async () => {
    top.attribs.class = 'on';
    el.touchDocument([
      {
        type: 'attributes',
        target: top,
        attributeName: 'class',
        oldValue: null,
      },
    ]);
    await act();
  });
  assert.deepStrictEqual(asked, []);
});

test('a change inside a drawing restyles what a :has() asking it can answer otherwise, and with none asking, nothing', async () => {
  // joshwcomeau.com animates a sparkle a path at a time, and with one
  // `:has()` anywhere in its sheets every frame restyled the whole page
  const { node } = await render(
    '<style>body{margin:0} .other:has(.x){color:#0000ff}' +
      ' .card:has(circle[fill="#00ff00"]){color:#00ff00}' +
      ' .card:has(rect){font-weight:bold}</style>' +
      '<div class="other" id="other"><span class="x"></span></div>' +
      '<div class="card" id="card"><svg width="60" height="40"><g id="g">' +
      '<circle id="c" cx="10" cy="20" r="8" fill="#ff0000"/></g></svg></div>' +
      '<p id="p">p</p>',
    300,
  );
  const el = view(node);
  await act();
  const card = byId(el, 'card');
  const circle = byId(el, 'c');
  // what no `:has()` tests: the drawing is drawn again, and nothing styled
  const moved = setAttr(circle, 'cx', '30');
  const none = scopeOf(el, [moved]);
  assert.ok(none, 'a refresh of everything');
  assert.equal(none.size, 0, `${none.size} restyled`);
  // what one tests: the element it can answer otherwise for, and no other
  const filled = setAttr(circle, 'fill', '#00ff00');
  const own = scopeOf(el, [filled]);
  assert.ok(own, 'a refresh of everything');
  assert.ok(own.has(card), 'the card is not restyled');
  assert.ok(!own.has(byId(el, 'other')), 'nor the rest left alone');
  assert.ok(!own.has(byId(el, 'p')));
  el.touchDocument([filled]);
  await act();
  assert.equal(el.computedStyle(card)?.color, 'rgb(0, 255, 0)');
  // and what comes into it, which every `:has()` may ask about
  const g = byId(el, 'g');
  const rect = createElement('rect', { width: '4', height: '4' });
  appendChild(g, rect);
  const added: HtmlChange = {
    type: 'childList',
    target: g,
    addedNodes: [rect],
    removedNodes: [],
  };
  const grown = scopeOf(el, [added]);
  assert.ok(grown, 'a refresh of everything');
  assert.ok(grown.has(card), 'the card is not restyled');
  assert.ok(!grown.has(byId(el, 'p')));
  el.touchDocument([added]);
  await act();
  assert.equal(el.computedStyle(card)?.['font-weight'], '700');
});

/** A node put at the end of `target`, with its record. */
function appended(target: Element, node: ChildNode): HtmlChange {
  appendChild(target, node);
  return {
    type: 'childList',
    target,
    addedNodes: [node],
    removedNodes: [],
  };
}

/** A node taken out of the tree, with its record. */
function takenOut(node: ChildNode): HtmlChange {
  const target = node.parent as unknown as Element;
  removeNode(node);
  return {
    type: 'childList',
    target,
    addedNodes: [],
    removedNodes: [node],
  };
}

metric(
  'a sheet in a drawing, put in, taken out, written to or given a media, draws what a refresh of everything draws',
  async () => {
    // a drawing exported from an editor keeps its colours in a `<style>` of
    // its own, and what a script wrote to one waited for a refresh that
    // said nothing: the rect stayed black
    const BLUE = 'rect{fill:#0000ff}';
    const onResource = (r: ResourceRequest) =>
      r.kind === 'stylesheet' && r.url === 'blue.css'
        ? { kind: 'stylesheet' as const, text: BLUE }
        : null;
    const linked = (_: HtmlViewNode, holder: Element) =>
      appended(
        holder,
        createElement('link', {
          id: 's',
          rel: 'stylesheet',
          href: 'blue.css',
        }),
      );
    const black = '#000000';
    const blue = '#0000ff';
    const cases: {
      name: string;
      holds: string;
      /** What a script does first, told and drawn. */
      before?: (el: HtmlViewNode, holder: Element) => HtmlChange;
      change: (el: HtmlViewNode, holder: Element) => HtmlChange;
      ink: string;
      /** Whether all it did is add rules (`_sheetsAdded`). */
      adds: boolean;
    }[] = [
      {
        name: 'a text put in a <style>',
        holds: '<style id="s"></style>',
        change: (el) => appended(byId(el, 's'), createText(BLUE)),
        ink: blue,
        adds: true,
      },
      {
        name: 'a <style> written on to',
        holds: '<style id="s">/* ink */</style>',
        change: (el) => {
          const text = byId(el, 's').children[0] as unknown as { data: string };
          text.data += BLUE;
          return { type: 'characterData', target: text as never };
        },
        ink: blue,
        adds: true,
      },
      {
        name: 'a <style> put in',
        holds: '',
        change: (_, holder) =>
          appended(holder, createElement('style', {}, [createText(BLUE)])),
        ink: blue,
        adds: true,
      },
      {
        name: 'a <style> taken out',
        holds: `<style id="s">${BLUE}</style>`,
        change: (el) => takenOut(byId(el, 's') as unknown as ChildNode),
        ink: black,
        adds: false,
      },
      {
        name: 'a media a <style> no longer holds under',
        holds: `<style id="s">${BLUE}</style>`,
        change: (el) => setAttr(byId(el, 's'), 'media', 'print'),
        ink: black,
        adds: false,
      },
      {
        name: 'a media a <style> holds under again',
        holds: `<style id="s" media="print">${BLUE}</style>`,
        change: (el) => setAttr(byId(el, 's'), 'media', null),
        ink: blue,
        adds: true,
      },
      // one a script puts in, which Chromium, Firefox and WebKit read as a
      // sheet: the parser makes a `<link>` it meets in a drawing an SVG
      // element, which they do not
      {
        name: 'a <link> put in',
        holds: '',
        change: linked,
        ink: blue,
        adds: true,
      },
      {
        name: 'a <link> taken out',
        holds: '',
        before: linked,
        change: (el) => takenOut(byId(el, 's') as unknown as ChildNode),
        ink: black,
        adds: false,
      },
      {
        name: 'a media a <link> no longer holds under',
        holds: '',
        before: linked,
        change: (el) => setAttr(byId(el, 's'), 'media', 'print'),
        ink: black,
        adds: false,
      },
    ];
    // where it stands: in a group, and at the root of the drawing, which a
    // change to what the root holds reaches by another way
    const stands: [string, (holds: string) => string][] = [
      [
        'a group',
        (holds) => `<svg ${SIZE}><g id="h">${holds}</g>${RECT}</svg>`,
      ],
      ['the root', (holds) => `<svg id="h" ${SIZE}>${holds}${RECT}</svg>`],
    ];
    for (const { name, holds, before, change, ink, adds } of cases) {
      for (const [where, drawing] of stands) {
        const message = `${name} in ${where}`;
        const { result, node } = await render(
          '<style>body{margin:0}svg{display:block}</style>' +
            `${drawing(holds)}<svg ${SIZE}>${RECT}</svg>`,
          200,
          { onResource },
        );
        const el = view(node);
        await snapshot(result, el);
        if (before) {
          el.touchDocument([before(el, byId(el, 'h'))]);
          await snapshot(result, el);
        }
        const internals = el as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        const sheetsAdded = internals._sheetsAdded;
        let answer: unknown;
        internals._sheetsAdded = function (this: unknown, ...a: unknown[]) {
          answer = sheetsAdded.apply(this, a);
          return answer;
        };
        el.touchDocument([change(el, byId(el, 'h'))]);
        const told = await snapshot(result, el);
        delete internals._sheetsAdded;
        assert.notStrictEqual(answer, undefined, `${message}: not read`);
        assert.strictEqual(answer instanceof Set, adds, `${message}: reach`);
        // what a sheet says is the document's: the drawing beside it too
        await expectPixel(result.ctx, 12, 12, ink, { message });
        await expectPixel(result.ctx, 12, 36, ink, { message });
        el.touchDocument();
        assert.strictEqual(
          bytesApart(told, await snapshot(result, el)),
          0,
          message,
        );
        result.unmount();
        cleanup();
      }
    }
  },
);

metric(
  'a rule written to a sheet in a drawing styles what it names, and a change to a shape beside the sheet costs the drawing and no more',
  async () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, i) => `<p id="p${i}">Paragraph ${i}</p>`,
    ).join('');
    const { result, node } = await render(
      '<!doctype html><html><head><style>body{margin:0} p{margin:0}</style>' +
        `</head><body><svg ${SIZE}><style id="s"></style><g id="g"></g>` +
        `${RECT}</svg>${paragraphs}</body></html>`,
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const box = (id: string) =>
      (el as unknown as { _firstBoxesOf(t: unknown): Map<Element, unknown> })
        ._firstBoxesOf(treeOf(el))
        .get(byId(el, id));
    const tree = treeOf(el);
    const cascade = cascadeOf(el);
    // a shape changed, and one put in: the drawing is drawn again, and the
    // sheets are as they were read
    const changes = [
      setAttr(byId(el, 'r'), 'width', '12'),
      appended(
        byId(el, 'g'),
        createElement('rect', { width: '4', height: '4' }),
      ),
    ];
    for (const change of changes) {
      assert.strictEqual(sheetsOf(el, [change]), false);
      assert.equal(scopeOf(el, [change])?.size, 0);
      const damage = await damageOf(el, () => el.touchDocument([change]));
      await act();
      assert.ok(treeOf(el) === tree, 'built again');
      assert.ok(cascadeOf(el) === cascade, 'the cascade was made again');
      assert.ok(damage.length > 0 && !damage.includes(el), 'all of it drawn');
    }
    // a rule: the paragraph it names, and no other box
    const far = box('p30');
    const internals = el as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const sheetsAdded = internals._sheetsAdded;
    let answer: unknown;
    internals._sheetsAdded = function (this: unknown, ...a: unknown[]) {
      answer = sheetsAdded.apply(this, a);
      return answer;
    };
    el.touchDocument([
      appended(byId(el, 's'), createText('#p7{color:#ff0000}')),
    ]);
    const told = await snapshot(result, el);
    delete internals._sheetsAdded;
    const reached = answer as Set<Element>;
    assert.ok(reached instanceof Set, 'every element styled again');
    assert.ok(reached.size === 1 && reached.has(byId(el, 'p7')));
    assert.ok(box('p30') === far, 'what its rule does not style was built');
    assert.strictEqual(
      el.computedStyle(byId(el, 'p7'))?.color,
      'rgb(255, 0, 0)',
    );
    el.touchDocument();
    assert.strictEqual(bytesApart(told, await snapshot(result, el)), 0);
  },
);

metric(
  'a <meta> or a <base> in a drawing is a change to every style, as one anywhere is, and a sheet in a shadow tree’s drawing is its tree’s',
  async () => {
    const block = `style="display:block" ${SIZE}`;
    const { result, node } = await render(
      `<style>body{margin:0}</style><svg ${block}><g id="g"></g>${RECT}</svg>` +
        '<div id="host"><template shadowrootmode="open">' +
        `<svg ${block}><style></style>${RECT}</svg></template></div>`,
      200,
    );
    const el = view(node);
    await snapshot(result, el);
    // each asked with the last change laid out, before which a scope is
    // not asked
    const g = byId(el, 'g');
    const pragmas: [string, Record<string, string>][] = [
      ['meta', { name: 'color-scheme', content: 'dark' }],
      ['base', { href: 'https://a.test/' }],
    ];
    for (const [tag, attribs] of pragmas) {
      assert.ok(scopeOf(el, []), 'the refresh of everything is still due');
      const change = appended(g, createElement(tag, attribs));
      assert.strictEqual(
        scopeOf(el, [change]),
        null,
        `a <${tag}> reached some`,
      );
      el.touchDocument([change]);
      await act();
    }
    const root = shadowRootOf(byId(el, 'host'))!;
    const drawing = root.children.find(
      (n) => (n as Element).name === 'svg',
    ) as Element;
    const style = drawing.children.find(
      (n) => (n as Element).name === 'style',
    ) as Element;
    const written = appended(style, createText('rect{fill:#0000ff}'));
    assert.ok(sheetsOf(el, [written]), 'a tree’s sheet was no sheet');
    el.touchDocument([written]);
    await snapshot(result, el);
    await expectPixel(result.ctx, 12, 12, '#000000');
    await expectPixel(result.ctx, 12, 36, '#0000ff');
  },
);

metric(
  'a sheet in a drawing that comes in chunks is read as it comes',
  async () => {
    const head =
      '<!doctype html><html><head><style>body{margin:0}svg{display:block}' +
      '</style></head><body>';
    const documents = [
      // cut inside the sheet's text
      [`<svg ${SIZE}><style>rect{fi`, `ll:#0000ff}</style>${RECT}</svg>`],
      // a sheet in a chunk of its own, after what it styles
      [
        `<svg ${SIZE}>${RECT}<g>`,
        '<style>rect{fill:#0000ff}</style></g></svg>',
      ],
    ];
    for (const parts of documents) {
      const doc = (source: string) =>
        h(
          'box',
          { style: { width: 200, flexDirection: 'column' } },
          h(Html, { source, partial: true, 'data-testname': 'doc' }),
        );
      let source = head + parts[0];
      const { result, node } = await render(source, 200, { partial: true });
      const el = view(node);
      await snapshot(result, el);
      for (const part of parts.slice(1)) {
        source += part;
        await act(() => result.rerender(doc(source)));
        await act();
      }
      const told = await snapshot(result, el);
      await expectPixel(result.ctx, 12, 12, '#0000ff', {
        message: JSON.stringify(parts),
      });
      el.touchDocument();
      assert.strictEqual(bytesApart(told, await snapshot(result, el)), 0);
      result.unmount();
      cleanup();
    }
  },
);

test('a child coming or going reaches what a test of where its siblings sit can answer otherwise for, and not all its holder holds', async () => {
  // A webmail page hides a split button's separator by where the button
  // sits, `.btn:not(:last-child) .label`, and has a `+` in its sheets:
  // each popup it put at the end of its <body> restyled all 13,000 of its
  // elements, a hidden strip of senders among them
  const strip = Array.from(
    { length: 40 },
    (_, i) => `<span class="label" id="s${i}">${i}</span>`,
  ).join('');
  const { node } = await render(
    '<style>body{margin:0} .btn:not(:last-child) .label{color:#ff0000}' +
      ' .a + .b{color:#00aa00} li:last-child{font-weight:bold}</style>' +
      '<main id="page"><div id="bar"><span class="btn" id="b1"><i class="label" id="l1">x' +
      '</i></span><span class="btn" id="b2"><i class="label" id="l2">y</i>' +
      '</span></div>' +
      '<div id="list"><p class="a" id="pa">a</p><p class="b" id="pb">b</p>' +
      '<p id="pc">c</p></div><ul id="ul"><li id="li1">1</li></ul>' +
      `<div id="strip">${strip}</div></main>`,
    300,
  );
  const el = view(node);
  await act();
  const bodyEl = byId(el, 'page');
  const red = 'rgb(255, 0, 0)';
  // at the end of what holds the page: what came, and none of what was
  // there
  const popup = createElement('div', { class: 'popup' });
  appendChild(bodyEl, popup);
  const put: HtmlChange = {
    type: 'childList',
    target: bodyEl,
    addedNodes: [popup],
    removedNodes: [],
    previousSibling: popup.prev,
    nextSibling: null,
  };
  const end = scopeOf(el, [put]);
  assert.ok(end, 'a refresh of everything');
  assert.ok(end.has(popup), 'what came is not styled');
  for (const id of ['l1', 'l2', 'pb', 's0', 's39']) {
    assert.ok(!end.has(byId(el, id)), `${id} restyled`);
  }
  el.touchDocument([put]);
  await act();
  // and two taken out at once, the first's record naming the second as
  // what was after it, which is gone too as the list is read
  const popup2 = createElement('div', { class: 'popup' });
  appendChild(bodyEl, popup2);
  el.touchDocument([
    {
      type: 'childList',
      target: bodyEl,
      addedNodes: [popup2],
      removedNodes: [],
      previousSibling: popup,
      nextSibling: null,
    },
  ]);
  await act();
  removeNode(popup as never);
  removeNode(popup2 as never);
  const both: HtmlChange[] = [
    {
      type: 'childList',
      target: bodyEl,
      addedNodes: [],
      removedNodes: [popup],
      previousSibling: byId(el, 'strip'),
      nextSibling: popup2,
    },
    {
      type: 'childList',
      target: bodyEl,
      addedNodes: [],
      removedNodes: [popup2],
      previousSibling: byId(el, 'strip'),
      nextSibling: null,
    },
  ];
  const gone = scopeOf(el, both);
  assert.ok(gone, 'a refresh of everything');
  for (const id of ['l1', 'pb', 's0']) {
    assert.ok(!gone.has(byId(el, id)), `${id} restyled as they went`);
  }
  el.touchDocument(both);
  await act();
  // a button after the last: the last's label is under one that is not
  // last now, which nothing after it reaches — and what is in the strip is
  // not
  const bar = byId(el, 'bar');
  const b3 = createElement('span', { class: 'btn' }, [
    createElement('i', { class: 'label' }),
  ]);
  appendChild(bar, b3);
  const after3: HtmlChange = {
    type: 'childList',
    target: bar,
    addedNodes: [b3],
    removedNodes: [],
    previousSibling: byId(el, 'b2'),
    nextSibling: null,
  };
  const moved = scopeOf(el, [after3]);
  assert.ok(moved, 'a refresh of everything');
  assert.ok(moved.has(byId(el, 'l2')), 'the label under it is not restyled');
  assert.ok(!moved.has(byId(el, 's0')), 'the strip is restyled');
  assert.notEqual(el.computedStyle(byId(el, 'l2'))?.color, red);
  el.touchDocument([after3]);
  await act();
  assert.equal(el.computedStyle(byId(el, 'l2'))?.color, red);
  // the `.a` before a `.b` taken out: what was after it
  const pa = byId(el, 'pa');
  const list = byId(el, 'list');
  removeNode(pa as never);
  const out: HtmlChange = {
    type: 'childList',
    target: list,
    addedNodes: [],
    removedNodes: [pa],
    previousSibling: null,
    nextSibling: byId(el, 'pb'),
  };
  const after = scopeOf(el, [out]);
  assert.ok(after, 'a refresh of everything');
  assert.ok(after.has(byId(el, 'pb')), 'what followed it is not restyled');
  assert.ok(!after.has(byId(el, 'l2')));
  el.touchDocument([out]);
  await act();
  assert.notEqual(el.computedStyle(byId(el, 'pb'))?.color, 'rgb(0, 170, 0)');
  // and an <li> after the last: the last is last no longer
  const ul = byId(el, 'ul');
  const li2 = createElement('li', {}, [createText('2')]);
  appendChild(ul, li2);
  const grown: HtmlChange = {
    type: 'childList',
    target: ul,
    addedNodes: [li2],
    removedNodes: [],
    previousSibling: byId(el, 'li1'),
    nextSibling: null,
  };
  const last = scopeOf(el, [grown]);
  assert.ok(last?.has(byId(el, 'li1')), 'the last <li> is not restyled');
  el.touchDocument([grown]);
  await act();
  assert.equal(el.computedStyle(byId(el, 'li1'))?.['font-weight'], '400');
  assert.equal(el.computedStyle(li2)?.['font-weight'], '700');
});

test('below a child whose place changed, what a test of the place reaches is its rule’s subject', async () => {
  const { node } = await render(
    '<style>body{margin:0} .row:last-child .cell{color:#ff0000}</style>' +
      '<div id="rows"><div class="row" id="r1"><span class="cell" id="c1">' +
      'a</span><span id="n1">b</span></div></div>',
    300,
  );
  const el = view(node);
  await act();
  const rows = byId(el, 'rows');
  const r2 = createElement('div', { class: 'row' });
  appendChild(rows, r2);
  const put: HtmlChange = {
    type: 'childList',
    target: rows,
    addedNodes: [r2],
    removedNodes: [],
    previousSibling: byId(el, 'r1'),
    nextSibling: null,
  };
  const own = scopeOf(el, [put]);
  assert.ok(own, 'a refresh of everything');
  assert.ok(own.has(byId(el, 'c1')), 'the cell is not restyled');
  assert.ok(!own.has(byId(el, 'n1')), 'what is beside it is restyled');
  el.touchDocument([put]);
  await act();
  assert.notEqual(el.computedStyle(byId(el, 'c1'))?.color, 'rgb(255, 0, 0)');
});

test('a child coming or going restyles the children a test of where they sit can be of, and the holder a test of what it holds can', async () => {
  // A popup's `> :first-child` names its parent and nothing of the child,
  // and `:empty` asks of what holds what came: every child of a webmail
  // page's <body> was restyled for each popup it put there
  const { node } = await render(
    '<style>body{margin:0} .menu > :first-child{color:#ff0000}' +
      ' div:empty{height:2px}</style>' +
      '<main id="page"><div id="d1">a</div><div id="d2">b</div></main>' +
      '<div class="menu" id="menu"><span id="m1">x</span></div>',
    300,
  );
  const el = view(node);
  await act();
  const page = byId(el, 'page');
  const extra = createElement('div', {}, [createText('c')]);
  appendChild(page, extra);
  const put: HtmlChange = {
    type: 'childList',
    target: page,
    addedNodes: [extra],
    removedNodes: [],
    previousSibling: byId(el, 'd2'),
    nextSibling: null,
  };
  const own = scopeOf(el, [put]);
  assert.ok(own, 'a refresh of everything');
  assert.ok(!own.has(byId(el, 'd1')), 'a child of no menu is restyled');
  assert.ok(!own.has(page), 'what holds them is restyled');
  el.touchDocument([put]);
  await act();
  // and in a menu, the child that was first and is not now
  const menu = byId(el, 'menu');
  const m0 = createElement('span', {}, [createText('w')]);
  DomUtils.prepend(byId(el, 'm1') as never, m0 as never);
  const first: HtmlChange = {
    type: 'childList',
    target: menu,
    addedNodes: [m0],
    removedNodes: [],
    previousSibling: null,
    nextSibling: byId(el, 'm1'),
  };
  const moved = scopeOf(el, [first]);
  assert.ok(moved?.has(byId(el, 'm1')), 'the first child is not restyled');
  el.touchDocument([first]);
  await act();
  assert.notEqual(el.computedStyle(byId(el, 'm1'))?.color, 'rgb(255, 0, 0)');
  assert.equal(el.computedStyle(m0)?.color, 'rgb(255, 0, 0)');
});

/** What a refresh told of `changes` would restyle by itself, or null where
 *  it would restyle everything. */
function scopeOf(el: HtmlViewNode, changes: HtmlChange[]): Set<Element> | null {
  const node = el as unknown as {
    _source: { touch(): void };
    _changeScope(c: HtmlChange[]): { own: Set<Element> } | null;
  };
  // the document's facts read again, as `touchDocument` has them
  node._source.touch();
  return node._changeScope(changes)?.own ?? null;
}

/** Whether a refresh told of `changes` makes the cascade again before its
 *  build (`ChangeScope.sheets`): a change to a sheet of the document's. */
function sheetsOf(el: HtmlViewNode, changes: HtmlChange[]): boolean {
  const node = el as unknown as {
    _source: { touch(): void };
    _changeScope(c: HtmlChange[]): { sheets?: boolean } | null;
  };
  node._source.touch();
  return node._changeScope(changes)?.sheets === true;
}

/** An attribute set, or taken away for `null`, with its record. */
function setAttr(
  target: Element,
  name: string,
  value: string | null,
): HtmlChange {
  const oldValue = target.attribs[name] ?? null;
  if (value === null) delete target.attribs[name];
  else target.attribs[name] = value;
  return { type: 'attributes', target, attributeName: name, oldValue };
}

test('a stylesheet prop made again with the sheets it held styles nothing again, and one with other sheets restyles everything', async () => {
  // what `<Html scripts>` hands down at every render where the page adopted
  // a sheet: the application's sheets and the page's, in an array made then
  const doc = '<style>body{margin:0}</style><p id="p">p</p><p id="q">q</p>';
  const sheets = (extra: string) =>
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, {
        source: doc,
        partial: false,
        'data-testname': 'doc',
        stylesheet: ['p { color: #00aa00 }', extra],
      }),
    );
  const { result, node } = await render(doc, 300, {
    stylesheet: ['p { color: #00aa00 }', '#q { color: #ff0000 }'],
  });
  const el = view(node);
  await act();
  const computed = await stylesComputed(el, async () => {
    await act(() => result.rerender(sheets('#q { color: #ff0000 }')));
  });
  assert.strictEqual(computed, 0, `${computed} styles worked out again`);
  await act(() => result.rerender(sheets('#q { color: #0000ff }')));
  assert.strictEqual(el.computedStyle(byId(el, 'q'))?.color, 'rgb(0, 0, 255)');
});

test('a cascade made for a sheet that came keeps what it knew of the rules before it, and learns the new', async () => {
  const { result, node } = await render(
    '<style>body{margin:0} .old[data-x] { color: #00aa00 }</style>' +
      '<body><p class="old" id="old">old</p><p class="new" id="new">new</p>' +
      '<style id="gone">.gone[data-z] { color: #ff0000 }</style></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const internals = el as unknown as {
    _cascade: {
      attributeChange(name: string, was: null, now: string): { bits: number };
      _changeRules: { note(...a: unknown[]): void };
    };
  };
  const reach = (name: string) =>
    internals._cascade.attributeChange(name, null, '').bits;
  assert.ok(reach('data-x'), 'the first sheet was not read');
  const before = internals._cascade;
  const reading = before._changeRules;
  const note = reading.note;
  let read = 0;
  reading.note = function (this: unknown, ...a: unknown[]) {
    read += 1;
    note.apply(this, a);
  };
  const body = byId(el, 'old').parent as Element;
  const style = createElement('style', {}, [
    createText('.new[data-y] { color: #0000ff }'),
  ]);
  appendChild(body, style);
  el.touchDocument([
    { type: 'childList', target: body, addedNodes: [style], removedNodes: [] },
  ]);
  await snapshot(result, el);
  assert.ok(internals._cascade !== before, 'the cascade was kept');
  assert.ok(internals._cascade._changeRules === reading, 'all read again');
  assert.strictEqual(read, 1, 'rules read before were read again');
  // the rule before it and the rule that came, each told of a change
  assert.ok(reach('data-x'), 'what the first sheet tests was forgotten');
  assert.ok(reach('data-y'), 'the new sheet was not read');
  const next = byId(el, 'new');
  next.attribs['data-y'] = '';
  el.touchDocument([
    {
      type: 'attributes',
      target: next,
      attributeName: 'data-y',
      oldValue: null,
    },
  ]);
  await snapshot(result, el);
  assert.equal(el.computedStyle(next)?.color, 'rgb(0, 0, 255)');
  // a sheet gone leaves what it tested read, which reaches more, not less
  const gone = byId(el, 'gone');
  removeNode(gone as unknown as ChildNode);
  el.touchDocument([
    { type: 'childList', target: body, addedNodes: [], removedNodes: [gone] },
  ]);
  await snapshot(result, el);
  assert.ok(reach('data-x'), 'what the first sheet tests was forgotten');
  // and enough of them read it afresh, or a page that writes a new sheet at
  // every step would hold every one it wrote
  const text = style.children[0] as unknown as { data: string };
  for (let i = 0; i < 24; i += 1) {
    text.data = `.new[data-w${i}] { color: #0000ff }`;
    el.touchDocument([{ type: 'characterData', target: text as never }]);
    await act();
  }
  assert.ok(
    internals._cascade._changeRules !== reading,
    'it was held for good',
  );
});

test('a sheet that comes late builds what its rules style, and keeps every other box', async () => {
  let arrive: (result: ResourceResult) => void = () => {};
  const onResource = (r: ResourceRequest) =>
    r.kind === 'stylesheet'
      ? new Promise<ResourceResult>((resolve) => (arrive = resolve))
      : null;
  const { result, node } = await render(
    '<!doctype html><html><head></head><body><div id="far">far</div>' +
      '<section><div id="q">q</div><div id="gone">gone</div></section>' +
      '<div id="last">last</div></body></html>',
    300,
    { onResource },
  );
  const el = view(node);
  await snapshot(result, el);
  const box = (id: string) =>
    (el as unknown as { _firstBoxesOf(t: unknown): Map<Element, unknown> })
      ._firstBoxesOf(treeOf(el))
      .get(byId(el, id));
  const far = box('far');
  const body = byId(el, 'far').parent as Element;
  const link = createElement('link', { rel: 'stylesheet', href: 'late.css' });
  appendChild(body, link);
  el.touchDocument([
    { type: 'childList', target: body, addedNodes: [link], removedNodes: [] },
  ]);
  await act();
  arrive({
    kind: 'stylesheet',
    text: '#q { color: #0000ff; display: flex } #gone { display: none }',
  });
  await snapshot(result, el);
  assert.ok(box('far') === far, 'what its rules do not style was built');
  assert.strictEqual(el.computedStyle(byId(el, 'q'))?.color, 'rgb(0, 0, 255)');
  assert.strictEqual(el.computedStyle(byId(el, 'q'))?.display, 'flex');
  assert.equal(drawnText(el).replace(/\s+/g, ''), 'farqlast');
  // and a sheet that does more than add rules styles everything
  arrive = () => {};
  const other = createElement('link', { rel: 'stylesheet', href: 'other.css' });
  appendChild(body, other);
  el.touchDocument([
    { type: 'childList', target: body, addedNodes: [other], removedNodes: [] },
  ]);
  await act();
  arrive({
    kind: 'stylesheet',
    text: '@font-face { font-family: x; src: url(x.woff) } #far { color: #00aa00 }',
  });
  await snapshot(result, el);
  assert.strictEqual(
    el.computedStyle(byId(el, 'far'))?.color,
    'rgb(0, 170, 0)',
  );
});

test('an element that comes out drawn, or hidden, builds what holds it, or the end of a body', async () => {
  const { result, node } = await render(
    '<!doctype html><html><head><style>body{margin:0} .off{display:none}</style></head>' +
      '<body><div id="far">far</div><section><p id="a" class="off">a</p><p>b</p></section>' +
      '<div id="c" class="off">c</div><div id="d">d</div></body></html>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const box = (id: string) =>
    (el as unknown as { _firstBoxesOf(t: unknown): Map<Element, unknown> })
      ._firstBoxesOf(treeOf(el))
      .get(byId(el, id));
  const far = box('far');
  const set = async (id: string, value: string | null) => {
    const target = byId(el, id);
    const was = target.attribs.class ?? null;
    if (value === null) delete target.attribs.class;
    else target.attribs.class = value;
    el.touchDocument([
      { type: 'attributes', target, attributeName: 'class', oldValue: was },
    ]);
    await snapshot(result, el);
    assert.ok(box('far') === far, `${id} built what is around it`);
  };
  await set('a', null);
  assert.equal(drawnText(el).replace(/\s+/g, ''), 'farabd');
  await set('a', 'off');
  assert.equal(drawnText(el).replace(/\s+/g, ''), 'farbd');
  // a child of the `<body>`, which no root is around
  await set('c', null);
  assert.equal(drawnText(el).replace(/\s+/g, ''), 'farbcd');
  await set('c', 'off');
  assert.equal(drawnText(el).replace(/\s+/g, ''), 'farbd');
});

test('a key tested through a function reaches what its rule names, and a child sits where a combinator says', async () => {
  const { node } = await render(
    '<style>body{margin:0} x-a:not(:defined) .i { color: #ff0000 } .g > :first-child .b { color: #00aa00 } :is(.u .v) .w { color: #0000ff } .t :first-child .under { color: #ff00ff }</style>' +
      '<body><x-a id="a"><p class="i" id="i">i</p><p id="other">o</p></x-a>' +
      '<div id="plain"><p class="b" id="deep">d</p><p class="under" id="under">u</p></div>' +
      '<div id="u"><div class="v"><p class="w" id="w">w</p><p id="x">x</p></div></div></body>',
    300,
  );
  const el = view(node);
  await act();
  const a = byId(el, 'a');
  a.attribs['-rx-defined'] = '';
  const reached = scopeOf(el, [
    {
      type: 'attributes',
      target: a,
      attributeName: '-rx-defined',
      oldValue: null,
    },
  ]);
  assert.ok(reached?.has(byId(el, 'i')), 'what the rule names was not reached');
  assert.ok(!reached?.has(byId(el, 'other')), 'all of the element was reached');
  // a child put in what is no `.g`
  const body = a.parent as Element;
  const child = createElement('div', {}, [createText('n')]);
  appendChild(body, child);
  const scope = scopeOf(el, [
    { type: 'childList', target: body, addedNodes: [child], removedNodes: [] },
  ]);
  assert.ok(!scope?.has(byId(el, 'deep')), 'all of the body was reached');
  assert.ok(!scope?.has(byId(el, 'under')), 'a descendant’s rule reached it');
  // and what is above a subject inside a function
  const u = byId(el, 'u');
  u.attribs.class = 'u';
  const inside = scopeOf(el, [
    { type: 'attributes', target: u, attributeName: 'class', oldValue: null },
  ]);
  assert.ok(inside?.has(byId(el, 'w')), 'what the rule names was not reached');
  assert.ok(!inside?.has(byId(el, 'x')), 'all of the element was reached');
});

test('a change to a <link>, a <style> or a <meta> restyles everything only where it changes what the cascade reads', async () => {
  // the sheets the host answers with, at once, and one it answers later
  const sheets: Record<string, string> = {
    'one.css': '#q { font-weight: bold }',
    'two.css': '#q { font-style: italic }',
    'three.css': '#q { text-decoration: underline }',
  };
  let arrive: (result: ResourceResult) => void = () => {};
  const onResource = (r: ResourceRequest) => {
    if (r.kind !== 'stylesheet') return null;
    if (r.url === 'late.css') {
      return new Promise<ResourceResult>((resolve) => (arrive = resolve));
    }
    const text = sheets[r.url];
    return text ? { kind: 'stylesheet' as const, text } : null;
  };
  const { node } = await render(
    '<p id="first">first</p><link rel="icon" id="icon" href="a.svg">' +
      '<link rel="stylesheet" id="s1" href="one.css" data-rspack-loading="1">' +
      '<link rel="stylesheet" id="s2" href="two.css">' +
      '<link rel="stylesheet" id="s3" href="three.css">' +
      '<style id="st">body{margin:0} link[data-rspack-loading] ~ p{color:#ff0000}</style>' +
      '<meta id="m" name="x" content="y"><p id="p">p</p><p id="q">q</p>' +
      '<div id="box"></div><div id="host"><template shadowrootmode="open">' +
      '<b id="inner">in</b></template></div>',
    300,
    { onResource },
  );
  const el = view(node);
  await act();
  const p = byId(el, 'p');
  const q = byId(el, 'q');
  assert.strictEqual(el.computedStyle(p)?.color, 'rgb(255, 0, 0)');
  assert.strictEqual(el.computedStyle(q)?.['font-style'], 'italic');
  // a bundler's mark taken off the sheet it loaded: what tests it — the
  // link's later siblings — is restyled, and nothing else
  const loaded = setAttr(byId(el, 's1'), 'data-rspack-loading', null);
  const own = scopeOf(el, [loaded]);
  assert.ok(own, 'a mark on a <link> was a refresh of everything');
  assert.ok(own.has(p), 'what tests the mark is not restyled');
  assert.ok(!own.has(byId(el, 'first')), 'what is before it is restyled');
  el.touchDocument([loaded]);
  assert.notStrictEqual(el.computedStyle(p)?.color, 'rgb(255, 0, 0)');
  // an icon's href, a <style>'s type, a <meta>'s data, and the content of
  // a <meta> no pragma reads: the element itself at most, since a `:link`
  // reads an `href`
  const quiet = [
    setAttr(byId(el, 'icon'), 'href', 'b.svg'),
    setAttr(byId(el, 'st'), 'type', 'text/css'),
    setAttr(byId(el, 'm'), 'data-x', '1'),
    setAttr(byId(el, 'm'), 'content', 'z'),
  ];
  for (const change of quiet) {
    const scoped = scopeOf(el, [change]);
    assert.ok(
      scoped && scoped.size <= 1,
      `${change.type === 'attributes' && change.attributeName} restyled`,
    );
  }
  el.touchDocument(quiet);
  // a <link> put in for a script's chunk, and one for a sheet that is not
  // in yet, which is a change when it comes
  const box = byId(el, 'box');
  const added = (...nodes: Element[]): HtmlChange => {
    for (const n of nodes) appendChild(box, n);
    return {
      type: 'childList',
      target: box,
      addedNodes: nodes,
      removedNodes: [],
    };
  };
  const preload = added(
    createElement('link', { rel: 'preload', href: 'c.js' }),
  );
  assert.ok(scopeOf(el, [preload]), 'a preload was a refresh of everything');
  el.touchDocument([preload]);
  const late = added(
    createElement('link', { rel: 'stylesheet', href: 'late.css' }),
  );
  assert.ok(scopeOf(el, [late]), 'a sheet not in yet restyled everything');
  el.touchDocument([late]);
  await act();
  arrive({ kind: 'stylesheet', text: '#q { color: #0000ff }' });
  await act();
  assert.strictEqual(el.computedStyle(q)?.color, 'rgb(0, 0, 255)');
  // a <style> put in makes the cascade again before the build, which
  // styles what its rules can style
  const style = added(
    createElement('style', {}, [createText('#q{color:#00aa00}')]),
  );
  assert.ok(sheetsOf(el, [style]), 'a sheet was no change to the cascade');
  el.touchDocument([style]);
  await act();
  assert.strictEqual(el.computedStyle(q)?.color, 'rgb(0, 170, 0)');
  // a <meta> the cascade reads, and one a page's scripts put in for its
  // social cards, which is an element like any
  const card = added(
    createElement('meta', { property: 'og:title', content: 'q' }),
    createElement('meta', { name: 'referrer', content: 'origin' }),
  );
  assert.ok(scopeOf(el, [card]), 'a card’s <meta> restyled everything');
  el.touchDocument([card]);
  await act();
  for (const attribs of <Record<string, string>[]>[
    { name: 'color-scheme', content: 'dark' },
    { 'http-equiv': 'Content-Language', content: 'fr' },
  ]) {
    const meta = added(createElement('meta', attribs));
    assert.strictEqual(
      scopeOf(el, [meta]),
      null,
      'a <meta> restyled only some',
    );
    el.touchDocument([meta]);
    await act();
  }
  // a shadow tree's sheets are its own, bound to it by how they read
  const root = shadowRootOf(byId(el, 'host'))!;
  const inTree = createElement('style', {}, [createText('b{color:#00aa00}')]);
  appendChild(root as unknown as Element, inTree);
  const treeSheet: HtmlChange = {
    type: 'childList',
    target: root as never,
    addedNodes: [inTree],
    removedNodes: [],
  };
  assert.ok(sheetsOf(el, [treeSheet]), 'a tree’s sheet was no sheet');
  el.touchDocument([treeSheet]);
  await act();
  const inner = root.children.find(
    (n) => (n as Element).name === 'b',
  ) as Element;
  assert.strictEqual(el.computedStyle(inner)?.color, 'rgb(0, 170, 0)');
  // a sheet that goes, by its media, its href or its rel — the cascade
  // made again, and every element styled again, since what it took away
  // styled what it did (`addedRules`) — and a pragma, each asked with the
  // last change laid out, before which a scope is not asked
  for (const make of [
    () => setAttr(byId(el, 's1'), 'media', 'print'),
    () => setAttr(byId(el, 's2'), 'href', 'none.css'),
    () => setAttr(byId(el, 's3'), 'rel', 'icon'),
    () => setAttr(byId(el, 'st'), 'media', 'print'),
  ]) {
    const change = make();
    assert.ok(
      sheetsOf(el, [change]),
      `${change.type === 'attributes' && change.attributeName} was no change to the cascade`,
    );
    el.touchDocument([change]);
    await act();
  }
  assert.notStrictEqual(el.computedStyle(q)?.['font-style'], 'italic');
  for (const make of [
    () => setAttr(byId(el, 'm'), 'name', 'color-scheme'),
    () => setAttr(byId(el, 'm'), 'name', 'x'),
  ]) {
    const change = make();
    assert.strictEqual(
      scopeOf(el, [change]),
      null,
      `${change.type === 'attributes' && change.attributeName} restyled only some`,
    );
    el.touchDocument([change]);
    await act();
    assert.ok(scopeOf(el, []), 'the refresh of everything is still due');
  }
});

test("a child put in reaches the later siblings of its new siblings, and its holder's own only where a rule asks what the holder holds before a sibling combinator", async () => {
  // The Guardian's ad scripts put a <script> in its <head> and take it out
  // some thirty times a load, and with a `+` anywhere in a sheet each one
  // restyled the whole <body>, as though the <head>'s own later siblings
  // were what a sibling combinator reaches
  const page = (rule: string) =>
    '<html><head><script></script></head><body><p id="a" class="a">a</p>' +
    `<p id="b" class="b">b</p></body></html><style>.a + .b { color: #ff0000 } ${rule}</style>`;
  const { node } = await render(page(''), 300);
  const el = view(node);
  await act();
  const head = byId(el, 'a').parent!.parent!.children.find(
    (n) => (n as Element).name === 'head',
  ) as Element;
  const script = createElement('script', {});
  appendChild(head as never, script);
  const putIn: HtmlChange = {
    type: 'childList',
    target: head as never,
    addedNodes: [script],
    removedNodes: [],
  };
  const own = scopeOf(el, [putIn]);
  assert.ok(own, 'a script in the <head> restyled everything');
  assert.ok(!own.has(byId(el, 'a')), 'the <body> was reached');
  el.touchDocument([putIn]);
  await act();
  assert.strictEqual(el.computedStyle(byId(el, 'b'))?.color, 'rgb(255, 0, 0)');

  // and where a rule asks whether the <head> is empty before a `+`, what it
  // holds reaches the <body> after it
  const { node: other } = await render(
    page('head:empty + body p { color: #0000ff }').replace(
      '<script></script>',
      '',
    ),
    300,
  );
  const el2 = view(other);
  await act();
  const p2 = byId(el2, 'a');
  assert.strictEqual(el2.computedStyle(p2)?.color, 'rgb(0, 0, 255)');
  const head2 = p2.parent!.parent!.children.find(
    (n) => (n as Element).name === 'head',
  ) as Element;
  const script2 = createElement('script', {});
  appendChild(head2 as never, script2);
  const filled: HtmlChange = {
    type: 'childList',
    target: head2 as never,
    addedNodes: [script2],
    removedNodes: [],
  };
  const reached = scopeOf(el2, [filled]);
  assert.ok(reached?.has(p2), 'what follows an emptied <head> was not reached');
  el2.touchDocument([filled]);
  await act();
  assert.notStrictEqual(el2.computedStyle(p2)?.color, 'rgb(0, 0, 255)');
});

test('a change a :has() anchors at the root of a long document is restyled in place where the root’s style comes out as it was', async () => {
  // Next.js puts scripts and styles in its <head> as it loads, and a
  // `:root:has(…)` in its sheets puts the root among the elements each one
  // reaches: the root and all it holds were more than a restyle in place
  // takes, and each was a build of the whole document. One that asks where
  // an element sits is reached by whatever comes (`:last-child`); one that
  // asks only of its subject, by what it names (the test after this one)
  const paragraphs = Array.from(
    { length: 400 },
    (_, i) => `<p id="p${i}">Paragraph ${i}</p>`,
  ).join('');
  const { result, node } = await render(
    '<html><head><script></script></head><body>' +
      paragraphs +
      '</body></html><style>p { margin: 0 } ' +
      'html:has(script.flag:last-child) { background: #00ff00 }</style>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const html = byId(el, 'p0').parent!.parent! as Element;
  const head = html.children.find(
    (n) => (n as Element).name === 'head',
  ) as Element;
  const putIn = (attribs: Record<string, string>): HtmlChange => {
    const script = createElement('script', attribs);
    appendChild(head as never, script);
    return {
      type: 'childList',
      target: head as never,
      addedNodes: [script],
      removedNodes: [],
    };
  };
  const plain = putIn({});
  assert.ok(scopeOf(el, [plain])?.has(html), 'the root was not reached');
  const tree = treeOf(el);
  const computed = await stylesComputed(el, async () => {
    el.touchDocument([plain]);
    await snapshot(result, el);
  });
  assert.ok(treeOf(el) === tree, 'the boxes were built again');
  assert.ok(computed > 0 && computed < 10, `${computed} styles worked out`);
  // and one that changes what the root draws still reaches it
  el.touchDocument([putIn({ class: 'flag' })]);
  await snapshot(result, el);
  assert.strictEqual(
    el.computedStyle(html)?.['background-color'],
    'rgb(0, 255, 0)',
  );
});

test('a node put in or taken out restyles a :has() that asks only of its subject where what came or went holds one', async () => {
  // joshwcomeau.com's `html:has([data-disable-document-scroll=true])`: every
  // sparkle its like button put in reached the root, and the root as a seed
  // built the whole document three times a second
  const { node } = await render(
    '<html><head><style>body{margin:0} html:has([data-lock]){color:#0000ff}' +
      ' .card:has(> .x .y){font-weight:bold}' +
      ' .list:has(li.a:first-child){color:#00aa00}</style></head><body>' +
      '<div class="card" id="card"><div class="x" id="x"></div></div>' +
      '<ul class="list" id="list"><li class="a" id="a">a</li></ul>' +
      '<p id="p">p</p></body></html>',
    300,
  );
  const el = view(node);
  await act();
  const html = byId(el, 'p').parent!.parent! as Element;
  assert.strictEqual(html.name, 'html');
  const p = byId(el, 'p');
  const card = byId(el, 'card');
  const ink = el.computedStyle(p)?.color;
  const added = (target: Element, node: ChildNode): HtmlChange => ({
    type: 'childList',
    target,
    addedNodes: [node],
    removedNodes: [],
  });
  // what holds nothing the subject names: no anchor
  const span = createElement('span', {});
  appendChild(p, span);
  const plain = scopeOf(el, [added(p, span)]);
  assert.ok(plain, 'a refresh of everything');
  assert.ok(!plain.has(html), 'the root is restyled');
  const z = createElement('span', { class: 'z' });
  appendChild(byId(el, 'x'), z);
  const other = scopeOf(el, [added(byId(el, 'x'), z)]);
  assert.ok(other && !other.has(card), 'the card is restyled');
  // what holds one, however deep: the anchors around it
  const wrap = createElement('i', {});
  appendChild(wrap, createElement('b', { 'data-lock': '' }));
  appendChild(p, wrap);
  const locked = scopeOf(el, [added(p, wrap)]);
  assert.ok(locked?.has(html), 'the root is not restyled');
  el.touchDocument([added(p, span), added(p, wrap)]);
  await act();
  assert.equal(el.computedStyle(p)?.color, 'rgb(0, 0, 255)');
  const y = createElement('span', { class: 'y' });
  appendChild(byId(el, 'x'), y);
  assert.ok(scopeOf(el, [added(byId(el, 'x'), y)])?.has(card));
  // and taken out, which is what went
  removeNode(wrap);
  const gone: HtmlChange = {
    type: 'childList',
    target: p,
    addedNodes: [],
    removedNodes: [wrap],
  };
  assert.ok(scopeOf(el, [gone])?.has(html), 'the root is not restyled');
  el.touchDocument([gone]);
  await act();
  assert.equal(el.computedStyle(p)?.color, ink);
  // A `:has()` that asks where an element sits is reached by any child
  // that comes: one put in before the list's first item takes it from
  // being first, and holds nothing the subject names
  const list = byId(el, 'list');
  assert.equal(el.computedStyle(list)?.color, 'rgb(0, 170, 0)');
  const first = createElement('li', {});
  DomUtils.prependChild(list as never, first as never);
  const before = scopeOf(el, [added(list, first)]);
  assert.ok(before?.has(list), 'the list is not restyled');
  el.touchDocument([added(list, first)]);
  await act();
  assert.equal(el.computedStyle(list)?.color, ink);
});

metric(
  'a node put into a long document restyles what a :has() asking only of its children, on a compound that names nothing, answers otherwise for, and not the document',
  async () => {
    // Apple's product pages style `:has(>.caption-primary) .caption`: an
    // anchor every element is, which made every change to their tree a
    // restyle, a build and a layout of all of it — 400 ms each forced read
    // of their script's took, which ran it into its time
    const paragraphs = Array.from(
      { length: 400 },
      (_, i) => `<p id="p${i}" class="caption">Paragraph ${i}</p>`,
    ).join('');
    const { result, node } = await render(
      '<style>body{margin:0} p{margin:0}' +
        ' :has(> .primary) .caption{color:#ff0000}</style><body>' +
        `<div id="box"><p id="cap" class="caption">caption</p></div>${paragraphs}</body>`,
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const box = byId(el, 'box');
    const body = box.parent as Element;
    const put = (into: Element, child: ChildNode): HtmlChange => {
      appendChild(into, child);
      return {
        type: 'childList',
        target: into,
        addedNodes: [child],
        removedNodes: [],
      };
    };
    // what holds a `.primary` below its own children changes the answer of
    // no element but its own, which comes with it
    const deep = put(
      body,
      createElement('div', {}, [createElement('span', { class: 'primary' })]),
    );
    const own = scopeOf(el, [deep]);
    assert.ok(own, 'a refresh of everything');
    assert.ok(!own.has(byId(el, 'p7')), 'the document was reached');
    const computed = await stylesComputed(el, async () => {
      el.touchDocument([deep]);
      await snapshot(result, el);
    });
    assert.ok(computed < 10, `${computed} styles worked out`);
    assert.notStrictEqual(
      el.computedStyle(byId(el, 'p7'))?.color,
      'rgb(255, 0, 0)',
    );
    // a `.primary` put in the box: the box's answer, and what it holds
    const primary = put(box, createElement('span', { class: 'primary' }));
    const reached = scopeOf(el, [primary]);
    assert.ok(reached?.has(byId(el, 'cap')), 'the box’s caption missed');
    assert.ok(!reached?.has(byId(el, 'p7')), 'the document was reached');
    el.touchDocument([primary]);
    await act();
    assert.strictEqual(
      el.computedStyle(byId(el, 'cap'))?.color,
      'rgb(255, 0, 0)',
    );
    // and a child of the body's made one: the body's, and all it holds
    const made = setClass(byId(el, 'p3'), 'caption primary');
    assert.ok(scopeOf(el, [made])?.has(byId(el, 'p7')), 'the body missed');
    el.touchDocument([made]);
    await act();
    assert.strictEqual(
      el.computedStyle(byId(el, 'p7'))?.color,
      'rgb(255, 0, 0)',
    );
  },
);

test('a class a sibling combinator tests reaches what its rule styles among what follows, and not all that follows', async () => {
  // Apple's local nav turns dark with `#ac-localnav.ac-localnav-dark ~
  // #ac-ln-curtain`, and each turn restyled and built all 5,000 elements
  // after it, to style one
  const paragraphs = Array.from(
    { length: 50 },
    (_, i) => `<p id="p${i}" class="p">p${i}</p>`,
  ).join('');
  const { node } = await render(
    '<style>body{margin:0} #nav.dark ~ #curtain{color:#ff0000}' +
      ' #nav.dark ~ main .note{color:#00aa00}' +
      ' #nav.dark + .next{color:#0000ff}</style>' +
      '<body><nav id="nav" class="light">n</nav><div id="next" class="next">x</div>' +
      `<div id="curtain">c</div><main id="main">${paragraphs}<i class="note" id="note">n</i></main></body>`,
    300,
  );
  const el = view(node);
  await act();
  const nav = byId(el, 'nav');
  nav.attribs.class = 'dark';
  const change: HtmlChange = {
    type: 'attributes',
    target: nav,
    attributeName: 'class',
    oldValue: 'light',
  };
  const own = scopeOf(el, [change]);
  assert.ok(own, 'a refresh of everything');
  for (const id of ['curtain', 'next', 'note']) {
    assert.ok(own.has(byId(el, id)), `${id} missed`);
  }
  assert.ok(!own.has(byId(el, 'p7')), 'all that follows was reached');
  assert.ok(!own.has(byId(el, 'main')));
  el.touchDocument([change]);
  await act();
  assert.strictEqual(
    el.computedStyle(byId(el, 'curtain'))?.color,
    'rgb(255, 0, 0)',
  );
  assert.strictEqual(
    el.computedStyle(byId(el, 'note'))?.color,
    'rgb(0, 170, 0)',
  );
  assert.strictEqual(
    el.computedStyle(byId(el, 'next'))?.color,
    'rgb(0, 0, 255)',
  );
});

test('a rule that says nothing of what it styles among what follows reaches all of it, as a rule whose old value is not known does', async () => {
  const { node } = await render(
    '<style>body{margin:0} .a ~ *{color:#ff0000} .b ~ .c{color:#00aa00}</style>' +
      '<body><i id="x">x</i><div id="y"><p id="p">p</p></div><i id="z" class="c">z</i></body>',
    300,
  );
  const el = view(node);
  await act();
  const x = byId(el, 'x');
  x.attribs.class = 'a';
  const own = scopeOf(el, [
    { type: 'attributes', target: x, attributeName: 'class', oldValue: null },
  ]);
  assert.ok(own?.has(byId(el, 'y')) && own.has(byId(el, 'p')));
  delete x.attribs.class;
  x.attribs.class = 'b';
  const unknown = scopeOf(el, [
    { type: 'attributes', target: x, attributeName: 'class' },
  ]);
  assert.ok(unknown?.has(byId(el, 'p')), 'an unknown old value says nothing');
});

test('a :has() of what an element holds is not asked of what is beside a change, whatever other :has() is', async () => {
  // Apple's cards style `.feature-card-content:has(~ .card-control)`, which
  // starts at a sibling, and their sections `.section:has(.pass)`, which
  // does not: every section before a dialog taken out of a card was a seed,
  // each built and laid out again, at 100 ms a read and 26 reads a task
  const { node } = await render(
    '<style>body{margin:0} .section:has(.pass){color:#ff0000}' +
      ' .content:has(~ .control) .caption{color:#00aa00}</style><body>' +
      '<section class="section" id="s0"><p>one</p></section>' +
      '<section class="section" id="s1"><p class="pass" id="pass">two</p></section>' +
      '<section class="section" id="s2"><div class="card" id="card">' +
      '<div class="content" id="content"><i class="caption" id="caption">c</i></div>' +
      '<b class="control" id="control">b</b><u id="dialog" class="pass">d</u></div></section></body>',
    300,
  );
  const el = view(node);
  await act();
  const card = byId(el, 'card');
  const dialog = byId(el, 'dialog');
  const next = dialog.next;
  const prev = dialog.prev;
  removeNode(dialog);
  const change: HtmlChange = {
    type: 'childList',
    target: card,
    addedNodes: [],
    removedNodes: [dialog],
    previousSibling: prev,
    nextSibling: next,
  };
  const own = scopeOf(el, [change]);
  assert.ok(own, 'a refresh of everything');
  assert.ok(!own.has(byId(el, 's0')), 'an earlier section was asked');
  assert.ok(!own.has(byId(el, 's1')), 'an earlier section was asked');
  assert.ok(own.has(byId(el, 's2')), 'the section around it is not asked');
  // and one that starts at a sibling still is, of what came before
  const control = byId(el, 'control');
  control.attribs.class = 'other';
  const asked = scopeOf(el, [
    {
      type: 'attributes',
      target: control,
      attributeName: 'class',
      oldValue: 'control',
    },
  ]);
  assert.ok(asked?.has(byId(el, 'caption')), 'the caption it styles is missed');
});

/** What holds the document's element of an id, its first box. */
const firstBox = (el: HtmlViewNode, id: string) => boxOf(el, id) as unknown;

/** Whether what a box holds or is in draws `text` of a `::before`. */
const hasGenerated = (el: HtmlViewNode, id: string): boolean => {
  const has = (box: { pseudo?: string | null; children: unknown[] }): boolean =>
    box.pseudo === 'before' ||
    box.children.some(
      (kid) =>
        !(kid as { el?: unknown }).el &&
        has(kid as { pseudo?: string | null; children: unknown[] }),
    );
  return has(boxOf(el, id) as unknown as { children: unknown[] });
};

metric(
  'what a rule can reach and comes out as it was is not built, beside what comes out otherwise',
  async () => {
    // Apple's script sets a class on a section as it scrolls in, and each of
    // the elements a rule of that class can style was built again and laid
    // out again for the few it changes
    const { result, node } = await render(
      '<style>body{margin:0} .same{color:#111111} .on .same{color:#111111}' +
        ' .on .wide{display:flex}</style><body><main id="top">' +
        '<section id="s0"><p class="same" id="kept">one</p></section>' +
        '<section id="s1"><p class="wide" id="made">two</p></section>' +
        '</main></body>',
      300,
    );
    const el = view(node);
    await act();
    const kept = firstBox(el, 'kept');
    const made = firstBox(el, 'made');
    el.touchDocument([setClass(byId(el, 'top'), 'on')]);
    const drawn = await snapshot(result, el);
    assert.strictEqual(
      el.computedStyle(byId(el, 'made'))?.display,
      'flex',
      'what changed was missed',
    );
    assert.ok(firstBox(el, 'kept') === kept, 'what is as it was was built');
    assert.ok(firstBox(el, 'made') !== made, 'nothing was built');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'a class taken off goes with the ::before it gave, in an anonymous box around it, where the element is styled as it was',
  async () => {
    // a `::before` beside blocks is in an anonymous box: no box of its
    // element's says it is there, and the element's own style does not move
    const { result, node } = await render(
      '<style>body{margin:0} .d::before{content:"*"} .d .w{display:flex}' +
        '</style><body><section id="s0"><div class="d" id="d"><p>one</p></div>' +
        '</section><section id="s1"><div class="d" id="d1"><p class="w">two</p>' +
        '</div></section></body>',
      300,
    );
    const el = view(node);
    await act();
    assert.ok(hasGenerated(el, 'd'), 'no ::before to take off');
    el.touchDocument([
      setClass(byId(el, 'd'), ''),
      setClass(byId(el, 'd1'), ''),
    ]);
    await act();
    const drawn = await snapshot(result, el);
    assert.ok(!hasGenerated(el, 'd'), 'the ::before stayed');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'an element moved under what a rule of its ::before asks for takes one, styled as it was',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} .in .p::before{content:"*"}</style><body>' +
        '<section id="to" class="in"><p id="stays">one</p></section>' +
        '<section id="from"><p class="p" id="moved">two</p></section></body>',
      300,
    );
    const el = view(node);
    await act();
    const moved = byId(el, 'moved');
    const from = byId(el, 'from');
    const to = byId(el, 'to');
    assert.ok(!hasGenerated(el, 'moved'));
    removeNode(moved);
    appendChild(to, moved);
    const nothing = { previousSibling: null, nextSibling: null };
    el.touchDocument([
      {
        type: 'childList',
        target: from,
        addedNodes: [],
        removedNodes: [moved],
        ...nothing,
      },
      {
        type: 'childList',
        target: to,
        addedNodes: [moved],
        removedNodes: [],
        previousSibling: byId(el, 'stays'),
        nextSibling: null,
      },
    ]);
    await act();
    const drawn = await snapshot(result, el);
    assert.ok(hasGenerated(el, 'moved'), 'its ::before was missed');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'a ::before a :has() gives an element goes when what it asked for goes, the element styled as it was',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} .a:has(+ .d)::before{content:"*"}</style><body>' +
        '<section id="s"><p class="a" id="a">one</p><p class="d" id="d">two</p>' +
        '<p id="c">three</p></section></body>',
      300,
    );
    const el = view(node);
    await act();
    assert.ok(hasGenerated(el, 'a'));
    const gone = byId(el, 'd');
    const next = gone.next;
    const prev = gone.prev;
    removeNode(gone);
    el.touchDocument([
      {
        type: 'childList',
        target: byId(el, 's'),
        addedNodes: [],
        removedNodes: [gone],
        previousSibling: prev,
        nextSibling: next,
      },
    ]);
    await act();
    const drawn = await snapshot(result, el);
    assert.ok(!hasGenerated(el, 'a'), 'the ::before stayed');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

test('a :has() above its rule’s subject reaches what the subject names in its element, and not all that is there', async () => {
  // Apple's `:has(>.caption-primary) .caption` names nothing of its own, so
  // it is asked of the `<body>` at every change to what it holds, and all
  // 5,800 elements of the page were styled and built again for its captions
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) => `<p id="p${i}">p${i}</p>`,
  ).join('');
  const { result, node } = await render(
    '<style>body{margin:0} :has(> .primary) .caption{color:#ff0000}</style>' +
      `<body>${paragraphs}<div id="wrap"><i class="caption" id="caption">c</i>` +
      '</div></body>',
    300,
  );
  const el = view(node);
  await act();
  const body = byId(el, 'wrap').parent as Element;
  const put = createElement('div');
  put.attribs.class = 'primary';
  const last = byId(el, 'wrap');
  appendChild(body, put);
  const change: HtmlChange = {
    type: 'childList',
    target: body,
    addedNodes: [put],
    removedNodes: [],
    previousSibling: last,
    nextSibling: null,
  };
  const own = scopeOf(el, [change]);
  assert.ok(own, 'a refresh of everything');
  assert.ok(own.has(byId(el, 'caption')), 'the caption it styles is missed');
  assert.ok(!own.has(byId(el, 'p7')), 'all that is in the <body> was reached');
  el.touchDocument([change]);
  await act();
  const drawn = await snapshot(result, el);
  assert.strictEqual(
    el.computedStyle(byId(el, 'caption'))?.color,
    'rgb(255, 0, 0)',
  );
  assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
});

metric(
  'a child put at the end of a <body> a :has() is anchored at builds the end of it, where its style stands',
  async () => {
    // a webmail page's popups and Apple's dialogs go at the end of a
    // `<body>` a rule's `:has()` asks about, and each was the whole document
    const { result, node } = await render(
      '<style>body{margin:0} body:has(> .open){color:#111111}' +
        ' body{color:#111111}</style><body><section id="s0"><p id="kept">one</p>' +
        '</section><section id="s1"><p>two</p></section></body>',
      300,
    );
    const el = view(node);
    await act();
    const kept = firstBox(el, 'kept');
    const body = byId(el, 's1').parent as Element;
    const put = createElement('div');
    put.attribs.class = 'open';
    appendChild(put, createText('three'));
    const last = byId(el, 's1');
    appendChild(body, put);
    el.touchDocument([
      {
        type: 'childList',
        target: body,
        addedNodes: [put],
        removedNodes: [],
        previousSibling: last,
        nextSibling: null,
      },
    ]);
    await act();
    const drawn = await snapshot(result, el);
    assert.ok(firstBox(el, 'kept') === kept, 'the whole document was built');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'text in an absolute box no line comes before builds what is in it, where one after a space builds the document',
  async () => {
    // Apple's menu counts its search results in an empty absolute box, and
    // each count laid out the whole document
    const { result, node } = await render(
      '<style>body{margin:0} #count,#after{position:absolute}</style><body>' +
        '<section id="s0"><p id="kept">one</p></section>' +
        '<div id="count"><div id="n"></div></div>' +
        '<p id="line">two <b id="after"><div id="m"></div></b></p></body>',
      300,
    );
    const el = view(node);
    await act();
    const kept = firstBox(el, 'kept');
    const textOf = (): string => (treeOf(el) as { text: string }).text;
    const tell = async (id: string, text: string): Promise<void> => {
      const at = byId(el, id);
      const put = createText(text);
      appendChild(at, put);
      el.touchDocument([
        {
          type: 'childList',
          target: at,
          addedNodes: [put],
          removedNodes: [],
          previousSibling: null,
          nextSibling: null,
        },
      ]);
      await act();
    };
    await tell('n', '5');
    let drawn = await snapshot(result, el);
    assert.ok(firstBox(el, 'kept') === kept, 'the document was built');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
    await tell('m', 'x');
    drawn = await snapshot(result, el);
    const told = textOf();
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
    assert.strictEqual(told, textOf(), 'the space before the box is another');
  },
);

metric(
  'what is written for assistive technology builds nothing, and restyles what a rule of it can style',
  async () => {
    // Apple's galleries write `aria-hidden`, `role` and `tabindex` on each
    // card as it scrolls in, and each write built all the card held
    const { result, node } = await render(
      '<style>body{margin:0}[aria-expanded=true] .x{color:#ff0000}' +
        '[role=tab] .x{background:#eeeeee}</style><body><main id="m">' +
        '<section id="s"><p class="x" id="p">one</p><p id="q">two</p></section>' +
        '</main></body>',
      300,
    );
    const el = view(node);
    await act();
    const tree = treeOf(el);
    const held = boxOf(el, 'q');
    const s = byId(el, 's');
    const set = (name: string, value: string): HtmlChange => {
      const oldValue = s.attribs[name] ?? null;
      s.attribs[name] = value;
      return { type: 'attributes', target: s, attributeName: name, oldValue };
    };
    el.touchDocument([set('aria-hidden', 'true'), set('role', 'group')]);
    await act();
    assert.ok(treeOf(el) === tree, 'the boxes were built');
    el.touchDocument([set('aria-expanded', 'true')]);
    await act();
    assert.ok(treeOf(el) === tree, 'a colour built the boxes');
    assert.ok(boxOf(el, 'q') === held, 'what it holds was built');
    assert.strictEqual(
      el.computedStyle(byId(el, 'p'))?.color,
      'rgb(255, 0, 0)',
      'the rule was missed',
    );
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'a tabindex that stays a number builds nothing and moves what Tab reaches, and one that comes makes a stop',
  async () => {
    const { node } = await render(
      '<body><div id="t" tabindex="0">one</div><div id="n">two</div></body>',
      300,
    );
    const el = view(node);
    await act();
    const stops = (): { element: Element; tabbable: boolean }[] =>
      (el as unknown as { _stops: { element: Element; tabbable: boolean }[] })
        ._stops;
    const t = byId(el, 't');
    const n = byId(el, 'n');
    assert.deepStrictEqual(
      stops().map((stop) => stop.tabbable),
      [true],
    );
    const tree = treeOf(el);
    const tell = (target: Element, value: string, oldValue: string | null) => {
      target.attribs.tabindex = value;
      el.touchDocument([
        { type: 'attributes', target, attributeName: 'tabindex', oldValue },
      ]);
    };
    tell(t, '-1', '0');
    await act();
    assert.ok(treeOf(el) === tree, 'the boxes were built');
    assert.deepStrictEqual(
      stops().map((stop) => stop.tabbable),
      [false],
    );
    tell(n, '0', null);
    await act();
    assert.ok(
      stops().some((stop) => stop.element === n),
      'a focusable area came and no stop did',
    );
  },
);

metric(
  'the hidden attribute takes its element out and puts it back, by the UA sheet alone',
  async () => {
    const { result, node } = await render(
      '<body><main><p id="a">one</p><p id="b">two</p></main></body>',
      300,
    );
    const el = view(node);
    await act();
    const a = byId(el, 'a');
    const height = boxOf(el, 'b').y;
    a.attribs.hidden = '';
    el.touchDocument([
      {
        type: 'attributes',
        target: a,
        attributeName: 'hidden',
        oldValue: null,
      },
    ]);
    await act();
    assert.ok(boxOf(el, 'b').y < height, 'it stayed');
    let drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
    delete a.attribs.hidden;
    el.touchDocument([
      { type: 'attributes', target: a, attributeName: 'hidden', oldValue: '' },
    ]);
    await act();
    assert.strictEqual(boxOf(el, 'b').y, height, 'it did not come back');
    drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'a backdrop filter that stays one is restyled in place, and one that comes makes a stacking context a build places',
  async () => {
    // Apple's cards fade a frosted panel in as they scroll, and every step
    // of it built them
    const { result, node } = await render(
      '<style>body{margin:0;background:#88aaff} main{position:relative}' +
        '#p{width:100px;height:50px;backdrop-filter:blur(2px)}' +
        '.on #p{backdrop-filter:blur(6px)}' +
        '.up #q{backdrop-filter:blur(3px)}</style><body>' +
        '<main id="m"><div id="p">one</div><div id="q">two</div></main></body>',
      300,
    );
    const el = view(node);
    await act();
    const tree = treeOf(el);
    const panel = boxOf(el, 'p');
    el.touchDocument([setClass(byId(el, 'm'), 'on')]);
    await act();
    assert.ok(treeOf(el) === tree, 'the boxes were built');
    assert.ok(boxOf(el, 'p') === panel, 'the box was built');
    let drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
    const before = treeOf(el);
    el.touchDocument([setClass(byId(el, 'm'), 'on up')]);
    await act();
    assert.ok(treeOf(el) !== before, 'a new stacking context in place');
    drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'a length of a box out of the flow is taken in place, and what it holds is laid out at it',
  async () => {
    // Apple's hero is an absolute box its script sizes at every step of a
    // scroll, and each built it
    const { result, node } = await render(
      '<style>body{margin:0}#a{position:absolute;left:10px;top:10px;' +
        'width:60px;height:80px} .on #a{width:200px}</style><body>' +
        '<main id="m"><div id="a"><p id="t" style="margin:0">one two three ' +
        'four five</p></div><p id="q">after</p></main></body>',
      300,
    );
    const el = view(node);
    await act();
    const tree = treeOf(el);
    const held = boxOf(el, 't');
    const lines = held.height;
    el.touchDocument([setClass(byId(el, 'm'), 'on')]);
    await act();
    assert.ok(treeOf(el) === tree, 'the boxes were built');
    assert.ok(boxOf(el, 't') === held, 'what it holds was built');
    assert.strictEqual(boxOf(el, 'a').width, 200);
    assert.ok(boxOf(el, 't').height < lines, 'the text kept its lines');
    const drawn = await snapshot(result, el);
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

test('a :has() that asks what its element is followed by is asked of what a change can change the answer of', async () => {
  // Apple's `.section:has(+ .section.theme-dark:not(.background-alt))`
  // reads the next section's own classes, and every change anywhere inside
  // a section reached all the sections before it: a dialog moved out of a
  // card was 14 sections built and laid out again, 26 times in one task
  const { node } = await render(
    '<style>body{margin:0} .s:has(+ .s.dark:not(.alt)){color:#ff0000}' +
      ' .s:has(+ .s > .pin){font-weight:bold}</style><body>' +
      '<section class="s" id="s0">a</section>' +
      '<section class="s" id="s1"><div id="deep"><i id="gone">b</i></div></section>' +
      '<section class="s dark" id="s2"><div><div id="deeper"><i>c</i></div></div></section>' +
      '</body>',
    300,
  );
  const el = view(node);
  await act();
  assert.strictEqual(el.computedStyle(byId(el, 's1'))?.color, 'rgb(255, 0, 0)');
  // inside a section: no answer can change, where the argument reads no more
  // than the section's own classes and its children
  const gone = byId(el, 'gone');
  const deep = byId(el, 'deep');
  removeNode(gone);
  const inside = scopeOf(el, [
    {
      type: 'childList',
      target: deep,
      addedNodes: [],
      removedNodes: [gone],
      previousSibling: null,
      nextSibling: null,
    },
  ]);
  assert.ok(inside, 'a refresh of everything');
  for (const id of ['s0', 's1', 's2']) {
    assert.ok(!inside.has(byId(el, id)), `${id} was reached`);
  }
  // the next section's class: the one before it, and that one alone
  const s2 = byId(el, 's2');
  s2.attribs.class = 's';
  const change: HtmlChange = {
    type: 'attributes',
    target: s2,
    attributeName: 'class',
    oldValue: 's dark',
  };
  const own = scopeOf(el, [change]);
  assert.ok(own?.has(byId(el, 's1')), 'the section it answers for is missed');
  el.touchDocument([change]);
  await act();
  assert.notStrictEqual(
    el.computedStyle(byId(el, 's1'))?.color,
    'rgb(255, 0, 0)',
  );
  // a child the argument names: one level down from the next section
  const pin = createElement('i', { class: 'pin' }, [createText('p')]);
  appendChild(s2, pin);
  const pinned: HtmlChange = {
    type: 'childList',
    target: s2,
    addedNodes: [pin],
    removedNodes: [],
    previousSibling: s2.children[0] as ChildNode,
    nextSibling: null,
  };
  assert.ok(scopeOf(el, [pinned])?.has(byId(el, 's1')), 'a child is missed');
  el.touchDocument([pinned]);
  await act();
  assert.strictEqual(el.computedStyle(byId(el, 's1'))?.['font-weight'], '700');
});

test('a :has() that reads what an element holds a level down is asked from there', async () => {
  const { node } = await render(
    '<style>body{margin:0} .e:has(> .a:empty){color:#ff0000}' +
      ' .f:has(+ .b:empty){color:#00aa00}</style><body>' +
      '<div class="e" id="e"><p class="a" id="a"><i id="i">i</i></p></div>' +
      '<div class="f" id="f">f</div><div class="b" id="b"><i id="j">j</i></div></body>',
    300,
  );
  const el = view(node);
  await act();
  const take = (id: string, holder: string): HtmlChange => {
    const node = byId(el, id);
    removeNode(node);
    return {
      type: 'childList',
      target: byId(el, holder),
      addedNodes: [],
      removedNodes: [node],
      previousSibling: null,
      nextSibling: null,
    };
  };
  const changes = [take('i', 'a'), take('j', 'b')];
  el.touchDocument(changes);
  await act();
  assert.strictEqual(el.computedStyle(byId(el, 'e'))?.color, 'rgb(255, 0, 0)');
  assert.strictEqual(el.computedStyle(byId(el, 'f'))?.color, 'rgb(0, 170, 0)');
});

test('a child put in reaches the later siblings its sibling combinators lead to from it, through one another, and not the rest', async () => {
  // Apple's pages put a banner in at the top of their <body>, whose sheets
  // style `:checked ~ .form-label`, `#ac-ln-menustate:checked ~ #main` and
  // `.headline + *`: with a `~` anywhere each restyled all the <body> held
  const paragraphs = Array.from(
    { length: 50 },
    (_, i) => `<p id="p${i}">p${i}</p>`,
  ).join('');
  const { node } = await render(
    '<style>body{margin:0} :checked ~ .label{color:#ff0000}' +
      ' #toggle:checked ~ #main p{color:#00aa00}' +
      ' .head + *{font-weight:bold} .a ~ .b + .c{color:#0000ff}' +
      ' .card:first-child:nth-last-child(2) ~ .card{color:#aa00aa}</style>' +
      '<body><input id="toggle" type="checkbox" checked>' +
      `<span class="label" id="label">l</span><main id="main">${paragraphs}</main>` +
      '<div id="row"><i class="b" id="b">b</i><i class="c" id="c">c</i></div>' +
      '<div id="cards"><i class="card" id="card1">1</i>' +
      '<i class="card" id="card2">2</i></div></body>',
    300,
  );
  const el = view(node);
  await act();
  const p7 = byId(el, 'p7');
  assert.strictEqual(el.computedStyle(p7)?.color, 'rgb(0, 170, 0)');
  const card2 = byId(el, 'card2');
  assert.strictEqual(el.computedStyle(card2)?.color, 'rgb(170, 0, 170)');
  const body = byId(el, 'main').parent as Element;
  // a banner at the top: what `:checked ~` leads to, and not #main's
  const banner = createElement('aside', {}, [createText('banner')]);
  DomUtils.prependChild(body as never, banner as never);
  const top: HtmlChange = {
    type: 'childList',
    target: body,
    addedNodes: [banner],
    removedNodes: [],
    previousSibling: null,
    nextSibling: byId(el, 'toggle'),
  };
  const own = scopeOf(el, [top]);
  assert.ok(own, 'a refresh of everything');
  assert.ok(own.has(byId(el, 'label')), 'what `~` leads to missed');
  assert.ok(!own.has(p7), '#main was reached');
  el.touchDocument([top]);
  await act();
  assert.strictEqual(el.computedStyle(p7)?.color, 'rgb(0, 170, 0)');
  // an `.a` before the row's `.b`: the `.c` the `.b` it reaches leads to
  const row = byId(el, 'row');
  const a = createElement('i', { class: 'a' });
  DomUtils.prependChild(row as never, a as never);
  const led: HtmlChange = {
    type: 'childList',
    target: row,
    addedNodes: [a],
    removedNodes: [],
    previousSibling: null,
    nextSibling: byId(el, 'b'),
  };
  assert.ok(scopeOf(el, [led])?.has(byId(el, 'c')), 'the chain’s `.c` missed');
  el.touchDocument([led]);
  await act();
  assert.strictEqual(el.computedStyle(byId(el, 'c'))?.color, 'rgb(0, 0, 255)');
  // a third card counts the first otherwise from the end: the second,
  // before what came, is reached through the first
  const cards = byId(el, 'cards');
  const third = createElement('i', {});
  appendChild(cards, third);
  const counted: HtmlChange = {
    type: 'childList',
    target: cards,
    addedNodes: [third],
    removedNodes: [],
    previousSibling: card2,
    nextSibling: null,
  };
  assert.ok(scopeOf(el, [counted])?.has(card2), 'the second card missed');
  el.touchDocument([counted]);
  await act();
  assert.notStrictEqual(el.computedStyle(card2)?.color, 'rgb(170, 0, 170)');
  // and in a holder of no card, none of its children
  const span = createElement('span', {});
  appendChild(row, span);
  const plain = scopeOf(el, [
    {
      type: 'childList',
      target: row,
      addedNodes: [span],
      removedNodes: [],
      previousSibling: byId(el, 'c'),
      nextSibling: null,
    },
  ]);
  assert.ok(plain && !plain.has(byId(el, 'b')), 'the row’s children reached');
});

test('a class that an attribute selector answers alike for before and after restyles nothing it tests, and one it answers otherwise for restyles what it reaches', async () => {
  // Primer's pricing rules: a `[class*=]` in a `:has()` that starts at a
  // sibling made every class change on github.com/features a refresh of
  // everything
  const { node } = await render(
    '<style>body{margin:0}' +
      ' [class*=Options__item]:not(:has(~ [class*=Options__item])){color:#ff0000}</style>' +
      '<div><p class="Options__item" id="one">1</p><p class="Options__item" id="two">2</p>' +
      '<p class="x" id="three">3</p></div><h1 class="Animation" id="h">h</h1>',
    300,
  );
  const el = view(node);
  await act();
  assert.strictEqual(
    el.computedStyle(byId(el, 'two'))?.color,
    'rgb(255, 0, 0)',
  );
  const heading = setClass(byId(el, 'h'), 'Animation Animation--active');
  const own = scopeOf(el, [heading]);
  assert.ok(own, 'the heading’s class was a refresh of everything');
  assert.strictEqual(own.size, 0, `${own.size} elements restyled`);
  el.touchDocument([heading]);
  // the last item is the third now: the second's answer changes too
  const item = setClass(byId(el, 'three'), 'x Options__item');
  assert.ok(scopeOf(el, [item]), 'an item’s class was a refresh of everything');
  el.touchDocument([item]);
  assert.notStrictEqual(
    el.computedStyle(byId(el, 'two'))?.color,
    'rgb(255, 0, 0)',
  );
  assert.strictEqual(
    el.computedStyle(byId(el, 'three'))?.color,
    'rgb(255, 0, 0)',
  );
});

test('a change at the root that a rule tests above its subject restyles what its subject names, not the document', async () => {
  // bun.com's blog sets `data-scrolled` on <html> as it is first scrolled,
  // which one rule reads for its header, and `reveal-ready`, which one reads
  // for elements the page has none of: each restyled all of its 7,000
  // elements, the first a 213 ms hold at the first notch of the wheel.
  // Tailwind's preflight has `:host, html`, a rule at a shadow tree's edge,
  // and that must not make every change reach everything below it again.
  const paragraphs = Array.from(
    { length: 300 },
    (_, i) => `<p>Paragraph ${i}</p>`,
  ).join('');
  const { node } = await render(
    '<html><head><style>:host, html { line-height: 1.5 } body { margin: 0 }' +
      ' html[data-scrolled] .site-header { border-bottom: 1px solid #ff0000 }' +
      ' .reveal-ready [data-reveal]:not(.revealed) { opacity: 0 }</style></head><body>' +
      `<header class="site-header" id="h"><a id="a">Bun</a></header>${paragraphs}</body></html>`,
    300,
  );
  const el = view(node);
  await act();
  const html = el.document.children.find(
    (n) => (n as Element).name === 'html',
  ) as Element;
  const header = byId(el, 'h');
  const body = html.children.find(
    (n) => (n as Element).name === 'body',
  ) as Element;

  const scrolled = [setAttr(html, 'data-scrolled', '')];
  const own = scopeOf(el, scrolled);
  assert.ok(own, 'the attribute was a refresh of everything');
  // by identity: a failing comparison would format the elements, which are
  // cyclic
  assert.ok(own.size === 1 && own.has(header), `${own.size} elements restyled`);
  const computed = await stylesComputed(el, () => el.touchDocument(scrolled));
  assert.ok(computed > 0 && computed < 5, `${computed} styles worked out`);
  assert.strictEqual(
    el.computedStyle(header)?.['border-bottom-color'],
    'rgb(255, 0, 0)',
  );

  const ready = [setClass(html, 'reveal-ready hydrated')];
  const none = scopeOf(el, ready);
  assert.ok(none, 'the class was a refresh of everything');
  assert.strictEqual(none.size, 0, `${none.size} elements restyled`);
  el.touchDocument(ready);

  // what a refresh of everything comes to, style by style
  const told = stylesOf(el, body);
  el.touchDocument();
  const whole = stylesOf(el, body);
  const at = told.findIndex((style, i) => style !== whole[i]);
  assert.ok(
    at < 0 && told.length === whole.length,
    `told what changed\n${(told[at] ?? '').slice(0, 300)}\n` +
      `styled whole\n${(whole[at] ?? '').slice(0, 300)}`,
  );
});

test('a :has() is restyled from its element, found by its compound: an earlier sibling, an id, a :not() around it', async () => {
  const { node } = await render(
    '<style>body{margin:0} .a:has(+ .b) > i{color:#ff0000}' +
      ' #box:has(.on) em{color:#ff0000} .c:not(:has(> .on)) b{color:#ff0000}</style>' +
      '<div id="d"><p class="a"><i id="i">i</i></p><p class="b" id="pb">b</p></div>' +
      '<div id="box"><span id="t">t</span><em id="em">em</em></div>' +
      '<div class="c"><span id="u">u</span><b id="bold">b</b></div>',
    300,
  );
  const el = view(node);
  await act();
  const red = 'rgb(255, 0, 0)';
  const colour = (id: string) => el.computedStyle(byId(el, id))?.color;
  assert.strictEqual(colour('i'), red);
  assert.notStrictEqual(colour('em'), red);
  assert.strictEqual(colour('bold'), red);
  // what came or went was the next sibling of the element whose answer
  // changed, which is one of what its parent holds
  const pb = byId(el, 'pb');
  removeNode(pb as unknown as ChildNode);
  const removed: HtmlChange = {
    type: 'childList',
    target: byId(el, 'd'),
    addedNodes: [],
    removedNodes: [pb],
  };
  const changes = [
    removed,
    setClass(byId(el, 't'), 'on'),
    setClass(byId(el, 'u'), 'on'),
  ];
  for (const change of changes) {
    assert.ok(scopeOf(el, [change]), `${change.type} restyled everything`);
  }
  el.touchDocument(changes);
  assert.notStrictEqual(colour('i'), red);
  assert.strictEqual(colour('em'), red);
  assert.notStrictEqual(colour('bold'), red);
});

test('a function in a :has() is restyled from what it reads: the sibling it asks about, and an element no walk from a change finds', async () => {
  const { node } = await render(
    '<style>body{margin:0} .p:has(+ .a:not(.b)) > i{color:#ff0000}' +
      ' .q:has(> .a:is(.x .a)) > i{color:#ff0000}</style>' +
      '<div><p class="p"><i id="i">i</i></p><p class="a" id="s">s</p></div>' +
      '<section id="x"><p class="q"><b class="a">b</b><i id="j">j</i></p></section>',
    300,
  );
  const el = view(node);
  await act();
  const red = 'rgb(255, 0, 0)';
  const colour = (id: string) => el.computedStyle(byId(el, id))?.color;
  assert.strictEqual(colour('i'), red);
  assert.notStrictEqual(colour('j'), red);
  // an element whose answer changed, found from the sibling, and no more
  const sibling = setClass(byId(el, 's'), 'a b');
  assert.ok(scopeOf(el, [sibling]), 'the class restyled everything');
  el.touchDocument([sibling]);
  assert.notStrictEqual(colour('i'), red);
  // what is above the `:has()`'s element is no element a walk up from a
  // change reaches it from
  const above = setClass(byId(el, 'x'), 'x');
  assert.strictEqual(scopeOf(el, [above]), null);
  el.touchDocument([above]);
  assert.strictEqual(colour('j'), red);
});

test('a sibling combinator in a function in a :has() that goes down is reached from inside its element, and restyles no more than that', async () => {
  // Tailwind's `peer` in a `has-`: tailwindcss.com's sheet has one, and read
  // as reaching everything, every change to its tree would style all of it
  const { node } = await render(
    '<style>body{margin:0} .p:has(:is(.peer ~ .on)) > i{color:#ff0000}' +
      ' .q:has(+ .a:is(.x ~ .a)) > i{color:#ff0000}</style>' +
      '<div class="p"><b id="b">b</b><b class="on">o</b><i id="i">i</i></div>' +
      '<p id="other">other</p>' +
      '<div><b id="x">x</b><p class="q"><i id="j">j</i></p><p class="a">a</p></div>',
    300,
  );
  const el = view(node);
  await act();
  const red = 'rgb(255, 0, 0)';
  const colour = (id: string) => el.computedStyle(byId(el, id))?.color;
  assert.notStrictEqual(colour('i'), red);
  const peer = setClass(byId(el, 'b'), 'peer');
  const own = scopeOf(el, [peer]);
  assert.ok(own, 'the class restyled everything');
  assert.ok(!own.has(byId(el, 'other')), 'an element nothing reaches');
  el.touchDocument([peer]);
  assert.strictEqual(colour('i'), red);
  // and before the element, where the argument starts at a sibling, no walk
  // reaches it
  const before = setClass(byId(el, 'x'), 'x');
  assert.strictEqual(scopeOf(el, [before]), null);
  el.touchDocument([before]);
  assert.strictEqual(colour('j'), red);
});

test('a :has() of what an element takes from one around it, :lang(), is restyled when that one changes', async () => {
  // what is inside the element changed answers, and the element whose
  // `:has()` it changes is inside it: no attribute an inherited answer is
  // read from is a style-only one, and what is in the element is
  // restyled with it
  const { node } = await render(
    '<style>body{margin:0} .x:has(:lang(fr)) > b{color:#ff0000}</style>' +
      '<div id="l" lang="en"><section class="x"><span><i>i</i></span>' +
      '<b id="b">b</b></section></div>',
    300,
  );
  const el = view(node);
  await act();
  const change = setAttr(byId(el, 'l'), 'lang', 'fr');
  assert.ok(scopeOf(el, [change]), 'the language restyled everything');
  el.touchDocument([change]);
  assert.strictEqual(el.computedStyle(byId(el, 'b'))?.color, 'rgb(255, 0, 0)');
});

// --- every change, held to every element styled again ---------------------
//
// Random documents, random rules and random changes, on the mock backend: a
// refresh told what changed has to come to the styles a refresh of the
// whole document does, element by element. The rules are the shapes whose
// reach the scope reads — each combinator, `:not()`, `:is()`, `:has()` at
// a subject and inside one, the structural pseudo-classes, attributes, ids,
// inherited properties, a `::before` — and the changes each kind of record.
// A `:has()` reaches the elements whose answer to it changed, found by the
// compound it is in among those around the change (`spreadAnchors`), and an
// attribute selector is a change where it answers otherwise for the old
// value than the new (`Cascade._flips`): the shapes of both are many, and
// a sheet of them is held to it apart (`anchored`).

const CLASSES = ['a', 'b', 'c', 'd'];
/** The classes only rules at trees' edges test, so that what such a rule
 *  reaches is not one an ordinary rule's test of the class reaches too. */
const EDGE_CLASSES = ['x', 'y'];
const TAGS = ['div', 'p', 'span', 'li', 'section'];
const INKS = ['#ff0000', '#00aa00', '#0000ff', '#aa00aa'];
const LANGS = ['fr', 'fr-CA', 'en'];

function rulesFor(
  next: () => number,
  around = true,
  anchoredShare = 0.15,
  holderPlain = true,
): string {
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
    // what a holder holds before a sibling combinator reaches its own
    // later siblings, where a sibling combinator alone reaches its
    // children's
    () => `div:empty + .${c()}`,
    () => `.${c()}:empty ~ *`,
    () => `:not(:empty) + .${c()}`,
    () => `.${c()}:nth-child(2n+1)`,
    // where an element sits, tested above a subject and of one, with
    // what else its compound asks
    () => `.${c()}:not(:first-child) .${c()}`,
    () => `.${c()}:last-child > .${c()}`,
    () => `${pick(TAGS)}:nth-child(2) .${c()}`,
    () => `.${c()}:not(:last-child)`,
    () => `[data-x] .${c()}`,
    () => `[data-x=y]`,
    () => `[role=tab] .${c()}`,
    () => `[aria-expanded=true] > .${c()}`,
    () => `[hidden] + .${c()}`,
    () => `[tabindex="0"] .${c()}`,
    () => `#e${Math.floor(next() * 6)} .${c()}`,
    () => `#e${Math.floor(next() * 6)}`,
  ];
  // a `:has()` whose element is found among those around what changed —
  // its ancestors, their earlier siblings, what is inside it — by the
  // compound it is in, and attribute selectors whose answer is asked of
  // the values the attribute had and has
  const anchored: (() => string)[] = [
    () => `.${c()}:has(+ .${c()})`,
    () => `.${c()}:has(~ .${c()})`,
    () => `${pick(TAGS)}:has(+ ${pick(TAGS)})`,
    () => `.${c()}:has(+ .${c()}) > *`,
    () => `.${c()}:has(+ .${c()}:not(.${c()}))`,
    () => `.${c()}:has(+ .${c()} > .${c()})`,
    () => `.${c()}:has(~ .${c()}:is(p, div)) .${c()}`,
    () => `.${c()}:has(+ .${c()} + .${c()})`,
    () => `.${c()}:has(+ .${c()}:empty)`,
    () => `.${c()}:has(> .${c()}:empty)`,
    () => `:has(+ .${c()}) .${c()}`,
    () => `:has(> .${c()}) .${c()}`,
    () => `.${c()}:has(> .${c()}) > .${c()}`,
    () => `.${c()}:has(.${c()}) .${c()} span`,
    () => `.${c()}:has(+ *) > *`,
    () => `${pick(TAGS)}:has(~ ${pick(TAGS)}) .${c()}`,
    () => `:is(p, span):has(~ div > .${c()})`,
    () => `#e${Math.floor(next() * 2)}:has(.${c()}) *`,
    () => `.${c()}:has(~ .${c()} .${c()})`,
    () => `.${c()}:has(.${c()}) span`,
    () => `section:has(.${c()}) + *`,
    () => `.${c()}:not(:has(> .${c()})) .${c()}`,
    () => `.${c()}:not(:has(.${c()})) > *`,
    () => `div:is(:has(> .${c()})) .${c()}`,
    () => `:is(.${c()}:has(.${c()}) > *, #e9)`,
    () => `.${c()}:has(.${c()}:has(+ .${c()}))`,
    () => `[data-x=y]:has(.${c()}) ~ *`,
    () => `.${c()}:has([data-x=z])`,
    () => `.${c()}:has(> .${c()}:first-child)`,
    () => `li:has(+ :empty)`,
    () => `${pick(TAGS)}:has(${pick(TAGS)}) .${c()}`,
    () => `.${c()}:has(:lang(fr)) > *`,
    () => `.${c()}:has(+ [lang|=fr])`,
    () => `:lang(fr) .${c()}`,
    () => `[class*=${c()}] .${c()}`,
    () => `[class~=${c()}] + *`,
    () => `[class^=${c()}]`,
    () => `[class|=${c()}] > *`,
    () => `[data-x^=y] > *`,
    () => `[data-x=Z i]`,
    () => `[id*="1"] *`,
  ];
  // what a `:has()` reaches where every element is one's, which is
  // everything around what changed, and what `:nth-child(… of …)` counts
  // by: such a sheet styles every element again, as one in a few does
  const reaching: (() => string)[] = [
    () => `:has(.${c()}) span`,
    () => `.${c()}:nth-child(odd of .${c()})`,
  ];
  const declarations: (() => string)[] = [
    () => `color: ${pick(INKS)}`,
    () => `background-color: ${pick(INKS)}`,
    () => 'font-weight: bold',
    () => `display: ${pick(['none', 'block', 'inline-block', 'flex'])}`,
    () => `padding-left: ${Math.floor(next() * 20)}px`,
    () => 'border-top: 2px solid',
    // out of the flow, which a frame's build repaints apart
    // (`_rebuildFrame`), where it is all a change restyles
    () => 'position: absolute',
  ];
  const rules: string[] = [];
  const count = 6 + Math.floor(next() * 8);
  for (let i = 0; i < count; i += 1) {
    // in a shadow tree's sheet, none: the index is one for every sheet, and
    // a document of several sheets would have one almost always
    const roll = next();
    const shape =
      roll < 0.04 && around
        ? pick(reaching)
        : roll < 0.04 + anchoredShare
          ? pick(anchored)
          : pick(shapes);
    let selector = shape();
    // a sibling combinator or a structural pseudo-class outside every
    // `:has()` reaches all of a holder's children, and with one, what came
    // or went could miss a `:has()` among them and nothing would show it
    while (!holderPlain && HOLDER_WIDE.test(withoutArguments(selector))) {
      selector = pick(next() < anchoredShare ? anchored : shapes)();
    }
    rules.push(`${selector} { ${pick(declarations)()} }`);
  }
  if (next() < 0.5) {
    rules.push(`.${c()}::before { content: "*"; color: ${pick(INKS)} }`);
  }
  return rules.join('\n');
}

/**
 * Rules whose reach a change finds by levels and by sibling: a `:has()`
 * that asks only of its element's children, on a compound that names
 * nothing (`HasAnchor.levels`) — Apple's `:has(>.caption-primary)
 * .caption` — and sibling combinators that lead from what names nothing,
 * to anything, or to one another, and after where an element sits counted
 * from the end (`siblingsReached`), beside the plain shapes they meet.
 */
function reachRulesFor(next: () => number): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const c = () => pick(CLASSES);
  const shapes: (() => string)[] = [
    () => `:has(> .${c()}) .${c()}`,
    () => `:has(> .${c()} > .${c()}) + .${c()}`,
    () => `:has(> .${c()}) > *`,
    () => `.${c()}:has(> .${c()})`,
    () => `:not(.${c()}) ~ .${c()}`,
    () => `.${c()} + *`,
    () => `.${c()} ~ .${c()}`,
    () => `.${c()} ~ .${c()} + .${c()}`,
    () => `.${c()} + .${c()} ~ .${c()} .${c()}`,
    () => `:is(.${c()} + .${c()}) ~ .${c()}`,
    () => `.${c()}:first-child:nth-last-child(2) ~ .${c()}`,
    () => `.${c()}:last-child + *`,
    () => `.${c()}:empty ~ *`,
    () => `.${c()} .${c()}`,
    () => `.${c()}`,
  ];
  const declarations: (() => string)[] = [
    () => `color: ${pick(INKS)}`,
    () => 'font-weight: bold',
    () => `display: ${pick(['none', 'block', 'inline-block'])}`,
    () => `padding-left: ${Math.floor(next() * 20)}px`,
    () => 'position: absolute',
  ];
  const rules: string[] = [];
  const count = 6 + Math.floor(next() * 8);
  for (let i = 0; i < count; i += 1) {
    rules.push(`${pick(shapes)()} { ${pick(declarations)()} }`);
  }
  if (next() < 0.5) {
    rules.push(`.${c()}::before { content: "*"; color: ${pick(INKS)} }`);
  }
  return rules.join('\n');
}

/**
 * Rules with a function in a `:has()`'s argument, which is compiled by
 * itself (`compileHoisted`): `apart` for those with a selector in it that
 * has a combinator, which reads elements no walk from a change finds, and
 * makes a sheet a refresh of everything; those without test what the
 * argument reaches.
 */
function hasFunctionRulesFor(next: () => number, apart: boolean): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const c = () => pick(CLASSES);
  const shapes: (() => string)[] = apart
    ? [
        () => `.${c()}:has(> .${c()}:is(.${c()} .${c()}))`,
        () => `.${c()}:has(.${c()}:not(.${c()} .${c()})) > *`,
        () => `.${c()}:has(+ .${c()}:is(.${c()} .${c()}))`,
        () => `.${c()}:has(+ .${c()}:is(.${c()} ~ .${c()}))`,
        () => `.${c()}:has(~ .${c()}:not(.${c()} > .${c()})) .${c()}`,
        () => `.${c()}:has(+ :not(.${c()} + *))`,
      ]
    : [
        () => `.${c()}:has(+ .${c()}:not(.${c()}))`,
        () => `.${c()}:has(~ .${c()}:not(.${c()}))`,
        () => `.${c()}:has(+ :is(.${c()}, .${c()}))`,
        () => `.${c()}:has(~ :where(.${c()})) > *`,
        () => `.${c()}:has(+ .${c()} > .${c()}:not(.${c()}))`,
        () => `.${c()}:has(~ .${c()}:not(:first-child)) .${c()}`,
        () => `.${c()}:has(+ :not(:empty))`,
        () => `:is(.${c()}:has(+ .${c()}:not(.${c()}))) + *`,
        // a sibling combinator stays inside an argument that goes down:
        // Tailwind's `peer` in a `has-`
        () => `.${c()}:has(:is(.${c()} ~ *)) > *`,
        () => `.${c()}:has(> .${c()}:not(.${c()} + *))`,
        () => `.${c()}:has(.${c()}:is(.${c()} + .${c()}))`,
      ];
  const declarations: (() => string)[] = [
    () => `color: ${pick(INKS)}`,
    () => 'font-weight: bold',
    () => `display: ${pick(['none', 'block', 'inline-block'])}`,
    () => `padding-left: ${Math.floor(next() * 20)}px`,
  ];
  const rules: string[] = [];
  const count = 6 + Math.floor(next() * 8);
  for (let i = 0; i < count; i += 1) {
    rules.push(`${pick(shapes)()} { ${pick(declarations)()} }`);
  }
  return rules.join('\n');
}

/**
 * Rules that test what an element is above their subject, the subject of
 * every kind a reach below the element can be narrowed to — a class, a
 * type, an attribute, a `:not()`, an `:is()` of compounds, a structural
 * pseudo-class beside them, a `::before` — and of the kinds it cannot: `*`,
 * pseudo-classes alone, an `:is()` of complex selectors. Tailwind's
 * `:host, html` is always there, a rule at a shadow tree's edge.
 */
function belowRulesFor(next: () => number): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const c = () => pick(CLASSES);
  const t = () => pick(TAGS);
  const above: (() => string)[] = [
    () => `.${c()}`,
    () => '[data-x]',
    () => '[data-x=y]',
    () => `#e${Math.floor(next() * 6)}`,
    () => `${t()}.${c()}`,
    () => `.${c()}:not(.${c()})`,
    // what a change reaches through a function, which holds no subject of
    // its own, and through a test of where a child sits
    () => `:not(.${c()})`,
    () => `:is(.${c()}, [data-x])`,
    () => `:where(.${c()} .${c()})`,
    () => `:not(.${c()} + .${c()})`,
    () => `.${c()} > :first-child`,
    () => `.${c()} :first-child`,
    () => `${t()}.${c()} :nth-child(2)`,
    () => `.${c()} > :not(:last-child)`,
    () => `.${c()} > ${t()}:nth-child(2)`,
  ];
  const subjects: (() => string)[] = [
    () => `.${c()}`,
    () => t(),
    () => `${t()}.${c()}`,
    () => '[data-x]',
    () => '[data-x=z]',
    () => `.${c()}:not(.${c()})`,
    () => `:is(.${c()}, ${t()})`,
    () => `.${c()}:first-child`,
    () => `${t()}:last-child`,
    () => '*',
    () => `:not(.${c()})`,
    () => ':first-child',
    () => `:is(.${c()} .${c()})`,
  ];
  const combinator = () => (next() < 0.6 ? ' ' : ' > ');
  const declarations: (() => string)[] = [
    () => `color: ${pick(INKS)}`,
    () => `background-color: ${pick(INKS)}`,
    () => 'font-weight: bold',
    () => `display: ${pick(['none', 'block', 'inline-block'])}`,
    () => `padding-left: ${Math.floor(next() * 20)}px`,
    () => 'border-top: 2px solid',
  ];
  const rules = [':host, html { line-height: 1.4 }'];
  const count = 6 + Math.floor(next() * 8);
  for (let i = 0; i < count; i += 1) {
    let selector = pick(above)() + combinator();
    if (next() < 0.3) selector += pick(above)() + combinator();
    selector += pick(subjects)();
    rules.push(`${selector} { ${pick(declarations)()} }`);
  }
  if (next() < 0.5) {
    rules.push(
      `.${c()} .${c()}::before { content: "*"; color: ${pick(INKS)} }`,
    );
  }
  return rules.join('\n');
}

/** What outside a `:has()` reaches all of a holder's children: a sibling
 *  combinator, and a pseudo-class that counts them. */
const HOLDER_WIDE = /[+~]|:(?:first|last|only|nth|empty)/;

/** A selector with what is in its parentheses taken out. */
function withoutArguments(selector: string): string {
  let out = selector;
  for (let was = ''; was !== out;) {
    was = out;
    out = out.replace(/\([^()]*\)/g, '');
  }
  return out;
}

/** Rules at a shadow tree's edge: of its host, of what its slots are
 *  given, or — `outside` — of the parts of a tree from the document. */
function edgeRulesFor(next: () => number, outside: boolean): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const c = () => pick(next() < 0.6 ? EDGE_CLASSES : CLASSES);
  const shapes: (() => string)[] = outside
    ? [
        () => `.${c()}::part(p)`,
        () => `.${c()} div::part(p)`,
        () => `[data-x=y]::part(p)`,
        () => `::part(p)`,
      ]
    : [
        () => `:host(.${c()})`,
        () => `:host(.${c()}) .${c()}`,
        () => `:host(.${c()}) > *`,
        () => `:host([data-x]) .${c()}`,
        () => `:host-context(.${c()}) .${c()}`,
        () => `:host`,
        () => `::slotted(.${c()})`,
        () => `::slotted(*)`,
        () => `slot[name=n]::slotted(.${c()})`,
        () => `.${c()} ::slotted(*)`,
      ];
  const rules: string[] = [];
  for (let i = 1 + Math.floor(next() * 3); i > 0; i -= 1) {
    rules.push(`${pick(shapes)()} { color: ${pick(INKS)} }`);
  }
  return rules.join('\n');
}

function markupFor(
  next: () => number,
  shadows = false,
  edges = false,
  drawings = false,
): string {
  let id = 0;
  const element = (depth: number): string => {
    if (drawings && depth > 0 && next() < 0.35) {
      return drawingFor(next, id++);
    }
    // a host: a shadow tree of its own, with sheets that stay inside it —
    // or, `edges`, that reach across its edge too — a slot for its
    // children and one named, and its light children
    if (shadows && depth === 0 && next() < 0.6) {
      let css = rulesFor(next, false);
      if (edges) css += `\n${edgeRulesFor(next, false)}`;
      let tree = `<style>${css}</style>`;
      const inTree = () => {
        const markup = element(1);
        return edges && next() < 0.4
          ? markup.replace(/^<(\w+)/, '<$1 part="p"')
          : markup;
      };
      tree += inTree() + '<slot></slot>' + inTree();
      if (next() < 0.5) tree += '<slot name="n"></slot>';
      let light = '';
      for (let i = Math.floor(next() * 3); i >= 0; i -= 1) {
        light += element(1).replace(/^<(\w+)/, (m) =>
          next() < 0.3 ? `${m} slot="n"` : m,
        );
      }
      const cls = CLASSES.filter(() => next() < 0.3).join(' ');
      return (
        `<div${cls ? ` class="${cls}"` : ''}>` +
        `<template shadowrootmode="open">${tree}</template>${light}</div>`
      );
    }
    const tag = TAGS[Math.floor(next() * TAGS.length)];
    const classes = CLASSES.filter(() => next() < 0.3).join(' ');
    let attrs = classes ? ` class="${classes}"` : '';
    if (next() < 0.3) attrs += ` id="e${id++}"`;
    if (next() < 0.2) attrs += ` data-x="${next() < 0.5 ? 'y' : 'z'}"`;
    if (next() < 0.1) {
      attrs += ` lang="${LANGS[Math.floor(next() * LANGS.length)]}"`;
    }
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

/** An inline drawing, with a gradient of its own that one of its shapes
 *  names. What another drawing names is left out: a change inside that is
 *  no change to the drawing that names it. */
function drawingFor(next: () => number, id: number): string {
  const classes = () => {
    const names = CLASSES.filter(() => next() < 0.3).join(' ');
    return names ? ` class="${names}"` : '';
  };
  const shape = () =>
    next() < 0.5
      ? `<rect${classes()} width="9" height="9"/>`
      : `<circle${classes()} r="4" cx="4" cy="4"/>`;
  return (
    `<svg${classes()} width="20" height="20">${shape()}<g${classes()}>` +
    `${shape()}</g><linearGradient id="d${id}"><stop${classes()}` +
    ` stop-color="#ff0000"/></linearGradient><rect fill="url(#d${id})"` +
    ' width="9" height="9"/></svg>'
  );
}

/** Rules that reach a drawing's elements from around them and in them,
 *  some of which give a shape nothing it draws, for `drawingFor`. */
function drawingRulesFor(next: () => number): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const c = () => pick(CLASSES);
  const above: (() => string)[] = [
    () => `.${c()}`,
    () => '[data-x=y]',
    () => `#e${Math.floor(next() * 6)}`,
    () => `${pick(TAGS)}.${c()}`,
    () => `.${c()} ~ *`,
    () => `.${c()} + *`,
    () => `.${c()}:has(.${c()})`,
    () => `:has(> .${c()})`,
    () => `:not(.${c()})`,
    () => `.${c()} > :first-child`,
  ];
  const subjects: (() => string)[] = [
    () => 'rect',
    () => 'circle',
    () => 'g',
    () => 'stop',
    () => `.${c()}`,
    () => `rect.${c()}`,
    () => `svg .${c()}`,
    () => `svg > *`,
    () => '*',
  ];
  const declarations: (() => string)[] = [
    () => `fill: ${pick(INKS)}`,
    () => `fill: ${pick(INKS)}`,
    () => `stroke: ${pick(INKS)}`,
    () => `stop-color: ${pick(INKS)}`,
    () => `color: ${pick(INKS)}`,
    () => 'visibility: hidden',
    () => 'background: #ff0000',
  ];
  const rules: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const selector =
      next() < 0.25 ? pick(subjects)() : `${pick(above)()} ${pick(subjects)()}`;
    rules.push(`${selector} { ${pick(declarations)()} }`);
  }
  return rules.join('\n');
}

/** Whether an element is outside every drawing. */
function outsideDrawings(el: Element): boolean {
  let at = el.parent as Element | null;
  while (at) {
    if (at.name === 'svg') return false;
    at = ((at as { host?: Element }).host ?? at.parent) as Element | null;
  }
  return true;
}

/** What the rules give the shapes of each drawing in `body`, which is what
 *  its next paint reads, or asks for where it never asked. */
function shapesOf(el: HtmlViewNode, body: Element): string[] {
  const view = el as unknown as {
    _tree: { shapeStyler(box: unknown): { key: string } | null };
    _firstBoxesOf(tree: unknown): Map<Element, unknown>;
  };
  const boxes = view._firstBoxesOf(view._tree);
  return elementsIn(body)
    .filter((e) => e.name === 'svg')
    .map((e, i) => {
      const box = boxes.get(e);
      return `${i} ${box ? (view._tree.shapeStyler(box)?.key ?? '') : 'no box'}`;
    });
}

/** The body's elements, in document order, and those of each shadow
 *  tree after its host's. */
function elementsIn(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    out.push(el);
    for (const child of el.children) {
      if ((child as Element).attribs) walk(child as Element);
    }
    for (const child of shadowRootOf(el)?.children ?? []) {
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

const PX_LENGTH = /-?\d+(?:\.\d+)?px/g;

/** Where two lists from `stylesOf` first say something else, or -1, a used
 *  length a thousandth either way: the sum in a kept box comes out a last bit
 *  from the same sum in a new one, and on a half that is two thousandths as
 *  `getComputedStyle` writes it — 497.6125 and 497.61249999999995, seed 29 of
 *  the form controls — as `thousandths` in the harness has it of a box. */
function firstApart(a: readonly string[], b: readonly string[]): number {
  return a.findIndex((line, i) => {
    const other = b[i];
    if (line === other) return false;
    if (line.replace(PX_LENGTH, '') !== other?.replace(PX_LENGTH, '')) {
      return true;
    }
    const mine = line.match(PX_LENGTH) ?? [];
    const theirs = other.match(PX_LENGTH) ?? [];
    return (
      mine.length !== theirs.length ||
      mine.some(
        (n, j) => Math.abs(parseFloat(n) - parseFloat(theirs[j])) > 0.0015,
      )
    );
  });
}

/** Where a node is among its siblings, as a record says, half the time:
 *  a host that keeps a `MutationObserver`'s records hands them on. */
function sidesOf(
  next: () => number,
  node: Element,
): { previousSibling?: ChildNode | null; nextSibling?: ChildNode | null } {
  if (next() < 0.5) return {};
  return { previousSibling: node.prev, nextSibling: node.next };
}

/** A change a script might make, done, and its records. */
function changeOne(
  next: () => number,
  body: Element,
  forgetOld: boolean,
  parts = false,
): HtmlChange[] {
  // a change to what a drawing names reaches no other drawing that names
  // it yet, as a rule's reach from outside it does: what names one stays
  // with it
  const all = elementsIn(body).filter(
    (e) => e.name !== 'linearGradient' && e.name !== 'stop' && !e.attribs.fill,
  );
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const inside = all.slice(1);
  const kind = Math.floor(next() * 8);
  if (kind === 0 || kind === 1) {
    // a class toggled — where rules cross trees' edges, a host's or one of
    // its light children's two times in three, which is what a `:host()`,
    // a `::part()` and a `::slotted()` test
    const hosts = parts ? all.filter((e) => shadowRootOf(e)) : [];
    const light = hosts.flatMap((h) =>
      h.children.filter((k): k is Element => !!(k as Element).attribs),
    );
    const roll = next();
    const target =
      hosts.length && roll < 1 / 3
        ? pick(hosts)
        : light.length && roll < 2 / 3
          ? pick(light)
          : pick(all);
    const was = target.attribs.class ?? null;
    const has = new Set((was ?? '').split(' ').filter(Boolean));
    const c = pick(parts && next() < 0.5 ? EDGE_CLASSES : CLASSES);
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
  if (kind === 2 && parts && next() < 0.3) {
    // a part given or taken away
    const target = pick(all);
    const was = target.attribs.part ?? null;
    if (was !== null) delete target.attribs.part;
    else target.attribs.part = 'p';
    return [
      { type: 'attributes', target, attributeName: 'part', oldValue: was },
    ];
  }
  if (kind === 2 && next() < 0.3) {
    // a language said or unsaid, which what is in the element takes
    const target = pick(all);
    const was = target.attribs.lang ?? null;
    if (was !== null && next() < 0.4) delete target.attribs.lang;
    else target.attribs.lang = pick(LANGS);
    return [
      { type: 'attributes', target, attributeName: 'lang', oldValue: was },
    ];
  }
  if (kind === 2 && next() < 0.3) {
    // what is written for assistive technology, and for Tab
    const target = pick(all);
    const name = pick(['role', 'aria-expanded', 'hidden', 'tabindex']);
    const was = target.attribs[name] ?? null;
    if (was !== null && next() < 0.5) delete target.attribs[name];
    else {
      target.attribs[name] =
        name === 'role'
          ? pick(['tab', 'menu'])
          : name === 'aria-expanded'
            ? pick(['true', 'false'])
            : name === 'hidden'
              ? ''
              : pick(['0', '-1']);
    }
    return [{ type: 'attributes', target, attributeName: name, oldValue: was }];
  }
  if (kind === 2) {
    // an attribute set or taken away
    const target = pick(all);
    const was = target.attribs['data-x'] ?? null;
    if (was !== null && next() < 0.5) delete target.attribs['data-x'];
    else target.attribs['data-x'] = pick(['y', 'z', 'Z', 'yy']);
    return [
      {
        type: 'attributes',
        target,
        attributeName: 'data-x',
        ...(forgetOld ? {} : { oldValue: was }),
      },
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
        ...sidesOf(next, child),
      },
    ];
  }
  if (kind === 5 && inside.length) {
    // one taken out
    const target = pick(inside);
    const parent = target.parent as unknown as Element;
    const sides = sidesOf(next, target);
    removeNode(target as unknown as ChildNode);
    return [
      {
        type: 'childList',
        target: parent,
        addedNodes: [],
        removedNodes: [target],
        ...sides,
      },
    ];
  }
  if (kind === 6 && inside.length) {
    // one moved somewhere outside itself
    const target = pick(inside);
    const into = pick(all.filter((e) => !elementsIn(target).includes(e)));
    const from = target.parent as unknown as Element;
    const sides = sidesOf(next, target);
    // and not before itself, which leaves it its own sibling, and a sibling
    // combinator walks that for ever
    const before = into.children.filter(
      (n) => (n as Element).attribs && n !== (target as unknown as ChildNode),
    );
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
        ...sides,
      },
      {
        type: 'childList',
        target: into,
        addedNodes: [target],
        removedNodes: [],
        ...sidesOf(next, target),
      },
    ];
  }
  if (kind === 7 && next() < 0.3) {
    // a light child to another slot, or to none
    const light = all.filter(
      (e) =>
        (e.parent as Element | null)?.attribs &&
        shadowRootOf(e.parent as Element),
    );
    if (light.length) {
      const target = pick(light);
      const was = target.attribs.slot ?? null;
      if (was === null) target.attribs.slot = next() < 0.5 ? 'n' : 'none';
      else delete target.attribs.slot;
      return [
        { type: 'attributes', target, attributeName: 'slot', oldValue: was },
      ];
    }
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

/**
 * A shadow tree put on an element, as a custom element does as it connects:
 * with a slot where most have one, and a sheet of its own where a few do,
 * which makes the cascade again.
 */
function attachOne(next: () => number, body: Element): HtmlChange[] {
  const all = elementsIn(body);
  const free = all.filter(
    (e) =>
      e !== body && ['div', 'span', 'p'].includes(e.name) && outsideDrawings(e),
  );
  const hosts = all.filter((e) => shadowRootOf(e));
  const rule = () =>
    [':host { color: #00aa00 }', 'b { color: #0000ff }', '.a { margin: 1px }'][
      Math.floor(next() * 3)
    ];
  if (hosts.length && next() < 0.4) {
    // a sheet put in a tree there is, or one in it written over
    const root = shadowRootOf(
      hosts[Math.floor(next() * hosts.length)],
    ) as unknown as Element;
    const had = root.children.find((n) => (n as Element).name === 'style') as
      Element | undefined;
    if (had && next() < 0.5) {
      const text = had.children[0] as unknown as { data: string };
      text.data = rule();
      return [{ type: 'characterData', target: text as never }];
    }
    const sheet = createElement('style', {}, [createText(rule())]);
    appendChild(root, sheet);
    return [
      {
        type: 'childList',
        target: root,
        addedNodes: [sheet],
        removedNodes: [],
      },
    ];
  }
  const target = free[Math.floor(next() * free.length)];
  const root = target && attachShadow(target, { mode: 'open' });
  if (!root) return [];
  if (next() < 0.25) {
    appendChild(
      root as unknown as Element,
      createElement('style', {}, [createText(':host { color: #00aa00 }')]),
    );
  }
  appendChild(
    root as unknown as Element,
    createElement('b', { class: 'a' }, [createText('in ')]),
  );
  if (next() < 0.7) {
    appendChild(root as unknown as Element, createElement('slot'));
  }
  return [{ type: 'shadowRoot', target }];
}

/**
 * A sheet change a CSS-in-JS library, a lazy chunk or a late `<link>` makes,
 * done, and its records: a `<style>` put in, rules written into one, its
 * text extended or replaced, one taken out, which the last two of make
 * every element styled again, and one bringing a `@keyframes`, which styles
 * what runs its name (`addedRules`).
 */
function sheetChange(
  next: () => number,
  body: Element,
  sheets: Element[],
): HtmlChange[] {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  // and rules as specific as another sheet's, on an element and on a
  // `::before`, which a place in the cascade decides between
  const rules = () => {
    const ink = pick(['#aa0000', '#00aa00', '#0000aa', '#aaaa00']);
    return [
      ...rulesFor(next, true).split('\n').slice(0, 4),
      ...drawingRulesFor(next).split('\n').slice(0, 2),
      `.a { outline-color: ${ink} }`,
      `.b::before { color: ${ink} }`,
    ].join('\n');
  };
  // at the end of the body, before an element at its top, or in a drawing,
  // at its root or in a group, which is a sheet like any
  const place = (sheet: Element): void => {
    const drawn = elementsIn(body).filter(
      (e) => e.name === 'g' || e.name === 'svg',
    );
    const kids = body.children.filter((n) => (n as Element).attribs);
    const at = next();
    if (drawn.length && at < 0.35) appendChild(pick(drawn), sheet);
    else if (kids.length && at < 0.6) DomUtils.prepend(pick(kids), sheet);
    else appendChild(body, sheet);
  };
  const kind = sheets.length ? Math.floor(next() * 8) : 0;
  if (kind === 6 || kind === 7) {
    const text = pick(sheets).children.find((n) => n.type === 'text') as
      { data: string } | undefined;
    if (kind === 6 && text) {
      // rules written between a sheet's, as styled-components writes each
      // component's group
      const lines = text.data.split('\n');
      const at = Math.floor(next() * (lines.length + 1));
      lines.splice(at, 0, rules());
      text.data = lines.join('\n');
      return [{ type: 'characterData', target: text as never }];
    }
    // a sheet that names a layer, which only the last may do, after which
    // no sheet can name one first
    const name = pick(['', 'a', 'b']);
    const layered = createElement('style', {}, [
      createText(
        next() < 0.3
          ? `@layer b, a;\n${rules()}`
          : `@layer ${name} {\n${rules()}\n}`,
      ),
    ]);
    place(layered);
    sheets.push(layered);
    return [
      {
        type: 'childList',
        target: layered.parent as unknown as Element,
        addedNodes: [layered],
        removedNodes: [],
      },
    ];
  }
  if (kind === 0) {
    const style = createElement('style', {}, [createText(rules())]);
    place(style);
    sheets.push(style);
    return [
      {
        type: 'childList',
        target: style.parent as unknown as Element,
        addedNodes: [style],
        removedNodes: [],
      },
    ];
  }
  const style = pick(sheets);
  if (kind === 1) {
    const text = createText(`\n${rules()}`);
    appendChild(style, text);
    return [
      {
        type: 'childList',
        target: style,
        addedNodes: [text],
        removedNodes: [],
      },
    ];
  }
  const text = style.children.find((n) => n.type === 'text') as
    { data: string } | undefined;
  if (kind === 2 && text) {
    text.data += `\n${rules()}`;
    return [{ type: 'characterData', target: text as never }];
  }
  if (kind === 3 && text) {
    text.data = rules();
    return [{ type: 'characterData', target: text as never }];
  }
  if (kind === 4) {
    const parent = style.parent as unknown as Element;
    removeNode(style as unknown as ChildNode);
    sheets.splice(sheets.indexOf(style), 1);
    return [
      {
        type: 'childList',
        target: parent,
        addedNodes: [],
        removedNodes: [style],
      },
    ];
  }
  const keyed = createElement('style', {}, [
    createText(`@keyframes k { to { color: #ff0000 } }\n${rules()}`),
  ]);
  appendChild(body, keyed);
  sheets.push(keyed);
  return [
    { type: 'childList', target: body, addedNodes: [keyed], removedNodes: [] },
  ];
}

test('sheets put in, written to, extended, replaced and taken out come to the styles of a refresh of everything, and an added rule restyles what it can style', async () => {
  let added = 0;
  let whole = 0;
  let tookOver = 0;
  for (let seed = 1; seed <= 32; seed += 1) {
    const next = mulberry32(seed * 7919);
    // what runs a `@keyframes` no sheet has yet, held half way through it
    const css =
      `${rulesFor(next, true)}\n.a { animation: k 1s paused -0.5s }\n` +
      '.b::before { content: "*"; animation: k 1s paused -0.5s }';
    // a document whose markup writes its `<html>`, and one the cascade
    // supplies one for, which a rule for the root reaches otherwise
    const markup = markupFor(next, false, false, true);
    const full = seed % 2 === 0;
    const source = full
      ? `<!doctype html><html><head><style>body{margin:0}\n${css}</style></head><body>${markup}</body></html>`
      : `<style>body{margin:0}\n${css}</style><body>${markup}</body>`;
    const { result, node } = await render(source, 320);
    const el = view(node);
    await act();
    const bodyEl = elementsIn(el.document as unknown as Element).find(
      (e) => e.name === 'body',
    )!;
    shapesOf(el, bodyEl);
    const sheets: Element[] = [];
    const internals = el as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const sheetsAdded = internals._sheetsAdded;
    for (let step = 0; step < 10; step += 1) {
      const changes =
        next() < 0.6
          ? sheetChange(next, bodyEl, sheets)
          : changeOne(next, bodyEl, false);
      let answer: unknown;
      internals._sheetsAdded = function (this: unknown, ...a: unknown[]) {
        answer = sheetsAdded.apply(this, a);
        return answer;
      };
      const cascadeWas = cascadeOf(el);
      el.touchDocument(changes);
      await act();
      delete internals._sheetsAdded;
      if (
        cascadeOf(el) !== cascadeWas &&
        cascadeOf(el)._index === cascadeWas._index
      ) {
        tookOver += 1;
      }
      if (answer instanceof Set) added += 1;
      else if (answer === null) whole += 1;
      const scoped = stylesOf(el, bodyEl);
      const shapes = shapesOf(el, bodyEl);
      el.touchDocument();
      await act();
      const styled = stylesOf(el, bodyEl);
      assert.deepStrictEqual(
        shapes,
        shapesOf(el, bodyEl),
        `seed ${seed}, step ${step}: what a shape is given\n` +
          `sheets\n${sheets.map((st) => DomUtils.textContent(st)).join('\n---\n')}`,
      );
      const at = firstApart(scoped, styled);
      assert.ok(
        at < 0 && scoped.length === styled.length,
        `seed ${seed}, step ${step}: ${String(scoped[at]).slice(0, 300)}\n` +
          `styled whole: ${String(styled[at]).slice(0, 300)}\n` +
          `sheets\n${sheets.map((st) => DomUtils.textContent(st)).join('\n---\n')}`,
      );
      // and a cascade that took over the one before it styles what one made
      // from nothing does: the refresh above asks the same cascade, which
      // would agree with itself. Put back, so the next step takes it over.
      const chain = el as unknown as {
        _sheetsRead: unknown;
        _cascade: unknown;
      };
      const { _sheetsRead, _cascade } = chain;
      chain._sheetsRead = null;
      el.touchDocument();
      await act();
      const made = stylesOf(el, bodyEl);
      chain._sheetsRead = _sheetsRead;
      chain._cascade = _cascade;
      el.touchDocument();
      await act();
      const apart = firstApart(styled, made);
      assert.ok(
        apart < 0 && styled.length === made.length,
        `seed ${seed}, step ${step}: ${String(styled[apart]).slice(0, 300)}\n` +
          `from nothing: ${String(made[apart]).slice(0, 300)}\n` +
          `sheets\n${sheets.map((st) => DomUtils.textContent(st)).join('\n---\n')}`,
      );
    }
    result.unmount();
  }
  // the added rules restyled what they could style often enough to say so,
  // and the changes they could not vouch for styled everything again
  assert.ok(added > 20, `${added} sheet changes restyled what they reach`);
  assert.ok(whole > 5, `${whole} sheet changes restyled everything`);
  assert.ok(tookOver > 20, `${tookOver} cascades took over the one before`);
});

metric(
  'a sheet that brings a @keyframes styles what runs its name, and nothing else',
  async () => {
    // Wikipedia's chunks of CSS each bring one, and each styled all 18,000
    // elements of an article again
    const paragraphs = Array.from(
      { length: 200 },
      (_, i) => `<p id="p${i}">p${i}</p>`,
    ).join('');
    const { node } = await render(
      '<style id="own">body{margin:0}.runs{animation:late 1s paused -0.5s}' +
        '.after::before{content:"*";animation:late 1s paused -0.5s}' +
        '.none::before{content:"*";display:contents;' +
        'animation:late 1s paused -0.5s}' +
        '.later{animation:later 1s paused -0.5s}</style>' +
        `<body><div id="runs" class="runs">r</div>` +
        `<div id="after" class="after">a</div>` +
        `<div id="none" class="none">n</div>` +
        `<div id="later" class="later">l</div>${paragraphs}</body>`,
      300,
    );
    const el = view(node);
    await act();
    const inked = (box: unknown): string =>
      (box as { style: { color: string } }).style.color;
    const before = (id = 'after'): unknown =>
      (
        boxOf(el, id) as unknown as {
          children: { pseudo?: string | null }[];
        }
      ).children.find((kid) => kid.pseudo === 'before');
    const black = inked(boxOf(el, 'runs'));
    assert.strictEqual(inked(before()), black);
    assert.strictEqual(inked(before('none')), black);
    const body = byId(el, 'runs').parent as Element;
    const sheet = createElement('style', {}, [
      createText(
        '@keyframes late { from { color: #000000 } to { color: #ff0000 } }',
      ),
    ]);
    appendChild(body, sheet);
    const styled = await stylesComputed(el, async () => {
      el.touchDocument([
        {
          type: 'childList',
          target: body,
          addedNodes: [sheet],
          removedNodes: [],
          previousSibling: null,
          nextSibling: null,
        },
      ]);
      await act();
    });
    assert.ok(styled < 30, `${styled} styles for one animation`);
    assert.notStrictEqual(inked(boxOf(el, 'runs')), black, 'it does not run');
    assert.notStrictEqual(inked(before()), black, 'its ::before does not');
    // a `display: contents` one's box has less of its style than it does
    assert.notStrictEqual(inked(before('none')), black, 'nor one with no box');
    assert.strictEqual(inked(boxOf(el, 'later')), black, 'nor should this');
    // and one written at the end of a sheet, as a CSS-in-JS library writes
    const text = byId(el, 'own').children[0] as unknown as { data: string };
    text.data +=
      '@keyframes later { from { color: #000000 } to { color: #00ff00 } }';
    const more = await stylesComputed(el, async () => {
      el.touchDocument([
        { type: 'characterData', target: text as unknown as ChildNode },
      ]);
      await act();
    });
    assert.ok(more < 30, `${more} styles for one written`);
    assert.notStrictEqual(inked(boxOf(el, 'later')), black, 'it does not run');
  },
);

test('a sheet that names a layer first before others named it restyles everything, since the layers rank otherwise', async () => {
  // `b` ranks before `a`, where the document first names them, so `a`'s
  // blue wins; a sheet put in ahead of them that names `a` first, and the
  // first sheet written to name it, rank `a` before `b`, and `b`'s red
  // wins on an element none of their own rules matches
  for (const how of ['before', 'written'] as const) {
    const { node } = await render(
      '<!doctype html><html><head>' +
        '<style id="s1">@layer b { .x { color: #ff0000 } }</style>' +
        '<style id="s2">@layer a { .x { color: #0000ff } }</style>' +
        '</head><body><p id="p" class="x">x</p><p id="q">q</p></body></html>',
      300,
    );
    const el = view(node);
    await act();
    const p = findById(el.document, 'p')!;
    assert.strictEqual(el.computedStyle(p)?.color, 'rgb(0, 0, 255)');
    const s1 = findById(el.document, 's1')!;
    let change: HtmlChange;
    if (how === 'before') {
      const sheet = createElement('style', {}, [
        createText('@layer a { #q { color: #00aa00 } }'),
      ]);
      DomUtils.prepend(s1 as unknown as ChildNode, sheet);
      change = {
        type: 'childList',
        target: s1.parent as unknown as Element,
        addedNodes: [sheet],
        removedNodes: [],
      };
    } else {
      const text = createText('\n@layer a { #q { color: #00aa00 } }');
      DomUtils.prepend(s1.children[0] as unknown as ChildNode, text);
      change = {
        type: 'childList',
        target: s1,
        addedNodes: [text],
        removedNodes: [],
      };
    }
    el.touchDocument([change]);
    await act();
    assert.strictEqual(
      el.computedStyle(findById(el.document, 'q')!)?.color,
      'rgb(0, 170, 0)',
      how,
    );
    assert.strictEqual(el.computedStyle(p)?.color, 'rgb(255, 0, 0)', how);
    await cleanup();
  }
});

test('a refresh told what changed comes to the styles of a refresh of everything', async () => {
  const ways = await refreshesAgree(40, false);
  const scoped = ways.inPlace + ways.frame + ways.build;
  assert.ok(scoped > ways.whole, `${JSON.stringify(ways)}`);
  for (const way of ['inPlace', 'frame', 'build'] as const) {
    if (way === 'inPlace' && !FONTS) continue;
    assert.ok(ways[way] > 0, `no refresh went ${way}: ${JSON.stringify(ways)}`);
  }
});

test('a refresh whose reach below what changed is narrowed to its rules’ subjects comes to the styles of a refresh of everything', async () => {
  // how many changes reached below their element only what the subjects
  // of the rules testing them name
  const change = Cascade.prototype.attributeChange;
  let narrowed = 0;
  Cascade.prototype.attributeChange = function (
    this: Cascade,
    ...a: Parameters<Cascade['attributeChange']>
  ) {
    const reach = change.apply(this, a);
    if (reach?.below && reach.bits & CHANGES_BELOW) narrowed += 1;
    return reach;
  };
  try {
    const ways = await refreshesAgree(
      40,
      false,
      false,
      undefined,
      3000,
      belowRulesFor,
    );
    const scoped = ways.inPlace + ways.frame + ways.build;
    assert.ok(scoped > ways.whole, `${JSON.stringify(ways)}`);
    // and with shadow trees, and rules across their edges, beside them
    await refreshesAgree(12, true, true, undefined, 4000, belowRulesFor);
    assert.ok(narrowed > 40, `${narrowed} changes narrowed`);
  } finally {
    Cascade.prototype.attributeChange = change;
  }
});

test('in a document of drawings, a refresh told what changed gives their shapes what a refresh of everything does', async () => {
  const seeds = Number(process.env.SHAPE_SEEDS ?? 24);
  const from = Number(process.env.SHAPE_FROM ?? 1);
  const ways = await refreshesAgree(
    seeds,
    false,
    false,
    undefined,
    from,
    drawingRulesFor,
    true,
  );
  assert.ok(
    ways.shapes >= seeds,
    `${ways.shapes} changes reached a shape from outside its drawing`,
  );
});

test('in a document of :has()s that ask only of their children and of sibling combinators, a refresh told what changed comes to the same styles', async () => {
  const ways = await refreshesAgree(
    30,
    false,
    false,
    undefined,
    1,
    reachRulesFor,
  );
  const scoped = ways.inPlace + ways.frame + ways.build;
  assert.ok(scoped > ways.whole, `${JSON.stringify(ways)}`);
  // and with shadow trees, and rules across their edges: an element a
  // script moves into a tree is styled by that tree's rules
  await refreshesAgree(20, true, true, undefined, 1, reachRulesFor);
});

test('in a document of functions in :has()s, a refresh told what changed comes to the same styles', async () => {
  const ways = await refreshesAgree(30, false, false, undefined, 1, (next) =>
    hasFunctionRulesFor(next, false),
  );
  const scoped = ways.inPlace + ways.frame + ways.build;
  assert.ok(scoped > ways.whole, `${JSON.stringify(ways)}`);
  // and one that reads elements no walk finds, which is every element
  // styled again
  await refreshesAgree(120, false, false, undefined, 500, (next) =>
    hasFunctionRulesFor(next, true),
  );
});

test('in a document with shadow trees whose rules stay inside them, a refresh told what changed comes to the same styles', async () => {
  const ways = await refreshesAgree(30, true);
  const scoped = ways.inPlace + ways.frame + ways.build;
  assert.ok(scoped > ways.whole, `${JSON.stringify(ways)}`);
  for (const way of ['inPlace', 'build'] as const) {
    if (way === 'inPlace' && !FONTS) continue;
    assert.ok(ways[way] > 0, `no refresh went ${way}: ${JSON.stringify(ways)}`);
  }
});

/** Rules on what a control holds and on what is around it, of an element
 *  and through each way a change reaches further. */
function controlRulesFor(next: () => number): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const c = () => pick(CLASSES);
  // what no key says, first: an answer read from other elements, which is
  // what a change has to be widened to reach (`controlsReached`)
  const around = () =>
    pick([
      'form:invalid',
      'form:valid',
      'fieldset:invalid',
      'fieldset:valid',
      'input:indeterminate',
      'button:default',
      'input:default',
    ]);
  const own = () =>
    pick([
      ':valid',
      ':invalid',
      ':user-valid',
      ':user-invalid',
      ':placeholder-shown',
      ':in-range',
      ':out-of-range',
      ':read-write',
      ':read-only',
      ':dir(rtl)',
      ':dir(ltr)',
    ]);
  const state = () => (next() < 0.6 ? around() : `${what()}${own()}`);
  const what = () => pick(['', 'input', 'select', 'button', `.${c()}`]);
  const shapes: (() => string)[] = [
    () => state(),
    () => `${state()} b`,
    () => `${state()} > b`,
    () => `${state()} ~ b`,
    () => `:not(${state()}) > b`,
    () => `div:has(${state()}) > b`,
    () => `section:has(${state()}) b`,
    () => `form:has(${state()}) b`,
    () => `fieldset:has(> ${state()}) > b`,
    () => `section:has(+ section ${state()})`,
  ];
  const rules: string[] = [];
  const count = 10 + Math.floor(next() * 8);
  for (let i = 0; i < count; i += 1) {
    const ink = pick(INKS);
    rules.push(
      `${pick(shapes)()} { ${pick([`color: ${ink}`, `background-color: ${ink}`, 'font-weight: bold', 'display: block', 'padding-left: 7px'])} }`,
    );
  }
  return rules.join('\n');
}

const CONTROL_ATTRIBUTES: readonly (readonly [string, readonly string[]])[] = [
  ['required', ['']],
  ['required', ['']],
  ['checked', ['']],
  ['checked', ['']],
  ['disabled', ['']],
  ['readonly', ['']],
  ['type', ['text', 'number', 'radio', 'checkbox', 'submit', 'date', 'tel']],
  ['name', ['g', 'h']],
  ['form', ['f0', 'f1', 'nothing']],
  ['value', ['', 'x', '3', '30', '2020-01-02']],
  ['checked', ['']],
  ['min', ['5', '2020-01-01']],
  ['max', ['9']],
  ['step', ['2']],
  ['pattern', ['a+']],
  ['placeholder', ['p']],
  ['dir', ['rtl', 'ltr', 'auto']],
  ['contenteditable', ['', 'false']],
];

/** A control of a random kind, as markup. */
function controlFor(next: () => number): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const attributes = CONTROL_ATTRIBUTES.filter(() => next() < 0.2)
    .map(([name, values]) => `${name}="${pick(values)}"`)
    .join(' ');
  const c = pick(CLASSES);
  return pick([
    `<input class="${c}" ${attributes}>`,
    `<input class="${c}" type="radio" name="g" ${attributes}>`,
    `<input class="${c}" type="number" ${attributes}>`,
    `<button class="${c}" ${attributes}>b</button>`,
    `<textarea class="${c}" ${attributes}>t</textarea>`,
    `<select class="${c}" ${attributes}><option value="">o</option><option>p</option></select>`,
  ]);
}

/** Forms, fieldsets and what is outside either, with something beside each
 *  control for a rule to reach. */
function controlMarkupFor(next: () => number): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const line = () =>
    `<div class="${pick(CLASSES)}">${controlFor(next)}<b>b</b></div>`;
  const lines = (n: number) => Array.from({ length: n }, line).join('');
  return (
    `<section class="a"><form id="f0">${lines(2)}<fieldset class="b">${lines(2)}<b>f</b></fieldset><b>f</b></form></section>` +
    `<section class="b"><form id="f1">${lines(2)}<b>f</b></form></section>` +
    `<section class="c">${lines(3)}<div dir="auto" class="d">text<b>b</b></div><bdi>text</bdi><b>s</b></section>`
  );
}

/** A change to a control a user or a script might make, done, and what a
 *  refresh is told of it. */
function controlChangeFor(
  next: () => number,
  body: Element,
  forms: FormState,
): HtmlChange[] {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const all = elementsIn(body);
  const controls = all.filter((e) =>
    ['input', 'button', 'textarea', 'select'].includes(e.name),
  );
  // those another element's answer reads, half the time
  const read = controls.filter(
    (e) => e.name === 'button' || e.attribs.type === 'radio',
  );
  const target = pick(
    read.length && next() < 0.5 ? read : controls.length ? controls : all,
  );
  const kind = Math.floor(next() * 10);
  if (kind < 3) {
    const [attributeName, values] = pick(CONTROL_ATTRIBUTES);
    const oldValue = target.attribs[attributeName] ?? null;
    target.attribs[attributeName] = pick(values);
    return [{ type: 'attributes', target, attributeName, oldValue }];
  }
  if (kind === 3) {
    const [attributeName] = pick(CONTROL_ATTRIBUTES);
    const oldValue = target.attribs[attributeName] ?? null;
    delete target.attribs[attributeName];
    return [{ type: 'attributes', target, attributeName, oldValue }];
  }
  if (kind === 4) {
    forms.setTyped(target, pick(['', 'x', '3', '30', 'مرحبا']));
    return [controlChange(target)];
  }
  if (kind === 5) {
    const moved = pick([
      () => setCustomError(target, next() < 0.5 ? 'no' : ''),
      () => setIndeterminate(target, next() < 0.5),
      () => setUserValidity(target, next() < 0.5),
    ])();
    return moved ? [controlChange(target)] : [];
  }
  if (kind === 6) {
    const parent = target.parent as Element;
    DomUtils.removeElement(target);
    return [
      {
        type: 'childList',
        target: parent,
        addedNodes: [],
        removedNodes: [target],
      },
    ];
  }
  if (kind === 7) {
    const holders = all.filter((e) =>
      ['div', 'form', 'fieldset', 'section'].includes(e.name),
    );
    const holder = pick(holders);
    const added = new HtmlSource();
    added.setSource(controlFor(next), true);
    const made = added.document.children.find(
      (n) => n.type === 'tag',
    ) as Element;
    DomUtils.removeElement(made);
    DomUtils.appendChild(holder, made);
    return [
      {
        type: 'childList',
        target: holder,
        addedNodes: [made],
        removedNodes: [],
      },
    ];
  }
  // text a direction or a default is read from
  const holders = all.filter((e) =>
    ['div', 'bdi', 'textarea'].includes(e.name),
  );
  const holder = pick(holders.length ? holders : all);
  const text = holder.children.find((n) => n.type === 'text') as
    { data: string } | undefined;
  if (!text) return [];
  text.data = pick(['text', 'مرحبا', '123', '']);
  return [{ type: 'characterData', target: text as unknown as ChildNode }];
}

test('a row with a control in it, put in a list, restyles the row and no row before it, however many there are', async () => {
  // a rule that reads a control's state, one that reads a direction above
  // what it styles, and a list of rows with a checkbox each: a mail page's,
  // whose every page of rows restyled all the rows there were
  const rows = Array.from(
    { length: 40 },
    (_, i) => `<div class="row" id="r${i}"><input type="checkbox"></div>`,
  ).join('');
  const { node } = await render(
    '<style>.field:not(:placeholder-shown) { color: #ff0000 }' +
      '.item:dir(rtl) .mark { color: #00ff00 }</style>' +
      `<div id="list">${rows}</div>`,
    320,
  );
  const el = view(node);
  await act();
  const list = byId(el, 'list');
  const row = createElement('div', { class: 'row', id: 'new' });
  appendChild(row, createElement('input', { type: 'checkbox' }));
  appendChild(list, row);
  const own = scopeOf(el, [
    {
      type: 'childList',
      target: list,
      addedNodes: [row],
      removedNodes: [],
      previousSibling: byId(el, 'r39'),
      nextSibling: null,
    },
  ]);
  assert.ok(own, 'a refresh of everything');
  assert.ok(own.has(row), 'what came is not styled');
  assert.ok(!own.has(byId(el, 'r0')), 'a row that was there is restyled');
  assert.ok(own.size <= 4, `${own.size} restyled`);
});

test('a change to a radio’s group restyles the fieldset around each radio in it, wherever the radio that changed is', async () => {
  // a fieldset answers for what is in it, and a radio for its group, so a
  // radio outside the fieldset moves its answer with nothing of the change
  // inside it
  const { node } = await render(
    '<style>fieldset:valid, input:valid { color: #ff0000 }</style>' +
      '<form><div id="d"><input id="a" type="radio" name="g" required></div>' +
      '<fieldset id="f"><input id="r" type="radio" name="g"></fieldset>' +
      '<input id="b" type="radio" name="g"></form>',
    320,
  );
  const el = view(node);
  await act();
  const valid = 'rgb(255, 0, 0)';
  const colour = (id = 'f') => el.computedStyle(byId(el, id))?.color;
  assert.notStrictEqual(colour(), valid, 'a required group with none checked');
  // the only required radio goes
  const a = byId(el, 'a');
  const holder = a.parent as Element;
  DomUtils.removeElement(a);
  el.touchDocument([
    { type: 'childList', target: holder, addedNodes: [], removedNodes: [a] },
  ]);
  assert.strictEqual(colour(), valid, 'a radio taken out');
  // another comes to be
  const b = byId(el, 'b');
  b.attribs.required = '';
  el.touchDocument([
    {
      type: 'attributes',
      target: b,
      attributeName: 'required',
      oldValue: null,
    },
  ]);
  assert.notStrictEqual(colour(), valid, 'a radio made required');
  assert.notStrictEqual(colour('r'), valid, 'another radio of its group');
  // and is checked
  b.attribs.checked = '';
  el.touchDocument([
    { type: 'attributes', target: b, attributeName: 'checked', oldValue: null },
  ]);
  assert.strictEqual(colour(), valid, 'a radio checked');
});

test('a control put in what holds no form tells nothing of what is there, whatever a rule below a form names', async () => {
  // what a form answers for from what is in it reaches what is in the
  // form: a `<div>` no selector answers for from what it holds is no form
  const { node } = await render(
    '<style>form:invalid * { color: #ff0000 }</style>' +
      '<form></form><div id="list"><b id="old">x</b></div>',
    320,
  );
  const el = view(node);
  await act();
  const list = byId(el, 'list');
  const input = createElement('input', {});
  appendChild(list, input);
  const own = scopeOf(el, [
    { type: 'childList', target: list, addedNodes: [input], removedNodes: [] },
  ]);
  assert.ok(own?.has(input), 'what came is not styled');
  assert.ok(!own?.has(byId(el, 'old')), 'what was there is restyled');
});

test('a direction or a language reaches what its rules can style of what is below it, and all of that', async () => {
  // told of a form's controls, of a turn of a text, and of a `lang`: each
  // reaches `.mark`, under the `.item` or as the rule's own subject, and
  // not what no rule styles
  const { node } = await render(
    '<style>.item:dir(rtl) .mark { color: #00ff00 }' +
      '.own:dir(rtl) { color: #0000ff }</style>' +
      '<form id="f"><div class="item"><b class="mark" id="m">x</b>' +
      '<i id="other">y</i></div><u class="own" id="o">z</u></form>',
    320,
  );
  const el = view(node);
  await act();
  const form = byId(el, 'f');
  const input = createElement('input', {});
  appendChild(form, input);
  const own = scopeOf(el, [
    { type: 'childList', target: form, addedNodes: [input], removedNodes: [] },
  ]);
  assert.ok(own?.has(byId(el, 'm')), 'the subject below is not reached');
  assert.ok(own?.has(byId(el, 'o')), 'a rule’s own subject is not reached');
  assert.ok(!own?.has(byId(el, 'other')), 'what no rule styles is reached');
});

test('a text that turns a direction restyles what reads it, above its rule’s subject and at it', async () => {
  const { node } = await render(
    '<style>.item:dir(rtl) .mark { color: #00ff00 }' +
      '.own:dir(rtl) { color: #0000ff }</style>' +
      '<div dir="auto" id="d"><span id="t">latin</span>' +
      '<div class="item"><b class="mark" id="m">x</b></div>' +
      '<u class="own" id="o">z</u></div>',
    320,
  );
  const el = view(node);
  await act();
  const text = byId(el, 't').children[0] as unknown as { data: string };
  text.data = 'אבג';
  el.touchDocument([{ type: 'characterData', target: text as never }]);
  await act();
  assert.strictEqual(el.computedStyle(byId(el, 'm'))?.color, 'rgb(0, 255, 0)');
  assert.strictEqual(el.computedStyle(byId(el, 'o'))?.color, 'rgb(0, 0, 255)');
});

test('in a document of form controls, a refresh told what changed comes to the styles of a refresh of everything', async () => {
  // A control's state reads what is around it, a radio's group and a
  // form's controls among it, and no key says so: `controlsReached` does.
  let scoped = 0;
  const seeds = Number(process.env.CONTROL_SEEDS ?? 8);
  const from = Number(process.env.CONTROL_FROM ?? 1);
  for (let seed = from; seed < from + seeds; seed += 1) {
    const next = mulberry32(seed * 6271);
    const css = controlRulesFor(next);
    const { result, node } = await render(
      `<style>body{margin:0}\n${css}</style><body>${controlMarkupFor(next)}</body>`,
      320,
    );
    const el = view(node);
    await act();
    const bodyEl = el.document.children.find(
      (n) => (n as Element).name === 'body',
    ) as Element;
    const forms = new FormState();
    for (let step = 0; step < 10; step += 1) {
      const changes = controlChangeFor(next, bodyEl, forms);
      const asked = (
        el as unknown as { _changeScope(c: HtmlChange[]): unknown }
      )._changeScope(changes);
      if (asked) scoped += 1;
      el.touchDocument(changes);
      const told = stylesOf(el, bodyEl);
      el.touchDocument();
      const whole = stylesOf(el, bodyEl);
      const at = firstApart(told, whole);
      assert.ok(
        at < 0 && told.length === whole.length,
        `seed ${seed}, step ${step}: ${changes.map((c) => `${c.type} ${c.type === 'attributes' ? c.attributeName : ''} on ${(c.target as Element).name}`).join(', ')}\n` +
          `told: ${String(told[at]).slice(0, 200)}\nwhole: ${String(whole[at]).slice(0, 200)}\n` +
          `rules\n${css}\n${DomUtils.getOuterHTML(bodyEl)}`,
      );
    }
    result.unmount();
  }
  assert.ok(scoped > seeds * 5, `${scoped} refreshes said what they reached`);
});

test('in a document of :has() and attribute selectors, a refresh told what changed comes to the same styles, and finds the elements whose answer changed', async () => {
  // how many elements a set of anchors found to be one's
  const at = ChangeAnchors.prototype.at;
  let found = 0;
  ChangeAnchors.prototype.at = function (
    this: ChangeAnchors,
    ...args: Parameters<ChangeAnchors['at']>
  ) {
    const bits = at.apply(this, args);
    if (bits) found += 1;
    return bits;
  };
  try {
    // no shape here reaches everything, so no refresh is of everything
    const ways = await refreshesAgree(120, false, false, 0.7, 1000);
    assert.strictEqual(ways.whole, 0, `${JSON.stringify(ways)}`);
    assert.ok(found > 1000, `${found} elements found by an anchor`);
  } finally {
    ChangeAnchors.prototype.at = at;
  }
});

test('a host’s colour reaches its shadow tree in place, and what its top holds is told', async () => {
  const { result, node } = await render(
    '<style>body{margin:0} .on{color:#ff0000}</style>' +
      '<div id="h"><template shadowrootmode="open"><p>in</p><b>b</b></template></div>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const host = byId(el, 'h');
  const root = shadowRootOf(host)!;
  const inner = root.children.find(
    (n) => (n as Element).name === 'p',
  ) as Element;
  const tree = treeOf(el);
  el.touchDocument([setClass(host, 'on')]);
  await snapshot(result, el);
  assert.ok(treeOf(el) === tree, 'the boxes were built again');
  assert.equal(el.computedStyle(inner)?.color, 'rgb(255, 0, 0)');
  // an element taken from the top of the tree is a change its root holds
  const b = root.children.find((n) => (n as Element).name === 'b') as Element;
  removeNode(b as unknown as ChildNode);
  const scope = (
    el as unknown as { _changeScope(c: HtmlChange[]): unknown }
  )._changeScope([
    {
      type: 'childList',
      target: root as never,
      addedNodes: [],
      removedNodes: [b],
    },
  ]);
  assert.ok(scope, 'the change was a refresh of everything');
});

test('a shadow tree put on an element builds its host, and none of the document around it', async () => {
  const { result, node } = await render(
    '<style>body{margin:0} .far{height:20px}</style>' +
      '<body><div class="far" id="before">before</div>' +
      '<div id="h"><b id="slotted" slot="s">taken</b><i id="left">left</i></div>' +
      '<div class="far" id="after">after</div></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const host = byId(el, 'h');
  const box = (id: string) =>
    (el as unknown as { _firstBoxesOf(t: unknown): Map<Element, unknown> })
      ._firstBoxesOf(treeOf(el))
      .get(byId(el, id));
  const far = box('before');
  const root = attachShadow(host, { mode: 'open' })!;
  appendChild(root as unknown as Element, createText('['));
  const slot = createElement('slot', { name: 's' });
  appendChild(root as unknown as Element, slot);
  appendChild(root as unknown as Element, createText(']'));
  const build = (el as unknown as Record<string, unknown>)._subtreeBuild as (
    ...a: unknown[]
  ) => unknown;
  let built: unknown;
  (el as unknown as Record<string, unknown>)._subtreeBuild = function (
    this: unknown,
    ...a: unknown[]
  ) {
    built = build.apply(this, a);
    return built;
  };
  el.touchDocument([{ type: 'shadowRoot', target: host }]);
  await snapshot(result, el);
  assert.ok(built, 'the whole document was built');
  assert.ok(box('before') === far, 'what is around the host was built');
  // what its slot takes is drawn in the tree, and what none takes is not
  assert.ok(el.computedStyle(byId(el, 'slotted')));
  assert.equal(el.computedStyle(byId(el, 'left')), null);
  assert.equal(drawnText(el).replace(/\s+/g, ''), 'before[taken]after');
});

test('a host put in with its shadow tree styles the tree by the tree’s own sheet', async () => {
  const { result, node } = await render(
    '<style>body{margin:0}</style><div id="into">x</div>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  // made apart from the document, as a custom element's constructor does,
  // and put in by a later task
  const host = createElement('div', { id: 'h' });
  const root = attachShadow(host, { mode: 'open' })!;
  appendChild(
    root as unknown as Element,
    createElement('style', {}, [createText('p { color: #00aa00 }')]),
  );
  const inner = createElement('p', {}, [createText('in')]);
  appendChild(root as unknown as Element, inner);
  const into = byId(el, 'into');
  appendChild(into, host);
  el.touchDocument([
    { type: 'childList', target: into, addedNodes: [host], removedNodes: [] },
  ]);
  await snapshot(result, el);
  assert.equal(el.computedStyle(inner)?.color, 'rgb(0, 170, 0)');
});

test('what a <template> comes to hold keeps no style, whatever else a change builds', async () => {
  const { result, node } = await render(
    '<style>body{margin:0} .off{display:none} .on{color:#ff0000}</style>' +
      '<body><p class="off" id="moved">m</p><template id="t"></template>' +
      '<div id="a">a</div><div id="b">b</div><div id="c">c</div>' +
      '<div id="d">d</div></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const moved = byId(el, 'moved');
  const from = moved.parent as Element;
  const into = byId(el, 't');
  appendChild(into, moved);
  const a = byId(el, 'a');
  a.attribs.class = 'on';
  el.touchDocument([
    { type: 'childList', target: from, addedNodes: [], removedNodes: [moved] },
    { type: 'childList', target: into, addedNodes: [moved], removedNodes: [] },
    {
      type: 'attributes',
      target: a,
      attributeName: 'class',
      oldValue: null,
    },
  ]);
  await snapshot(result, el);
  const tree = treeOf(el) as unknown as { styles: Map<Element, unknown> };
  assert.ok(!tree.styles.has(moved), 'a style was kept for what a build skips');
  assert.equal(el.computedStyle(a)?.color, 'rgb(255, 0, 0)');
});

test('a sheet put in a shadow tree styles its host and what it holds, and builds what is around it no more', async () => {
  const { result, node } = await render(
    '<style>body{margin:0}</style><body><div id="far">far</div>' +
      '<div id="h"><template shadowrootmode="open"><b id="in">in</b></template></div>' +
      '<div id="twin"><template shadowrootmode="open"><b id="other">in</b></template></div></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const box = () =>
    (el as unknown as { _firstBoxesOf(t: unknown): Map<Element, unknown> })
      ._firstBoxesOf(treeOf(el))
      .get(byId(el, 'far'));
  const far = box();
  const put = async (id: string) => {
    const host = byId(el, id);
    const root = shadowRootOf(host)!;
    const sheet = createElement('style', {}, [
      createText(':host { color: #00aa00 } b { font-weight: bold }'),
    ]);
    appendChild(root as unknown as Element, sheet);
    el.touchDocument([
      {
        type: 'childList',
        target: root as never,
        addedNodes: [sheet],
        removedNodes: [],
      },
    ]);
    await snapshot(result, el);
    assert.ok(box() === far, 'what is around the host was built');
    assert.equal(el.computedStyle(host)?.color, 'rgb(0, 170, 0)');
    const inner = root.children.find(
      (n) => (n as Element).name === 'b',
    ) as Element;
    assert.equal(el.computedStyle(inner)?.['font-weight'], '700');
  };
  await put('h');
  // and the second of its kind, whose rules are the first's, the cascade
  // kept for it
  const cascade = (el as unknown as { _cascade: unknown })._cascade;
  await put('twin');
  assert.ok((el as unknown as { _cascade: unknown })._cascade === cascade);
});

test('what a shadow tree’s sheet imports late styles the tree', async () => {
  let arrive: (result: ResourceResult) => void = () => {};
  const onResource = (r: ResourceRequest) =>
    r.kind === 'stylesheet'
      ? new Promise<ResourceResult>((resolve) => (arrive = resolve))
      : null;
  const { result, node } = await render(
    '<style>body{margin:0}</style><body>' +
      '<div id="h"><template shadowrootmode="open">' +
      '<style>@import "late.css"; b { color: #00aa00 }</style><b>in</b>' +
      '</template></div></body>',
    300,
    { onResource },
  );
  const el = view(node);
  await snapshot(result, el);
  const inner = shadowRootOf(byId(el, 'h'))!.children.find(
    (n) => (n as Element).name === 'b',
  ) as Element;
  assert.strictEqual(el.computedStyle(inner)?.['font-style'], 'normal');
  arrive({ kind: 'stylesheet', text: 'b { font-style: italic }' });
  await snapshot(result, el);
  assert.strictEqual(el.computedStyle(inner)?.['font-style'], 'italic');
});

const elementParentOf = (el: Element) => el.parent as unknown as Element;

/** A `<style>` a script puts in, before `at` or at the end of `body`. */
function putSheet(
  el: HtmlViewNode,
  css: string,
  at: Element | null = null,
): Element {
  const body = elementsIn(el.document as unknown as Element).find(
    (e) => e.name === 'body',
  )!;
  const style = createElement('style', {}, [createText(css)]);
  if (at) DomUtils.prepend(at, style);
  else appendChild(body, style);
  el.touchDocument([
    {
      type: 'childList',
      target: style.parent as unknown as Element,
      addedNodes: [style],
      removedNodes: [],
    },
  ]);
  return style;
}

test('a sheet put in files its own rules in the indexes it finds, and walks no others', async () => {
  const { node } = await render(
    '<style>body{margin:0} .a{color:#111111} .a::before{color:#111111}</style>' +
      '<body><p class="a" id="p">p</p><p class="b" id="q">q</p></body>',
    300,
  );
  const el = view(node);
  await act();
  const was = cascadeOf(el);
  putSheet(el, '.b { color: #00aa00 } .b::before { content: "x" }');
  await act();
  const now = cascadeOf(el);
  assert.notStrictEqual(now, was, 'a cascade for the new sheet');
  assert.strictEqual(now._index, was._index);
  assert.strictEqual(now._pseudo, was._pseudo);
  assert.strictEqual(now._latest.length, 2);
  assert.strictEqual(el.computedStyle(byId(el, 'q'))?.color, 'rgb(0, 170, 0)');
  assert.strictEqual(el.computedStyle(byId(el, 'p'))?.color, 'rgb(17, 17, 17)');
});

test("the host's sheets are parsed once, so a sheet put in takes the indexes over under them too", async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><body><p id="p">p</p></body>',
    300,
    { stylesheet: 'p { color: #00aa00 }' },
  );
  const el = view(node);
  await act();
  const was = cascadeOf(el);
  // the same as the host's, before it in the cascade
  putSheet(el, 'p { color: #ff0000 }');
  await act();
  assert.notStrictEqual(cascadeOf(el), was);
  assert.strictEqual(cascadeOf(el)._index, was._index);
  assert.strictEqual(cascadeOf(el)._latest.length, 1);
  assert.strictEqual(el.computedStyle(byId(el, 'p'))?.color, 'rgb(0, 170, 0)');
});

test('a sheet put in before another comes before it, however the indexes hold the rules', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><body>' +
      '<x-a id="h"><template shadowrootmode="open"><b part="q">in</b></template></x-a>' +
      '<p class="a" id="p">p</p>' +
      '<style id="late">' +
      '.a { color: #00aa00 }\n' +
      '.a::before { content: "x"; color: #00aa00 }\n' +
      'x-a::part(q)::before { content: "x"; color: #00aa00 }\n' +
      '.a::highlight(h) { color: #00aa00 }\n' +
      '::view-transition-group(v) { color: #00aa00 }' +
      '</style></body>',
    300,
  );
  const el = view(node);
  await act();
  const was = cascadeOf(el);
  // long enough that a rule of the last sheet left where it was comes
  // before all of these
  putSheet(
    el,
    '.z { color: #000000 }\n.y { color: #000000 }\n.x { color: #000000 }\n' +
      '.w { color: #000000 }\n.v { color: #000000 }\n.u { color: #000000 }\n' +
      '.a { color: #ff0000 }\n.a::before { color: #ff0000 }\n' +
      'x-a::part(q)::before { color: #ff0000 }',
    byId(el, 'late'),
  );
  await act();
  const now = cascadeOf(el);
  assert.strictEqual(now._index, was._index);
  const p = byId(el, 'p');
  assert.strictEqual(el.computedStyle(p)?.color, 'rgb(0, 170, 0)');
  assert.strictEqual(el.computedStyle(p, 'before')?.color, 'rgb(0, 170, 0)');
  const inner = shadowRootOf(byId(el, 'h'))!.children.find(
    (n) => (n as Element).name === 'b',
  ) as Element;
  assert.strictEqual(
    el.computedStyle(inner, 'before')?.color,
    'rgb(0, 170, 0)',
  );
  // and what no style says here: each rule filed anywhere has the place of
  // the sheet's rule it was made from
  const places = new Map<object, number>();
  for (const sheet of now._sheets) {
    for (const rule of sheet.rules) places.set(rule.declarations, rule.order);
  }
  const filed = [
    ...now._index.all(),
    ...Object.values(now._pseudo).flatMap((index) => [...index.all()]),
    ...[...now._highlights.values()].flatMap((index) => [...index.all()]),
    ...now._transitionRules.all(),
    ...now._document.parts,
  ];
  assert.ok(filed.length > 12, `${filed.length} rules filed`);
  for (const { rule } of filed) {
    // the user agent's lists share their declarations, and never move
    if (rule.order >= 0) {
      assert.strictEqual(rule.order, places.get(rule.declarations));
    }
  }
});

test("a sheet that comes to a shadow tree's sheet by its import comes before it, on a rule of the host's too", async () => {
  let arrive: (result: ResourceResult) => void = () => {};
  const onResource = (r: ResourceRequest) =>
    r.kind === 'stylesheet'
      ? new Promise<ResourceResult>((resolve) => (arrive = resolve))
      : null;
  const { result, node } = await render(
    '<style>body{margin:0}</style><body>' +
      '<div id="h" class="on"><template shadowrootmode="open">' +
      '<style>@import "late.css"; :host(.on) b { color: #00aa00 }</style>' +
      '<b>in</b></template></div></body>',
    300,
    { onResource },
  );
  const el = view(node);
  await snapshot(result, el);
  const was = cascadeOf(el);
  const inner = shadowRootOf(byId(el, 'h'))!.children.find(
    (n) => (n as Element).name === 'b',
  ) as Element;
  assert.strictEqual(el.computedStyle(inner)?.color, 'rgb(0, 170, 0)');
  arrive({
    kind: 'stylesheet',
    text: 'i { color: #000000 } u { color: #000000 } :host(.on) b { color: #ff0000 }',
  });
  await snapshot(result, el);
  assert.strictEqual(cascadeOf(el)._index, was._index);
  assert.strictEqual(el.computedStyle(inner)?.color, 'rgb(0, 170, 0)');
});

test("what a rule's matcher asks it asks of the cascade in force, once one has taken its indexes over", () => {
  const source = new HtmlSource();
  source.setSource('<p id="p">x</p>', true);
  const p = findById(source.document, 'p') as unknown as Element;
  const css = [
    'p:hover { --a: 1 }',
    'p:active { --b: 1 }',
    'p:focus { --c: 1 }',
    'p:focus-visible { --d: 1 }',
    'p:focus-within { --e: 1 }',
    'p:target { --f: 1 }',
  ];
  const sheet = parseStylesheet(css.join('\n'), 0);
  const look = {
    color: '#000000',
    fontFamily: 'sans-serif',
    fontSize: 16,
    monoFamily: 'monospace',
    linkColor: '#0000ee',
    borderColor: '#808080',
    mutedColor: '#666666',
    background: '#ffffff',
    colorScheme: 'light',
    surface: '#ffffff',
  } as RootLook;
  const candidates = (cascade: Cascade) =>
    (cascade as unknown as { _candidates(el: Element): unknown[] })._candidates(
      p,
    );
  const first = new Cascade([sheet], look, 800, 600, 1);
  // compiled here, over what the first cascade made
  assert.strictEqual(candidates(first).length, 0);
  const second = new Cascade(
    [sheet, parseStylesheet('b { --z: 1 }', css.length)],
    look,
    800,
    600,
    1,
    null,
    null,
    null,
    null,
    null,
    null,
    [],
    first,
  );
  second.setPointer({ hovered: new Set([p]), active: new Set([p]) });
  second.setFocus({ element: p, visible: true, within: new Set([p]) });
  second.setTarget(p);
  assert.strictEqual(candidates(second).length, css.length);
});

test('a rule that asks an ancestor still does in a cascade that took it over', async () => {
  const { result, node } = await render(
    '<style>body{margin:0} .dark .card { color: #00aa00 }</style><body>' +
      '<div class="dark"><p id="a" class="card">a</p></div></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const was = cascadeOf(el);
  putSheet(el, '.other { color: #ff0000 }');
  await snapshot(result, el);
  assert.strictEqual(cascadeOf(el)._index, was._index);
  // styled again, with a `needs` the first cascade worked out
  el.touchDocument();
  await snapshot(result, el);
  assert.strictEqual(el.computedStyle(byId(el, 'a'))?.color, 'rgb(0, 170, 0)');
});

test('the rule of a name a sheet put in first is still found after the one of it that is last', async () => {
  const frames = (ink: string) =>
    `@keyframes k { from { color: ${ink} } to { color: ${ink} } }`;
  const { result, node } = await render(
    '<style>body{margin:0} p { animation: k 1s paused }</style><body><p id="p">p</p>' +
      `<style id="late">${frames('#00aa00')}</style></body>`,
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const was = cascadeOf(el);
  assert.strictEqual(el.computedStyle(byId(el, 'p'))?.color, 'rgb(0, 170, 0)');
  putSheet(el, frames('#ff0000'), byId(el, 'late'));
  await snapshot(result, el);
  assert.strictEqual(cascadeOf(el)._index, was._index);
  assert.strictEqual(el.computedStyle(byId(el, 'p'))?.color, 'rgb(0, 170, 0)');
  el.touchDocument();
  await snapshot(result, el);
  assert.strictEqual(el.computedStyle(byId(el, 'p'))?.color, 'rgb(0, 170, 0)');
});

test('a @keyframes under a media query is read from its sheet by each cascade, and not once more each', async () => {
  const { result, node } = await render(
    '<style>body{margin:0} @media (min-width: 200px) { @keyframes k { to { color: red } } }</style>' +
      '<body><p id="p">p</p></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const was = cascadeOf(el);
  putSheet(el, '.a { color: #000000 }');
  await snapshot(result, el);
  putSheet(el, '.b { color: #000000 }');
  await snapshot(result, el);
  assert.strictEqual(cascadeOf(el)._index, was._index);
  assert.strictEqual(cascadeOf(el)._keyframeMedia.length, 1);
  assert.strictEqual(cascadeOf(el)._mediaOutsideRules.length, 0);
});

test('a sheet taken out leaves the cascade, and one moved into a shadow tree styles that tree', async () => {
  const { result, node } = await render(
    '<style>body{margin:0}</style><body><div id="h"><template shadowrootmode="open">' +
      '<b>in</b></template></div><b id="out">out</b>' +
      '<style id="s">b { color: #00aa00 }</style></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const root = shadowRootOf(byId(el, 'h'))!;
  const inner = root.children.find(
    (n) => (n as Element).name === 'b',
  ) as Element;
  const out = byId(el, 'out');
  assert.strictEqual(el.computedStyle(out)?.color, 'rgb(0, 170, 0)');
  // the sheet that reads the same is the same parse, for another tree
  const style = byId(el, 's');
  removeNode(style);
  appendChild(root as unknown as Element, style);
  el.touchDocument();
  await snapshot(result, el);
  assert.notStrictEqual(el.computedStyle(out)?.color, 'rgb(0, 170, 0)');
  assert.strictEqual(el.computedStyle(inner)?.color, 'rgb(0, 170, 0)');
  // and back: filed under the tree it has left, it would style nothing
  removeNode(style);
  appendChild(elementParentOf(out), style);
  el.touchDocument();
  await snapshot(result, el);
  assert.strictEqual(el.computedStyle(out)?.color, 'rgb(0, 170, 0)');
  assert.notStrictEqual(el.computedStyle(inner)?.color, 'rgb(0, 170, 0)');
  removeNode(style);
  el.touchDocument();
  await snapshot(result, el);
  assert.notStrictEqual(el.computedStyle(out)?.color, 'rgb(0, 170, 0)');
});

test('a cascade that took the one before it over holds all that one made from nothing holds', async () => {
  const { result, node } = await render(
    '<style>body{margin:0}</style><body>' +
      '<x-a id="h" class="on"><template shadowrootmode="open"><style>' +
      ':host::before { content: "x" }\n' +
      ':host(.on) b::before { color: #00aa00 }\n' +
      '</style><b part="q">in</b></template></x-a>' +
      '<div id="host"></div><p id="p">p</p>' +
      '<svg width="10" height="10"><path class="s" d="M0 0h9v9z"/></svg>' +
      '<style id="last">' +
      'p { --x: #00aa00; color: var(--x); margin-top: 1lh; zoom: 1.5;' +
      ' writing-mode: horizontal-tb; scroll-snap-type: y mandatory }\n' +
      '@media (min-width: 1px) { x-a::part(q) { color: #00aa00 } }\n' +
      '.s { fill: #00aa00 }\n.a::highlight(h) { color: #00aa00 }\n' +
      '::view-transition-group(v) { color: #00aa00 }\n' +
      '@keyframes k { to { color: red } }\n' +
      '@position-try --t { top: 0 }' +
      '</style></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const first = cascadeOf(el);
  // a sheet where the rest are not, one after them, and a tree's of its own
  putSheet(
    el,
    '@keyframes k { to { color: blue } } .a { color: #000000 }',
    byId(el, 'last'),
  );
  await snapshot(result, el);
  putSheet(el, '.b::before { color: #000000 }');
  await snapshot(result, el);
  const root = attachShadow(byId(el, 'host'), { mode: 'open' });
  appendChild(
    root as unknown as Element,
    createElement('style', {}, [createText('b { color: #0000ff }')]),
  );
  appendChild(
    root as unknown as Element,
    createElement('b', {}, [createText('b')]),
  );
  el.touchDocument();
  await snapshot(result, el);
  assert.strictEqual(cascadeOf(el)._index, first._index, 'taken over');
  assert.strictEqual(el.computedStyle(byId(el, 'p'))?.color, 'rgb(0, 170, 0)');
  const took = walkOf(cascadeOf(el));
  const chain = el as unknown as { _sheetsRead: unknown };
  chain._sheetsRead = null;
  el.touchDocument();
  await snapshot(result, el);
  assert.notStrictEqual(cascadeOf(el)._index, first._index, 'from nothing');
  assert.deepStrictEqual(took, walkOf(cascadeOf(el)));
});

metric(
  "a rule matched in a <use>'s copy stops at the copy's top in a cascade that took it over",
  async () => {
    // Each copy is a tree of its own, whose top has nothing above it and
    // nothing beside it, whichever it is of the sprite's elements: a rule
    // that finds one wrong draws it red.
    const { result, node } = await render(
      '<style>body{margin:0}svg{display:block;float:left}' +
        '.above{fill:#00aa00}.sprite .above{fill:#ff0000}' +
        '.beside{fill:#00aa00}.before + .beside{fill:#ff0000}' +
        '.only{fill:#ff0000}.only:last-child{fill:#00aa00}</style><body>' +
        '<svg class="sprite" width="0" height="0"><g>' +
        '<rect class="before" width="12" height="12"/>' +
        '<rect id="u" class="above" width="12" height="12"/>' +
        '<rect class="before" width="12" height="12"/>' +
        '<rect id="v" class="beside" width="12" height="12"/>' +
        '<rect id="w" class="only" width="12" height="12"/>' +
        '<rect class="before" width="12" height="12"/>' +
        '</g></svg>' +
        '<svg width="12" height="12"><use href="#u"/></svg>' +
        '<svg width="12" height="12"><use href="#v"/></svg>' +
        '<svg width="12" height="12"><use href="#w"/></svg></body>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const drawn = async (message: string, beside = '#00aa00') => {
      await expectPixel(result.ctx, 6, 6, '#00aa00', { message });
      await expectPixel(result.ctx, 18, 6, beside, { message });
      await expectPixel(result.ctx, 30, 6, '#00aa00', { message });
    };
    await drawn('the cascade that compiled them');
    const was = cascadeOf(el);
    // and rules compiled since: one that finds nothing above a copy, and
    // one that holds of what is in it
    putSheet(
      el,
      '.sprite .only { fill: #ff0000 } .beside.beside { fill: #0000aa }',
    );
    await snapshot(result, el);
    assert.strictEqual(cascadeOf(el)._index, was._index);
    el.touchDocument();
    await snapshot(result, el);
    await drawn('the one that took it over', '#0000aa');
  },
);

test('a cascade that takes over indexes takes over what read their rules, however many sheets went before', async () => {
  const { result, node } = await render(
    '<style>body{margin:0} .m:hover .i { color: #00aa00 }</style><body><div class="m"><p class="i" id="i">i</p></div></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const was = cascadeOf(el);
  for (let i = 0; i < 40; i += 1) was._noted.add({});
  putSheet(el, '.other { color: #ff0000 }');
  await snapshot(result, el);
  assert.strictEqual(cascadeOf(el)._index, was._index);
  assert.strictEqual(cascadeOf(el)._changeRules, was._changeRules);
});

test('a change whose seeds are most of the document builds all of it, at once', async () => {
  const { result, node } = await render(
    '<style>body{margin:0}</style><body><div id="a"><p>1</p><p>2</p></div><div id="b">x</div></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const internals = el as unknown as Record<string, unknown>;
  const found = internals._subtreeRoots as (...a: unknown[]) => unknown;
  let asked = 0;
  internals._subtreeRoots = function (this: unknown, ...a: unknown[]) {
    asked += 1;
    return found.apply(this, a);
  };
  const body = el.document.children.find(
    (n) => (n as Element).name === 'body',
  ) as Element;
  const every = elementsIn(body);
  (
    el as unknown as {
      _invalidate(
        stale: number,
        restyle: Set<Element>,
        follow: boolean,
        seeds: Set<Element>,
      ): void;
    }
  )._invalidate(2, new Set(every), true, new Set(every));
  await snapshot(result, el);
  assert.strictEqual(asked, 0, 'the roots of nearly all of it were looked for');
  // and a seed or two are built apart
  const b = byId(el, 'b');
  (
    el as unknown as {
      _invalidate(
        stale: number,
        restyle: Set<Element>,
        follow: boolean,
        seeds: Set<Element>,
      ): void;
    }
  )._invalidate(2, new Set([b]), true, new Set([b]));
  await snapshot(result, el);
  assert.strictEqual(asked, 1);
});

test('a sheet put in with what comes at the end of the body builds the end of the body', async () => {
  const { result, node } = await render(
    '<!doctype html><html><head><style>body{margin:0}</style></head>' +
      '<body><div id="before">before</div><div id="last">last</div></body></html>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const body = byId(el, 'last').parent as Element;
  const head = el.document.children
    .flatMap((n) => (n as Element).children ?? [])
    .find((n) => (n as Element).name === 'head') as Element;
  const sheet = createElement('style', {}, [
    createText('.new { color: #ff0000 }'),
  ]);
  appendChild(head, sheet);
  const added = createElement('div', { class: 'new' }, [createText('new')]);
  appendChild(body, added);
  const box = () =>
    (el as unknown as { _firstBoxesOf(t: unknown): Map<Element, unknown> })
      ._firstBoxesOf(treeOf(el))
      .get(byId(el, 'before'));
  const far = box();
  el.touchDocument([
    { type: 'childList', target: head, addedNodes: [sheet], removedNodes: [] },
    {
      type: 'childList',
      target: body,
      addedNodes: [added],
      removedNodes: [],
      nextSibling: null,
      previousSibling: byId(el, 'last'),
    },
  ]);
  await snapshot(result, el);
  assert.ok(box() === far, 'what was before it was built');
  assert.equal(el.computedStyle(added)?.color, 'rgb(255, 0, 0)');
});

test('a change inside a shadow tree builds its host, where it built the whole document', async () => {
  const { result, node } = await render(
    '<style>body{margin:0} .far{height:20px}</style>' +
      '<body><div class="far" id="before">before</div>' +
      '<div id="h"><template shadowrootmode="open"><div><p id="p">in</p></div></template></div></body>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const root = shadowRootOf(byId(el, 'h'))!;
  const inner = (root.children[0] as Element).children[0] as Element;
  const boxes = () =>
    (el as unknown as { _firstBoxesOf(t: unknown): Map<Element, unknown> })
      ._firstBoxesOf(treeOf(el))
      .get(byId(el, 'before'));
  const far = boxes();
  const added = createElement('b', {}, [createText('new')]);
  appendChild(inner.parent as Element, added);
  el.touchDocument([
    {
      type: 'childList',
      target: inner.parent as Element,
      addedNodes: [added],
      removedNodes: [],
    },
  ]);
  await snapshot(result, el);
  assert.ok(boxes() === far, 'what is around the host was built');
  assert.ok(el.computedStyle(added));
  assert.equal(drawnText(el).replace(/\s+/g, ''), 'beforeinnew');
});

test('a rule across a shadow tree’s edge reaches what is below its host across the edge, and nothing makes it a refresh of everything', async () => {
  const { result, node } = await render(
    '<div class="a" id="h"><template shadowrootmode="open">' +
      '<style>:host(.on) p { color: #ff0000 }</style><p>p</p></template></div>' +
      '<p id="other">o</p>',
    300,
  );
  const el = view(node);
  await snapshot(result, el);
  const host = byId(el, 'h');
  const inner = shadowRootOf(host)!.children.find(
    (n) => (n as Element).name === 'p',
  ) as Element;
  const change = setClass(host, 'a on');
  const scope = (
    el as unknown as {
      _changeScope(c: HtmlChange[]): { own: Set<Element> } | null;
    }
  )._changeScope([change]);
  assert.ok(scope, 'the change was a refresh of everything');
  assert.ok(scope.own.has(inner), 'the tree’s paragraph is not restyled');
  assert.ok(!scope.own.has(byId(el, 'other')), 'the whole page is restyled');
  el.touchDocument([change]);
  await snapshot(result, el);
  assert.equal(el.computedStyle(inner)?.color, 'rgb(255, 0, 0)');
});

test('in a document with rules across shadow trees’ edges — :host, :host-context, ::slotted, ::part — a refresh told what changed comes to the same styles', async () => {
  const ways = await refreshesAgree(60, true, true);
  const scoped = ways.inPlace + ways.frame + ways.build;
  assert.ok(scoped > ways.whole, `${JSON.stringify(ways)}`);
});

/** Random documents, each changed a step at a time, its styles after a
 *  refresh told what changed held to those after a refresh of everything;
 *  which way each scoped refresh went, so the comparison is known to be of
 *  the scoped ways and not only of the refresh of everything they fall
 *  back to. */
async function refreshesAgree(
  seeds: number,
  shadows: boolean,
  edges = false,
  anchoredShare?: number,
  firstSeed = 1,
  /** The document's rules, where not `rulesFor`'s. */
  sheet?: (next: () => number) => string,
  /** Whether it holds drawings, whose shapes are held to it as well. */
  drawings = false,
): Promise<{
  whole: number;
  inPlace: number;
  frame: number;
  build: number;
  shapes: number;
}> {
  const ways = { whole: 0, inPlace: 0, frame: 0, build: 0, shapes: 0 };
  for (let seed = firstSeed; seed < firstSeed + seeds; seed += 1) {
    const next = mulberry32(seed);
    // a sheet of anchored shapes has none of those that reach everything,
    // which would make it a refresh of everything and test none of them,
    // and every other one nothing outside a `:has()` that reaches all of
    // a holder's children (`HOLDER_WIDE`)
    let css = sheet
      ? sheet(next)
      : rulesFor(
          next,
          anchoredShare === undefined,
          anchoredShare,
          anchoredShare === undefined || seed % 3 === 0,
        );
    if (edges) css += `\n${edgeRulesFor(next, true)}`;
    const source = `<style>body{margin:0}\n${css}</style><body>${markupFor(next, shadows, edges, drawings)}</body>`;
    // real fonts where the machine has them: the mock backend lays out no
    // text, and a restyle in place remakes the text it inks
    const { result, node } = await render(source, 320);
    const el = view(node);
    await act();
    const bodyEl = el.document.children.find(
      (n) => (n as Element).name === 'body',
    ) as Element;
    if (drawings) shapesOf(el, bodyEl);
    for (let step = 0; step < 8; step += 1) {
      const changes: HtmlChange[] = [];
      const batch = 1 + Math.floor(next() * 3);
      for (let i = 0; i < batch; i += 1) {
        changes.push(
          ...(anchoredShare === undefined && next() < 0.05
            ? attachOne(next, bodyEl)
            : changeOne(next, bodyEl, next() < 0.25, edges)),
        );
      }
      const node = el as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      const scope = node._changeScope.call(el, changes) as {
        boxes: boolean;
        shapes?: Set<Element>;
      } | null;
      if (!scope) ways.whole += 1;
      if (scope?.shapes?.size) ways.shapes += 1;
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
      const shapes = drawings ? shapesOf(el, bodyEl) : [];
      el.touchDocument();
      const whole = stylesOf(el, bodyEl);
      const told = (): string =>
        changes
          .map((c) =>
            c.type === 'attributes'
              ? `${c.attributeName} of <${c.target.name} ${JSON.stringify(c.target.attribs)}> was ${JSON.stringify(c.oldValue)}`
              : c.type,
          )
          .join(', ') + ` (${way})`;
      if (drawings) {
        assert.deepStrictEqual(
          shapes,
          shapesOf(el, bodyEl),
          `seed ${seed}, step ${step}: what a shape is given\nrules\n${css}\n` +
            `changes ${told()}\nin ${source}`,
        );
      }
      const at = firstApart(scoped, whole);
      // the fields two lines of `stylesOf` differ in, which a style's
      // hundred fields hide
      const apart = (a = '', b = ''): string => {
        const bs = new Set(b.split(/,(?=")/));
        return a
          .split(/,(?=")/)
          .filter((f) => !bs.has(f))
          .join(', ');
      };
      assert.ok(
        at < 0 && scoped.length === whole.length,
        `seed ${seed}, step ${step}: told what changed\n` +
          `${apart(scoped[at], whole[at]).slice(0, 600)}\n` +
          `styled whole\n${apart(whole[at], scoped[at]).slice(0, 600)}\n` +
          `${(scoped[at] ?? '').slice(0, 80)}\nrules\n${css}\nchanges ${told()}`,
      );
    }
    result.unmount();
  }
  return ways;
}
