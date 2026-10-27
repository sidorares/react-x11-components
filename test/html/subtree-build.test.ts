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
import { blocksKept } from '../../src/html/layout/block.js';
import { shadowRootOf } from '../../src/html/dom.js';
import { FONTS, h, metric, render, view } from './harness.js';
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
