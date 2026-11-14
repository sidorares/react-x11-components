// SMIL in a drawing (src/html/scripts/smil.ts): `<animate>`, `<set>`,
// `<animateTransform>` and `<animateMotion>` on the document's timeline,
// which `pauseAnimations()` and `setCurrentTime()` drive, read back through
// an attribute's `animVal`, `getComputedStyle()`, `getBBox()` and `getCTM()`,
// and the begin, repeat and end events. WPT's `svg/animations/` holds the
// rest; what each case expects is what Chromium answers.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What a page's script logs as `out …` once its `load` is told, with the
 *  drawing's timeline paused at 0. */
async function atLoad(svg: string, code: string): Promise<unknown> {
  const page = await scriptedPage(
    `<svg id="root" width="200" height="100">${svg}</svg>
     <script>addEventListener('load', function () {
       var root = document.getElementById('root');
       root.pauseAnimations();
       var at = function (t) { root.setCurrentTime(t); };
       var $ = function (id) { return document.getElementById(id); };
       Promise.resolve().then(function () { ${code} }).then(
         function (v) { console.log('out ' + JSON.stringify(v)); },
         function (e) { console.log('out ' + JSON.stringify(String(e))); });
     });</script>`,
  );
  const out = JSON.parse(
    await page.until('out ').catch((e) => {
      throw new Error(page.logs.join('\n') || String(e));
    }),
  );
  page.result.unmount();
  return out;
}

test('an animate sets an attribute through its animVal, frozen at its end', async () => {
  const out = await atLoad(
    `<rect id="r" width="100" height="10">
       <animate attributeName="width" from="100px" to="5cm" dur="4s" fill="freeze"/>
     </rect>`,
    `var r = $('r'), out = [];
     [0, 2, 3.999, 5].forEach(function (t) {
       at(t); out.push(Math.round(r.width.animVal.value * 10) / 10);
     });
     out.push(r.width.baseVal.value, r.getAttribute('width'));
     return out;`,
  );
  assert.deepEqual(out, [100, 144.5, 189, 189, 100, '100']);
});

test('a by animation adds to what is under it, and a later one goes over it', async () => {
  const out = await atLoad(
    `<rect id="r" width="10" height="100">
       <animate attributeName="width" fill="freeze" by="40" begin="0s" dur="4s"/>
       <animate attributeName="width" additive="replace" fill="freeze" by="50" begin="5s" dur="4s"/>
     </rect>`,
    `var r = $('r'), out = [];
     [2, 4, 7, 9].forEach(function (t) { at(t); out.push(r.width.animVal.value); });
     return out;`,
  );
  assert.deepEqual(out, [30, 50, 75, 100]);
});

test('an invalid value leaves the attribute as it was', async () => {
  const out = await atLoad(
    `<rect id="r" width="100" height="100" fill="green">
       <animate attributeName="fill" from="gr   een" to="red" dur="3s" fill="freeze"/>
       <animate attributeName="width" dur="4s" by="200   px"/>
     </rect>`,
    `var r = $('r'); at(2);
     return [getComputedStyle(r).fill, r.width.animVal.value];`,
  );
  assert.deepEqual(out, ['rgb(0, 128, 0)', 100]);
});

test('a set and a colour animation are what a computed style reads, inherited too', async () => {
  const out = await atLoad(
    `<g id="g" fill="red">
       <set attributeName="fill" to="blue" begin="1s" dur="2s"/>
       <rect id="r" width="10" height="10"/>
     </g>
     <rect id="c" width="10" height="10" fill="#000">
       <animate attributeName="fill" from="#000" to="#fff" dur="2s"/>
     </rect>`,
    `var out = [];
     [0.5, 1.5, 3.5].forEach(function (t) {
       at(t);
       out.push(getComputedStyle($('g')).fill, getComputedStyle($('r')).fill);
     });
     at(1); out.push(getComputedStyle($('c')).fill);
     return out;`,
  );
  assert.deepEqual(out, [
    'rgb(255, 0, 0)',
    'rgb(255, 0, 0)',
    'rgb(0, 0, 255)',
    'rgb(0, 0, 255)',
    'rgb(255, 0, 0)',
    'rgb(255, 0, 0)',
    'rgb(128, 128, 128)',
  ]);
});

