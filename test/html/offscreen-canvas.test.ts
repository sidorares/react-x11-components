// `<Html scripts>`' `OffscreenCanvas` (HTML 4.12.5.3), `ImageBitmap` and
// `createImageBitmap` (HTML 8.11), in `src/html/scripts/dom.ts`: a bitmap
// with no element, drawn on through the 2d context's own code, handed to a
// worker, and shown in the `<canvas>` that gave its control to it; and a
// bitmap as a PNG (`src/html/scripts/png.ts`), which the test reads back
// with pngjs.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { PNG } from 'pngjs';
import { act, cleanup, renderX11, waitForPixel } from 'react-x11/test';

import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { encodePng } from '../../src/html/scripts/png.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/page.html';

/** A page whose scripts run: what it logs, a wait for a log line that
 *  starts with a prefix, and the window it is drawn in. */
async function page(
  body: string,
  ms = 5000,
): Promise<{
  logs: string[];
  until(prefix: string): Promise<string>;
  result: Awaited<ReturnType<typeof renderX11>>;
}> {
  const logs: string[] = [];
  const result = await renderX11(
    h(Html, {
      source: `<!doctype html><html><head><style>body{margin:0}</style></head><body>${body}</body></html>`,
      partial: false,
      baseUrl: PAGE,
      scripts: {
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
      },
    }),
    FONTS ? { width: 200, height: 120, fonts: FONTS } : { backend: 'mock' },
  );
  return {
    logs,
    result,
    async until(prefix) {
      const end = Date.now() + ms;
      const found = () => logs.find((l) => l.startsWith(`log: ${prefix}`));
      while (!found() && Date.now() < end) {
        await act(() => new Promise((r) => setTimeout(r, 10)));
      }
      const line = found();
      assert.ok(line, `no "${prefix}" in:\n${logs.join('\n')}`);
      return line.slice(`log: ${prefix}`.length).trim();
    },
  };
}

const LOG =
  'function log() { console.log([].slice.call(arguments).join("|")); }' +
  'function err(f) { try { f(); return "none"; } catch (e) { return e.name + (e instanceof DOMException ? "" : "!"); } }' +
  'function px(x, a, b) { var d = x.getImageData(a, b, 1, 1).data; return [d[0], d[1], d[2], d[3]].join(","); }';

/** A worker started from source, as a page bundles one. */
const worker = (source: string): string =>
  `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(source)}], { type: "application/javascript" })))`;

test('an OffscreenCanvas draws through a 2d context of its own, which is no canvas element’s', async () => {
  const p = await page(
    '<script>' +
      LOG +
      'var oc = new OffscreenCanvas(20, 10); var x = oc.getContext("2d");' +
      'log("idl", Object.prototype.toString.call(oc), oc instanceof EventTarget, oc.width, oc.height,' +
      '  x === oc.getContext("2d"), x.canvas === oc, Object.prototype.toString.call(x),' +
      '  x instanceof OffscreenCanvasRenderingContext2D, x instanceof CanvasRenderingContext2D,' +
      '  typeof x.fillRect, typeof x.drawFocusIfNeeded, "drawFocusIfNeeded" in CanvasRenderingContext2D.prototype,' +
      '  oc.getContext("webgl"), oc.getContext("bitmaprenderer"), oc.oncontextlost);' +
      'x.fillStyle = "#ff0000"; x.fillRect(0, 0, 10, 10); x.beginPath(); x.arc(15, 5, 4, 0, 7); x.fillStyle = "#0000ff"; x.fill();' +
      'log("drawn", px(x, 5, 5), px(x, 15, 5), px(x, 19, 0));' +
      // a side set is a new bitmap and the context's state as it starts,
      // even set to what it was
      'oc.width = 20; log("resized", px(x, 5, 5), x.fillStyle, oc.width);' +
      'oc.height = 4; log("smaller", oc.height, x.getImageData(0, 0, 20, 4).data.length);' +
      // what is not a kind of context, and what is not a size
      'log("errors", err(function () { oc.getContext("2D"); }), err(function () { oc.getContext("experimental-webgl"); }),' +
      '  err(function () { oc.getContext(); }), new OffscreenCanvas(1, 1).getContext("webgpu"),' +
      '  err(function () { new OffscreenCanvas(1); }), err(function () { new OffscreenCanvas(-1, 1); }),' +
      '  err(function () { new OffscreenCanvas(NaN, 1); }), err(function () { oc.width = Infinity; }),' +
      '  new OffscreenCanvas(2.9, "3").width, err(function () { new OffscreenCanvasRenderingContext2D(); }),' +
      '  err(function () { new ImageBitmap(); }));' +
      // WebGL on one, whose drawing buffer is its size
      'var gl = new OffscreenCanvas(30, 16).getContext("webgl2");' +
      'log("gl", gl.canvas instanceof OffscreenCanvas, gl.drawingBufferWidth, gl.drawingBufferHeight);' +
      // and a canvas element's width set to what it was clears it
      'var c = document.createElement("canvas"); c.width = 4; c.height = 4; var cx = c.getContext("2d");' +
      'cx.fillRect(0, 0, 4, 4); var was = px(cx, 1, 1); c.width = c.width; log("cleared", was, px(cx, 1, 1));' +
      '</script>',
  );
  assert.equal(
    await p.until('idl|'),
    '[object OffscreenCanvas]|true|20|10|true|true|[object OffscreenCanvasRenderingContext2D]|true|false|function|undefined|true|||',
  );
  assert.equal(await p.until('drawn|'), '255,0,0,255|0,0,255,255|0,0,0,0');
  assert.equal(await p.until('resized|'), '0,0,0,0|#000000|20');
  assert.equal(await p.until('smaller|'), '4|320');
  assert.equal(
    await p.until('errors|'),
    'TypeError!|TypeError!|TypeError!||TypeError!|TypeError!|TypeError!|TypeError!|2|TypeError!|TypeError!',
  );
  assert.equal(await p.until('gl|'), 'true|30|16');
  assert.equal(await p.until('cleared|'), '0,0,0,255|0,0,0,0');
});

