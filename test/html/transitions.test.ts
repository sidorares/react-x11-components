// <Html> — transitions: `transition` and its longhands, what a style change
// starts, and how one under way turns back, runs on to a new end or stops.
import { afterEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert';
import type { DrawnNode } from 'react-x11';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import {
  NO_TRANSITIONS,
  parseTransition,
} from '../../src/html/css/animation.js';
import {
  AnimationTimeline,
  noteAnimated,
} from '../../src/html/css/timeline.js';
import { copyStyle, initialStyle } from '../../src/html/css/style.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { animationClock } from '../../src/html/node.js';
import { stacksLayers } from '../../src/html/paint.js';
import type { Box } from '../../src/html/layout/boxes.js';
import { Html } from '../../src/index.js';
import { holdClock } from '../held-clock.js';
import { FONTS, boxOf, h, render, view } from './harness.js';

afterEach(cleanup);

/** The computed style of the element with `id`. */
function styleOf(node: Parameters<typeof view>[0], id: string): ComputedStyle {
  return (boxOf(view(node), id) as unknown as { style: ComputedStyle }).style;
}

const near = (a: number, b: number, by = 1e-6) => Math.abs(a - b) <= by;

/** A document on a clock the test holds: `at(ms)` runs the frames up to
 *  then, and `hover(id)` moves the pointer over an element, or off every
 *  one, at the time the clock is at. */
async function holding(
  t: TestContext,
  source: string,
  props: Record<string, unknown> = {},
) {
  const clock = holdClock(t, animationClock);
  const { node } = await render(source, 400, props);
  const el = view(node);
  return {
    node,
    el,
    clock,
    style: (id: string) => styleOf(node, id),
    hover(id: string | null) {
      const abs = (el as unknown as DrawnNode).abs;
      if (id === null) {
        el.setHover(-1, -1);
        return;
      }
      const box = boxOf(el, id);
      el.setHover(abs.x + box.x + 2, abs.y + box.y + 2);
    },
    /** The frames up to `ms` on the held clock — which moves only while a
     *  frame waits, so a change that asks for none leaves it where it is. */
    async at(ms: number) {
      await act();
      while (animationClock.now() + 16 <= ms) {
        if (!(await clock.frame())) break;
      }
      await act();
    },
  };
}

test('`transition` and its longhands are read into their lists', async () => {
  const lists = parseTransition(
    'opacity 160ms ease-in 32ms, transform 1s allow-discrete',
  )!;
  assert.deepStrictEqual(lists.properties, ['opacity', 'transform']);
  assert.deepStrictEqual(lists.durations, [160, 1000]);
  assert.deepStrictEqual(lists.delays, [32, 0]);
  assert.deepStrictEqual(lists.behaviors, ['normal', 'allow-discrete']);
  assert.deepStrictEqual(parseTransition('none')!.properties, []);
  assert.strictEqual(parseTransition('none, opacity 1s'), null, 'none alone');
  assert.strictEqual(parseTransition('opacity -1s'), null, 'no duration');
  const { node } = await render(
    '<style>#a { transition: opacity 1s; transition-delay: 2s, 3s }' +
      '#b { -webkit-transition: color .5s linear }' +
      '#c { transition-property: none }</style>' +
      '<p id="a">a</p><p id="b">b</p><p id="c">c</p><p id="d">d</p>',
  );
  const a = styleOf(node, 'a').transitions;
  assert.deepStrictEqual(
    [a.properties, a.durations, a.delays],
    [['opacity'], [1000], [2000, 3000]],
  );
  const b = styleOf(node, 'b').transitions;
  assert.deepStrictEqual([b.properties, b.durations], [['color'], [500]]);
  assert.deepStrictEqual(styleOf(node, 'c').transitions.properties, []);
  assert.strictEqual(styleOf(node, 'd').transitions, NO_TRANSITIONS);
});

test('a hover that changes a property a transition names runs it, from the value before through its timing function to the value after, and then asks for no frame', async (t) => {
  const doc = await holding(
    t,
    '<style>#a { width: 40px; height: 20px; transition: opacity 160ms linear }' +
      '#a:hover { opacity: .2 }</style><div id="a"></div>',
  );
  assert.strictEqual(doc.clock.pending, false, 'nothing to run yet');
  doc.hover('a');
  await act();
  assert.strictEqual(doc.style('a').opacity, 1, 'where it starts');
  assert.strictEqual(doc.clock.pending, true, 'frames of it');
  await doc.at(80);
  assert.ok(near(doc.style('a').opacity, 0.6), `${doc.style('a').opacity}`);
  await doc.at(176);
  assert.ok(near(doc.style('a').opacity, 0.2));
  assert.strictEqual(doc.clock.pending, false, 'over');
});

test('a transition holds where it starts through its delay', async (t) => {
  const doc = await holding(
    t,
    '<style>#a { width: 40px; height: 20px;' +
      ' transition: opacity 160ms linear 64ms } #a:hover { opacity: .2 }' +
      '</style><div id="a"></div>',
  );
  doc.hover('a');
  await doc.at(48);
  assert.strictEqual(doc.style('a').opacity, 1, 'in its delay');
  await doc.at(64 + 80);
  assert.ok(near(doc.style('a').opacity, 0.6), `${doc.style('a').opacity}`);
});

test('a hover let go of half way turns back, in half the time', async (t) => {
  const doc = await holding(
    t,
    '<style>#a { width: 40px; height: 20px; transition: opacity 160ms linear }' +
      '#a:hover { opacity: .2 }</style><div id="a"></div>',
  );
  doc.hover('a');
  await doc.at(80);
  assert.ok(near(doc.style('a').opacity, 0.6));
  doc.hover(null);
  await act();
  assert.ok(near(doc.style('a').opacity, 0.6), 'from where it was');
  // back over half the way it came, in half the time: 0.6 to 1 in 80ms
  await doc.at(80 + 48);
  assert.ok(near(doc.style('a').opacity, 0.84), `${doc.style('a').opacity}`);
  await doc.at(80 + 96);
  assert.strictEqual(doc.style('a').opacity, 1);
  assert.strictEqual(doc.clock.pending, false);
});

test('what transitions and what does not: the first style nothing, a keyword at once, and a document that runs no animation none of it', async (t) => {
  const page =
    '<style>#a { width: 40px; height: 20px; opacity: .5;' +
    ' transition: all 160ms linear } #a:hover { opacity: 1;' +
    ' text-align: center }</style><div id="a">x</div>';
  const doc = await holding(t, page);
  assert.strictEqual(doc.clock.pending, false, 'drawn as it is at first');
  doc.hover('a');
  await act();
  assert.strictEqual(doc.style('a').textAlign, 'center', 'a keyword at once');
  assert.strictEqual(doc.style('a').opacity, 0.5, 'a number from where it was');
  await doc.at(80);
  assert.ok(near(doc.style('a').opacity, 0.75));
  const still = await holding(t, page, { animate: false });
  still.hover('a');
  await act();
  assert.strictEqual(still.style('a').opacity, 1, 'at once');
  assert.strictEqual(still.clock.pending, false);
});

test('an inherited property in transition is what the element holds inherits, at every frame', async (t) => {
  const doc = await holding(
    t,
    '<style>#a { color: #000000; transition: color 160ms linear }' +
      '#a:hover { color: #ffffff }</style>' +
      '<div id="a"><span id="in">text</span></div>',
  );
  doc.hover('a');
  await doc.at(80);
  const mid = doc.style('a').color;
  assert.notStrictEqual(mid, '#000000');
  assert.notStrictEqual(mid, '#ffffff');
  assert.strictEqual(doc.style('in').color, mid, 'the child at the same frame');
});

test('a transition makes the stacking context an animation of its property would, from its delay to its end: an opacity at 1 is one while it waits to fall', async (t) => {
  // Web Animations 1, 5.6, which CSS transitions are animations under
  const doc = await holding(
    t,
    '<style>#b { width: 40px; height: 20px;' +
      ' transition: opacity 160ms linear 64ms } #b:hover { opacity: .5 }' +
      '</style><div id="b"></div>',
  );
  const stacks = () => stacksLayers(boxOf(doc.el, 'b') as unknown as Box);
  assert.strictEqual(stacks(), false, 'none before');
  doc.hover('b');
  await doc.at(32);
  assert.strictEqual(doc.style('b').opacity, 1, 'in its delay');
  assert.strictEqual(stacks(), true, 'a stacking context for all that');
  await doc.at(240);
  assert.strictEqual(doc.style('b').opacity, 0.5);
  assert.strictEqual(doc.clock.pending, false, 'over');
});

test('a stylesheet that arrives later starts no transition: the change it makes is not one a browser that waits for it shows', async (t) => {
  holdClock(t, animationClock);
  let arrive!: (sheet: { kind: 'stylesheet'; text: string }) => void;
  const late = new Promise<{ kind: 'stylesheet'; text: string }>((r) => {
    arrive = r;
  });
  await renderX11(
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>p { color: #000000; transition: color 1s linear }</style>' +
          '<link rel="stylesheet" href="a.css"><p id="p">text</p>',
        partial: false,
        onResource: (r: { kind: string }) =>
          r.kind === 'stylesheet' ? late : null,
        'data-testname': 'doc',
      }),
    ),
    FONTS
      ? { width: 340, height: 300, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  const node = screen.getByTestName('doc') as DrawnNode;
  assert.strictEqual(styleOf(node, 'p').color, '#000000');
  arrive({ kind: 'stylesheet', text: 'p { color: #ff0000 }' });
  await act();
  await act();
  assert.strictEqual(styleOf(node, 'p').color, '#ff0000', 'at once');
});

test('one under way: turned back, it runs back as far as it came; given a new end, it runs on from where it is; no longer named, it is at its new value at once', () => {
  const base = initialStyle(LOOK, 1);
  base.transitions = parseTransition('opacity 100ms linear')!;
  const at = (opacity: number, transitions = base.transitions) => {
    const s = copyStyle(base);
    s.opacity = opacity;
    s.transitions = transitions;
    return s;
  };
  const tl = new AnimationTimeline();
  const el = {};
  let drawn = at(1);
  const step = (now: number, after: ComputedStyle) => {
    tl.now = now;
    const was = drawn;
    drawn = tl.transition(el, '', after, () => was);
    return drawn.opacity;
  };
  assert.strictEqual(step(0, at(0)), 1, 'from where it was');
  assert.ok(near(step(40, at(0)), 0.6));
  // back where it came from: 0.6 to 1 in 40ms, as far as it had come
  assert.ok(near(step(40, at(1)), 0.6));
  assert.ok(near(step(60, at(1)), 0.8));
  assert.strictEqual(step(80, at(1)), 1, 'back');
  // to a new end, from where it is, in the whole of its duration
  assert.strictEqual(step(100, at(0)), 1);
  assert.ok(near(step(150, at(0)), 0.5));
  assert.ok(near(step(150, at(0.25)), 0.5), 'on from where it is');
  assert.ok(near(step(200, at(0.25)), 0.375));
  // its property no longer named: the new value at once
  const none = parseTransition('none')!;
  assert.strictEqual(step(210, at(0.25, none)), 0.25);
  assert.strictEqual(tl.isLive(el), false);
});

test('a property an animation sets starts no transition, though the animation changes it every frame, nor where an animation starts or stops setting it', async (t) => {
  // CSS Transitions 1, 3: the style before a change has the animations
  // brought up to the time of the change, so what they change is none
  const doc = await holding(
    t,
    '<style>@keyframes fade { from { opacity: 0 } to { opacity: 1 } }' +
      'div { width: 40px; height: 20px; transition: opacity 160ms linear }' +
      '#a { animation: fade 320ms linear infinite }' +
      '#b { opacity: .5; animation: fade 320ms linear infinite }' +
      '#b:hover { animation: none }' +
      '#c { opacity: .5 } #c:hover { animation: fade 320ms linear infinite }' +
      '</style><div id="a"></div><div id="b"></div><div id="c"></div>',
  );
  const transiting = (id: string) =>
    (
      doc.el as unknown as { _timeline: AnimationTimeline }
    )._timeline.transiting(boxOf(doc.el, id).el!);
  await doc.at(48);
  assert.ok(near(doc.style('a').opacity, 0.15), `${doc.style('a').opacity}`);
  await doc.at(96);
  assert.ok(near(doc.style('a').opacity, 0.3), `${doc.style('a').opacity}`);
  assert.strictEqual(transiting('a'), false, 'the animation’s frames are none');
  // an animation that stops setting it leaves its own value, at once
  doc.hover('b');
  await act();
  assert.strictEqual(doc.style('b').opacity, 0.5);
  assert.strictEqual(transiting('b'), false);
  // and one that starts setting it, its first frame
  doc.hover('c');
  await act();
  assert.strictEqual(doc.style('c').opacity, 0);
  assert.strictEqual(transiting('c'), false);
});

test('a transition under way that an animation starts on runs on beneath it, the animation’s value over it, and is where it has got to once the animation stops', () => {
  const base = initialStyle(LOOK, 1);
  base.transitions = parseTransition('opacity 100ms linear')!;
  const at = (opacity: number) => {
    const s = copyStyle(base);
    s.opacity = opacity;
    return s;
  };
  const tl = new AnimationTimeline();
  const el = {};
  const fading = new Set(['opacity']);
  let drawn = at(1);
  const step = (now: number, after: ComputedStyle, animated = false) => {
    tl.now = now;
    const was = drawn;
    drawn = tl.transition(el, '', after, () => was, animated ? fading : null);
    if (animated) noteAnimated(drawn, fading);
    return drawn.opacity;
  };
  assert.strictEqual(step(0, at(0)), 1);
  assert.ok(near(step(40, at(0)), 0.6));
  // an animation of the opacity starts: its value is the element's
  assert.strictEqual(step(50, at(0.9), true), 0.9);
  assert.strictEqual(step(60, at(0.8), true), 0.8, 'its frames, as written');
  // and stops: the transition has run on, to where it is at 70ms of 100
  assert.ok(near(step(70, at(0)), 0.3), `${drawn.opacity}`);
  assert.strictEqual(step(100, at(0)), 0);
  // what an animation leaves as it stops is no change to run from
  step(110, at(0.4), true);
  assert.strictEqual(step(120, at(0)), 0, 'at once');
  assert.strictEqual(tl.isLive(el), false);
});

/** A palette to make an initial style from, every colour its own. */
const LOOK = {
  color: '#010101',
  fontFamily: 'sans-serif',
  fontSize: 14,
  monoFamily: 'monospace',
  linkColor: '#020202',
  borderColor: '#030303',
  mutedColor: '#040404',
  background: '#050505',
  colorScheme: 'light' as const,
  surface: '#060606',
  controlPadY: 4,
  controlBorder: 1,
  controlRadius: 4,
};
