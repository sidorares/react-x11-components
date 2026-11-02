// <Html scripts>' canvas text (HTML 4.12.5.1.8): set by the host's text engine
// (`src/html/canvas-text.ts`), and painted by the page's realm as any shape
// is, so a transform, a clip, an alpha and a compositing operator all reach
// it. What is drawn is read back from the bitmap and held to where a
// `<span>` in the same font says the text is, rather than to another of the
// context's own answers, which would pass however wrong the two were.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

// real faces, and a worker of the page's: neither is on every runner
const test = SCRIPTS_CONTAINED && FONTS ? nodeTest : nodeTest.skip;

const LOG =
  'function log() { console.log([].slice.call(arguments).join("|")); }' +
  'var c = document.createElement("canvas"); c.width = 300; c.height = 200;' +
  'var x = c.getContext("2d");' +
  // what anything was drawn on, as left, top, right and bottom
  'function ink(of) {' +
  '  var t = of || x, w = t.canvas.width, h = t.canvas.height;' +
  '  var d = t.getImageData(0, 0, w, h).data, l = w, r = 0, u = h, b = 0;' +
  '  for (var q = 0; q < h; q += 1) for (var p = 0; p < w; p += 1) {' +
  '    if (d[(q * w + p) * 4 + 3] < 128) continue;' +
  '    if (p < l) l = p; if (p >= r) r = p + 1; if (q < u) u = q; b = q + 1;' +
  '  }' +
  '  return r > l ? [l, u, r, b] : null;' +
  '}' +
  'function wipe() { x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, 300, 200); }';

const near = (a: number, b: number, by: number, what: string): void => {
  assert.ok(Math.abs(a - b) <= by, `${what}: ${a}, within ${by} of ${b}`);
};

test('fillText draws at its anchor, as far as a span in the font says', async () => {
  const p = await scriptedPage(
    '<span id="s" style="font:40px sans-serif">HHH</span><script>' +
      LOG +
      'var span = document.getElementById("s").getBoundingClientRect().width;' +
      'x.font = "40px sans-serif"; x.fillText("HHH", 20, 100);' +
      'var a = ink(); wipe();' +
      'x.textAlign = "right"; x.fillText("HHH", 200, 100);' +
      'var b = ink(); wipe();' +
      'x.textAlign = "center"; x.fillText("HHH", 150, 100);' +
      'var d = ink(); wipe(); x.textAlign = "start";' +
      'x.textBaseline = "top"; x.fillText("HHH", 20, 100);' +
      'var e = ink(); wipe(); x.textBaseline = "alphabetic";' +
      'log("drawn", JSON.stringify([span, a, b, d, e]));' +
      '</script>',
  );
  const [span, a, right, centre, top] = JSON.parse(await p.until('drawn|'));
  // three stems of an H inside the advance of each, and none past it
  assert.ok(a[0] >= 20 && a[0] < 28, `starts at its x: ${a}`);
  near(a[2] - 20, span, 6, 'runs as far as the span');
  assert.strictEqual(a[3], 100, 'stands on its baseline');
  assert.ok(a[1] > 60 && a[1] < 80, `an H's height above it: ${a}`);
  near(right[2], 200, 6, 'ends at a right anchor');
  near((centre[0] + centre[2]) / 2, 150, 3, 'centres on a centre anchor');
  assert.ok(top[1] > 100, `hangs under a top anchor: ${top}`);
});

