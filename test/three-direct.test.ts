// The direct backend's renderer, asserted on the **GL call stream** it
// produces against a recording fake — the same idea as the indirect test,
// which checks encoded GLX bytes. What matters is a protocol property
// either way: geometry reaches the GPU once and a frame is uniforms plus a
// draw call, never the vertices again.
//
// Hermetic by construction: no X server, no GPU, no addon. The renderer
// only ever touches `gl`, so a fake one is the whole environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DirectRenderer } from '../src/three/renderer-direct.js';
import { PostProcessor } from '../src/three/postprocess.js';
import {
  Mesh,
  PerspectiveCamera,
  PointLight,
  Scene,
} from '../src/three/objects.js';
import { BoxGeometry } from '../src/three/geometries.js';
import {
  MeshPhongMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
} from '../src/three/materials.js';
import { EffectComposer, VignettePass } from '../src/three/passes.js';

interface Call {
  name: string;
  args: unknown[];
}

/** A `gl` that records every call and answers queries optimistically. */
function fakeGL({ compileFails = false } = {}) {
  const calls: Call[] = [];
  const shaderSources: { type: unknown; source: string }[] = [];
  let nextId = 1;
  const record =
    (name: string, result?: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return result ? result(...args) : undefined;
    };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const gl: any = {
    calls,
    shaderSources,
    TRIANGLES: 4,
    UNSIGNED_SHORT: 0x1403,
    FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    LEQUAL: 0x0203,
    FRONT: 0x0404,
    BACK: 0x0405,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNPACK_ALIGNMENT: 0x0cf5,
    FRAMEBUFFER: 0x8d40,
    RENDERBUFFER: 0x8d41,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    DEPTH_COMPONENT16: 0x81a5,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    TRIANGLE_STRIP: 5,
  };
  for (const name of [
    'enable',
    'disable',
    'depthFunc',
    'depthMask',
    'cullFace',
    'blendFunc',
    'lineWidth',
    'useProgram',
    'bindBuffer',
    'bufferData',
    'deleteBuffer',
    'enableVertexAttribArray',
    'vertexAttribPointer',
    'drawArrays',
    'drawElements',
    'uniform1f',
    'uniform1i',
    'uniform2fv',
    'uniform3fv',
    'uniform4fv',
    'uniform1fv',
    'uniformMatrix3fv',
    'uniformMatrix4fv',
    'attachShader',
    'linkProgram',
    'deleteShader',
    'deleteProgram',
    'deleteTexture',
    'bindTexture',
    'activeTexture',
    'texImage2D',
    'texParameteri',
    'pixelStorei',
    'bindFramebuffer',
    'bindRenderbuffer',
    'renderbufferStorage',
    'framebufferTexture2D',
    'framebufferRenderbuffer',
    'deleteFramebuffer',
    'deleteRenderbuffer',
    'viewport',
    'clearColor',
    'clear',
  ]) {
    gl[name] = record(name);
  }
  gl.createBuffer = record('createBuffer', () => ({ id: nextId++ }));
  gl.createTexture = record('createTexture', () => ({ id: nextId++ }));
  gl.createProgram = record('createProgram', () => ({ id: nextId++ }));
  gl.createFramebuffer = record('createFramebuffer', () => ({ id: nextId++ }));
  gl.createRenderbuffer = record('createRenderbuffer', () => ({
    id: nextId++,
  }));
  gl.createShader = record('createShader', (type: unknown) => ({
    id: nextId++,
    type,
  }));
  gl.shaderSource = (shader: { type: unknown }, source: string) => {
    calls.push({ name: 'shaderSource', args: [shader, source] });
    shaderSources.push({ type: shader.type, source });
  };
  gl.compileShader = record('compileShader');
  gl.getShaderParameter = () => !compileFails;
  gl.getProgramParameter = () => true;
  gl.getShaderInfoLog = () => 'ERROR: 0:3 syntax error';
  gl.getProgramInfoLog = () => 'link failed';
  gl.getUniformLocation = (_p: unknown, name: string) => `u:${name}`;
  gl.getAttribLocation = (_p: unknown, name: string) =>
    ({ position: 0, normal: 1, uv: 2 })[name as 'position'] ?? -1;
  gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_COMPLETE;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return gl;
}

const count = (calls: Call[], name: string) =>
  calls.filter((call) => call.name === name).length;

function phongScene() {
  const scene = new Scene();
  const mesh = new Mesh(
    new BoxGeometry(1, 1, 1),
    new MeshPhongMaterial({ color: '#2980b9', shininess: 40 }),
  );
  const light = new PointLight();
  light.position.set(4, 5, 3);
  scene.add(mesh, light);
  const camera = new PerspectiveCamera();
  camera.position.set(0, 0, 6);
  return { scene, mesh, camera };
}

const SIZE = { width: 320, height: 240 };

test('geometry uploads once; later frames are uniforms and one draw', () => {
  const gl = fakeGL();
  const renderer = new DirectRenderer();
  const { scene, mesh, camera } = phongScene();

  renderer.render(gl, scene, camera, SIZE);
  const uploads = count(gl.calls, 'bufferData');
  assert.equal(uploads, 4, 'position, normal, uv and the index — once');
  assert.equal(count(gl.calls, 'drawElements'), 1);
  const programs = count(gl.calls, 'createProgram');
  assert.equal(programs, 1, 'one program for one material configuration');

  gl.calls.length = 0;
  mesh.rotation.y += 0.4;
  renderer.render(gl, scene, camera, SIZE);
  assert.equal(count(gl.calls, 'bufferData'), 0, 'no geometry re-sent');
  assert.equal(count(gl.calls, 'createProgram'), 0, 'no recompile');
  assert.equal(count(gl.calls, 'drawElements'), 1, 'still one draw');
  assert.ok(count(gl.calls, 'uniformMatrix4fv') >= 3, 'matrices re-sent');
});

