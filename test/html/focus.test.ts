// <Html> — the keyboard's way through a document: Tab over its links,
// buttons, summaries and controls, the ring round what has the focus, and
// what Enter does there.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import { Button } from 'react-x11';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';
import { XK_RETURN, XK_SPACE } from 'react-x11/keysyms';
import { Html } from '../../src/index.js';
import type { HtmlViewNode } from '../../src/html/index.js';
import { elementsIn, parseFragment } from '../../src/html/dom.js';
import type { Element as DocElement } from '../../src/html/dom.js';
import {
  focusableElement,
  isTabbable,
  stepFrom,
} from '../../src/html/focus.js';
import type { FocusStop } from '../../src/html/focus.js';
import { FONTS, boxOf, h, metric, view } from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

/** A document's elements by id, and its focusable ones as stops, in the
 *  order the markup has them — what the box tree collects, less the
 *  question of which are rendered. */
function stopsIn(html: string) {
  const [root] = parseFragment(`<div>${html}</div>`) as DocElement[];
  const byId = new Map<string, DocElement>();
  const stops: FocusStop[] = [];
  for (const el of elementsIn(root)) {
    if (el.attribs.id) byId.set(el.attribs.id, el);
    if (focusableElement(el)) {
      stops.push({ element: el, tabbable: isTabbable(el), widget: false });
    }
  }
  const id = (stop: FocusStop | null) => stop?.element.attribs.id ?? null;
  return { byId, stops, id };
}

test('what markup makes focusable, and what Tab reaches', () => {
  const { stops, id } = stopsIn(
    '<a id="a" href="#">a</a><a id="no-href">b</a>' +
      '<button id="b">b</button><button id="off" disabled>x</button>' +
      '<fieldset disabled><input id="in-off"><legend><input id="legend">' +
      '</legend></fieldset>' +
      '<input id="hidden" type="hidden"><input id="text">' +
      '<details><summary id="s">s</summary><summary id="s2">s2</summary>' +
      '</details><summary id="loose">x</summary>' +
      '<span id="t0" tabindex="0">x</span><span id="t-1" tabindex="-1">x' +
      '</span><span id="t-junk" tabindex="x">x</span>' +
      '<span id="t5" tabindex=" 5px">x</span>',
  );
  assert.deepStrictEqual(
    stops.map((s) => [id(s), s.tabbable]),
    [
      ['a', true],
      ['b', true],
      // a disabled fieldset's first legend is not disabled with it
      ['legend', true],
      ['text', true],
      ['s', true],
      ['t0', true],
      // focusable, and kept to a press
      ['t-1', false],
      // a positive one where it is, as a control's
      ['t5', true],
    ],
  );
});

test('Tab goes on from a stop, from no stop, and from a place in the document', () => {
  const { byId, stops, id } = stopsIn(
    '<p id="p1">x <a id="a" href="#">a <em id="in-a">b</em></a></p>' +
      '<p id="p2"><span id="skip" tabindex="-1">no</span> text</p>' +
      '<a id="b" href="#">b <span id="c" tabindex="0">c <i id="in-c">' +
      'd</i></span> <em id="after-c">e</em></a>' +
      '<p id="p3">end</p>',
  );
  const from = (el: string | null, back = false) =>
    id(stepFrom(stops, el === null ? null : byId.get(el)!, back));
  // from the document's edges
  assert.strictEqual(from(null), 'a');
  assert.strictEqual(from(null, true), 'c');
  // from a stop, and off either end
  assert.strictEqual(from('a'), 'b');
  assert.strictEqual(from('c'), null);
  assert.strictEqual(from('a', true), null);
  // from one Tab passes, focused some other way
  assert.strictEqual(from('skip'), 'b');
  assert.strictEqual(from('skip', true), 'a');
  // from a place: before the first, between, after the last
  assert.strictEqual(from('p1'), 'a');
  assert.strictEqual(from('p2'), 'b');
  assert.strictEqual(from('p2', true), 'a');
  assert.strictEqual(from('p3'), null);
  assert.strictEqual(from('p3', true), 'c');
  // from inside a stop, as from the stop: the text of a link, and of a
  // stop in a stop, the nearest
  assert.strictEqual(from('in-a'), 'b');
  assert.strictEqual(from('in-a', true), null);
  assert.strictEqual(from('in-c', true), 'b');
  assert.strictEqual(from('after-c'), 'c');
  assert.strictEqual(from('after-c', true), 'a');
});

