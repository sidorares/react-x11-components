# Three

A [react-three-fiber](https://docs.pmnd.rs/react-three-fiber)-shaped 3D
scene graph, drawn through whichever OpenGL backend the connection has.

```jsx
import { Canvas, useFrame } from '@react-x11/components/three';

function SpinningBox() {
  const ref = useRef(null);
  useFrame((state, delta) => {
    ref.current.rotation.y += delta;
  });
  return (
    <mesh ref={ref} position={[0, 0.5, 0]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="hotpink" />
    </mesh>
  );
}

<Canvas camera={{ position: [3, 3, 6], fov: 50 }} style={{ flexGrow: 1 }}>
  <ambientLight intensity={0.4} />
  <pointLight position={[5, 6, 6]} />
  <SpinningBox />
</Canvas>;
```

If that looks like a react-three-fiber component, that is the design goal:
the element names, the prop shapes (`args`, `position`, tuples, CSS or hex
colours), `attach`, dashed paths like `position-x`, refs that hand out
mutable objects, `useFrame`/`useThree`, pointer events on meshes, and
`extend()` all follow r3f, so a component written for it ports with its
structure intact. What differs is underneath: there is no three.js and no
WebGL — the scene renders through react-x11's `<glarea>`, over one of two
pipelines.

## The two backends

|                 | **indirect** (GLX)                                                 | **direct** (DRI3)                                    |
| --------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| how it draws    | GL 1.x commands encoded into the X connection                      | OpenGL ES 2 on the GPU, frames as dma-bufs           |
| reaches         | any server that allows indirect contexts, including over a network | a local Linux server with DRI3 + the `x11-dri` addon |
| geometry        | compiled into server-side display lists, once                      | vertex buffers on the GPU, once                      |
| lighting        | per vertex, 8 fixed-function light units                           | per fragment (same 8-light cap, so scenes match)     |
| shaders         | none — the protocol encodes no shader objects                      | **yes** — `<shaderMaterial>`, GLSL ES 1.00           |
| post-processing | none — no framebuffer objects to encode                            | **yes** — `<effectComposer>` and passes              |

**The scene graph is identical**; the indirect feature set is a subset of
the direct one. Ask for the best available at the root and the same JSX
renders on both:

```jsx
const root = await createRoot({ glPolicy: 'auto' });
```

`'auto'` uses direct rendering where it is available and indirect otherwise —
which is usually what you want, since most modern desktops ship with
indirect GLX **off** (Xorg ≥ 1.17, Xwayland), and those are exactly the
machines where direct works. react-x11's default policy is `'indirect'`;
one run can be switched without touching code via `NTK_GL_POLICY=auto`.

The two direct-only element families throw at creation, naming the reason,
rather than rendering a blank surface. A scene that would rather degrade
branches first:

```jsx
const shaders = useThree((s) => s.supportsShaders); // or useSupports('shaders')
{
  shaders ? (
    <shaderMaterial {...glsl} />
  ) : (
    <meshPhongMaterial color="#e0533d" />
  );
}
```

## `<Canvas>`

| prop              | meaning                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `style`           | layout, as any drawn element takes it                                                     |
| `camera`          | partial settings for the default camera: `{ position, fov, near, far, zoom, up, target }` |
| `orthographic`    | an orthographic default camera                                                            |
| `frameloop`       | `'demand'` (default) / `'always'` / `'never'` — see below                                 |
| `clearColor`      | CSS colour or `[r, g, b, a]`; `<color attach="background" />` wins over it                |
| `glx`             | visual spec, e.g. `{ DEPTH_SIZE: 24 }`                                                    |
| `fallback`        | element or `(error) => element`, shown when the connection has no GL at all               |
| `onCreated`       | `(state) => void`, once the context exists                                                |
| `onPointerMissed` | a press that hit no object                                                                |
| `onDraw`          | raw GL after the scene draws — branch on `gl.backend`                                     |

The name is `Canvas`, as in r3f — the lowercase `<canvas>` host element is
core's 2D escape hatch and JSX keeps them apart.

**`frameloop` differs from r3f in one deliberate way.** r3f renders
continuously by default; a desktop toolkit should not, so the default here
is `'demand'`: render on commits, resizes, exposes and `invalidate()`.
Subscribing to `useFrame` switches the surface to continuous rendering
while mounted — which is why ported r3f components animate without asking —
and prop-driven changes redraw on their own. An imperative mutation from an
event handler (`ref.current.position.x = 2`) lands through the object's own
change hooks too; `useThree((s) => s.invalidate)` is the explicit valve.

## Elements

Objects: `<group>`, `<mesh>`, `<points>`, `<line>`, `<lineSegments>`,
`<lineLoop>`, `<instancedMesh instances={[…]}>`, `<primitive object={…}>`.

Geometries (three.js `args`): `<boxGeometry>`, `<planeGeometry>`,
`<sphereGeometry>`, `<cylinderGeometry>`, `<coneGeometry>`,
`<torusGeometry>`, and `<bufferGeometry position={…} normal={…} uv={…}
index={…}>` for explicit arrays. Changing `args` rebuilds the shape in
place — refs stay valid, and the renderers re-upload once.

Materials: `<meshBasicMaterial>` (unlit), `<meshLambertMaterial>`,
`<meshPhongMaterial>`, `<meshStandardMaterial>`, `<pointsMaterial>`,
`<lineBasicMaterial>`, and — direct backend only — `<shaderMaterial>` /
`<rawShaderMaterial>` with three.js's prelude declared for you and
`uniforms` in the `{ name: { value } }` shape
(`material.uniforms.uTime.value = t` animates without a recompile).

Lights: `<ambientLight>`, `<directionalLight>`, `<pointLight>`,
`<spotLight>` — eight-unit cap on both backends, `<ambientLight>` costs no
unit.

Cameras: the default one, adjusted through the `camera` prop, or
`<perspectiveCamera makeDefault>` / `<orthographicCamera makeDefault>`.

Post-processing (direct only): `<effectComposer>` holding `<bloomPass>`,
`<vignettePass>`, `<fxaaPass>`, `<shaderPass>` — the scene renders to a
texture and the passes run in tree order, last one to the window. There is
no `<renderPass>`: the surface's own scene is always the input.
`examples/three-effects.tsx` runs the whole stack with each pass's
`enabled` on a switch.

`extend({ MyThing })` teaches the reconciler new classes, r3f's way:
`<myThing args={[…]} />`.

## Hooks

`useThree()` — or `useThree(selector)` — reads the canvas state:
`{ gl, backend, scene, camera, size, viewport, clock, supportsShaders,
invalidate }`. `useFrame((state, delta) => …, priority?)` runs on every
frame of the enclosing canvas, before the scene draws; mutate what refs
hold and the frame being drawn has it.

## Events

`onClick`, `onPointerDown/Up/Move/Over/Out` on any object, raycast on the
CPU against the same arrays the geometry was uploaded from — no GPU
picking, no round trips. Only objects that (or whose ancestors) carry
handlers are tested, and X pointer events are only selected on the window
once something listens. `cursor="pointer"` on a hovered object sets the
window cursor. `onPointerMissed` on the canvas catches presses that hit
nothing.

## TypeScript

The scene vocabulary is typed twice over, because react-x11 core still
declares its own (narrower) 3D element types until its scene graph is
removed:

- Plain JSX works today with core's declarations for the shared names, plus
  this package's for the new ones (`<primitive>`, the cameras, `<color>`,
  `<coneGeometry>`, `<meshStandardMaterial>`).
