// <Html scripts>' 2d canvas beyond its paths and shadows: `drawImage`
// composited as any fill is, under every operator, the clip and the shadow
// (`raster.ts`'s `image`); colours read as CSS reads one, `currentColor`
// and mixes among them; `roundRect`'s radii; strokes traced under the
// transform; and `ImageData`'s and the context's argument checks, as Web
// IDL has them. WPT's `html/canvas/element/` and `offscreen/` hold the rest.
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
async function inPage(code: string, markup = ''): Promise<unknown> {
  const page = await scriptedPage(
    `${markup}<script>console.log("out " + JSON.stringify((function () {
      var c = document.createElement('canvas'); c.width = 100; c.height = 50;
      var x = c.getContext('2d');
      var at = function (px, py) {
        return Array.from(x.getImageData(px, py, 1, 1).data);
      };
      var thrown = function (f) {
        try { f(); return 'none'; } catch (e) { return e.name; }
      };
      ${code}
    })()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('drawImage composites a canvas under the operator, as a fill does', async () => {
  const out = (await inPage(
    `var d = document.createElement('canvas'); d.width = 100; d.height = 50;
     var y = d.getContext('2d');
     y.fillStyle = 'rgba(255, 255, 0, 0.75)';
     y.fillRect(0, 0, 100, 50);
     var ops = ['source-in', 'destination-over', 'xor', 'copy'];
     return ops.map(function (op) {
       x.globalCompositeOperation = 'source-over';
       x.clearRect(0, 0, 100, 50);
       x.fillStyle = 'rgba(0, 255, 255, 0.5)';
       x.fillRect(0, 0, 100, 50);
       x.globalCompositeOperation = op;
       x.drawImage(d, 0, 0);
       return at(50, 25);
     });`,
  )) as number[][];
  // WPT's 2d.composite.canvas.*, within 5 of each channel
  const want = [
    [255, 255, 0, 96],
    [109, 255, 146, 223],
    [191, 255, 64, 128],
    [255, 255, 0, 191],
  ];
  out.forEach((got, i) =>
    got.forEach((v, k) =>
      assert.ok(Math.abs(v - want[i][k]) <= 5, `${i}: ${got} for ${want[i]}`),
    ),
  );
});

test("an operator that reaches past drawImage's rectangle clears what it leaves", async () => {
  const out = await inPage(
    `var d = document.createElement('canvas'); d.width = 10; d.height = 10;
     d.getContext('2d').fillRect(0, 0, 10, 10);
     x.fillStyle = '#0f0';
     x.fillRect(0, 0, 100, 50);
     x.globalCompositeOperation = 'source-in';
     x.drawImage(d, 0, 0);
     return [at(5, 5), at(50, 25)];`,
  );
  assert.deepEqual(out, [
    [0, 0, 0, 255],
    [0, 0, 0, 0],
  ]);
});

test('drawImage is clipped, casts a shadow, takes the transform and reads itself as it was', async () => {
  const out = await inPage(
    `var d = document.createElement('canvas'); d.width = 50; d.height = 50;
     var y = d.getContext('2d'); y.fillStyle = '#f00'; y.fillRect(0, 0, 50, 50);
     x.save();
     x.beginPath(); x.rect(0, 0, 25, 50); x.clip();
     x.drawImage(d, 0, 0);
     x.restore();
     var clipped = [at(10, 10), at(40, 10)];
     x.clearRect(0, 0, 100, 50);
     x.shadowColor = '#00f'; x.shadowOffsetX = 50;
     x.drawImage(d, -50, 0);
     var shadow = at(25, 25);
     x.shadowColor = 'transparent';
     x.clearRect(0, 0, 100, 50);
     x.setTransform(0.5, 0, 0, 0.5, 50, 0);
     x.drawImage(d, 0, 0);
     x.setTransform(1, 0, 0, 1, 0, 0);
     var scaled = [at(60, 10), at(80, 10)];
     // onto itself: the canvas as it was before the draw
     x.clearRect(0, 0, 100, 50);
     x.fillStyle = '#0f0'; x.fillRect(0, 1, 100, 49);
     x.fillStyle = '#f00'; x.fillRect(0, 0, 100, 1);
     x.drawImage(c, 0, 1);
     return [clipped, shadow, scaled, at(50, 49)];`,
  );
  assert.deepEqual(out, [
    [
      [255, 0, 0, 255],
      [0, 0, 0, 0],
    ],
    [0, 0, 255, 255],
    [
      [255, 0, 0, 255],
      [0, 0, 0, 0],
    ],
    [0, 255, 0, 255],
  ]);
});

test("drawImage's arguments are Web IDL's", async () => {
  const out = await inPage(
    `return [
       thrown(function () { x.drawImage(null, 0, 0); }),
       thrown(function () { x.drawImage(undefined, 0, 0); }),
       thrown(function () { x.drawImage(document.createElement('p'), 0, 0); }),
       thrown(function () { x.drawImage(c); }),
       thrown(function () { x.drawImage(c, 0, 0, 1); }),
       thrown(function () { x.drawImage(c, 0, 0, NaN, 1); }),
       thrown(function () { x.drawImage(new Image(), 0, 0); }),
     ];`,
  );
  assert.deepEqual(out, [
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'none',
    'none',
  ]);
});

test('a colour is read as CSS reads one, and read back as the canvas serializes it', async () => {
  const out = await inPage(
    `var out = [];
     var set = function (v) { x.fillStyle = '#123456'; x.fillStyle = v; out.push(x.fillStyle); };
     set('rgb(255, 0, 0 / 1)');
     set('hsl(0, 100%, 50% /)');
     set('rgba(255, 0, 0, 1.)');
     set('rgb(0, 255, 0');
     set('rgba(0, 255, 0, -2)');
     set('color-mix(in srgb, red, blue)');
     set('rgb(from red g r b)');
     set({ toString: function () { return '#008000'; } });
     c.style.color = 'magenta';
     document.body.appendChild(c);
     set('currentColor');
     set('rgb(from currentcolor g r b)');
     c.remove();
     set('currentColor');
     x.globalAlpha = 0.5; x.globalAlpha = 1.1; out.push(x.globalAlpha);
     return out;`,
  );
  assert.deepEqual(out, [
    '#123456',
    '#123456',
    '#123456',
    '#00ff00',
    'rgba(0, 255, 0, 0)',
    'color(srgb 0.5 0 0.5)',
    'color(srgb 0 1 0)',
    '#008000',
    '#ff00ff',
    'color(srgb 0 1 1)',
    '#000000',
    0.5,
  ]);
});

test("roundRect's radii are points or numbers, and a negative side winds it back", async () => {
  const out = await inPage(
    `x.fillStyle = '#f00'; x.fillRect(0, 0, 100, 50);
     x.roundRect(0, 0, 100, 50, [new DOMPoint(40, 20), 0, 0, 0]);
     x.fillStyle = '#0f0'; x.fill();
     // two radii of none on a side limit nothing
     var corner = [at(20, 1), at(41, 1), at(1, 10), at(1, 21), at(98, 48)];
     x.fillStyle = '#0f0'; x.fillRect(0, 0, 100, 50);
     x.beginPath(); x.fillStyle = '#f00';
     x.roundRect(0, 0, 50, 50, [0]);
     x.roundRect(100, 50, -50, -50, [0]);
     x.roundRect(0, 25, 100, -25, [0]);
     x.roundRect(100, 25, -100, 25, [0]);
     x.fill();
     var winding = [at(25, 12), at(75, 37)];
     return [corner, winding,
       thrown(function () { x.roundRect(0, 0, 10, 10, 0n); }),
       thrown(function () { x.roundRect(0, 0, 10, 10, [-1]); }),
       thrown(function () { x.roundRect(0, 0, 10, 10, [NaN, -1]); })];`,
  );
  assert.deepEqual(out, [
    [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 255, 0, 255],
    ],
    [
      [0, 255, 0, 255],
      [0, 255, 0, 255],
    ],
    'TypeError',
    'RangeError',
    'none',
  ]);
});

test('a stroke is traced under the transform, and a point of no length draws nothing', async () => {
  const out = await inPage(
    `x.fillStyle = '#f00'; x.fillRect(0, 0, 100, 50);
     x.beginPath(); x.rect(25, 12.5, 50, 25);
     x.save(); x.scale(50, 25); x.strokeStyle = '#0f0'; x.stroke(); x.restore();
     var scaled = [at(1, 1), at(50, 25), at(98, 48)];
     x.fillStyle = '#0f0'; x.fillRect(0, 0, 100, 50);
     x.strokeStyle = '#f00'; x.lineWidth = 100; x.lineCap = 'round';
     x.beginPath(); x.moveTo(50, 25); x.lineTo(50, 25); x.stroke();
     var pruned = at(50, 25);
     // a rectangle of no height goes there and back, a join at each end
     x.clearRect(0, 0, 100, 50);
     x.lineWidth = 250; x.lineCap = 'butt'; x.lineJoin = 'round';
     x.strokeStyle = '#0f0'; x.strokeRect(100, 25, 100, 0);
     return [scaled, pruned, at(50, 25)];`,
  );
  assert.deepEqual(out, [
    [
      [0, 255, 0, 255],
      [0, 255, 0, 255],
      [0, 255, 0, 255],
    ],
    [0, 255, 0, 255],
    [0, 255, 0, 255],
  ]);
});

test("ImageData and the context's pixel methods check their arguments", async () => {
  const out = await inPage(
    `var d = new ImageData(2, 3);
     d.width = 9;
     return [
       d.width, d.pixelFormat, d.colorSpace,
       thrown(function () { new ImageData(10); }),
       thrown(function () { new ImageData(0, 10); }),
       thrown(function () { new ImageData(new Uint8ClampedArray(0), 1); }),
       thrown(function () { new ImageData(new Uint8ClampedArray(3), 1); }),
       thrown(function () { new ImageData(new Uint8ClampedArray(4), 1, 2); }),
       thrown(function () { new ImageData(self, 4, 4); }),
       thrown(function () { new ImageData(4, 4, { pixelFormat: 'unorm8' }); }),
       thrown(function () { x.createImageData(null); }),
       thrown(function () { x.createImageData(Infinity, 10); }),
       thrown(function () { CanvasRenderingContext2D.prototype.createImageData.call({}, d); }),
       thrown(function () { x.getImageData(NaN, 0, 1, 1); }),
       thrown(function () { x.getImageData(10, 0xffffffff, 1, 1); }),
       thrown(function () { x.putImageData(d, Infinity, 0); }),
       thrown(function () { x.scale(1); }),
       thrown(function () { x.setTransform(1, 0); }),
       thrown(function () { x.isPointInPath(0, 0, 'gazonk'); }),
       thrown(function () { c.getContext(); }),
     ];`,
  );
  assert.deepEqual(out, [
    2,
    'rgba-unorm8',
    'srgb',
    'TypeError',
    'IndexSizeError',
    'InvalidStateError',
    'InvalidStateError',
    'IndexSizeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
  ]);
});

test('an arc from 0 to a whole turn anticlockwise is a circle, and a stop of no legacy colour mixes in Oklab', async () => {
  const out = await inPage(
    `x.fillStyle = '#f00';
     x.beginPath(); x.arc(50, 25, 20, 0, 2 * Math.PI, true); x.fill();
     var circle = [at(50, 25), at(50, 10), at(5, 5)];
     x.clearRect(0, 0, 100, 50);
     var g = x.createLinearGradient(0, 0, 100, 0);
     g.addColorStop(0, '#f00');
     g.addColorStop(1, 'color-mix(in srgb, #0f0, #00f)');
     x.fillStyle = g; x.fillRect(0, 0, 100, 50);
     var mixed = at(50, 25);
     x.fillStyle = '#f00'; x.fillStyle = 'ThreeDDarkShadow';
     return [circle, mixed, x.fillStyle !== '#ff0000' && x.fillStyle[0] === '#',
       thrown(function () { g.addColorStop(Infinity, '#000'); })];`,
  );
  const [circle, mixed, system, stop] = out as [
    number[][],
    number[],
    boolean,
    string,
  ];
  assert.deepEqual(circle, [
    [255, 0, 0, 255],
    [255, 0, 0, 255],
    [0, 0, 0, 0],
  ]);
  // Chrome's 167, 106, 88 at the middle, where sRGB would be 128, 64, 64
  [167, 106, 88, 255].forEach((v, k) =>
    assert.ok(Math.abs(mixed[k] - v) <= 3, `${mixed} for 167,106,88`),
  );
  assert.equal(system, true, 'a system colour is a colour');
  assert.equal(stop, 'TypeError');
});
