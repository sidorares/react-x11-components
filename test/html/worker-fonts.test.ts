// A worker's `FontFace` and `self.fonts` (CSS Font Loading 3, 2.6), in
// `src/html/scripts/dom.ts`: a worker has no document whose fonts draw
// anything, so a face there is a status and the bytes it holds, in a set with
// a `ready` and the loading events. A script that draws a document's text in
// a worker, as rida.dev's glass worker does, throws without one.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const worker = (source: string): string =>
  `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(source)}], { type: "application/javascript" })))`;

test('a worker has fonts, and a face it makes from bytes loads and is added to it', async () => {
  const p = await scriptedPage(
    '<script>' +
      `var w = ${worker(
        'var out = []; var events = [];' +
          'out.push(typeof self.fonts, self.fonts instanceof FontFaceSet, self.fonts.status, self.fonts === self.fonts);' +
          'self.fonts.onloading = function () { events.push("loading"); };' +
          'self.fonts.addEventListener("loadingdone", function (e) { events.push("done" + e.fontfaces.length); });' +
          'var f = new FontFace("Test", new Uint8Array([1, 2, 3]).buffer, { weight: "700" });' +
          'out.push(f.status, f.family, f.weight);' +
          'self.fonts.add(f);' +
          'out.push(self.fonts.status, self.fonts.size, self.fonts.has(f), self.fonts.check("700 12px Test"));' +
          'var ready = self.fonts.ready;' +
          'f.loaded.then(function () { return ready; }).then(function () {' +
          '  out.push(f.status, self.fonts.status, self.fonts.check("700 12px Test"), self.fonts.size);' +
          '  out.push(self.fonts.delete(f), self.fonts.size, self.fonts.delete(f));' +
          '  postMessage(out.join(",") + "|" + events.join(",")); });',
      )};` +
      'w.onmessage = function (e) { console.log("fonts|" + e.data); };' +
      '</script>',
    15000,
  );
  assert.equal(
    await p.until('fonts|'),
    'object,true,loaded,true,loading,Test,700,loading,1,true,false,' +
      'loaded,loaded,true,1,true,0,false|loading,done1',
  );
});

test('a worker’s face that is not a FontFace is refused by its set, and a bad url face fails to load', async () => {
  const p = await scriptedPage(
    '<script>' +
      `var w = ${worker(
        'function err(f) { try { f(); return "none"; } catch (e) { return e.name; } }' +
          'var bad = new FontFace("Bad", "url(missing.woff2)");' +
          'var out = [bad.status, err(function () { self.fonts.add({}); }), err(function () { self.fonts.has(1); })];' +
          'bad.load().then(function () { out.push("loaded"); }, function (e) { out.push(e.name); })' +
          '  .then(function () { out.push(bad.status); postMessage(out.join(",")); });',
      )};` +
      'w.onmessage = function (e) { console.log("bad|" + e.data); };' +
      '</script>',
    15000,
  );
  assert.equal(
    await p.until('bad|'),
    'unloaded,TypeError,TypeError,NetworkError,error',
  );
});

test('text drawn on an OffscreenCanvas in a worker is set in the page’s fonts, as it is on the page', async () => {
  const draw =
    'var c = new OffscreenCanvas(120, 30); var x = c.getContext("2d");' +
    'x.font = "20px sans-serif"; x.fillStyle = "#000"; x.fillText("Hello", 2, 22);' +
    'var m = x.measureText("Hello").width; var d = x.getImageData(0, 0, 120, 30).data;' +
    'var n = 0; for (var i = 3; i < d.length; i += 4) if (d[i]) n++;';
  const p = await scriptedPage(
    '<script>' +
      `var w = ${worker(`${draw} postMessage(n + "," + m);`)};` +
      'w.onmessage = function (e) { console.log("w|" + e.data); };' +
      `${draw} console.log("page|" + n + "," + m);` +
      '</script>',
    15000,
  );
  const inWorker = await p.until('w|');
  const onPage = await p.until('page|');
  // with no fonts (the mock backend) the page has no ink and a worker the
  // same: they are asked of one engine
  assert.equal(inWorker, onPage);
  if (FONTS) assert.ok(Number(inWorker.split(',')[0]) > 0, 'it inked');
});
