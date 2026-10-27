// The geometry interfaces a page's scripts see (src/html/scripts/geometry.ts):
// `DOMPoint`, `DOMRect`, `DOMQuad` and `DOMMatrix` with their read-only
// parents, run in a page's realm. Geometry Interfaces Module Level 1 is the
// reference, and Chrome where it leaves a choice. Most of them run in a
// realm over a document nothing draws; what a laid-out element or a worker
// is needed for runs in an `<Html scripts>`.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import type { HtmlHandle } from '../../src/html/index.js';
import { HtmlSource } from '../../src/html/dom.js';
import { ScriptEngine } from '../../src/html/scripts/engine.js';
import { DomHost } from '../../src/html/scripts/host.js';
import { useScripts } from '../../src/html/scripts/hook.js';
import type { ScriptsOptions } from '../../src/html/scripts/runner.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);

const PAGE = 'https://example.test/dir/page.html';

/** A page's realm over a document nothing draws: `run` evaluates a
 *  function body there and answers what it returned, through JSON, or
 *  `threw <name>: <message>`. */
function realm() {
  const source = new HtmlSource();
  source.setSource('<html><body></body></html>', true);
  const logs: string[] = [];
  const host = new DomHost(
    source.document,
    {
      handle: { refresh() {}, base: null } as unknown as HtmlHandle,
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
    },
    PAGE,
  );
  const engine = new ScriptEngine(host.bridge, {
    timeout: 1000,
    onTimeout() {},
    log: (level, text) => void logs.push(`engine ${level}: ${text}`),
    settled() {},
  });
  host.entries = engine;
  return {
    run(body: string): unknown {
      logs.length = 0;
      engine.exec(
        'console.log((function () { try { return JSON.stringify((function () {' +
          body +
          '})()); } catch (e) { return JSON.stringify("threw " + e.name + ": " + e.message); } })())',
        'test',
        0,
      );
      assert.equal(logs.length, 1, logs.join('\n'));
      return JSON.parse(logs[0]);
    },
  };
}

/** The elements of a matrix, `m11` to `m44`, and whether it is 2D, as a
 *  page reads them. */
const ELEMENTS =
  'function els(m) { var out = []; for (var c = 1; c <= 4; c++) for (var r = 1; r <= 4; r++) out.push(m["m" + c + r]); return out.concat(m.is2D); }';

/** Sixteen numbers, as `els` answers them, within a hair of `expected`. */
function near(actual: unknown, expected: Array<number | boolean>) {
  const got = actual as Array<number | boolean>;
  assert.equal(got.length, expected.length, JSON.stringify(got));
  for (let i = 0; i < got.length; i++) {
    const a = got[i];
    const e = expected[i];
    if (typeof e === 'boolean') {
      assert.equal(a, e, `is2D of ${JSON.stringify(got)}`);
    } else {
      assert.ok(
        Math.abs((a as number) - e) < 1e-9,
        `element ${i}: ${a} for ${e}, in ${JSON.stringify(got)}`,
      );
    }
  }
}

const IDENTITY_2D = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, true];

test('a matrix is made from nothing, from six numbers or sixteen, and from no other count', () => {
  const { run } = realm();
  near(run(`${ELEMENTS} return els(new DOMMatrixReadOnly());`), IDENTITY_2D);
  // six are a, b, c, d, e and f
  near(run(`${ELEMENTS} return els(new DOMMatrix([1, 2, 3, 4, 5, 6]));`), [
    1,
    2,
    0,
    0,
    3,
    4,
    0,
    0,
    0,
    0,
    1,
    0,
    5,
    6,
    0,
    1,
    true,
  ]);
  // sixteen are column-major, and 3D whatever they hold
  near(
    run(
      `${ELEMENTS} return els(new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]));`,
    ),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1, false],
  );
  // a typed array is a sequence too
  assert.equal(
    run('return new DOMMatrix(new Float64Array([2, 0, 0, 2, 0, 0])).a;'),
    2,
  );
  assert.match(
    String(run('return new DOMMatrix([1, 2, 3]);')),
    /^threw TypeError: .*6 elements for a 2D matrix or 16 elements/,
  );
  assert.deepEqual(
    run(
      'var m = new DOMMatrix([1, 2, 3, 4, 5, 6]); return [m.a, m.b, m.c, m.d, m.e, m.f, m.isIdentity, new DOMMatrix().isIdentity];',
    ),
    [1, 2, 3, 4, 5, 6, false, true],
  );
});

