// <Html> — a build of only the subtrees a change reached: the tree it makes,
// the boxes it keeps and the ones it builds, is the tree a build of the
// whole document makes, box for box, list for list, line for line after
// layout — and the layout after it, which keeps the blocks an earlier one
// laid out where nothing they were laid out from changed (`reuseLaid`),
// places them as a layout of all new boxes does (`buildSubtrees`,
// docs/prd-subtree-build.md).
import { afterEach } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import * as DomUtils from 'domutils';
import {
  appendChild,
  createHtmlElement as createElement,
  createText,
  removeNode,
} from '../../src/html/index.js';
import type { ChildNode, Element, HtmlChange } from '../../src/html/index.js';
import type { Box, BoxTree } from '../../src/html/layout/boxes.js';
import { buildsAtEnd, GENERATED_FROM } from '../../src/html/layout/boxes.js';
import { blocksKept, standsMade } from '../../src/html/layout/block.js';
import { inkKept } from '../../src/html/paint.js';
import { shadowRootOf } from '../../src/html/dom.js';
import { FONTS, h, metric, render, renderScrolled, view } from './harness.js';
import { Html } from '../../src/index.js';

afterEach(cleanup);

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

const CLASSES = 'abcdefghijklmnopq'.split('');
const SHEET = `body { margin: 0; font-size: 14px }
.a { display: flex; gap: 4px }
.b { color: #aa0000 }
.c { display: inline-block; width: 40px }
.d { float: left; width: 30px; height: 12px }
.e { position: absolute; top: 4px; left: 4px; width: 20px }
.f::before { content: "* " }
.g { display: none }
.h { padding: 4px; border: 1px solid #000 }
.h::first-letter { font-size: 20px; color: #00aa00 }
.i { white-space: pre }
.j { text-transform: uppercase }
.k { user-select: none }
.l { margin: 10px 0 }
.m { display: grid; grid-template-columns: 1fr 1fr }
.n::after { content: " +"; color: #0000aa }
.o { position: relative; top: 3px; left: 2px }
.p { transform: translate(5px, 2px) }
.q { overflow: hidden; height: 20px }`;

const BLOCKS = ['div', 'p', 'section', 'h2'];
const INLINES = ['span', 'b', 'a'];
const WORDS = ['one', 'two three', ' four ', 'five\nsix', '  ', 'seven'];

function element(next: () => number, depth: number): Element {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const roll = next();
  const tag =
    roll < 0.6
      ? pick(BLOCKS)
      : roll < 0.85
        ? pick(INLINES)
        : pick(['ul', 'ol', 'input', 'button', 'br']);
  const classes = CLASSES.filter(() => next() < 0.12).join(' ');
  const attribs: Record<string, string> = classes ? { class: classes } : {};
  if (tag === 'a') attribs.href = '#x';
  const el = createElement(tag, attribs);
  if (tag === 'ul' || tag === 'ol') {
    appendChild(el, createElement('li', {}, [createText('item')]));
    return el;
  }
  if (tag === 'input' || tag === 'br') return el;
  // a host, now and then, whose light children go to its slot: a build of
  // a subtree beside a shadow tree, or around one, holds to a whole build
  if ((tag === 'div' || tag === 'section') && depth < 2 && next() < 0.12) {
    appendChild(
      el,
      createElement('template', { shadowrootmode: 'open' }, [
        createElement('b', { class: 'b' }, [createText('shadow ')]),
        createElement('slot', {}),
        createElement('p', { class: next() < 0.5 ? 'l' : 'h' }, [
          createText('after'),
        ]),
      ]),
    );
  }
  const count = depth > 2 ? 1 : 1 + Math.floor(next() * 3);
  for (let i = 0; i < count; i += 1) {
    if (depth < 3 && next() < 0.45) appendChild(el, element(next, depth + 1));
    else appendChild(el, createText(pick(WORDS)));
  }
  return el;
}

/** Every element under `root`, in the document's order. */
function elementsUnder(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    for (const child of el.children) {
      if ((child as Element).attribs) {
        out.push(child as Element);
        walk(child as Element);
      }
    }
  };
  walk(root);
  return out;
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

