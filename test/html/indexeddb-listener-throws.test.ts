// A listener that throws at a request's success or error event, or at an
// upgrade's upgradeneeded, aborts its transaction with an AbortError once
// the dispatch is over (IndexedDB 3, 5.6, 5.7 and 5.8), and a handleEvent
// that is no function is a listener that throws.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

(SCRIPTS_CONTAINED ? test : test.skip)(
  'a listener that throws at a request or an upgrade aborts its transaction',
  async () => {
    const page = await scriptedPage(
      '<script>' +
        'var r = [];' +
        'window.onerror = function () { return true; };' +
        'var open = indexedDB.open("throws", 1);' +
        'open.onupgradeneeded = function () { open.result.createObjectStore("s"); };' +
        'open.onsuccess = function () {' +
        '  var db = open.result;' +
        '  var one = db.transaction("s", "readonly");' +
        '  var got = one.objectStore("s").get(0);' +
        '  var later = false;' +
        '  got.addEventListener("success", function () { throw new Error("x"); });' +
        '  got.addEventListener("success", function () { later = true; });' +
        '  one.oncomplete = function () { r.push("complete"); };' +
        '  one.onabort = function () {' +
        '    r.push(one.error.name, later);' +
        '    var two = db.transaction("s", "readwrite");' +
        '    two.objectStore("s").put(0, 0);' +
        '    var add = two.objectStore("s").add(0, 0);' +
        '    add.onerror = function (e) { e.preventDefault(); throw new Error("y"); };' +
        '    two.oncomplete = function () { r.push("complete"); };' +
        '    two.onabort = function () {' +
        '      r.push(two.error.name);' +
        '      var three = db.transaction("s", "readonly");' +
        '      three.objectStore("s").get(0).addEventListener("success", { handleEvent: null });' +
        '      three.onabort = function () {' +
        '        r.push(three.error.name);' +
        '        db.close();' +
        '        var up = indexedDB.open("throws", 2);' +
        '        var tx;' +
        '        up.onupgradeneeded = function () { tx = up.transaction; throw new Error("z"); };' +
        '        up.onsuccess = function () { r.push("opened"); };' +
        '        up.onerror = function () { r.push(tx.error.name); console.log("out " + r.join("|")); };' +
        '      };' +
        '    };' +
        '  };' +
        '};' +
        '</script>',
    );
    assert.equal(
      await page.until('out'),
      'AbortError|true|AbortError|AbortError|AbortError',
    );
  },
);
