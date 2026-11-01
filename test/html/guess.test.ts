// <Html> — SPIKE: a drag that stays behind its edge, drawn by a guess.
//
// docs/prd-guessed-layout.md is the record. What these hold is what makes the
// fallback safe to have at all: it is the last resort of a drag that fell
// behind, a guess never reaches the boxes for good, and the document at rest
// is the document a whole layout makes.
import { afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import { boxLayoutsMade } from '../../src/html/layout/block.js';
import type { Box, BoxTree } from '../../src/html/layout/boxes.js';
import { guessing } from '../../src/html/layout/guess.js';
import type { LayoutGuess } from '../../src/html/layout/guess.js';
import { HtmlViewNode } from '../../src/html/index.js';
import { frameClock, resizeClock } from '../../src/html/node.js';
import { holdClock } from '../held-clock.js';
import { boxOf, metric, renderScrolled, treeOf } from './harness.js';

afterEach(cleanup);

/** What an application's page is made of: what is either side of a column
 *  stays its size, and the column takes the rest. */
const ROWS = (n: number) => `<style>
  body { margin: 0 }
  .row { display: flex; height: 40px; gap: 8px }
  .side { width: 80px; flex: none }
  .rest { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap }
  .end { width: 60px; flex: none }
</style>${Array.from(
  { length: n },
  (_, i) =>
    `<div class="row"><div class="side">s${i}</div>` +
    `<div id="rest${i}" class="rest">the subject of a message</div>` +
    `<div id="end${i}" class="end">21:40</div></div>`,
).join('')}`;

interface Guessing {
  _guess: LayoutGuess | null;
  _guessedAt: number | null;
  _guessWanted: boolean;
  _laidOutWidth: number;
}
const inner = (el: HtmlViewNode) => el as unknown as Guessing;

const windowOf = (el: HtmlViewNode) =>
  (el as unknown as { root: { window: { liveResizing?: boolean } } }).root
    .window;

/** The guess on, and the document's own work timed at `ms.value`. */
function behind(t: TestContext, ms: { value: number }): void {
  guessing.enabled = true;
  t.after(() => {
    guessing.enabled = false;
  });
  let now = 0;
  t.mock.method(frameClock, 'now', () => (now += ms.value));
}

/** Drag from 400 until a guess is ready: three frames to fall behind, and
 *  the two exact layouts after them to take a slope from. */
async function untilGuessing(
  resize: (height: number, width?: number) => Promise<void>,
  el: HtmlViewNode,
): Promise<number> {
  let width = 400;
  for (let i = 0; i < 12 && !inner(el)._guess; i += 1) {
    width -= 4;
    await resize(300, width);
  }
  assert.ok(inner(el)._guess, 'two exact layouts after it fell behind');
  return width;
}

const rectOf = (el: HtmlViewNode, id: string): number[] => {
  const { x, y, width, height } = boxOf(el, id);
  return [x, y, width, height];
};

/** Everything a guess moves, as numbers. */
function geometry(el: HtmlViewNode): number[] {
  const out: number[] = [];
  const walk = (box: Box): void => {
    out.push(box.x, box.y, box.width, box.height);
    out.push(box.boundsX, box.boundsWidth);
    for (const line of box.lines ?? []) {
      out.push(line.x, line.y);
      for (const text of line.texts) out.push(text.drawX, text.drawY);
    }
    for (const child of box.children) walk(child);
  };
  walk((treeOf(el) as BoxTree).root);
  return out;
}

metric(
  'a drag that stays behind its edge draws widths by a guess, laying nothing out',
  async (t) => {
    const clock = holdClock(t, resizeClock);
    behind(t, { value: 20 });
    const { el, resize } = await renderScrolled(ROWS(12), 300, 400);
    const wnd = windowOf(el);
    wnd.liveResizing = true;
    try {
      const width = await untilGuessing(resize, el);
      const laid = boxLayoutsMade();
      const exact = inner(el)._laidOutWidth;
      for (let w = width - 4; w > width - 40; w -= 4) await resize(300, w);
      assert.strictEqual(boxLayoutsMade(), laid, 'no box laid out');
      assert.strictEqual(inner(el)._guessedAt, width - 36);
      assert.strictEqual(inner(el)._laidOutWidth, exact, 'and none lied about');
    } finally {
      wnd.liveResizing = false;
    }
    await clock.finish();
  },
);

metric('a drag the document keeps up with draws no guess', async (t) => {
  holdClock(t, resizeClock);
  behind(t, { value: 0 });
  const { el, resize } = await renderScrolled(ROWS(12), 300, 400);
  const wnd = windowOf(el);
  wnd.liveResizing = true;
  try {
    for (const width of [396, 392, 388, 384, 380, 376, 372]) {
      await resize(300, width);
    }
    assert.strictEqual(inner(el)._guessWanted, false);
    assert.strictEqual(inner(el)._laidOutWidth, 372);
  } finally {
    wnd.liveResizing = false;
  }
});

metric(
  'a guess puts every box where a layout at that width does',
  async (t) => {
    holdClock(t, resizeClock);
    behind(t, { value: 20 });
    const { el, resize } = await renderScrolled(ROWS(12), 300, 400);
    const wnd = windowOf(el);
    wnd.liveResizing = true;
    try {
      await untilGuessing(resize, el);
      const guess = inner(el)._guess!;
      guess.apply(320);
      const rest = rectOf(el, 'rest3');
      const end = rectOf(el, 'end3');
      guess.undo();
      const fresh = await renderScrolled(ROWS(12), 300, 320);
      const want = rectOf(fresh.el, 'rest3');
      const wantEnd = rectOf(fresh.el, 'end3');
      assert.ok(Math.abs(rest[2] - want[2]) < 1, 'what takes the rest');
      assert.ok(Math.abs(end[0] - wantEnd[0]) < 1, 'what comes after it');
      assert.strictEqual(end[2], wantEnd[2], 'and stays its size');
    } finally {
      wnd.liveResizing = false;
    }
  },
);

metric('a guess leaves the boxes as the exact layout left them', async (t) => {
  holdClock(t, resizeClock);
  behind(t, { value: 20 });
  const { el, resize } = await renderScrolled(ROWS(12), 300, 400);
  const wnd = windowOf(el);
  wnd.liveResizing = true;
  try {
    await untilGuessing(resize, el);
    const guess = inner(el)._guess!;
    const was = geometry(el);
    for (const width of [340, 360, 300, 500]) {
      guess.apply(width);
      assert.notDeepStrictEqual(geometry(el), was, `moved for ${width}`);
    }
    guess.undo();
    const now = geometry(el);
    assert.strictEqual(now.length, was.length);
    now.forEach((n, i) =>
      assert.ok(Math.abs(n - was[i]) < 1e-6, `field ${i}: ${n} and ${was[i]}`),
    );
  } finally {
    wnd.liveResizing = false;
  }
});

metric(
  'a page is held at its width while a guess draws, and told at rest',
  async (t) => {
    const clock = holdClock(t, resizeClock);
    behind(t, { value: 20 });
    const { el, resize } = await renderScrolled(ROWS(12), 300, 400);
    const wnd = windowOf(el);
    wnd.liveResizing = true;
    let width = 400;
    try {
      width = await untilGuessing(resize, el);
      assert.strictEqual(el.heldViewport(), true);
      const key = el.geometryKey();
      await resize(300, width - 8);
      width -= 8;
      assert.strictEqual(el.geometryKey(), key, 'no observer sees it move');
    } finally {
      wnd.liveResizing = false;
    }
    await clock.finish();
    assert.strictEqual(el.heldViewport(), false);
    assert.strictEqual(inner(el)._guessedAt, null);
    assert.strictEqual(
      inner(el)._laidOutWidth,
      width,
      'laid out where it rests',
    );
    // and what a layout at that width makes of it
    const fresh = await renderScrolled(ROWS(12), 300, width);
    for (const id of ['rest7', 'end7']) {
      assert.deepStrictEqual(rectOf(el, id), rectOf(fresh.el, id), id);
    }
  },
);

metric(
  'a breakpoint is laid out, however far behind the drag is',
  async (t) => {
    holdClock(t, resizeClock);
    behind(t, { value: 20 });
    const source = `${ROWS(12)}<style>@media (max-width: 340px) { .side { display: none } }</style>`;
    const { el, resize } = await renderScrolled(source, 300, 400);
    const wnd = windowOf(el);
    wnd.liveResizing = true;
    try {
      let width = await untilGuessing(resize, el);
      while (width > 344) {
        width -= 4;
        await resize(300, width);
      }
      assert.notStrictEqual(
        inner(el)._laidOutWidth,
        width,
        'a guess before it',
      );
      await resize(300, 336);
      assert.strictEqual(
        inner(el)._laidOutWidth,
        336,
        'and a layout across it',
      );
      assert.strictEqual(inner(el)._guessedAt, null);
    } finally {
      wnd.liveResizing = false;
    }
  },
);

metric('columns are laid out, however far behind the drag is', async (t) => {
  holdClock(t, resizeClock);
  behind(t, { value: 20 });
  const source = `<div style="columns: 2">${ROWS(12)}</div>`;
  const { el, resize } = await renderScrolled(source, 300, 400);
  const wnd = windowOf(el);
  wnd.liveResizing = true;
  try {
    for (let width = 396; width > 340; width -= 4) await resize(300, width);
    assert.strictEqual(inner(el)._guess, null);
    assert.strictEqual(inner(el)._laidOutWidth, 344);
  } finally {
    wnd.liveResizing = false;
  }
});

metric(
  'what a page changes at the width it is on leaves a guess the slopes it had',
  async (t) => {
    holdClock(t, resizeClock);
    behind(t, { value: 20 });
    const { el, resize } = await renderScrolled(ROWS(12), 300, 400);
    const wnd = windowOf(el);
    wnd.liveResizing = true;
    try {
      const width = await untilGuessing(resize, el);
      const exact = inner(el)._laidOutWidth;
      // a layout at the width it was laid out at, as a page's timer asks
      (el as unknown as { _invalidate(stale: number): void })._invalidate(1);
      await resize(300, exact);
      assert.ok(inner(el)._guess, 'no two new layouts to wait for');
      await resize(300, width - 8);
      assert.strictEqual(inner(el)._guessedAt, width - 8);
    } finally {
      wnd.liveResizing = false;
    }
  },
);
