// Renaming a store and an index (IndexedDB 3, 4.5 and 4.6): only while the
// database is upgraded, never onto a name another has, and put back where the
// upgrade aborts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

(SCRIPTS_CONTAINED ? test : test.skip)(
  'a store and an index are renamed in an upgrade, refused elsewhere, and named as before after an abort but for what it created',
  async () => {
    const page = await scriptedPage(
      '<script>' +
        'var r = [];' +
        'function threw(f) { try { f(); return "none"; } catch (e) { return e.name; } }' +
        'var open = indexedDB.open("rename", 1);' +
        'open.onupgradeneeded = function () {' +
        '  var db = open.result;' +
        '  var books = db.createObjectStore("books", { keyPath: "id" });' +
        '  db.createObjectStore("films");' +
        '  var by = books.createIndex("by_title", "title");' +
        '  books.createIndex("by_year", "year");' +
        '  books.put({ id: 1, title: "x" });' +
        '  books.name = "novels";' +
        '  r.push(books.name, [].slice.call(db.objectStoreNames).join(), open.transaction.objectStore("novels") === books);' +
        '  r.push(threw(function () { books.name = "films"; }));' +
        '  by.name = "by_name";' +
        '  r.push(by.name, [].slice.call(books.indexNames).join(), books.index("by_name") === by);' +
        '  r.push(threw(function () { by.name = "by_year"; }));' +
        '};' +
        'open.onsuccess = function () {' +
        '  var db = open.result;' +
        '  var tx = db.transaction("novels", "readwrite");' +
        '  var store = tx.objectStore("novels");' +
        '  r.push(threw(function () { store.name = "x"; }), threw(function () { store.index("by_name").name = "y"; }));' +
        '  store.get(1).onsuccess = function (e) {' +
        '    r.push(e.target.result.title);' +
        '    db.close();' +
        '    var again = indexedDB.open("rename", 2);' +
        '    again.onupgradeneeded = function () {' +
        '      var s = again.transaction.objectStore("novels");' +
        '      var i = s.index("by_name");' +
        '      s.name = "poems";' +
        '      i.name = "by_line";' +
        '      var made = again.result.createObjectStore("new");' +
        '      made.name = "newer";' +
        '      again.transaction.abort();' +
        '      r.push(s.name, i.name, made.name, made.indexNames.length);' +
        '    };' +
        '    again.onerror = function () { console.log("out " + r.join("|")); };' +
        '  };' +
        '};' +
        '</script>',
    );
    assert.equal(
      await page.until('out'),
      'novels|films,novels|true|ConstraintError|by_name|by_name,by_year|true|ConstraintError|InvalidStateError|InvalidStateError|x|novels|by_name|newer|0',
    );
  },
);
