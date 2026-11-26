// A page's WebGL on a real GPU (`src/html/webgl.ts`), run where this machine
// has one and x11-dri can reach it, and skipped where it has none: a healthy
// machine with no picture. Each of these is a difference between WebGL and
// the desktop GL behind it that fails with nothing to show for it but a blank
// canvas, which is why they are read from pixels.
import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopGlsl, gpuWebGL } from '../../src/html/webgl.js';
import type {
  HtmlGLCommand,
  HtmlGLContext,
  HtmlGLOptions,
} from '../../src/html/webgl.js';

const webgl = await gpuWebGL();

const OPTIONS: HtmlGLOptions = {
  version: 2,
  width: 4,
  height: 4,
  alpha: true,
  depth: true,
  stencil: false,
  antialias: false,
  premultipliedAlpha: false,
};

/** A context, or the test skipped. */
function contextOf(
  t: { skip(message: string): void; after(fn: () => void): void },
  options: Partial<HtmlGLOptions> = {},
): HtmlGLContext | null {
  const context = webgl?.open({ ...OPTIONS, ...options }) ?? null;
  if (!context) {
    t.skip('no GPU here');
    return null;
  }
  t.after(() => context.dispose());
  return context;
}

const FRAMEBUFFER = 0x8d40;
const COLOR = 0x4000;
const TEXTURE_2D = 0xde1;
const ARRAY_BUFFER = 0x8892;
const STATIC_DRAW = 0x88e4;
const FLOAT = 0x1406;
const VERTEX = 0x8b31;
const FRAGMENT = 0x8b30;
const TRIANGLE_STRIP = 5;

const QUAD = Buffer.from(
  new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]).buffer,
).toString('base64');

/** Calls that make a program of `fragment`, numbered from `first`. */
function program(first: number, fragment: string): HtmlGLCommand[] {
  return [
    ['createShader', first, VERTEX],
    [
      'shaderSource',
      ['o', first],
      'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }',
    ],
    ['compileShader', ['o', first]],
    ['createShader', first + 1, FRAGMENT],
    ['shaderSource', ['o', first + 1], fragment],
    ['compileShader', ['o', first + 1]],
    ['createProgram', first + 2],
    ['attachShader', ['o', first + 2], ['o', first]],
    ['attachShader', ['o', first + 2], ['o', first + 1]],
    ['linkProgram', ['o', first + 2]],
    ['useProgram', ['o', first + 2]],
  ];
}

/** A quad over everything through the default vertex array. */
const DRAWN: HtmlGLCommand[] = [
  ['createBuffer', 90],
  ['bindBuffer', ARRAY_BUFFER, ['o', 90]],
  ['bufferData', ARRAY_BUFFER, ['b', 'Float32Array', QUAD], STATIC_DRAW],
  ['enableVertexAttribArray', 0],
  ['vertexAttribPointer', 0, 2, FLOAT, false, 0, 0],
  ['drawArrays', TRIANGLE_STRIP, 0, 4],
];

test('a page is drawn to with no vertex array bound, which a core profile has no such thing as', (t) => {
  const context = contextOf(t);
  if (!context) return;
  context.run([
    ...program(
      1,
      'precision highp float; void main() { gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); }',
    ),
    ['bindVertexArray', null],
    ...DRAWN,
  ]);
  assert.equal(context.run([['getError']]), 0);
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  context.present(pixels);
  assert.deepEqual([...pixels.subarray(0, 4)], [0, 255, 0, 255]);
});

test("a program's status is the page's boolean, and a shader that does not compile says so", (t) => {
  const context = contextOf(t);
  if (!context) return;
  const compile = 0x8b81;
  const link = 0x8b82;
  context.run(
    program(
      1,
      'precision highp float; void main() { gl_FragColor = vec4(1.0); }',
    ),
  );
  assert.equal(context.run([['getShaderParameter', ['o', 2], compile]]), true);
  assert.equal(context.run([['getProgramParameter', ['o', 3], link]]), true);
  context.run([
    ['createShader', 9, FRAGMENT],
    ['shaderSource', ['o', 9], 'this is no shader'],
    ['compileShader', ['o', 9]],
  ]);
  assert.equal(context.run([['getShaderParameter', ['o', 9], compile]]), false);
  assert.ok(String(context.run([['getShaderInfoLog', ['o', 9]]])).length > 0);
});