test('a matrix is made from a transform list, its lengths absolute, as Chrome parses one', () => {
  const { run } = realm();
  near(
    run(
      `${ELEMENTS} return els(new DOMMatrixReadOnly('translate(10px, 20px) scale(2)'));`,
    ),
    [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1, true],
  );
  // a quarter turn leaves exact zeros, as Chrome's does
  assert.deepEqual(
    run(
      "var m = new DOMMatrix('rotate(90deg)'); return [m.a, m.b, m.c, m.d, Object.is(m.a, 0)];",
    ),
    [0, 1, -1, 0, true],
  );
  // every absolute unit, every angle unit, a percentage scale, and case
  near(
    run(
      `${ELEMENTS} return els(new DOMMatrix('TRANSLATE(1in, 3pt) rotate(0.5turn) scale(50%)'));`,
    ),
    [-0.5, 0, 0, 0, 0, -0.5, 0, 0, 0, 0, 1, 0, 96, 4, 0, 1, true],
  );
  // a 3D function makes it 3D, whatever it does
  near(
    run(`${ELEMENTS} return els(new DOMMatrix('translate3d(1px, 2px, 3px)'));`),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1, false],
  );
  assert.equal(run("return new DOMMatrix('translateZ(0)').is2D;"), false);
  assert.equal(run("return new DOMMatrix('perspective(100px)').m34;"), -0.01);
  assert.equal(
    run("return new DOMMatrix('perspective(none)').isIdentity;"),
    true,
  );
  // the empty string and `none` are the identity; white space alone is not
  assert.deepEqual(
    run(
      "return [new DOMMatrix('').isIdentity, new DOMMatrix(' none ').isIdentity];",
    ),
    [true, true],
  );
  for (const [text, error] of [
    ['translate(1em)', /^threw SyntaxError: .*absolute, not relative/],
    ['translate(10%)', /^threw SyntaxError: .*absolute, not relative/],
    ['translate(10)', /^threw SyntaxError: .*Failed to parse/],
    ['translate (1px)', /^threw SyntaxError/],
    ['translate(1px,)', /^threw SyntaxError/],
    ['rotate(45)', /^threw SyntaxError/],
    ['bogus(1px)', /^threw SyntaxError/],
    ['  ', /^threw SyntaxError/],
  ] as const) {
    assert.match(
      String(run(`return new DOMMatrix(${JSON.stringify(text)});`)),
      error,
      text,
    );
  }
  // an object with no iterator is read as a string: a matrix as its own
  assert.deepEqual(
    run(
      'var m = new DOMMatrix([1, 2, 3, 4, 5, 6]); var copy = new WebKitCSSMatrix(m); return [copy !== m, copy.toString()];',
    ),
    [true, 'matrix(1, 2, 3, 4, 5, 6)'],
  );
});

test('a matrix is said as the transform function that makes it, never with NaN or an infinity', () => {
  const { run } = realm();
  assert.equal(
    run("return String(new DOMMatrix('translate(10px, -0px)'));"),
    'matrix(1, 0, 0, 1, 10, 0)',
  );
  assert.equal(
    run("return new DOMMatrix('translateZ(5px)') + '';"),
    'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1)',
  );
  assert.match(
    String(run('return String(new DOMMatrix([NaN, 0, 0, 1, 0, 0]));')),
    /^threw InvalidStateError/,
  );
  // what a string makes is what was said
  assert.equal(
    run(
      'var m = new DOMMatrix().rotate(30, 20, 10).translate(1, 2, 3); var again = new DOMMatrix(String(m)); return again.toString() === m.toString();',
    ),
    true,
  );
});

