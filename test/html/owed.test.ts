// <Html> — what can wait: a change nobody can see the want of waits until it
// is scrolled near, the thread is idle or a read needs it (`_owe`). A face
// that arrives is the first to: the text in view is set in it at the next
// frame, what is off screen stays drawn as it was and is set again a slice
// at a time, and once that has run the document is the one a whole build
// makes, box for box and line for line. A read of the page's answers as
// though none of it had waited.
import { afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { act, cleanup, renderX11, screen, userEvent } from 'react-x11/test';
import { XK_RIGHT } from 'react-x11/keysyms';
import type { DrawnNode } from 'react-x11';
import {
  appendChild,
  createHtmlElement as createElement,
  createText,
  removeNode,
} from '../../src/html/index.js';
import type { Element, HtmlChange } from '../../src/html/index.js';
import type { Box, BoxTree } from '../../src/html/layout/boxes.js';
import * as DomUtils from 'domutils';
import { boxLayoutsMade } from '../../src/html/layout/block.js';
import { frameClock, owedClock, resizeClock } from '../../src/html/node.js';
import type { HtmlViewNode } from '../../src/html/index.js';
import type { ResourceResult } from '../../src/html/resources.js';
import { holdClock } from '../held-clock.js';
import {
  FONTS,
  h,
  metric,
  renderScrolled,
  solidPng,
  treeLines,
  view,
} from './harness.js';
import { Html, useHtmlHandle } from '../../src/html/index.js';

afterEach(cleanup);

/** The element's own, as a test drives them. */
interface Owing {
  _tree: BoxTree;
  _owed: Map<Box, unknown>;
  _inputAt: number;
  _owedChunk: number;
  _owedSlices: number;
  _owedSlice(): void;
  _takeFaces(): void;
  _invalidate(stale: number): void;
  _measuredAt: number;
  _owedTop: number;
  _partial: boolean;
  _scrollBox(box: Box, x: number, y: number): unknown;
  _firstBoxesOf(tree: BoxTree): Map<Element, Box>;
}

const owing = (el: HtmlViewNode): Owing => el as unknown as Owing;

/** How wide the fuzz's image of a name is, and three pixels less than tall. */
const imageSize = (name: string): number => 6 + (name.length % 5) * 7;

/** Two faces of one family, unlike each other and the fallback, and each
 *  held until the test lets it come. */
function heldFaces() {
  const files: Record<string, Uint8Array> = {
    'regular.ttf': new Uint8Array(readFileSync(FONTS!.monospace)),
    'bold.ttf': new Uint8Array(readFileSync(FONTS!['sans-serif'])),
  };
  const waiting = new Map<string, () => void>();
  return {
    onResource(request: { url: string; kind: string }) {
      const name = request.url.slice(request.url.lastIndexOf('/') + 1);
      if (request.kind === 'image') {
        const size = imageSize(name);
        const bytes = solidPng(size, size + 3, [90, 40, 200]);
        return new Promise<ResourceResult | null>((resolve) => {
          waiting.set(name, () => resolve({ kind: 'image', bytes }));
        });
      }
      if (request.kind !== 'font') return null;
      const bytes = files[name];
      if (!bytes) return null;
      return new Promise<ResourceResult | null>((resolve) => {
        waiting.set(name, () => resolve({ kind: 'font', bytes }));
      });
    },
    get held(): string[] {
      return [...waiting.keys()];
    },
    /** Let them all come at once, with no frame between. */
    settleAll(): void {
      for (const come of waiting.values()) come();
      waiting.clear();
    },
    /** Let one come, and the frame it asks for run. */
    async arrive(name: string): Promise<void> {
      waiting.get(name)!();
      waiting.delete(name);
      await act();
      await act();
    },
  };
}

const FACES = `@font-face { font-family: Web; src: url(regular.ttf) }
@font-face { font-family: Web; font-weight: 700; src: url(bold.ttf) }
body { margin: 0; font: 14px Web, sans-serif }`;

/** A page of paragraphs, tall enough to have most of it off screen. */
function page(paragraphs: number): string {
  const body: string[] = [];
  for (let i = 0; i < paragraphs; i += 1) {
    body.push(`<p id="p${i}">paragraph ${i} of a page set in a web font</p>`);
  }
  return `<!doctype html><html><head><style>${FACES}
    p { margin: 4px 0 } b { font-weight: 700 }</style></head>
    <body>${body.join('')}</body></html>`;
}

/** Run all that is owed, as the idle thread would. */
async function runOwed(el: HtmlViewNode): Promise<number> {
  const inner = owing(el);
  let slices = 0;
  while (inner._owed.size) {
    inner._inputAt = -Infinity;
    inner._owedSlice();
    slices += 1;
    await act();
  }
  await act();
  return slices;
}

function byId(el: HtmlViewNode, id: string): Element {
  const found = DomUtils.findOne(
    (e) => e.attribs.id === id,
    el.document.children as never,
    true,
  );
  assert.ok(found, id);
  return found as unknown as Element;
}

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;
/** A tree's line's width and height, for what a change started at. */
const sizeOf = (line: string | undefined): string =>
  (line?.split('|')[6] ?? '').split(',').slice(2).join(',');

/** The tree as it is, against the whole document built from nothing. */
async function assertWhole(el: HtmlViewNode, what: string): Promise<void> {
  const inner = owing(el);
  const kept = treeLines(inner._tree);
  inner._invalidate(2);
  await act();
  const whole = treeLines(inner._tree);
  const at = kept.findIndex((line, i) => line !== whole[i]);
  // the deepest that differ, which is where it started
  const differ = kept
    .map((line, i) => (line === whole[i] ? -1 : i))
    .filter((i) => i >= 0)
    .sort(
      (a, b) =>
        Number(sizeOf(whole[b]) !== sizeOf(kept[b])) -
          Number(sizeOf(whole[a]) !== sizeOf(kept[a])) ||
        indentOf(kept[b]) - indentOf(kept[a]),
    )
    .slice(0, 3)
    .map((i) => `kept  ${kept[i]}\nwhole ${whole[i]}`);
  assert.ok(
    at < 0 && kept.length === whole.length,
    `${what}: line ${at}\n${differ.join('\n')}`,
  );
}

metric(
  'a face that arrives sets what can be seen, and what is off screen stays as it was until its turn',
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const { el } = await renderScrolled(page(120), 200, 320, {
      onResource: faces.onResource,
    });
    await act();
    const inner = owing(el);
    const far = byId(el, 'p100');
    const before = inner._tree;
    const farBox = (): Box => {
      let found: Box | null = null;
      const walk = (box: Box) => {
        if (box.el === far && box.lines) found = box;
        for (const child of box.children) walk(child);
      };
      walk(inner._tree.root);
      return found!;
    };
    const farLines = farBox().lines;
    const made = boxLayoutsMade();
    await faces.arrive('regular.ttf');
    assert.strictEqual(inner._tree, before, 'no box was built');
    assert.ok(
      boxLayoutsMade() - made < 60,
      `${boxLayoutsMade() - made} boxes laid out of a page of 240`,
    );
    assert.ok(inner._owed.size > 50, `${inner._owed.size} blocks wait`);
    assert.strictEqual(farBox().lines, farLines, 'drawn as it was');
    const slices = await runOwed(el);
    assert.ok(slices > 1, `${slices} slices`);
    assert.notStrictEqual(farBox().lines, farLines, 'and set in its turn');
    await assertWhole(el, 'all of it set');
  },
);

