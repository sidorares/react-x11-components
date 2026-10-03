// <Html> — animations: `@keyframes`, `animation` and its longhands, the
// values an animation passes through as it runs, and what one leaves on a
// style where none runs.
import { afterEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert';
import type { DrawnNode } from 'react-x11';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import { parseStylesheet } from '../../src/html/css/parse.js';
import {
  NO_ANIMATIONS,
  animationLonghand,
  ease,
  parseAnimation,
  parseEasing,
  parseTime,
  progressAt,
} from '../../src/html/css/animation.js';
import type { Timing } from '../../src/html/css/animation.js';
import { blend } from '../../src/html/css/color.js';
import {
  interpolateField,
  interpolateTransforms,
} from '../../src/html/css/interpolate.js';
import {
  parseRotate,
  parseTransform,
  primitiveSolid,
} from '../../src/html/css/transform.js';
import type { Turn } from '../../src/html/css/transform.js';
import {
  interpolateMatrix4,
  multiply4,
  perspective4,
  rotate4,
  translate4,
} from '../../src/html/css/transform3d.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { animationClock } from '../../src/html/node.js';
import type { DocumentSprite } from '../../src/html/sprites.js';
import { fixedToViewport, stacksLayers } from '../../src/html/paint.js';
import type { Box } from '../../src/html/layout/boxes.js';
import type { HtmlViewNode } from '../../src/html/node.js';
import { SpriteStore } from '../../src/html/surfaces.js';
import { Html } from '../../src/index.js';
import { holdClock } from '../held-clock.js';
import {
  FONTS,
  boxOf,
  h,
  metric,
  render,
  render2x,
  snapshot,
  treeOf,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

/** A document drawn with its animations at rest: each as it stands once
 *  it has run one iteration at no length. */
const rest = (source: string) => render(source, 400, { animate: false });

/** The computed style of the element with `id`. */
function styleOf(node: Parameters<typeof view>[0], id: string): ComputedStyle {
  return (boxOf(view(node), id) as unknown as { style: ComputedStyle }).style;
}

test('@keyframes is read into its frames', () => {
  const sheet = parseStylesheet(
    '@keyframes slide {' +
      ' from { top: -500px; opacity: 1 !important }' +
      ' 20%, 40.5% { top: 50%; animation-timing-function: ease-in;' +
      ' animation-duration: 3s; transition: none }' +
      ' 120% { top: 0 }' +
      ' to { top: 10px } }' +
      '@-webkit-keyframes "quoted name" { to { color: red } }' +
      '@-moz-keyframes slide { to { top: 1px } }' +
      '@keyframes none { to { top: 1px } }' +
      '@keyframes two words { to { top: 1px } }' +
      'p { color: blue }',
  );
  const keyframes = sheet.keyframes ?? [];
  assert.deepStrictEqual(
    keyframes.map((k) => [k.name, k.prefixed]),
    [
      ['slide', false],
      ['quoted name', true],
    ],
  );
  const [slide] = keyframes;
  // a frame's `!important` declaration is ignored, and so is a frame whose
  // selector is no offset; the animation's own properties are not a
  // frame's, but for the easing it takes to the next one
  assert.deepStrictEqual(
    slide.frames.map((f) => ({
      offsets: f.offsets,
      props: f.declarations.map((d) => `${d.prop}: ${d.value}`),
      easing: f.easing,
    })),
    [
      { offsets: [0], props: ['top: -500px'], easing: null },
      { offsets: [0.2, 0.405], props: ['top: 50%'], easing: 'ease-in' },
      { offsets: [1], props: ['top: 10px'], easing: null },
    ],
  );
  // the style rule after them is still read
  assert.strictEqual(sheet.rules.length, 1);
});

test('the animation shorthand reads its longhands in any order', () => {
  const marquee = parseAnimation('marquee 15s infinite linear')!;
  assert.deepStrictEqual(marquee.names, ['marquee']);
  assert.deepStrictEqual(marquee.durations, [15000]);
  assert.deepStrictEqual(marquee.iterations, [Infinity]);
  assert.deepStrictEqual(marquee.easings, [{ type: 'linear' }]);
  assert.deepStrictEqual(marquee.fillModes, ['none']);

  // the first time is the duration and the second the delay
  const timed = parseAnimation('1s -250ms slide, .5s fade both')!;
  assert.deepStrictEqual(timed.names, ['slide', 'fade']);
  assert.deepStrictEqual(timed.durations, [1000, 500]);
  assert.deepStrictEqual(timed.delays, [-250, 0]);
  assert.deepStrictEqual(timed.fillModes, ['none', 'both']);

  // a keyword is its longhand's first, and only then a name: `none` is a
  // fill mode, and a second `ease` names the animation
  const none = parseAnimation('none')!;
  assert.deepStrictEqual(none.names, [null]);
  assert.deepStrictEqual(none.fillModes, ['none']);
  const named = parseAnimation('ease ease 2 reverse paused forwards')!;
  assert.deepStrictEqual(named.names, ['ease']);
  assert.deepStrictEqual(named.iterations, [2]);
  assert.deepStrictEqual(named.directions, ['reverse']);
  assert.deepStrictEqual(named.playStates, ['paused']);
  assert.deepStrictEqual(named.fillModes, ['forwards']);
  assert.deepStrictEqual(parseAnimation('1s forwards slide')!.names, ['slide']);

  // what is none: three times, a negative duration, two names, `inherit`
  // inside a list, an empty item
  for (const bad of [
    '1s 2s 3s a',
    '-1s a',
    'a b',
    'a, inherit',
    'a,,b',
    '1s 3px',
  ]) {
    assert.strictEqual(parseAnimation(bad), null, bad);
  }
});

test('a longhand sets its own list, and the others keep theirs', () => {
  let a = parseAnimation('a 1s, b 2s')!;
  a = animationLonghand(a, 'durations', '9s')!;
  a = animationLonghand(a, 'delays', '.1s, 200ms')!;
  assert.deepStrictEqual(a.names, ['a', 'b']);
  assert.deepStrictEqual(a.durations, [9000]);
  assert.deepStrictEqual(a.delays, [100, 200]);
  assert.deepStrictEqual(
    animationLonghand(NO_ANIMATIONS, 'names', 'none, x')!.names,
    [null, 'x'],
  );
  assert.strictEqual(animationLonghand(a, 'durations', '-1s'), null);
  assert.strictEqual(animationLonghand(a, 'delays', '0'), null);
  assert.strictEqual(animationLonghand(a, 'iterations', '-1'), null);
  assert.strictEqual(animationLonghand(a, 'fillModes', 'forward'), null);
  assert.strictEqual(animationLonghand(a, 'names', 'initial'), null);
});

test('a time is in seconds or milliseconds, and calc() adds them', () => {
  assert.strictEqual(parseTime('2s'), 2000);
  assert.strictEqual(parseTime('150MS'), 150);
  assert.strictEqual(parseTime('calc(1s + 100ms)'), 1100);
  assert.strictEqual(parseTime('0'), null);
  assert.strictEqual(parseTime('2'), null);
});

test('easing functions: keywords, cubic-bezier(), steps() and linear()', () => {
  assert.deepStrictEqual(parseEasing('ease-out'), {
    type: 'cubic',
    x1: 0,
    y1: 0,
    x2: 0.58,
    y2: 1,
  });
  assert.deepStrictEqual(parseEasing('cubic-bezier(0.1, -0.6, 0.2, 1.5)'), {
    type: 'cubic',
    x1: 0.1,
    y1: -0.6,
    x2: 0.2,
    y2: 1.5,
  });
  // an x outside the interval is no time
  assert.strictEqual(parseEasing('cubic-bezier(1.1, 0, 0, 1)'), null);
  assert.deepStrictEqual(parseEasing('steps(4)'), {
    type: 'steps',
    count: 4,
    position: 'jump-end',
  });
  assert.deepStrictEqual(parseEasing('step-start'), {
    type: 'steps',
    count: 1,
    position: 'jump-start',
  });
  assert.deepStrictEqual(parseEasing('steps(2, start)'), {
    type: 'steps',
    count: 2,
    position: 'jump-start',
  });
  assert.strictEqual(parseEasing('steps(1, jump-none)'), null);
  assert.strictEqual(parseEasing('steps(1.5)'), null);
  // the inputs a linear() leaves out are placed: the ends at 0 and 1, an
  // input under one before it raised to it, and the rest spread between
  assert.deepStrictEqual(parseEasing('linear(0, 0.25 75%, 0.5 50%, 0.9, 1)'), {
    type: 'points',
    points: [
      { input: 0, output: 0 },
      { input: 0.75, output: 0.25 },
      { input: 0.75, output: 0.5 },
      { input: 0.875, output: 0.9 },
      { input: 1, output: 1 },
    ],
  });
  assert.deepStrictEqual(parseEasing('linear(0, 1 20% 80%)'), {
    type: 'points',
    points: [
      { input: 0, output: 0 },
      { input: 0.2, output: 1 },
      { input: 0.8, output: 1 },
    ],
  });
  assert.strictEqual(parseEasing('linear(0)'), null);
  assert.strictEqual(parseEasing('bounce'), null);
});

test('an animation that fills forwards leaves the frame it ends on', async () => {
  // what Chrome holds a page at with every animation run at no length,
  // which is how the Zen Garden bench captures it
  const { node } = await rest(
    '<style>' +
      '@keyframes show { from { opacity: 0 } 50% { color: blue }' +
      ' to { opacity: .5; margin-left: 2em } }' +
      '#forwards { animation: show 1s forwards; font-size: 10px }' +
      '#both { animation: show 1s 2s infinite both }' +
      '#none { animation: show 1s }' +
      '#backwards { animation: show 1s backwards }' +
      '#reverse { animation: show 1s reverse forwards }' +
      '#alternate { animation: show 1s alternate-reverse forwards }' +
      '#missing { animation: nothing 1s forwards }' +
      '</style>' +
      '<p id="forwards">x</p><p id="both">x</p><p id="none">x</p>' +
      '<p id="backwards">x</p><p id="reverse">x</p><p id="alternate">x</p>' +
      '<p id="missing">x</p>',
  );
  const style = (id: string) => styleOf(node, id);
  for (const id of ['forwards', 'both']) {
    assert.strictEqual(style(id).opacity, 0.5, id);
    // an em in a frame is the element's own
    assert.strictEqual(style(id).marginLeft, 2 * style(id).fontSize, id);
  }
  assert.strictEqual(style('forwards').marginLeft, 20);
  // nothing else, and the frame between is no frame it ends on
  for (const id of ['none', 'backwards', 'missing']) {
    assert.strictEqual(style(id).opacity, 1, id);
    assert.strictEqual(style(id).marginLeft, 0, id);
  }
  assert.strictEqual(style('forwards').color, style('none').color);
  // played backwards, it ends on its `from`
  for (const id of ['reverse', 'alternate']) {
    assert.strictEqual(style(id).opacity, 0, id);
    assert.strictEqual(style(id).marginLeft, 0, id);
  }
});

test('an animation is over the author’s declarations and under their !important ones', async () => {
  const { node } = await rest(
    '<style>' +
      '@keyframes a { to { opacity: .25; z-index: 3 } }' +
      '@keyframes b { to { opacity: .5 } }' +
      '#over { opacity: .9; z-index: 9 !important;' +
      ' animation: a 1s forwards, b 1s forwards; position: relative }' +
      '#order { animation: b 1s forwards, a 1s forwards }' +
      '</style>' +
      '<p id="over" style="opacity: .8">x</p><p id="order">x</p>',
  );
  // over a rule and the inline style, and the later animation over the
  // earlier; under an !important
  assert.strictEqual(styleOf(node, 'over').opacity, 0.5);
  assert.strictEqual(styleOf(node, 'over').zIndex, 9);
  assert.strictEqual(styleOf(node, 'order').opacity, 0.25);
});

test('which @keyframes a name finds', async () => {
  const { node } = await rest(
    '<style>' +
      // the last of a name, but that a prefixed rule never replaces one
      // that is not, wherever it comes
      '@keyframes k { to { opacity: .1 } }' +
      '@keyframes k { to { opacity: .2 } }' +
      '@-webkit-keyframes k { to { opacity: .3 } }' +
      '@-webkit-keyframes w { to { opacity: .3 } }' +
      '@-webkit-keyframes w { to { opacity: .4 } }' +
      // one whose media do not hold is none
      '@keyframes m { to { opacity: .5 } }' +
      '@media (max-width: 100px) { @keyframes m { to { opacity: .6 } } }' +
      // a later layer over an earlier, and no layer over any
      '@layer one, two;' +
      '@keyframes l { to { opacity: .7 } }' +
      '@layer two { @keyframes l { to { opacity: .8 } } }' +
      '@layer one { @keyframes l { to { opacity: .9 } } }' +
      '@layer two { @keyframes n { to { opacity: .8 } } }' +
      '@layer one { @keyframes n { to { opacity: .9 } } }' +
      // the frames at one offset merge, a later one's over an earlier
      '@keyframes merged { to { opacity: .1; z-index: 2 } 100% { opacity: .2 } }' +
      '#k { animation: k 1s forwards } #w { animation: w 1s forwards }' +
      '#m { animation: m 1s forwards } #l { animation: l 1s forwards }' +
      '#n { animation: n 1s forwards }' +
      '#merged { animation: merged 1s forwards; position: relative }' +
      '</style>' +
      '<p id="k">x</p><p id="w">x</p><p id="m">x</p><p id="l">x</p>' +
      '<p id="n">x</p><p id="merged">x</p>',
  );
  const opacity = (id: string) => styleOf(node, id).opacity;
  assert.strictEqual(opacity('k'), 0.2);
  assert.strictEqual(opacity('w'), 0.4);
  assert.strictEqual(opacity('m'), 0.5);
  assert.strictEqual(opacity('l'), 0.7);
  assert.strictEqual(opacity('n'), 0.8);
  assert.strictEqual(opacity('merged'), 0.2);
  assert.strictEqual(styleOf(node, 'merged').zIndex, 2);
});

test('each longhand of the animation inherits and resets on its own', async () => {
  const { node } = await rest(
    '<style>' +
      '@keyframes a { to { opacity: .5 } }' +
      '#outer { animation: a 1s forwards }' +
      '#inner { -webkit-animation-name: a; animation-fill-mode: inherit }' +
      '#reset { animation: a 1s forwards; animation-fill-mode: initial }' +
      '</style>' +
      '<div id="outer"><p id="inner">x</p></div><p id="reset">x</p>',
  );
  // not inherited: the outer's opacity is its own, and the inner's comes
  // of its own animation, its fill mode taken from the outer
  assert.strictEqual(styleOf(node, 'inner').opacity, 0.5);
  assert.deepStrictEqual(styleOf(node, 'inner').animations.durations, [0]);
  assert.strictEqual(styleOf(node, 'reset').opacity, 1);
});

test('a design that cycles its panels shows them as they are without one', async () => {
  // Zen Garden 219: every panel is hidden, and an infinite animation that
  // fills nothing makes each visible in turn
  const { node } = await rest(
    '<style>' +
      '@keyframes slider { from { visibility: visible; top: -500px }' +
      ' 1% { visibility: visible; top: 50% } 20% { visibility: hidden }' +
      ' to { visibility: hidden; top: 50% } }' +
      '#panel { visibility: hidden; animation: slider 100s infinite linear }' +
      '</style><div id="panel">x</div>',
  );
  assert.strictEqual(styleOf(node, 'panel').visibility, 'hidden');
  assert.deepStrictEqual(styleOf(node, 'panel').animations.names, ['slider']);
});

// --- running -------------------------------------------------------------------

/**
 * A document whose animations run on a held clock: `at(ms)` takes the frames
 * up to that time, a frame each 16 ms, and lets the document draw what they
 * restyled.
 */
async function running(
  t: TestContext,
  source: string,
  width = 400,
  how: typeof render = render,
) {
  const clock = holdClock(t, animationClock);
  const { node, result } = await how(source, width);
  const el = view(node);
  let time = 0;
  return {
    node,
    result,
    el,
    clock,
    style: (id: string) => styleOf(node, id),
    async at(ms: number) {
      while (time + 16 <= ms) {
        time += 16;
        if (!(await clock.frame())) break;
      }
      time = ms;
      await act();
    },
  };
}

/** `render`, in a pane 200px tall that scrolls the document. */
async function inPane(source: string, width = 400) {
  const result = await renderX11(
    h(
      'box',
      {
        'data-testname': 'pane',
        style: { width, height: 200, overflow: 'scroll' },
      },
      h(Html, { source, partial: false, 'data-testname': 'doc' }),
    ),
    FONTS
      ? { width: width + 40, height: 300, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return { result, node: screen.getByTestName('doc') as DrawnNode };
}

test('an animation runs its frames as time passes, and is over at its end', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { from { opacity: 0 } to { opacity: 1 } }' +
      '#a { animation: fade 160ms linear; opacity: .8 }</style>' +
      '<p id="a">x</p>',
  );
  assert.strictEqual(doc.style('a').opacity, 0);
  await doc.at(80);
  assert.strictEqual(doc.style('a').opacity, 0.5);
  await doc.at(160);
  // filling nothing, it leaves the element's own value
  assert.strictEqual(doc.style('a').opacity, 0.8);
  assert.strictEqual(doc.clock.pending, false, 'no frame is asked for');
});

test('a delay, a fill, iterations and a direction', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes slide { from { margin-left: 0 } to { margin-left: 100px } }' +
      'p { margin-left: 7px }' +
      '#back { animation: slide 160ms 32ms linear backwards }' +
      '#late { animation: slide 160ms 32ms linear }' +
      '#alt { animation: slide 160ms 2 alternate linear forwards }' +
      '#rev { animation: slide 160ms reverse linear }</style>' +
      '<p id="back">x</p><p id="late">x</p><p id="alt">x</p><p id="rev">x</p>',
  );
  const left = (id: string) => round(doc.style(id).marginLeft as number);
  // before its delay: its first frame where it fills backwards, and the
  // element's own value where it does not
  assert.strictEqual(left('back'), 0);
  assert.strictEqual(left('late'), 7);
  assert.strictEqual(left('rev'), 100);
  await doc.at(112);
  assert.strictEqual(left('back'), 50);
  assert.strictEqual(left('late'), 50);
  assert.strictEqual(left('alt'), 70);
  assert.strictEqual(left('rev'), 30);
  // the second iteration of an alternating one plays backwards
  await doc.at(240);
  assert.strictEqual(left('alt'), 50);
  // and filling forwards, it holds where its last iteration ended: at its
  // `from`, having played back to it
  await doc.at(320);
  assert.strictEqual(left('alt'), 0);
  assert.strictEqual(left('back'), 7);
});