test("a matrix's immutable methods hand back a new DOMMatrix, and its mutable ones change it", () => {
  const { run } = realm();
  assert.deepEqual(
    run(
      'var r = new DOMMatrixReadOnly(); var t = r.translate(5, 6);' +
        'return [t instanceof DOMMatrix, r.isIdentity, t.e, t.f, t.is2D];',
    ),
    [true, true, 5, 6, true],
  );
  assert.deepEqual(
    run(
      'var m = new DOMMatrix(); var same = m.translateSelf(5, 6, 7);' +
        'return [same === m, m.m41, m.m42, m.m43, m.is2D];',
    ),
    [true, 5, 6, 7, false],
  );
  // a scale about an origin keeps the origin where it was
  assert.deepEqual(
    run(
      'var p = new DOMMatrix().scale(2, undefined, 1, 10, 10).transformPoint({ x: 10, y: 10 });' +
        'return [p.x, p.y, new DOMMatrix().scale(3).d];',
    ),
    [10, 10, 3],
  );
  // rotate(z) alone is about z; a turn about x or y is 3D
  near(run(`${ELEMENTS} return els(new DOMMatrix().rotate(90));`), [
    0,
    1,
    0,
    0,
    -1,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    true,
  ]);
  near(run(`${ELEMENTS} return els(new DOMMatrix().rotate(90, 0, 0));`), [
    1,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    -1,
    0,
    0,
    0,
    0,
    0,
    1,
    false,
  ]);
  near(run(`${ELEMENTS} return els(new DOMMatrix().rotateFromVector(0, 1));`), [
    0,
    1,
    0,
    0,
    -1,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    true,
  ]);
  assert.deepEqual(
    run(
      'return [new DOMMatrix().rotateAxisAngle(0, 0, 2, 90).is2D, new DOMMatrix().rotateAxisAngle(1, 1, 0, 90).is2D];',
    ),
    [true, false],
  );
  // a turn about (1, 1, 1) by 120° takes x to y
  const turned = run(
    'var p = new DOMMatrix().rotateAxisAngle(1, 1, 1, 120).transformPoint({ x: 1 }); return [p.x, p.y, p.z];',
  ) as number[];
  near(turned, [0, 1, 0]);
  near(run(`${ELEMENTS} return els(new DOMMatrix().skewX(45).skewYSelf(0));`), [
    1,
    0,
    0,
    0,
    1,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    true,
  ]);
  assert.deepEqual(
    run(
      'var m = new DOMMatrix([1, 2, 3, 4, 5, 6]); return [m.flipX().toString(), m.flipY().toString()];',
    ),
    ['matrix(-1, -2, 3, 4, 5, 6)', 'matrix(1, 2, -3, -4, 5, 6)'],
  );
  // post- and pre-multiplication
  assert.deepEqual(
    run(
      'var a = new DOMMatrix().translate(10, 0); var b = new DOMMatrix().scale(2);' +
        'return [a.multiply(b).e, a.multiply(b).a, new DOMMatrix().translate(10, 0).preMultiplySelf(b).e];',
    ),
    [10, 2, 20],
  );
});

test('a matrix is inverted, and one with no inverse is NaN through and through', () => {
  const { run } = realm();
  near(
    run(
      `${ELEMENTS} return els(new DOMMatrix([2, 0, 0, 4, 10, 20]).inverse());`,
    ),
    [0.5, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1, 0, -5, -5, 0, 1, true],
  );
  near(
    run(
      `${ELEMENTS} var m = new DOMMatrix().rotate(10, 20, 30).translate(1, 2, 3).scale(2, 3, 4); return els(m.multiply(m.inverse()));`,
    ),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, false],
  );
  assert.deepEqual(
    run(
      'var m = new DOMMatrix([0, 0, 0, 0, 1, 1]); m.invertSelf(); return [String(m.a), String(m.m44), m.is2D];',
    ),
    ['NaN', 'NaN', false],
  );
});