test('text goes through the transform, and a clip, an alpha and an operator reach it', async () => {
  const p = await scriptedPage(
    '<script>' +
      LOG +
      'x.font = "20px sans-serif";' +
      'x.fillText("HHHH", 0, 40); var one = ink(); wipe();' +
      'x.scale(2, 3); x.fillText("HHHH", 0, 40); var scaled = ink(); wipe();' +
      // a quarter turn about the origin puts its height across
      'x.translate(150, 20); x.rotate(Math.PI / 2);' +
      'x.fillText("HHHH", 0, 0); var turned = ink(); wipe();' +
      // read from a fraction of a pixel, which sharp text cannot hide
      'x.fillStyle = "#ff0000"; x.font = "100px sans-serif";' +
      'x.globalAlpha = 0.5; x.fillText("H", 10, 120);' +
      'var d = x.getImageData(0, 0, 300, 200).data, most = 0, red = 0;' +
      'for (var i = 3; i < d.length; i += 4) if (d[i] > most) { most = d[i]; red = d[i - 3]; }' +
      'log("alpha", most, red); wipe(); x.globalAlpha = 1;' +
      'x.save(); x.beginPath(); x.rect(0, 0, 40, 200); x.clip();' +
      'x.fillText("H", 10, 120); var clipped = ink(); x.restore(); wipe();' +
      'x.fillRect(0, 0, 300, 200); x.globalCompositeOperation = "destination-out";' +
      'x.fillStyle = "#000"; x.fillText("H", 10, 120);' +
      'x.globalCompositeOperation = "source-over";' +
      'var stem = x.getImageData(24, 80, 1, 1).data[3], off = x.getImageData(200, 80, 1, 1).data[3];' +
      'wipe(); var g = x.createLinearGradient(0, 0, 0, 200);' +
      'g.addColorStop(0, "#ff0000"); g.addColorStop(1, "#0000ff"); x.fillStyle = g;' +
      'x.fillText("H", 10, 120); var low = x.getImageData(24, 110, 1, 1).data, high = x.getImageData(24, 60, 1, 1).data;' +
      'log("drawn", JSON.stringify([one, scaled, turned, clipped, stem, off, low[2] > high[2]]));' +
      '</script>',
  );
  const alpha = (await p.until('alpha|')).split('|').map(Number);
  near(alpha[0], 128, 2, 'half the alpha');
  const [one, scaled, turned, clipped, stem, off, gradient] = JSON.parse(
    await p.until('drawn|'),
  );
  const [w, h] = [one[2] - one[0], one[3] - one[1]];
  near(scaled[2] - scaled[0], w * 2, 4, 'twice as wide');
  near(scaled[3] - scaled[1], h * 3, 4, 'three times as tall');
  near(turned[2] - turned[0], h, 2, 'its height across');
  near(turned[3] - turned[1], w, 2, 'its width down');
  assert.ok(
    turned[0] >= 150 && turned[2] < 185,
    `up is to the right: ${turned}`,
  );
  assert.ok(clipped[2] <= 40, `the clip cuts it: ${clipped}`);
  assert.strictEqual(stem, 0, 'destination-out takes the stem out');
  assert.strictEqual(off, 255, 'and nothing else');
  assert.strictEqual(gradient, true, 'a gradient is read along the glyphs');
});

test('text lands at a fraction of a pixel, not on the nearest one', async () => {
  // pdf.js places a document a letter at a time: rounded to a pixel, its
  // spacing comes and goes along a line
  const p = await scriptedPage(
    '<script>' +
      LOG +
      'x.font = "12px sans-serif";' +
      'function sum(px) { wipe(); x.fillText("H", px, 40);' +
      '  var d = x.getImageData(0, 0, 40, 60).data, moment = 0, mass = 0;' +
      '  for (var q = 0; q < 60; q += 1) for (var p = 0; p < 40; p += 1) {' +
      '    var a = d[(q * 40 + p) * 4 + 3]; moment += a * (p + 0.5); mass += a;' +
      '  }' +
      '  return moment / mass; }' +
      'var at = sum(10); log("drawn", sum(10.25) - at, sum(10.5) - at, sum(10.75) - at);' +
      '</script>',
  );
  const [a, b, c] = (await p.until('drawn|')).split('|').map(Number);
  near(a, 0.25, 0.08, 'a quarter');
  near(b, 0.5, 0.08, 'a half');
  near(c, 0.75, 0.08, 'three quarters');
});

test('maxWidth takes a string in across, and none or less draws nothing', async () => {
  const p = await scriptedPage(
    '<script>' +
      LOG +
      'x.font = "30px sans-serif";' +
      'x.fillText("HHHHHHHH", 10, 60, 80); var kept = ink(); wipe();' +
      'x.fillText("HH", 10, 60, 280); var wide = ink(); wipe();' +
      'x.fillText("HH", 10, 60, 0); x.fillText("HH", 10, 60, -1); x.fillText("HH", 10, 60, NaN);' +
      'x.fillText("HH", Infinity, 60); x.fillText("HH", 10, NaN); x.fillText("   \\n", 10, 60);' +
      'log("drawn", JSON.stringify([kept, wide, ink()]));' +
      '</script>',
  );
  const [kept, wide, none] = JSON.parse(await p.until('drawn|'));
  assert.ok(kept[2] <= 90 && kept[2] > 80, `in 80 from 10: ${kept}`);
  assert.ok(kept[3] - kept[1] > 15, `no shorter for it: ${kept}`);
  assert.ok(wide[2] < 70, `more room does not stretch it: ${wide}`);
  assert.strictEqual(none, null);
});