/** A change a page's scripts might make, done, and its records. */
function change(next: () => number, body: Element): HtmlChange[] {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const all = [body, ...elementsUnder(body)];
  const inside = all.slice(1);
  const kind = Math.floor(next() * 7);
  if (kind === 6) {
    // what a page's scripts put in and take out as they load, which draws
    // nothing: a script, a title, a template
    const undrawn = all.flatMap((el) =>
      el.children.filter(
        (n) =>
          (n as Element).attribs &&
          ['script', 'title', 'template'].includes((n as Element).name),
      ),
    ) as Element[];
    if (undrawn.length && next() < 0.4) {
      const target = pick(undrawn);
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
    const parent = pick(all);
    const child = createElement(pick(['script', 'title', 'template']), {}, [
      createText('x'),
    ]);
    const kids = parent.children.filter((n) => (n as Element).attribs);
    if (kids.length && next() < 0.5) DomUtils.prepend(pick(kids), child);
    else appendChild(parent, child);
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
  if (kind === 0 || !inside.length) {
    const parent = pick(all);
    const child = element(next, 2);
    const kids = parent.children.filter((n) => (n as Element).attribs);
    if (kids.length && next() < 0.5) DomUtils.prepend(pick(kids), child);
    else appendChild(parent, child);
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
  if (kind === 1) {
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
  if (kind === 2) {
    const target = pick(all);
    const was = target.attribs.class ?? null;
    const has = new Set((was ?? '').split(' ').filter(Boolean));
    const c = pick(CLASSES);
    if (has.has(c)) has.delete(c);
    else has.add(c);
    target.attribs.class = [...has].join(' ');
    return [
      { type: 'attributes', target, attributeName: 'class', oldValue: was },
    ];
  }
  if (kind === 3) {
    const target = pick(all);
    const text = target.children.find((n) => n.type === 'text') as
      { data: string } | undefined;
    if (text) {
      text.data = pick(WORDS);
      return [{ type: 'characterData', target: text as never }];
    }
  }
  if (kind === 4 && inside.length > 1) {
    const target = pick(inside);
    const into = pick(all.filter((e) => !elementsUnder(target).includes(e)));
    if (into !== target) {
      const from = target.parent as unknown as Element;
      const sides = sidesOf(next, target);
      appendChild(into, target as unknown as ChildNode);
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
  }
  const target = pick(all);
  const was = target.attribs.style ?? null;
  target.attribs.style = pick([
    'color: #00aa00',
    'display: none',
    'padding-left: 6px',
    'display: inline',
    'display: list-item',
    '',
  ]);
  return [
    { type: 'attributes', target, attributeName: 'style', oldValue: was },
  ];
}

/** Where an element is: its indices down from the document. */
function pathOf(el: Element | null | undefined): string {
  if (!el) return '-';
  const steps: number[] = [];
  for (let at: Element = el; at.parent; at = at.parent as Element) {
    steps.push((at.parent as Element).children.indexOf(at));
  }
  return steps.reverse().join('.');
}

/** What a box says of itself that two builds must agree on. */
function boxLine(box: Box): string {
  const s = box.style;
  const el = box.el ?? GENERATED_FROM.get(box);
  return [
    box.kind,
    pathOf(el),
    box.pseudo ?? '',
    JSON.stringify(box.text),
    `${box.textStart}-${box.textEnd}`,
    `${box.subtreeTextStart}-${box.subtreeTextEnd}`,
    // a text's, a break's or an inline box's rect is never laid out, and
    // `translate` moves it with the rest, pass after pass
    box.kind === 'text' || box.kind === 'break' || box.kind === 'inline'
      ? ''
      : // to a thousandth of a pixel: Yoga's sizes are float32, and one a
        // kept box's layout measured comes out a last bit or two apart
        [box.x, box.y, box.width, box.height]
          .map((n) => Math.round(n * 1000) / 1000)
          .join(','),
    s.display,
    s.position,
    s.float,
    s.color,
    s.fontSize,
    s.whiteSpace,
    s.userSelect,
    box.outOfFlow ? 'out' : '',
    box.isFloat ? 'float' : '',
    // and where it inks, which a block a layout kept is walked for again;
    // a text's is its line's
    box.kind === 'text' || box.kind === 'break'
      ? ''
      : [box.boundsX, box.boundsY, box.boundsWidth, box.boundsHeight]
          .map((n) => Math.round(n * 1000) / 1000)
          .join(','),
    box.lines?.length ?? '',
    // a list item's number
    box.marker ? JSON.stringify(box.marker.text) : '',
    // where its lines and the text on them are drawn, which a block kept
    // from an earlier layout carries with it
    (box.lines ?? [])
      .map((line) =>
        [
          line.x,
          line.y,
          line.width,
          line.height,
          line.baseline,
          ...line.texts.flatMap((t) => [t.drawX, t.drawY]),
        ]
          .map((n) => Math.round(n * 1000) / 1000)
          .join(','),
      )
      .join(';'),
  ].join('|');
}

/** The elements the UA's sheet never draws, whose styles a build that
 *  restyles what a change reached may leave out. */
const UNDRAWN = [
  'script',
  'style',
  'link',
  'meta',
  'title',
  'base',
  'template',
];

/** A tree as two builds of one document must have it alike. */
function treeLines(tree: BoxTree): string[] {
  const out: string[] = [];
  const walk = (box: Box, depth: number) => {
    out.push(`${' '.repeat(depth)}${boxLine(box)}`);
    for (const child of box.children) walk(child, depth + 1);
  };
  walk(tree.root, 0);
  const boxes = (name: string, list: readonly Box[]) =>
    out.push(
      `${name}: ${list.map((b) => boxLine(b).split('|').slice(0, 3).join('|')).join(' ')}`,
    );
  boxes('textBoxes', tree.textBoxes);
  boxes('controls', tree.controls);
  boxes('links', tree.links);
  boxes('focusables', tree.focusables);
  boxes('backgrounds', tree.backgrounds);
  boxes('images', tree.images);
  out.push(`text: ${JSON.stringify(tree.text)}`);
  out.push(`unselectable: ${tree.unselectable.join(',')}`);
  out.push(
    `textNodes: ${(tree.textNodes ?? [])
      .map((t) => `${JSON.stringify(t.node.data)}@${t.start}-${t.end}`)
      .join(' ')}`,
  );
  out.push(
    // but for what is never drawn, which a restyle in place leaves out
    `styles: ${[...tree.styles]
      .filter(([el]) => !UNDRAWN.includes(el.name))
      .map(
        ([el, { style, inFlex }]) =>
          `${pathOf(el)}:${style.display}:${style.color}:${inFlex}`,
      )
      .join(' ')}`,
  );
  return out;
}

metric(
  'a build of the subtrees a change reached makes the tree a build of the whole document makes',
  async () => {
    let subtrees = 0;
    let wholes = 0;
    const keptAtStart = blocksKept();
    let shadowed = 0;
    // SUBTREE_SEEDS sweeps more of them, for a change to the splice, and
    // SUBTREE_FROM starts at the one a sweep failed at
    const env =
      (globalThis as { process?: { env?: Record<string, string> } }).process
        ?.env ?? {};
    const seeds = Number(env.SUBTREE_SEEDS ?? 60);
    for (let seed = Number(env.SUBTREE_FROM ?? 1); seed <= seeds; seed += 1) {
      const next = random(seed * 104729);
      const body = createElement('body', {});
      const blocks = 3 + Math.floor(next() * 4);
      for (let i = 0; i < blocks; i += 1) appendChild(body, element(next, 0));
      const markup = DomUtils.getOuterHTML(body as never);
      const { result, node } = await render(
        `<!doctype html><html><head><style>${SHEET}</style></head>${markup}</html>`,
        320,
      );
      const el = view(node);
      await act();
      const internals = el as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      > & { _tree: BoxTree };
      const bodyEl = elementsUnder(el.document as unknown as Element).find(
        (e) => e.name === 'body',
      )!;
      if (elementsUnder(bodyEl).some((e) => shadowRootOf(e))) shadowed += 1;
      const subtreeBuild = internals._subtreeBuild;
      for (let step = 0; step < 10; step += 1) {
        const changes = change(next, bodyEl);
        let built: unknown = undefined;
        internals._subtreeBuild = function (this: unknown, ...a: unknown[]) {
          built = subtreeBuild.apply(this, a);
          return built;
        };
        el.touchDocument(changes);
        await act();
        delete internals._subtreeBuild;
        if (built) subtrees += 1;
        else if (built === null) wholes += 1;
        const kept = treeLines(internals._tree);
        // the whole document built again, every style kept, and laid out
        (el as unknown as { _invalidate(stale: number): void })._invalidate(2);
        await act();
        const whole = treeLines(internals._tree);
        const at = kept.findIndex((line, i) => line !== whole[i]);
        assert.ok(
          at < 0 && kept.length === whole.length,
          `seed ${seed}, step ${step} (${built ? 'subtrees' : 'whole'}): ` +
            `line ${at}\nkept  ${kept[at]}\nwhole ${whole[at]}\n` +
            `${markup}\n${DomUtils.getOuterHTML(bodyEl as never)}`,
        );
      }
      result.unmount();
    }
    assert.ok(subtrees > 60, `${subtrees} changes built only their subtrees`);
    assert.ok(wholes > 10, `${wholes} changes built the whole document`);
    assert.ok(shadowed > 5, `${shadowed} documents with a shadow tree`);
    // and the layouts after them kept blocks a layout before laid out
    const kept = blocksKept() - keptAtStart;
    assert.ok(kept > 100, `${kept} blocks kept from an earlier layout`);
  },
);

/** What a probe measures (`measureIntrinsicWidth`): rows whose items
 *  their automatic minimums hold wider than the row gives them, grid
 *  columns as wide as what is in them, cells, boxes sized by their content,
 *  rows that wrap and lines cut short — around blocks of text, which a
 *  probe takes for what they came to before (`Stand`). */
const PROBE_SHEET = `body { margin: 0; font-size: 14px }
.row { display: flex }
.w { width: calc(100% - 30px) }
.s { flex: 0 0 60px }
.wrap { display: flex; flex-wrap: wrap }
.col { display: flex; flex-direction: column }
.gr { display: grid; grid-template-columns: auto 1fr }
.mc { width: min-content }
.fc { width: fit-content }
.xc { width: max-content; max-width: 100% }
.ib { display: inline-block }
.fl { float: left }
.tb { display: table }
.tc { display: table-cell }
.el { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.pc { margin: 0 10%; padding: 0 5% }
.l { margin: 6px 0 }
.h { padding: 3px; border: 1px solid #000 }
.nw { white-space: nowrap }`;

const PROBE_CLASSES = [
  'row',
  'w',
  's',
  'wrap',
  'col',
  'gr',
  'mc',
  'fc',
  'xc',
  'ib',
  'fl',
  'tb',
  'tc',
  'el',
  'pc',
  'l',
  'h',
  'nw',
];

const PROBE_WORDS = [
  'one two',
  'three four five six',
  'averyveryverylongword',
  'seven',
  'eight nine ten eleven twelve',
];

function probed(next: () => number, depth: number): Element {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const classes = PROBE_CLASSES.filter(() => next() < 0.1);
  const el = createElement(
    pick(['div', 'p', 'section']),
    classes.length ? { class: classes.join(' ') } : {},
  );
  // a list of blocks, now and then, which a probe of what holds it lays
  // out as often as it measures it
  const count = depth > 2 ? 1 : 1 + Math.floor(next() * (depth ? 3 : 5));
  for (let i = 0; i < count; i += 1) {
    const roll = next();
    if (depth < 3 && roll < 0.55) appendChild(el, probed(next, depth + 1));
    else if (roll < 0.7) {
      appendChild(
        el,
        createElement(pick(['span', 'b']), {}, [createText(pick(PROBE_WORDS))]),
      );
    } else appendChild(el, createText(pick(PROBE_WORDS)));
  }
  return el;
}

/** A change to a document of `probed` elements, done, and its records. */
function probedChange(next: () => number, body: Element): HtmlChange[] {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const all = [body, ...elementsUnder(body)];
  const inside = all.slice(1);
  const kind = Math.floor(next() * 5);
  if (kind === 0 || !inside.length) {
    const parent = pick(all);
    const child = probed(next, 2);
    const kids = parent.children.filter((n) => (n as Element).attribs);
    if (kids.length && next() < 0.5) DomUtils.prepend(pick(kids), child);
    else appendChild(parent, child);
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
  if (kind === 1) {
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
  if (kind === 2) {
    const target = pick(all);
    const was = target.attribs.class ?? null;
    const has = new Set((was ?? '').split(' ').filter(Boolean));
    const c = pick(PROBE_CLASSES);
    if (has.has(c)) has.delete(c);
    else has.add(c);
    target.attribs.class = [...has].join(' ');
    return [
      { type: 'attributes', target, attributeName: 'class', oldValue: was },
    ];
  }
  if (kind === 3) {
    const target = pick(all);
    const text = target.children.find((n) => n.type === 'text') as
      { data: string } | undefined;
    if (text) {
      text.data = pick(PROBE_WORDS);
      return [{ type: 'characterData', target: text as never }];
    }
  }
  const target = pick(all);
  const was = target.attribs.style ?? null;
  target.attribs.style = pick([
    'width: 50px',
    'margin-left: 12px',
    'display: none',
    'padding: 0 8%',
    'min-width: 0',
    '',
  ]);
  return [
    { type: 'attributes', target, attributeName: 'style', oldValue: was },
  ];
}

metric(
  'a probe that takes blocks for what they came to before measures what a probe of all new boxes measures',
  async () => {
    const standsAtStart = standsMade();
    // PROBE_SEEDS sweeps more of them, and PROBE_FROM starts at one
    const env =
      (globalThis as { process?: { env?: Record<string, string> } }).process
        ?.env ?? {};
    const seeds = Number(env.PROBE_SEEDS ?? 40);
    for (let seed = Number(env.PROBE_FROM ?? 1); seed <= seeds; seed += 1) {
      const next = random(seed * 7919);
      const body = createElement('body', {});
      const blocks = 3 + Math.floor(next() * 4);
      for (let i = 0; i < blocks; i += 1) appendChild(body, probed(next, 0));
      const markup = DomUtils.getOuterHTML(body as never);
      const { result, node } = await render(
        `<!doctype html><html><head><style>${PROBE_SHEET}</style></head>${markup}</html>`,
        320,
      );
      const el = view(node);
      await act();
      const internals = el as unknown as { _tree: BoxTree };
      const bodyEl = elementsUnder(el.document as unknown as Element).find(
        (e) => e.name === 'body',
      )!;
      for (let step = 0; step < 8; step += 1) {
        el.touchDocument(probedChange(next, bodyEl));
        await act();
        const kept = treeLines(internals._tree);
        // the whole document built again, laid out with no block that
        // stood for a probe before
        (el as unknown as { _invalidate(stale: number): void })._invalidate(2);
        await act();
        const whole = treeLines(internals._tree);
        const at = kept.findIndex((line, i) => line !== whole[i]);
        assert.ok(
          at < 0 && kept.length === whole.length,
          `seed ${seed}, step ${step}: line ${at}\nkept  ${kept[at]}\n` +
            `whole ${whole[at]}\n${markup}\n` +
            DomUtils.getOuterHTML(bodyEl as never),
        );
      }
      result.unmount();
    }
    const stood = standsMade() - standsAtStart;
    assert.ok(
      stood > 200,
      `${stood} blocks a probe took for what they came to`,
    );
  },
);

/** Rules a stream's chunk can change the answer of for what was there
 *  before it: where a child sits from the end, whether an element holds
 *  anything, what follows a sibling — and counters, which a tail at the
 *  document's end may count with nothing after it to read them. */
const STREAM_SHEETS = [
  '',
  `p:last-child { color: #00aa00 }
li:nth-last-child(2) { color: #aa00aa }
div:empty { display: none }
section:empty { padding: 3px }
h2 + p { margin-top: 0 }
span:last-of-type { font-size: 12px }
b:only-child { color: #0000aa }
div > :first-child { padding-left: 2px }
p ~ div { border-left: 2px solid #333 }`,
  `body { counter-reset: n }
h2 { counter-increment: n }
h2::before { content: counter(n) ". " }
ol { counter-reset: item }
ol > li::marker { content: counter(item) ") " }
ol > li { counter-increment: item }
blockquote::before { content: open-quote }
blockquote::after { content: close-quote }`,
];

/** More of what a model writes than `element` makes: lists, a table, code
 *  and a quote. */
function streamed(next: () => number, depth: number): Element {
  const roll = next();
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  if (roll < 0.12) {
    const list = createElement(pick(['ul', 'ol']), {});
    const items = 1 + Math.floor(next() * 4);
    for (let i = 0; i < items; i += 1) {
      appendChild(
        list,
        createElement('li', {}, [createText(pick(WORDS) + ' item')]),
      );
    }
    return list;
  }
  if (roll < 0.17) {
    return createElement('pre', {}, [createText('code\n  more\n')]);
  }
  if (roll < 0.22) {
    return createElement('blockquote', {}, [
      createElement('p', {}, [createText(pick(WORDS))]),
    ]);
  }
  if (roll < 0.26) {
    return createElement('table', {}, [
      createElement('tr', {}, [
        createElement('td', {}, [createText('a')]),
        createElement('td', {}, [createText(pick(WORDS))]),
      ]),
    ]);
  }
  if (roll < 0.32) {
    const attribs: Record<string, string> = next() < 0.5 ? { id: 'h' } : {};
    return createElement('h2', attribs, [createText(pick(WORDS))]);
  }
  // and what the document's scan collects: a sheet, an image, a script,
  // a drawing that names a sprite, and the sprite
  if (roll < 0.35) {
    return createElement('style', {}, [createText('.r { color: #006600 }')]);
  }
  if (roll < 0.37) {
    return createElement('img', { src: 'a.png', width: '10', height: '8' });
  }
  if (roll < 0.39) return createElement('script', {}, [createText('1')]);
  if (roll < 0.42) {
    return createElement('svg', { width: '10', height: '10' }, [
      createElement('use', { href: '#s' }),
    ]);
  }
  if (roll < 0.44) {
    return createElement('svg', { style: 'display:none' }, [
      createElement('symbol', { id: 's', viewBox: '0 0 2 2' }, [
        createElement('rect', { class: 'r', width: '2', height: '2' }),
      ]),
    ]);
  }
  return element(next, depth);
}

/** What the document's scan found (`HtmlSource.facts`), as two parses of
 *  one document must have it alike. */
function factsLine(el: unknown): string {
  const facts = (
    el as { _source: { facts(): Record<string, unknown> } }
  )._source.facts() as {
    sheets: { kind: string; element: Element; text?: string }[];
    scripts: Element[];
    resources: Element[];
    pictures: Element[];
    drawings: Element[];
    title: string | null;
    base: string | null;
  };
  return JSON.stringify([
    facts.sheets.map((s) => [s.kind, pathOf(s.element), s.text ?? '']),
    facts.scripts.map(pathOf),
    facts.resources.map(pathOf),
    facts.pictures.map(pathOf),
    facts.drawings.map(pathOf),
    facts.title,
    facts.base,
  ]);
}

/** Places to cut `markup` at after `from`, in order: anywhere — inside a
 *  word, a tag, an attribute — and as often just after a tag ends. */
function cutsOf(next: () => number, markup: string, from: number): number[] {
  const cuts = new Set<number>();
  const count = 5 + Math.floor(next() * 12);
  for (let i = 0; i < count; i += 1) {
    let at = from + Math.floor(next() * (markup.length - from));
    if (next() < 0.5) {
      const close = markup.indexOf('>', at);
      if (close >= 0) at = close + 1;
    }
    if (at > from && at < markup.length) cuts.add(at);
  }
  return [...cuts].sort((a, b) => a - b).concat(markup.length);
}

metric(
  'a stream fed a chunk at a time makes the tree a build of the whole prefix makes',
  async () => {
    let subtrees = 0;
    let wholes = 0;
    let steps = 0;
    const keptAtStart = blocksKept();
    const endsAtStart = buildsAtEnd();
    // STREAM_SEEDS sweeps more of them, and STREAM_FROM starts at one
    const env =
      (globalThis as { process?: { env?: Record<string, string> } }).process
        ?.env ?? {};
    const seeds = Number(env.STREAM_SEEDS ?? 40);
    for (let seed = Number(env.STREAM_FROM ?? 1); seed <= seeds; seed += 1) {
      const next = random(seed * 7919);
      const holder = createElement('body', {});
      const blocks = 3 + Math.floor(next() * 6);
      for (let i = 0; i < blocks; i += 1) {
        appendChild(holder, streamed(next, 0));
      }
      // a document, or a fragment the way a model writes one, whose
      // children are the document's own
      const sheet = SHEET + '\n' + STREAM_SHEETS[seed % STREAM_SHEETS.length];
      const content = holder.children
        .map((n) => DomUtils.getOuterHTML(n as never))
        .join(next() < 0.5 ? '\n' : '');
      const fragment = seed % 3 === 0;
      const head = fragment
        ? `<style>${sheet}</style>`
        : `<!doctype html><html><head><style>${sheet}</style></head><body>`;
      const markup = head + content + (fragment ? '' : '</body></html>');
      const cuts = cutsOf(next, markup, head.length);
      // The stream, and beside it the same chunks, each styled and built
      // whole, as every chunk was before a chunk built its tails — the
      // same parse, since how a chunk cut inside a `<style>` reads depends
      // on where it was cut, and scanned whole at each.
      const pair = (prefix: string, last: boolean) =>
        h(
          'box',
          { style: { flexDirection: 'column' } },
          h(
            'box',
            { style: { width: 320, flexDirection: 'column' } },
            h(Html, {
              source: prefix,
              partial: !last,
              'data-testname': 'stream',
            }),
          ),
          h(
            'box',
            { style: { width: 320, flexDirection: 'column' } },
            h(Html, {
              source: prefix,
              partial: !last,
              'data-testname': 'whole',
            }),
          ),
        );
      const result = await renderX11(pair(markup.slice(0, cuts[0]), false), {
        width: 360,
        height: 600,
        fonts: FONTS!,
      });
      const stream = () => view(screen.getByTestName('stream') as DrawnNode);
      const reference = view(screen.getByTestName('whole') as DrawnNode);
      Object.assign(reference, { _parsedChanges: () => false });
      Object.assign((reference as unknown as { _source: object })._source, {
        _extendFacts: () => null,
      });
      await act();
      for (let step = 1; step < cuts.length; step += 1) {
        // the last step ends the source
        const last = step === cuts.length - 1;
        const prefix = markup.slice(0, cuts[step]);
        const internals = stream() as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        > & { _tree: BoxTree };
        const subtreeBuild = internals._subtreeBuild;
        let built: unknown = undefined;
        internals._subtreeBuild = function (this: unknown, ...a: unknown[]) {
          built = subtreeBuild.apply(this, a);
          return built;
        };
        await act(() => result.rerender(pair(prefix, last)));
        delete internals._subtreeBuild;
        steps += 1;
        if (built) subtrees += 1;
        else if (built === null) wholes += 1;
        const a = stream();
        const b = reference;
        const domA = DomUtils.getOuterHTML(a.document as never);
        const domB = DomUtils.getOuterHTML(b.document as never);
        assert.strictEqual(domA, domB, `seed ${seed}, step ${step}: the DOM`);
        assert.strictEqual(
          factsLine(a),
          factsLine(b),
          `seed ${seed}, step ${step}: what the scan found`,
        );
        const kept = treeLines((a as unknown as { _tree: BoxTree })._tree);
        const whole = treeLines((b as unknown as { _tree: BoxTree })._tree);
        const at = kept.findIndex((line, i) => line !== whole[i]);
        assert.ok(
          at < 0 && kept.length === whole.length,
          `seed ${seed}, step ${step} (${built ? 'subtrees' : 'whole'}): ` +
            `line ${at}\nkept  ${kept[at]}\nwhole ${whole[at]}\n` +
            `${JSON.stringify(markup.slice(0, cuts[step - 1]))}\n+ ` +
            JSON.stringify(prefix.slice(cuts[step - 1])),
        );
      }
      result.unmount();
    }
    assert.ok(
      subtrees > steps / 3,
      `${subtrees} of ${steps} chunks built only their subtrees (${wholes} the whole)`,
    );
    const kept = blocksKept() - keptAtStart;
    assert.ok(kept > 100, `${kept} blocks kept from an earlier layout`);
    // and most of them spliced where the document ends
    const ends = buildsAtEnd() - endsAtStart;
    assert.ok(ends > subtrees / 2, `${ends} of them at the document's end`);
  },
);

metric(
  'a script’s child put in or taken out at the end of what holds it builds that end, and keeps the boxes before it',
  async () => {
    // A webmail page puts its popups at the end of its `<body>`, a flex
    // column, and takes them out again: each built the whole document. The
    // end of a flex box, whose children are each an item, and of a block,
    // whose build noted what its wraps ran from, is built as a stream's is
    // — Apple's `<body>` holds a line of text before its blocks, and every
    // dialog its script put at the end built the whole page.
    for (const holder of ['flex', 'block', 'wrapped']) {
      const display = holder === 'flex' ? 'flex' : 'block';
      const { node, result } = await render(
        '<!doctype html><html><head><style>body { margin: 0;' +
          ` font-size: 14px; display: ${display}; flex-direction: column }` +
          '.pop { position: absolute; top: 0; left: 0; width: 20px }' +
          `</style></head><body>${holder === 'wrapped' ? '<span>skip</span> to it' : ''}` +
          '<main id="app"><p id="p">the page</p>' +
          '<section id="s"><p>more of it</p></section></main>' +
          '<div id="cover">cover</div></body></html>',
        320,
      );
      const el = view(node);
      await act();
      const internals = el as unknown as {
        _tree: BoxTree;
        _firstBoxesOf(tree: BoxTree): Map<Element, Box>;
        _invalidate(stale: number): void;
      };
      const all = () => elementsUnder(el.document as unknown as Element);
      const byId = (id: string): Element =>
        all().find((e) => e.attribs.id === id)!;
      const boxOf = (id: string) =>
        internals._firstBoxesOf(internals._tree).get(byId(id));
      const body = all().find((e) => e.name === 'body')!;
      const app = boxOf('app');
      const p = boxOf('p');
      const pop = createElement('div', { class: 'pop' }, [createText('hi')]);
      appendChild(body, pop);
      const put: HtmlChange = {
        type: 'childList',
        target: body,
        addedNodes: [pop],
        removedNodes: [],
        previousSibling: byId('cover'),
        nextSibling: null,
      };
      el.touchDocument([put]);
      await act();
      assert.ok(
        boxOf('app') === app && boxOf('p') === p,
        `${holder}: what was before it built again as one was put in`,
      );
      let lines = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      let whole = treeLines(internals._tree);
      let at = lines.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        at < 0 && lines.length === whole.length,
        `${holder}, put in: line ${at}\nkept  ${lines[at]}\nwhole ${whole[at]}`,
      );
      // and taken out, with the cover before it, which ends the line
      const before = { app: boxOf('app'), p: boxOf('p') };
      removeNode(pop as unknown as ChildNode);
      const out: HtmlChange = {
        type: 'childList',
        target: body,
        addedNodes: [],
        removedNodes: [pop],
        previousSibling: byId('cover'),
        nextSibling: null,
      };
      el.touchDocument([out]);
      await act();
      assert.ok(
        boxOf('app') === before.app && boxOf('p') === before.p,
        `${holder}: what was before it built again as one was taken out`,
      );
      lines = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      whole = treeLines(internals._tree);
      at = lines.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        at < 0 && lines.length === whole.length,
        `${holder}, taken out: line ${at}\nkept  ${lines[at]}\nwhole ${whole[at]}`,
      );
      result.unmount();
    }
  },
);

metric(
  "a block holding an absolute box with no inset and a size of its own — a link's sr-only label — is kept by a layout, and the box moves with it where a layout of all new boxes puts it",
  async () => {
    // placed against the article and not the paragraph, each such label
    // made the boxes between them laid out again at every layout:
    // joshwcomeau.com's paragraphs, lists and asides, at every step of a
    // playground's divider. One with an inset, or a size that is a
    // percentage of what it is placed against, still makes them so.
    const { node } = await render(
      '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
        'article { position: relative } p { margin: 2px }' +
        '.sr { position: absolute; width: 1px; height: 1px; margin: -1px;' +
        ' padding: 0; overflow: hidden; clip: rect(0 0 0 0);' +
        ' white-space: nowrap }' +
        '.inset { position: absolute; top: 0; width: 1px; height: 1px }' +
        '</style></head><body><article>' +
        '<p id="a">first <span id="grow">s</span></p>' +
        '<p id="b">a <a href="#x">link<span class="sr">opens elsewhere' +
        '</span></a> in it</p>' +
        '<div id="c"><p id="c1">and <a href="#y">another<span class="sr">' +
        'label</span></a> after</p></div>' +
        '<p id="d">and one <span class="inset">placed</span> at the top</p>' +
        '</article></body></html>',
      320,
    );
    const el = view(node);
    await act();
    const internals = el as unknown as {
      _tree: BoxTree;
      _firstBoxesOf(tree: BoxTree): Map<Element, Box>;
      _invalidate(stale: number): void;
    };
    const byId = (id: string): Element =>
      elementsUnder(el.document as unknown as Element).find(
        (e) => e.attribs.id === id,
      )!;
    const serials = (ids: readonly string[]): number[] =>
      ids.map(
        (id) =>
          internals._firstBoxesOf(internals._tree).get(byId(id))!.layoutSerial,
      );
    const kept = serials(['b', 'c', 'c1']);
    const inset = serials(['d']);
    const span = byId('grow');
    const text = createText(' and more of it, enough to wrap a line or two');
    appendChild(span, text);
    el.touchDocument([
      { type: 'childList', target: span, addedNodes: [text], removedNodes: [] },
    ]);
    await act();
    assert.deepStrictEqual(
      serials(['b', 'c', 'c1']),
      kept,
      'a block holding an sr-only label was laid out again',
    );
    assert.notDeepStrictEqual(
      serials(['d']),
      inset,
      'a block holding a box placed by its inset was kept',
    );
    const lines = treeLines(internals._tree);
    internals._invalidate(2);
    await act();
    const whole = treeLines(internals._tree);
    const line = lines.findIndex((one, i) => one !== whole[i]);
    assert.ok(
      line < 0 && lines.length === whole.length,
      `line ${line}\nkept  ${lines[line]}\nwhole ${whole[line]}`,
    );
  },
);

metric(
  'a layout after a change in one flex item or grid item keeps the others as an earlier layout laid them out, where a layout of all new boxes puts them',
  async () => {
    // joshwcomeau.com's article is a grid of a hundred paragraphs in flex
    // boxes, and a sparkle its like button put in beside one of them laid
    // every one of them out again, three times a second
    const { node } = await render(
      '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
        '.col { display: flex; flex-direction: column; gap: 4px }' +
        '.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px }' +
        'p { margin: 2px }</style></head><body>' +
        '<div class="col"><p id="f1">one item of a column</p>' +
        '<p id="f2">two <span id="fs">s</span></p>' +
        '<p id="f3">three items down</p></div>' +
        '<div class="grid"><p id="g1">one cell of a grid</p>' +
        '<p id="g2">two <span id="gs">s</span></p><p id="g3">three</p>' +
        '<p id="g4">four cells across</p></div></body></html>',
      320,
    );
    const el = view(node);
    await act();
    const internals = el as unknown as {
      _tree: BoxTree;
      _firstBoxesOf(tree: BoxTree): Map<Element, Box>;
      _invalidate(stale: number): void;
    };
    const byId = (id: string): Element =>
      elementsUnder(el.document as unknown as Element).find(
        (e) => e.attribs.id === id,
      )!;
    const serials = (ids: readonly string[]): number[] =>
      ids.map(
        (id) =>
          internals._firstBoxesOf(internals._tree).get(byId(id))!.layoutSerial,
      );
    for (const [at, others] of [
      ['fs', ['f1', 'f3']],
      ['gs', ['g1', 'g3', 'g4']],
    ] as const) {
      const before = serials(others);
      const span = byId(at);
      const text = createText(' and more of it');
      appendChild(span, text);
      el.touchDocument([
        {
          type: 'childList',
          target: span,
          addedNodes: [text],
          removedNodes: [],
        },
      ]);
      await act();
      assert.deepStrictEqual(
        serials(others),
        before,
        `#${others.join(', #')} laid out again for #${at}`,
      );
      const kept = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      const whole = treeLines(internals._tree);
      const line = kept.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        line < 0 && kept.length === whole.length,
        `line ${line}\nkept  ${kept[line]}\nwhole ${whole[line]}`,
      );
    }
  },
);

metric(
  'a layout under another viewport height keeps the blocks, flex items and grid items an earlier one laid out where that one read none of the height, where a layout of all new boxes puts them',
  async () => {
    // A pane's height is a frame's to decide, after the document's first
    // layout, and the layout after that one laid out again every block,
    // flex item and grid item the first had laid out, whatever they held:
    // a grid of a hundred paragraphs set again for nothing. A document that
    // reads the height — here a box placed against the viewport's bottom —
    // is laid out again under the new one, as it was.
    for (const reads of [false, true]) {
      const { el, resize } = await renderScrolled(
        '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
          'article { display: grid; grid-template-columns: 1fr; gap: 6px }' +
          '.col { display: flex; flex-direction: column; gap: 4px }' +
          'p { margin: 2px } .code { height: 300px }' +
          '.foot { position: fixed; bottom: 0; height: 10px; width: 10px }' +
          '</style></head><body><article><p id="g1">a paragraph</p>' +
          '<div class="code" id="g2">let a = 1;</div>' +
          '<p id="g3">another paragraph below it</p></article>' +
          '<div class="col"><p id="f1">one item of a column</p>' +
          '<p id="f2">two items down</p></div><p id="b1">and a block</p>' +
          (reads ? '<div class="foot"></div>' : '') +
          '</body></html>',
        160,
        320,
      );
      const internals = el as unknown as {
        _tree: BoxTree;
        _firstBoxesOf(tree: BoxTree): Map<Element, Box>;
        _invalidate(stale: number): void;
      };
      const byId = (id: string): Element =>
        elementsUnder(el.document as unknown as Element).find(
          (e) => e.attribs.id === id,
        )!;
      const ids = ['g1', 'g2', 'g3', 'f1', 'f2', 'b1'];
      const serials = (): number[] =>
        ids.map(
          (id) =>
            internals._firstBoxesOf(internals._tree).get(byId(id))!
              .layoutSerial,
        );
      const before = serials();
      await resize(220);
      internals._invalidate(1);
      await act();
      if (reads) {
        assert.notDeepStrictEqual(serials(), before, 'kept under a new height');
      } else {
        assert.deepStrictEqual(
          serials(),
          before,
          `#${ids.join(', #')} laid out again under a new height`,
        );
      }
      const kept = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      const whole = treeLines(internals._tree);
      const line = kept.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        line < 0 && kept.length === whole.length,
        `reads ${reads}: line ${line}\nkept  ${kept[line]}\nwhole ${whole[line]}`,
      );
      cleanup();
    }
  },
);

metric(
  'a change beside a block that styles its first letter builds only the subtree it reached, where a build of all new boxes puts it',
  async (t) => {
    // a webmail page's header styles the first letter of the account's
    // name, one rule in all its sheets, and every change the page made was
    // a build of all 12,894 of its elements
    const { node } = await render(
      '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
        '.lead::first-letter { font-size: 24px; color: #00aa00 }' +
        'p { margin: 2px }</style></head><body>' +
        '<div class="lead"><p id="l1">Opening <span id="ls">words</span></p>' +
        '<p id="l2">and more</p></div>' +
        '<div><p id="b1">beside <span id="bs">it</span></p>' +
        '<p id="b2">a second row</p></div></body></html>',
      320,
    );
    const el = view(node);
    await act();
    const internals = el as unknown as {
      _tree: BoxTree;
      _subtreeBuild(...a: unknown[]): BoxTree | null;
      _invalidate(stale: number): void;
    };
    const byId = (id: string): Element =>
      elementsUnder(el.document as unknown as Element).find(
        (e) => e.attribs.id === id,
      )!;
    for (const [at, apart] of [
      ['bs', true],
      ['ls', false],
    ] as const) {
      const built = t.mock.method(internals, '_subtreeBuild');
      const span = byId(at);
      const text = createText(' and more of it');
      appendChild(span, text);
      el.touchDocument([
        {
          type: 'childList',
          target: span,
          addedNodes: [text],
          removedNodes: [],
        },
      ]);
      await act();
      const result = built.mock.calls.at(-1)?.result;
      built.mock.restore();
      // inside the block whose letter is looked for, the whole is built
      assert.strictEqual(
        result !== null && result !== undefined,
        apart,
        `#${at} built ${result ? 'its subtree' : 'the whole document'}`,
      );
      const kept = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      const whole = treeLines(internals._tree);
      const line = kept.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        line < 0 && kept.length === whole.length,
        `line ${line}\nkept  ${kept[line]}\nwhole ${whole[line]}`,
      );
    }
  },
);

metric(
  'a change before a list that makes its own counter builds only the subtree it reached, and one before what counts a counter of the document’s builds the whole, where a build of all new boxes puts it',
  async (t) => {
    // Apple's product pages hold a `<ul>` in every section, which makes a
    // `list-item` counter, and end in footnotes, an `<ol>` whose numbers
    // read one: a change in a section counted, a box after it read a
    // counter, and every write of the page's script built all of it. The
    // `<ol>` makes its own, which nothing before it changes; a counter the
    // `<body>` makes is another matter.
    const head =
      '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
      ' .doc { counter-reset: fig } .tick { counter-increment: fig }' +
      ' .fig::before { counter-increment: fig; content: "Fig. " counter(fig) " " }' +
      ' p { margin: 2px }</style></head>';
    for (const [body, apart] of [
      [
        '<body><section id="s"><ul><li>one</li><li>two</li></ul>' +
          '<p>a section</p></section><p>more</p>' +
          '<ol><li>a note</li><li>another</li></ol></body>',
        true,
      ],
      [
        '<body class="doc"><section id="s"><p class="fig">first</p>' +
          '<p>here</p></section><p class="fig">second</p></body>',
        false,
      ],
    ] as const) {
      const { node, result: rendered } = await render(
        `${head}${body}</html>`,
        320,
      );
      const el = view(node);
      await act();
      const internals = el as unknown as {
        _tree: BoxTree;
        _subtreeBuild(...a: unknown[]): BoxTree | null;
        _invalidate(stale: number): void;
      };
      const section = elementsUnder(el.document as unknown as Element).find(
        (e) => e.attribs.id === 's',
      )!;
      const built = t.mock.method(internals, '_subtreeBuild');
      const first = section.children[0] as ChildNode;
      // one that counts, and reads nothing it did not make
      const p = createElement('p', { class: 'tick' }, [createText('put in')]);
      DomUtils.prependChild(section as never, p as never);
      el.touchDocument([
        {
          type: 'childList',
          target: section,
          addedNodes: [p],
          removedNodes: [],
          previousSibling: null,
          nextSibling: first,
        },
      ]);
      await act();
      const result = built.mock.calls.at(-1)?.result;
      built.mock.restore();
      assert.strictEqual(
        result !== null && result !== undefined,
        apart,
        `built ${result ? 'the subtree' : 'the whole document'}`,
      );
      const kept = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      const whole = treeLines(internals._tree);
      const line = kept.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        line < 0 && kept.length === whole.length,
        `line ${line}\nkept  ${kept[line]}\nwhole ${whole[line]}`,
      );
      rendered.unmount();
    }
  },
);

metric(
  'a probe of a flex row keeps the items an earlier layout laid out, where a layout of all new boxes puts them',
  async () => {
    // A webmail page's promo holds a hidden strip of 2,496 senders, a
    // nowrap row in a grid's `auto` column, and the flex row around the
    // grid asks for its least width: a probe at no width, which laid every
    // sender out again at each layout of the page, whatever changed.
    const items = Array.from(
      { length: 40 },
      (_, i) =>
        `<div class="item"><span class="b"><i class="av"></i>` +
        `<span>sender ${i}</span></span></div>`,
    ).join('');
    const { node } = await render(
      '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
        '.root { display: flex }' +
        '.body { display: flex; width: calc(100% - 57px); flex-grow: 1 }' +
        '.aside { width: 70px; flex-shrink: 0 }' +
        '.main { flex-grow: 1; min-width: 0; display: flex; overflow: hidden }' +
        '.mc { flex: auto; min-width: 0; display: flex; flex-direction: column }' +
        '.grid { display: grid; grid-template-columns: min-content 60px auto;' +
        ' overflow: hidden; white-space: nowrap }' +
        '.strip { width: 100%; overflow: hidden }' +
        '.list { display: flex; width: 100%; overflow: hidden; height: 0 }' +
        '.item { flex: none }' +
        '.b { display: flex; align-items: center; padding: 2px 4px }' +
        '.av { display: block; width: 10px; height: 10px; margin-right: 3px }' +
        'p { margin: 2px }</style></head><body><div class="root">' +
        '<div class="body"><div class="main"><div class="mc">' +
        '<div class="grid"><span>i</span><span>title</span>' +
        `<div class="strip"><div class="list">${items}</div></div></div>` +
        '<p id="msg">a message <span id="ms">row</span></p></div></div></div>' +
        '<div class="aside">bar</div></div></body></html>',
      480,
    );
    const el = view(node);
    await act();
    const internals = el as unknown as {
      _tree: BoxTree;
      _invalidate(stale: number): void;
    };
    const senders = (): Box[] => {
      const out: Box[] = [];
      const walk = (box: Box) => {
        if (box.el?.attribs.class === 'item') out.push(box);
        for (const child of box.children) walk(child);
      };
      walk(internals._tree.root);
      return out;
    };
    const span = elementsUnder(el.document as unknown as Element).find(
      (e) => e.attribs.id === 'ms',
    )!;
    for (let round = 0; round < 2; round += 1) {
      const before = senders().map((box) => box.layoutSerial);
      const text = createText(' and more');
      appendChild(span, text);
      el.touchDocument([
        {
          type: 'childList',
          target: span,
          addedNodes: [text],
          removedNodes: [],
        },
      ]);
      await act();
      const after = senders().map((box) => box.layoutSerial);
      const again = after.filter((serial, i) => serial !== before[i]).length;
      assert.strictEqual(
        again,
        0,
        `${again} of ${after.length} senders laid out again (round ${round})`,
      );
      const kept = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      const whole = treeLines(internals._tree);
      const line = kept.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        line < 0 && kept.length === whole.length,
        `line ${line}\nkept  ${kept[line]}\nwhole ${whole[line]}`,
      );
    }
  },
);