test('an animation acts as though will-change named what it sets: a stacking context from its delay to its end, at an opacity of 1 as well, and for good where it fills forwards; a transform holds what is fixed in it as long', async (t) => {
  // Web Animations 1, 5.6: every property an animation that is current or
  // in effect sets, as though `will-change` named it
  const doc = await running(
    t,
    '<style>@keyframes fade { from { opacity: 1 } to { opacity: .5 } }' +
      '@keyframes rise { from { opacity: .5 } to { opacity: 1 } }' +
      '@keyframes slide { to { transform: translateX(10px) } }' +
      'div { width: 20px; height: 20px }' +
      '#late { animation: fade 160ms 64ms linear }' +
      '#first { animation: fade 160ms linear }' +
      '#held { animation: rise 160ms linear forwards }' +
      '#moved { animation: slide 160ms 64ms linear }' +
      '#pinned { position: fixed; top: 0 }</style>' +
      '<div id="late"></div><div id="first"></div><div id="held"></div>' +
      '<div id="moved"><div id="pinned"></div></div>',
  );
  const stacks = (id: string) =>
    stacksLayers(boxOf(doc.el, id) as unknown as Box);
  const pinned = () =>
    fixedToViewport(boxOf(doc.el, 'pinned') as unknown as Box);
  assert.strictEqual(doc.style('late').opacity, 1);
  assert.strictEqual(stacks('late'), true, 'in its delay');
  assert.strictEqual(doc.style('first').opacity, 1);
  assert.strictEqual(stacks('first'), true, 'at an opacity of 1');
  assert.strictEqual(pinned(), false, "held by a transform's delay");
  await doc.at(240);
  assert.strictEqual(stacks('late'), false, 'over');
  assert.strictEqual(stacks('first'), false, 'over');
  assert.strictEqual(doc.style('held').opacity, 1);
  assert.strictEqual(stacks('held'), true, 'filling forwards');
  assert.strictEqual(pinned(), true, 'fixed to the viewport once it is over');
});

test('a turn is interpolated by its angle, a whole one included', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }' +
      '#s { animation: spin 256ms linear infinite; width: 10px; height: 10px }' +
      '</style><div id="s"></div>',
  );
  const angle = () => {
    const [fn] = doc.style('s').transform!;
    assert.ok('fn' in fn && fn.fn?.kind === 'rotate');
    return fn.fn.angle;
  };
  const tree = treeOf(doc.el);
  await doc.at(64);
  assert.strictEqual(angle(), 90);
  await doc.at(192);
  assert.strictEqual(angle(), 270);
  // a transform moves nothing else: restyled in place, frame by frame
  assert.ok(treeOf(doc.el) === tree, 'the document was built again');
  // round again, for ever
  await doc.at(320);
  assert.strictEqual(angle(), 90);
  assert.strictEqual(doc.clock.pending, true);
});

test('translate, rotate and scale run out of the plane: a depth by its value, and a turn about one axis to one about another through the turn between them', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes tilt { from { rotate: x 90deg } to { rotate: y 90deg } }' +
      '@keyframes rise { to { translate: 0 0 100px; scale: 1 1 3 } }' +
      '#a { animation: tilt 256ms linear; width: 10px; height: 10px }' +
      '#b { animation: rise 256ms linear; width: 10px; height: 10px }' +
      '</style><div id="a"></div><div id="b"></div>',
  );
  const tree = treeOf(doc.el);
  await doc.at(128);
  // halfway from a quarter about one axis to a quarter about the other: a
  // turn about the axis between them
  const tilt = doc.style('a').rotate!;
  const angle = (2 * Math.acos(Math.sqrt(2 / 3)) * 180) / Math.PI;
  assert.ok(
    tilt.kind === 'rotate3d' &&
      near(tilt.x, Math.SQRT1_2, 1e-9) &&
      near(tilt.y, Math.SQRT1_2, 1e-9) &&
      near(tilt.z, 0, 1e-9) &&
      near(tilt.angle, angle, 1e-9),
    JSON.stringify(tilt),
  );
  // from `none`, which is nothing in depth as well
  assert.deepStrictEqual(doc.style('b').translate, [0, 0, 50]);
  assert.deepStrictEqual(doc.style('b').scale, [1, 1, 2]);
  assert.ok(treeOf(doc.el) === tree, 'the document was built again');
});

test('colours, lengths of two kinds, visibility, and a value that goes over half-way', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes all {' +
      ' from { background-color: #000; top: -500px; visibility: hidden; text-align: left }' +
      ' to { background-color: #fff; top: 50%; visibility: hidden; text-align: right } }' +
      '@keyframes show { from { visibility: hidden } to { visibility: visible } }' +
      '#a { animation: all 160ms linear; position: relative }' +
      '#v { animation: show 160ms linear; visibility: hidden }' +
      '</style><div id="a">x</div><div id="v">x</div>',
  );
  await doc.at(64);
  const a = doc.style('a');
  assert.strictEqual(a.backgroundColor, blend('#000', '#fff', 0.4));
  assert.deepStrictEqual(a.top, { pct: 20, px: -300 });
  assert.strictEqual(a.visibility, 'hidden');
  assert.strictEqual(a.textAlign, 'left');
  // visible all the way between an end that is and one that is not
  assert.strictEqual(doc.style('v').visibility, 'visible');
  await doc.at(96);
  assert.strictEqual(doc.style('a').textAlign, 'right');
});

test('a frame eases to the next by its own timing function', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes e {' +
      ' from { opacity: 0; animation-timing-function: steps(2, end) }' +
      ' 50% { opacity: .5 } to { opacity: 1 } }' +
      '#a { animation: e 160ms steps(4, start) }</style><p id="a">x</p>',
  );
  // the first half steps twice, by its frame's own function
  await doc.at(32);
  assert.strictEqual(doc.style('a').opacity, 0);
  await doc.at(48);
  assert.strictEqual(doc.style('a').opacity, 0.25);
  // the second by the animation's: four steps, each at its start — a
  // fifth of the way through the half is past the first
  await doc.at(96);
  assert.strictEqual(doc.style('a').opacity, 0.625);
});

test('what an animation does to an inherited property reaches what the element holds', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes c { from { color: #000000 } to { color: #ffffff } }' +
      '@keyframes f { from { opacity: 0 } to { opacity: 1 } }' +
      '#p { animation: c 160ms linear } #b { animation: f 160ms linear }' +
      '#b::before { content: "x"; animation: f 160ms linear reverse }' +
      '</style><p id="p">a <span id="s">b</span></p><p id="b">x</p>',
  );
  // a pseudo-element's animations run on their own
  const before = () =>
    (
      boxOf(doc.el, 'b').children.find(
        (box) => (box as LaidBox & { pseudo?: string }).pseudo === 'before',
      ) as unknown as { style: ComputedStyle }
    ).style;
  await doc.at(48);
  assert.strictEqual(round(doc.style('b').opacity), 0.3);
  assert.strictEqual(round(before().opacity), 0.7);
  // a colour and an opacity are restyled in place — but where an opacity
  // comes to 1 or leaves it, which paints the box as a group or not
  const tree = treeOf(doc.el);
  await doc.at(80);
  assert.strictEqual(doc.style('p').color, blend('#000000', '#ffffff', 0.5));
  assert.strictEqual(doc.style('s').color, doc.style('p').color);
  assert.ok(treeOf(doc.el) === tree, 'the document was built again');
});

metric(
  'a frame restyled in place draws what the document built again draws',
  async (t) => {
    // an opacity on a block and on a run of text, a colour inherited, a turn,
    // a visibility that comes on, and a pseudo-element's colour: each
    // restyled in place every frame, which has to come to the pixels a
    // build of the whole document at the same moment does
    const doc = await running(
      t,
      '<style>body { margin: 0; font: 14px sans-serif }' +
        '@keyframes f { from { opacity: .2 } to { opacity: .8 } }' +
        '@keyframes c { from { color: #ff0000 } to { color: #0000ff } }' +
        '@keyframes r { from { transform: rotate(0) } to { transform: rotate(90deg) } }' +
        '@keyframes v { 0%, 49% { visibility: hidden } 50%, 100% { visibility: visible } }' +
        '.box { width: 40px; height: 20px; background: #00aa00; margin: 4px }' +
        '#o, #i { animation: f 160ms linear } #p { animation: c 160ms linear }' +
        '#t { animation: r 160ms linear } #v { animation: v 160ms linear }' +
        '#b::before { content: "ab"; animation: c 160ms linear }</style>' +
        '<div class="box" id="o"></div>' +
        '<p>text <span id="i" style="background: #ffff00">fading</span> on</p>' +
        '<p id="p">red to <em>blue</em></p>' +
        '<div class="box" id="t"></div><div class="box" id="v"></div>' +
        '<p id="b">x</p>',
      300,
    );
    let tree = treeOf(doc.el);
    const frames: Uint8ClampedArray[] = [];
    for (const ms of [48, 96]) {
      await doc.at(ms);
      assert.ok(treeOf(doc.el) === tree, `built again by ${ms} ms`);
      const drawn = await snapshot(doc.result, doc.el);
      (doc.el as unknown as { _invalidate(stale: number): void })._invalidate(
        2,
      );
      const built = await snapshot(doc.result, doc.el);
      assert.ok(
        drawn.length === built.length && drawn.every((v, i) => v === built[i]),
        `at ${ms} ms the frame drew what a build does`,
      );
      frames.push(drawn);
      tree = treeOf(doc.el);
    }
    assert.ok(
      frames[0].some((v, i) => v !== frames[1][i]),
      'the animations drew something',
    );
  },
);

