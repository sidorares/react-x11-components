// <Html scripts>' slot assignment as a page sees it change: `slotchange`
// at a slot whose assigned nodes changed (DOM 4.2.2.5), in the mutation
// observer microtask, and a shadow root whose `slotAssignment` is manual,
// whose slots are assigned what `slot.assign()` names (HTML 4.12.4).
// WPT's `shadow-dom/slotchange*.html` and `imperative-slot-api*.html`.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What a page's script logged as `out …`, once its promise settled. */
async function inPage(code: string): Promise<unknown> {
  const page = await scriptedPage(
    `<div id="host"></div><script>
     (async function () {${code}})().then(
       function (v) { console.log('out ' + JSON.stringify(v)); },
       function (e) { console.log('out ' + JSON.stringify('threw ' + e)); });
     </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

const tick = 'await new Promise(function (go) { setTimeout(go, 0); });';

test('a slot hears slotchange once a task its assigned nodes changed in', async () => {
  const out = await inPage(
    `var host = document.getElementById('host');
     var root = host.attachShadow({ mode: 'open' });
     root.innerHTML = '<slot id="a"></slot><slot id="b" name="b"></slot>';
     var heard = [];
     root.addEventListener('slotchange', function (e) {
       heard.push(e.target.id + ':' + e.bubbles + ':' + e.composed);
     });
     var x = document.createElement('span');
     host.append(x, document.createElement('i'));
     var sync = heard.length;
     ${tick}
     var first = heard.splice(0);
     x.slot = 'b';
     ${tick}
     var moved = heard.splice(0).sort();
     x.slot = 'nowhere';
     ${tick}
     var gone = heard.splice(0);
     x.id = 'still';
     ${tick}
     return [sync, first, moved, gone, heard];`,
  );
  assert.deepEqual(out, [
    0,
    ['a:true:false'],
    ['a:true:false', 'b:true:false'],
    ['b:true:false'],
    [],
  ]);
});

test('a slot renamed, removed or given fallback is signalled', async () => {
  const out = await inPage(
    `var host = document.getElementById('host');
     var root = host.attachShadow({ mode: 'open' });
     root.innerHTML = '<slot id="a"></slot>';
     var a = root.getElementById('a');
     var heard = [];
     a.addEventListener('slotchange', function () { heard.push('a'); });
     host.append(document.createTextNode('t'));
     ${tick}
     var assigned = heard.splice(0);
     a.name = 'other';
     ${tick}
     var renamed = heard.splice(0);
     a.append(document.createElement('b'));
     ${tick}
     var fallback = heard.splice(0);
     a.name = '';
     ${tick}
     heard.splice(0);
     a.remove();
     ${tick}
     return [assigned, renamed, fallback, heard, a.assignedNodes().length];`,
  );
  assert.deepEqual(out, [['a'], ['a'], ['a'], ['a'], 0]);
});

test('slotchange comes after the mutation observers', async () => {
  const out = await inPage(
    `var host = document.getElementById('host');
     var root = host.attachShadow({ mode: 'open' });
     root.innerHTML = '<slot></slot>';
     var order = [];
     new MutationObserver(function () { order.push('observer'); })
       .observe(host, { childList: true });
     root.firstChild.onslotchange = function () { order.push('slotchange'); };
     host.append(document.createElement('p'));
     ${tick}
     return order;`,
  );
  assert.deepEqual(out, ['observer', 'slotchange']);
});

test('a manual root assigns what assign() names, in its order', async () => {
  const out = await inPage(
    `var host = document.getElementById('host');
     var bad = null;
     try { document.createElement('div').attachShadow({ mode: 'open', slotAssignment: 'other' }); }
     catch (e) { bad = e.name; }
     var root = host.attachShadow({ mode: 'open', slotAssignment: 'manual' });
     root.innerHTML = '<slot id="s1"></slot><slot id="s2"></slot>';
     var s1 = root.getElementById('s1'), s2 = root.getElementById('s2');
     var c1 = document.createElement('i'), c2 = document.createElement('b');
     var c3 = document.createTextNode('t');
     host.append(c1, c2, c3);
     var ids = function (slot) {
       return slot.assignedNodes().map(function (n) { return n.nodeName; });
     };
     var named = ids(s1);
     s1.assign(c3, c1);
     var first = [ids(s1), c1.assignedSlot === s1, c2.assignedSlot];
     s2.assign(c1, c2);
     var moved = [ids(s1), ids(s2)];
     c2.remove();
     var removed = ids(s2);
     host.append(c2);
     var back = ids(s2);
     var seq = null;
     try { s1.assign([c3]); } catch (e) { seq = e.name; }
     return [bad, root.slotAssignment, named, first, moved, removed, back, seq];`,
  );
  assert.deepEqual(out, [
    'TypeError',
    'manual',
    [],
    [['#text', 'I'], true, null],
    [['#text'], ['I', 'B']],
    ['I'],
    ['I', 'B'],
    'TypeError',
  ]);
});

test('a clone of a manual root is manual', async () => {
  const out = await inPage(
    `var host = document.getElementById('host');
     var root = host.attachShadow({ mode: 'open', slotAssignment: 'manual', clonable: true });
     return host.cloneNode(false).shadowRoot.slotAssignment;`,
  );
  assert.equal(out, 'manual');
});