test('transferToImageBitmap hands over the bitmap and leaves a clear one, and a bitmap is drawn, shown, cloned and closed', async () => {
  const p = await page(
    '<script>' +
      LOG +
      'var oc = new OffscreenCanvas(4, 2);' +
      'log("nocontext", err(function () { oc.transferToImageBitmap(); }));' +
      'var x = oc.getContext("2d"); x.fillStyle = "#00ff00"; x.fillRect(0, 0, 2, 2);' +
      'var bm = oc.transferToImageBitmap();' +
      // the canvas is clear, and its context keeps its state
      'log("taken", Object.prototype.toString.call(bm), bm.width, bm.height, px(x, 0, 0), x.fillStyle);' +
      // drawn on another canvas, scaled
      'var c = document.createElement("canvas"); c.width = 8; c.height = 4; var cx = c.getContext("2d");' +
      'cx.drawImage(bm, 0, 0, 8, 4); log("drawn", px(cx, 1, 1), px(cx, 3, 3), px(cx, 4, 1), bm.width);' +
      // serializable: a clone is a copy, and a transfer gives it up
      'var copy = structuredClone(bm); log("cloned", copy !== bm, copy.width, bm.width);' +
      'var moved = structuredClone(bm, { transfer: [bm] }); log("moved", moved.width, bm.width, bm.height,' +
      '  err(function () { cx.drawImage(bm, 0, 0); }), err(function () { structuredClone(bm); }),' +
      '  err(function () { structuredClone(1, { transfer: [bm] }); }));' +
      // shown by a bitmaprenderer context, which takes it
      'var shown = document.createElement("canvas"); var r = shown.getContext("bitmaprenderer");' +
      'r.transferFromImageBitmap(moved); log("shown", Object.prototype.toString.call(r), r.canvas === shown, moved.width,' +
      '  err(function () { r.transferFromImageBitmap(moved); }), err(function () { r.transferFromImageBitmap({}); }));' +
      // and what it shows is drawn as the canvas's pixels, at the bitmap's size
      'var back = document.createElement("canvas"); back.width = 4; back.height = 2; var bx = back.getContext("2d");' +
      'bx.drawImage(shown, 0, 0); log("readback", px(bx, 1, 1), px(bx, 3, 1));' +
      'r.transferFromImageBitmap(null); bx.clearRect(0, 0, 4, 2); bx.drawImage(shown, 0, 0, 4, 2); log("blank", px(bx, 1, 1));' +
      'copy.close(); log("closed", copy.width, copy.height, err(function () { cx.drawImage(copy, 0, 0); }));' +
      'log("zero", err(function () { cx.drawImage(new OffscreenCanvas(0, 3), 0, 0); }));' +
      '</script>',
  );
  assert.equal(await p.until('nocontext|'), 'InvalidStateError');
  assert.equal(
    await p.until('taken|'),
    '[object ImageBitmap]|4|2|0,0,0,0|#00ff00',
  );
  assert.equal(await p.until('drawn|'), '0,255,0,255|0,255,0,255|0,0,0,0|4');
  assert.equal(await p.until('cloned|'), 'true|4|4');
  assert.equal(
    await p.until('moved|'),
    '4|0|0|InvalidStateError|DataCloneError|DataCloneError',
  );
  assert.equal(
    await p.until('shown|'),
    '[object ImageBitmapRenderingContext]|true|0|InvalidStateError|TypeError!',
  );
  assert.equal(await p.until('readback|'), '0,255,0,255|0,0,0,0');
  assert.equal(await p.until('blank|'), '0,0,0,0');
  assert.equal(await p.until('closed|'), '0|0|InvalidStateError');
  assert.equal(await p.until('zero|'), 'InvalidStateError');
});