/** Each frame of `doc` at `times`: the rects it repainted — the node
 *  where it repainted all of it — and whether what it drew is what the
 *  document built again at the same moment draws. */
async function framesAgainstBuilds(
  doc: Awaited<ReturnType<typeof running>>,
  times: number[],
): Promise<{ repainted: unknown[]; frames: Uint8ClampedArray[] }> {
  const node = doc.el as unknown as {
    invalidate(...args: unknown[]): void;
  };
  const invalidate = node.invalidate.bind(node);
  let repainted: unknown[] = [];
  node.invalidate = (...args: unknown[]) => {
    repainted.push(args[1]);
    invalidate(...args);
  };
  const all: unknown[] = [];
  const frames: Uint8ClampedArray[] = [];
  for (const ms of times) {
    repainted = [];
    await doc.at(ms);
    all.push(...repainted);
    const drawn = await snapshot(doc.result, doc.el);
    (doc.el as unknown as { _invalidate(stale: number): void })._invalidate(2);
    const built = await snapshot(doc.result, doc.el);
    assert.ok(
      drawn.length === built.length && drawn.every((v, i) => v === built[i]),
      `at ${ms} ms the frame drew what a build does`,
    );
    frames.push(drawn);
  }
  return { repainted: all, frames };
}

metric(
  'a frame that lays out a box out of the flow again repaints that box, to the pixels a build draws',
  async (t) => {
    // Zen Garden 219's marquees: `text-indent` across a box placed
    // absolutely, which nothing around it is laid out by
    const doc = await running(
      t,
      '<style>body { margin: 0; font: 14px sans-serif }' +
        '@keyframes m { from { text-indent: 100% } to { text-indent: -100% } }' +
        '@keyframes s { from { left: 0 } to { left: 100px } }' +
        '#page { position: relative; height: 100px; background: #eeeeee }' +
        '#a { position: absolute; top: 30px; width: 150px; height: 20px;' +
        ' overflow: hidden; white-space: nowrap; background: #333333;' +
        ' color: #ffffff; animation: m 160ms linear infinite }' +
        '#b { position: absolute; top: 60px; width: 30px; height: 20px;' +
        ' background: #aa0000; animation: s 160ms linear infinite }</style>' +
        '<div id="page"><p>flow text stays</p><div id="a">a marquee name</div>' +
        '<div id="b"></div></div>',
      300,
    );
    const { repainted, frames } = await framesAgainstBuilds(doc, [48, 96]);
    assert.ok(repainted.length > 0, 'something was repainted');
    assert.ok(
      repainted.every((r) => r !== doc.el),
      'only what moved was repainted',
    );
    assert.ok(
      frames[0].some((v, i) => v !== frames[1][i]),
      'it moved',
    );
  },
);

metric(
  'a frame that lays out a box in the flow again repaints the document',
  async (t) => {
    const doc = await running(
      t,
      '<style>body { margin: 0; font: 14px sans-serif }' +
        '@keyframes s { from { margin-left: 0 } to { margin-left: 100px } }' +
        '#a { width: 30px; height: 20px; background: #aa0000;' +
        ' animation: s 160ms linear infinite }</style>' +
        '<div id="a"></div><p>text after it</p>',
      300,
    );
    const { repainted } = await framesAgainstBuilds(doc, [48, 96]);
    assert.ok(repainted.includes(doc.el), 'the document was repainted');
  },
);

metric(
  'a frame that moves a ::before or an ::after out of the flow repaints it, to the pixels a build draws',
  async (t) => {
    // Zen Garden 215's robot rises into the page as an `aside::after`: a
    // pseudo-element has no element of its own to compare, and its frames
    // repainted nothing
    const doc = await running(
      t,
      '<style>body { margin: 0 }' +
        '@keyframes rise { from { top: 80px } to { top: 0 } }' +
        '#page { position: relative; height: 100px; background: #eeeeee }' +
        '#page::after { content: ""; position: absolute; left: 20px;' +
        ' width: 30px; height: 20px; background: #aa0000;' +
        ' animation: rise 160ms linear infinite }</style>' +
        '<div id="page"></div>',
      300,
    );
    const { repainted, frames } = await framesAgainstBuilds(doc, [48, 96]);
    assert.ok(repainted.length > 0, 'something was repainted');
    assert.ok(
      repainted.every((r) => r !== doc.el),
      'only what moved was repainted',
    );
    assert.ok(
      frames[0].some((v, i) => v !== frames[1][i]),
      'it moved',
    );
  },
);

metric(
  'a frame of a box fixed to the viewport repaints it where the viewport has it, however far the pane has scrolled the document under it',
  async (t) => {
    // Zen Garden 215's starburst turns, fixed to the viewport, behind its
    // robot rising the same way: a frame repainted where each was laid out,
    // at the document's top, and they moved only as a scroll repainted them
    const doc = await running(
      t,
      '<style>body { margin: 0 } #tall { height: 1000px }' +
        '@keyframes spin { to { transform: rotate(360deg) } }' +
        '@keyframes rise { from { top: 120px } to { top: 40px } }' +
        '#star { position: fixed; top: 20px; left: 20px; width: 80px;' +
        ' height: 20px; background: #000080;' +
        ' animation: spin 160ms linear infinite }' +
        '#bot::after { content: ""; position: fixed; top: 40px; left: 200px;' +
        ' width: 40px; height: 40px; background: #aa0000;' +
        ' animation: rise 160ms linear infinite }</style>' +
        '<div id="tall"></div><div id="star"></div><div id="bot"></div>',
      400,
      inPane,
    );
    const pane = screen.getByTestName('pane') as DrawnNode & {
      scrollTo(y: number): void;
    };
    await act(async () => pane.scrollTo(100));
    const shot = async (): Promise<Uint8ClampedArray> => {
      await act();
      const { x, y, width, height } = pane.abs;
      return new Promise((ok, fail) =>
        (
          doc.result.ctx as unknown as {
            getImageData(
              x: number,
              y: number,
              w: number,
              h: number,
              cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
            ): void;
          }
        ).getImageData(x, y, width, height, (e, d) =>
          e ? fail(e) : ok(d.data),
        ),
      );
    };
    const frames: Uint8ClampedArray[] = [];
    for (const ms of [48, 96]) {
      await doc.at(ms);
      const drawn = await shot();
      // the whole element painted again, at the same moment
      (
        doc.el as unknown as { invalidate(layout: boolean, at: unknown): void }
      ).invalidate(false, doc.el);
      const whole = await shot();
      assert.ok(
        drawn.every((v, i) => v === whole[i]),
        `at ${ms} ms the frame drew what a whole repaint does`,
      );
      frames.push(drawn);
    }
    assert.ok(
      frames[0].some((v, i) => v !== frames[1][i]),
      'they moved',
    );
  },
);

metric(
  "a frame of an inline element's fade fades its text, in place, to the pixels a build draws",
  async (t) => {
    // a prompt's cursor that blinks by its opacity: its text is in its
    // paragraph's glyphs, drawn in the ink the frame's fade gives them, and
    // its background on the line beside them
    const doc = await running(
      t,
      '<style>body { margin: 0; font: 14px sans-serif }' +
        '@keyframes blink { from { opacity: .9 } to { opacity: .1 } }' +
        '#c { color: #aa0000; background: #ffff00;' +
        ' animation: blink 160ms linear infinite }</style>' +
        '<p>a prompt <span id="c">_ </span>blinking</p>',
      300,
    );
    const tree = treeOf(doc.el);
    await doc.at(32);
    assert.ok(treeOf(doc.el) === tree, 'the document was built again');
    const { frames } = await framesAgainstBuilds(doc, [64, 112]);
    assert.ok(
      frames[0].some((v, i) => v !== frames[1][i]),
      'it faded',
    );
  },
);

metric(
  'a frame that takes an opacity off 1, or back to it, fades a block or an inline element in place, to the pixels a build draws',
  async (t) => {
    // named in will-change for as long as the animation runs, the opacity
    // makes the element a layer of its context at 1 as well, and the order
    // the document paints in is the same on both sides of 1
    const doc = await running(
      t,
      '<style>body { margin: 0; font: 14px sans-serif }' +
        '@keyframes out { from { opacity: 1 } to { opacity: .2 } }' +
        '#c { color: #aa0000; background: #ffff00;' +
        ' animation: out 160ms linear infinite }' +
        '#b { width: 60px; padding: 4px; background: #0000aa;' +
        ' color: #ffffff; animation: out 160ms linear infinite }</style>' +
        '<p>a prompt <span id="c">_ </span>blinking</p>' +
        '<div id="b">a block</div>',
      300,
    );
    const tree = treeOf(doc.el);
    await doc.at(16);
    assert.ok(treeOf(doc.el) === tree, 'the document was built again');
    // off 1, back at 1 as an iteration begins, and off it again
    const { frames } = await framesAgainstBuilds(doc, [32, 160, 176]);
    assert.ok(
      frames[1].some((v, i) => v !== frames[2][i]),
      'it faded',
    );
  },
);

metric(
  'a frame that takes a box out of the plane by translate, rotate or scale restyles it in place, to the pixels a build draws',
  async (t) => {
    // the first two start flat, at `none`, and leave the plane at their
    // first frame; the third deepens a box a turn has already taken out of
    // it. Each is drawn through a projection, and reaches where that puts it
    const doc = await running(
      t,
      '<style>body { margin: 0 }' +
        '.s { position: relative; width: 300px; height: 120px;' +
        ' perspective: 300px }' +
        '.w { position: absolute; left: 50px; top: 20px; width: 200px;' +
        ' height: 80px; background: #aa0000 }' +
        '@keyframes tilt { to { rotate: y 60deg } }' +
        '@keyframes rise { to { translate: 0 0 100px } }' +
        '@keyframes deepen { to { scale: 1 1 3 } }' +
        '#a { animation: tilt 160ms linear }' +
        '#b { animation: rise 160ms linear }' +
        '#c { animation: deepen 160ms linear; transform: rotateY(40deg) }' +
        '</style><div class="s"><div class="w" id="a"></div></div>' +
        '<div class="s"><div class="w" id="b"></div></div>' +
        '<div class="s"><div class="w" id="c"></div></div>',
      300,
    );
    const tree = treeOf(doc.el);
    await doc.at(32);
    assert.ok(treeOf(doc.el) === tree, 'the document was built again');
    const { frames } = await framesAgainstBuilds(doc, [48, 96, 144]);
    assert.ok(
      frames[0].some((v, i) => v !== frames[2][i]),
      'they moved',
    );
  },
);

metric(
  'a hover that pauses a running animation holds it, in place',
  async (t) => {
    // Zen Garden 219's marquees stop under the pointer
    const doc = await running(
      t,
      '<style>body { margin: 0 } @keyframes f { from { opacity: 0 } to { opacity: 1 } }' +
        '#m { animation: f 160ms linear infinite }' +
        '#m:hover { animation-play-state: paused }</style><p id="m">marquee</p>',
      300,
    );
    await doc.at(48);
    const tree = treeOf(doc.el);
    const target = findElement(doc.el, 'm');
    const rect = doc.el.elementRect(target as never)!;
    const { abs } = doc.el as unknown as { abs: { x: number; y: number } };
    doc.el.setHover(abs.x + rect.x + 4, abs.y + rect.y + rect.height / 2);
    await doc.at(64);
    const held = doc.style('m').opacity;
    await doc.at(128);
    assert.strictEqual(doc.style('m').opacity, held, 'held under the pointer');
    assert.ok(treeOf(doc.el) === tree, 'the document was built again');
    doc.el.clearHover();
    await doc.at(160);
    assert.strictEqual(round(doc.style('m').opacity), round(held + 0.2));
  },
);

// --- a box whose transform is animating -------------------------------------
//
// Drawn on a surface once and drawn through each frame's matrix after it,
// where the context draws such a box on a surface at all (`paintSprite`) —
// the in-process server's does, as X11's does. Each frame here is held to a
// build of the whole document at the same moment, which draws the box on a
// surface made for it then.

const CARD =
  '<style>body { margin: 0; font: 14px sans-serif }' +
  '#card { width: 120px; margin: 30px; padding: 8px; background: #ddeeff;' +
  ' border: 2px solid #335577; box-shadow: 0 2px 6px #00000066 }' +
  '@keyframes r { to { transform: rotate(90deg) } }</style>';

const CARD_TEXT = '<b>A card</b> with a line of text that wraps';

/** How many surfaces the kept ones were made of, from now on. */
function surfacesMade(t: TestContext): () => number {
  const make = t.mock.method(SpriteStore.prototype, 'make');
  return () => make.mock.callCount();
}

/** What the document draws now with nothing kept: each box drawn on a
 *  surface made for the paint alone, as every one was before. */
async function drawnAlone(
  t: TestContext,
  doc: Awaited<ReturnType<typeof running>>,
): Promise<Uint8ClampedArray> {
  t.mock.method(SpriteStore.prototype, 'make', () => null);
  const el = doc.el as unknown as {
    _sprites: { clear(): void } | null;
    _invalidate(stale: number): void;
  };
  el._sprites?.clear();
  el._invalidate(0);
  return snapshot(doc.result, doc.el);
}

/** The surfaces a document keeps, by box. */
const kept = (el: HtmlViewNode) =>
  (el as unknown as { _sprites: { size: number } | null })._sprites?.size ?? 0;

/** Whether each frame drew something other than the one before. */
function moved(frames: Uint8ClampedArray[]): boolean {
  return frames.every(
    (frame, i) => i === 0 || frame.some((v, j) => v !== frames[i - 1][j]),
  );
}