/** What the passes after a flow move — sticky boxes held to the viewport
 *  and to scroll containers, relative boxes with insets and without,
 *  transforms, scrolls — in blocks a layout keeps, beside flex and grid
 *  items, boxes out of the flow placed in them, and ink past a box. */
const MOVING_SHEET = `body { margin: 0; font-size: 14px }
.st { position: sticky; top: 12px; background: #eeeeee }
.sb { position: sticky; bottom: 6px }
.r { position: relative; top: 3px; left: 2px }
.z { position: relative }
.t { transform: translate(4px, 3px) }
.sc { overflow: auto; height: 36px }
.ab { position: absolute; top: 2px; right: 3px; width: 12px; height: 6px }
.sh { box-shadow: 0 3px 5px #000000 }
.fx { display: flex; gap: 3px }
.gr { display: grid; grid-template-columns: 1fr 1fr }
.tall { min-height: 90px }
p { margin: 4px 0 }`;

const MOVING_CLASSES = ['st', 'sb', 'r', 'z', 't', 'sc', 'sh', 'fx', 'gr'];

function moving(next: () => number, depth: number): Element {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const classes = MOVING_CLASSES.filter(() => next() < 0.14);
  if (next() < 0.15) classes.push('tall');
  const el = createElement(
    pick(['div', 'p', 'section']),
    classes.length ? { class: classes.join(' ') } : {},
  );
  // something out of the flow, placed against a box it is in
  if (classes.includes('z') || classes.includes('r')) {
    if (next() < 0.5) appendChild(el, createElement('i', { class: 'ab' }));
  }
  const count = depth > 2 ? 1 : 1 + Math.floor(next() * 3);
  for (let i = 0; i < count; i += 1) {
    const roll = next();
    if (depth < 3 && roll < 0.45) appendChild(el, moving(next, depth + 1));
    else if (roll < 0.6) {
      appendChild(
        el,
        createElement('span', { class: pick(['r', 'z', 'sh', '']) }, [
          createText(pick(WORDS)),
        ]),
      );
    } else appendChild(el, createText(pick(['one two', 'three four five'])));
  }
  return el;
}