test('a bitmap is a PNG: convertToBlob, toBlob and toDataURL, which a decoder reads back pixel for pixel', async () => {
  const p = await page(
    '<canvas id="c" width="3" height="2"></canvas><script>' +
      LOG +
      'function hex(bytes) { return [].map.call(bytes.slice(0, 8), function (b) { return b.toString(16); }).join(" "); }' +
      'function b64(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }' +
      'var oc = new OffscreenCanvas(3, 2); var x = oc.getContext("2d");' +
      'x.fillStyle = "#ff0000"; x.fillRect(0, 0, 1, 2); x.fillStyle = "rgba(0, 0, 255, 0.5)"; x.fillRect(1, 0, 1, 2);' +
      'oc.convertToBlob({ type: "image/jpeg", quality: 0.5 }).then(function (blob) {' +
      '  return blob.arrayBuffer().then(function (buf) { var bytes = new Uint8Array(buf);' +
      '    log("blob", blob instanceof Blob, blob.type, hex(bytes)); log("png", b64(bytes)); }); });' +
      'new OffscreenCanvas(0, 4).convertToBlob().catch(function (e) { log("empty", e.name); });' +
      'var c = document.getElementById("c"); var cx = c.getContext("2d"); cx.fillStyle = "#00ff00"; cx.fillRect(1, 1, 1, 1);' +
      'var url = c.toDataURL(); log("dataurl", url.slice(0, 22)); log("dataurlpng", url.slice(22));' +
      'log("empty url", document.createElement("canvas").getContext("2d") && (function () { var e = document.createElement("canvas"); e.width = 0; return e.toDataURL(); })());' +
      'c.toBlob(function (blob) { log("toblob", blob.type, blob.size > 8); });' +
      'log("toblob args", err(function () { c.toBlob(); }));' +
      // a PNG's pixels decoded again, through the host's decoders
      'oc.convertToBlob().then(createImageBitmap).then(function (bm) {' +
      '  var y = new OffscreenCanvas(3, 2).getContext("2d"); y.drawImage(bm, 0, 0);' +
      '  log("decoded", bm.width, bm.height, px(y, 0, 1), px(y, 1, 0), px(y, 2, 0)); });' +
      '</script>',
  );
  assert.equal(await p.until('blob|'), 'true|image/png|89 50 4e 47 d a 1a a');
  const decode = (b64: string) => PNG.sync.read(Buffer.from(b64, 'base64'));
  const png = decode(await p.until('png|'));
  assert.equal(png.width, 3);
  assert.equal(png.height, 2);
  // straight RGBA, as the canvas holds it
  assert.deepEqual(
    [...png.data.subarray(0, 12)],
    [255, 0, 0, 255, 0, 0, 255, 128, 0, 0, 0, 0],
  );
  assert.equal(await p.until('empty|'), 'IndexSizeError');
  assert.equal(await p.until('dataurl|'), 'data:image/png;base64,');
  const fromUrl = decode(await p.until('dataurlpng|'));
  assert.deepEqual(
    [...fromUrl.data.subarray((1 * 3 + 1) * 4, (1 * 3 + 2) * 4)],
    [0, 255, 0, 255],
  );
  assert.equal(await p.until('empty url|'), 'data:,');
  assert.equal(await p.until('toblob|'), 'image/png|true');
  assert.equal(await p.until('toblob args|'), 'TypeError!');
  assert.equal(
    await p.until('decoded|'),
    '3|2|255,0,0,255|0,0,255,128|0,0,0,0',
  );
});