metric(
  'a turning box is drawn from a surface it keeps, to the pixels a build draws',
  async (t) => {
    const made = surfacesMade(t);
    const doc = await running(
      t,
      CARD +
        '<style>#card { animation: r 640ms linear }</style>' +
        `<div id="card">${CARD_TEXT}</div>`,
      300,
    );
    await doc.at(16);
    assert.strictEqual(made(), 1, 'drawn on a surface once it turned');
    assert.strictEqual(kept(doc.el), 1, 'and the surface kept');
    await doc.at(160);
    assert.strictEqual(made(), 1, 'and not drawn again as it turned');
    const { frames } = await framesAgainstBuilds(doc, [176, 320]);
    assert.ok(moved(frames), 'it turned');
    assert.strictEqual(
      kept(doc.el),
      1,
      'the builds’ boxes keep one between them',
    );
    // a build draws it on a kept surface too: held to a surface made for
    // one paint, as each was before any was kept
    await doc.at(336);
    const drawn = await snapshot(doc.result, doc.el);
    const alone = await drawnAlone(t, doc);
    assert.ok(
      drawn.every((v, i) => v === alone[i]),
      'what a surface made for the paint alone draws',
    );
  },
);

metric(
  'a turning box moved a fraction of a pixel is drawn again where it falls',
  async (t) => {
    // what is on the surface is snapped to the pixel grid from where its
    // corner falls within a pixel, which a translation moves
    const doc = await running(
      t,
      CARD +
        '<style>@keyframes m { to { transform: translateX(7.3px) rotate(90deg) } }' +
        '#card { animation: m 640ms linear }</style>' +
        `<div id="card">${CARD_TEXT}</div>`,
      300,
    );
    const { frames } = await framesAgainstBuilds(doc, [48, 96, 144]);
    assert.ok(moved(frames), 'it moved');
  },
);

metric(
  'a box that grows and fades in at once keeps its surface, faded as a group',
  async (t) => {
    // a turn, a scale and an opacity are where and how faded the surface
    // is drawn, and leave what is on it as it was
    const made = surfacesMade(t);
    const doc = await running(
      t,
      CARD +
        '<style>@keyframes z { from { transform: scale(.5); opacity: 0 }' +
        ' to { transform: scale(1.5); opacity: .9 } }' +
        '#card { animation: z 640ms linear }</style>' +
        `<div id="card">${CARD_TEXT}</div>`,
      300,
    );
    await doc.at(32);
    const first = made();
    await doc.at(160);
    assert.strictEqual(made(), first, 'one surface all the way');
    const { frames } = await framesAgainstBuilds(doc, [176, 320]);
    assert.ok(moved(frames), 'it grew');
  },
);

metric(
  'a fading box keeps the surface its group is drawn on, to the pixels a build draws',
  async (t) => {
    // a frame of a fade draws the group at another opacity and paints
    // nothing, on any backend with a surface to keep
    const made = surfacesMade(t);
    const doc = await running(
      t,
      CARD +
        '<style>@keyframes f { from { opacity: .2 } to { opacity: .9 } }' +
        '#card { animation: f 640ms linear }</style>' +
        `<div id="card">${CARD_TEXT}</div>`,
      300,
    );
    await doc.at(16);
    assert.strictEqual(made(), 1, 'drawn on a surface once');
    await doc.at(160);
    assert.strictEqual(made(), 1, 'and not drawn again as it faded');
    const { frames } = await framesAgainstBuilds(doc, [176, 320]);
    assert.ok(moved(frames), 'it faded');
    await doc.at(336);
    const drawn = await snapshot(doc.result, doc.el);
    const alone = await drawnAlone(t, doc);
    assert.ok(
      drawn.every((v, i) => v === alone[i]),
      'what a surface made for the paint alone draws',
    );
  },
);

metric(
  'what changes inside a turning box, or with its turn, draws its surface again',
  async (t) => {
    // a colour animating inside it, a box inside it turning on its own, and
    // a turning box's own background animating with its turn: each frame
    // draws what is on the surface again, as a build does
    const doc = await running(
      t,
      CARD +
        '<style>@keyframes c { from { color: #ff0000 } to { color: #0000ff } }' +
        '@keyframes rb { from { transform: rotate(10deg); background: #ffffff }' +
        ' to { transform: rotate(60deg); background: #ffcc00 } }' +
        '#a { animation: r 640ms linear } #a b { animation: c 640ms linear }' +
        '#n { animation: r 640ms linear }' +
        '#n i { display: inline-block; animation: r 320ms linear infinite }' +
        '#o { animation: rb 640ms linear }</style>' +
        `<div id="card"><div id="a">${CARD_TEXT}</div>` +
        `<div id="n"><i>turning</i> inside</div>` +
        '<div id="o">turning and colouring</div></div>',
      300,
    );
    const { frames } = await framesAgainstBuilds(doc, [48, 96, 112]);
    assert.ok(moved(frames), 'they changed');
  },
);

metric(
  'a hover in a turning box, a selection across it, and a resize draw its surface again',
  async (t) => {
    const source =
      CARD +
      '<style>#card { width: 40%; animation: r 640ms linear }' +
      '#card:hover b { color: #ff0000; background: #ffff00 }</style>' +
      `<div id="card">${CARD_TEXT}</div>`;
    const doc = await running(t, source, 300);
    await doc.at(48);
    const made = surfacesMade(t);
    // the pointer over the middle of the card, which a turn about it keeps
    // under the pointer
    const rect = doc.el.elementRect(findElement(doc.el, 'card') as never)!;
    const { abs } = doc.el as unknown as { abs: { x: number; y: number } };
    doc.el.setHover(
      abs.x + rect.x + rect.width / 2,
      abs.y + rect.y + rect.height / 2,
    );
    await framesAgainstBuilds(doc, [64]);
    assert.ok(made() > 0, 'drawn again under the pointer');
    // drawn again with the pointer gone, before the selection is made
    doc.el.clearHover();
    await doc.at(72);
    await act(async () => {
      (doc.node as unknown as { selectAll(): void }).selectAll();
    });
    assert.ok(doc.el.selectionRange, 'selected');
    await framesAgainstBuilds(doc, [80]);
    await act(async () => {
      (doc.node as unknown as { clearSelection(): void }).clearSelection();
    });
    await doc.result.rerender(
      h(
        'box',
        { style: { width: 220, flexDirection: 'column' } },
        h(Html, { source, partial: false, 'data-testname': 'doc' }),
      ),
    );
    await framesAgainstBuilds(doc, [96, 112]);
  },
);

metric(
  'a hover that recolours a drawing in a turning box draws its surface again',
  async (t) => {
    // what the rules give the shapes in a drawing is no box's style
    // (`BoxTree.shapeStyler`): a hover changes it and restyles no box
    const doc = await running(
      t,
      CARD +
        '<style>#card { animation: r 640ms linear }' +
        '#s:hover path { fill: #ff0000 }</style>' +
        '<div id="card">A drawing <svg id="s" width="24" height="24">' +
        '<path d="M0 0h24v24H0z" fill="#0000ff"/></svg></div>',
      300,
    );
    await doc.at(48);
    const made = surfacesMade(t);
    const rect = doc.el.elementRect(findElement(doc.el, 's') as never)!;
    const { abs } = doc.el as unknown as { abs: { x: number; y: number } };
    doc.el.setHover(
      abs.x + rect.x + rect.width / 2,
      abs.y + rect.y + rect.height / 2,
    );
    await framesAgainstBuilds(doc, [64]);
    assert.ok(made() > 0, 'drawn again under the pointer');
  },
);

metric(
  'a turning box at a display scale of 2 is drawn from its surface where a build draws it',
  async (t) => {
    const made = surfacesMade(t);
    const doc = await running(
      t,
      CARD +
        '<style>#card { animation: r 640ms linear }</style>' +
        `<div id="card">${CARD_TEXT}</div>`,
      300,
      render2x,
    );
    await doc.at(32);
    const first = made();
    await doc.at(160);
    assert.strictEqual(made(), first, 'one surface all the way');
    const { frames } = await framesAgainstBuilds(doc, [176, 320]);
    assert.ok(moved(frames), 'it turned');
  },
);

metric(
  'a turning box keeps no surface once its animation is over',
  async (t) => {
    // back unturned at its end, it draws on no surface: the one kept for
    // the animation is given up
    const doc = await running(
      t,
      CARD +
        '<style>#card { animation: r 160ms linear }</style>' +
        `<div id="card">${CARD_TEXT}</div>`,
      300,
    );
    await doc.at(80);
    assert.strictEqual(kept(doc.el), 1, 'kept while it turns');
    await doc.at(176);
    assert.strictEqual(doc.clock.pending, false, 'over');
    assert.strictEqual(kept(doc.el), 0, 'and given up');
    await framesAgainstBuilds(doc, [192]);
  },
);

metric(
  'a still box drawn on a surface keeps a small one, and draws a large one where each paint reaches it',
  async (t) => {
    // a faded card, and a turned one, are composited from what they drew
    // the paint before; a panel past the size kept still is drawn again
    const made = surfacesMade(t);
    const { result, node } = await render(
      '<style>body { margin: 0; font: 14px sans-serif }' +
        '.c { width: 120px; margin: 30px; padding: 8px; background: #ddeeff;' +
        ' border: 2px solid #335577; box-shadow: 0 2px 6px #00000066 }' +
        '#faded:hover b { color: #ff0000 }</style>' +
        `<div id="faded" class="c" style="opacity:.6">${CARD_TEXT}</div>` +
        `<div class="c" style="transform:rotate(5deg)">${CARD_TEXT}</div>` +
        '<div class="c" style="opacity:.6;width:600px;height:300px">' +
        `${CARD_TEXT}</div>`,
      700,
    );
    const el = view(node);
    const invalidate = (stale: number) =>
      (el as unknown as { _invalidate(stale: number): void })._invalidate(
        stale,
      );
    assert.strictEqual(made(), 2, 'the card and the turned card');
    const drawn = await snapshot(result, el);
    invalidate(0);
    const again = await snapshot(result, el);
    assert.strictEqual(made(), 2, 'and nothing made again to paint them');
    assert.ok(
      drawn.every((v, i) => v === again[i]),
      'what they drew before',
    );
    // a hover in the faded card draws its group again, to what a build of
    // the document under the pointer draws
    const rect = el.elementRect(findElement(el, 'faded') as never)!;
    const { abs } = el as unknown as { abs: { x: number; y: number } };
    el.setHover(abs.x + rect.x + 10, abs.y + rect.y + rect.height / 2);
    const hovered = await snapshot(result, el);
    assert.ok(made() > 2, 'drawn again under the pointer');
    invalidate(2);
    const built = await snapshot(result, el);
    assert.ok(
      hovered.every((v, i) => v === built[i]),
      'what a build under the pointer draws',
    );
    assert.ok(
      hovered.some((v, i) => v !== again[i]),
      'the hover changed it',
    );
    el.clearHover();
    await act();
    const alone = await drawnAlone(t, {
      el,
      result,
    } as unknown as Awaited<ReturnType<typeof running>>);
    assert.ok(
      drawn.every((v, i) => v === alone[i]),
      'what a surface made for the paint alone draws',
    );
  },
);

metric(
  'a still box keeps its surface while something else on the page animates',
  async (t) => {
    // the frames give up only what was kept for an animation of their own
    const made = surfacesMade(t);
    const doc = await running(
      t,
      CARD +
        '<style>@keyframes c { from { color: #ff0000 } to { color: #0000ff } }' +
        '#x { animation: c 640ms linear }</style>' +
        '<p id="x">a colour that changes</p>' +
        `<div id="card" style="opacity:.6">${CARD_TEXT}</div>`,
      300,
    );
    assert.strictEqual(made(), 1, 'the faded card');
    await doc.at(160);
    const el = doc.el as unknown as { _invalidate(stale: number): void };
    el._invalidate(0);
    await act();
    assert.strictEqual(made(), 1, 'kept through ten frames of another');
  },
);

test('a paused animation holds where it was, and plays on from there', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes slide { from { margin-left: 0 } to { margin-left: 100px } }' +
      '#a { animation: slide 160ms linear }' +
      '#a.paused { animation-play-state: paused }</style><p id="a">x</p>',
  );
  const left = () => doc.style('a').marginLeft;
  const a = findElement(doc.el, 'a');
  await doc.at(48);
  assert.strictEqual(left(), 30);
  a.attribs.class = 'paused';
  doc.el.touchDocument();
  await doc.at(64);
  assert.strictEqual(left(), 40, 'paused where the change found it');
  // nothing is asked for while it is held
  assert.strictEqual(doc.clock.pending, false);
  await doc.at(160);
  assert.strictEqual(left(), 40);
  delete a.attribs.class;
  doc.el.touchDocument();
  await doc.at(176);
  assert.strictEqual(left(), 40);
  await doc.at(224);
  assert.strictEqual(left(), 70);
});

test('an animation a style stops naming is over, and named again starts again', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes f { from { opacity: 0 } to { opacity: 1 } }' +
      '.on { animation: f 160ms linear }</style>' +
      '<p id="a" class="on">x</p><p id="b" class="on">x</p>',
  );
  const a = findElement(doc.el, 'a');
  await doc.at(80);
  assert.strictEqual(doc.style('a').opacity, 0.5);
  a.attribs.class = '';
  doc.el.touchDocument();
  await doc.at(96);
  assert.strictEqual(doc.style('a').opacity, 1);
  a.attribs.class = 'on';
  doc.el.touchDocument();
  await doc.at(112);
  // started again, where its sibling, which kept it, is further on
  assert.strictEqual(doc.style('a').opacity, 0);
  assert.strictEqual(doc.style('b').opacity, 0.7);
});

test('an element not displayed runs no animation, and asks for no frame', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes f { from { opacity: 0 } to { opacity: 1 } }' +
      '#a { animation: f 1s infinite; display: none }' +
      '#c { animation: f 1s infinite }</style>' +
      '<p id="a">x</p><div style="display: none"><p id="c">x</p></div>',
  );
  assert.strictEqual(doc.clock.pending, false);
});

test('a document drawn at rest asks for no frame', async (t) => {
  const clock = holdClock(t, animationClock);
  const { node } = await render(
    '<style>@keyframes f { from { opacity: 0 } to { opacity: .5 } }' +
      '#a { animation: f 1s infinite forwards }</style><p id="a">x</p>',
    400,
    { animate: false },
  );
  assert.strictEqual(clock.pending, false);
  assert.strictEqual(styleOf(node, 'a').opacity, 0.5);
});