metric(
  'a layout keeps blocks that hold sticky, relative, transformed and scrolled boxes, and places them and keeps their ink as a layout of all new boxes does',
  async () => {
    const keptAtStart = blocksKept();
    const inkAtStart = inkKept();
    let stickyKept = 0;
    // MOVING_SEEDS sweeps more of them, and MOVING_FROM starts at one
    const env =
      (globalThis as { process?: { env?: Record<string, string> } }).process
        ?.env ?? {};
    const seeds = Number(env.MOVING_SEEDS ?? 30);
    for (let seed = Number(env.MOVING_FROM ?? 1); seed <= seeds; seed += 1) {
      const next = random(seed * 6151);
      const pick = <T>(list: readonly T[]): T =>
        list[Math.floor(next() * list.length)];
      const body = createElement('body', {});
      const blocks = 4 + Math.floor(next() * 5);
      for (let i = 0; i < blocks; i += 1) appendChild(body, moving(next, 0));
      appendChild(body, createElement('div', { style: 'height: 400px' }));
      const markup = DomUtils.getOuterHTML(body as never);
      const { el, result } = await renderScrolled(
        `<!doctype html><html><head><style>${MOVING_SHEET}</style></head>${markup}</html>`,
        160,
        320,
      );
      const internals = el as unknown as {
        _tree: BoxTree;
        _invalidate(stale: number): void;
        _firstBoxesOf(tree: BoxTree): Map<Element, Box>;
      };
      const pane = movingPane(el);
      const bodyEl = elementsUnder(el.document as unknown as Element).find(
        (e) => e.name === 'body',
      )!;
      for (let step = 0; step < 10; step += 1) {
        const all = elementsUnder(bodyEl);
        const kind = Math.floor(next() * 8);
        // the blocks that hold a sticky box, and when each was laid out
        const holding = () =>
          [...internals._firstBoxesOf(internals._tree)]
            .filter(
              ([e, box]) =>
                box.kind === 'block' &&
                e.name !== 'body' &&
                elementsUnder(e).some((d) =>
                  /\bs[tb]\b/.test(d.attribs.class ?? ''),
                ),
            )
            .map(([e, box]) => [e, box.layoutSerial] as const);
        const before = holding();
        let what = '';
        if (kind === 0 || kind === 1) {
          // something above the rest, which moves every block after it
          const into = pick([bodyEl, ...all.filter((e) => e.name !== 'i')]);
          const added = createElement('p', {}, [
            createText(pick(['added', 'a longer line of words added here'])),
          ]);
          const first = into.children.find((n) => (n as Element).attribs);
          if (first && kind === 0) DomUtils.prepend(first as never, added);
          else appendChild(into, added);
          el.touchDocument([
            {
              type: 'childList',
              target: added.parent as unknown as Element,
              addedNodes: [added],
              removedNodes: [],
            },
          ]);
          what = `a paragraph in ${pathOf(into)}`;
        } else if (kind === 2) {
          const target = pick(all);
          const text = target.children.find((n) => n.type === 'text') as
            { data: string } | undefined;
          if (text) {
            text.data = pick(['x', 'a much longer run of text than before']);
            el.touchDocument([
              { type: 'characterData', target: text as never },
            ]);
          }
          what = `the text of ${pathOf(target)}`;
        } else if (kind === 3 || kind === 4) {
          // in place: a transform, or a relative box's inset
          const target = pick(all.filter((e) => e.name !== 'i'));
          const was = target.attribs.style ?? null;
          target.attribs.style =
            kind === 3
              ? pick(['transform: translate(6px, 2px)', ''])
              : pick(['top: 5px', 'left: 7px', '']);
          el.touchDocument([
            {
              type: 'attributes',
              target,
              attributeName: 'style',
              oldValue: was,
            },
          ]);
          what = `${pathOf(target)} styled ${target.attribs.style}`;
        } else if (kind === 5) {
          const scrollers = all.filter((e) =>
            /\bsc\b/.test(e.attribs.class ?? ''),
          );
          if (scrollers.length) {
            el.scrollElementTo(pick(scrollers), {
              y: Math.floor(next() * 40),
            });
          }
          await act();
          // and a layout after it, which is the one held to a whole one: a
          // scroll alone leaves the boxes around what it moved as large as
          // they were (`boundsAfterMove`)
          internals._invalidate(1);
          what = 'a scroll container scrolled, and laid out again';
        } else if (kind === 6) {
          await act(async () => pane.scrollTo(Math.floor(next() * 300)));
          internals._invalidate(1);
          what = 'the pane scrolled, and laid out again';
        } else {
          internals._invalidate(1);
          what = 'laid out again';
        }
        await act();
        const after = new Map(holding());
        for (const [e, serial] of before) {
          if (after.get(e) === serial) stickyKept += 1;
        }
        const kept = treeLines(internals._tree);
        internals._invalidate(2);
        await act();
        const whole = treeLines(internals._tree);
        const at = kept.findIndex((line, i) => line !== whole[i]);
        assert.ok(
          at < 0 && kept.length === whole.length,
          `seed ${seed}, step ${step} (${what}): line ${at}\n` +
            `kept  ${kept[at]}\nwhole ${whole[at]}\n${markup}`,
        );
      }
      result.unmount();
    }
    const kept = blocksKept() - keptAtStart;
    assert.ok(kept > 100, `${kept} blocks kept from an earlier layout`);
    assert.ok(
      stickyKept > 20,
      `${stickyKept} blocks holding a sticky box kept`,
    );
    const ink = inkKept() - inkAtStart;
    assert.ok(ink > 100, `${ink} blocks' ink kept from an earlier layout`);
  },
);

