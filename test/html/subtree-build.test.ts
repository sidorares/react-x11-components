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
import * as ntk from 'react-x11/ntk';
import * as DomUtils from 'domutils';
import {
  appendChild,
  createHtmlElement as createElement,
  createText,
  removeNode,
} from '../../src/html/index.js';
import type { ChildNode, Element, HtmlChange } from '../../src/html/index.js';
import type { Box, BoxTree } from '../../src/html/layout/boxes.js';
import { buildsAtEnd } from '../../src/html/layout/boxes.js';
import { blocksKept, standsMade } from '../../src/html/layout/block.js';
import { inkKept } from '../../src/html/paint.js';
import { attachShadow, shadowRootOf } from '../../src/html/dom.js';
import {
  boxOf,
  FONTS,
  h,
  metric,
  pathOf,
  render,
  renderScrolled,
  solidPng,
  treeLines,
  view,
} from './harness.js';
import { resizeClock } from '../../src/html/node.js';
import { imageDecoder } from '../../src/html/resources.js';
import { holdClock } from '../held-clock.js';
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

const CLASSES = 'abcdefghijklmnopqrs'.split('');
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
.l { margin: 10px 0; container-type: inline-size }
@container (min-width: 150px) { .b { color: #123456 } .k::after { content: " q" } }
.m { display: grid; grid-template-columns: 1fr 1fr }
.n::after { content: " +"; color: #0000aa }
.o { position: relative; top: 3px; left: 2px }
.p { transform: translate(5px, 2px) }
.q { overflow: hidden; height: 20px }`;
/** And flows in another writing mode, which a build of subtrees stops at:
 *  a change in one builds the whole document, so a sheet that means to see
 *  subtrees built at every step leaves them out. */
const FRAMED_SHEET = `${SHEET}
.r { writing-mode: vertical-rl; height: 60px }
.s { writing-mode: vertical-lr }`;

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
  // a shadow tree put on an element, as a custom element does as it
  // connects, and what is in one changed
  if (next() < 0.06) {
    const free = inside.filter((e) => e.name === 'div' && !shadowRootOf(e));
    if (free.length) {
      const target = pick(free);
      const root = attachShadow(target, { mode: 'open' }) as unknown as Element;
      appendChild(root, createElement('p', {}, [createText('in ')]));
      if (next() < 0.7) appendChild(root, createElement('slot'));
      return [{ type: 'shadowRoot', target }];
    }
  }
  const hosts = all.filter((e) => shadowRootOf(e));
  if (hosts.length && next() < 0.1) {
    const root = shadowRootOf(pick(hosts)) as unknown as Element;
    const child = createElement('i', {}, [createText('more ')]);
    appendChild(root, child);
    return [
      {
        type: 'childList',
        target: root,
        addedNodes: [child],
        removedNodes: [],
      },
    ];
  }
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
  // and the root element past the body, where a page's script puts what it
  // measures the viewport with: Apple's puts a probe there at every step of
  // a drag, and takes it out
  const root = body.parent as unknown as Element | null;
  const pastBody = root
    ? (root.children
        .slice(root.children.indexOf(body) + 1)
        .filter((n) => (n as Element).attribs) as Element[])
    : [];
  if (kind === 0 || !inside.length) {
    const atRoot = !!root && next() < 0.15;
    const parent = atRoot ? root : pick(all);
    const child = element(next, 2);
    const kids = parent.children.filter((n) => (n as Element).attribs);
    if (!atRoot && kids.length && next() < 0.5) {
      DomUtils.prepend(pick(kids), child);
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
  if (kind === 1) {
    const target =
      pastBody.length && next() < 0.3 ? pick(pastBody) : pick(inside);
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
metric(
  'a build of the subtrees a change reached makes the tree a build of the whole document makes',
  async () => {
    let subtrees = 0;
    let wholes = 0;
    let widened = 0;
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
        `<!doctype html><html><head><style>${seed % 3 ? SHEET : FRAMED_SHEET}</style></head>${markup}</html>`,
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
      const subtreeRoots = internals._subtreeRoots;
      let tries = 0;
      internals._subtreeRoots = function (this: unknown, ...a: unknown[]) {
        tries += 1;
        return subtreeRoots.apply(this, a);
      };
      for (let step = 0; step < 10; step += 1) {
        const changes = change(next, bodyEl);
        let built: unknown = undefined;
        internals._subtreeBuild = function (this: unknown, ...a: unknown[]) {
          tries = 0;
          built = subtreeBuild.apply(this, a);
          // a root that came out as no block in the flow, built again
          // from the root around it (`wider`)
          if (built && tries > 1) widened += 1;
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
    assert.ok(widened > 5, `${widened} built from a root around one refused`);
    assert.ok(wholes > 10, `${wholes} changes built the whole document`);
    assert.ok(shadowed > 5, `${shadowed} documents with a shadow tree`);
    // and the layouts after them kept blocks a layout before laid out
    const kept = blocksKept() - keptAtStart;
    assert.ok(kept > 100, `${kept} blocks kept from an earlier layout`);
  },
);

/** Images a document's rules name, which its boxes are built without
 *  until they are in: generated content and a list's marker. No containers:
 *  a restyle in place that is the first to read one answers with no size
 *  until the next layout, which is nothing an image does. */
const IMAGE_SHEET = `${SHEET}
.l { container-type: normal }
.r::before { content: url(before.png) }
.s::after { content: url(after.png) }
.t { display: list-item; list-style-image: url(marker.png) }`;

/** An image of each kind of thing a late one is to its document: sized by
 *  nothing else, sized by its attributes, chosen from a set, and what comes
 *  out another kind of box with it. */
function imageOf(next: () => number, url: string): Element {
  switch (Math.floor(next() * 8)) {
    case 0:
      return createElement('img', { src: url, width: '30', height: '12' });
    case 1:
      return createElement('img', { srcset: `${url} 2x` });
    case 2:
      return createElement(
        'object',
        { data: next() < 0.3 ? url.replace('.png', '.html') : url },
        [createText('in its place')],
      );
    case 3:
      return createElement('embed', {
        src: next() < 0.3 ? url.replace('.png', '.html') : url,
      });
    case 4:
      return createElement('video', { poster: url });
    case 5:
      return createElement('input', { type: 'image', src: url, alt: 'go' });
    default:
      return createElement('img', { src: url });
  }
}

/** Every image a fuzz's host holds back, to land when the test says: a
 *  request answered, which says its size, then its pixels decoded. */
function holdImages(
  t: { mock: { method: typeof import('node:test').mock.method } },
  next: () => number,
  images: ReadonlyMap<string, Uint8Array>,
): {
  onResource(r: { url: string; kind: string }): unknown;
  /** Whether anything is still to land. */
  held(): boolean;
  /** The next to land, at random. */
  land(): void;
  /** The decoder as it was. */
  done(): void;
} {
  const answers = new Map<string, () => void>();
  const decodes: Array<() => void> = [];
  const decoder = t.mock.method(
    imageDecoder,
    'decode',
    (bytes: Uint8Array) =>
      new Promise<never>((resolve) => {
        decodes.push(() => resolve(ntk.decodeImageBytes(bytes) as never));
      }),
  );
  return {
    done: () => decoder.mock.restore(),
    onResource: (r) => {
      if (r.kind !== 'image') return null;
      const bytes = images.get(r.url);
      if (!bytes && !r.url.endsWith('.html')) return null;
      return new Promise((resolve) => {
        answers.set(r.url, () =>
          resolve(bytes ? { kind: 'image', bytes } : { kind: 'document' }),
        );
      });
    },
    held: () => answers.size > 0 || decodes.length > 0,
    land: () => {
      if (decodes.length && (!answers.size || next() < 0.5)) {
        const at = Math.floor(next() * decodes.length);
        decodes.splice(at, 1)[0]();
      } else if (answers.size) {
        const urls = [...answers.keys()];
        const url = urls[Math.floor(next() * urls.length)];
        const go = answers.get(url)!;
        answers.delete(url);
        go();
      }
    },
  };
}

metric(
  'images that arrive make the tree a build of the whole document makes, a change owed or none',
  async (t) => {
    // An image is news to the boxes it sizes, and to those of what comes
    // out another kind with it (`_imageArrived`, `_arrivedKinds`), whether
    // or not a change has a build of some subtrees owed: those subtrees read
    // each size as they are built, and every other box takes its own in
    // place, or is built for it. Held to a build and a layout of the whole
    // document after each step.
    let owed = 0;
    let kinds = 0;
    let subtrees = 0;
    let landed = 0;
    let moved = 0;
    const keptAtStart = blocksKept();
    // IMAGE_SEEDS sweeps more of them, and IMAGE_FROM starts at one
    const env =
      (globalThis as { process?: { env?: Record<string, string> } }).process
        ?.env ?? {};
    const seeds = Number(env.IMAGE_SEEDS ?? 40);
    for (let seed = Number(env.IMAGE_FROM ?? 1); seed <= seeds; seed += 1) {
      const next = random(seed * 15485863);
      const pick = <T>(list: readonly T[]): T =>
        list[Math.floor(next() * list.length)];
      const body = createElement('body', {});
      const blocks = 3 + Math.floor(next() * 4);
      for (let i = 0; i < blocks; i += 1) appendChild(body, element(next, 0));
      const images = new Map<string, Uint8Array>();
      const png = (url: string) =>
        images.set(
          url,
          solidPng(
            ...pick<[number, number]>([
              [20, 10],
              [40, 20],
              [8, 30],
            ]),
            [255, 0, 0],
          ),
        );
      for (const url of ['before.png', 'after.png', 'marker.png']) png(url);
      const holders = [body, ...elementsUnder(body)].filter(
        (e) => !['input', 'br', 'ul', 'ol', 'template'].includes(e.name),
      );
      for (const holder of holders) {
        if (holder !== body && next() < 0.12) {
          holder.attribs.class =
            `${holder.attribs.class ?? ''} ${pick(['r', 's', 't'])}`.trim();
        }
      }
      const count = 3 + Math.floor(next() * 6);
      for (let i = 0; i < count; i += 1) {
        // now and then an image two elements show
        const url = `${i && next() < 0.2 ? i - 1 : i}.png`;
        png(url);
        appendChild(pick(holders), imageOf(next, url));
      }
      const markup = DomUtils.getOuterHTML(body as never);
      const held = holdImages(t, next, images);
      const { result, node } = await render(
        `<!doctype html><html><head><style>${IMAGE_SHEET}</style></head>${markup}</html>`,
        320,
        { onResource: held.onResource },
      );
      const el = view(node);
      await act();
      const internals = el as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      > & {
        _tree: BoxTree;
        _stale: number;
        _buildSeeds: ReadonlySet<Element> | null;
      };
      const bodyEl = elementsUnder(el.document as unknown as Element).find(
        (e) => e.name === 'body',
      )!;
      const arrived = internals._imageArrived;
      internals._imageArrived = function (this: unknown, ...a: unknown[]) {
        landed += 1;
        if (internals._stale >= 2 && internals._buildSeeds) owed += 1;
        return arrived.apply(this, a);
      };
      const arrivedKinds = internals._arrivedKinds;
      internals._arrivedKinds = function (this: unknown, ...a: unknown[]) {
        const found = arrivedKinds.apply(this, a);
        if (found) kinds += 1;
        return found;
      };
      const subtreeBuild = internals._subtreeBuild;
      for (let step = 0; step < 18; step += 1) {
        if (!held.held() && step > 6) break;
        const changed = next() < 0.6;
        if (changed) el.touchDocument(change(next, bodyEl));
        // and what lands, before the frame that builds what it reached
        const count = 1 + Math.floor(next() * 3);
        for (let i = 0; i < count; i += 1) {
          held.land();
          for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
        }
        let built: unknown = undefined;
        internals._subtreeBuild = function (this: unknown, ...a: unknown[]) {
          built = subtreeBuild.apply(this, a);
          return built;
        };
        const before = internals._tree;
        await act();
        delete internals._subtreeBuild;
        if (built) subtrees += 1;
        if (internals._tree === before) moved += 1;
        const kept = treeLines(internals._tree);
        // the whole document built again and laid out
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
        assert.deepStrictEqual(
          textBoxesAstray(internals._tree),
          [],
          `seed ${seed}, step ${step}: the text where its boxes say`,
        );
      }
      result.unmount();
      held.done();
    }
    assert.ok(landed > 200, `${landed} images landed`);
    assert.ok(owed > 40, `${owed} with a build of subtrees owed`);
    assert.ok(kinds > 20, `${kinds} made something's boxes otherwise`);
    assert.ok(subtrees > 40, `${subtrees} built only their subtrees`);
    assert.ok(moved > 20, `${moved} kept every box`);
    const kept = blocksKept() - keptAtStart;
    assert.ok(kept > 100, `${kept} blocks kept from an earlier layout`);
  },
);

/** A document whose images land when the test says, one URL at a time, in
 *  the microtasks of the turn that says so: before any frame. */
async function withHeldImages(source: string) {
  const answers = new Map<string, () => void>();
  const bytes = solidPng(40, 20, [255, 0, 0]);
  const { node } = await render(
    `<!doctype html><html><head><style>body { margin: 0 }</style></head><body>${source}</body></html>`,
    320,
    {
      onResource: (r: { url: string; kind: string }) =>
        r.kind === 'image'
          ? new Promise((resolve) => {
              answers.set(r.url, () => resolve({ kind: 'image', bytes }));
            })
          : null,
    },
  );
  const el = view(node);
  await act();
  return {
    el,
    internals: el as unknown as {
      _subtreeBuild(...a: unknown[]): unknown;
      _tree: BoxTree;
      _buildSeeds: ReadonlySet<Element> | null;
    },
    of: (id: string): Element =>
      elementsUnder(el.document as unknown as Element).find(
        (e) => e.attribs.id === id,
      )!,
    land: async (url: string) => {
      answers.get(url)!();
      answers.delete(url);
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    },
  };
}

metric(
  'an image that lands while a build of subtrees is owed leaves it one',
  async (t) => {
    // An image landing between a page's change and the frame that builds it
    // made that build the whole document's: an arrival that had nothing to do
    // with the change took away what the change had said it reached, 120 to
    // 420 ms a time on the Guardian and BBC. An image can land on any turn of
    // a page still loading, so most of a page's cheap builds were lost so.
    const doc = await withHeldImages(
      '<p id="still">still</p><p><img id="late" src="i.png"></p><p id="under">under</p><div id="moved">one</div>',
    );
    const built = t.mock.method(doc.internals, '_subtreeBuild');
    const still = boxOf(doc.el, 'still');
    const late = boxOf(doc.el, 'late');
    const under = boxOf(doc.el, 'under').y;
    doc.of('moved').attribs.hidden = '';
    doc.el.touchDocument([
      { type: 'attributes', target: doc.of('moved'), attributeName: 'hidden' },
    ] as HtmlChange[]);
    assert.ok(doc.internals._buildSeeds, 'a build of what the change reached');
    await doc.land('i.png');
    assert.ok(doc.internals._buildSeeds, 'which the image leaves as it was');
    await act();
    assert.strictEqual(built.mock.callCount(), 1, 'its subtrees');
    assert.ok(built.mock.calls[0].result, 'built apart');
    assert.ok(boxOf(doc.el, 'still') === still, 'and no other box');
    // and the box a change never reached has what arrived all the same
    assert.ok(boxOf(doc.el, 'late') === late, 'its box kept');
    assert.strictEqual(
      (late as unknown as Box).intrinsic?.width,
      40,
      'the size it took in place',
    );
    assert.notStrictEqual(
      boxOf(doc.el, 'under').y,
      under,
      'and what follows it',
    );
  },
);

metric(
  'what comes out another box with its image is built, and nothing else',
  async (t) => {
    // an `<object>` is its content until its image is in, and generated
    // content and a marker are built without it: each with what holds it,
    // where each built the whole document
    for (const [late, url] of [
      ['<object id="late" data="i.png">in its place</object>', 'i.png'],
      ['<embed id="late" src="i.png">', 'i.png'],
      ['<input id="late" type="image" src="i.png" alt="go">', 'i.png'],
      ['<span id="late" class="g"></span>', 'g.png'],
      ['<ul><li id="late" class="m">item</li></ul>', 'm.png'],
    ] as const) {
      const doc = await withHeldImages(
        '<style>.g::before { content: url(g.png) } .m { list-style-image: url(m.png) }</style>' +
          `<p id="still">still</p><div>${late}</div>`,
      );
      const built = t.mock.method(doc.internals, '_subtreeBuild');
      const still = boxOf(doc.el, 'still');
      await doc.land(url);
      await act();
      assert.strictEqual(built.mock.callCount(), 1, `its subtree: ${late}`);
      assert.ok(built.mock.calls[0].result, `built apart: ${late}`);
      assert.ok(boxOf(doc.el, 'still') === still, `no other box: ${late}`);
      const kept = doc.internals._tree;
      assert.ok(
        kept.contentImages.every((c) => c.sized),
        `none left to come: ${late}`,
      );
      built.mock.restore();
      cleanup();
    }
  },
);

metric('what a document came to is no news at the next image', async (t) => {
  // an `<object>` that holds a document is its frame for good, and it was
  // listed as waiting all the same: every image after it built the whole
  // document, and would have built the frame's subtree
  const answers = new Map<string, () => void>();
  const { node } = await render(
    '<!doctype html><p id="still">still</p><div><object id="doc" data="d.html">in its place</object></div><p><img src="i.png"></p>',
    320,
    {
      onResource: (r: { url: string; kind: string }) =>
        r.kind === 'image'
          ? new Promise((resolve) => {
              answers.set(r.url, () =>
                resolve(
                  r.url === 'd.html'
                    ? { kind: 'document' }
                    : {
                        kind: 'image',
                        bytes: solidPng(40, 20, [255, 0, 0]),
                      },
                ),
              );
            })
          : null,
    },
  );
  const el = view(node);
  await act();
  const internals = el as unknown as {
    _tree: BoxTree;
    _subtreeBuild(...a: unknown[]): unknown;
  };
  answers.get('d.html')!();
  await act();
  assert.deepStrictEqual(
    internals._tree.awaitingKind,
    [],
    'nothing left to come',
  );
  const built = t.mock.method(internals, '_subtreeBuild');
  answers.get('i.png')!();
  await act();
  assert.strictEqual(built.mock.callCount(), 0, 'no box of it built again');
});

metric(
  "a tail built again leaves one entry for its holder's `::after`",
  async (t) => {
    // A tail builds its holder's `::after` again, and the list goes by the
    // element it stands for, which stays. Left in, an entry with no size
    // said an image had come at every arrival after it, and built the holder
    // again each time.
    const doc = await withHeldImages(
      '<style>.s::after { content: url(g.png) }</style>' +
        '<p>before</p><div id="holder" class="s"><p>first</p><p id="gone">gone</p><p>kept</p></div><p>after</p>',
    );
    const holder = doc.of('holder');
    const gone = doc.of('gone');
    const roots = t.mock.method(
      doc.internals as unknown as { _subtreeRoots(...a: unknown[]): unknown },
      '_subtreeRoots',
    );
    const previousSibling = gone.prev;
    const nextSibling = gone.next;
    removeNode(gone);
    doc.el.touchDocument([
      {
        type: 'childList',
        target: holder,
        addedNodes: [],
        removedNodes: [gone],
        previousSibling,
        nextSibling,
      },
    ] as unknown as HtmlChange[]);
    await act();
    const found = roots.mock.calls[0]?.result as {
      tails: readonly unknown[];
    } | null;
    assert.strictEqual(found?.tails.length, 1, 'a tail of the holder');
    const images = doc.internals._tree.contentImages;
    assert.strictEqual(images.length, 1, 'the one it has');
  },
);

metric(
  'a tail that builds a shadow host leaves nothing of its tree waiting',
  async (t) => {
    // What a tail holds is reached through a host, or an element in the
    // tree stays listed beside the one the build lists: an image button in
    // a card's shadow tree, once its image came, was news at every arrival.
    const doc = await withHeldImages(
      '<div id="holder"><p>first</p><p id="gone">gone</p>' +
        '<section><template shadowrootmode="open">' +
        '<input id="button" type="image" src="i.png" alt="go">' +
        '</template>light</section></div>',
    );
    const holder = doc.of('holder');
    const gone = doc.of('gone');
    const roots = t.mock.method(
      doc.internals as unknown as { _subtreeRoots(...a: unknown[]): unknown },
      '_subtreeRoots',
    );
    const previousSibling = gone.prev;
    const nextSibling = gone.next;
    removeNode(gone);
    doc.el.touchDocument([
      {
        type: 'childList',
        target: holder,
        addedNodes: [],
        removedNodes: [gone],
        previousSibling,
        nextSibling,
      },
    ] as unknown as HtmlChange[]);
    await act();
    const found = roots.mock.calls[0]?.result as {
      tails: readonly unknown[];
    } | null;
    assert.strictEqual(found?.tails.length, 1, 'a tail of the holder');
    assert.strictEqual(
      doc.internals._tree.awaitingKind.length,
      1,
      'the one button',
    );
  },
);

/** The text boxes the document's text says otherwise of: a build of
 *  subtrees cuts the text where its boxes say, so a build of the whole
 *  document that puts them one out is one a comparison of the two cannot
 *  see, and every later splice comes out as garbage. */
function textBoxesAstray(tree: BoxTree): string[] {
  return tree.textBoxes
    .filter(
      (box) =>
        box.text && tree.text.slice(box.textStart, box.textEnd) !== box.text,
    )
    .map((box) => `${JSON.stringify(box.text)}@${box.textStart}`);
}

metric(
  'a space taken back past what a float holds leaves the text where its boxes say',
  async () => {
    // The float's own line ends on a space of its own, which empties the
    // chunk that space was, and leaving the float puts back the space
    // before it. The next line's end took that one back from the empty
    // chunk: nothing came off the text, and every place after it was one
    // out, in a plain build of the whole document.
    for (const inFloat of [
      '<input>',
      '<img src="x.png">',
      '<span style="display: inline-block; width: 9px"></span>',
    ]) {
      for (const out of ['float: left', 'position: absolute']) {
        const { result, node } = await render(
          `<!doctype html><p>keep</p><div>a <div style="${out}">${inFloat} </div><div>b</div></div><p>after</p>`,
          320,
        );
        await act();
        const tree = (view(node) as unknown as { _tree: BoxTree })._tree;
        assert.deepStrictEqual(textBoxesAstray(tree), [], inFloat);
        assert.strictEqual(tree.text, 'keepabafter', `${inFloat} ${out}`);
        result.unmount();
      }
    }
  },
);

/** What a long page holds besides: lengths in `vw`, which a drag's steps
 *  restyle, in place or by a build, over what the drag set aside, and
 *  breakpoints the drag crosses, which turn on what lays a box out
 *  otherwise and what draws one or none. */
const DRAG_SHEET = `${SHEET}
.v { margin-left: 3vw; padding-right: 1vw }
.w { font-size: calc(10px + 1vw) }
.x::before { content: ""; display: block; width: 50vw; height: 2px }
.y { width: 40vw; transform: translateX(2vw) }
.y::after { content: "~"; position: absolute; width: 10vw; transform: translateX(1vw) }
@media (max-width: 355px) {
  .a { flex-direction: column }
  .h { padding: 8px }
  .c { width: 20vw }
  .b { display: block }
}
@media (min-width: 362px) {
  .l { margin: 4px 0 }
  .g { display: block }
  .k { position: absolute; left: 2vw }
}`;

metric(
  'a page that writes while a window edge is dragged comes to rest as a build of the whole document makes it',
  async (t) => {
    // A drag lays out down to a viewport past what can be seen at each
    // step, and sets the rest aside (`_stopAt`). A page's resize handlers
    // write at every step, and a layout at the width the step is at stops
    // where the step's did; a build of the subtrees a write reached puts
    // back what was set aside to splice them in (`_subtreeBuild`), and what
    // a restyle in place left owed is built at rest (`_asideOwed`). What a
    // step restyles itself — a breakpoint's rules, a `vw` — builds its own
    // subtrees (`seedWith`). Held to a restyle, build and layout of the
    // whole document once it rests.
    const clock = holdClock(t, resizeClock);
    const env =
      (globalThis as { process?: { env?: Record<string, string> } }).process
        ?.env ?? {};
    let again = 0;
    let apart = 0;
    let stepApart = 0;
    let stepped = 0;
    const seeds = Number(env.DRAG_SEEDS ?? 24);
    for (let seed = Number(env.DRAG_FROM ?? 1); seed <= seeds; seed += 1) {
      const next = random(seed * 15485863);
      const pick = <T>(list: readonly T[]): T =>
        list[Math.floor(next() * list.length)];
      const body = createElement('body', {});
      const blocks = 18 + Math.floor(next() * 8);
      for (let i = 0; i < blocks; i += 1) {
        const block = element(next, 0);
        if (next() < 0.3) {
          const was = block.attribs.class ? `${block.attribs.class} ` : '';
          block.attribs.class = was + pick(['v', 'w', 'x', 'y']);
        }
        // in a section of its own, as a page's parts are: an inline box
        // the body holds is in no element a build can make apart
        appendChild(body, createElement('section', {}, [block]));
        appendChild(
          body,
          createElement('div', { style: 'height: 40px' }, [createText('·')]),
        );
      }
      const markup = DomUtils.getOuterHTML(body as never);
      const { el, resize, result } = await renderScrolled(
        `<!doctype html><html><head><style>${DRAG_SHEET}</style></head>${markup}</html>`,
        160,
        400,
      );
      const internals = el as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      > & {
        _tree: BoxTree;
        _partial: boolean;
        _widthLaid: number;
        _cascade: { viewportWidth: number };
        _invalidate(stale: number): void;
      };
      const stopAt = internals._stopAt;
      internals._stopAt = function (this: typeof internals, ...a: unknown[]) {
        const stop = stopAt.apply(this, a);
        if (stop && this._widthLaid === a[0]) again += 1;
        return stop;
      };
      const subtreeBuild = internals._subtreeBuild;
      internals._subtreeBuild = function (
        this: typeof internals,
        ...a: unknown[]
      ) {
        const partial = this._partial;
        const built = subtreeBuild.apply(this, a);
        if (built && partial) apart += 1;
        // at a step's width, for what a breakpoint or a `vw` restyled
        if (built && this._cascade.viewportWidth !== this._widthLaid) {
          stepApart += 1;
        }
        return built;
      };
      const bodyEl = elementsUnder(el.document as unknown as Element).find(
        (e) => e.name === 'body',
      )!;
      await act(async () => movingPane(el).scrollTo(Math.floor(next() * 400)));
      // a jump, laid out whole, then a drag of small steps
      let width = 360;
      await resize(160, width);
      const log: string[] = [];
      for (let step = 0; step < 12; step += 1) {
        width += pick([-14, -8, -4, 6, 10]);
        await resize(160, width);
        if (internals._partial) stepped += 1;
        log.push(`width ${width}`);
        // what the page's handlers write at that step, read back at once
        const writes = Math.floor(next() * 3);
        for (let i = 0; i < writes; i += 1) {
          const changes = change(next, bodyEl);
          log.push(changes.map((c) => c.type).join('+'));
          el.touchDocument(changes);
          await act();
        }
      }
      await clock.finish();
      assert.ok(!internals._partial, `seed ${seed}: rested`);
      const rested = treeLines(internals._tree);
      // the whole document styled, built and laid out again at that width
      internals._invalidate(3);
      await act();
      const whole = treeLines(internals._tree);
      const at = rested.findIndex((line, i) => line !== whole[i]);
      assert.ok(
        at < 0 && rested.length === whole.length,
        `seed ${seed}: line ${at}\nrested ${rested[at]}\nwhole  ${whole[at]}\n` +
          `${log.join(', ')}\n${markup}`,
      );
      result.unmount();
    }
    assert.ok(stepped > 100, `${stepped} steps stopped`);
    assert.ok(again > 30, `${again} layouts at a step's width stopped`);
    assert.ok(apart > 20, `${apart} subtrees built during a drag`);
    assert.ok(stepApart > 20, `${stepApart} subtrees built at a step's width`);
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
  'a parse that waits at a script goes on after it as a stream does: what it reads on to is styled and built, and the rest kept, as a build of the whole makes it',
  async (t) => {
    // Apple's product pages wait at six scripts in their `<body>`, and the
    // parse going on after each styled all of the page again
    const paragraphs = (from: number) =>
      Array.from(
        { length: 40 },
        (_, i) => `<p id="p${from + i}">Paragraph ${from + i}</p>`,
      ).join('');
    const held: Element[] = [];
    const { node } = await render(
      '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
        ' p { margin: 2px } p:last-child { color: #aa0000 }' +
        ' .x + p { font-weight: bold }</style></head><body>' +
        `<main>${paragraphs(0)}</main><script id="s1"></script>` +
        `<div class="x">x</div>${paragraphs(40)}<script id="s2"></script>` +
        `<section>${paragraphs(80)}</section><script id="s3"></script>` +
        `<footer>${paragraphs(120)}</footer></body></html>`,
      320,
      { scripting: true, _onParserBlocked: (s: Element) => held.push(s) },
    );
    const el = view(node);
    await act();
    const internals = el as unknown as {
      _tree: BoxTree;
      _restyle(...a: unknown[]): void;
      _invalidate(stale: number): void;
      parserResume(script: Element): void;
    };
    for (const id of ['s1', 's2', 's3']) {
      const script = held.at(-1)!;
      assert.strictEqual(script?.attribs.id, id, `the parse waits at #${id}`);
      const restyled = t.mock.method(internals, '_restyle');
      internals.parserResume(script);
      el.layoutNow();
      assert.strictEqual(
        restyled.mock.callCount(),
        0,
        `after #${id} every element was styled again`,
      );
      restyled.mock.restore();
      await act();
      const kept = treeLines(internals._tree);
      internals._invalidate(3);
      el.layoutNow();
      const whole = treeLines(internals._tree);
      const line = kept.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        line < 0 && kept.length === whole.length,
        `after #${id}: line ${line}\nkept  ${kept[line]}\nwhole ${whole[line]}`,
      );
    }
  },
);

metric(
  'what counts as it did leaves what reads a counter after it to a build of its own subtree, and what counts otherwise builds the whole',
  async (t) => {
    // Wikipedia's articles number their references, and a change to a
    // section with a list in it built all 18,000 elements for what the
    // list could have done to them
    const { node } = await render(
      '<!doctype html><html><head><style>body { margin: 0;' +
        ' counter-reset: fig } .tick { counter-increment: fig }' +
        ' .read::before { content: "Fig. " counter(fig) " " }' +
        ' p { margin: 2px }</style></head><body>' +
        '<p id="t" class="tick">one</p><p class="read">two</p></body></html>',
      320,
    );
    const el = view(node);
    await act();
    const internals = el as unknown as {
      _tree: BoxTree;
      _subtreeBuild(...a: unknown[]): BoxTree | null;
      _invalidate(stale: number): void;
    };
    const p = elementsUnder(el.document as unknown as Element).find(
      (e) => e.attribs.id === 't',
    )!;
    const compare = async (apart: boolean, what: string): Promise<void> => {
      const result = built.mock.calls.at(-1)?.result;
      assert.strictEqual(!!result, apart, what);
      const kept = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      assert.deepStrictEqual(kept, treeLines(internals._tree), what);
    };
    const built = t.mock.method(internals, '_subtreeBuild');
    const text = p.children[0];
    (text as unknown as { data: string }).data = 'one more';
    el.touchDocument([{ type: 'characterData', target: text }]);
    await act();
    await compare(true, 'a text in what counts');
    p.attribs.class = '';
    el.touchDocument([
      {
        type: 'attributes',
        target: p,
        attributeName: 'class',
        oldValue: 'tick',
      },
    ]);
    await act();
    await compare(false, 'what counts no more');
    built.mock.restore();
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
.v { writing-mode: vertical-rl; height: 60px }
p { margin: 4px 0 }`;

const MOVING_CLASSES = ['st', 'sb', 'r', 'z', 't', 'sc', 'sh', 'fx', 'gr', 'v'];

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
  'a change beside a flow in another writing mode builds what it reached, keeps the blocks around it, and moves the frame as a whole build places it',
  async () => {
    // an MDN article's live sample in a vertical writing mode made every
    // build of the page whole, and CodeMirror's six updates of a cursor's
    // layer held one task for a second and a half
    const paragraphs: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      paragraphs.push(`<p id="p${i}">a paragraph of the page</p>`);
    }
    const { el } = await renderScrolled(
      '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
        'p { margin: 2px 0 } .v { height: 80px }</style></head><body>' +
        '<p id="above">above</p>' +
        '<div class="v" id="rl" style="writing-mode: vertical-rl">' +
        '<p id="in">in the flow</p></div>' +
        '<div class="v" id="lr" style="writing-mode: vertical-lr">' +
        '<p>in another</p></div>' +
        `${paragraphs.join('')}</body></html>`,
      240,
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
    const box = (id: string) =>
      internals._firstBoxesOf(internals._tree).get(byId(id))!;
    assert.ok(internals._tree.vertical, 'a flow in another writing mode');
    const write = async (id: string): Promise<void> => {
      const text = byId(id).children[0] as unknown as { data: string };
      text.data += ', and a line more of words than it had before it';
      el.touchDocument([{ type: 'characterData', target: text as never }]);
      await act();
    };
    const asWhole = async (what: string): Promise<void> => {
      const kept = treeLines(internals._tree);
      internals._invalidate(2);
      await act();
      const whole = treeLines(internals._tree);
      const line = kept.findIndex((one, i) => one !== whole[i]);
      assert.ok(
        line < 0 && kept.length === whole.length,
        `${what}: line ${line}\nkept  ${kept[line]}\nwhole ${whole[line]}`,
      );
    };
    // beside it, after it: built apart, and what is around it kept
    const far = box('p30');
    const serial = far.layoutSerial;
    await write('p3');
    assert.strictEqual(box('p30'), far, 'a box it did not reach is the same');
    assert.strictEqual(far.layoutSerial, serial, 'and was not laid out');
    await asWhole('beside the frames');
    // before it, which moves it down the page and all after it
    const moved = box('p30');
    const was = moved.layoutSerial;
    await write('above');
    assert.strictEqual(box('p30'), moved, 'kept below what moved');
    assert.strictEqual(moved.layoutSerial, was, 'and moved whole');
    await asWhole('above the frames');
    // and in it, which only a build of the whole can make
    await write('in');
    await asWhole('in a frame');
  },
);

metric(
  'a frame fit to the viewport follows its height, wherever an absolute box beside it stops what it marks',
  async () => {
    const words = 'one two three four five six seven eight nine '.repeat(8);
    const sections = '<section><p>a section</p></section>'.repeat(12);
    const follows = async (flow: string, what: string) => {
      const { el, resize, result } = await renderScrolled(
        '<!doctype html><html><head><style>body { margin: 0; font-size: 14px }' +
          '.v { writing-mode: vertical-rl } .pos { position: relative }' +
          '.ab { position: absolute; top: 2px; right: 3px; width: 12px;' +
          ' height: 6px }</style></head><body><main>' +
          `<section id="a"><p>before</p></section>${flow}${sections}` +
          '</main></body></html>',
        200,
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
      const frame = () =>
        internals._firstBoxesOf(internals._tree).get(byId('v'))!;
      const serial = frame().layoutSerial;
      const target = byId('a');
      const child = createElement('p', {}, [createText('more')]);
      appendChild(target, child);
      el.touchDocument([
        {
          type: 'childList',
          target,
          addedNodes: [child],
          removedNodes: [],
          previousSibling: target.children[0],
          nextSibling: null,
        } as HtmlChange,
      ]);
      await act();
      assert.notStrictEqual(frame().layoutSerial, serial, `${what}: laid out`);
      await resize(120);
      const after = frame().height;
      internals._invalidate(2);
      await act();
      assert.strictEqual(after, frame().height, what);
      result.unmount();
    };
    await follows(`<aside id="v" class="v">${words}</aside>`, 'plain');
    await follows(
      `<section class="pos"><div><aside id="v" class="v">${words}</aside>` +
        '<i class="ab"></i></div></section>',
      'between an absolute box and what it is placed against',
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
