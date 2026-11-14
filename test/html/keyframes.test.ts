// <Html scripts>' Web Animations, as a page hands them keyframes and reads
// them back: a keyframe-like object is read as Web Animations 1, 5.2.2 has
// it, its animatable properties alone and in code-point order;
// `commitStyles` writes the values of an element a script made a moment
// ago; and `getComputedStyle` reads the box-shadow and clip an animation
// sets. WPT's `web-animations/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What a function of the page's comes to, through JSON. */
async function inPage(code: string): Promise<unknown> {
  const page = await scriptedPage(
    `<div id="c"><div id="e"></div></div><script>console.log("out " + JSON.stringify((function () {
      var e = document.getElementById('e');
      var c = document.getElementById('c');
      ${code}
    })()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test("a keyframe-like object's getters are called for its animatable properties alone, in code-point order", async () => {
  const out = await inPage(
    `var read = [];
     var frame = {};
     ['opacity', 'animationName', 'direction', 'left', 'fontSize', 'font-size', 'willChange'].forEach(function (name) {
       Object.defineProperty(frame, name, {
         get: function () { read.push(name); return '1'; }, enumerable: true });
     });
     new KeyframeEffect(null, frame);
     var indexed = read.slice();
     read.length = 0;
     new KeyframeEffect(null, [frame]);
     return [indexed, read];`,
  );
  const order = ['fontSize', 'left', 'opacity'];
  assert.deepEqual(out, [order, order]);
});

test('commitStyles writes the values of an element the script made a moment ago', async () => {
  const out = await inPage(
    `var d = document.createElement('div');
     document.body.appendChild(d);
     var a = d.animate({ opacity: ['0.2', '0.2'] }, { duration: 1, fill: 'forwards' });
     a.finish();
     a.commitStyles();
     return d.style.opacity;`,
  );
  assert.equal(out, '0.2');
});

test('getComputedStyle reads an element’s box-shadow and clip, an animated one among them', async () => {
  const out = await inPage(
    `var before = [getComputedStyle(e).boxShadow, getComputedStyle(e).clip];
     e.style.position = 'absolute';
     e.style.clip = 'rect(1px, auto, 3px, 4px)';
     c.style.color = 'rgb(0, 128, 0)';
     var a = e.animate([{ boxShadow: '2px 3px 4px 5px currentColor inset' },
       { boxShadow: '2px 3px 4px 5px currentColor inset' }], 10);
     a.pause();
     a.currentTime = 5;
     return before.concat([getComputedStyle(e).boxShadow, getComputedStyle(e).clip]);`,
  );
  assert.deepEqual(out, [
    'none',
    'auto',
    'rgb(0, 128, 0) 2px 3px 4px 5px inset',
    'rect(1px, auto, 3px, 4px)',
  ]);
});

test('a keyframe’s composite is its enum, repeated over the frames, and its easing is read as CSS reads it after every frame', async () => {
  const out = await inPage(
    `var repeated = new KeyframeEffect(null, { left: ['1px', '2px', '3px'], composite: 'add' })
       .getKeyframes().map(function (k) { return k.composite; });
     var easing = new KeyframeEffect(null, [{ left: '1px', easing: 'Ease\\\\2d in-out' }, { left: '2px' }])
       .getKeyframes()[0].easing;
     var bad = '';
     try { new KeyframeEffect(null, { left: ['1px', '2px'], composite: 'Replace' }); } catch (x) { bad = x.name; }
     var read = false;
     var late = '';
     try {
       new KeyframeEffect(null, [{ easing: '' }, { get left() { read = true; return '1px'; } }]);
     } catch (x) { late = x.name; }
     return [repeated, easing, bad, late, read];`,
  );
  assert.deepEqual(out, [
    ['add', 'add', 'add'],
    'ease-in-out',
    'TypeError',
    'TypeError',
    true,
  ]);
});

test('a time set as a number of CSS is milliseconds, and a reversed animation finished is at 0 and not -0', async () => {
  const out = await inPage(
    `var a = e.animate(null, 100000);
     a.currentTime = CSSNumericValue.parse('3000');
     var set = a.currentTime;
     var b = e.animate(null, 100000);
     b.reverse();
     b.finish();
     return [set, Object.is(b.currentTime, -0)];`,
  );
  assert.deepEqual(out, [3000, false]);
});

test('getAnimations() takes a pseudo-element, and a document lists only what is in it', async () => {
  const out = await inPage(
    `var a = e.animate({ opacity: [0, 1] }, { duration: 100000, pseudoElement: '::before' });
     var mine = e.animate({ opacity: [0, 1] }, 100000);
     var gone = document.createElement('div');
     gone.animate({ opacity: [0, 1] }, 100000);
     var bad = '';
     try { e.getAnimations({ pseudoElement: ':invalid-pseudo' }); } catch (x) { bad = x.name; }
     return [
       e.getAnimations().length,
       e.getAnimations({ pseudoElement: ':before' }).length,
       e.getAnimations({ subtree: true }).length,
       document.getAnimations().length,
       a.effect.pseudoElement,
       bad,
     ];`,
  );
  assert.deepEqual(out, [1, 1, 2, 2, '::before', 'SyntaxError']);
});

test('an element an effect no longer targets reads its own style at once', async () => {
  const out = await inPage(
    `e.style.marginLeft = '10px';
     c.style.marginLeft = '20px';
     var a = e.animate({ marginLeft: ['0px', '100px'] }, 100000);
     a.currentTime = 50000;
     var before = getComputedStyle(e).marginLeft;
     a.effect.target = c;
     var moved = [getComputedStyle(e).marginLeft, getComputedStyle(c).marginLeft];
     a.effect.target = null;
     return [before, moved, getComputedStyle(c).marginLeft];`,
  );
  assert.deepEqual(out, ['50px', ['10px', '50px'], '20px']);
});

test('a filling animation another replaces is removed after the call that finished it, a shorthand counted as its longhands', async () => {
  const page = await scriptedPage(
    `<div id="e"></div><script>(async function () {
      var e = document.getElementById('e');
      var frame = function () { return new Promise(function (go) { requestAnimationFrame(go); }); };
      var a = e.animate({ opacity: 1 }, { duration: 1, fill: 'forwards' });
      var b = e.animate({ opacity: 1 }, { duration: 100000, fill: 'forwards' });
      await a.finished;
      var states = [a.replaceState];
      b.finish();
      states.push(a.replaceState);
      await frame();
      states.push(a.replaceState, b.replaceState);
      var c = e.animate({ marginLeft: '10px' }, { duration: 1, fill: 'forwards' });
      var d = e.animate({ margin: '20px' }, { duration: 30, fill: 'forwards' });
      await d.finished;
      await frame();
      states.push(c.replaceState, d.replaceState);
      console.log('out ' + JSON.stringify(states));
    })();</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  assert.deepEqual(out, [
    'active',
    'active',
    'removed',
    'active',
    'removed',
    'active',
  ]);
});