/** A node with the props it was mounted with, which core's type leaves to
 *  the element. */
type Mounted = DrawnNode & {
  props: Record<string, unknown>;
  focused: boolean;
};

/** Every node under `node`, depth first. */
function nodesUnder(node: Mounted): Mounted[] {
  const out: Mounted[] = [node];
  for (const child of node.children as Mounted[])
    out.push(...nodesUnder(child));
  return out;
}

/** Renders a document between two of the window's own buttons, with Tab
 *  — a key press — going through the in-process server. */
async function renderBetween(
  source: string,
  props: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
) {
  const result = await renderX11(
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Button, { label: 'before' }),
      h(Html, { source, partial: false, 'data-testname': 'doc', ...props }),
      h(Button, { label: 'after' }),
    ),
    { width: 440, height: 600, fonts: FONTS!, ...options },
  );
  await act();
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const windowNode = result.windowNode as unknown as Mounted;
  /** What holds the focus: the document's element by its id, or a
   *  widget by its placeholder or label, or one of the window's buttons. */
  const focused = (): string | undefined => {
    const node = nodesUnder(windowNode).find((n) => n.focused);
    if (!node) return undefined;
    const element = el.focusedElement;
    if (element) {
      return element.attribs.id ?? element.attribs.placeholder ?? element.name;
    }
    // a widget, or one of the window's buttons, by the text in it
    const text = nodesUnder(node)
      .map((n) => n.props.children)
      .filter((c) => typeof c === 'string')
      .join('');
    return String(node.props.placeholder ?? (text || node.props.role));
  };
  /** The stops mounted: the boxes that take the focus for what the
   *  document draws. */
  const stops = () =>
    nodesUnder(windowNode).filter(
      (n) =>
        n.props.tabIndex !== undefined &&
        (n.props.style as { pointerEvents?: string } | undefined)
          ?.pointerEvents === 'none',
    );
  /** One of the window's two buttons. */
  const button = (label: string) =>
    nodesUnder(windowNode).find(
      (n) =>
        n.props.role === 'button' &&
        nodesUnder(n).some((c) => c.props.children === label),
    )!;
  return { result, el, focused, stops, button, windowNode };
}

async function tabs(
  n: number,
  focused: () => string | undefined,
  shift = false,
) {
  const out: (string | undefined)[] = [];
  for (let i = 0; i < n; i += 1) {
    await userEvent.tab({ shift });
    out.push(focused());
  }
  return out;
}

metric(
  'Tab goes through the links, buttons and controls in the order the markup has them, and on out of the document',
  async () => {
    // The Zen Garden's list of designs: a preview that is a link round a
    // picture, a link in the credits under it, and the pages after. Tab
    // stopped on the document as one stop, and then left it.
    const { focused } = await renderBetween(
      '<p><a id="a" href="/221/">Mid Century Modern</a> by ' +
        '<a id="b" href="http://andrewlohman.com/">Andrew Lohman</a></p>' +
        '<input placeholder="field">' +
        '<p><button id="c">Press</button> <span id="x" tabindex="-1">no</span>' +
        ' <span id="d" tabindex="0">yes</span></p>' +
        '<details><summary id="e">More</summary><a id="hidden" href="#">' +
        'inside</a></details>' +
        '<a id="none" href="#" style="display:none">gone</a>' +
        '<a id="invisible" href="#" style="visibility:hidden">unseen</a>' +
        '<button id="off" disabled>Off</button>' +
        '<div inert><a id="inert" href="#">inert</a></div>' +
        '<a name="anchor">no href</a>' +
        '<p><a id="f" href="?pg=2">2</a></p>',
    );
    assert.deepStrictEqual(await tabs(10, focused), [
      'before',
      'a',
      'b',
      'field',
      'c',
      'd',
      'e',
      'f',
      'after',
      'before',
    ]);
    assert.deepStrictEqual(
      await tabs(9, focused, true),
      ['after', 'f', 'e', 'd', 'c', 'field', 'b', 'a', 'before'],
      'and Shift+Tab back the other way',
    );
  },
);

