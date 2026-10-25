// <Html> — a build of only the subtrees a change reached: the tree it makes,
// the boxes it keeps and the ones it builds, is the tree a build of the
// whole document makes, box for box, list for list, line for line after
// layout — and the layout after it, which keeps the blocks an earlier one
// laid out where nothing they were laid out from changed (`reuseLaid`),
// places them as a layout of all new boxes does (`buildSubtrees`,
// docs/prd-subtree-build.md).
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup } from 'react-x11/test';
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
import type { Box, BoxTree } from '../../src/html/layout/boxes.js';
import { GENERATED_FROM } from '../../src/html/layout/boxes.js';
import { blocksKept } from '../../src/html/layout/block.js';
import { metric, render, view } from './harness.js';

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
        : pick(['ul', 'input', 'button', 'br']);
  const classes = CLASSES.filter(() => next() < 0.12).join(' ');
  const attribs: Record<string, string> = classes ? { class: classes } : {};
  if (tag === 'a') attribs.href = '#x';
  const el = createElement(tag, attribs);
  if (tag === 'ul') {
    appendChild(el, createElement('li', {}, [createText('item')]));
    return el;
  }
  if (tag === 'input' || tag === 'br') return el;
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

/** A change a page's scripts might make, done, and its records. */
function change(next: () => number, body: Element): HtmlChange[] {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const all = [body, ...elementsUnder(body)];
  const inside = all.slice(1);
  const kind = Math.floor(next() * 6);
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
      },
    ];
  }
  if (kind === 1) {
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
      appendChild(into, target as unknown as ChildNode);
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
  }
  const target = pick(all);
  const was = target.attribs.style ?? null;
  target.attribs.style = pick([
    'color: #00aa00',
    'display: none',
    'padding-left: 6px',
    'display: inline',
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
    box.lines?.length ?? '',
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
    `styles: ${[...tree.styles]
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
    assert.ok(subtrees > 80, `${subtrees} changes built only their subtrees`);
    assert.ok(wholes > 10, `${wholes} changes built the whole document`);
    // and the layouts after them kept blocks a layout before laid out
    const kept = blocksKept() - keptAtStart;
    assert.ok(kept > 100, `${kept} blocks kept from an earlier layout`);
  },
);
