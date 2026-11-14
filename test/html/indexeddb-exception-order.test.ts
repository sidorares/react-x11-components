// What a store's or an index's request asks first (IndexedDB 3, 4.5 and
// 4.6): its arguments, then whether the store or the index was deleted,
// then whether the transaction is active, then whether it may write, and
// the key only after all of them. A transaction is active through the task
// that made it and those that fire its requests' events, the microtasks
// after them among them, so a promise that awaits a request goes on in it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

(SCRIPTS_CONTAINED ? test : test.skip)(
  'a request on a deleted store, an inactive transaction or a read-only one throws in IndexedDB’s order',
  async () => {
    const page = await scriptedPage(
      '<script>' +
        'var r = [];' +
        'function threw(f) { try { f(); return "none"; } catch (e) { return e.name; } }' +
        'var open = indexedDB.open("order", 1);' +
        'open.onupgradeneeded = function () {' +
        '  var db = open.result;' +
        '  db.createObjectStore("s");' +
        '  var gone = db.createObjectStore("gone");' +
        '  var index = gone.createIndex("i", "x");' +
        '  db.deleteObjectStore("gone");' +
        '  setTimeout(function () {' +
        '    r.push(threw(function () { gone.get({}); }), threw(function () { index.count({}); }));' +
        '  }, 0);' +
        '};' +
        'open.onsuccess = function () {' +
        '  var db = open.result;' +
        '  var tx = db.transaction("s", "readonly");' +
        '  var store = tx.objectStore("s");' +
        '  r.push(threw(function () { store.put(1, {}); }), threw(function () { store.get({}); }));' +
        '  setTimeout(function () {' +
        '    r.push(threw(function () { store.get({}); }), threw(function () { store.put(1, {}); }), threw(function () { store.getAll(null, -1); }));' +
        '    var rw = db.transaction("s", "readwrite").objectStore("s");' +
        '    var put = rw.put("a", 1);' +
        '    new Promise(function (go) { put.onsuccess = go; }).then(function () {' +
        '      r.push(threw(function () { rw.get(1); }));' +
        '      console.log("out " + r.join("|"));' +
        '    });' +
        '  }, 0);' +
        '};' +
        '</script>',
    );
    assert.equal(
      await page.until('out'),
      'InvalidStateError|InvalidStateError|ReadOnlyError|DataError|TransactionInactiveError|TransactionInactiveError|TypeError|none',
    );
  },
);

(SCRIPTS_CONTAINED ? test : test.skip)(
  'a request a success listener asks is answered in a task of its own, and commit() leaves a transaction inactive',
  async () => {
    const page = await scriptedPage(
      '<script>' +
        'var r = [];' +
        'function threw(f) { try { f(); return "none"; } catch (e) { return e.name; } }' +
        'var open = indexedDB.open("spin", 1);' +
        'open.onupgradeneeded = function () { open.result.createObjectStore("s"); };' +
        'open.onsuccess = function () {' +
        '  var db = open.result;' +
        '  var tx = db.transaction("s", "readonly");' +
        '  var store = tx.objectStore("s");' +
        '  var spins = 0, spinning = true, ticks = 0;' +
        '  (function spin() { if (!spinning) return; spins += 1; store.get(0).onsuccess = spin; })();' +
        '  (function tick() {' +
        '    ticks += 1;' +
        '    if (ticks < 5) { setTimeout(tick, 0); return; }' +
        '    spinning = false;' +
        '    r.push(spins > 1, spins < 1000);' +
        '    var w = db.transaction("s", "readwrite");' +
        '    var ws = w.objectStore("s");' +
        '    ws.put(1, 1);' +
        '    w.commit();' +
        '    r.push(threw(function () { ws.put(2, 2); }), threw(function () { w.commit(); }), threw(function () { w.abort(); }));' +
        '    w.oncomplete = function () { console.log("out " + r.join("|")); };' +
        '  })();' +
        '};' +
        '</script>',
    );
    assert.equal(
      await page.until('out'),
      'true|true|TransactionInactiveError|InvalidStateError|InvalidStateError',
    );
  },
);

(SCRIPTS_CONTAINED ? test : test.skip)(
  'a transaction waits for an earlier one it overlaps where either writes, and a throw after commit() leaves it to commit',
  async () => {
    const page = await scriptedPage(
      '<script>' +
        'var r = [];' +
        'window.onerror = function () { return true; };' +
        'var open = indexedDB.open("waits", 1);' +
        'open.onupgradeneeded = function () { open.result.createObjectStore("s"); };' +
        'open.onsuccess = function () {' +
        '  var db = open.result;' +
        '  var one = db.transaction("s", "readwrite");' +
        '  one.oncomplete = function () { r.push("one"); };' +
        '  var store = one.objectStore("s");' +
        '  store.put("a", 1).onsuccess = function () {' +
        '    var two = db.transaction("s", "readonly");' +
        '    two.oncomplete = function () {' +
        '      r.push("two");' +
        '      var three = db.transaction("s", "readwrite");' +
        '      var put = three.objectStore("s").put("c", 3);' +
        '      three.commit();' +
        '      put.onsuccess = function () { throw new Error("after commit"); };' +
        '      three.oncomplete = function () { r.push("committed"); console.log("out " + r.join("|")); };' +
        '      three.onabort = function () { r.push("aborted"); console.log("out " + r.join("|")); };' +
        '    };' +
        '    store.put("b", 2);' +
        '  };' +
        '};' +
        '</script>',
    );
    assert.equal(await page.until('out'), 'one|two|committed');
  },
);