test('a uniform a program does not have is no location, and a present one is', (t) => {
  const context = contextOf(t);
  if (!context) return;
  context.run(
    program(
      1,
      'precision highp float; uniform float there; void main() { gl_FragColor = vec4(there); }',
    ),
  );
  assert.equal(
    context.run([['getUniformLocation', ['o', 3], 'missing']]),
    null,
  );
  assert.equal(
    typeof context.run([['getUniformLocation', ['o', 3], 'there']]),
    'number',
  );
});

test('the top of what a page drew is the top of the picture', (t) => {
  const context = contextOf(t);
  if (!context) return;
  // GL counts rows up, and a canvas's bitmap counts them down
  context.run([
    ['enable', 0xc11],
    ['scissor', 0, 2, 4, 2],
    ['clearColor', 1, 0, 0, 1],
    ['clear', COLOR],
    ['disable', 0xc11],
  ]);
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  context.present(pixels);
  assert.deepEqual([...pixels.subarray(0, 4)], [255, 0, 0, 255], 'the top row');
  assert.equal(pixels[3 * 4 * 4 + 3], 0, 'the bottom row');
});

test('an antialiased context with no alpha is resolved, and reads as opaque', (t) => {
  const context = contextOf(t, { antialias: true, alpha: false });
  if (!context) return;
  // a blit between two formats is an error that leaves what was there
  context.run([
    ['clearColor', 0, 0, 1, 1],
    ['clear', COLOR],
  ]);
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  context.present(pixels);
  assert.deepEqual([...pixels.subarray(0, 4)], [0, 0, 255, 255]);
  assert.equal(context.run([['getError']]), 0);
});

test('a premultiplied canvas reads as straight colour, as a picture is', (t) => {
  const context = contextOf(t, { premultipliedAlpha: true });
  if (!context) return;
  context.run([
    ['clearColor', 0.5, 0, 0, 0.5],
    ['clear', COLOR],
  ]);
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  context.present(pixels);
  assert.ok(pixels[0] > 250, `red ${pixels[0]}`);
  assert.ok(Math.abs(pixels[3] - 128) <= 1, `alpha ${pixels[3]}`);
});

test("a page's framebuffers hold half floats, and what it had bound stays bound over a present", (t) => {
  const context = contextOf(t);
  if (!context) return;
  const RGBA16F = 0x881a;
  const RGBA = 0x1908;
  const HALF_FLOAT = 0x140b;
  context.run([
    ['createTexture', 1],
    ['bindTexture', TEXTURE_2D, ['o', 1]],
    ['texImage2D', TEXTURE_2D, 0, RGBA16F, 8, 8, 0, RGBA, HALF_FLOAT, null],
    ['createFramebuffer', 2],
    ['bindFramebuffer', FRAMEBUFFER, ['o', 2]],
    ['framebufferTexture2D', FRAMEBUFFER, 0x8ce0, TEXTURE_2D, ['o', 1], 0],
  ]);
  assert.equal(
    context.run([['checkFramebufferStatus', FRAMEBUFFER]]),
    0x8cd5,
    'complete',
  );
  context.present(new Uint8ClampedArray(4 * 4 * 4));
  context.run([
    ['clearColor', 2, 0, 0, 1],
    ['clear', COLOR],
  ]);
  const read = context.run([['readPixels', 0, 0, 1, 1, RGBA, 0x1406, 16]]);
  const value = new Float32Array(
    Buffer.from(String(read), 'base64').buffer.slice(
      Buffer.from(String(read), 'base64').byteOffset,
      Buffer.from(String(read), 'base64').byteOffset + 16,
    ),
  );
  assert.equal(value[0], 2, 'a float, past what an 8-bit target holds');
});

test('a drawing buffer takes a new size', (t) => {
  const context = contextOf(t);
  if (!context) return;
  context.resize(2, 1);
  context.run([
    ['clearColor', 0, 1, 0, 1],
    ['clear', COLOR],
  ]);
  const pixels = new Uint8ClampedArray(2 * 4);
  context.present(pixels);
  assert.deepEqual([...pixels], [0, 255, 0, 255, 0, 255, 0, 255]);
});