test('an element that is taken away takes its timer with it', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes f { from { opacity: 0 } to { opacity: 1 } }' +
      '#a { animation: f 1s infinite }</style><p id="a">x</p>',
  );
  assert.strictEqual(doc.clock.pending, true);
  await doc.result.unmount();
  assert.strictEqual(doc.clock.pending, false);
});

// --- sprites: an animation a layer of its own can carry -----------------------
//
// react-x11's surface presenter on macOS asks a drawn element for the parts
// of its drawing it may lift onto layers of their own (`Node.sprites()`,
// sidorares/react-x11#819), and runs their animations in the render server.
// Nothing asks in this suite: these ask as the presenter would, and answer
// as it would.

/** A context that records what is filled, where its translation puts it,
 *  and does nothing else. */
function recorder() {
  const fills: {
    style: unknown;
    x: number;
    y: number;
    w: number;
    h: number;
  }[] = [];
  let tx = 0;
  let ty = 0;
  const saved: [number, number][] = [];
  const own = {
    fillStyle: null as unknown,
    globalAlpha: 1,
    save() {
      saved.push([tx, ty]);
    },
    restore() {
      [tx, ty] = saved.pop() ?? [0, 0];
    },
    translate(x: number, y: number) {
      tx += x;
      ty += y;
    },
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: own.fillStyle, x: x + tx, y: y + ty, w, h });
    },
  };
  const ctx = new Proxy(own, {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : () => undefined,
  });
  return { ctx, fills };
}

const near = (a: number, b: number, by = 1e-6) => Math.abs(a - b) <= by;

test('an element whose animation a layer can carry is offered as a sprite: its frames sampled as the document runs them, its delay from now', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { from { opacity: 0 } to { opacity: 1 } }' +
      '#a { animation: fade 160ms linear; width: 40px; height: 20px;' +
      ' background: red; opacity: .8 }</style><div id="a"></div>',
  );
  await doc.at(48);
  const sprites = doc.el.sprites();
  assert.strictEqual(sprites?.length, 1);
  const [sprite] = sprites!;
  const box = boxOf(doc.el, 'a');
  const abs = (doc.el as unknown as DrawnNode).abs;
  assert.deepStrictEqual(sprite.rect, {
    x: abs.x + box.x,
    y: abs.y + box.y,
    width: box.width,
    height: box.height,
  });
  const [fade] = sprite.animations;
  assert.deepStrictEqual(
    [fade.property, fade.duration, fade.repeat, fade.delay],
    ['opacity', 160, 1, -48],
  );
  // a display's frames: from 0, through half way at half time, to a breath
  // short of 1
  const values = fade.values as number[];
  assert.strictEqual(values.length, 11);
  assert.strictEqual(values[0], 0);
  assert.ok(near(values[5], 0.5));
  assert.ok(values[10] > 0.99 && values[10] < 1);
  // what it rests at once it is over, filling nothing: its own value
  assert.strictEqual(sprite.opacity, 0.8);
  // a frame later the same part, sampled once, its delay from the new now
  await doc.at(64);
  const [again] = doc.el.sprites()!;
  assert.strictEqual(again.key, sprite.key);
  assert.ok(again.animations[0].values === fade.values, 'not sampled again');
  assert.strictEqual(again.animations[0].delay, -64);
});

test('a turn is offered as matrices about the transform origin, a whole turn turning, and an alternating slide as two iterations a cycle', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes spin { to { transform: rotate(360deg) } }' +
      '@keyframes slide { to { transform: translateX(30px) } }' +
      '#s { animation: spin 256ms linear infinite; width: 10px; height: 10px;' +
      ' background: red }' +
      '#t { animation: slide 160ms 3 alternate linear; width: 10px;' +
      ' height: 10px; margin-top: 20px; background: blue }</style>' +
      '<div id="s"></div><div id="t"></div>',
  );
  const sprites = doc.el.sprites()!;
  const abs = (doc.el as unknown as DrawnNode).abs;
  const s = boxOf(doc.el, 's');
  const spin = sprites.find((p) => p.rect.y === abs.y + s.y)!;
  assert.deepStrictEqual(spin.origin, {
    x: abs.x + s.x + 5,
    y: abs.y + s.y + 5,
  });
  const [turn] = spin.animations;
  assert.deepStrictEqual(
    [turn.property, turn.duration, turn.repeat],
    ['transform', 256, Infinity],
  );
  // every frame the turn its time has — which no interpolation of the
  // matrices of `rotate(0)` and `rotate(360deg)`, the same one, would give
  const matrices = turn.values as number[][];
  const n = matrices.length - 1;
  matrices.forEach((m, k) => {
    const angle = (2 * Math.PI * Math.min(k, n - 1e-6)) / n;
    assert.ok(
      near(m[0], Math.cos(angle), 1e-3) && near(m[1], Math.sin(angle), 1e-3),
      `frame ${k} of ${n}: ${m}`,
    );
  });
  const slide = sprites.find((p) => p !== spin)!;
  const [move] = slide.animations;
  // there and back is the cycle, run a time and a half
  assert.deepStrictEqual([move.duration, move.repeat], [320, 1.5]);
  // there 30px, and back: the value each frame's time has
  const slid = move.values as number[][];
  const last = slid.length - 1;
  slid.forEach((m, k) => {
    const u = k === last ? 320 - 1e-3 : (k / last) * 320;
    const x = u <= 160 ? (30 * u) / 160 : (30 * (320 - u)) / 160;
    assert.ok(near(m[4], x, 1e-6), `frame ${k}: ${m[4]} for ${x}`);
  });
});

test('a turn out of the plane is not offered, which a layer cannot carry, and a turn in it inside a perspective is', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes flip { to { transform: rotateY(180deg) } }' +
      '@keyframes spin { to { transform: rotate(360deg) } }' +
      '@keyframes fade { from { opacity: .2 } }' +
      '#f { animation: flip 256ms linear infinite; width: 10px;' +
      ' height: 10px; background: red }' +
      '#t { animation: fade 256ms linear infinite; width: 10px;' +
      ' height: 10px; background: red; transform: rotateX(30deg) }' +
      '#p { perspective: 100px }' +
      '#s { animation: spin 256ms linear infinite; width: 10px;' +
      ' height: 10px; background: blue }</style>' +
      '<div id="f"></div><div id="t"></div><div id="p"><div id="s"></div></div>',
  );
  await doc.at(32);
  // the turning box, and not the flip, which turns it out of the plane, nor
  // the fade of a box turned out of it
  const sprites = doc.el.sprites()!;
  const abs = (doc.el as unknown as DrawnNode).abs;
  assert.deepStrictEqual(
    sprites.map((p) => p.rect.y - abs.y),
    [boxOf(doc.el, 's').y],
  );
});

test('nor is translate, rotate or scale out of the plane, nor a fade of a box one of them takes out of it; and rotate in the plane is', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes tilt { to { rotate: y 180deg } }' +
      '@keyframes rise { to { translate: 0 0 50px } }' +
      '@keyframes deepen { to { scale: 1 1 3 } }' +
      '@keyframes fade { from { opacity: .2 } }' +
      '@keyframes spin { to { rotate: 360deg } }' +
      'div { width: 10px; height: 10px; background: red }' +
      '#r { animation: tilt 256ms linear infinite }' +
      '#z { animation: rise 256ms linear infinite }' +
      '#d { animation: deepen 256ms linear infinite }' +
      '#f { animation: fade 256ms linear infinite; translate: 0 0 10px }' +
      '#s { animation: spin 256ms linear infinite }</style>' +
      '<div id="r"></div><div id="z"></div><div id="d"></div>' +
      '<div id="f"></div><div id="s"></div>',
  );
  await doc.at(32);
  const sprites = doc.el.sprites()!;
  const abs = (doc.el as unknown as DrawnNode).abs;
  assert.deepStrictEqual(
    sprites.map((p) => p.rect.y - abs.y),
    [boxOf(doc.el, 's').y],
  );
});

test('a fade and a turn on one element go over as two animations on its layer, each with its own cycle and delay; a name with no frames is none', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { from { opacity: .2 } to { opacity: 1 } }' +
      '@keyframes spin { to { transform: rotate(360deg) } }' +
      '#a { animation: fade 160ms linear infinite, spin 256ms 32ms linear' +
      ' infinite, nothing 1s; width: 10px; height: 10px; background: red }' +
      '</style><div id="a"></div>',
  );
  // before the turn's delay is out, it is not yet under way
  assert.strictEqual(doc.el.sprites(), null);
  await doc.at(48);
  const [sprite] = doc.el.sprites()!;
  const [fade, turn] = sprite.animations;
  assert.deepStrictEqual(
    [fade.property, fade.duration, fade.repeat, fade.delay],
    ['opacity', 160, Infinity, -48],
  );
  assert.deepStrictEqual(
    [turn.property, turn.duration, turn.repeat, turn.delay],
    ['transform', 256, Infinity, -16],
  );
  // each sampled through its own cycle: the fade's opacities rise, and
  // the turn turns once
  const opacities = fade.values as number[];
  assert.ok(near(opacities[0], 0.2) && opacities.at(-1)! > 0.99);
  const matrices = turn.values as number[][];
  const n = matrices.length - 1;
  matrices.forEach((m, k) => {
    const angle = (2 * Math.PI * Math.min(k, n - 1e-6)) / n;
    assert.ok(
      near(m[0], Math.cos(angle), 1e-3) && near(m[1], Math.sin(angle), 1e-3),
      `frame ${k} of ${n}: ${m}`,
    );
  });
  // and both of one property are the cascade's to choose between: not lifted
  const both = await running(
    t,
    '<style>@keyframes fade { to { opacity: .2 } }' +
      '#b { animation: fade 1s infinite, fade 2s infinite; width: 10px;' +
      ' height: 10px }</style><div id="b"></div>',
  );
  assert.strictEqual(both.el.sprites(), null);
});

test('what a layer cannot carry stays on the document’s clock: a colour, two animations of one property, a paused one, a fade around it, and ink beside it', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { to { opacity: .2 } }' +
      '@keyframes tint { to { background: blue } }' +
      'div { width: 20px; height: 20px; background: red }' +
      '#colour { animation: tint 1s infinite }' +
      '#two { animation: fade 1s infinite, fade 2s infinite }' +
      '#paused { animation: fade 1s infinite paused }' +
      '#faded { opacity: .5; height: auto; background: none }' +
      '#inside { animation: fade 1s infinite }' +
      '#under { animation: fade 1s infinite; margin-top: 10px }' +
      '#over { position: relative; top: -15px; left: 5px; background: green }' +
      '#free { animation: fade 1s infinite; margin-top: 30px }</style>' +
      '<div id="colour"></div><div id="two"></div><div id="paused"></div>' +
      '<div id="faded"><div id="inside"></div></div>' +
      '<div id="under"></div><div id="over"></div><div id="free"></div>',
  );
  const sprites = doc.el.sprites()!;
  const abs = (doc.el as unknown as DrawnNode).abs;
  const free = boxOf(doc.el, 'free');
  assert.deepStrictEqual(
    sprites.map((p) => p.rect.y),
    [abs.y + free.y],
    'only the one nothing is near',
  );
});

test('what the document paints before an element is under its layer, as it is under the element: a toast over the text before it, a block that slides over the flow after it', async (t) => {
  // a stacking context is painted with the positioned boxes, after the flow
  // it is in, the flow after it among it
  const doc = await running(
    t,
    '<style>@keyframes fade { from { opacity: .2 } to { opacity: 1 } }' +
      '@keyframes rise { from { transform: translateY(20px) }' +
      ' to { transform: none } }' +
      'body { margin: 0 }' +
      'p { margin: 0; height: 20px; background: #eee }' +
      '#toast { position: absolute; top: 0; left: 0; width: 40px;' +
      ' height: 20px; background: red; animation: fade 1s infinite }' +
      '#rise { height: 20px; background: blue; animation: rise 1s infinite }' +
      '</style><p>under the toast</p><div id="rise"></div><p>after it</p>' +
      '<div id="toast"></div>',
  );
  const abs = (doc.el as unknown as DrawnNode).abs;
  const ys = (doc.el.sprites() ?? []).map((p) => p.rect.y - abs.y);
  // the rise where it is with no transform, and the toast at the top
  assert.deepStrictEqual(ys, [20, 0]);
});

test('the outline of the stacking context an element is in keeps it in the document where the ring is within its reach, and not where the element is inside the ring', async (t) => {
  // a stacking context paints its outline over all it holds
  const doc = await running(
    t,
    '<style>@keyframes fade { to { opacity: .2 } }' +
      'body { margin: 0 }' +
      'section { position: relative; z-index: 0; padding: 10px;' +
      ' outline: 2px solid green }' +
      'div { width: 20px; height: 20px; background: red;' +
      ' animation: fade 1s infinite }' +
      '#tight { outline-offset: -12px }</style>' +
      '<section><div></div></section><section id="tight"><div></div></section>',
  );
  const abs = (doc.el as unknown as DrawnNode).abs;
  const ys = (doc.el.sprites() ?? []).map((p) => p.rect.y - abs.y);
  assert.deepStrictEqual(ys, [10], 'inside the first ring, under the second');
});

test('a box fixed to the viewport keeps an element in the document while the scroll has it within the element’s reach', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { to { opacity: .2 } }' +
      'body { margin: 0 }' +
      '#bar { position: fixed; top: 0; left: 0; right: 0; height: 20px;' +
      ' background: navy; z-index: 1 }' +
      '#fade { margin-top: 100px; width: 20px; height: 20px;' +
      ' background: red; animation: fade 1s infinite }' +
      '#tall { height: 1000px }</style>' +
      '<div id="bar"></div><div id="fade"></div><div id="tall"></div>',
    400,
    inPane,
  );
  const pane = screen.getByTestName('pane') as DrawnNode & {
    scrollTo(y: number): void;
  };
  const offered = () => (doc.el.sprites() ?? []).length;
  assert.strictEqual(offered(), 1, 'clear of it');
  await act(async () => pane.scrollTo(90));
  assert.strictEqual(offered(), 0, 'under it');
  await act(async () => pane.scrollTo(200));
  assert.strictEqual(offered(), 1, 'past it');
});