test('a matrix from a dictionary agrees with itself, and a number of its third dimension makes it 3D', () => {
  const { run } = realm();
  assert.deepEqual(
    run(
      'var m = DOMMatrix.fromMatrix({ a: 2, m22: 3, e: 4 }); return [m.m11, m.d, m.m41, m.is2D, m instanceof DOMMatrix];',
    ),
    [2, 3, 4, true, true],
  );
  assert.equal(
    run('return DOMMatrixReadOnly.fromMatrix({ m13: 1 }).is2D;'),
    false,
  );
  assert.equal(
    run('return DOMMatrixReadOnly.fromMatrix({ m33: 1, is2D: false }).is2D;'),
    false,
  );
  assert.match(
    String(run('return DOMMatrix.fromMatrix({ a: 1, m11: 2 });')),
    /^threw TypeError: .*'a' property should equal the 'm11'/,
  );
  // NaN agrees with NaN, as SameValueZero has it
  assert.equal(
    run('return String(DOMMatrix.fromMatrix({ a: NaN, m11: NaN }).a);'),
    'NaN',
  );
  assert.match(
    String(run('return DOMMatrix.fromMatrix({ is2D: true, m33: 2 });')),
    /^threw TypeError/,
  );
  assert.deepEqual(
    run(
      'return [DOMMatrix.fromFloat32Array(new Float32Array([1, 2, 3, 4, 5, 6])).f, DOMMatrixReadOnly.fromFloat64Array(new Float64Array(16)).is2D];',
    ),
    [6, false],
  );
  assert.match(
    String(run('return DOMMatrix.fromFloat32Array([1, 2, 3, 4, 5, 6]);')),
    /^threw TypeError: .*not of type 'Float32Array'/,
  );
  assert.deepEqual(
    run(
      'var m = new DOMMatrix([1, 2, 3, 4, 5, 6]); return [Array.from(m.toFloat32Array()).length, m.toFloat64Array()[12]];',
    ),
    [16, 5],
  );
});

test('a DOMMatrix is set an element at a time, and a read-only one is not', () => {
  const { run } = realm();
  assert.deepEqual(
    run(
      'var m = new DOMMatrix(); m.e = 7; m.m22 = 2; var was = m.is2D;' +
        'm.m13 = 1; m.m13 = 0; return [m.m41, m.d, was, m.is2D];',
    ),
    [7, 2, true, false],
  );
  assert.match(
    String(run('"use strict"; var m = new DOMMatrixReadOnly(); m.a = 2;')),
    /^threw TypeError/,
  );
  // the attributes are the prototype's, and enumerable, as Web IDL has them
  assert.deepEqual(
    run(
      'var m = new DOMMatrix(); var seen = []; for (var k in m) seen.push(k);' +
        'return [Object.keys(m).length, seen.indexOf("m41") >= 0, seen.indexOf("translateSelf") >= 0,' +
        ' Object.getOwnPropertyDescriptor(DOMMatrixReadOnly.prototype, "a").get.name];',
    ),
    [0, true, true, 'get a'],
  );
  // a method of the mutable interface asks that its object is one
  assert.match(
    String(
      run(
        'return DOMMatrix.prototype.translateSelf.call(new DOMMatrixReadOnly(), 1);',
      ),
    ),
    /^threw TypeError: Illegal invocation/,
  );
  assert.equal(
    run(
      'var m = new DOMMatrix([1, 2, 3, 4, 5, 6]); var j = m.toJSON(); return [j.a, j.m42, j.is2D, j.isIdentity, Object.keys(j).length].join();',
    ),
    '1,6,true,false,24',
  );
});