test('the generated program is lit per light count and declares three names', () => {
  const gl = fakeGL();
  const renderer = new DirectRenderer();
  const { scene, camera } = phongScene();
  renderer.render(gl, scene, camera, SIZE);

  const vertex = gl.shaderSources.find((s: { source: string }) =>
    s.source.includes('attribute vec3 position'),
  );
  assert.ok(vertex, "three.js's attribute names are declared");
  const fragment = gl.shaderSources.find((s: { source: string }) =>
    s.source.includes('lightPosition[1]'),
  );
  assert.ok(fragment, 'one light in the scene compiles a one-light shader');
  assert.ok(fragment.source.includes('shininess'), 'phong terms present');
});

test('meshStandardMaterial draws through the shared phong mapping', () => {
  const gl = fakeGL();
  const renderer = new DirectRenderer();
  const scene = new Scene();
  scene.add(
    new Mesh(
      new BoxGeometry(),
      new MeshStandardMaterial({ color: 'orange', roughness: 0.3 }),
    ),
    new PointLight(),
  );
  const camera = new PerspectiveCamera();
  renderer.render(gl, scene, camera, SIZE);
  const specular = gl.calls.find(
    (call: Call) => call.name === 'uniform3fv' && call.args[0] === 'u:specular',
  );
  assert.ok(specular, 'roughness/metalness became specular terms');
});

test('a shader material compiles once per source and takes { value } uniforms', () => {
  const gl = fakeGL();
  const renderer = new DirectRenderer();
  const scene = new Scene();
  const material = new ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(uColor, uTime); }',
    uniforms: { uTime: 0.5, uColor: { value: [1, 0, 1] } },
  });
  scene.add(new Mesh(new BoxGeometry(), material));
  const camera = new PerspectiveCamera();

  renderer.render(gl, scene, camera, SIZE);
  assert.equal(count(gl.calls, 'createProgram'), 1);
  const time = gl.calls.find(
    (call: Call) => call.name === 'uniform1f' && call.args[0] === 'u:uTime',
  );
  assert.ok(time, 'a bare number goes out as uniform1f');
  assert.equal(time.args[1], 0.5);
  const color = gl.calls.find(
    (call: Call) => call.name === 'uniform3fv' && call.args[0] === 'u:uColor',
  );
  assert.ok(color, 'three numbers go out as a vec3');

  // animating a uniform never recompiles anything
  gl.calls.length = 0;
  material.uniforms.uTime.value = 0.75;
  renderer.render(gl, scene, camera, SIZE);
  assert.equal(count(gl.calls, 'createShader'), 0);
  const again = gl.calls.find(
    (call: Call) => call.name === 'uniform1f' && call.args[0] === 'u:uTime',
  );
  assert.equal(again.args[1], 0.75);
});

test('a broken shader is reported once and its mesh skipped', () => {
  const gl = fakeGL({ compileFails: true });
  const renderer = new DirectRenderer();
  const reports: Error[] = [];
  renderer.onError = (err) => reports.push(err);
  const scene = new Scene();
  scene.add(
    new Mesh(new BoxGeometry(), new ShaderMaterial({ fragmentShader: '!' })),
  );
  const camera = new PerspectiveCamera();

  renderer.render(gl, scene, camera, SIZE);
  renderer.render(gl, scene, camera, SIZE);
  assert.equal(reports.length, 1, 'reported once, not per frame');
  assert.equal(
    (reports[0] as Error & { code?: string }).code,
    'GL_SHADER_FAILED',
  );
  assert.ok(
    reports[0].message.includes('syntax error'),
    "the driver's own log is the message",
  );
  assert.equal(count(gl.calls, 'drawElements'), 0, 'the mesh is skipped');
});

test('the composer ping-pongs targets and never reads what it writes', () => {
  const gl = fakeGL();
  const renderer = new DirectRenderer();
  const { scene, camera } = phongScene();
  const composer = new EffectComposer();
  const passA = new VignettePass();
  const passB = new VignettePass();
  composer.add(passA, passB);
  scene.add(composer);

  const post = new PostProcessor(renderer);
  const info = SIZE;
  assert.ok(post.begin(gl, info, composer), 'the frame is redirected');
  renderer.render(gl, scene, camera, info);
  assert.ok(post.end(gl, info));

  // walk the recorded stream: framebuffer binds vs texture binds per draw
  let bound: unknown = 'window';
  let reading: unknown = null;
  for (const call of gl.calls as Call[]) {
    if (call.name === 'bindFramebuffer') bound = call.args[1] ?? 'window';
    if (call.name === 'bindTexture') reading = call.args[1];
    if (call.name === 'drawArrays') {
      assert.notEqual(
        reading,
        bound && (bound as { texture?: unknown }).texture,
        'a pass never samples the target it is writing',
      );
    }
  }
  // two passes: first into the second target, last into the window (0)
  const lastBind = (gl.calls as Call[])
    .filter((call) => call.name === 'bindFramebuffer')
    .at(-2);
  assert.equal(lastBind!.args[1], 0, 'the last pass writes the window');
});