metric(
  "a read of the page's during a swap answers from the document the face made",
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const { el } = await renderScrolled(page(120), 200, 320, {
      onResource: faces.onResource,
    });
    await act();
    const inner = owing(el);
    await faces.arrive('regular.ttf');
    assert.ok(inner._owed.size > 50, 'something waits to be read past');
    const rect = el.elementRect(byId(el, 'p110'))!;
    assert.strictEqual(inner._owed.size, 0, 'the read brought it up to date');
    inner._invalidate(2);
    await act();
    assert.deepStrictEqual(el.elementRect(byId(el, 'p110')), rect);
  },
);

metric('each read of what is laid out settles what waits', async (t) => {
  holdClock(t, owedClock);
  const reads: [string, (el: HtmlViewNode, far: Element) => unknown][] = [
    ['elementRect', (el, far) => el.elementRect(far)],
    ['offsetRect', (el, far) => el.offsetRect(far)],
    ['clientBoxOf', (el, far) => el.clientBoxOf(far)],
    ['computedStyle', (el, far) => el.computedStyle(far)],
    [
      'textRects',
      (el, far) => el.textRects(far.children[0], 0, far.children[0], 3),
    ],
    ['textPointAt', (el) => el.textPointAt(5, 5)],
    ['scrollElementTo', (el, far) => el.scrollElementTo(far, { y: 0 })],
    // what it scrolls waits, so how far that reaches does
    ['scrollStateOf', (el) => el.scrollStateOf(byId(el, 'in'))],
  ];
  for (const [name, read] of reads) {
    const faces = heldFaces();
    const body: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      body.push(`<p id="p${i}">paragraph ${i} of a page</p>`);
    }
    const { el, result } = await renderScrolled(
      `<!doctype html><html><head><style>${FACES}
      p { margin: 4px 0 } #in { overflow: auto; height: 40px }</style></head>
      <body>${body.join('')}<div id="in"><p>a</p><p>b</p><p>c</p></div>
      </body></html>`,
      200,
      320,
      { onResource: faces.onResource },
    );
    await act();
    const inner = owing(el);
    await faces.arrive('regular.ttf');
    assert.ok(inner._owed.size > 50, `${name}: something waits`);
    read(el, byId(el, 'p110'));
    assert.strictEqual(inner._owed.size, 0, `${name} settled it`);
    result.unmount();
  }
});