test('a toast fixed to the viewport goes on a layer that stays where the viewport is as the pane scrolls the document under it, and is a hole where the document draws it', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { from { opacity: .2 } to { opacity: 1 } }' +
      'body { margin: 0 } #tall { height: 1000px }' +
      '#toast { position: fixed; bottom: 10px; left: 10px; width: 120px;' +
      ' height: 30px; background: navy; z-index: 10;' +
      ' animation: fade 1s infinite }</style>' +
      '<div id="tall"></div><div id="toast"></div>',
    400,
    inPane,
  );
  const pane = screen.getByTestName('pane') as DrawnNode & {
    scrollTo(y: number): void;
  };
  const toast = boxOf(doc.el, 'toast');
  const at = {
    x: pane.abs.x + toast.x,
    y: pane.abs.y + toast.y,
    width: 120,
    height: 30,
  };
  const [sprite] = doc.el.sprites()!;
  assert.deepStrictEqual(sprite.rect, at, 'at the viewport');
  // and still there after a scroll, which moves the document under it
  await act(async () => pane.scrollTo(300));
  const [again] = doc.el.sprites()!;
  assert.deepStrictEqual(again.rect, at, 'where the viewport is');
  // drawn there by its own paint
  const own = (fills: ReturnType<typeof recorder>['fills']) =>
    fills.filter((f) => f.w === 120 && f.h === 30);
  const drawn = recorder();
  again.paint!(drawn.ctx as never);
  assert.deepStrictEqual(
    own(drawn.fills).map((f) => [f.x, f.y]),
    [[at.x, at.y]],
  );
  doc.el.spritesLifted(new Set([again.key]));
  const hole = recorder();
  doc.el.paint(hole.ctx as never);
  assert.strictEqual(own(hole.fills).length, 0, 'a hole in the document');
});

test('what is painted after a part at the viewport is asked of everywhere the scroll can take it over the document, and what is fixed after it of where it is', async (t) => {
  const page = (after: string) =>
    '<style>@keyframes fade { from { opacity: .2 } to { opacity: 1 } }' +
    'body { margin: 0 } #tall { height: 1000px }' +
    '#toast { position: fixed; top: 10px; left: 10px; width: 120px;' +
    ' height: 30px; background: navy; z-index: 10;' +
    ' animation: fade 1s infinite }' +
    `#after { width: 40px; height: 20px; background: red; ${after} }` +
    '</style><div id="tall"></div><div id="toast"></div><div id="after"></div>';
  const offered = async (after: string, how = inPane) => {
    const doc = await running(t, page(after), 400, how);
    return (doc.el.sprites() ?? []).length;
  };
  // a box over it in the paint order, far down the document: a scroll
  // brings it under the toast
  assert.strictEqual(
    await offered('position: absolute; top: 700px; left: 20px; z-index: 20'),
    0,
    'scrolled under it',
  );
  // under it in the paint order, wherever the scroll takes it
  assert.strictEqual(
    await offered('position: absolute; top: 700px; left: 20px; z-index: 5'),
    1,
    'under it',
  );
  // fixed over it, clear of it and on it
  assert.strictEqual(
    await offered('position: fixed; top: 100px; left: 20px; z-index: 20'),
    1,
    'fixed clear of it',
  );
  assert.strictEqual(
    await offered('position: fixed; top: 20px; left: 20px; z-index: 20'),
    0,
    'fixed on it',
  );
  // where nothing scrolls the element, the box far down is only that
  assert.strictEqual(
    await offered(
      'position: absolute; top: 700px; left: 20px; z-index: 20',
      render,
    ),
    1,
    'no pane',
  );
});

test('an element inside a box fixed to the viewport goes on a layer at the viewport too', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes spin { to { transform: rotate(360deg) } }' +
      'body { margin: 0 } #tall { height: 1000px }' +
      '#toast { position: fixed; bottom: 10px; left: 10px; width: 120px;' +
      ' height: 30px; background: navy; z-index: 10 }' +
      '#spin { margin: 5px; width: 20px; height: 20px; background: white;' +
      ' animation: spin 1s linear infinite }</style>' +
      '<div id="tall"></div><div id="toast"><div id="spin"></div></div>',
    400,
    inPane,
  );
  const pane = screen.getByTestName('pane') as DrawnNode & {
    scrollTo(y: number): void;
  };
  await act(async () => pane.scrollTo(300));
  const spin = boxOf(doc.el, 'spin');
  const [sprite] = doc.el.sprites()!;
  assert.deepStrictEqual(
    [sprite.rect.x, sprite.rect.y],
    [pane.abs.x + spin.x, pane.abs.y + spin.y],
  );
});

test('parts that overlap are offered together and listed in the order the document paints them, the later over the earlier', async (t) => {
  // A staggered list: each row slides in from 8px below, into the row
  // before it. Every row's layer stands over the ones painted before it,
  // so each is offered on the word that the rows after it are lifted too,
  // which the presenter keeps (react-x11's `Node.sprites()`). The document
  // used to keep every row but the last for itself. The first row's
  // z-index paints it last, and it is listed last.
  const doc = await running(
    t,
    '<style>@keyframes in { from { opacity: 0; transform: translateY(8px) }' +
      ' to { opacity: 1; transform: none } }' +
      '.r { animation: in 400ms ease-out both; height: 10px; margin: 0;' +
      ' background: #ccd }</style>' +
      '<div class="r" id="a" style="position: relative; z-index: 2"></div>' +
      '<div class="r" id="b" style="animation-delay: 40ms"></div>' +
      '<div class="r" id="c" style="animation-delay: 80ms"></div>',
  );
  await doc.at(100);
  const sprites = doc.el.sprites()!;
  const abs = (doc.el as unknown as DrawnNode).abs;
  // where layout puts each row, with no transform: a row of 10px each
  const top = sprites.at(-1)!.rect.y - abs.y;
  assert.deepStrictEqual(
    sprites.map((s) => s.rect.y - abs.y),
    [top + 10, top + 20, top],
    'every row, b and c in the order they are painted and a after them',
  );

  // a box painted over the last row, which no layer carries, keeps that
  // row for the document, and every row whose slide reaches one the
  // document keeps: c, then b, then a
  const page = (gap: number) =>
    '<style>@keyframes in { from { opacity: 0; transform: translateY(8px) }' +
    ' to { opacity: 1; transform: none } }' +
    '.r { animation: in 400ms ease-out both; height: 10px; margin: 0;' +
    ' background: #ccd } #o { position: relative; height: 4px;' +
    ' margin-top: -4px; background: #000 }</style>' +
    `<div class="r" id="a" style="margin-bottom: ${gap}px"></div>` +
    '<div class="r" id="b"></div><div class="r" id="c"></div><div id="o"></div>';
  const covered = await running(t, page(0));
  await covered.at(100);
  assert.strictEqual(covered.el.sprites(), null, 'no row is offered');

  // …and a row clear of the ones it keeps keeps its layer
  const clear = await running(t, page(20));
  await clear.at(100);
  const kept = clear.el.sprites() ?? [];
  const clearAbs = (clear.el as unknown as DrawnNode).abs;
  assert.deepStrictEqual(
    kept.map((s) => s.rect.y - clearAbs.y),
    [top],
    'only a, which its slide keeps 12px clear of b',
  );
});

test('a box that clips an element cuts its layer: the sprite is offered with the clip, and what is painted after it outside the clip keeps nothing from it', async (t) => {
  const page = (overflow: string) =>
    '<style>@keyframes slide { from { transform: translateX(-40px) }' +
    ' to { transform: translateX(120px) } }' +
    'body { margin: 0 }' +
    `#frame { overflow: ${overflow}; width: 100px; height: 30px;` +
    ' margin: 10px; border: 2px solid }' +
    '#marquee { width: 40px; height: 20px; background: red;' +
    ' animation: slide 1s linear infinite }' +
    '#after { position: absolute; left: 130px; top: 10px; width: 20px;' +
    ' height: 20px; background: blue }</style>' +
    '<div id="frame"><div id="marquee"></div></div><div id="after"></div>';
  const doc = await running(t, page('hidden'));
  const abs = (doc.el as unknown as DrawnNode).abs;
  const [sprite] = doc.el.sprites() ?? [];
  // the padding box, inside the border: 10 + 2 across and down
  assert.deepStrictEqual(sprite?.clip, {
    x: abs.x + 12,
    y: abs.y + 12,
    width: 100,
    height: 30,
  });
  // the blue box is painted after it, where its slide takes it: outside
  // the clip it covers nothing that shows, and unclipped it does
  const open = await running(t, page('visible'));
  assert.strictEqual(open.el.sprites(), null);
});

test('a box that clips cuts only what it holds: an absolute element whose containing block is outside it is not cut by it, and a rounded one cuts an element clear of its corners not at all, and one that reaches them with its corners', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { to { opacity: .2 } }' +
      'body { margin: 0; position: relative }' +
      '.clip { overflow: hidden; width: 100px; height: 60px }' +
      '.round { border-radius: 10px }' +
      'i { display: block; width: 20px; height: 20px; background: red;' +
      ' animation: fade 1s infinite }' +
      '#out { position: absolute; left: 0; top: 0 }' +
      '#corner { margin: 0 }' +
      '#middle { margin: 20px 40px }</style>' +
      '<div class="clip"><i id="out"></i></div>' +
      '<div class="clip round"><i id="middle"></i></div>' +
      '<div class="clip round" id="card"><i id="corner"></i></div>',
  );
  const abs = (doc.el as unknown as DrawnNode).abs;
  const sprites = doc.el.sprites()!;
  const at = (id: string) =>
    sprites.find((p) => p.rect.y === abs.y + boxOf(doc.el, id).y);
  assert.ok(at('out'), 'positioned against the body, outside the clip');
  assert.strictEqual(at('out')!.clip, undefined);
  assert.ok(at('middle'), 'clear of the corners');
  assert.strictEqual(at('middle')!.clip, undefined);
  // in the corner: cut to the card with its corners
  const card = boxOf(doc.el, 'card');
  const corner = at('corner') as DocumentSprite | undefined;
  assert.ok(corner, 'in the corner');
  assert.deepStrictEqual(corner.clip, {
    x: abs.x + card.x,
    y: abs.y + card.y,
    width: 100,
    height: 60,
  });
  assert.strictEqual(corner.clipRadius, 10);
});

test('a rounded box cuts a layer with its corners only where they are one circle’s, inside its border, and no other clip cuts it again', async (t) => {
  const offered = async (card: string, outer = '') => {
    const doc = await running(
      t,
      '<style>@keyframes fade { to { opacity: .2 } }' +
        'body { margin: 0 } .outer { overflow: hidden; width: 300px;' +
        ` height: 200px; ${outer} }` +
        `.card { overflow: hidden; width: 100px; height: 60px; ${card} }` +
        'i { display: block; width: 20px; height: 20px; background: red;' +
        ' animation: fade 1s infinite }</style>' +
        '<div class="outer"><div class="card"><i></i></div></div>',
    );
    return (doc.el.sprites() ?? []) as DocumentSprite[];
  };
  // inside a border, its padding box's corners: the radius less the border
  const [inset] = await offered('border-radius: 10px; border: 2px solid');
  assert.deepStrictEqual(
    [inset?.clip?.width, inset?.clip?.height, inset?.clipRadius],
    [100, 60, 8],
  );
  // an ellipse, and corners of two sizes, are no one circle's
  assert.strictEqual((await offered('border-radius: 10px / 20px')).length, 0);
  assert.strictEqual((await offered('border-radius: 10px 0 0 0')).length, 0);
  // cut again by a smaller box around it, and by a rounded one
  assert.strictEqual(
    (await offered('border-radius: 10px', 'width: 50px')).length,
    0,
    'cut again',
  );
  assert.strictEqual(
    (await offered('border-radius: 10px', 'border-radius: 20px; width: 100px'))
      .length,
    0,
    'two rounded',
  );
});

test('a lifted element is a hole in the document, and its animation is no frame of the document’s; given back, it is drawn where its animation has got to', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { from { opacity: .2 } to { opacity: 1 } }' +
      'body { margin: 0; background: white }' +
      '#a { animation: fade 320ms linear; width: 40px; height: 20px;' +
      ' background: red }</style><div id="a"></div>',
  );
  await doc.at(32);
  const [sprite] = doc.el.sprites()!;
  assert.strictEqual(doc.clock.pending, true, 'its frames are the clock’s');
  doc.el.spritesLifted(new Set([sprite.key]));
  assert.strictEqual(doc.clock.pending, false, 'and not now it is lifted');
  // its paint leaves it out
  const own = (fills: ReturnType<typeof recorder>['fills']) =>
    fills.filter((f) => f.w === 40 && f.h === 20).length;
  const before = recorder();
  doc.el.paint(before.ctx as never);
  assert.strictEqual(own(before.fills), 0, 'the document drew it');
  // a timer of our own, so that time can pass with nothing of the
  // document's waiting on it
  const step = animationClock.arm(() => {}, 1000);
  t.after(() => animationClock.disarm(step));
  await doc.at(160);
  const style = styleOf(doc.node, 'a');
  assert.ok(near(style.opacity, 0.28, 1e-9), 'not restyled while lifted');
  // given back: restyled to now, drawn, and on the clock again
  doc.el.spritesLifted(new Set());
  assert.ok(near(styleOf(doc.node, 'a').opacity, 0.6, 1e-9));
  assert.strictEqual(doc.clock.pending, true);
  const after = recorder();
  doc.el.paint(after.ctx as never);
  assert.strictEqual(own(after.fills), 1, 'drawn again');
});