test('createImageBitmap cuts, resizes and flips what it is given, and refuses what has nothing to give', async () => {
  const p = await page(
    '<img id="img" width="5" height="3"><script>' +
      LOG +
      // a source: a red left column, a blue right one, a green bottom row
      'var src = new OffscreenCanvas(4, 4); var s = src.getContext("2d");' +
      's.fillStyle = "#ff0000"; s.fillRect(0, 0, 2, 4); s.fillStyle = "#0000ff"; s.fillRect(2, 0, 2, 4);' +
      's.fillStyle = "#00ff00"; s.fillRect(0, 3, 4, 1);' +
      'function read(bm) { var c = new OffscreenCanvas(bm.width, bm.height).getContext("2d"); c.drawImage(bm, 0, 0); return c; }' +
      'Promise.all([' +
      '  createImageBitmap(src),' +
      '  createImageBitmap(src, 2, 0, 2, 2),' +
      '  createImageBitmap(src, 4, 0, -2, 2),' + // a negative width reaches left
      '  createImageBitmap(src, 3, 3, 2, 2),' + // past the source is transparent
      '  createImageBitmap(src, { resizeWidth: 8, resizeQuality: "pixelated" }),' +
      '  createImageBitmap(src, { imageOrientation: "flipY" }),' +
      '  createImageBitmap(s.getImageData(0, 2, 4, 2)),' +
      '  createImageBitmap(src, { resizeWidth: 2, resizeHeight: 2, resizeQuality: "high" }),' +
      '  createImageBitmap(document.getElementById("img")),' +
      ']).then(function (b) {' +
      '  log("whole", Object.prototype.toString.call(b[0]), b[0].width, b[0].height, px(read(b[0]), 0, 0), px(read(b[0]), 3, 3));' +
      '  log("cut", b[1].width, b[1].height, px(read(b[1]), 0, 0));' +
      '  log("negative", b[2].width, px(read(b[2]), 0, 0), px(read(b[2]), 1, 1));' +
      '  log("past", px(read(b[3]), 0, 0), px(read(b[3]), 1, 1));' +
      '  log("resized", b[4].width, b[4].height, px(read(b[4]), 3, 0), px(read(b[4]), 4, 0));' +
      '  log("flipped", px(read(b[5]), 0, 0), px(read(b[5]), 0, 3));' +
      '  log("imagedata", b[6].width, b[6].height, px(read(b[6]), 0, 1));' +
      '  var hi = read(b[7]); log("smooth", b[7].width, hi.getImageData(0, 0, 1, 1).data[3]);' +
      '  var img = document.getElementById("img");' +
      '  log("image", b[8].width === img.naturalWidth, b[8].height === img.naturalHeight, b[8].width > 0, px(read(b[8]), 0, 0));' +
      '});' +
      'function why(p) { return p.then(function () { return "none"; }, function (e) { return e.name + (e instanceof DOMException ? "" : "!"); }); }' +
      'var gone = src.transferToImageBitmap(); gone.close();' +
      'Promise.all([' +
      '  why(createImageBitmap(src, 0, 0, 0, 2)),' +
      '  why(createImageBitmap(src, { resizeHeight: 0 })),' +
      '  why(createImageBitmap({})),' +
      '  why(createImageBitmap(src, 0, 0)),' +
      '  why(createImageBitmap()),' +
      '  why(createImageBitmap(gone)),' +
      '  why(createImageBitmap(new OffscreenCanvas(0, 2))),' +
      '  why(createImageBitmap(new Blob(["not an image"]))),' +
      '  why(createImageBitmap(new Blob([]))),' +
      '  why(createImageBitmap(src, { imageOrientation: "sideways" })),' +
      ']).then(function (r) { log("refused", r.join(",")); });' +
      '</script>',
  );
  assert.equal(
    await p.until('whole|'),
    '[object ImageBitmap]|4|4|255,0,0,255|0,255,0,255',
  );
  assert.equal(await p.until('cut|'), '2|2|0,0,255,255');
  assert.equal(await p.until('negative|'), '2|0,0,255,255|0,0,255,255');
  assert.equal(await p.until('past|'), '0,255,0,255|0,0,0,0');
  assert.equal(await p.until('resized|'), '8|8|255,0,0,255|0,0,255,255');
  assert.equal(await p.until('flipped|'), '0,255,0,255|255,0,0,255');
  assert.equal(await p.until('imagedata|'), '4|2|0,255,0,255');
  assert.equal(await p.until('smooth|'), '2|255');
  // an image's pixels are the host's, which a 2d context draws as nothing:
  // its bitmap is transparent, at its size
  assert.equal(await p.until('image|'), 'true|true|true|0,0,0,0');
  assert.equal(
    await p.until('refused|'),
    'RangeError!,InvalidStateError,TypeError!,TypeError!,TypeError!,InvalidStateError,InvalidStateError,InvalidStateError,InvalidStateError,TypeError!',
  );
});