metric("a page's elementFromPoint settles what waits", async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  let handle: ReturnType<typeof useHtmlHandle> | null = null;
  const Doc = () => {
    handle = useHtmlHandle();
    return h(Html, {
      source: page(120),
      ref: handle.ref,
      onResource: faces.onResource,
      'data-testname': 'doc',
    });
  };
  await renderX11(
    h(
      'box',
      { style: { width: 320, height: 200, flexDirection: 'column' } },
      h('box', { style: { flexGrow: 1, overflow: 'scroll' } }, h(Doc)),
    ),
    { width: 640, height: 800, fonts: FONTS! },
  );
  await act();
  await act();
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const inner = owing(el);
  await faces.arrive('regular.ttf');
  assert.ok(inner._owed.size > 50, 'something waits');
  handle!.elementAt(5, 5);
  assert.strictEqual(inner._owed.size, 0);
});

metric(
  'a layout that costs what it keeps is not paid for each block',
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const { el } = await renderScrolled(page(240), 200, 320, {
      onResource: faces.onResource,
    });
    await act();
    const inner = owing(el);
    inner._owedChunk = 1;
    await faces.arrive('regular.ttf');
    // every slice as long as a long task, whatever it holds
    let now = 0;
    t.mock.method(frameClock, 'now', () => (now += 30));
    const slices = await runOwed(el);
    assert.ok(slices <= 6, `${slices} slices`);
  },
);

metric(
  'a marker in a face of its own is set again with its item',
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const { el } = await renderScrolled(
      `<!doctype html><html><head><style>${FACES}
    ul { font-family: sans-serif; list-style: "www " outside; padding: 0 80px }
    li::marker { font-family: Web }</style></head>
    <body><ul><li id="m">an item</li><li>an item</li></ul></body></html>`,
      200,
      320,
      { onResource: faces.onResource },
    );
    await act();
    const inner = owing(el);
    await faces.arrive('regular.ttf');
    await runOwed(el);
    const item = inner._firstBoxesOf(inner._tree).get(byId(el, 'm'))!;
    assert.ok(item.marker?.style?.fontFamily.startsWith('html webfont'));
    await assertWhole(el, 'a marker');
  },
);

metric(
  'the faces of a list that changed are warmed before it is set',
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const { el, result } = await renderScrolled(page(20), 200, 320, {
      onResource: faces.onResource,
    });
    await act();
    const fonts = (result.app as unknown as { fonts: object }).fonts as {
      prewarm(family: string, faces?: unknown[]): void;
    };
    const prewarm = fonts.prewarm.bind(fonts);
    const warmed: string[] = [];
    fonts.prewarm = (family, named) => {
      warmed.push(family);
      prewarm(family, named);
    };
    await faces.arrive('regular.ttf');
    assert.ok(
      warmed.some((family) => family.includes('html webfont')),
      `warmed ${warmed.join('; ')}`,
    );
    void el;
  },
);

metric(
  "a length read from a face that came under a list that stayed is the new face's",
  async (t) => {
    // the bold face comes under the list the regular one made, so what was
    // kept of a face by its list says nothing of it
    holdClock(t, owedClock);
    const source = `<!doctype html><html><head><style>${FACES}
    b { font-weight: 700; display: block; padding-left: 10ch }</style></head>
    <body><b id="b">bold</b></body></html>`;
    const faces = heldFaces();
    const { el, result } = await renderScrolled(source, 200, 320, {
      onResource: faces.onResource,
    });
    await act();
    await faces.arrive('regular.ttf');
    await faces.arrive('bold.ttf');
    await runOwed(el);
    const swapped = el.computedStyle(byId(el, 'b'))!['padding-left'];
    result.unmount();
    const both = heldFaces();
    const fresh = await renderScrolled(source, 200, 320, {
      onResource: both.onResource,
    });
    await act();
    both.settleAll();
    await act();
    await act();
    const first = fresh.el.computedStyle(byId(fresh.el, 'b'))!['padding-left'];
    assert.strictEqual(swapped, first);
  },
);

metric('what a face owes waits for a drag to rest', async (t) => {
  holdClock(t, owedClock);
  const rest = holdClock(t, resizeClock);
  const faces = heldFaces();
  const { el, resize } = await renderScrolled(page(120), 200, 320, {
    onResource: faces.onResource,
  });
  await act();
  const inner = owing(el);
  await resize(200, 316);
  assert.ok(inner._partial, 'a step of a drag holds the rest aside');
  await faces.arrive('regular.ttf');
  // measured under it, what is set aside would be left out for good
  assert.strictEqual(inner._owed.size, 120, 'none of it ran');
  await rest.finish();
  assert.ok(!inner._partial, 'at rest');
  await runOwed(el);
  await assertWhole(el, 'after a drag');
});