- For the full r3f-shaped typings — refs to the mutable classes, `attach`,
  dashed props — put the pragma at the top of a scene-heavy file:

```tsx
/** @jsxImportSource @react-x11/components/three */
```

It is runtime-identical to the default JSX source; only the types change.
When core's 3D vocabulary is gone, the default namespace picks these
typings up and the pragma stops being necessary.

## Honest edges

- **`<meshStandardMaterial>` is an approximation.** `roughness`/`metalness`
  are mapped onto Blinn-Phong terms — identically on both backends — so
  tutorial scenes render sensibly, not physically.
- **The camera is position/target/up.** `camera.lookAt(…)` works;
  writing to a camera's `rotation` does not (no quaternions anywhere in the
  fixed subset).
- **`<instancedMesh>` is declarative** — an `instances` array instead of
  `setMatrixAt`. What it saves is the geometry; each instance still costs a
  transform and a draw, since neither backend does GPU instancing.
- **No loaders.** `useLoader`, GLTF, textures-from-URL are three.js
  machinery; `map` takes an ntk `Image` or any `{ width, height, data }`
  RGBA bytes.
- **Removed props keep their value** rather than resetting to a default
  (write the value you want, or key the element).

## Why this lives here, and how

Core's `<glarea>` owns everything that is renderer internals — the child X
window on a GL visual, the context, the frame clock, the swap. This module
is composition over that public element: a second react-reconciler renders
the scene children into mutable objects (that is what makes `args`,
`attach` and mutation-by-ref _possible_), and a per-backend renderer walks
them from inside `<glarea onDraw>` — display lists over indirect GLX,
buffers and generated GLSL over direct GL. The AGENTS.md "boundary runs
through a feature" section is this exact worked example.