test('strokeText draws the edge of a glyph and not its inside', async () => {
  const p = await scriptedPage(
    '<script>' +
      LOG +
      'x.font = "bold 120px sans-serif"; x.lineWidth = 2;' +
      'x.fillText("H", 20, 150);' +
      // the middle of the stem, found from what fills it
      'var d = x.getImageData(0, 80, 300, 1).data, l = 0, r = 0;' +
      'for (var i = 0; i < 300; i += 1) if (d[i * 4 + 3] > 128) { if (!l) l = i; else if (r === 0 && d[(i + 1) * 4 + 3] < 128) r = i + 1; }' +
      'wipe(); x.strokeText("H", 20, 150);' +
      'var e = x.getImageData(0, 80, 300, 1).data;' +
      'log("drawn", r - l, e[((l + r) >> 1) * 4 + 3], e[l * 4 + 3] + e[(l - 1) * 4 + 3], JSON.stringify(ink()));' +
      '</script>',
  );
  const [stem, middle, edge, box] = (await p.until('drawn|')).split('|');
  assert.ok(Number(stem) > 10, `a stem to stand in: ${stem}`);
  assert.strictEqual(Number(middle), 0, 'nothing inside it');
  assert.ok(Number(edge) > 128, `a pen's width on its edge: ${edge}`);
  assert.ok(JSON.parse(box), 'and the rest of the glyph');
});

test('measureText reads the font, and a span in it agrees', async () => {
  const p = await scriptedPage(
    '<span id="s" style="font:italic 700 24px serif;white-space:pre">Hello, world</span><script>' +
      LOG +
      'var want = document.getElementById("s").getBoundingClientRect().width;' +
      'x.font = "italic 700 24px serif";' +
      'var m = x.measureText("Hello, world");' +
      'log("widths", want, m.width);' +
      'log("class", m instanceof TextMetrics, Object.prototype.toString.call(m),' +
      '  Object.keys(TextMetrics.prototype).length, (function () { try { new TextMetrics(); } catch (e) { return e.name; } })());' +
      'x.font = "20px sans-serif"; var a = x.measureText("ab").width;' +
      'x.font = "40px sans-serif"; log("doubles", a, x.measureText("ab").width);' +
      'var dot = x.measureText(".").width, space = x.measureText(". ").width - dot;' +
      'log("spaces", space > 0, x.measureText("  ").width > 0, x.measureText("").width);' +
      'var H = x.measureText("H"); log("ink", H.actualBoundingBoxLeft < 1, H.actualBoundingBoxRight <= H.width, H.actualBoundingBoxAscent > 20, Math.abs(H.actualBoundingBoxDescent) < 2);' +
      'var y = x.measureText("g"); log("below", y.actualBoundingBoxDescent > 4);' +
      'log("font", H.fontBoundingBoxAscent > 30, H.fontBoundingBoxDescent > 4, H.alphabeticBaseline, H.emHeightAscent + H.emHeightDescent);' +
      'x.textBaseline = "top"; var t = x.measureText("H"); log("anchored", Math.round(t.emHeightAscent), Math.round(t.alphabeticBaseline + H.emHeightAscent));' +
      'x.textBaseline = "alphabetic"; x.textAlign = "center"; var q = x.measureText("H"); log("centred", Math.round((q.actualBoundingBoxRight + q.width / 2 - H.actualBoundingBoxRight) * 100));' +
      'x.textAlign = "start"; x.letterSpacing = "5px"; log("spaced", Math.round(x.measureText("ab").width - a * 2));' +
      'x.letterSpacing = "0px"; x.wordSpacing = "1em"; var w = x.measureText("a b").width; x.wordSpacing = "0px"; log("word", Math.round(w - x.measureText("a b").width));' +
      '</script>',
  );
  const [want, got] = (await p.until('widths|')).split('|').map(Number);
  near(got, want, 0.5, 'as wide as the span');
  assert.strictEqual(
    await p.until('class|'),
    'true|[object TextMetrics]|0|TypeError',
  );
  const [one, two] = (await p.until('doubles|')).split('|').map(Number);
  near(two, one * 2, 0.5, 'twice the size is twice as wide');
  assert.strictEqual(await p.until('spaces|'), 'true|true|0');
  assert.strictEqual(await p.until('ink|'), 'true|true|true|true');
  assert.strictEqual(await p.until('below|'), 'true');
  assert.strictEqual(await p.until('font|'), 'true|true|0|40');
  assert.strictEqual(await p.until('anchored|'), '0|0');
  assert.strictEqual(await p.until('centred|'), '0');
  assert.strictEqual(await p.until('spaced|'), '10');
  assert.strictEqual(await p.until('word|'), '40');
});