metric('what a face does not reach is kept around what it does', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const rows = "<p>a block in no face of the page's</p>".repeat(40);
  const items = '<div>an item</div>'.repeat(40);
  const { el } = await renderScrolled(
    `<!doctype html><html><head><style>${FACES}
    .plain { font-family: sans-serif } .web { font-family: Web }
    .row { display: flex; gap: 4px } .row > div { flex: 0 1 auto; min-width: 0 }
    .wrap { flex-wrap: wrap }
    .tracks { display: grid; grid-template-columns: 100px 100px }
    .grid { display: grid; grid-template-columns: auto auto }
    p { margin: 2px 0 }</style></head>
    <body class="plain">
      <div class="row"><div>${rows}<p class="web">in the face</p></div>
      <div>${rows}</div></div>
      <div class="grid"><div>${rows}<p class="web">in the face</p></div>
      <div>${rows}</div></div>
      <div>${rows}<p class="web">in the face</p></div>
      <div class="row wrap">${items}<div class="web">in the face</div></div>
      <div class="tracks">${items}<div class="web">in the face</div></div>
    </body></html>`,
    400,
    320,
    { onResource: faces.onResource },
  );
  await act();
  const before = boxLayoutsMade();
  await faces.arrive('regular.ttf');
  await runOwed(el);
  const laid = boxLayoutsMade() - before;
  assert.ok(laid < 40, `${laid} laid out of some 500`);
  await assertWhole(el, 'beside what it reached');
});

metric('a table waits whole, and is laid out once', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const rows: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push(`<tr><td>a row ${i}</td><td>of a table</td></tr>`);
  }
  const body: string[] = [];
  for (let i = 0; i < 30; i += 1) body.push(`<p>paragraph ${i}</p>`);
  const { el } = await renderScrolled(
    `<!doctype html><html><head><style>${FACES}</style></head><body>
    ${body.join('')}<table id="t">${rows.join('')}</table></body></html>`,
    200,
    320,
    { onResource: faces.onResource },
  );
  await act();
  const inner = owing(el);
  inner._owedChunk = 1;
  await faces.arrive('regular.ttf');
  const cells = [...inner._owed.keys()].filter((box) => box.kind !== 'block');
  assert.strictEqual(cells.length, 1, 'the table, and no cell of it');
  assert.strictEqual(cells[0].kind, 'table');
});

metric("the host's family is no list of the sheets'", async (t) => {
  // a document can name a family as the host's, and text in no family of its
  // own is the host's whatever it declares: nothing maps what no sheet wrote
  holdClock(t, owedClock);
  const faces = heldFaces();
  const { el } = await renderScrolled(
    `<!doctype html><html><head><style>
    @font-face { font-family: Web; src: url(regular.ttf) }
    p { font-family: Web }</style></head>
    <body>the host's<p>a paragraph</p></body></html>`,
    200,
    320,
    { onResource: faces.onResource, fontFamily: 'Web' },
  );
  await act();
  await faces.arrive('regular.ttf');
  await runOwed(el);
  await assertWhole(el, "the host's family");
});

metric(
  'what is above what can be seen is set after the rest, and what is read stays where it is on screen',
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const text = 'words that wrap at another place in the other face '.repeat(
      2,
    );
    const body: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      body.push(`<p id="p${i}">${text}</p>`);
    }
    // a size of its own, since two faces a machine has may wrap alike
    const wider = FACES.replace('url(regular.ttf)', '$&; size-adjust: 170%');
    const { el } = await renderScrolled(
      `<!doctype html><html><head><style>${wider}
      p { margin: 4px 0 }</style></head><body>${body.join('')}</body></html>`,
      200,
      320,
      { onResource: faces.onResource },
    );
    await act();
    const inner = owing(el);
    paneOf(el).scrollTo({ y: 1200 });
    await act();
    await act();
    const boxOf = (id: string) =>
      inner._firstBoxesOf(inner._tree).get(byId(el, id))!;
    const y = (id: string) => boxOf(id).y;
    const pane = paneOf(el);
    // the block the top of the pane cuts through
    const first = Array.from({ length: 120 }, (_, i) => `p${i}`).find(
      (id) => y(id) + boxOf(id).height > pane.scrollY,
    )!;
    const from = y(first);
    const was = from - pane.scrollY;
    await faces.arrive('regular.ttf');
    // the pane following what moved is no reader's scroll, which would hold
    // the rest off (`_followOwed`)
    let held = 0;
    for (let i = 0; i < 400 && inner._owed.size; i += 1) {
      inner._inputAt = -Infinity;
      inner._owedChunk = 4;
      inner._owedSlices = 1000;
      inner._owedSlice();
      await act();
      await act();
      if (inner._inputAt !== -Infinity) held += 1;
    }
    assert.strictEqual(inner._owed.size, 0);
    assert.strictEqual(held, 0, 'nobody scrolled');
    await act();
    const to = y(first);
    assert.ok(Math.abs(to - from) > 100, `it went from ${from} to ${to}`);
    const moved = Math.abs(to - pane.scrollY - was);
    assert.ok(moved < 2, `what was at the top moved ${moved}px on screen`);
  },
);

metric(
  'a scroll onto what waits sets it, without the idle thread',
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const { el } = await renderScrolled(page(120), 200, 320, {
      onResource: faces.onResource,
    });
    await act();
    const inner = owing(el);
    await faces.arrive('regular.ttf');
    const far = byId(el, 'p100');
    const line = (): unknown =>
      inner._firstBoxesOf(inner._tree).get(far)?.lines?.[0]?.texts[0]?.layout;
    const drawn = line();
    const y = el.elementRect.call(
      Object.assign(Object.create(el), { _settle: () => undefined }),
      far,
    )!.y;
    paneOf(el).scrollTo({ y });
    await act();
    await act();
    await act();
    assert.notStrictEqual(line(), drawn, 'set as it came near');
    assert.ok(inner._owed.size > 0, 'and the rest still waits');
  },
);