test('animateMotion moves what getBBox and getCTM read', async () => {
  const out = await atLoad(
    `<rect id="r" width="10" height="10">
       <animateMotion path="M0,0 L100,0" dur="4s" fill="freeze"/>
     </rect>`,
    `var out = [];
     [0, 2, 5].forEach(function (t) {
       at(t); out.push($('root').getBBox().x, $('r').getCTM().e);
     });
     return out;`,
  );
  assert.deepEqual(out, [0, 0, 50, 50, 100, 100]);
});

test('seeking tells what began and ended, and nothing it passed over', async () => {
  const out = await atLoad(
    `<set id="a" attributeName="fill" to="green" begin="5s" dur="1s" repeatCount="2" fill="freeze"/>
     <set id="b" attributeName="fill" to="green" begin="9s" dur="11s"/>`,
    `var seen = [];
     ['a', 'b'].forEach(function (id) {
       ['beginEvent', 'repeatEvent', 'endEvent'].forEach(function (type) {
         $(id).addEventListener(type, function () { seen.push(id + ' ' + type); });
       });
     });
     var wait = function () { return new Promise(function (go) { setTimeout(go, 50); }); };
     at(10);
     return wait().then(function () {
       seen.push('|'); at(5.5); return wait();
     }).then(function () { return seen; });`,
  );
  assert.deepEqual(out, ['b beginEvent', '|', 'b endEvent', 'a beginEvent']);
});

test('the timing methods answer for the interval', async () => {
  const out = await atLoad(
    `<rect><animate id="a" attributeName="x" from="0" to="10" begin="2s" dur="3s"/></rect>`,
    `var a = $('a'), out = [a.getStartTime(), a.getSimpleDuration()];
     at(3); out.push(a.getCurrentTime(), $('root').animationsPaused());
     try { $('root').setCurrentTime(NaN); } catch (e) { out.push(e.name); }
     return out;`,
  );
  assert.deepEqual(out, [2, 3, 3, true, 'TypeError']);
});

test('currentColor and inherit are what the element and its parent compute', async () => {
  const out = await atLoad(
    `<rect id="r" width="10" height="10" fill="red" color="green">
       <animate attributeName="fill" from="red" to="currentColor" dur="3s" fill="freeze"/>
     </rect>
     <g fill="green">
       <rect id="i" width="10" height="10" fill="red">
         <animate attributeName="fill" from="red" to="inherit" dur="3s" fill="freeze"/>
       </rect>
     </g>`,
    `at(1.5);
     return [getComputedStyle($('r')).fill, getComputedStyle($('i')).fill,
             getComputedStyle($('r')).color];`,
  );
  assert.deepEqual(out, [
    'rgb(128, 64, 0)',
    'rgb(128, 64, 0)',
    'rgb(0, 128, 0)',
  ]);
});

test("an event named `end` runs no `onend`, which is `endEvent`'s", async () => {
  const out = await atLoad(
    `<rect><animate id="a" attributeName="x" from="0" to="1" dur="1s" onend="window.ran = (window.ran || 0) + 1"/></rect>`,
    `var a = $('a');
     a.dispatchEvent(new Event('end'));
     var seen = [window.ran || 0, typeof a.onend];
     var wait = function () { return new Promise(function (go) { setTimeout(go, 50); }); };
     at(0.5);
     return wait().then(function () {
       a.onend = function () { seen.push('idl'); };
       at(2);
       return wait();
     }).then(function () { seen.push(window.ran || 0); return seen; });`,
  );
  assert.deepEqual(out, [0, 'function', 'idl', 0]);
});
