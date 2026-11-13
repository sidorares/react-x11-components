// <Html scripts>' window as Web IDL has a `[Global]` interface's members
// (3.7.6, 3.7.7): own properties of the window, operations enumerable data
// properties, attributes accessors, `[LegacyUnforgeable]` ones not
// configurable and `[Replaceable]` ones with a setter that puts what it is
// set to in their place — what WPT's
// `html/browsers/the-window-object/window-properties.https.html` reads.
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
    `<script>console.log("out " + JSON.stringify((function () {${code}})()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

/** A property's descriptor, as a short string. */
const DESCRIBE = `var describe = function (name) {
  var d = Object.getOwnPropertyDescriptor(window, name);
  if (!d) return 'none';
  return ('value' in d ? 'data' + (d.writable ? 'W' : '') : 'get' +
    (typeof d.get === 'function' ? '' : '?') +
    (typeof d.set === 'function' ? 'S' : '')) +
    (d.enumerable ? 'E' : '') + (d.configurable ? 'C' : '');
};`;

test('an operation is an enumerable data property, an interface is not', async () => {
  const out = await inPage(
    `${DESCRIBE}
     return ['setTimeout', 'getComputedStyle', 'moveTo', 'moveBy', 'Node',
       'addEventListener'].map(describe)
       .concat([Object.getOwnPropertyDescriptor(EventTarget.prototype,
         'addEventListener').enumerable]);`,
  );
  assert.deepEqual(out, [
    'dataWEC',
    'dataWEC',
    'dataWEC',
    'dataWEC',
    'dataWC',
    'none',
    true,
  ]);
});

test('attributes are accessors, unforgeable ones not configurable', async () => {
  const out = await inPage(
    `${DESCRIBE}
     return ['window', 'document', 'top', 'self', 'frames', 'parent', 'history',
       'navigator', 'frameElement', 'screen', 'external', 'toolbar', 'name',
       'innerWidth', 'localStorage'].map(describe)
       .concat([Object.getOwnPropertyDescriptor(window, 'window').get.call(window)
         === window, typeof external.AddSearchProvider]);`,
  );
  assert.deepEqual(out, [
    'getE',
    'getE',
    'getE',
    'getSEC',
    'getSEC',
    'getSEC',
    'getEC',
    'getEC',
    'getEC',
    'getSEC',
    'getSEC',
    'getSEC',
    'getSEC',
    'getSEC',
    'getEC',
    true,
    'function',
  ]);
});

test('a replaceable attribute takes what it is set to', async () => {
  const out = await inPage(
    `var bar = toolbar;
     self = 1; screen = 2; toolbar = 3;
     return [self, screen, toolbar, window.window === window,
       typeof bar.visible];`,
  );
  assert.deepEqual(out, [1, 2, 3, true, 'boolean']);
});

test('the window has the handlers HTML gives it', async () => {
  const out = await inPage(
    `var names = ['onafterprint', 'onbeforeprint', 'onclose', 'oninvalid',
       'onstorage'];
     var seen = [];
     names.forEach(function (n) { window[n] = function () { seen.push(n); }; });
     window.dispatchEvent(new Event('storage'));
     window.dispatchEvent(new Event('afterprint'));
     return names.map(function (n) { return n in window; }).concat(seen);`,
  );
  assert.deepEqual(out, [
    true,
    true,
    true,
    true,
    true,
    'onstorage',
    'onafterprint',
  ]);
});