test('a point is moved through a matrix, and a matrix through a point', () => {
  const { run } = realm();
  assert.deepEqual(
    run(
      'var p = new DOMPoint(1, 2); return [p.x, p.y, p.z, p.w, p instanceof DOMPointReadOnly];',
    ),
    [1, 2, 0, 1, true],
  );
  assert.deepEqual(
    run(
      'var q = new DOMMatrix().translate(10, 20).transformPoint(new DOMPoint(1, 2));' +
        'var r = new DOMPointReadOnly(1, 2).matrixTransform({ e: 10, f: 20 });' +
        'return [q.x, q.y, r.x, r.y, r instanceof DOMPoint];',
    ),
    [11, 22, 11, 22, true],
  );
  // a perspective divides nothing: w carries it
  assert.deepEqual(
    run(
      "var p = new DOMMatrix('perspective(100px)').transformPoint({ z: 50 }); return [p.z, p.w];",
    ),
    [50, 0.5],
  );
  assert.deepEqual(
    run(
      'var p = DOMPoint.fromPoint({ x: 3 }); p.y = 4; return [p.toJSON(), DOMPointReadOnly.fromPoint(p) instanceof DOMPoint];',
    ),
    [{ x: 3, y: 4, z: 0, w: 1 }, false],
  );
});

test("a rectangle's edges are where its size takes it, either way, and its attributes are its prototype's", () => {
  const { run } = realm();
  assert.deepEqual(
    run(
      'var r = new DOMRect(10, 20, -5, 30); return [r.left, r.right, r.top, r.bottom];',
    ),
    [5, 10, 20, 50],
  );
  assert.deepEqual(
    run(
      'var r = DOMRectReadOnly.fromRect({ width: 4, height: 3 }); var w = new DOMRect(); w.width = 2;' +
        'return [r.width, r instanceof DOMRect, w.right, Object.keys(w).length, JSON.stringify(w)];',
    ),
    [
      4,
      false,
      2,
      0,
      '{"x":0,"y":0,"width":2,"height":0,"top":0,"right":2,"bottom":0,"left":0}',
    ],
  );
});

test('a quad keeps its points, and is bounded by them', () => {
  const { run } = realm();
  assert.deepEqual(
    run(
      'var q = DOMQuad.fromRect({ x: 1, y: 2, width: 3, height: 4 });' +
        'var b = q.getBounds(); var before = [b.x, b.y, b.width, b.height];' +
        'q.p3.x = 10; var after = q.getBounds();' +
        'return [before, [after.x, after.width], q.p1 === q.p1, q.p2.x, JSON.parse(JSON.stringify(q)).p4];',
    ),
    [[1, 2, 3, 4], [1, 9], true, 4, { x: 1, y: 6, z: 0, w: 1 }],
  );
  assert.deepEqual(
    run(
      'var q = new DOMQuad({ x: 1 }, { y: 2 }, undefined, DOMPoint.fromPoint({ x: -3 })); var b = q.getBounds();' +
        'return [b.left, b.right, b.top, b.bottom, DOMQuad.fromQuad({ p2: { x: 5 } }).p2.x];',
    ),
    [-3, 1, 0, 2, 5],
  );
});

test('the interfaces have the names a window keeps for them, and are cloned as themselves', () => {
  const { run } = realm();
  assert.deepEqual(
    run(
      'return [WebKitCSSMatrix === DOMMatrix, SVGMatrix === DOMMatrix, SVGPoint === DOMPoint, SVGRect === DOMRect,' +
        ' Object.prototype.toString.call(new DOMMatrix()), Object.prototype.toString.call(new DOMQuad())];',
    ),
    [true, true, true, true, '[object DOMMatrix]', '[object DOMQuad]'],
  );
  assert.deepEqual(
    run(
      'var m = structuredClone(new DOMMatrixReadOnly("translate3d(1px, 2px, 3px)"));' +
        'var p = structuredClone(new DOMPoint(1, NaN));' +
        'var q = structuredClone(DOMQuad.fromRect({ width: 2 }));' +
        'return [m instanceof DOMMatrix, m instanceof DOMMatrixReadOnly, m.m43, m.is2D, p instanceof DOMPoint, String(p.y), q.p2.x];',
    ),
    [false, true, 3, false, true, 'NaN', 2],
  );
});

