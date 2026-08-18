// The scene reconciler and the object model, hermetically: no X server, no
// GL, no `<glarea>` — the reconciler renders into the object graph and the
// graph is what the assertions read. The r3f prop contract lives here:
// `args` in place, tuples through `.set()`, dashed paths, attach, events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { createSceneRoot, extend } from '../src/three/reconciler.js';
import type { SceneContainer } from '../src/three/reconciler.js';
import {
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
  SpotLight,
} from '../src/three/objects.js';
import { BoxGeometry, SphereGeometry } from '../src/three/geometries.js';
import {
  MeshPhongMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  standardToPhong,
} from '../src/three/materials.js';
import { Color, Vector3 } from '../src/three/math.js';
import { createThreeStore, computeViewport } from '../src/three/store.js';
import type { ThreeStore } from '../src/three/store.js';
import { EffectComposer, BloomPass } from '../src/three/passes.js';
import { raycast } from '../src/three/raycast.js';
import { IndirectRenderer } from '../src/three/renderer-indirect.js';

const h = React.createElement;

function makeContainer({ supportsShaders = true } = {}): {
  container: SceneContainer;
  scene: Scene;
  store: ThreeStore;
  removed: object[];
  invalidations: () => number;
} {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  let invalidated = 0;
  const removed: object[] = [];
  const size = { width: 320, height: 240 };
  const store = createThreeStore({
    gl: null,
    backend: null,
    scene,
    camera,
    size,
    viewport: computeViewport(camera, size),
    clock: { elapsedTime: 0, delta: 0 },
    supportsShaders,
    frameloop: 'demand',
    invalidate: () => {
      invalidated += 1;
    },
  });
  const container: SceneContainer = {
    scene,
    store,
    invalidate: () => store.getState().invalidate(),
    onRemoved: (instance) => removed.push(instance),
  };
  return {
    container,
    scene,
    store,
    removed,
    invalidations: () => invalidated,
  };
}

/** Render and wait for the commit to land in the graph. */
function render(
  container: SceneContainer,
  element: React.ReactNode,
  root = createSceneRoot(container),
) {
  return new Promise<ReturnType<typeof createSceneRoot>>((resolve) => {
    root.render(element, () => resolve(root));
  });
}

test('elements become objects; geometry and material attach to their mesh', async () => {
  const { container, scene } = makeContainer();
  await render(
    container,
    h(
      'mesh',
      { position: [1, 2, 3], scale: 2 },
      h('boxGeometry', { args: [2, 1, 1] }),
      h('meshPhongMaterial', { color: '#2980b9', shininess: 12 }),
    ),
  );

  assert.equal(scene.children.length, 1);
  const mesh = scene.children[0] as Mesh;
  assert.ok(mesh.isMesh);
  assert.deepEqual(mesh.position.toArray(), [1, 2, 3]);
  assert.deepEqual(mesh.scale.toArray(), [2, 2, 2]);
  // auto-attach: children with isGeometry/isMaterial land in the slots, not
  // in `children`
  assert.ok(mesh.geometry instanceof BoxGeometry);
  assert.deepEqual(mesh.geometry!.args, [2, 1, 1]);
  const material = mesh.material as MeshPhongMaterial;
  assert.ok(material instanceof MeshPhongMaterial);
  assert.equal(material.shininess, 12);
  // '#2980b9' is rgb(41, 128, 185)
  assert.ok(Math.abs(material.color.r - 41 / 255) < 1e-6);
  assert.equal(mesh.children.length, 0);
});

test('args change rebuilds the geometry in place — the ref stays valid', async () => {
  const { container, scene } = makeContainer();
  const root = await render(
    container,
    h('mesh', {}, h('sphereGeometry', { args: [1, 8, 6] })),
  );
  const mesh = scene.children[0] as Mesh;
  const geometry = mesh.geometry!;
  const before = geometry.version;
  assert.ok(geometry instanceof SphereGeometry);

  await render(
    container,
    h('mesh', {}, h('sphereGeometry', { args: [2, 8, 6] })),
    root,
  );
  assert.equal(mesh.geometry, geometry, 'same object after args change');
  assert.ok(geometry.version > before, 'version bumped so caches re-upload');
  assert.equal(geometry.data().positions[0 * 3 + 1], 2, 'radius really moved');

  // unchanged args do not invalidate
  const version = geometry.version;
  await render(
    container,
    h('mesh', {}, h('sphereGeometry', { args: [2, 8, 6] })),
    root,
  );
  assert.equal(geometry.version, version);
});

