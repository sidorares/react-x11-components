// A WebGL context on an `OffscreenCanvas`, on the page's thread and in a
// worker (`src/html/scripts/webgl.ts`, `gl.ts`, `workers.ts`): a canvas no
// element shows has no element to read its frame into, so the realm reads it
// out (`glRead`) and hands it to the canvas, which routes it to its
// placeholder as a 2d one's pixels go. A worker's context runs on the page's
// GPU seam, asked across the thread. Read from the window's pixels, on a
// machine with a GPU, and skipped where there is none.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11, waitForPixel } from 'react-x11/test';
import { createElement as h } from 'react';

import { Html, gpuWebGL, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, PAGE } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const gpuModule = await gpuWebGL();
// the module loading says nothing: a CI machine has x11-dri and no GPU to
// make a context on
const probe = gpuModule?.open({
  version: 2,
  width: 1,
  height: 1,
  alpha: true,
  depth: false,
  stencil: false,
  antialias: false,
  premultipliedAlpha: true,
});
probe?.dispose();
const gpu = probe ? gpuModule : null;
const test = SCRIPTS_CONTAINED && FONTS && gpu ? nodeTest : nodeTest.skip;

const worker = (source: string): string =>
  `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(source)}], { type: "application/javascript" })))`;

/** A page of `body`, its WebGL on the GPU, and what it logs. */
async function glPage(body: string) {
  const logs: string[] = [];
  const result = await renderX11(
    h(Html, {
      source: `<!doctype html><html><head><style>body{margin:0}canvas{display:block;width:80px;height:40px}</style></head><body>${body}</body></html>`,
      partial: false,
      baseUrl: PAGE,
      scripts: {
        webgl: gpu!,
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
      },
    }),
    { width: 200, height: 120, fonts: FONTS! },
  );
  return {
    logs,
    result,
    async until(prefix: string, ms = 15000): Promise<string> {
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

const CLEAR = (gl: string, r: number, g: number, b: number) =>
  `${gl}.clearColor(${r}, ${g}, ${b}, 1); ${gl}.clear(${gl}.COLOR_BUFFER_BIT);`;

test('an OffscreenCanvas a canvas gave its control to draws its WebGL in that canvas’s box', async () => {
  const p = await glPage(
    '<canvas id="c" width="4" height="2"></canvas><script>' +
      'var oc = document.getElementById("c").transferControlToOffscreen();' +
      'var gl = oc.getContext("webgl2");' +
      CLEAR('gl', 1, 0, 0) +
      'console.log("drew|" + (gl.getError() === 0) + "|" + gl.drawingBufferWidth);' +
      '</script>',
  );
  assert.equal(await p.until('drew|'), 'true|4');
  await waitForPixel(p.result.ctx, 40, 20, '#ff0000', {
    message: 'the canvas, cleared red on the page’s thread',
  });
});

test('an OffscreenCanvas a worker draws WebGL on shows in the canvas it came from', async () => {
  const p = await glPage(
    '<canvas id="c" width="4" height="2"></canvas><script>' +
      'var oc = document.getElementById("c").transferControlToOffscreen();' +
      `var w = ${worker(
        'onmessage = function (e) { var oc = e.data.canvas; var gl = oc.getContext("webgl2");' +
          '  if (!gl) { postMessage("no context"); return; }' +
          `  ${CLEAR('gl', 0, 1, 0)}` +
          '  var px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);' +
          '  postMessage([gl.getError(), gl.drawingBufferWidth, gl.drawingBufferHeight, px.join("-")].join(",")); };',
      )};` +
      'w.onmessage = function (e) { console.log("worker|" + e.data); };' +
      'w.postMessage({ canvas: oc }, [oc]);' +
      '</script>',
  );
  assert.equal(await p.until('worker|'), '0,4,2,0-255-0-255');
  await waitForPixel(p.result.ctx, 40, 20, '#00ff00', {
    message: 'the canvas, cleared green in the worker',
  });
});

test('a texture is made of an OffscreenCanvas, as ALPHA, and of an ImageData with texSubImage2D, premultiplied where asked', async () => {
  // a glyph atlas is a canvas the text is drawn on, uploaded as its alpha
  // channel alone; the texture was none, and every glyph a page set in one
  // was never drawn
  const p = await glPage(
    '<canvas id="c" width="4" height="2"></canvas><script>' +
      'var oc = document.getElementById("c").transferControlToOffscreen();' +
      'var gl = oc.getContext("webgl2", { antialias: false });' +
      'var vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, "#version 300 es\\nvoid main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }"); gl.compileShader(vs);' +
      'var fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, "#version 300 es\\nprecision highp float; uniform sampler2D t; uniform int channel; out vec4 o; void main() { vec4 v = texture(t, vec2(0.5)); o = vec4(channel == 0 ? v.a : v.r, 0.0, 0.0, 1.0); }"); gl.compileShader(fs);' +
      'var pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr); gl.useProgram(pr);' +
      'var vao = gl.createVertexArray(); gl.bindVertexArray(vao);' +
      'function sample(channel) { gl.uniform1i(gl.getUniformLocation(pr, "t"), 0); gl.uniform1i(gl.getUniformLocation(pr, "channel"), channel);' +
      '  gl.viewport(0, 0, 4, 2); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);' +
      '  var px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return px[0]; }' +
      'function texture() { var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);' +
      '  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); return t; }' +
      // an OffscreenCanvas, white at half alpha, as ALPHA
      'var atlas = new OffscreenCanvas(2, 2); var x = atlas.getContext("2d"); x.fillStyle = "rgba(255, 255, 255, 0.5)"; x.fillRect(0, 0, 2, 2);' +
      'texture(); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, atlas);' +
      'var alpha = sample(0);' +
      // an ImageData into a texture's storage, straight and then premultiplied
      'var image = new ImageData(new Uint8ClampedArray([200, 100, 50, 128, 200, 100, 50, 128, 200, 100, 50, 128, 200, 100, 50, 128]), 2, 2);' +
      'texture(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);' +
      'gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);' +
      'var straight = sample(1);' +
      'gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);' +
      'texture(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);' +
      'gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);' +
      'var premultiplied = sample(1);' +
      'console.log("tex|" + gl.getError() + "," + alpha + "," + straight + "," + premultiplied);' +
      '</script>',
  );
  const [error, alpha, straight, premultiplied] = (await p.until('tex|'))
    .split(',')
    .map(Number);
  assert.equal(error, 0, 'no GL error');
  assert.ok(Math.abs(alpha - 128) <= 1, `the canvas's alpha, was ${alpha}`);
  assert.equal(straight, 200, 'a straight upload');
  assert.ok(
    Math.abs(premultiplied - 100) <= 1,
    `premultiplied, was ${premultiplied}`,
  );
});

test('transferToImageBitmap on a WebGL OffscreenCanvas hands over its drawing buffer, on the page’s thread and from a worker', async () => {
  // rida.dev's glass draws on a stage no element shows, and hands each frame
  // to the canvases it appears in as a bitmap: the bitmap was the 2d one's,
  // and empty
  const px =
    'function px(bitmap) { var c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d"); c.drawImage(bitmap, 0, 0);' +
    '  var d = c.getImageData(0, 0, 1, 1).data; return [bitmap.width, bitmap.height, d[0], d[1], d[2], d[3]].join("-"); }';
  const p = await glPage(
    '<script>' +
      px +
      'var gl = new OffscreenCanvas(4, 2).getContext("webgl2");' +
      CLEAR('gl', 0, 0, 1) +
      'console.log("main|" + px(gl.canvas.transferToImageBitmap()));' +
      `var w = ${worker(
        'var gl = new OffscreenCanvas(6, 3).getContext("webgl2");' +
          `${CLEAR('gl', 1, 0, 0)}` +
          'var bitmap = gl.canvas.transferToImageBitmap(); postMessage(bitmap, [bitmap]);',
      )};` +
      'w.onmessage = function (e) { console.log("from|" + px(e.data)); };' +
      '</script>',
  );
  assert.equal(await p.until('main|'), '4-2-0-0-255-255');
  assert.equal(await p.until('from|'), '6-3-255-0-0-255');
});

test('an OffscreenCanvas sized after its WebGL context was made draws and reads back at the new size', async () => {
  // rida.dev's glass makes its stage at the default 300 by 150 and sizes it
  // after: its drawing buffer stayed 300 wide, and a pill at 2x (476) came out
  // cut at column 300
  const p = await glPage(
    '<script>' +
      'var oc = new OffscreenCanvas(300, 150); var gl = oc.getContext("webgl2");' +
      'oc.width = 476; oc.height = 104;' +
      CLEAR('gl', 0, 1, 0) +
      'var bitmap = oc.transferToImageBitmap();' +
      'var c = new OffscreenCanvas(476, 104).getContext("2d"); c.drawImage(bitmap, 0, 0);' +
      'var d = c.getImageData(475, 103, 1, 1).data;' +
      'console.log("size|" + gl.drawingBufferWidth + "," + gl.drawingBufferHeight + "," + bitmap.width + "," + bitmap.height + "," + [d[0], d[1], d[2], d[3]].join("-"));' +
      '</script>',
  );
  assert.equal(await p.until('size|'), '476,104,476,104,0-255-0-255');
});

test('a stage’s frame is moved to the canvas that shows it as the frame and not its pixels, from the page’s thread and from a worker', async () => {
  // rida.dev's glass draws on a stage no element shows and hands each frame
  // to a canvas that is the placeholder of an OffscreenCanvas: at 2x a frame
  // is 13 MB, and sent as text through a worker and back it was ten passes
  // over every byte
  const stage = (colour: string, size: string) =>
    `var stage = new OffscreenCanvas(${size}); var gl = stage.getContext("webgl2");` +
    CLEAR(
      'gl',
      ...((colour === 'blue' ? [0, 0, 1] : [1, 0, 0]) as [
        number,
        number,
        number,
      ]),
    ) +
    'var bitmap = stage.transferToImageBitmap();';
  const p = await glPage(
    '<canvas id="a" width="4" height="2"></canvas>' +
      '<canvas id="b" width="4" height="2"></canvas><script>' +
      'var shown = document.getElementById("a").transferControlToOffscreen();' +
      stage('blue', '4, 2') +
      'shown.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);' +
      'console.log("page|" + bitmap.width + "," + bitmap.height);' +
      'var other = document.getElementById("b").transferControlToOffscreen();' +
      `var w = ${worker(
        'onmessage = function (e) { var oc = e.data.canvas;' +
          '  var stage = new OffscreenCanvas(4, 2); var gl = stage.getContext("webgl2");' +
          `  ${CLEAR('gl', 1, 0, 0)}` +
          '  var bitmap = stage.transferToImageBitmap();' +
          '  oc.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);' +
          '  postMessage(bitmap.width + "," + bitmap.height); };',
      )};` +
      'w.onmessage = function (e) { console.log("worker|" + e.data); };' +
      'w.postMessage({ canvas: other }, [other]);' +
      '</script>',
  );
  // a bitmap moved to a canvas is detached
  assert.equal(await p.until('page|'), '0,0');
  assert.equal(await p.until('worker|'), '0,0');
  await waitForPixel(p.result.ctx, 40, 20, '#0000ff', {
    message: 'the first canvas, a frame drawn on the page’s thread',
  });
  await waitForPixel(p.result.ctx, 40, 60, '#ff0000', {
    message: 'the second, a frame a worker drew',
  });
});

test('a fence a worker makes on its WebGL context is signaled by the GPU, and polled for', async () => {
  const p = await glPage(
    '<script>' +
      `var w = ${worker(
        'var gl = new OffscreenCanvas(32, 32).getContext("webgl2");' +
          'gl.clearColor(0, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);' +
          'var sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();' +
          'var polls = 0; var first = gl.getSyncParameter(sync, gl.SYNC_STATUS);' +
          'while (gl.getSyncParameter(sync, gl.SYNC_STATUS) !== gl.SIGNALED && polls < 20000) polls += 1;' +
          'var waited = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 1000000000);' +
          'var type = gl.getSyncParameter(sync, gl.OBJECT_TYPE) === gl.SYNC_FENCE; gl.deleteSync(sync);' +
          'postMessage([type, polls < 20000, waited === gl.ALREADY_SIGNALED || waited === gl.CONDITION_SATISFIED, gl.isSync(sync)].join(","));',
      )};` +
      'w.onmessage = function (e) { console.log("fence|" + e.data); };' +
      '</script>',
  );
  assert.equal(await p.until('fence|'), 'true,true,true,false');
});
