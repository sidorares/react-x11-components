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
  shadowRootOf,
} from '../../src/html/index.js';
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
import { Html } from '../../src/index.js';
import {
  FONTS,
  bytesApart,
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
  assert.strictEqual(scopeOf(el, [treeSheet]), null, 'a tree’s sheet');
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
    () => `[data-x] .${c()}`,
    () => `[data-x=y]`,
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

function markupFor(next: () => number, shadows = false, edges = false): string {
  let id = 0;
  const element = (depth: number): string => {
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

/** A change a script might make, done, and its records. */
function changeOne(
  next: () => number,
  body: Element,
  forgetOld: boolean,
  parts = false,
): HtmlChange[] {
  const all = elementsIn(body);
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
 * A sheet change a CSS-in-JS library, a lazy chunk or a late `<link>` makes,
 * done, and its records: a `<style>` put in, rules written into one, its
 * text extended or replaced, one taken out, and one bringing a `@keyframes`
 * — the last three of which make every element styled again
 * (`addedRules`).
 */
function sheetChange(
  next: () => number,
  body: Element,
  sheets: Element[],
): HtmlChange[] {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const rules = () => rulesFor(next, true).split('\n').slice(0, 4).join('\n');
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
    const kids = body.children.filter((n) => (n as Element).attribs);
    if (kids.length && next() < 0.4) DomUtils.prepend(pick(kids), layered);
    else appendChild(body, layered);
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
    const kids = body.children.filter((n) => (n as Element).attribs);
    if (kids.length && next() < 0.4) DomUtils.prepend(pick(kids), style);
    else appendChild(body, style);
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
  for (let seed = 1; seed <= 32; seed += 1) {
    const next = random(seed * 7919);
    const css = rulesFor(next, true);
    // a document whose markup writes its `<html>`, and one the cascade
    // supplies one for, which a rule for the root reaches otherwise
    const markup = markupFor(next, false, false);
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
      el.touchDocument(changes);
      await act();
      delete internals._sheetsAdded;
      if (answer instanceof Set) added += 1;
      else if (answer === null) whole += 1;
      const scoped = stylesOf(el, bodyEl);
      el.touchDocument();
      await act();
      const styled = stylesOf(el, bodyEl);
      const at = scoped.findIndex((s, i) => s !== styled[i]);
      assert.ok(
        at < 0 && scoped.length === styled.length,
        `seed ${seed}, step ${step}: ${String(scoped[at]).slice(0, 300)}\n` +
          `styled whole: ${String(styled[at]).slice(0, 300)}\n` +
          `sheets\n${sheets.map((st) => DomUtils.textContent(st)).join('\n---\n')}`,
      );
    }
    result.unmount();
  }
  // the added rules restyled what they could style often enough to say so,
  // and the changes they could not vouch for styled everything again
  assert.ok(added > 20, `${added} sheet changes restyled what they reach`);
  assert.ok(whole > 5, `${whole} sheet changes restyled everything`);
});

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

test('in a document with shadow trees whose rules stay inside them, a refresh told what changed comes to the same styles', async () => {
  const ways = await refreshesAgree(30, true);
  const scoped = ways.inPlace + ways.frame + ways.build;
  assert.ok(scoped > ways.whole, `${JSON.stringify(ways)}`);
  for (const way of ['inPlace', 'build'] as const) {
    if (way === 'inPlace' && !FONTS) continue;
    assert.ok(ways[way] > 0, `no refresh went ${way}: ${JSON.stringify(ways)}`);
  }
});

test('in a document of :has() and attribute selectors, a refresh told what changed comes to the same styles, and finds the elements whose answer changed', async () => {
  // how many elements a set of anchors found to be one's
  const at = ChangeAnchors.prototype.at;
  let found = 0;
  ChangeAnchors.prototype.at = function (this: ChangeAnchors, el: Element) {
    const bits = at.call(this, el);
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
): Promise<{ whole: number; inPlace: number; frame: number; build: number }> {
  const ways = { whole: 0, inPlace: 0, frame: 0, build: 0 };
  for (let seed = firstSeed; seed < firstSeed + seeds; seed += 1) {
    const next = random(seed);
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
    const source = `<style>body{margin:0}\n${css}</style><body>${markupFor(next, shadows, edges)}</body>`;
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
        changes.push(...changeOne(next, bodyEl, next() < 0.25, edges));
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
          `${(scoped[at] ?? '').slice(0, 80)}\nrules\n${css}\nchanges ` +
          changes
            .map((c) =>
              c.type === 'attributes'
                ? `${c.attributeName} of <${c.target.name} ${JSON.stringify(c.target.attribs)}> was ${JSON.stringify(c.oldValue)}`
                : c.type,
            )
            .join(', ') +
          ` (${way})`,
      );
    }
    result.unmount();
  }
  return ways;
}