test('dashed paths, nested material props and events', async () => {
  const { container, scene, store } = makeContainer();
  const clicks: unknown[] = [];
  await render(
    container,
    h(
      'mesh',
      {
        'position-x': 4,
        'rotation-y': 0.5,
        onClick: (event: unknown) => clicks.push(event),
      },
      h('meshStandardMaterial', { 'color-r': 0.25, roughness: 0.5 }),
    ),
  );
  const mesh = scene.children[0] as Mesh;
  assert.equal(mesh.position.x, 4);
  assert.equal(mesh.rotation.y, 0.5);
  const material = mesh.material as MeshStandardMaterial;
  assert.equal(material.color.r, 0.25);
  assert.equal(material.roughness, 0.5);
  assert.equal(typeof mesh.__handlers?.onClick, 'function');
  assert.ok(store.eventsDirty, 'the surface is told to reconsider events');
});

test('mutating through the ref marks the surface dirty without React', async () => {
  const { container, scene, invalidations } = makeContainer();
  await render(container, h('group', {}, h('mesh', {})));
  const group = scene.children[0] as Group;
  scene.propagateDirty(container.invalidate);

  const before = invalidations();
  group.rotation.y += 0.1;
  assert.equal(invalidations(), before + 1, 'a rotation write invalidates');
  group.position.set(1, 0, 0);
  assert.equal(invalidations(), before + 2);
});

test('explicit attach: <color attach="background"> sets the scene clear', async () => {
  const { container, scene } = makeContainer();
  await render(
    container,
    h('color', { attach: 'background', args: ['#102030'] }),
  );
  assert.ok(scene.background instanceof Color);
  assert.ok(Math.abs(scene.background!.b - 48 / 255) < 1e-6);
});

test('primitive mounts an existing object; removal releases it', async () => {
  const { container, scene, removed } = makeContainer();
  const object = new Mesh(new BoxGeometry(1, 1, 1));
  const root = await render(container, h('primitive', { object }));
  assert.equal(scene.children[0], object);

  await render(container, null, root);
  assert.equal(scene.children.length, 0);
  assert.ok(removed.includes(object));
});

test('a spot light aims through target and keeps three defaults', async () => {
  const { container, scene } = makeContainer();
  await render(
    container,
    h('spotLight', { position: [0, 5, 0], target: [1, 0, 0], penumbra: 0.5 }),
  );
  const light = scene.children[0] as SpotLight;
  assert.ok(light.isSpotLight);
  assert.deepEqual(light.target.toArray(), [1, 0, 0]);
  assert.equal(light.penumbra, 0.5);
  assert.ok(Math.abs(light.angle - Math.PI / 6) < 1e-9);
});

test('a shader material on an indirect-only connection refuses to mount', async () => {
  // The throw happens in createInstance, up front, with the reason — React
  // then routes it through the root's error handler and drops the subtree.
  // What a test can observe from outside is exactly what a user would see:
  // the scene did not get something that could never draw.
  const { container, scene } = makeContainer({ supportsShaders: false });
  await render(container, h('mesh', {}, h('shaderMaterial', {})));
  const mesh = scene.children[0] as Mesh | undefined;
  assert.ok(!mesh?.material, 'nothing shader-shaped mounted');

  // the same tree on a connection with direct GL mounts fine
  const withGL = makeContainer({ supportsShaders: true });
  await render(withGL.container, h('mesh', {}, h('shaderMaterial', {})));
  const okMesh = withGL.scene.children[0] as Mesh;
  assert.ok(okMesh.material instanceof ShaderMaterial);
});