/** A laid-out box's outline, as the cascade left it. */
type Outlined = LaidBox & {
  style: {
    outlineStyle: string;
    outlineWidth: number;
    outlineColor: string;
    color: string;
  };
};

const outlineOf = (el: HtmlViewNode, id: string) => {
  const { style } = boxOf(el, id) as Outlined;
  return [style.outlineStyle, style.outlineWidth, style.outlineColor];
};

metric(
  'the link Tab reaches is the document’s :focus, ringed as the page says',
  async () => {
    // Chrome's `:focus-visible { outline: auto 1px -webkit-focus-ring-color
    // }`, the palette's ring here; and the Zen Garden's own `a:focus`,
    // which a page that styles its focus gets instead.
    const { el, focused } = await renderBetween(
      '<style>a.own:focus{outline:5px solid #ff0000;color:#00ff00}</style>' +
        '<p><a id="a" href="#a">plain</a> <a id="b" class="own" href="#b">' +
        'own</a> <button id="c">button</button></p>',
    );
    assert.strictEqual(outlineOf(el, 'a')[0], 'none');
    await tabs(2, focused);
    assert.strictEqual(focused(), 'a');
    assert.deepStrictEqual(
      outlineOf(el, 'a'),
      ['auto', 2, '#2980b9'],
      "the palette's ring",
    );
    await userEvent.tab();
    assert.strictEqual(focused(), 'b');
    assert.strictEqual(outlineOf(el, 'a')[0], 'none');
    assert.deepStrictEqual(outlineOf(el, 'b'), ['solid', 5, '#ff0000']);
    assert.strictEqual((boxOf(el, 'b') as Outlined).style.color, '#00ff00');
    await userEvent.tab();
    assert.deepStrictEqual(outlineOf(el, 'c'), ['auto', 2, '#2980b9']);
    // and the focus leaving the document takes the ring with it
    await userEvent.tab();
    assert.strictEqual(focused(), 'after');
    assert.strictEqual(outlineOf(el, 'c')[0], 'none');
    assert.strictEqual(el.focusedElement, null);
  },
);

metric(
  'Enter follows the link that has the focus, with a click on it',
  async () => {
    // A browser activates a link from the keyboard with a click (HTML
    // 6.5.6): `detail` 0, the key's modifiers, and here a point on the
    // link, which the example browser asks for its `target`.
    const followed: { href: string; ev: X11MouseEvent<DrawnNode> }[] = [];
    const { el, focused } = await renderBetween(
      '<p>Read <a id="a" href="/221/" target="_blank">the long name of a ' +
        'design that wraps onto a second line of the paragraph</a>.</p>',
      {
        baseUrl: 'https://www.csszengarden.com/pages/alldesigns/',
        onLink: (href: string, ev: X11MouseEvent<DrawnNode>) =>
          followed.push({ href, ev }),
      },
    );
    await tabs(2, focused);
    assert.strictEqual(focused(), 'a');
    await userEvent.key(XK_SPACE);
    assert.strictEqual(followed.length, 0, 'Space is the page’s');
    await userEvent.key(XK_RETURN);
    assert.strictEqual(followed.length, 1);
    const [{ href, ev }] = followed;
    assert.strictEqual(href, 'https://www.csszengarden.com/221/');
    assert.strictEqual(ev.detail, 0);
    assert.strictEqual(ev.ctrlKey, false);
    const at = el.elementAtPoint(ev.x, ev.y);
    assert.ok(
      at && (at.attribs.id === 'a' || at.parent === boxOf(el, 'a').el),
      'the click is on the link',
    );
    await act(() => fireEvent.key(XK_RETURN, { modifiers: ['Control'] }));
    assert.strictEqual(followed.length, 2);
    assert.strictEqual(followed[1].ev.ctrlKey, true, 'Ctrl+Enter, Ctrl+click');
  },
);