test('GLSL ES 3.00 is said as 4.10 to a core profile, and to nothing else', () => {
  const es3 = '#version 300 es\nprecision highp float;\nvoid main() {}';
  assert.equal(
    desktopGlsl(es3, true),
    '#version 410 core\nprecision highp float;\nvoid main() {}',
  );
  assert.equal(desktopGlsl(es3, false), es3, 'ES drivers read it as it is');
  const commented = '// a licence\n#version 300 es\nvoid main() {}';
  assert.ok(desktopGlsl(commented, true).includes('#version 410 core'));
  const es1 = 'attribute vec2 p; void main() {}';
  assert.equal(desktopGlsl(es1, true), es1, 'ES 1.00 has a way in of its own');
});

test('a page reads its drawing buffer back, multisampled or not', (t) => {
  // WebGL's `antialias` defaults on, and GL refuses to read a multisampled
  // framebuffer: every page that read its canvas back got INVALID_OPERATION
  // and zeroes
  for (const antialias of [true, false]) {
    const context = contextOf(t, { antialias });
    if (!context) return;
    const read = context.run([
      ['clearColor', 0, 1, 0, 1],
      ['clear', COLOR],
      ['readPixels', 0, 0, 1, 1, 0x1908, 0x1401, 4],
      ['getError'],
    ]);
    assert.equal(read, 0, `no error, antialias ${antialias}`);
    const bytes = context.run([['readPixels', 0, 0, 1, 1, 0x1908, 0x1401, 4]]);
    assert.deepEqual(
      [...Buffer.from(bytes as string, 'base64')],
      [0, 255, 0, 255],
      `the clear colour, antialias ${antialias}`,
    );
  }
});

test('a frame is read top row first and straight, with the rows turned on the GPU, antialiased or not', (t) => {
  for (const antialias of [false, true]) {
    const context = contextOf(t, {
      width: 2,
      height: 2,
      antialias,
      premultipliedAlpha: true,
    });
    if (!context) return;
    const SCISSOR_TEST = 0xc11;
    context.run([
      ['enable', SCISSOR_TEST],
      // GL's first row is the bottom: opaque red
      ['scissor', 0, 0, 2, 1],
      ['clearColor', 1, 0, 0, 1],
      ['clear', COLOR],
      // and its second the top: blue at half alpha, premultiplied
      ['scissor', 0, 1, 2, 1],
      ['clearColor', 0, 0, 0.25, 0.5],
      ['clear', COLOR],
    ]);
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    context.present(pixels);
    const near = (got: number, want: number) =>
      assert.ok(Math.abs(got - want) <= 1, `${got} for ${want}`);
    // the picture's top row is the blue, made straight: 0.25 / 0.5
    near(pixels[0], 0);
    near(pixels[1], 0);
    near(pixels[2], 128);
    near(pixels[3], 128);
    // and its bottom the red
    assert.deepEqual([...pixels.slice(8, 12)], [255, 0, 0, 255]);
    // read again where the scissor is on, and into a snapshot: the same
    const kept = context.snapshot!();
    assert.ok(kept);
    assert.deepEqual(
      [...context.frameData!(kept.id)!.slice(8, 12)],
      [255, 0, 0, 255],
    );
    context.discard!(kept.id);
  }
});

test('a fence is the GPU’s: unsignaled until what came before it has run, and waited on for real', (t) => {
  // it was passed at once, so a page that limits its frames in flight by
  // fences drew a frame for each message it got and the GPU's backlog
  // stalled the next read for seconds
  const context = contextOf(t, { width: 64, height: 64 });
  if (!context) return;
  const SYNC_GPU_COMMANDS_COMPLETE = 0x9117;
  const SYNC_STATUS = 0x9114;
  const SIGNALED = 0x9119;
  context.run([
    ['clearColor', 1, 0, 0, 1],
    ['clear', COLOR],
    ['fenceSync', 1, SYNC_GPU_COMMANDS_COMPLETE, 0],
    ['flush'],
  ]);
  const wait = context.run([['clientWaitSync', ['o', 1], 1, 5_000_000_000]]);
  assert.ok(
    wait === 0x911a || wait === 0x911c,
    `waited for it, was 0x${Number(wait).toString(16)}`,
  );
  assert.equal(
    context.run([['getSyncParameter', ['o', 1], SYNC_STATUS]]),
    SIGNALED,
  );
  context.run([['deleteSync', ['o', 1]]]);
});
