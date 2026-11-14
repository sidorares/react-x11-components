// IndexedDB's interfaces in Web IDL's shape: members enumerable, an
// attribute read off anything but an instance a TypeError, an operation's
// required arguments checked and counted in its `length`, and an interface
// with no constructor one a page cannot call.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

(SCRIPTS_CONTAINED ? test : test.skip)(
  'IndexedDB’s interfaces are in Web IDL’s shape, and still the classes of what the realm makes',
  async () => {
    const page = await scriptedPage(
      '<script>' +
        'var r = [];' +
        'function threw(f) { try { f(); return "none"; } catch (e) { return e.name; } }' +
        'var d = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "name");' +
        'r.push(d.enumerable, Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "get").enumerable);' +
        'r.push(threw(function () { return IDBRequest.prototype.result; }));' +
        'r.push(threw(function () { return new IDBObjectStore(); }), threw(function () { IDBIndex(); }));' +
        'r.push(IDBObjectStore.prototype.createIndex.length, IDBKeyRange.only.length);' +
        'r.push(threw(function () { indexedDB.open(); }), threw(function () { IDBKeyRange.bound(1); }));' +
        'var range = IDBKeyRange.only(1);' +
        'r.push(range instanceof IDBKeyRange, range.constructor === IDBKeyRange, Object.getPrototypeOf(IDBOpenDBRequest) === IDBRequest);' +
        'var open = indexedDB.open("webidl-shape");' +
        'r.push(open instanceof IDBOpenDBRequest, open.source, open.transaction);' +
        'open.onsuccess = function () { r.push(open.result instanceof IDBDatabase); open.result.close(); console.log("out " + r.join("|")); };' +
        '</script>',
    );
    assert.equal(
      await page.until('out'),
      'true|true|TypeError|TypeError|TypeError|2|1|TypeError|TypeError|true|true|true|true|||true',
    );
  },
);