test('a font is read as CSS reads it, and what is none is ignored', async () => {
  const p = await scriptedPage(
    '<canvas id="in" style="font-size:30px"></canvas><script>' +
      LOG +
      'var seen = [];' +
      '["20px serif", "italic 12px serif", "bold 10pt serif", "small-caps 700 8px/3 Unknown Font, sans-serif"].forEach(function (f) { x.font = f; seen.push(x.font); });' +
      'log("read", JSON.stringify(seen));' +
      'x.font = "20px serif";' +
      '["", "bogus", "12px", "inherit", "initial", "12px var(--a)", "20 serif"].forEach(function (f) { x.font = f; });' +
      'log("kept", x.font);' +
      'var y = document.getElementById("in").getContext("2d"); y.font = "2em serif"; log("em", y.font);' +
      // no document holds it, so an em is of the 10px a context starts at
      'x.font = "2em serif"; log("no document", x.font);' +
      'var s = document.createElement("canvas").getContext("2d");' +
      's.font = "50px sans-serif"; log("measured", s.measureText("H").width > 20);' +
      'x.save(); x.font = "20px serif"; x.restore(); log("restored", x.font);' +
      'x.textAlign = "bogus"; x.textBaseline = "x"; x.direction = "up"; x.fontKerning = "x"; x.fontStretch = "x"; x.fontVariantCaps = "x"; x.textRendering = "x"; x.letterSpacing = "wide"; x.wordSpacing = "9";' +
      'log("keywords", x.textAlign, x.textBaseline, x.direction, x.fontKerning, x.fontStretch, x.fontVariantCaps, x.textRendering, x.letterSpacing, x.wordSpacing, x.lang);' +
      '</script>',
  );
  assert.deepStrictEqual(JSON.parse(await p.until('read|')), [
    '20px serif',
    'italic 12px serif',
    '700 13.333px serif',
    'small-caps 700 8px "Unknown Font", sans-serif',
  ]);
  assert.strictEqual(await p.until('kept|'), '20px serif');
  assert.strictEqual(await p.until('em|'), '60px serif');
  assert.strictEqual(await p.until('no document|'), '20px serif');
  assert.strictEqual(await p.until('measured|'), 'true');
  assert.strictEqual(await p.until('restored|'), '20px serif');
  assert.strictEqual(
    await p.until('keywords|'),
    'start|alphabetic|inherit|auto|normal|normal|auto|0px|0px|inherit',
  );
});

test('a string is set again in the face that lands, not kept in the one before it', async () => {
  // pdf.js loads a document's fonts with `new FontFace` and draws in them
  const { readFileSync } = await import('node:fs');
  const mono = readFileSync(FONTS!.monospace);
  const bytes = [...new Uint8Array(mono.buffer, mono.byteOffset, mono.length)];
  const p = await scriptedPage(
    '<script>' +
      LOG +
      'x.font = "30px Landed, sans-serif";' +
      'x.fillText("iiii", 0, 50); var before = ink(); wipe();' +
      'log("before", x.measureText("iiii").width);' +
      `var face = new FontFace("Landed", new Uint8Array(${JSON.stringify(bytes)}).buffer);` +
      'document.fonts.add(face);' +
      'face.load().then(function () { x.fillText("iiii", 0, 50);' +
      '  log("after", JSON.stringify(before), JSON.stringify(ink()), x.measureText("iiii").width);' +
      '}, function (e) { log("after", "failed " + e); });' +
      '</script>',
    20000,
  );
  const was = Number(await p.until('before|'));
  const [before, after, width] = (await p.until('after|')).split('|');
  assert.ok(
    Number(width) > was * 1.2,
    `a monospace i is wider: ${width}, ${was}`,
  );
  assert.ok(
    JSON.parse(after)[2] > JSON.parse(before)[2] + 5,
    `and is drawn so: ${before}, ${after}`,
  );
});

test("a display's scale is no part of a canvas's units", async () => {
  const run = async (scale: number) => {
    const p = await scriptedPage(
      '<script>' +
        LOG +
        'x.font = "30px sans-serif"; x.fillText("HH", 10, 60);' +
        'log("drawn", x.measureText("HH").width, x.font, JSON.stringify(ink()));' +
        '</script>',
      5000,
      {},
      scale,
    );
    return p.until('drawn|');
  };
  assert.strictEqual(await run(2), await run(1));
});

test('an OffscreenCanvas draws text, and a worker, with no fonts, carries on', async () => {
  const worker =
    'var o = new OffscreenCanvas(40, 40), w = o.getContext("2d");' +
    'w.font = "20px sans-serif"; w.fillText("H", 5, 30);' +
    'postMessage(["measured", w.measureText("H").width > 0, w.font]);';
  const p = await scriptedPage(
    '<script>' +
      LOG +
      'var o = new OffscreenCanvas(100, 60), y = o.getContext("2d");' +
      'y.font = "30px sans-serif"; y.fillText("H", 5, 40);' +
      'log("drawn", JSON.stringify(ink(y)));' +
      `var t = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: "application/javascript" })));` +
      't.onmessage = function (e) { log(e.data.join("|")); };' +
      '</script>',
  );
  const box = JSON.parse(await p.until('drawn|'));
  assert.ok(box && box[0] >= 5 && box[3] === 40, `${box}`);
  assert.strictEqual(await p.until('measured|'), 'true|20px sans-serif');
});
