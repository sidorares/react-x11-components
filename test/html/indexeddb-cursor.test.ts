// What a cursor's methods ask, in IndexedDB 3, 4.8's order: the transaction
// is active, then its source is there, then what only continuePrimaryKey()
// asks of its source and direction, then whether it may write and has a
// record, and its keys last; a key that is not past the cursor is a
// DataError. Its direction is an attribute, and update() and delete() are
// requests whose source is the cursor.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

(SCRIPTS_CONTAINED ? test : test.skip)(
  'a cursor’s methods throw in IndexedDB’s order, and its update and delete requests come from it',
  async () => {
    const page = await scriptedPage(
      '<script>' +
        'var r = [];' +
        'function threw(f) { try { f(); return "none"; } catch (e) { return e.name; } }' +
        'var open = indexedDB.open("cursors", 1);' +
        'open.onupgradeneeded = function () {' +
        '  var s = open.result.createObjectStore("s");' +
        '  s.createIndex("i", "k");' +
        '  s.put({ k: "a" }, 1); s.put({ k: "b" }, 2); s.put({ k: "c" }, 3);' +
        '};' +
        'open.onsuccess = function () {' +
        '  var db = open.result;' +
        '  r.push(typeof Object.getOwnPropertyDescriptor(IDBCursor.prototype, "direction").get);' +
        '  var ro = db.transaction("s", "readonly").objectStore("s");' +
        '  var once = {};' +
        '  ro.openCursor().onsuccess = function (e) {' +
        '    var c = e.target.result;' +
        '    if (once.a) return; once.a = true;' +
        '    r.push(threw(function () { c.continuePrimaryKey("a", 1); }), threw(function () { c.update({ k: "z" }); }), threw(function () { c.delete(); }));' +
        '    c.continue();' +
        '    r.push(threw(function () { c.continue(); }), threw(function () { c.continue(1); }));' +
        '  };' +
        '  ro.index("i").openCursor(null, "nextunique").onsuccess = function (e) {' +
        '    var c = e.target.result;' +
        '    if (once.u) return; once.u = true;' +
        '    r.push(threw(function () { c.continuePrimaryKey("b", 2); }));' +
        '  };' +
        '  ro.index("i").openCursor().onsuccess = function (e) {' +
        '    var c = e.target.result;' +
        '    if (once.i) return;' +
        '    if (c.key !== "b") { c.continue(); return; }' +
        '    once.i = true;' +
        '    r.push(threw(function () { c.continuePrimaryKey("a", 9); }), threw(function () { c.continuePrimaryKey("b", 2); }), threw(function () { c.continue("a"); }));' +
        '    setTimeout(function () {' +
        '      r.push(threw(function () { c.continue({}); }));' +
        '      var rw = db.transaction("s", "readwrite").objectStore("s");' +
        '      rw.openCursor().onsuccess = function (e) {' +
        '        var w = e.target.result;' +
        '        if (once.w) return; once.w = true;' +
        '        var del = w.delete();' +
        '        r.push(del.source === w);' +
        '        console.log("out " + r.join("|"));' +
        '      };' +
        '    }, 0);' +
        '  };' +
        '};' +
        '</script>',
    );
    assert.equal(
      await page.until('out'),
      'function|InvalidAccessError|ReadOnlyError|ReadOnlyError|InvalidStateError|InvalidStateError|InvalidAccessError|DataError|DataError|DataError|TransactionInactiveError|true',
    );
  },
);