test('a size an animation is sought to is laid out before a page reads it, and a keyword runs in a min-width', async () => {
  const page = await scriptedPage(
    `<div style="width: 600px; interpolate-size: allow-keywords"><div id="t"><div style="height: 100px; width: 23px"></div></div></div><script>
      var t = document.getElementById('t'), r = [];
      var a = t.animate({ height: ['calc-size(auto, size)', 'calc-size(auto, size * 2)'] }, 1000);
      a.pause();
      a.currentTime = 250;
      r.push(getComputedStyle(t).height);
      a.currentTime = 500;
      r.push(getComputedStyle(t).height);
      a.cancel();
      var b = t.animate({ minWidth: ['initial', '20px'] }, 1000);
      b.pause();
      b.currentTime = 300;
      r.push(getComputedStyle(t).minWidth);
      console.log('out ' + JSON.stringify(r));
    </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  assert.deepEqual(out, [
    '125px',
    '150px',
    'calc-size(auto, 6px + (0.7 * size))',
  ]);
});

test("a CSS animation's keyframe composites as its animation-composition says", async () => {
  const page = await scriptedPage(
    `<style>@keyframes k { from { margin-left: 10px; animation-composition: add } to { margin-left: 30px; animation-composition: add } }
      #t { margin-left: 100px; animation: k 1s linear paused }</style><div id="t"></div><script>
      var t = document.getElementById('t');
      var a = t.getAnimations()[0];
      a.currentTime = 500;
      console.log('out ' + JSON.stringify([getComputedStyle(t).marginLeft]));
    </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  assert.deepEqual(out, ['120px']);
});
