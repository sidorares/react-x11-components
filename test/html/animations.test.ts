// <Html> — animations: `@keyframes`, `animation` and its longhands, the
// values an animation passes through as it runs, and what one leaves on a
// style where none runs.
import { afterEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert';
import { act, cleanup } from 'react-x11/test';
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
import { parseTransform } from '../../src/html/css/transform.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { animationClock } from '../../src/html/node.js';
import type { HtmlViewNode } from '../../src/html/node.js';
import { holdClock } from '../held-clock.js';
import { boxOf, metric, render, view } from './harness.js';
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
async function running(t: TestContext, source: string, width = 400) {
  const clock = holdClock(t, animationClock);
  const { node, result } = await render(source, width);
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

/** The element's pixels, as the server has them. */
async function snapshot(
  result: Awaited<ReturnType<typeof render>>['result'],
  el: HtmlViewNode,
): Promise<Uint8ClampedArray> {
  const { abs } = el as unknown as {
    abs: { x: number; y: number; width: number; height: number };
  };
  await act();
  return new Promise((ok, fail) =>
    (
      result.ctx as unknown as {
        getImageData(
          x: number,
          y: number,
          w: number,
          h: number,
          cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
        ): void;
      }
    ).getImageData(abs.x, abs.y, abs.width, abs.height, (e, d) =>
      e ? fail(e) : ok(d.data),
    ),
  );
}

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

/** The box tree, to tell a restyle in place from a document built again. */
const treeOf = (el: HtmlViewNode) =>
  (el as unknown as { _tree: unknown })._tree;

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