metric('a scroll container that shows what waits sets it', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const rows: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push(`<p id="r${i}">a row ${i} of what it scrolls</p>`);
  }
  const { el } = await renderScrolled(
    `<!doctype html><html><head><style>${FACES}
    #s { overflow: auto; height: 160px } p { margin: 2px 0 }</style></head>
    <body><div id="s">${rows.join('')}</div></body></html>`,
    200,
    320,
    { onResource: faces.onResource },
  );
  await act();
  const inner = owing(el);
  inner._owedChunk = 1;
  await faces.arrive('regular.ttf');
  const waiting = inner._owed.size;
  assert.ok(waiting > 20, `${waiting} wait`);
  const boxes = inner._firstBoxesOf(inner._tree);
  const scroller = boxes.get(byId(el, 's'))!;
  const row = boxes.get(byId(el, 'r50'))!;
  inner._inputAt = -Infinity;
  inner._scrollBox(scroller, 0, row.y - scroller.y);
  assert.notStrictEqual(inner._inputAt, -Infinity, 'it holds the rest off');
  await act();
  await act();
  assert.ok(inner._owed.size < waiting, 'set as it came into view');
  assert.ok(inner._owed.size > 0, 'and only that');
});

metric('a small scroll that shows what waits has it painted', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const { el } = await renderScrolled(page(120), 400, 320, {
    onResource: faces.onResource,
  });
  await act();
  let paints = 0;
  const paint = el.paint;
  el.paint = function (this: HtmlViewNode, ...a: Parameters<typeof paint>) {
    paints += 1;
    return paint.apply(this, a);
  };
  const inner = owing(el);
  inner._owedChunk = 1;
  await faces.arrive('regular.ttf');
  // by less than what is near is looked for at (`_followOwed`), to just
  // show the first block that waits
  const first = [...inner._owed.keys()][0];
  const y = first.y - 400 + 10;
  inner._owedTop = y;
  paneOf(el).scrollTo({ y });
  await act();
  await act();
  const was = paints;
  inner._owedChunk = 1;
  inner._inputAt = -Infinity;
  // and with the pane told of its height a moment ago, which paints
  inner._measuredAt = owedClock.now();
  inner._owedSlice();
  await act();
  assert.ok(paints > was, 'painted once it is set');
});

metric('the pane is told how tall the document came to be', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const { el } = await renderScrolled(page(120), 200, 320, {
    onResource: faces.onResource,
  });
  await act();
  await faces.arrive('regular.ttf');
  await runOwed(el);
  await act();
  const inner = el as unknown as { _documentHeight: number };
  assert.ok(
    Math.abs(el.abs.height - inner._documentHeight) <= 1,
    `${el.abs.height} for ${inner._documentHeight}`,
  );
});

metric(
  'a hover over what waits is restyled where it is, in the face it is drawn in',
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const body: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      body.push(
        `<p><a id="a${i}" href="#x">a link of a paragraph ${i}</a></p>`,
      );
    }
    const { el } = await renderScrolled(
      `<!doctype html><html><head><style>${FACES}
      p { margin: 4px 0 } a:hover { color: red }</style></head>
      <body>${body.join('')}</body></html>`,
      200,
      320,
      { onResource: faces.onResource },
    );
    await act();
    const inner = owing(el);
    inner._owedChunk = 1;
    await faces.arrive('regular.ttf');
    const anchor = byId(el, 'a60');
    const link = inner._firstBoxesOf(inner._tree).get(anchor)!;
    const owner = [...inner._owed.keys()].find((box) => {
      for (let at: Box | null = link; at; at = at.parent) {
        if (at === box) return true;
      }
      return false;
    });
    assert.ok(owner, 'the link waits');
    // scrolled to it with nothing looking for what is near (`_followOwed`)
    const y = owner.y;
    inner._owedTop = y;
    paneOf(el).scrollTo({ y });
    await act();
    const left = inner._owed.size;
    const tree = inner._tree;
    const { color } = link.style;
    el.setHover(owner.x + 5, 5);
    await act();
    assert.ok(inner._tree === tree, 'no box was built');
    assert.strictEqual(inner._owed.size, left, 'and nothing was set for it');
    assert.notStrictEqual(link.style.color, color, 'it was restyled');
  },
);

metric('an anonymous style no box has takes the face too', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const { el } = await renderScrolled(
    `<!doctype html><html><head><style>${FACES}</style></head>
    <body><div id="d">around <p>a block</p></div></body></html>`,
    200,
    320,
    { onResource: faces.onResource },
  );
  await act();
  const d = byId(el, 'd');
  const around = d.children[0];
  removeNode(around as never);
  el.touchDocument([
    {
      type: 'childList',
      target: d,
      addedNodes: [],
      removedNodes: [around as never],
    },
  ]);
  await act();
  await faces.arrive('regular.ttf');
  await runOwed(el);
  const text = createText('around');
  appendChild(d, text);
  el.touchDocument([
    { type: 'childList', target: d, addedNodes: [text], removedNodes: [] },
  ]);
  await act();
  await assertWhole(el, 'a box made again for it');
});

