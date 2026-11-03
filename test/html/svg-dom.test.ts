// SVG 2's DOM types as a page's scripts see them (src/html/scripts/svg-dom.ts):
// the values an attribute is reflected as, the live lists of them, the
// animated objects an element's attributes are, and SVG's properties in
// `getComputedStyle` and `el.style` (src/html/css/svg-properties.ts). Every
// expected answer is what Chromium, Firefox and WebKit give for the same
// script, or two of them where they differ, as `svg-dom.ts` says; the cases
// were run in all three through Playwright.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import { useScripts } from '../../src/html/scripts/hook.js';
import type { ScriptsOptions } from '../../src/html/scripts/runner.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);

const PAGE = 'https://example.test/page.html';

/** An `<Html scripts>` page: what its console said once it said `done`. */
async function page(source: string): Promise<string[]> {
  const logs: string[] = [];
  const seams: ScriptsOptions = {
    userAgent: 'test',
    language: 'en-US',
    viewport: () => ({
      width: 400,
      height: 300,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      dpr: 1,
      left: 0,
      top: 0,
    }),
    scrollTo() {},
    navigate() {},
    reload() {},
    go() {},
    log: (_level, text) => void logs.push(text),
    title() {},
    fetch: () => Promise.reject(new Error('none')),
    load: async () => null,
    onTimeout() {},
  };
  function Page() {
    const handle = useHtmlHandle();
    const scripts = useScripts(true, handle, PAGE, seams);
    return h(Html, {
      source,
      partial: false,
      ref: handle.ref,
      baseUrl: PAGE,
      ...scripts,
    });
  }
  await renderX11(
    h('box', { style: { width: 400, flexDirection: 'column' } }, h(Page)),
    FONTS ? { width: 440, height: 400, fonts: FONTS } : { backend: 'mock' },
  );
  const end = Date.now() + 15000;
  while (!logs.includes('done') && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  return logs;
}

/** What `body` answers, run in a page of a 200 by 100 `<svg id="s">` once it
 *  is laid out, through JSON: a thrown error as `throws <name>`. `make`
 *  makes an SVG element in the drawing, with attributes. */
async function run(body: string, markup = ''): Promise<unknown> {
  const logs = await page(
    `<!DOCTYPE html><html><body><svg id="s" width="200" height="100">${markup}</svg><script>` +
      'const NS = "http://www.w3.org/2000/svg"; const svg = document.getElementById("s");' +
      'function make(tag, attrs) { const el = document.createElementNS(NS, tag);' +
      '  for (const k in attrs || {}) el.setAttribute(k, attrs[k]); svg.appendChild(el); return el; }' +
      'function L(s) { const l = svg.createSVGLength(); l.valueAsString = s; return [l.valueAsString, l.unitType, l.valueInSpecifiedUnits].join("|"); }' +
      'function tried(fn) { try { return fn(); } catch (e) { return "throws " + e.name; } }' +
      'setTimeout(() => { let out; try { out = (() => {' +
      body +
      '})(); } catch (e) { out = "threw " + e.name + ": " + e.message; }' +
      ' console.log(JSON.stringify(out)); console.log("done"); }, 30);' +
      '</script></body></html>',
  );
  assert.ok(logs.includes('done'), logs.join('\n'));
  return JSON.parse(logs[0]);
}

test('an SVGLength parses, serializes and converts as the browsers do', async () => {
  assert.deepEqual(
    await run(
      'return [L(" 5"), L(".5"), L("1E2px"), L("5PX"), L("-0"), L("5vw"), L("5q"), L("5%"), L("-.5em"),' +
        ' tried(() => L("1.")), tried(() => L("5 px")), tried(() => L("10deg")), tried(() => L("calc(5px)"))];',
    ),
    [
      '5|1|5',
      '0.5|1|0.5',
      '100px|5|100',
      '5px|5|5',
      '0|1|0',
      '5vw|0|5',
      '5q|0|5',
      '5%|2|5',
      '-0.5em|3|-0.5',
      'throws SyntaxError',
      'throws SyntaxError',
      'throws SyntaxError',
      'throws SyntaxError',
    ],
  );
  // a float, written with six significant digits as Chromium and Firefox
  // write one
  assert.deepEqual(
    await run(
      'return [1 / 3, 123456789, 1e-7, 0.1 + 0.2, 1.27, 2.5e-5].map((n) => {' +
        ' const l = svg.createSVGLength(); l.valueInSpecifiedUnits = n; return l.valueAsString + "|" + l.valueInSpecifiedUnits; });',
    ),
    [
      '0.333333|0.3333333432674408',
      '1.23457e+08|123456792',
      '1e-07|1.0000000116860974e-7',
      '0.3|0.30000001192092896',
      '1.27|1.2699999809265137',
      '2.5e-05|0.00002499999936844688',
    ],
  );
  // Web IDL's float and unsigned short, and what a length of no element
  // converts with: a percentage of 100
  assert.deepEqual(
    await run(
      'const l = svg.createSVGLength(); l.valueAsString = "2px";' +
        'const out = [tried(() => { l.value = NaN; }), tried(() => l.convertToSpecifiedUnits(11)),' +
        ' tried(() => l.newValueSpecifiedUnits(5, "x")), tried(() => l.newValueSpecifiedUnits("x", 4))];' +
        'l.convertToSpecifiedUnits(2); out.push(l.valueAsString, l.value);' +
        'l.valueAsString = "48px"; l.convertToSpecifiedUnits(6); out.push(l.valueAsString, l.value);' +
        'return out;',
    ),
    [
      'throws TypeError',
      'throws NotSupportedError',
      'throws TypeError',
      'throws NotSupportedError',
      '2%',
      2,
      '1.27cm',
      48,
    ],
  );
});

test('a length attribute is one SVGLength with its element, written through and read back live', async () => {
  assert.deepEqual(
    await run(
      'const r = make("rect", { x: "5" }); const b = r.x.baseVal;' +
        'const out = [r.x === r.x, b === r.x.baseVal, b === r.x.animVal];' +
        'r.setAttribute("x", "7px"); out.push(b.valueAsString);' +
        'r.removeAttribute("x"); out.push(b.valueAsString, b.unitType);' +
        'b.newValueSpecifiedUnits(6, 2); out.push(r.getAttribute("x"), r.x.animVal.value);' +
        'out.push(tried(() => { r.x.animVal.value = 3; }), tried(() => r.x.animVal.convertToSpecifiedUnits(1)));' +
        'const e = make("rect", { x: "5em", style: "font-size: 10px" }); e.x.baseVal.value = 30; out.push(e.getAttribute("x"));' +
        'const p = make("rect", { x: "50%", y: "50%", width: "10%" }); const c = make("circle", { r: "10%" });' +
        'out.push(p.x.baseVal.value, p.y.baseVal.value, p.width.baseVal.value, Math.round(c.r.baseVal.value * 1e4) / 1e4);' +
        'const loose = document.createElementNS(NS, "rect"); loose.setAttribute("x", "50%");' +
        'out.push(tried(() => loose.x.baseVal.value));' +
        'for (const a of ["abc", "10 20", "-5", " 10 ", "calc(10px + 5px)"]) { r.setAttribute("x", a); out.push(r.x.baseVal.valueAsString); }' +
        'return out;',
    ),
    [
      true,
      true,
      false,
      '7px',
      '0',
      1,
      '2cm',
      75.5905532836914,
      'throws NoModificationAllowedError',
      'throws NoModificationAllowedError',
      '3em',
      100,
      50,
      20,
      15.8114,
      'throws NotSupportedError',
      '0',
      '0',
      '-5',
      '10',
      '0',
    ],
  );
});

test('each length an element has starts at its initial value, a geometry size at none below nought', async () => {
  assert.deepEqual(
    await run(
      'const v = (el, n) => el[n].baseVal.valueAsString;' +
        'const f = make("filter"), m = make("mask"), g = make("radialGradient"), lg = make("linearGradient"), k = make("marker"), b = make("feBlend");' +
        'const out = [v(f, "x"), v(f, "width"), v(m, "y"), v(g, "cx"), v(g, "fr"), v(lg, "x2"), v(k, "markerWidth"), v(b, "width"), v(svg, "x")];' +
        'const r = make("rect", { width: "-10", rx: "auto" }); out.push(v(r, "width"), v(r, "rx"), r.rx.baseVal.value, r.rx.baseVal.unitType);' +
        'return out;',
    ),
    [
      '-10%',
      '120%',
      '-10%',
      '50%',
      '0%',
      '100%',
      '3',
      '100%',
      '0',
      '0',
      '0',
      0,
      1,
    ],
  );
});

test('an attribute of an element HTML made in a drawing is read by the name the tree keeps', async () => {
  // HTML's parser keeps `viewBox` in lower case here, as `getAttribute`
  // looks for it
  assert.deepEqual(
    await run(
      'const v = document.getElementById("v"); const g = document.getElementById("g");' +
        'return [v.viewBox.baseVal.height, v.preserveAspectRatio.baseVal.align, g.gradientUnits.baseVal];',
      '<svg id="v" viewBox="0 0 1 2" preserveAspectRatio="none"><linearGradient id="g" gradientUnits="userSpaceOnUse"/></svg>',
    ),
    [2, 1, 1],
  );
});

test('a transform list parses, serializes and keeps its items live', async () => {
  assert.deepEqual(
    await run(
      'const r = make("rect", { transform: "translate(10,20) rotate(45 5 5) scale(2) skewX(10) matrix(1,2,3,4,5,6)" });' +
        'const l = r.transform.baseVal; const items = [];' +
        'for (let i = 0; i < l.numberOfItems; i++) { const t = l.getItem(i); const m = t.matrix;' +
        '  items.push([t.type, t.angle, ...[m.a, m.b, m.c, m.d, m.e, m.f].map((x) => Math.round(x * 1000) / 1000)].join(",")); }' +
        'const t = make("rect", { transform: "translate(10,20)" }).transform.baseVal;' +
        'const one = t.getItem(0); one.setTranslate(1, 2); const rot = svg.createSVGTransform(); rot.setRotate(45, 1, 2); t.appendItem(rot);' +
        'const s = svg.createSVGTransform(); s.setScale(2, 2); t.appendItem(s);' +
        'const m = svg.createSVGTransform(); m.setMatrix({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }); t.appendItem(m);' +
        'const z = svg.createSVGTransform(); z.setRotate(30, 0, 0); t.appendItem(z);' +
        'const live = make("rect", { transform: "translate(10,20)" }); const lt = live.transform.baseVal.getItem(0); lt.matrix.a = 2;' +
        'const c = make("rect", { transform: "translate(10,20) scale(2)" }); const cc = c.transform.baseVal.consolidate();' +
        'return [items, t.getItem(0) === one, t.getItem(0).matrix.e, one.matrix === one.matrix,' +
        ' one.matrix instanceof SVGMatrix, one.matrix instanceof DOMMatrix, t.numberOfItems,' +
        ' lt.type, live.getAttribute("transform"), cc.type, c.getAttribute("transform"),' +
        ' make("rect").transform.baseVal.consolidate(), make("rect", { transform: "translate(1) foo(2)" }).transform.baseVal.numberOfItems];',
    ),
    [
      [
        '2,0,1,0,0,1,10,20',
        '4,45,0.707,0.707,-0.707,0.707,5,-2.071',
        '3,0,2,0,0,2,0,0',
        '5,10,1,0,0.176,1,0,0',
        '1,0,1,2,3,4,5,6',
      ],
      true,
      1,
      true,
      true,
      false,
      5,
      1,
      'matrix(2 0 0 1 10 20)',
      1,
      'matrix(2 0 0 2 10 20)',
      null,
      0,
    ],
  );
  // what a list writes, as Chromium and WebKit write it
  assert.equal(
    await run(
      'const r = make("rect", { transform: "translate(10,20)" }); const l = r.transform.baseVal;' +
        'l.getItem(0).setTranslate(1, 2); const t = svg.createSVGTransform(); t.setRotate(45, 1, 2); l.appendItem(t);' +
        'for (const [f, a] of [["setScale", [2, 2]], ["setSkewX", [10]], ["setSkewY", [1.5]], ["setTranslate", [5, 0]], ["setRotate", [30, 0, 0]]]) {' +
        '  const x = svg.createSVGTransform(); x[f](...a); l.appendItem(x); }' +
        'return r.getAttribute("transform");',
    ),
    'translate(1 2) rotate(45 1 2) scale(2 2) skewX(10) skewY(1.5) translate(5 0) rotate(30)',
  );
});

test('a list keeps its items across a change of its attribute, copies what is anything else, and is read only as an animVal', async () => {
  assert.deepEqual(
    await run(
      'const t = make("text", { x: "10 20 30", y: "40" }); const l = t.x.baseVal; const held = l.getItem(0); const last = l.getItem(2);' +
        't.setAttribute("x", "40 50"); const out = [held.value, l.getItem(0) === held, l.numberOfItems];' +
        'last.value = 9; out.push(t.getAttribute("x"));' +
        't.setAttribute("x", "10 20 INVALID"); out.push(l.numberOfItems);' +
        'const a = make("rect", { transform: "translate(1)" }); const b = make("rect", { transform: "translate(2)" });' +
        'const item = a.transform.baseVal.getItem(0); const got = b.transform.baseVal.appendItem(item);' +
        'out.push(got === item, a.transform.baseVal.numberOfItems, b.getAttribute("transform"));' +
        'const fresh = svg.createSVGTransform(); fresh.setScale(3, 3); b.transform.baseVal[1] = fresh;' +
        'out.push(b.getAttribute("transform"), b.transform.baseVal[1] === fresh, b.transform.baseVal.length);' +
        'out.push(tried(() => a.transform.animVal.clear()), tried(() => a.transform.baseVal.getItem(5)),' +
        ' tried(() => a.transform.baseVal.appendItem(svg.createSVGNumber())));' +
        'const r = make("text", { rotate: "10, 20 30" }); r.rotate.baseVal.getItem(0).value = 1.5; out.push(r.getAttribute("rotate"));' +
        'const p = make("polygon", { points: "1,2 3,4 5" }); p.points.getItem(0).x = 10.5;' +
        'const pt = svg.createSVGPoint(); pt.x = 7; pt.y = 8; p.points.appendItem(pt);' +
        'out.push(p.getAttribute("points"), p.points === p.points, p.points === p.animatedPoints, make("polyline", { points: "0,0 100,0 INVALID" }).points.numberOfItems);' +
        'const c = make("rect", { transform: "translate(1) scale(2)" }); c.transform.baseVal.clear(); out.push(JSON.stringify(c.getAttribute("transform")));' +
        'const s = make("rect", { systemLanguage: "en, fr-CA", requiredExtensions: "a b  c" });' +
        'out.push(s.systemLanguage.numberOfItems, s.systemLanguage.getItem(1), s.requiredExtensions.appendItem("d"), s.getAttribute("requiredExtensions"));' +
        'return out;',
    ),
    [
      40,
      true,
      2,
      '40 50',
      0,
      false,
      1,
      'translate(2 0) translate(1 0)',
      'translate(2 0) scale(3 3)',
      true,
      2,
      'throws NoModificationAllowedError',
      'throws IndexSizeError',
      'throws TypeError',
      '1.5 20 30',
      '10.5 2 3 4 7 8',
      true,
      false,
      0,
      '""',
      2,
      'fr-CA',
      'd',
      'a b c d',
    ],
  );
});

test('a viewBox, a preserveAspectRatio and the enumerations reflect their attributes', async () => {
  assert.deepEqual(
    await run(
      'const vb = (v) => { const s = document.createElementNS(NS, "svg"); if (v !== null) s.setAttribute("viewBox", v);' +
        ' const b = s.viewBox.baseVal; return [b.x, b.y, b.width, b.height].join(" "); };' +
        'const par = (v) => { const s = document.createElementNS(NS, "svg"); if (v !== null) s.setAttribute("preserveAspectRatio", v);' +
        ' const b = s.preserveAspectRatio.baseVal; return b.align + "|" + b.meetOrSlice; };' +
        'const out = [vb("0,0,100,50"), vb("0 0 -10 5"), vb("abc"), vb(null), par("xMinYMax slice"), par("bogus"), par(" xMaxYMid  meet ")];' +
        'const s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", "0 0 100 50"); const held = s.viewBox.baseVal;' +
        'held.width = 10.5; out.push(s.getAttribute("viewBox")); s.setAttribute("viewBox", "1 2 3 4"); out.push(held.x, s.viewBox.baseVal === held, held instanceof DOMRect);' +
        'out.push(tried(() => { s.viewBox.animVal.width = 5; }));' +
        's.preserveAspectRatio.baseVal.align = 2; out.push(s.getAttribute("preserveAspectRatio"), tried(() => { s.preserveAspectRatio.baseVal.align = 0; }));' +
        'const g = make("linearGradient", { gradientUnits: "bogus" }); out.push(g.gradientUnits.baseVal, g.spreadMethod.baseVal);' +
        'g.spreadMethod.baseVal = 3; out.push(g.getAttribute("spreadMethod"), tried(() => { g.gradientUnits.baseVal = 0; }), tried(() => { g.gradientUnits.baseVal = 9; }));' +
        'out.push(make("clipPath").clipPathUnits.baseVal, make("mask").maskContentUnits.baseVal, make("marker").markerUnits.baseVal, make("text").lengthAdjust.baseVal);' +
        'return out;',
    ),
    [
      '0 0 100 50',
      '0 0 -10 5',
      '0 0 0 0',
      '0 0 0 0',
      '8|2',
      '6|1',
      '7|1',
      '0 0 10.5 50',
      1,
      true,
      false,
      'throws NoModificationAllowedError',
      'xMinYMin meet',
      'throws NotSupportedError',
      2,
      1,
      'repeat',
      'throws TypeError',
      'throws TypeError',
      1,
      1,
      2,
      1,
    ],
  );
});

test("an element's strings, a marker's orient and a filter's numbers reflect theirs", async () => {
  assert.deepEqual(
    await run(
      'const r = make("rect", { class: "a b" }); const out = [r.className instanceof SVGAnimatedString, r.className.baseVal, r.className === r.className];' +
        'r.className.baseVal = "c d"; out.push(r.getAttribute("class"), r.classList.length);' +
        'r.className = "zz"; out.push(typeof r.className, r.getAttribute("class"));' +
        'const u = make("use"); u.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "#a"); out.push(u.href.baseVal);' +
        'u.href.baseVal = "#c"; out.push(u.getAttribute("href"), u.getAttributeNS("http://www.w3.org/1999/xlink", "href"));' +
        'const o = (v) => { const m = make("marker", v === null ? {} : { orient: v }); const a = m.orientAngle.baseVal;' +
        ' return [m.orientType.baseVal, a.unitType, Math.round(a.value * 1e4) / 1e4, a.valueAsString].join("|"); };' +
        'out.push(o("auto"), o("1rad"), o("10grad"), o("0.5turn"), o("auto-start-reverse"), o(null));' +
        'const m = make("marker", { orient: "auto" }); m.setOrientToAngle(svg.createSVGAngle()); const one = m.getAttribute("orient");' +
        'm.orientAngle.baseVal.value = 30; out.push(one, m.getAttribute("orient"), m.orientAngle.animVal.value); m.setOrientToAuto(); out.push(m.getAttribute("orient"), m.orientType.baseVal);' +
        'const f = make("feGaussianBlur", { stdDeviation: "2 3", in: "SourceGraphic", edgeMode: "wrap" });' +
        'out.push(f.constructor.name, f.stdDeviationX.baseVal, f.stdDeviationY.baseVal, f.in1.baseVal, f.edgeMode.baseVal, f.x.baseVal.valueAsString);' +
        'f.stdDeviationX.baseVal = 5; out.push(f.getAttribute("stdDeviation")); f.setStdDeviation(7, 8); out.push(f.getAttribute("stdDeviation"));' +
        'const c = make("feConvolveMatrix", { order: "3", preserveAlpha: "true", kernelMatrix: "1 0 0 0 1 0 0 0 1" });' +
        'out.push(c.orderX.baseVal, c.preserveAlpha.baseVal, c.kernelMatrix.baseVal.numberOfItems, c.divisor.baseVal);' +
        'const t = make("feTurbulence", { numOctaves: "2.5" }); out.push(t.numOctaves.baseVal); t.numOctaves.baseVal = 3.7; out.push(t.getAttribute("numOctaves"));' +
        'const s = make("stop", { offset: "50%" }); out.push(s.offset.baseVal); s.offset.baseVal = 0.25; out.push(s.getAttribute("offset"), tried(() => { s.offset.baseVal = NaN; }));' +
        'return out;',
    ),
    [
      true,
      'a b',
      true,
      'c d',
      2,
      'object',
      'c d',
      '#a',
      null,
      '#c',
      '1|1|0|0',
      '2|3|57.2958|1rad',
      '2|4|9|10grad',
      '2|0|180|0.5turn',
      '0|1|0|0',
      '2|1|0|0',
      '0',
      '30',
      30,
      'auto',
      1,
      'SVGFEGaussianBlurElement',
      2,
      3,
      'SourceGraphic',
      2,
      '0%',
      '5 3',
      '7 8',
      3,
      true,
      9,
      1,
      1,
      '3',
      0.5,
      '0.25',
      'throws TypeError',
    ],
  );
});

test('SVGPoint, SVGRect and SVGMatrix are interfaces of their own, with float numbers', async () => {
  assert.deepEqual(
    await run(
      'const p = svg.createSVGPoint(); const out = [p instanceof DOMPoint, p.constructor.name, p.w, tried(() => { p.x = NaN; })];' +
        'p.y = null; out.push(p.y);' +
        'const m = svg.createSVGMatrix(); out.push(m instanceof DOMMatrix, m.multiply({ a: 3, d: 2 }).a, tried(() => m.multiply({ a: 1, m11: 5 })),' +
        ' tried(() => m.scaleNonUniform(1, 0).inverse()), tried(() => m.rotateFromVector(0, 1)), m.translate(10, 20).scale(2).e);' +
        'p.x = 2; p.y = 3; const moved = p.matrixTransform(m.translate(10, 20).scale(2)); out.push(moved.x, moved.y);' +
        'const r = svg.createSVGRect(); out.push(r instanceof DOMRect, tried(() => { r.height = NaN; }));' +
        'const box = make("rect", { width: "10", height: "10" }); out.push(box.getBBox().constructor.name, box.getCTM().constructor.name);' +
        'out.push(svg.currentTranslate === svg.currentTranslate, svg.currentTranslate.constructor.name, document.rootElement);' +
        'out.push(["SVGLength", "SVGTransform", "SVGNumber", "SVGAnimatedLength"].map((n) => tried(() => new window[n]())).join(" "));' +
        'return out;',
    ),
    [
      false,
      'SVGPoint',
      null,
      'throws TypeError',
      0,
      false,
      3,
      'throws TypeError',
      'throws InvalidStateError',
      'throws InvalidAccessError',
      10,
      14,
      26,
      false,
      'throws TypeError',
      'SVGRect',
      'SVGMatrix',
      true,
      'SVGPoint',
      null,
      'throws TypeError throws TypeError throws TypeError throws TypeError',
    ],
  );
});

test('a shape says whether a point is in its fill or its stroke, by its rule, its width, its caps and its dashes', async () => {
  assert.deepEqual(
    await run(
      'const $ = (id) => document.getElementById(id); const pts = [[150, 150], [275, 150], [250, 225], [0, 0], [275, 250]];' +
        'return [pts.map(([x, y]) => $("e").isPointInFill({ x, y })), $("o").isPointInFill(), $("o").isPointInFill({ x: NaN, y: 0 }),' +
        ' $("eo").isPointInFill({ x: 250, y: 250 }), $("nz").isPointInFill({ x: 360, y: 250 }),' +
        ' [[275, 250], [300, 200], [375, 375], [0, 0], [150, 150]].map(([x, y]) => $("e").isPointInStroke({ x, y })),' +
        ' $("d").isPointInStroke({ x: 250, y: 50 }), $("d").isPointInStroke({ x: 300, y: 100 }), $("d").isPointInStroke({ x: 250, y: 150 })];',
      '<circle id="o" r="10"/><ellipse id="e" cx="150" cy="150" rx="200" ry="100" stroke-width="100"/>' +
        '<path id="eo" d="M200,200h100v100h-100z m20,20h60v60h-60z" fill-rule="evenodd"/>' +
        '<path id="nz" d="M310,200h100v100h-100z m20,20h60v60h-60z"/>' +
        '<rect id="d" width="100" height="100" x="200" y="50" stroke-dasharray="100" stroke-width="10" fill="none"/>',
    ),
    [
      [true, true, true, false, false],
      true,
      false,
      false,
      true,
      [true, true, false, false, false],
      true,
      false,
      true,
    ],
  );
});

test("getComputedStyle answers SVG's properties for every element, from rules, style and presentation attributes", async () => {
  assert.deepEqual(
    await run(
      'const g = (el, p) => getComputedStyle(el)[p];' +
        'const d = document.getElementById("d"); const c = document.getElementById("c"); const st = document.getElementById("st"); const r = document.getElementById("r");' +
        'return [g(d, "fill"), g(d, "stroke"), g(d, "strokeWidth"), g(d, "paintOrder"), g(d, "stopColor"), "rx" in getComputedStyle(d),' +
        ' g(c, "fill"), g(c, "cx"), g(c, "r"), g(c, "strokeDasharray"), g(c, "fillOpacity"), g(c, "markerEnd"),' +
        ' g(st, "stopColor"), g(st, "stopOpacity"), g(r, "rx"), g(r, "x"), g(r, "fill")];',
      '<style>#c { fill: url(#x) green; stroke-dasharray: 10 20%; fill-opacity: 300%; marker: url(#m) } .p circle { r: 0.5em }</style>' +
        '<g class="p" style="font-size: 40px; color: blue"><circle id="c" cx="5" r="7" fill="red"/></g>' +
        '<stop id="st" style="stop-color: currentcolor; stop-opacity: 50%; color: rgb(1, 2, 3)"/><rect id="r" rx="-5" x="5%" fill="inherit"/>' +
        '</svg><div id="d" style="fill: #00f; stroke-width: 2; paint-order: stroke fill"><svg>',
    ),
    [
      'rgb(0, 0, 255)',
      'none',
      '2px',
      'stroke',
      'rgb(0, 0, 0)',
      true,
      'url("#x") rgb(0, 128, 0)',
      '5px',
      '20px',
      '10px, 20%',
      '1',
      'url("#m")',
      'rgb(1, 2, 3)',
      '0.5',
      'auto',
      '5%',
      'rgb(0, 0, 0)',
    ],
  );
});

test("el.style keeps an SVG property's value canonical, and none it does not take", async () => {
  assert.deepEqual(
    await run(
      'const e = document.createElement("div"); const set = (p, v) => { e.style[p] = ""; e.style[p] = v; return e.style[p]; };' +
        'return [set("cx", "0"), set("cx", "10"), set("rx", "auto"), set("r", "-1px"), set("stopColor", "#ffffff"), set("stopColor", "currentcolor"),' +
        ' set("stroke", "rgb(0 128 0)"), set("stroke", "green"), set("stroke", "auto"), set("fillOpacity", "-100%"), set("fillOpacity", "1."),' +
        ' set("paintOrder", "markers fill stroke"), set("paintOrder", "normal stroke"), set("strokeDasharray", "10pt 20% 30pc 40in"),' +
        ' set("strokeWidth", "calc(2 + 1)"), set("strokeDashoffset", "40Q"), set("marker", "url(#a)"), e.style.markerMid, "cx" in e.style];',
    ),
    [
      '0px',
      '',
      'auto',
      '',
      'rgb(255, 255, 255)',
      'currentcolor',
      'rgb(0, 128, 0)',
      'green',
      '',
      '-1',
      '',
      'markers',
      '',
      '10pt, 20%, 30pc, 40in',
      'calc(3)',
      '40q',
      'url("#a")',
      'url("#a")',
      true,
    ],
  );
});

test("a chart library's page sets its geometry through baseVal and reads it back, as d3 and draw.io do", async () => {
  // what d3-zoom, draw.io's graph view and a chart's axis do with a drawing:
  // place marks through `x.baseVal.value`, move a group through its
  // transform list and consolidate it, size the drawing through its
  // viewBox, and turn a pointer's point into the drawing's units
  assert.deepEqual(
    await run(
      'const bars = []; for (let i = 0; i < 4; i++) { const r = make("rect"); r.x.baseVal.value = i * 30; r.width.baseVal.value = 20;' +
        ' r.height.baseVal.newValueSpecifiedUnits(SVGLength.SVG_LENGTHTYPE_PERCENTAGE, 25 * (i + 1)); bars.push(r); }' +
        'const g = make("g"); bars.forEach((r) => g.appendChild(r));' +
        'const list = g.transform.baseVal; const move = svg.createSVGTransform(); move.setTranslate(10, 5); list.appendItem(move);' +
        'const zoom = svg.createSVGTransform(); zoom.setScale(2, 2); list.appendItem(zoom);' +
        'const placed = bars.map((r) => [r.getAttribute("x"), r.getAttribute("height"), r.height.baseVal.value]);' +
        'const attr = g.getAttribute("transform"); const one = list.consolidate();' +
        'svg.viewBox.baseVal.width = 400; svg.viewBox.baseVal.height = 200;' +
        'const pt = svg.createSVGPoint(); pt.x = 50; pt.y = 20; const local = pt.matrixTransform(g.getCTM().inverse());' +
        'return [placed, attr, g.getAttribute("transform"), one.matrix.a, one.matrix.e, svg.getAttribute("viewBox"),' +
        ' [local.x, local.y].map((n) => Math.round(n * 100) / 100), bars[3].getBBox().width];',
    ),
    [
      [
        ['0', '25%', 25],
        ['30', '50%', 50],
        ['60', '75%', 75],
        ['90', '100%', 100],
      ],
      'translate(10 5) scale(2 2)',
      'matrix(2 0 0 2 10 5)',
      2,
      10,
      '0 0 400 200',
      // the viewBox written is in what `getCTM` answers, as Chromium and
      // WebKit have it; Firefox writes no viewBox where there was none
      [45, 17.5],
      20,
    ],
  );
});