test('a `::before` or an `::after` whose animation a layer can carry is a sprite of its own, a hole in the document and no frame of its clock once lifted; one whose element is on a layer too goes in its element’s layer', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes spin { to { transform: rotate(360deg) } }' +
      '@keyframes fade { to { opacity: .2 } }' +
      'body { margin: 0; background: white }' +
      '#a { position: relative; width: 40px; height: 40px }' +
      '#a::after { content: ""; position: absolute; left: 10px; top: 10px;' +
      ' width: 20px; height: 20px; background: red;' +
      ' animation: spin 320ms linear infinite }' +
      '#b { width: 40px; height: 20px; animation: fade 1s infinite }' +
      '#b::before { content: ""; display: block; width: 10px;' +
      ' height: 10px; background: blue; animation: spin 1s linear infinite }' +
      '</style><div id="a"></div><div id="b"></div>',
  );
  const sprites = doc.el.sprites()! as DocumentSprite[];
  assert.strictEqual(sprites.length, 3);
  const abs = (doc.el as unknown as DrawnNode).abs;
  const a = boxOf(doc.el, 'a');
  const b = boxOf(doc.el, 'b');
  const at = (x: number, y: number) =>
    sprites.find((p) => p.rect.x === abs.x + x && p.rect.y === abs.y + y)!;
  const spin = at(a.x + 10, a.y + 10);
  assert.deepStrictEqual(spin.rect, {
    x: abs.x + a.x + 10,
    y: abs.y + a.y + 10,
    width: 20,
    height: 20,
  });
  assert.deepStrictEqual(
    [spin.animations[0].property, spin.animations[0].duration],
    ['transform', 320],
  );
  // #b fades and its `::before` turns: the `::before` in #b's layer
  const fade = sprites.find(
    (p) => p.rect.width === 40 && p.rect.height === 20,
  )!;
  assert.deepStrictEqual(
    [fade.rect.x, fade.rect.y],
    [abs.x + b.x, abs.y + b.y],
  );
  const turn = sprites.find((p) => p.rect.width === 10)!;
  assert.strictEqual(turn.parent, fade.key, 'inside its element’s');
  const small = (fills: ReturnType<typeof recorder>['fills']) =>
    fills.filter((f) => f.w === 10 && f.h === 10).length;
  const whole = recorder();
  fade.paint(whole.ctx as never);
  assert.strictEqual(small(whole.fills), 1, 'its element draws it');
  const holed = recorder();
  fade.paint(holed.ctx as never, new Set([turn.key]));
  assert.strictEqual(small(holed.fills), 0, 'but where it is lifted');
  // the `::after` draws itself, and once lifted the document does not
  const own = (fills: ReturnType<typeof recorder>['fills']) =>
    fills.filter((f) => f.w === 20 && f.h === 20).length;
  const drawn = recorder();
  spin.paint!(drawn.ctx as never);
  assert.strictEqual(own(drawn.fills), 1, 'by its own paint');
  doc.el.spritesLifted(new Set([spin.key]));
  const hole = recorder();
  doc.el.paint(hole.ctx as never);
  assert.strictEqual(own(hole.fills), 0, 'a hole in the document');
  // #b's frames are the clock's still, and the `::after`'s are not
  const live = () =>
    (
      doc.el as unknown as {
        _timeline: {
          live(skip: unknown): { el: unknown; targets: string[] }[];
        };
        _skipLifted: unknown;
      }
    )._timeline.live(
      (doc.el as unknown as { _skipLifted: unknown })._skipLifted,
    );
  assert.deepStrictEqual(
    live().map((l) => l.targets),
    [['', 'before']],
    'only #b and its own',
  );
  // #b and its `::before` lifted too: nothing is the clock's
  doc.el.spritesLifted(new Set([spin.key, fade.key, turn.key]));
  assert.deepStrictEqual(live(), []);
  // given back, the document draws them again
  doc.el.spritesLifted(new Set());
  const back = recorder();
  doc.el.paint(back.ctx as never);
  assert.strictEqual(own(back.fills), 1, 'drawn again');
  assert.strictEqual(small(back.fills), 1, 'and the `::before`');
});

test('a lifted element that moves is hit where its animation has it, with nothing repainted and nothing sampled again', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes slide { from { transform: translateX(0) }' +
      ' to { transform: translateX(200px) } }' +
      'body { margin: 0 }' +
      '#a { animation: slide 320ms linear; width: 40px; height: 20px;' +
      ' background: red }</style><div id="a"></div>',
  );
  await doc.at(32);
  const [sprite] = doc.el.sprites()!;
  doc.el.spritesLifted(new Set([sprite.key]));
  // time passes with nothing of the document's waiting on it
  const step = animationClock.arm(() => {}, 1000);
  t.after(() => animationClock.disarm(step));
  await doc.at(160);
  const abs = (doc.el as unknown as DrawnNode).abs;
  const idAt = (dx: number) =>
    doc.el.elementAtPoint(abs.x + dx, abs.y + 10)?.attribs.id ?? null;
  const claims = t.mock.method(doc.el, 'invalidate');
  // lifted 20px across, and half way through it is 100px across
  assert.strictEqual(idAt(120), 'a', 'where its layer has it now');
  assert.notStrictEqual(idAt(30), 'a', 'not where it was lifted');
  assert.strictEqual(claims.mock.callCount(), 0, 'nothing repainted');
  const [again] = doc.el.sprites()!;
  assert.ok(
    again.animations[0].values === sprite.animations[0].values,
    'not sampled again',
  );
});

test('a lifted element a hover draws otherwise asks for the frame that paints its layer again, and repaints no hole', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { from { opacity: .2 } to { opacity: 1 } }' +
      'body { margin: 0 }' +
      '#a { animation: fade 320ms linear infinite; width: 40px;' +
      ' height: 20px; background: red }' +
      '#a:hover { background: blue }</style><div id="a"></div>',
  );
  const [sprite] = doc.el.sprites()!;
  doc.el.spritesLifted(new Set([sprite.key]));
  const asked = t.mock.method(doc.el, 'spritesChanged');
  const claims = t.mock.method(doc.el, 'invalidate');
  const abs = (doc.el as unknown as DrawnNode).abs;
  doc.el.setHover(abs.x + 10, abs.y + 10);
  assert.strictEqual(asked.mock.callCount(), 1, 'a frame asked for');
  assert.strictEqual(claims.mock.callCount(), 0, 'no hole repainted');
  const [again] = doc.el.sprites()!;
  assert.notStrictEqual(again.version, sprite.version, 'painted again');
});

test('an element that animates inside a lifted one paints the lifted one’s layer again at each of its frames, and samples none of the lifted one’s frames again', async (t) => {
  // a spinner in a card that pulses: the card's frames are sampled from
  // its own style and its animation, which the spinner's frames leave as
  // they were
  const doc = await running(
    t,
    '<style>@keyframes pulse { from { opacity: 1 } to { opacity: .6 } }' +
      '@keyframes spin { to { transform: rotate(360deg) } }' +
      'body { margin: 0 } #card { width: 200px; height: 80px;' +
      ' background: blue; animation: pulse 1s infinite alternate }' +
      '#spin { width: 20px; height: 20px; background: white;' +
      ' animation: spin 1s linear infinite }</style>' +
      '<div id="card"><div id="spin"></div></div>',
  );
  const [sprite] = doc.el.sprites()!;
  doc.el.spritesLifted(new Set([sprite.key]));
  await doc.at(32);
  const [again] = doc.el.sprites()!;
  assert.strictEqual(again.key, sprite.key);
  assert.notStrictEqual(again.version, sprite.version, 'painted again');
  assert.ok(
    again.animations[0].values === sprite.animations[0].values,
    'not sampled again',
  );
});

test('an element animating inside one that goes on a layer is offered inside it: in its layer, placed as though it did not move, and left out of its raster where the presenter lifts it', async (t) => {
  // a card that pulses, moved 20px across, and a spinner in it
  const doc = await running(
    t,
    '<style>@keyframes pulse { from { opacity: 1 } to { opacity: .6 } }' +
      '@keyframes spin { to { transform: rotate(360deg) } }' +
      'body { margin: 0 } #card { width: 200px; height: 80px;' +
      ' background: blue; transform: translateX(20px);' +
      ' animation: pulse 1s infinite alternate }' +
      '#spin { margin: 10px; width: 20px; height: 20px; background: white;' +
      ' animation: spin 1s linear infinite }</style>' +
      '<div id="card"><div id="spin"></div></div>',
  );
  const sprites = doc.el.sprites()! as DocumentSprite[];
  assert.strictEqual(sprites.length, 2);
  const [card, spin] = sprites;
  assert.strictEqual(card.parent, undefined);
  assert.strictEqual(spin.parent, card.key, 'the card is its parent');
  const abs = (doc.el as unknown as DrawnNode).abs;
  const box = boxOf(doc.el, 'spin');
  // layout moved the spinner with the card; in the card's raster it is
  // where it would be with the card where it was laid out
  assert.deepStrictEqual(
    [spin.rect.x, spin.rect.y],
    [abs.x + box.x - 20, abs.y + box.y],
  );
  // the card's raster has the spinner in it, but for where the presenter
  // hands it its key
  const own = (fills: ReturnType<typeof recorder>['fills']) =>
    fills.filter((f) => f.w === 20 && f.h === 20).length;
  const whole = recorder();
  card.paint(whole.ctx as never);
  assert.strictEqual(own(whole.fills), 1, 'drawn in the card');
  const holed = recorder();
  card.paint(holed.ctx as never, new Set([spin.key]));
  assert.strictEqual(own(holed.fills), 0, 'a hole where it is lifted');
  // lifted together, neither is a frame of the document's
  doc.el.spritesLifted(new Set([card.key, spin.key]));
  assert.strictEqual(doc.clock.pending, false);
});

test('what is between a part and one inside it is asked about as for any part: a fade or a turn keeps the inner one in the document, and a box that clips cuts its layer in the outer one’s', async (t) => {
  // the card in a box that clips it narrower than what is between: that
  // box cuts the card's layer, and the part inside it is cut no more
  const page = (between: string) =>
    '<style>@keyframes pulse { from { opacity: 1 } to { opacity: .6 } }' +
    '@keyframes slide { to { transform: translateX(30px) } }' +
    'body { margin: 0 } #outer { width: 100px; overflow: hidden }' +
    '#card { width: 200px; height: 80px;' +
    ' background: blue; animation: pulse 1s infinite alternate }' +
    `#between { width: 120px; height: 60px; ${between} }` +
    '#move { width: 20px; height: 20px; background: white;' +
    ' animation: slide 1s linear infinite }</style>' +
    '<div id="outer"><div id="card"><div id="between"><div id="move">' +
    '</div></div></div></div>';
  const faded = await running(t, page('opacity: .5'));
  assert.strictEqual(faded.el.sprites()!.length, 1, 'the card alone');
  const turned = await running(t, page('transform: rotate(5deg)'));
  assert.strictEqual(turned.el.sprites()!.length, 1, 'the card alone');
  const clipped = await running(t, page('overflow: hidden'));
  const sprites = clipped.el.sprites()! as DocumentSprite[];
  assert.strictEqual(sprites.length, 2);
  const abs = (clipped.el as unknown as DrawnNode).abs;
  const between = boxOf(clipped.el, 'between');
  assert.strictEqual(sprites[1].parent, sprites[0].key);
  assert.deepStrictEqual(sprites[1].clip, {
    x: abs.x + between.x,
    y: abs.y + between.y,
    width: 120,
    height: 60,
  });
});

test('the frames the document runs for what is not lifted restyle nothing that is', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes fade { from { opacity: .2 } to { opacity: 1 } }' +
      '@keyframes tint { to { color: blue } }' +
      '#a { animation: fade 320ms linear; width: 40px; height: 20px }' +
      '#b { animation: tint 320ms linear; margin-top: 40px }</style>' +
      '<div id="a"></div><p id="b">x</p>',
  );
  await doc.at(32);
  const [sprite] = doc.el.sprites()!;
  doc.el.spritesLifted(new Set([sprite.key]));
  assert.strictEqual(doc.clock.pending, true, 'the colour runs on');
  const tinted = styleOf(doc.node, 'b').color;
  await doc.at(160);
  assert.ok(near(styleOf(doc.node, 'a').opacity, 0.28, 1e-9), 'restyled');
  assert.notStrictEqual(styleOf(doc.node, 'b').color, tinted, 'its frames');
});

test('a sprite paints its element as the document would, at full opacity and where it would be with no transform; an ended one is not offered again', async (t) => {
  const doc = await running(
    t,
    '<style>@keyframes slide { from { transform: translateX(10px) }' +
      ' to { transform: translateX(50px) } }' +
      'body { margin: 0 }' +
      '#a { animation: slide 160ms linear forwards; width: 40px;' +
      ' height: 20px; background: red; opacity: .9 }</style>' +
      '<div id="a"></div>',
  );
  await doc.at(80);
  const [sprite] = doc.el.sprites()!;
  const abs = (doc.el as unknown as DrawnNode).abs;
  // with no transform the box is at the document's left: layout moved it by
  // the 30px this frame's translation has, and its layer's matrix carries
  // every frame's
  assert.strictEqual(sprite.rect.x, abs.x);
  const { ctx, fills } = recorder();
  sprite.paint!(ctx as never);
  const own = fills.filter((f) => f.w === 40 && f.h === 20);
  assert.strictEqual(own.length, 1, JSON.stringify(fills));
  assert.strictEqual(own[0].x, abs.x, 'drawn untranslated');
  // filling forwards, it rests at its last frame
  assert.ok(near(sprite.transform[4], 50, 1e-6), `${sprite.transform}`);
  // the render server ran it out: no longer offered, so the presenter gives
  // it back, to be drawn as it ended
  const [slide] = sprite.animations;
  doc.el.spriteAnimationEnded(sprite.key, slide.id, true);
  assert.strictEqual(doc.el.sprites(), null);
});

// --- the arithmetic ---------------------------------------------------------------