test("a canvas's transform is a DOMMatrix, and one is set from a dictionary", () => {
  const { run } = realm();
  assert.deepEqual(
    run(
      'var ctx = document.createElement("canvas").getContext("2d"); ctx.translate(3, 4); ctx.scale(2, 2);' +
        'var m = ctx.getTransform(); ctx.setTransform(new DOMMatrix([1, 0, 0, 1, 9, 9]));' +
        'var then = ctx.getTransform().e; ctx.setTransform(); var reset = ctx.getTransform().isIdentity;' +
        'var bad; try { ctx.setTransform({ a: 1, m11: 2 }); } catch (e) { bad = e.name; }' +
        'return [m instanceof DOMMatrix, m.toString(), then, reset, bad];',
    ),
    [true, 'matrix(2, 0, 0, 2, 3, 4)', 9, true, 'TypeError'],
  );
});

/** An `<Html scripts>` page, `files` its scripts and a worker's by their
 *  names: what its console said once it said `done`. */
async function page(
  source: string,
  files: Record<string, string> = {},
): Promise<string[]> {
  const logs: string[] = [];
  const answer = (url: string) => files[url.slice(url.lastIndexOf('/') + 1)];
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
    fetch: async (request) => {
      const body = answer(request.url);
      if (body === undefined) throw new Error('no answer');
      return {
        url: request.url,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: [['content-type', 'text/javascript']],
        body,
      };
    },
    load: async (url) => answer(url) ?? null,
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

test('where a box was moved to is read from its computed transform, as a carousel reads it', async () => {
  // the report: a page's `new window.DOMMatrixReadOnly(...)` threw, since
  // there was none
  const logs = await page(
    '<style>#slide { transform: translate(30px, 40px) rotate(90deg) } #still { width: 10px }</style>' +
      '<div id="slide">slide</div><div id="still">still</div><script>' +
      'var moved = new window.DOMMatrixReadOnly(getComputedStyle(document.getElementById("slide")).transform);' +
      'var still = new window.DOMMatrixReadOnly(getComputedStyle(document.getElementById("still")).transform);' +
      'console.log([Math.round(moved.m41), Math.round(moved.m42), Math.round(moved.b), moved.is2D, still.isIdentity].join());' +
      // what an element's box is handed over as, which copies with for…in
      'var r = document.getElementById("still").getBoundingClientRect(); var copy = {};' +
      'for (var k in r) if (typeof r[k] === "number") copy[k] = r[k];' +
      'console.log([r instanceof DOMRectReadOnly, r instanceof DOMRect, r.width, Object.keys(copy).sort().join()].join("|"));' +
      'console.log("done");' +
      '</script>',
  );
  assert.deepEqual(logs, [
    '30,40,1,true,true',
    'true|true|10|bottom,height,left,right,top,width,x,y',
    'done',
  ]);
});

test('a worker has the interfaces, parses no string, and is posted a matrix as a matrix', async () => {
  const logs = await page(
    '<script>' +
      'var w = new Worker("worker.js");' +
      'w.onmessage = function (e) { var d = e.data;' +
      '  console.log([d.made, d.parsed, d.said, d.alias, d.round instanceof DOMMatrix, d.round.toString()].join("|"));' +
      '  console.log("done"); };' +
      'w.postMessage(new DOMMatrix([1, 0, 0, 1, 5, 6]));' +
      '</script>',
    {
      'worker.js':
        'self.onmessage = function (e) { var m = e.data; var parsed;' +
        '  try { new DOMMatrix("none"); parsed = "parsed"; } catch (err) { parsed = err.name; }' +
        '  postMessage({ made: typeof DOMMatrix + ":" + (m instanceof DOMMatrix) + ":" + m.e,' +
        '    parsed: parsed, said: Object.prototype.hasOwnProperty.call(DOMMatrixReadOnly.prototype, "toString"),' +
        '    alias: typeof WebKitCSSMatrix + ":" + typeof SVGPoint, round: m.scale(2) }); };',
    },
  );
  assert.deepEqual(logs, [
    'function:true:5|TypeError|false|undefined:undefined|true|matrix(2, 0, 0, 2, 5, 6)',
    'done',
  ]);
});
