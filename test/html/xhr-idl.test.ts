// `XMLHttpRequest`, `FormData` and `ProgressEvent` as Web IDL has them (XHR
// 3, 5, 6): constants on the interface and its prototype, attributes as
// accessors that check what they are called on, operations enumerable and
// held to their arguments. WPT's xhr/idlharness is the check.
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html } from '../../src/html/index.js';
import { preloadHtmlScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What a page's script logs, one line per check. */
async function logged(script: string): Promise<string[]> {
  const logs: string[] = [];
  await renderX11(
    React.createElement(Html, {
      source: `<!doctype html><html><body><script>${script}; console.log('done')</script></body></html>`,
      partial: false,
      baseUrl: 'https://example.test/page.html',
      scripts: {
        log: (level: string, text: string) =>
          void (level === 'log' && logs.push(text)),
      },
    }),
    { backend: 'mock' },
  );
  const end = Date.now() + 5000;
  while (!logs.includes('done') && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  return logs.filter((l) => l !== 'done');
}

const THROWS =
  'function throws(f) { try { f(); return "none" } catch (e) { return e.constructor.name } }';

test('an XMLHttpRequest is shaped as Web IDL has it', async () => {
  const logs = await logged(
    THROWS +
      'var P = XMLHttpRequest.prototype, x = new XMLHttpRequest();' +
      "var c = Object.getOwnPropertyDescriptor(XMLHttpRequest, 'DONE');" +
      "console.log('const:' + c.value + ':' + c.writable + ':' + c.configurable + ':' + P.DONE + ':' + Object.prototype.hasOwnProperty.call(x, 'DONE'));" +
      "console.log('attr:' + ('get' in Object.getOwnPropertyDescriptor(P, 'readyState')) + ':' + Object.prototype.hasOwnProperty.call(x, 'readyState') + ':' + throws(function () { return P.status }));" +
      "console.log('op:' + Object.getOwnPropertyDescriptor(P, 'open').enumerable + ':' + P.open.length + ':' + throws(function () { x.open() }) + ':' + throws(function () { P.abort.call({}) }));" +
      "x.open('GET', '/'); console.log('state:' + x.readyState + ':' + x.withCredentials);",
  );
  assert.deepEqual(logs, [
    'const:4:false:false:4:false',
    'attr:true:false:TypeError',
    'op:true:2:TypeError:TypeError',
    'state:1:false',
  ]);
});

test('a FormData and a ProgressEvent are shaped as Web IDL has them', async () => {
  const logs = await logged(
    THROWS +
      'var F = FormData.prototype, f = new FormData();' +
      "console.log('form:' + FormData.length + ':' + (F[Symbol.iterator] === F.entries) + ':' + Object.getOwnPropertyDescriptor(F, 'append').enumerable + ':' + throws(function () { f.append('a') }) + ':' + F.append.length);" +
      "f.append('a', '1'); console.log('works:' + f.get('a'));" +
      "var e = new ProgressEvent('progress', { loaded: 3, total: 9, lengthComputable: true });" +
      "console.log('event:' + e.loaded + ':' + e.total + ':' + e.lengthComputable + ':' + Object.prototype.hasOwnProperty.call(e, 'loaded') + ':' + throws(function () { return ProgressEvent.prototype.loaded }));",
  );
  assert.deepEqual(logs, [
    'form:0:true:true:TypeError:2',
    'works:1',
    'event:3:9:true:false:TypeError',
  ]);
});