test('a transfer moves an OffscreenCanvas and leaves the one it moved detached; one with a context does not move', async () => {
  const p = await page(
    '<script>' +
      LOG +
      'var oc = new OffscreenCanvas(6, 3);' +
      'var moved = structuredClone({ c: oc }, { transfer: [oc] }).c;' +
      'log("moved", moved instanceof OffscreenCanvas, moved !== oc, moved.width, moved.height, oc.width, oc.height,' +
      '  err(function () { oc.getContext("2d"); }), err(function () { oc.width = 3; }),' +
      '  err(function () { oc.transferToImageBitmap(); }));' +
      'oc.convertToBlob().catch(function (e) { log("detached blob", e.name); });' +
      'log("again", err(function () { structuredClone(oc, { transfer: [oc] }); }),' +
      '  err(function () { structuredClone(moved); }),' +
      '  err(function () { structuredClone(moved, { transfer: [moved, moved] }); }));' +
      'moved.getContext("2d");' +
      'log("context", err(function () { structuredClone(moved, { transfer: [moved] }); }), moved.width);' +
      // a message channel's transfer moves one too
      'var mc = new MessageChannel(); var other = new OffscreenCanvas(2, 2);' +
      'mc.port2.onmessage = function (e) { log("port", e.data instanceof OffscreenCanvas, e.data.width, other.width, e.ports.length); };' +
      'mc.port1.postMessage(other, [other]);' +
      '</script>',
  );
  assert.equal(
    await p.until('moved|'),
    'true|true|6|3|0|0|InvalidStateError|InvalidStateError|InvalidStateError',
  );
  assert.equal(await p.until('detached blob|'), 'InvalidStateError');
  assert.equal(
    await p.until('again|'),
    'DataCloneError|DataCloneError|DataCloneError',
  );
  assert.equal(await p.until('context|'), 'InvalidStateError|6');
  assert.equal(await p.until('port|'), 'true|2|0|0');
});

test('a canvas that hands its control to an OffscreenCanvas refuses its own context and size, and shows what the OffscreenCanvas draws', async () => {
  const p = await page(
    '<style>canvas{display:block;width:80px;height:40px}</style>' +
      '<canvas id="c" width="4" height="2"></canvas><script>' +
      LOG +
      'var c = document.getElementById("c"); var oc = c.transferControlToOffscreen();' +
      'log("placeholder", oc instanceof OffscreenCanvas, oc.width, oc.height,' +
      '  err(function () { c.getContext("2d"); }), err(function () { c.width = 8; }),' +
      '  err(function () { c.toDataURL(); }), err(function () { c.transferControlToOffscreen(); }), c.width);' +
      'var used = document.createElement("canvas"); used.getContext("2d");' +
      'log("used", err(function () { used.transferControlToOffscreen(); }));' +
      'var x = oc.getContext("2d"); x.fillStyle = "#ff0000"; x.fillRect(0, 0, 2, 2); x.fillStyle = "#0000ff"; x.fillRect(2, 0, 2, 2);' +
      'log("drawn", px(x, 0, 0));' +
      '</script>',
  );
  assert.equal(
    await p.until('placeholder|'),
    'true|4|2|InvalidStateError|InvalidStateError|InvalidStateError|InvalidStateError|4',
  );
  assert.equal(await p.until('used|'), 'InvalidStateError');
  assert.equal(await p.until('drawn|'), '255,0,0,255');
  if (!FONTS) return;
  // the bitmap stretched over the placeholder's box
  await waitForPixel(p.result.ctx, 20, 20, '#ff0000', {
    message: 'the left half, drawn on the OffscreenCanvas',
  });
  await waitForPixel(p.result.ctx, 60, 20, '#0000ff', {
    message: 'the right half',
  });
});