test('extend() teaches the reconciler a new class, r3f-style', async () => {
  class Rig extends Group {
    speed = 1;
  }
  extend({ Rig });
  const { container, scene } = makeContainer();
  await render(container, h('rig', { speed: 3 }, h('mesh', {})));
  const rig = scene.children[0] as Rig;
  assert.ok(rig instanceof Rig);
  assert.equal(rig.speed, 3);
  assert.equal(rig.children.length, 1);
});

test('the composer and its passes stay out of the drawable walk', async () => {
  const { container, scene } = makeContainer();
  await render(
    container,
    h(
      React.Fragment,
      null,
      h('mesh', {}),
      h('effectComposer', {}, h('bloomPass', { threshold: 0.5 })),
    ),
  );
  const composer = scene.children.find(
    (child): child is EffectComposer =>
      (child as EffectComposer).isComposer === true,
  );
  assert.ok(composer);
  assert.equal(composer.isObject3D, false, 'the render walk steps over it');
  assert.equal(composer.passes.length, 1);
  assert.ok(composer.passes[0] instanceof BloomPass);
  assert.equal((composer.passes[0] as BloomPass).threshold, 0.5);
});

test('raycast hits the mesh a rendered frame recorded', async () => {
  const { container, scene, store } = makeContainer();
  await render(
    container,
    h(
      'mesh',
      { onClick: () => {} },
      h('boxGeometry', { args: [1, 1, 1] }),
      h('meshPhongMaterial', {}),
    ),
  );
  // record world matrices the way a frame does, against a null GL: the
  // indirect renderer only reads constants off gl, so a proxy that answers
  // numbers is enough here
  const gl = new Proxy({}, { get: () => () => 1 }) as ConstructorParameters<
    typeof Proxy
  >[0];
  const renderer = new IndirectRenderer();
  const camera = store.getState().camera;
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  renderer.render(gl, scene, camera, { width: 200, height: 200 });

  const hits = raycast(scene.children, 100, 100, renderer.camera!);
  assert.equal(hits.length, 1, 'the centre pixel hits the unit box');
  assert.ok(Math.abs(hits[0].point[2] - 0.5) < 1e-3, 'on the near face');
  const miss = raycast(scene.children, 3, 3, renderer.camera!);
  assert.equal(miss.length, 0, 'a corner pixel misses');
});

test('standardToPhong maps roughness/metalness identically for both backends', () => {
  const rough = new MeshStandardMaterial({ color: 'white', roughness: 1 });
  const phongy = standardToPhong(rough);
  assert.ok(phongy.shininess <= 1.01, 'fully rough is matte');
  assert.equal(phongy.diffuseScale, 1, 'dielectric keeps its diffuse');

  const metal = new MeshStandardMaterial({
    color: '#ffcc00',
    roughness: 0.2,
    metalness: 1,
  });
  const shiny = standardToPhong(metal);
  assert.ok(shiny.shininess > 40, 'polished metal gets a tight highlight');
  assert.ok(shiny.diffuseScale < 0.5, 'metal scatters little diffusely');
  assert.ok(
    shiny.specular[0] > shiny.specular[2],
    'the highlight is tinted by the base colour',
  );
});

test('shader material uniforms wrap bare values so mutation works', () => {
  const material = new ShaderMaterial({
    fragmentShader: 'void main() {}',
    uniforms: { uTime: 0, uColor: { value: [1, 0, 0] } },
  });
  material.uniforms.uTime.value = 4;
  assert.equal(material.uniforms.uTime.value, 4);
  assert.deepEqual(material.uniforms.uColor.value, [1, 0, 0]);
});

test('Vector3 and Color speak enough three.js', () => {
  const v = new Vector3(3, 0, 4);
  assert.equal(v.length(), 5);
  v.normalize().multiplyScalar(10);
  assert.ok(Math.abs(v.x - 6) < 1e-6 && Math.abs(v.z - 8) < 1e-6);
  const c = new Color(0x336699);
  assert.ok(Math.abs(c.r - 0x33 / 255) < 1e-6);
  assert.ok(Math.abs(c.b - 0x99 / 255) < 1e-6);
  c.set('rgba(255, 0, 0, 0.5)');
  assert.equal(c.r, 1);
  assert.equal(c._alpha, 0.5, 'CSS alpha rides along for the material');
});
