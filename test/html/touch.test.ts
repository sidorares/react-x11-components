// <Html> — a finger, and the user's scroll of a snap container as it comes to
// rest. A press the backend says is a finger's (core's `nativeEvent.pointerType`,
// which react-x11's Wayland seat sets on what it emulates of a touch point)
// pans what it presses once it has gone the touch slop, as a browser's touch
// scrolling does: the page's pointer is cancelled, the content follows the
// finger, and a finger let go while it moves flings on and snaps ahead. The
// in-process server has no touch device, so the window's events are tagged as
// they are emitted, as the conformance harness does for a `touch` source.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import {
  Html,
  HtmlViewNode,
  preloadHtmlScripts,
} from '../../src/html/index.js';
import { snapClock } from '../../src/html/node.js';
import { holdClock, type HeldClock } from '../held-clock.js';
import { findById, FONTS } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A page in a window of 400 by 300, what its `console.log` says, and the
 *  server's pointer, as a mouse's or, with `finger`, a finger's. */
async function page(source: string, scripts = true) {
  const log: string[] = [];
  const result = await renderX11(
    React.createElement(
      'box',
      { style: { width: 400, height: 300 } },
      React.createElement(Html, {
        source: `<!DOCTYPE html><html><body>${source}</body></html>`,
        baseUrl: 'https://example.test/',
        partial: false,
        ...(scripts && {
          scripts: { log: (_: string, text: string) => log.push(text) },
        }),
      } as never),
    ),
    { width: 400, height: 300, fonts: FONTS! },
  );
  const step = async (ms = 20) => {
    await act(async () => {
      await wait(ms);
    });
    await wait(5);
  };
  await step(100);
  const server = result.server!;
  // what react-x11's Wayland seat puts on the pointer events it emulates of
  // a touch point
  let finger = false;
  const win = result.window as unknown as {
    emit(name: string, ev: unknown, ...rest: unknown[]): boolean;
  };
  const emit = win.emit;
  win.emit = function (name, ev, ...rest) {
    if (
      finger &&
      (name === 'mousedown' || name === 'mouseup' || name === 'mousemove') &&
      ev &&
      typeof ev === 'object'
    ) {
      Object.assign(ev, { pointerType: 'touch', touchId: 1 });
    }
    return emit.call(this, name, ev, ...rest);
  };
  let node: HtmlViewNode | null = null;
  const find = (n: unknown): void => {
    if (node) return;
    if (n instanceof HtmlViewNode) node = n;
    for (const c of (n as { children?: unknown[] }).children ?? []) find(c);
  };
  find(result.windowNode);
  assert.ok(node, 'the document');
  const view = node as HtmlViewNode;
  return {
    log,
    view,
    step,
    el: (id: string) => findById(view.document, id)!,
    /** A finger down at a point, moved through the others a frame apart,
     *  and lifted `rest` ms after its last move: a frame apart on `clock`
     *  where the test holds the gesture's (`snapClock`), which a finger's
     *  speed is read on. */
    swipe: async (points: [number, number][], rest = 16, clock?: HeldClock) => {
      const apart = async (ms: number) => {
        clock?.pass(ms);
        await step(ms);
      };
      finger = true;
      server.injectPointerMove(points[0][0], points[0][1]);
      await apart(16);
      server.injectButton(1, true);
      await apart(16);
      for (const [x, y] of points.slice(1)) {
        server.injectPointerMove(x, y);
        await apart(16);
      }
      if (rest > 16) await apart(rest - 16);
      server.injectButton(1, false);
      await apart(16);
      finger = false;
    },
    /** A mouse's drag from one point to another, a frame at each. */
    drag: async (from: [number, number], to: [number, number]) => {
      server.injectPointerMove(from[0], from[1]);
      await step(16);
      server.injectButton(1, true);
      await step(16);
      server.injectPointerMove(to[0], to[1]);
      await step(16);
    },
    lift: async () => {
      server.injectButton(1, false);
      await step(16);
    },
    /** A mouse's press and release where the pointer is. */
    click: async (x: number, y: number) => {
      server.injectPointerMove(x, y);
      await step();
      server.injectButton(1, true);
      server.injectButton(1, false);
      await step();
    },
  };
}