test('a worker has OffscreenCanvas, createImageBitmap and animation frames, and no canvas element’s context', async () => {
  const p = await page(
    '<script>' +
      LOG +
      `var w = ${worker(
        'var oc = new OffscreenCanvas(2, 2); var x = oc.getContext("2d"); x.fillStyle = "#ff00ff"; x.fillRect(0, 0, 2, 2);' +
          'var bm = oc.transferToImageBitmap();' +
          'requestAnimationFrame(function (t) {' +
          '  postMessage({ kinds: [typeof OffscreenCanvas, typeof OffscreenCanvasRenderingContext2D, typeof ImageBitmap,' +
          '    typeof createImageBitmap, typeof ImageBitmapRenderingContext, typeof CanvasRenderingContext2D,' +
          '    typeof HTMLCanvasElement, typeof t, typeof cancelAnimationFrame].join(","), bm: bm }, [bm]);' +
          '  postMessage({ after: bm.width });' +
          '});',
      )};` +
      'w.onmessage = function (e) {' +
      '  if ("after" in e.data) { log("after", e.data.after); return; }' +
      '  var c = new OffscreenCanvas(2, 2).getContext("2d"); c.drawImage(e.data.bm, 0, 0);' +
      '  log("worker", e.data.kinds, e.data.bm.width, px(c, 1, 1)); };' +
      '</script>',
    15000,
  );
  assert.equal(
    await p.until('worker|'),
    'function,function,function,function,function,undefined,undefined,number,function|2|255,0,255,255',
  );
  assert.equal(await p.until('after|'), '0');
});

test('an OffscreenCanvas a canvas gave its control to draws in that canvas’s box from a worker', async () => {
  const p = await page(
    '<style>canvas{display:block;width:80px;height:40px}</style>' +
      '<canvas id="c" width="4" height="2"></canvas><script>' +
      LOG +
      'var c = document.getElementById("c"); var oc = c.transferControlToOffscreen();' +
      `var w = ${worker(
        'onmessage = function (e) { var oc = e.data.canvas; var x = oc.getContext("2d");' +
          '  requestAnimationFrame(function () {' +
          '    x.fillStyle = "#00ff00"; x.fillRect(0, 0, 4, 2); x.fillStyle = "#0000ff"; x.fillRect(2, 0, 2, 2);' +
          '    var d = x.getImageData(0, 0, 1, 1).data;' +
          '    postMessage([oc.width, oc.height, d[1]].join(","));' +
          '  }); };',
      )};` +
      'w.onmessage = function (e) { log("worker", e.data, oc.width, err(function () { oc.getContext("2d"); })); };' +
      'w.postMessage({ canvas: oc }, [oc]);' +
      '</script>',
    15000,
  );
  assert.equal(await p.until('worker|'), '4,2,255|0|InvalidStateError');
  if (!FONTS) return;
  await waitForPixel(p.result.ctx, 20, 20, '#00ff00', {
    message: 'the left half, drawn in the worker',
  });
  await waitForPixel(p.result.ctx, 60, 20, '#0000ff', {
    message: 'the right half',
  });
});

nodeTest(
  'encodePng writes what a decoder reads back, through every filter',
  () => {
    // a gradient across and down, and a flat run, so each row takes its own
    // filter
    const width = 17;
    const height = 9;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        rgba[o] = x * 15;
        rgba[o + 1] = y < 4 ? 200 : y * 28;
        rgba[o + 2] = (x * y) & 255;
        rgba[o + 3] = x === 0 ? 0 : 255 - y;
      }
    }
    const png = PNG.sync.read(Buffer.from(encodePng(width, height, rgba)));
    assert.equal(png.width, width);
    assert.equal(png.height, height);
    assert.deepEqual([...png.data], [...rgba]);
  },
);