metric(
  'Enter and Space press a button the document draws, and open a summary',
  async () => {
    const changes: string[] = [];
    const { el, focused } = await renderBetween(
      '<button id="c" value="go">Go</button>' +
        '<details><summary id="s">More</summary>' +
        '<a id="in" href="#">inside</a></details>',
      {
        onControlChange: (element: { attribs: Record<string, string> }) =>
          changes.push(element.attribs.id),
      },
    );
    await tabs(2, focused);
    assert.strictEqual(focused(), 'c');
    await userEvent.key(XK_RETURN);
    await userEvent.key(XK_SPACE);
    assert.deepStrictEqual(changes, ['c', 'c']);
    await userEvent.tab();
    assert.strictEqual(focused(), 's');
    // closed, the link in the details has no box, and is no stop
    await userEvent.tab();
    assert.strictEqual(focused(), 'after');
    await userEvent.tab({ shift: true });
    assert.strictEqual(focused(), 's');
    await userEvent.key(XK_RETURN);
    const details = boxOf(el, 's').el as unknown as {
      parent: { attribs: Record<string, string> };
    };
    assert.strictEqual(details.parent.attribs.open, '', 'opened');
    await userEvent.tab();
    assert.strictEqual(focused(), 'in', 'and what it shows is reached');
  },
);

metric(
  'a page of links mounts a stop for a few of them, and Tab still walks them all',
  async () => {
    // a box each would be a node core walks for every hit test and every
    // paint, on a page of thousands of links
    const links = Array.from(
      { length: 300 },
      (_, i) => `<li><a id="l${i}" href="#${i}">design ${i}</a></li>`,
    ).join('');
    const { focused, stops, button } = await renderBetween(`<ul>${links}</ul>`);
    assert.ok(stops().length <= 2, `${stops().length} mounted before Tab`);
    const walked = await tabs(40, focused);
    assert.deepStrictEqual(walked, [
      'before',
      ...Array.from({ length: 39 }, (_, i) => `l${i}`),
    ]);
    assert.ok(stops().length <= 5, `${stops().length} mounted while in it`);
    // in from the far side, at the last
    await userEvent.tab({ shift: true });
    assert.strictEqual(focused(), 'l37');
    await act(() => {
      button('after').focus();
    });
    assert.deepStrictEqual(await tabs(2, focused, true), ['l299', 'l298']);
  },
);

metric('the link Tab reaches is scrolled into view', async () => {
  const links = Array.from(
    { length: 60 },
    (_, i) =>
      `<p style="margin:0;height:30px"><a id="l${i}" href="#">${i}</a></p>`,
  ).join('');
  const result = await renderX11(
    h(
      'box',
      {
        'data-testname': 'pane',
        style: { width: 400, height: 200, overflow: 'scroll' },
      },
      h(Html, { source: links, partial: false, 'data-testname': 'doc' }),
    ),
    { width: 440, height: 300, fonts: FONTS! },
  );
  void result;
  await act();
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const pane = screen.getByTestName('pane') as DrawnNode & {
    scrollY: number;
  };
  // the pane first, which core makes a stop for having something to
  // scroll, and then the links in it
  await userEvent.tab();
  assert.ok((pane as unknown as Mounted).focused);
  for (let i = 0; i < 30; i += 1) await userEvent.tab();
  assert.strictEqual(el.focusedElement?.attribs.id, 'l29');
  await act();
  const box = el.elementRect(el.focusedElement!)!;
  assert.ok(
    box.y >= pane.scrollY && box.y + box.height <= pane.scrollY + 200,
    `l29 at ${box.y}..${box.y + box.height} in ${pane.scrollY}..${pane.scrollY + 200}`,
  );
});