metric('a drawing with no text in it is left alone', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const { el } = await renderScrolled(
    `<!doctype html><html><head><style>${FACES}</style></head><body>
    <div><svg id="icon" width="10" height="10"><path d="M0 0h9"/></svg></div>
    <div><svg id="label" width="90" height="20"><text y="10">a word</text></svg></div>
    <p>text</p></body></html>`,
    200,
    320,
    { onResource: faces.onResource },
  );
  await act();
  const inner = owing(el);
  const first = inner._firstBoxesOf(inner._tree);
  const icon = first.get(byId(el, 'icon'));
  const label = first.get(byId(el, 'label'));
  await faces.arrive('regular.ttf');
  const now = inner._firstBoxesOf(inner._tree);
  assert.ok(now.get(byId(el, 'icon')) === icon, 'kept');
  assert.ok(now.get(byId(el, 'label')) !== label, 'built again');
});

metric('a tree no layout keeps blocks in takes the swap whole', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const body: string[] = [];
  for (let i = 0; i < 80; i += 1) body.push(`<p>a paragraph ${i}</p>`);
  const { el } = await renderScrolled(
    `<!doctype html><html><head><style>${FACES}
    p::first-line { color: red }</style></head>
    <body>${body.join('')}</body></html>`,
    200,
    320,
    { onResource: faces.onResource },
  );
  await act();
  const inner = owing(el);
  await faces.arrive('regular.ttf');
  assert.strictEqual(inner._owed.size, 0, 'nothing waits');
  await assertWhole(el, 'a first line');
});

metric('what a build made again is no longer owed', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const { el } = await renderScrolled(page(120), 200, 320, {
    onResource: faces.onResource,
  });
  await act();
  const inner = owing(el);
  await faces.arrive('regular.ttf');
  assert.ok(inner._owed.size > 50);
  inner._invalidate(3);
  await act();
  assert.strictEqual(inner._owed.size, 0);
});

metric(
  "a scroller's offsets are read without running what is outside it",
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const body: string[] = [];
    for (let i = 0; i < 120; i += 1) body.push(`<p>a paragraph ${i}</p>`);
    const { el } = await renderScrolled(
      `<!doctype html><html><head><style>${FACES}
    #s { overflow: auto; height: 30px; font-family: sans-serif }</style></head>
    <body><div id="s"><p>x</p><p>y</p><p>z</p></div>${body.join('')}</body></html>`,
      200,
      320,
      { onResource: faces.onResource },
    );
    await act();
    const inner = owing(el);
    await faces.arrive('regular.ttf');
    const left = inner._owed.size;
    assert.ok(left > 50);
    assert.ok(el.scrollStateOf(byId(el, 's')));
    assert.strictEqual(inner._owed.size, left, 'nothing in it waits');
  },
);

metric(
  'faces that arrive together are taken in once, and a bold face leaves the regular text as it was',
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const body: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      body.push(
        i % 4 === 0
          ? `<p id="p${i}"><b>a bold paragraph ${i}</b></p>`
          : `<p id="p${i}">a regular paragraph ${i}</p>`,
      );
    }
    const { el } = await renderScrolled(
      `<!doctype html><html><head><style>${FACES}
      p { margin: 4px 0 } b { font-weight: 700 }</style></head>
      <body>${body.join('')}</body></html>`,
      200,
      320,
      { onResource: faces.onResource },
    );
    await act();
    const inner = owing(el);
    await faces.arrive('regular.ttf');
    await runOwed(el);
    // a slice as small as they come, whatever the last ones found
    inner._owedChunk = 1;
    await faces.arrive('bold.ttf');
    // only the bold paragraphs off screen, of the eighty
    assert.ok(inner._owed.size > 0, 'a bold paragraph waits');
    assert.ok(
      inner._owed.size <= 20,
      `${inner._owed.size} wait, of twenty that are bold`,
    );
    await runOwed(el);
    await assertWhole(el, 'both faces in');
  },
);

metric('arrivals close together are one swap', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const { el } = await renderScrolled(page(60), 200, 320, {
    onResource: faces.onResource,
  });
  await act();
  const proto = Object.getPrototypeOf(el) as { _takeFaces(): void };
  const take = proto._takeFaces;
  let taken = 0;
  proto._takeFaces = function (this: unknown) {
    taken += 1;
    return take.call(this);
  };
  try {
    faces.settleAll();
    await Promise.resolve();
    await act();
    await act();
  } finally {
    proto._takeFaces = take;
  }
  assert.strictEqual(taken, 1, 'both taken at one frame');
});