const LOGS = (types: string[]) =>
  `<script>for (const n of ${JSON.stringify(types)}) document.addEventListener(n, (e) => console.log(n + (e.pointerType ? ':' + e.pointerType : '') + '@' + (e.target.id || e.target.localName)), true);</script>`;

/** A list 200px tall of 40px rows that snaps on each, at the top left. */
const LIST =
  '<style>body{margin:0}#s{width:200px;height:200px;overflow-y:auto;' +
  'scroll-snap-type:y mandatory}.r{height:40px;scroll-snap-align:start}' +
  '#t{touch-action:none}</style>' +
  `<div id="s">${Array.from({ length: 30 }, (_, i) => `<div class="r" id="r${i}">${i}</div>`).join('')}</div>`;

const scrollTop = (p: Awaited<ReturnType<typeof page>>, id: string) =>
  p.view.scrollStateOf(p.el(id))?.y ?? NaN;

test('a finger that pans cancels the page’s pointer, scrolls what it pressed with the finger, and clicks nothing', async () => {
  const p = await page(
    LIST.replace('scroll-snap-type:y mandatory', '') +
      LOGS([
        'pointerdown',
        'pointermove',
        'pointercancel',
        'pointerup',
        'mousedown',
        'mouseup',
        'click',
      ]),
  );
  // slowly, so that nothing flings: 100px up, and still before it lifts
  await p.swipe(
    [
      [50, 150],
      [50, 145],
      [50, 120],
      [50, 80],
      [50, 50],
    ],
    150,
  );
  await p.step(100);
  assert.equal(p.log[0], 'pointerdown:touch@r3');
  // a move inside the slop is the page's, and the pan cancels the pointer
  assert.deepEqual(p.log.slice(1), [
    'pointermove:touch@r3',
    'pointercancel:touch@r3',
  ]);
  assert.equal(scrollTop(p, 's'), 100, 'the content followed the finger');
});

test('a tap is the pointer’s down and up, then the mouse’s events a tap is compatible with, and the click', async () => {
  const p = await page(
    LIST +
      LOGS([
        'pointerdown',
        'pointerup',
        'pointerout',
        'mousedown',
        'mouseup',
        'click',
      ]),
  );
  await p.swipe([[50, 50]]);
  await p.step(50);
  assert.deepEqual(p.log, [
    'pointerdown:touch@r1',
    'pointerup:touch@r1',
    'pointerout:touch@r1',
    'mousedown@r1',
    'mouseup@r1',
    'click:touch@r1',
  ]);
  assert.equal(scrollTop(p, 's'), 0);
});

test('a finger let go as it moves flings on, comes to rest at the snap position ahead, and the list’s scrollend is told once it has', async (t) => {
  // the gesture's clock held, the finger's speed read on it: on the wall
  // clock a slow runner moved the finger more than the speed's window apart,
  // which read as a finger that stopped, or ran the fling out before it was
  // looked at
  const clock = holdClock(t, snapClock);
  const p = await page(
    LIST +
      `<script>const s = document.getElementById('s'); s.addEventListener('scrollend', () => console.log('scrollend ' + s.scrollTop));</script>`,
  );
  await p.swipe(
    [
      [50, 180],
      [50, 160],
      [50, 140],
      [50, 120],
      [50, 100],
    ],
    16,
    clock,
  );
  // the finger took it 80px, and it goes on from there
  const lifted = scrollTop(p, 's');
  assert.ok(lifted >= 80, `${lifted}`);
  assert.ok(p.view.scrollGestureOwed(p.el('s')), 'still on its way');
  await clock.finish();
  // told at the page's next rendering update, which the wall clock brings
  for (let i = 0; i < 100 && !p.log.length; i += 1) await p.step(20);
  const rest = scrollTop(p, 's');
  assert.ok(rest > lifted, `it went on, to ${rest}`);
  assert.equal(rest % 40, 0, 'at a snap position');
  assert.equal(p.view.scrollGestureOwed(p.el('s')), false);
  assert.deepEqual(p.log, [`scrollend ${rest}`]);
});