test('progress through an iteration: phases, fills, directions', () => {
  const timing = (over: Partial<Timing>): Timing => ({
    duration: 100,
    delay: 0,
    iterations: 1,
    direction: 'normal',
    fill: 'none',
    ...over,
  });
  assert.deepStrictEqual(progressAt(timing({}), 25), {
    progress: 0.25,
    phase: 'active',
  });
  assert.deepStrictEqual(progressAt(timing({ delay: 50 }), 25), {
    progress: null,
    phase: 'before',
  });
  assert.strictEqual(
    progressAt(timing({ delay: 50, fill: 'both' }), 25).progress,
    0,
  );
  // a negative delay starts part of the way through
  assert.strictEqual(progressAt(timing({ delay: -50 }), 0).progress, 0.5);
  assert.strictEqual(progressAt(timing({}), 100).progress, null);
  assert.strictEqual(progressAt(timing({ fill: 'forwards' }), 100).progress, 1);
  // half of an iteration fills where it stopped
  assert.strictEqual(
    progressAt(timing({ iterations: 0.5, fill: 'forwards' }), 900).progress,
    0.5,
  );
  assert.strictEqual(
    progressAt(timing({ iterations: 3, direction: 'alternate' }), 150).progress,
    0.5,
  );
  assert.strictEqual(
    progressAt(timing({ iterations: 3, direction: 'alternate' }), 175).progress,
    0.25,
  );
  assert.strictEqual(
    progressAt(timing({ direction: 'alternate-reverse' }), 25).progress,
    0.75,
  );
  // no length: over as it starts
  assert.deepStrictEqual(progressAt(timing({ duration: 0, fill: 'both' }), 0), {
    progress: 1,
    phase: 'after',
  });
  assert.strictEqual(
    round(progressAt(timing({ iterations: Infinity }), 1e6 + 30).progress!),
    0.3,
  );
});

test('easing functions eased', () => {
  const at = (value: string, t: number) => ease(parseEasing(value)!, t);
  assert.strictEqual(at('linear', 0.3), 0.3);
  // ease-in-out is symmetric about its middle
  assert.ok(Math.abs(at('ease-in-out', 0.5) - 0.5) < 1e-6);
  assert.ok(Math.abs(at('cubic-bezier(0, 0, 1, 1)', 0.37) - 0.37) < 1e-6);
  assert.ok(at('ease-in', 0.25) < 0.25 && at('ease-out', 0.25) > 0.25);
  // CSS Easing 2's own example of a curve that overshoots
  assert.ok(at('cubic-bezier(0.3, 1.5, 0.8, 1.5)', 0.5) > 1);
  assert.strictEqual(at('steps(4)', 0.3), 0.25);
  assert.strictEqual(at('steps(4, start)', 0.3), 0.5);
  assert.strictEqual(at('steps(3, jump-both)', 0.5), 0.5);
  assert.strictEqual(at('steps(3, jump-none)', 0.5), 0.5);
  assert.strictEqual(at('linear(0, 0.25 75%, 1)', 0.375), 0.125);
  assert.strictEqual(at('linear(0, 1 20% 80%, 0)', 0.5), 1);
});

test('two transform lists between', () => {
  const ctx = { em: 16, rem: 16, vw: 0, vh: 0, scale: 1 } as never;
  const list = (v: string) => parseTransform(v, ctx)!;
  const close = (a: readonly number[], b: readonly number[]) =>
    a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  // alike, function by function; `none` is the other's at nothing
  const half = interpolateTransforms(
    list('translateX(10px) scale(2)'),
    null,
    0.5,
  )!;
  assert.deepStrictEqual(half[0], { by: [5, 0] });
  assert.ok('fn' in half[1] && half[1].fn?.kind === 'scale');
  assert.strictEqual((half[1] as { fn: { x: number } }).fn.x, 1.5);
  // a translation by a percentage stays one
  assert.deepStrictEqual(
    interpolateTransforms(
      list('translate(-50%, 0)'),
      list('translate(0, 10px)'),
      0.5,
    ),
    [{ by: [{ pct: -25 }, 5] }],
  );
  // not alike: the rest as matrices, taken apart. Zen Garden 219's sign
  // turns back from its tilt as it straightens
  const tilted = list('rotate(-5deg) skew(-5deg) scale(0.8)');
  for (const q of [0, 1]) {
    const [end] = interpolateTransforms(tilted, list('scale(1)'), q)!;
    assert.ok('matrix' in end);
    const want = q
      ? [1, 0, 0, 1, 0, 0]
      : product(tilted as { matrix: readonly number[] }[]);
    assert.ok(close(end.matrix, want), `${q}: ${end.matrix}`);
  }
  const mid = interpolateTransforms(
    list('rotate(30deg)'),
    list('scale(2)'),
    0.5,
  )!;
  assert.strictEqual(mid.length, 1);
  const [one] = mid;
  assert.ok('matrix' in one && !one.fn);
  const c = Math.cos(Math.PI / 12);
  const s = Math.sin(Math.PI / 12);
  assert.ok(
    close(one.matrix, [1.5 * c, 1.5 * s, -1.5 * s, 1.5 * c, 0, 0]),
    `${one.matrix}`,
  );
  // a percentage in the rest is no matrix: the property goes over
  assert.strictEqual(
    interpolateTransforms(
      list('translate(10%) rotate(1deg)'),
      list('scale(2)'),
      0.5,
    ),
    undefined,
  );
});

test('two transform lists between, out of the plane', () => {
  const ctx = { em: 16, rem: 16, vw: 0, vh: 0, scale: 1 } as never;
  const list = (v: string) => parseTransform(v, ctx)!;
  const close = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const fnOf = (f: object) => ('fn' in f ? f.fn : undefined);
  // a turn about one axis, by its angle: the Zen Garden's 219 straightens
  // its panel from rotateY(40deg)
  const [half] = interpolateTransforms(
    list('rotateY(40deg)'),
    list('rotateY(0)'),
    0.5,
  )!;
  assert.deepStrictEqual(fnOf(half), {
    kind: 'rotate3d',
    x: 0,
    y: 1,
    z: 0,
    angle: 20,
  });
  assert.ok('solid' in half && close(half.solid, rotate4(0, 1, 0, 20)));
  // a turn of none is about any axis: 219's sign turns back in the plane
  const sign = interpolateTransforms(
    list('rotate(-5deg) skew(-5deg) scale(0.8)'),
    list('rotateY(0) scale(1)'),
    0.5,
  )!;
  assert.deepStrictEqual(fnOf(sign[0]), { kind: 'rotate', angle: -2.5 });
  // and its header's scale meets a turn: not alike, and in the plane, so
  // one matrix of the plane from there
  const header = interpolateTransforms(
    list('scale(0.8)'),
    list('rotateY(0) scale(1)'),
    0.5,
  )!;
  assert.strictEqual(header.length, 1);
  assert.ok(
    'matrix' in header[0] && close(header[0].matrix, [0.9, 0, 0, 0.9, 0, 0]),
  );
  // two turns about axes of their own: the shorter way round, in space —
  // halfway from a quarter about one to a quarter about the other is a
  // turn about the axis between them
  const [both] = interpolateTransforms(
    list('rotateX(90deg)'),
    list('rotateY(90deg)'),
    0.5,
  )!;
  const angle = (2 * Math.acos(Math.sqrt(2 / 3)) * 180) / Math.PI;
  assert.ok('solid' in both && close(both.solid, rotate4(1, 1, 0, angle)));
  // a matrix in space taken apart and put together again at either end is
  // that end
  const a = multiply4(perspective4(400), rotate4(1, 2, 3, 50));
  const b = multiply4(translate4(10, 20, 30), rotate4(0, 1, 0, -20));
  assert.ok(close(interpolateMatrix4(a, b, 0), a));
  assert.ok(close(interpolateMatrix4(a, b, 1), b));
  // a perspective by how much it divides: halfway to none is twice as far
  const [far] = interpolateTransforms(
    list('perspective(100px)'),
    list('perspective(none)'),
    0.5,
  )!;
  assert.deepStrictEqual(fnOf(far), { kind: 'perspective', depth: 200 });
  // and a move toward the viewer by its depth
  assert.deepStrictEqual(
    interpolateTransforms(
      list('translateZ(0)'),
      list('translate3d(10px, 0, 100px)'),
      0.5,
    ),
    [{ by: [5, 0], z: 50 }],
  );
});

test('translate, rotate and scale between, out of the plane', () => {
  const close = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const turn = (value: string) => parseRotate(value)!;
  const between = (a: Turn | null, b: Turn | null, q: number) =>
    interpolateField('rotate', a, b, q) as Turn;
  // a move and a scale by their values, a depth with them, and `none` the
  // other's at nothing
  assert.deepStrictEqual(
    interpolateField('translate', [0, { pct: 50 }, 0], [10, 0, 100], 0.5),
    [5, { pct: 25 }, 50],
  );
  assert.deepStrictEqual(
    interpolateField('translate', null, [0, 0, 100], 0.25),
    [0, 0, 25],
  );
  assert.deepStrictEqual(
    interpolateField('scale', [2, 2, 1], [1, 1, 3], 0.5),
    [1.5, 1.5, 2],
  );
  assert.deepStrictEqual(
    interpolateField('scale', null, [1, 1, 3], 0.5),
    [1, 1, 2],
  );
  // about one axis by the angle: a whole turn in the plane, and in space
  // about axes of any length that point one way
  assert.deepStrictEqual(between(null, turn('360deg'), 0.25), {
    kind: 'rotate',
    angle: 90,
  });
  assert.deepStrictEqual(between(turn('y 40deg'), turn('0 2 0 80deg'), 0.5), {
    kind: 'rotate3d',
    x: 0,
    y: 1,
    z: 0,
    angle: 60,
  });
  // a turn of none is about the other's axis, `none` among them
  assert.deepStrictEqual(between(null, turn('x 90deg'), 0.5), {
    kind: 'rotate3d',
    x: 1,
    y: 0,
    z: 0,
    angle: 45,
  });
  assert.deepStrictEqual(between(turn('45deg'), turn('y 0deg'), 0.5), {
    kind: 'rotate',
    angle: 22.5,
  });
  // two about axes of their own as their matrices, taken apart and put
  // together again, which is a turn: halfway from a quarter about one to a
  // quarter about the other is a turn about the axis between them, as
  // rotateX() to rotateY() is
  const both = between(turn('x 90deg'), turn('y 90deg'), 0.5);
  const angle = (2 * Math.acos(Math.sqrt(2 / 3)) * 180) / Math.PI;
  assert.ok(
    both.kind === 'rotate3d' &&
      close(
        [both.x, both.y, both.z, both.angle],
        [Math.SQRT1_2, Math.SQRT1_2, 0, angle],
      ),
    JSON.stringify(both),
  );
  assert.ok(
    close(
      primitiveSolid(both),
      interpolateMatrix4(rotate4(1, 0, 0, 90), rotate4(0, 1, 0, 90), 0.5),
    ),
  );
  // and a turn in the plane to one out of it, where Chrome, Firefox and
  // WebKit all come to 36.1357deg about (0, 0.3235, 0.9462)
  const tilt = between(turn('45deg'), turn('y 45deg'), 0.25);
  assert.ok(
    close(
      primitiveSolid(tilt),
      interpolateMatrix4(rotate4(0, 0, 1, 45), rotate4(0, 1, 0, 45), 0.25),
    ),
    JSON.stringify(tilt),
  );
  assert.ok(
    tilt.kind === 'rotate3d' &&
      [tilt.x, tilt.y, tilt.z, tilt.angle].every(
        (v, i) => Math.abs(v - [0, 0.323459, 0.946242, 36.135673][i]) < 1e-6,
      ),
    JSON.stringify(tilt),
  );
  // a turn past a half is the matrix's, the shorter one the other way, as
  // Chrome and WebKit have it; Firefox slerps the turn as written, and is
  // half a turn about (1, 1, 0) here
  const past = between(turn('x 270deg'), turn('y 90deg'), 0.5);
  assert.ok(
    past.kind === 'rotate3d' &&
      close(
        [past.x, past.y, past.z, past.angle],
        [-Math.SQRT1_2, Math.SQRT1_2, 0, angle],
      ),
    JSON.stringify(past),
  );
});

test('fields between: lengths, integers, a visibility, what cannot be', () => {
  assert.deepStrictEqual(interpolateField('top', -500, { pct: 50 }, 0.5), {
    pct: 25,
    px: -250,
  });
  assert.strictEqual(interpolateField('zIndex', 1, 4, 0.5), 3);
  assert.strictEqual(interpolateField('width', 10, 20, -2), 0);
  assert.strictEqual(interpolateField('opacity', 0, 1, 1.5), 1);
  assert.strictEqual(interpolateField('top', 'auto', 10, 0.5), undefined);
  assert.strictEqual(
    interpolateField('visibility', 'hidden', 'visible', 0),
    'hidden',
  );
  assert.strictEqual(
    interpolateField('visibility', 'hidden', 'visible', 0.01),
    'visible',
  );
  assert.strictEqual(
    interpolateField('display', 'block', 'flex', 0.5),
    undefined,
  );
});

/** A number to the precision a test says it in. */
const round = (n: number) => Math.round(n * 1e9) / 1e9;

/** What a list of matrices comes to. */
function product(list: readonly { matrix?: readonly number[] }[]): number[] {
  let m = [1, 0, 0, 1, 0, 0];
  for (const fn of list) {
    const [a, b, c, d, e, f] = fn.matrix!;
    m = [
      m[0] * a + m[2] * b,
      m[1] * a + m[3] * b,
      m[0] * c + m[2] * d,
      m[1] * c + m[3] * d,
      m[0] * e + m[2] * f + m[4],
      m[1] * e + m[3] * f + m[5],
    ];
  }
  return m;
}

/** The element with `id` in the document. */
function findElement(
  el: HtmlViewNode,
  id: string,
): { attribs: Record<string, string> } {
  const stack: unknown[] = [el.document];
  while (stack.length) {
    const at = stack.pop() as {
      attribs?: Record<string, string>;
      children?: unknown[];
    };
    if (at.attribs?.id === id) return at as { attribs: Record<string, string> };
    for (const child of at.children ?? []) stack.push(child);
  }
  throw new Error(`no #${id}`);
}