metric(
  'a key holds what is owed off, and a pointer settles nothing',
  async (t) => {
    const clock = holdClock(t, owedClock);
    const faces = heldFaces();
    const { el } = await renderScrolled(page(120), 200, 320, {
      onResource: faces.onResource,
    });
    await act();
    const inner = owing(el);
    await faces.arrive('regular.ttf');
    const waiting = inner._owed.size;
    assert.ok(waiting > 50, 'something waits');
    // what a press is aimed by: what is drawn there, as it is drawn
    el.elementAtPoint(10, 10);
    assert.strictEqual(inner._owed.size, waiting, 'a hit test runs nothing');
    el.noteInput();
    inner._owedSlice();
    assert.strictEqual(inner._owed.size, waiting, 'a key holds it off');
    // on its own, at the thread's pace, once the keys have stopped
    let frames = 0;
    while (inner._owed.size && frames < 2000) {
      await clock.frame();
      await act();
      frames += 1;
    }
    assert.strictEqual(inner._owed.size, 0, `run out in ${frames} frames`);
    await assertWhole(el, 'run by the clock');
  },
);

metric('a key pressed in the document holds what waits off', async (t) => {
  holdClock(t, owedClock);
  const faces = heldFaces();
  const { el } = await renderScrolled(
    page(120).replace('<body>', '<body><a id="l" href="#x">a link</a>'),
    200,
    320,
    { onResource: faces.onResource },
  );
  await act();
  const inner = owing(el);
  await faces.arrive('regular.ttf');
  const waiting = inner._owed.size;
  assert.ok(waiting > 50, 'something waits');
  await act(async () => {
    assert.ok(el.interactive!.focus(byId(el, 'l')), 'the link takes the focus');
  });
  await act();
  inner._inputAt = -Infinity;
  await userEvent.key(XK_RIGHT);
  inner._owedSlice();
  assert.strictEqual(inner._owed.size, waiting, 'nothing ran for it');
});

metric(
  "a length read from a face is the new face's, at a read, and once its box's turn comes",
  async (t) => {
    holdClock(t, owedClock);
    const faces = heldFaces();
    const body: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      body.push(
        `<p id="p${i}" class="ch">a paragraph ${i} set to a measure</p>`,
      );
    }
    const { el } = await renderScrolled(
      `<!doctype html><html><head><style>${FACES}
      p { margin: 4px 0 } .ch { max-width: 20ch }</style></head>
      <body>${body.join('')}</body></html>`,
      200,
      320,
      { onResource: faces.onResource },
    );
    await act();
    const inner = owing(el);
    await faces.arrive('regular.ttf');
    assert.ok(inner._owed.size > 20, 'a paragraph off screen waits');
    await runOwed(el);
    await assertWhole(el, 'measures in `ch`');
  },
);

/** The pane a document scrolls in. */
function paneOf(node: unknown): {
  scrollY: number;
  scrollTo(to: { y: number }): void;
} {
  type Up = { parent: Up | null; props?: { style?: { overflow?: string } } };
  let at = (node as Up).parent;
  while (at && at.props?.style?.overflow !== 'scroll') at = at.parent;
  assert.ok(at, 'a pane');
  return at as unknown as ReturnType<typeof paneOf>;
}

/** mulberry32: the same document for the same seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_SHEET = `${FACES}
p { margin: 3px 0 } h2 { margin: 2px 0; font-size: 18px }
.b { font-weight: 700 } .i { font-style: italic }
.plain { font-family: sans-serif } .only { font-family: Web }
.ch { max-width: 14ch } .ex { padding-left: 2ex } .lh { min-height: 2lh }
.ib { display: inline-block; max-width: 60% }
.fl { display: flex; gap: 4px } .grow { flex: 1 }
.gr { display: grid; grid-template-columns: auto 1fr; gap: 2px }
.fit { float: left; clear: left } .sh { display: table }
.abs { position: absolute } .rel { position: relative; top: 3px }
.sti { position: sticky; top: 0 } .sc { overflow: auto; height: 40px }
.cols { columns: 2 } .op { opacity: .5 } .tr { transform: rotate(3deg) }
.ic::before { content: 'w ' } .ia::after { content: ' 0' }
ul { margin: 0; padding-left: 20px }`;

/** And a flow in another writing mode, which takes a face whole, so a third
 *  of the documents are enough. */
const FRAMED_FUZZ_SHEET = `${FUZZ_SHEET}
.vr { writing-mode: vertical-rl; height: 80px }`;

const FUZZ_CLASSES = [
  'b',
  'i',
  'plain',
  'only',
  'ch',
  'ex',
  'lh',
  'ib',
  'fl',
  'gr',
  'fit',
  'sh',
  'abs',
  'rel',
  'sti',
  'sc',
  'cols',
  'op',
  'tr',
  'ic',
  'ia',
  'vr',
];

const FUZZ_WORDS = [
  'one',
  'two three',
  'four five six seven',
  'a longer run of words for a line to break',
  'WWWW iiii',
  '0123',
];

let fuzzedImages = 0;

