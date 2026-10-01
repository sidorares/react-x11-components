// <Html> — animations: `@keyframes`, `animation` and its longhands, and
// what an animation leaves on a style once it has run.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import { parseStylesheet } from '../../src/html/css/parse.js';
import {
  NO_ANIMATIONS,
  animationLonghand,
  parseAnimation,
  parseEasing,
  parseTime,
} from '../../src/html/css/animation.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { boxOf, render, view } from './harness.js';

afterEach(cleanup);

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
  const { node } = await render(
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
  const { node } = await render(
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
  const { node } = await render(
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
  const { node } = await render(
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
  const { node } = await render(
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