/** The pane a document scrolled in (`renderScrolled`). */
function movingPane(node: unknown): { scrollTo(y: number): void } {
  type Up = { parent: Up | null; props?: { style?: { overflow?: string } } };
  let at = (node as Up).parent;
  while (at && at.props?.style?.overflow !== 'scroll') at = at.parent;
  assert.ok(at, 'a pane');
  return at as unknown as { scrollTo(y: number): void };
}

metric(
  'a transform a hover puts on a box where it is moves the box at every layout after, whether it keeps the box or lays it out again',
  async () => {
    // A relative box with no inset moves nowhere, and the passes after a
    // flow pass it by (`Blockers.moved`); a hover that turns it, restyled
    // in place, has them walk to it from then on (`noteMoving`), or a
    // layout that lays it out again leaves it where the flow put it.
    const { node } = await render(
      '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
        'p { margin: 2px } .card { position: relative; z-index: 1; padding: 4px }' +
        '.card:hover { transform: translate(0px, -5px) }</style></head><body>' +
        '<div><p>above it</p></div>' +
        '<div><div class="card" id="card"><p id="in">a card</p></div>' +
        '<p>beside it</p></div></body></html>',
      320,
    );
    const el = view(node);
    await act();
    const internals = el as unknown as {
      _tree: BoxTree;
      _invalidate(stale: number): void;
    };
    const byId = (id: string): Element =>
      elementsUnder(el.document as unknown as Element).find(
        (e) => e.attribs.id === id,
      )!;
    const card = byId('card');
    const flow = el.elementRect(card)!;
    const tree = internals._tree;
    el.setHover(flow.x + 10, flow.y + flow.height / 2);
    await act();
    assert.strictEqual(internals._tree, tree, 'the hover restyled in place');
    const top = () => el.elementRect(card)!.y;
    assert.strictEqual(top(), flow.y - 5, 'hovered');
    internals._invalidate(1);
    await act();
    assert.strictEqual(top(), flow.y - 5, 'kept by a layout');
    const text = byId('in').children[0] as unknown as { data: string };
    text.data = 'a card still';
    el.touchDocument([{ type: 'characterData', target: text as never }]);
    await act();
    assert.strictEqual(top(), flow.y - 5, 'laid out again');
    const kept = treeLines(internals._tree);
    internals._invalidate(2);
    await act();
    const whole = treeLines(internals._tree);
    const line = kept.findIndex((one, i) => one !== whole[i]);
    assert.ok(
      line < 0 && kept.length === whole.length,
      `line ${line}\nkept  ${kept[line]}\nwhole ${whole[line]}`,
    );
  },
);