function fuzzed(next: () => number, depth: number): Element {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const kind = next();
  if (kind < 0.08) {
    return createElement('button', {}, [createText(pick(FUZZ_WORDS))]);
  }
  if (kind < 0.13) {
    return createElement('input', { value: pick(FUZZ_WORDS) });
  }
  if (kind < 0.2) {
    const items: ReturnType<typeof createElement>[] = [];
    for (let i = 0, n = 1 + Math.floor(next() * 3); i < n; i += 1) {
      items.push(createElement('li', {}, [createText(pick(FUZZ_WORDS))]));
    }
    return createElement('ul', {}, items);
  }
  if (kind < 0.26) {
    const cell = () => createElement('td', {}, [createText(pick(FUZZ_WORDS))]);
    return createElement('table', {}, [
      createElement('tbody', {}, [
        createElement('tr', {}, [cell(), cell()]),
        createElement('tr', {}, [cell(), cell()]),
      ]),
    ]);
  }
  if (kind < 0.34) {
    // a lazy image's size waits with the rest: none of its own, or one the
    // image takes the place of, in a box or on a line
    fuzzedImages += 1;
    const src = `${'i'.repeat(1 + (fuzzedImages % 4))}${fuzzedImages}.png`;
    const given = next();
    // or a pixel from what it comes to, as rounding leaves an image's
    // attributes, which waits for the scroll to end
    const size = imageSize(src);
    const sized: Record<string, string> | null =
      given < 0.3
        ? { width: '12', height: '9' }
        : given < 0.6
          ? { width: `${size}`, height: `${size + 4}`, style: 'height: auto' }
          : null;
    return createElement('img', {
      loading: 'lazy',
      src,
      ...sized,
      ...(next() < 0.5 && { class: 'plain' }),
    });
  }
  const classes: string[] = [];
  for (let i = 0, n = Math.floor(next() * 3); i < n; i += 1) {
    classes.push(pick(FUZZ_CLASSES));
  }
  const name = pick(['div', 'p', 'section', 'h2', 'span', 'b', 'em']);
  const out = createElement(name, { class: classes.join(' ') }, []);
  const inner = depth < 3 ? Math.floor(next() * 4) : 0;
  if (next() < 0.8 || inner === 0) {
    appendChild(out, createText(pick(FUZZ_WORDS)));
  }
  for (let i = 0; i < inner; i += 1) appendChild(out, fuzzed(next, depth + 1));
  return out;
}

metric(
  'a document set again a slice at a time, around what a page does meanwhile, is the document a whole build makes',
  async (t) => {
    holdClock(t, owedClock);
    const rest = holdClock(t, resizeClock);
    let waited = 0;
    let readsSettled = 0;
    // OWED_SEEDS sweeps more of them, and OWED_FROM starts at the one a
    // sweep failed at
    const env =
      (globalThis as { process?: { env?: Record<string, string> } }).process
        ?.env ?? {};
    const seeds = Number(env.OWED_SEEDS ?? 30);
    const from = Number(env.OWED_FROM ?? 1);
    for (let seed = from; seed <= seeds; seed += 1) {
      const next = random(seed * 7907);
      const body = createElement('body', {});
      const blocks = 12 + Math.floor(next() * 16);
      for (let i = 0; i < blocks; i += 1) appendChild(body, fuzzed(next, 0));
      const markup = DomUtils.getOuterHTML(body as never);
      const faces = heldFaces();
      const { el, result, resize } = await renderScrolled(
        `<!doctype html><html><head><style>${seed % 3 ? FUZZ_SHEET : FRAMED_FUZZ_SHEET}</style></head>${markup}</html>`,
        160,
        320,
        { onResource: faces.onResource, scripting: seed % 2 === 0 },
      );
      await act();
      const inner = owing(el);
      const pane = paneOf(el);
      const bodyEl = DomUtils.findOne(
        (e) => e.name === 'body',
        el.document.children as never,
        true,
      ) as unknown as Element;
      for (let step = 0; step < 14; step += 1) {
        const roll = next();
        if (faces.held.length && roll < 0.4) {
          await faces.arrive(faces.held[0]);
          if (inner._owed.size) waited += 1;
        } else if (roll < 0.55) {
          pane.scrollTo({ y: Math.floor(next() * 600) });
          await act();
          await act();
        } else if (roll < 0.7) {
          inner._inputAt = -Infinity;
          inner._owedSlice();
          await act();
        } else if (roll < 0.78) {
          // a step of a drag, or a width set once
          await resize(160, 300 + Math.floor(next() * 60));
        } else if (roll < 0.9) {
          const text = createText(' more');
          appendChild(bodyEl, text);
          const changes: HtmlChange[] = [
            {
              type: 'childList',
              target: bodyEl,
              addedNodes: [text],
              removedNodes: [],
            },
          ];
          el.touchDocument(changes);
          await act();
        } else if (inner._owed.size && !inner._partial) {
          el.elementRect(bodyEl);
          assert.strictEqual(inner._owed.size, 0, 'a read settles it');
          readsSettled += 1;
          await act();
        }
      }
      for (const name of faces.held) await faces.arrive(name);
      await rest.finish();
      await runOwed(el);
      await assertWhole(el, `seed ${seed}\n${markup}`);
      result.unmount();
    }
    if (seeds - from >= 29) {
      assert.ok(waited > 5, `${waited} arrivals left something to wait`);
      assert.ok(readsSettled > 2, `${readsSettled} reads settled what waited`);
    }
  },
);