metric(
  'Tab after a press in the document goes on from where it landed',
  async () => {
    // HTML's sequential focus navigation starting point (6.6.4)
    const { el, focused } = await renderBetween(
      '<p><a id="a" href="#">a</a></p><p id="mid">some text to press on</p>' +
        '<p><a id="b" href="#">b</a> <a id="c" href="#">c</a></p>',
    );
    const mid = boxOf(el, 'mid');
    const at = (el as unknown as { abs: { x: number; y: number } }).abs;
    await userEvent.click(
      el as unknown as DrawnNode,
      {
        x: at.x + mid.x + 20,
        y: at.y + mid.y + mid.height / 2,
      } as never,
    );
    await userEvent.tab();
    assert.strictEqual(focused(), 'b');
    await userEvent.click(
      el as unknown as DrawnNode,
      {
        x: at.x + mid.x + 20,
        y: at.y + mid.y + mid.height / 2,
      } as never,
    );
    await userEvent.tab({ shift: true });
    assert.strictEqual(focused(), 'a');
  },
);

metric(
  'a stop is where its element is, in logical pixels, at scale 2',
  async () => {
    const { el, focused, stops } = await renderBetween(
      '<p style="margin:40px 0 0 30px"><a id="a" href="#">a link</a></p>',
      {},
      { scale: 2 },
    );
    await tabs(2, focused);
    assert.strictEqual(focused(), 'a');
    const stop = stops().find((n) => n.focused)!;
    const doc = el as unknown as { abs: { x: number; y: number } };
    const rect = el.elementRect(boxOf(el, 'a').el as never)!;
    const abs = (
      stop as unknown as {
        abs: { x: number; y: number; width: number; height: number };
      }
    ).abs;
    // the stop's box is device pixels, as every node's is, and the rect
    // the document measures logical ones
    assert.ok(Math.abs(abs.x - (doc.abs.x + rect.x * 2)) <= 1, `${abs.x}`);
    assert.ok(Math.abs(abs.y - (doc.abs.y + rect.y * 2)) <= 1, `${abs.y}`);
    assert.ok(Math.abs(abs.width - rect.width * 2) <= 1, `${abs.width}`);
    assert.ok(rect.y >= 40 && rect.x >= 30, `${rect.x},${rect.y}`);
  },
);

metric(
  'the selection’s keys still reach the document while a link has the focus',
  async () => {
    // core runs Ctrl+A on the surface that is focused, and a stop inside
    // it is focused instead
    const { focused } = await renderBetween(
      '<p>Some text and <a id="a" href="#">a link</a>.</p>',
    );
    await tabs(2, focused);
    assert.strictEqual(focused(), 'a');
    await act(() => fireEvent.key(0x61, { modifiers: ['Control'] }));
    const root = screen.getByTestName('doc') as DrawnNode & {
      textSelection: { isCollapsed: boolean; text: string } | null;
    };
    assert.ok(root.textSelection && !root.textSelection.isCollapsed);
    assert.match(root.textSelection.text, /Some text and a link/);
  },
);

metric(
  'a skip link hidden until it has the focus shows when Tab reaches it',
  async () => {
    // Wikipedia's "Jump to content": a pixel square, clipped and out of
    // the flow, while it is `:not(:focus)`. Its stop is where it moves to.
    const { el, focused, stops } = await renderBetween(
      '<style>body{margin:0} .skip:not(:focus){position:absolute;' +
        'width:1px;height:1px;overflow:hidden;clip:rect(1px,1px,1px,1px)}' +
        ' .skip{display:block} .skip:focus{padding:10px}</style>' +
        '<a id="skip" class="skip" href="#content">Jump to content</a>' +
        '<p id="content">The article.</p>',
    );
    const before = el.elementRect(boxOf(el, 'skip').el as never)!;
    assert.ok(before.width <= 1, `hidden: ${before.width}`);
    await tabs(2, focused);
    assert.strictEqual(focused(), 'skip');
    await act();
    const after = el.elementRect(boxOf(el, 'skip').el as never)!;
    assert.ok(after.width > 100, `shown: ${after.width}`);
    const stop = stops().find((n) => n.focused)!;
    const style = stop.props.style as { width: number; top: number };
    assert.strictEqual(style.width, after.width, 'the stop went with it');
    assert.strictEqual(style.top, after.y);
  },
);