metric(
  'a block holding a sticky box the viewport holds is kept by a layout, and its sticky box held where a layout of all new boxes holds it',
  async () => {
    // joshwcomeau.com's code blocks each hold a copy button stuck 88px
    // down the viewport, and every box around one was laid out at every
    // layout of the page: its article's grid, a hundred items, half of
    // them laid out again for nothing
    const { el } = await renderScrolled(
      '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
        'article { display: grid; grid-template-columns: 1fr; gap: 6px }' +
        'p { margin: 0 } .code { height: 300px; background: #eeeeee }' +
        '.copy { display: block; position: sticky; top: 10px; height: 20px;' +
        ' width: 20px; margin-left: auto }</style></head><body><article>' +
        '<p id="first">a paragraph above the code</p>' +
        '<div class="code" id="code"><button class="copy" id="copy"></button>' +
        '<pre>let a = 1;</pre></div>' +
        '<p id="last">a paragraph below it</p></article>' +
        '<div style="height: 600px"></div></body></html>',
      160,
      320,
    );
    const internals = el as unknown as {
      _tree: BoxTree;
      _invalidate(stale: number): void;
      _firstBoxesOf(tree: BoxTree): Map<Element, Box>;
    };
    const byId = (id: string): Element =>
      elementsUnder(el.document as unknown as Element).find(
        (e) => e.attribs.id === id,
      )!;
    const serial = () =>
      internals._firstBoxesOf(internals._tree).get(byId('code'))!.layoutSerial;
    const code = el.elementRect(byId('code'))!;
    await act(async () => movingPane(el).scrollTo(code.y + 100));
    const held = () => el.elementRect(byId('copy'))!.y;
    assert.strictEqual(held(), code.y + 110, 'held 10px down the viewport');
    const before = serial();
    internals._invalidate(1);
    await act();
    assert.strictEqual(serial(), before, 'kept by a bare layout');
    assert.strictEqual(held(), code.y + 110, 'and held');
    // a change below it, and then one above it, which moves it
    for (const id of ['last', 'first']) {
      const was = serial();
      const text = byId(id).children[0] as unknown as { data: string };
      text.data += ', and a line more of words than it had before';
      el.touchDocument([{ type: 'characterData', target: text as never }]);
      await act();
      assert.strictEqual(serial(), was, `kept for a change in #${id}`);
      const moved = el.elementRect(byId('code'))!.y - code.y;
      assert.strictEqual(held(), code.y + 110, `held after #${id} (${moved})`);
      const kept = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      const whole = treeLines(internals._tree);
      const line = kept.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        line < 0 && kept.length === whole.length,
        `#${id}: line ${line}\nkept  ${kept[line]}\nwhole ${whole[line]}`,
      );
    }
  },
);