test('a finger that stops before it lifts flings nothing, and snaps to the position nearest where it left it, ahead of where it began', async () => {
  const p = await page(LIST);
  await p.swipe(
    [
      [50, 150],
      [50, 130],
      [50, 110],
      [50, 100],
    ],
    200,
  );
  await p.step(600);
  // 50px down, past the row at 40: the nearest position ahead of where it
  // began, which a fling would have taken farther
  assert.equal(scrollTop(p, 's'), 40);
});

test('touch-action: none keeps a finger’s press a press, which the page goes on hearing', async () => {
  const p = await page(
    LIST.replace('<div class="r" id="r1">', '<div class="r" id="t">') +
      LOGS(['pointermove', 'pointercancel', 'pointerup']),
  );
  await p.swipe([
    [50, 50],
    [50, 30],
    [50, 10],
  ]);
  await p.step(100);
  assert.equal(scrollTop(p, 's'), 0);
  assert.ok(!p.log.some((l) => l.startsWith('pointercancel')), p.log.join());
  // held by what it pressed, as a finger is
  assert.deepEqual(p.log, [
    'pointermove:touch@t',
    'pointermove:touch@t',
    'pointerup:touch@t',
  ]);
});

test('each snap container’s wheel rests and snaps on its own: a wheel on another leaves the first to snap', async () => {
  const p = await page(
    '<style>body{margin:0;display:flex}.s{width:150px;height:200px;' +
      'overflow-y:auto;scroll-snap-type:y mandatory}.r{height:100px;' +
      'scroll-snap-align:start}</style>' +
      ['a', 'b']
        .map(
          (id) =>
            `<div class="s" id="${id}">${'<div class="r"></div>'.repeat(10)}</div>`,
        )
        .join(''),
    false,
  );
  const a = p.el('a');
  const b = p.el('b');
  await act(async () => {
    p.view.wheelAt({ x: 50, y: 50 });
    p.view.scrollBy({ y: 30 });
    p.view.wheelAt({ x: 200, y: 50 });
    p.view.scrollBy({ y: 70 });
  });
  assert.ok(p.view.scrollGestureOwed(a) && p.view.scrollGestureOwed(b));
  await p.step(150);
  assert.equal(p.view.scrollStateOf(a)?.y, 100, 'the first snapped ahead');
  assert.equal(p.view.scrollStateOf(b)?.y, 100, 'and the second');
  assert.equal(p.view.scrollGestureOwed(a), false);
});

test('a wheel’s scrollend waits for the snap it ends in', async () => {
  const p = await page(
    LIST +
      `<script>const s = document.getElementById('s'); s.addEventListener('scroll', () => console.log('scroll ' + s.scrollTop)); s.addEventListener('scrollend', () => console.log('scrollend ' + s.scrollTop));</script>`,
  );
  await act(async () => {
    p.view.wheelAt({ x: 50, y: 50 });
    p.view.scrollBy({ y: 10 });
  });
  await p.step(300);
  // the wheel's scroll, the snap's, then the end of it at the snap
  assert.equal(p.log[p.log.length - 1], 'scrollend 40');
  assert.equal(p.log.filter((l) => l.startsWith('scrollend')).length, 1);
});

test('a scroll bar’s thumb dragged in a snap container snaps once it is let go of, ahead of where the drag began', async () => {
  const p = await page(LIST, false);
  const list = p.el('s');
  // 200 of 1200 is a thumb 33px long, with 167 to travel for 1000: 15px
  // down it is some 90
  await p.drag([195, 10], [195, 25]);
  const dragged = p.view.scrollStateOf(list)?.y ?? NaN;
  assert.ok(
    dragged > 80 && dragged < 100,
    `${dragged}, not snapped while held`,
  );
  assert.ok(p.view.scrollGestureOwed(list));
  await p.lift();
  await p.step(600);
  assert.equal(p.view.scrollStateOf(list)?.y, 80);
  assert.equal(p.view.scrollGestureOwed(list), false);
});
