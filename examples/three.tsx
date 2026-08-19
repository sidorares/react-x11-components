/** @jsxImportSource @react-x11/components/three */
// Run with: npm run examples:three   (needs an X server / DISPLAY, and a
// `npm run build` first — the pragma above resolves this package's own
// exports map, which is how the scene elements get their full r3f-shaped
// typings while react-x11 core still declares its own.)
//
// A react-three-fiber-shaped scene that picks the best GL backend the
// server offers: `glPolicy: 'auto'` uses direct rendering (GPU, shaders)
// where DRI3 and the x11-dri addon exist, and indirect GLX (display lists
// over the wire) anywhere else — the same JSX renders on both, and the
// status line says which one you got.
//
// The r3f idioms on show: `useFrame` mutating through a ref (no re-render
// per frame), pointer events raycast against the geometry, a
// `<meshStandardMaterial>` tutorial-style, `<color attach="background">`,
// and a `<shaderMaterial>` that degrades to Phong where shaders cannot
// exist. On Xwayland or Xorg without `+iglx` and without DRI3 there is no
// GL at all — that lands in `fallback`.
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Switch, createRoot, useSupports } from 'react-x11';

import { Canvas, useFrame } from '../src/index.js';
import type { Mesh, Group, RootState, ThreeEvent } from '../src/index.js';

/** The one shader: bands of the base colour, swept by time — the kind of
 * surface the fixed-function pipeline cannot express at all. */
const BANDS_FRAGMENT = `
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3 uColor;
  void main() {
    float wave = 0.55 + 0.45 * sin(vUv.x * 24.0 + uTime * 2.0);
    gl_FragColor = vec4(uColor * wave, 1.0);
  }
`;
const BANDS_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Time into the one animated uniform, r3f's way: mutate, never re-render. */
function Bands({ spinning }: { spinning: boolean }): ReactElement {
  const material = useRef<{ uniforms: { uTime: { value: number } } }>(null);
  useFrame((state) => {
    if (spinning && material.current) {
      material.current.uniforms.uTime.value = state.clock.elapsedTime;
    }
  });
  return (
    <mesh position={[0, -1.6, 0]} rotation={[-Math.PI / 2.6, 0, 0]}>
      <planeGeometry args={[5.4, 1.6]} />
      <shaderMaterial
        ref={material as never}
        vertexShader={BANDS_VERTEX}
        fragmentShader={BANDS_FRAGMENT}
        uniforms={{ uTime: 0, uColor: [0.2, 0.6, 1.0] }}
      />
    </mesh>
  );
}

function Shapes({
  spinning,
  wireframe,
  onPick,
}: {
  spinning: boolean;
  wireframe: boolean;
  onPick: (name: string | null) => void;
}): ReactElement {
  const rig = useRef<Group>(null);
  const ball = useRef<Mesh>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  useFrame((_state: RootState, delta: number) => {
    if (!spinning) return;
    if (rig.current) rig.current.rotation.y += delta * 0.6;
    if (ball.current) {
      ball.current.position.y =
        0.4 + Math.abs(Math.sin(_state.clock.elapsedTime * 2)) * 0.9;
    }
  });

  const pointer = (name: string) => ({
    cursor: 'pointer',
    onPointerOver: () => setHovered(name),
    onPointerOut: () =>
      setHovered((current) => (current === name ? null : current)),
    onClick: (event: ThreeEvent) => {
      event.stopPropagation();
      onPick(name);
    },
  });
  const lift = (name: string) => (hovered === name ? 1.12 : 1);

  return (
    <group ref={rig}>
      <mesh
        position={[-1.7, 0.2, 0]}
        rotation={[0.5, 0.4, 0]}
        scale={lift('box')}
        {...pointer('box')}
      >
        <boxGeometry args={[1.3, 1.3, 1.3]} />
        <meshStandardMaterial
          color={hovered === 'box' ? '#f1c40f' : '#2980b9'}
          roughness={0.35}
          metalness={0.2}
          wireframe={wireframe}
        />
      </mesh>
      <mesh
        ref={ball}
        position={[1.7, 0.4, 0]}
        scale={lift('ball')}
        {...pointer('ball')}
      >
        <sphereGeometry args={[0.8, 24, 16]} />
        <meshPhongMaterial
          color={hovered === 'ball' ? '#f1c40f' : '#e67e22'}
          shininess={40}
          wireframe={wireframe}
        />
      </mesh>
      <mesh position={[0, 0.1, -0.6]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.05, 0.26, 12, 36]} />
        <meshLambertMaterial color="#27ae60" wireframe={wireframe} />
      </mesh>
    </group>
  );
}

/** Xwayland and stock Xorg have indirect GLX off, and without DRI3 there is
 * no direct backend either — this is what that machine shows. */
function NoGL({ error }: { error: Error & { hint?: string } }): ReactElement {
  return (
    <box
      style={{
        flexGrow: 1,
        padding: 20,
        gap: 10,
        justifyContent: 'center',
        backgroundColor: '#12161f',
      }}
    >
      <text style={{ fontSize: 15, color: '#e8ecf1' }}>
        No GL on this X server
      </text>
      <text style={{ fontSize: 12, color: '#9aa7b4' }}>{error.message}</text>
      {error.hint ? (
        <text style={{ fontSize: 11, color: '#6f7d8c' }}>{error.hint}</text>
      ) : null}
    </box>
  );
}

function App(): ReactElement {
  const [spinning, setSpinning] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [backend, setBackend] = useState<string>('…');
  // shaders exist only on the direct backend; the scene degrades rather
  // than fails where they cannot. [react-x11 gap] useSupports('shaders')
  // reports capability, not the effective policy — NTK_GL_POLICY=indirect
  // on a DRI3-capable box still answers true — so the context's own
  // backend settles it before the shader plane mounts.
  const shaders = useSupports('shaders') && backend === 'direct';

  return (
    <window width={620} height={520} title="react-x11 components — three">
      <box
        style={{
          flexGrow: 1,
          padding: 12,
          gap: 12,
          backgroundColor: '#1a1f2a',
        }}
      >
        <Canvas
          style={{ flexGrow: 1 }}
          glx={{ DEPTH_SIZE: 24 }}
          camera={{ position: [0, 2.4, 7.5], target: [0, -0.3, 0], fov: 45 }}
          frameloop="demand"
          onCreated={(state: RootState) => setBackend(state.backend ?? '?')}
          onPointerMissed={() => setPicked(null)}
          fallback={(error: Error) => <NoGL error={error} />}
        >
          <color attach="background" args={['#12161f']} />
          <ambientLight intensity={0.35} />
          <pointLight position={[5, 6, 6]} intensity={1} />
          <directionalLight
            position={[-6, 2, 3]}
            intensity={0.4}
            color="#9ecbff"
          />
          <Shapes
            spinning={spinning}
            wireframe={wireframe}
            onPick={setPicked}
          />
          {shaders ? (
            <Bands spinning={spinning} />
          ) : (
            <mesh position={[0, -1.6, 0]} rotation={[-Math.PI / 2.6, 0, 0]}>
              <planeGeometry args={[5.4, 1.6]} />
              <meshPhongMaterial color="#2f5c8f" />
            </mesh>
          )}
        </Canvas>

        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Switch checked={spinning} onChange={(ev) => setSpinning(ev.value)} />
          <text style={{ fontSize: 13, color: '#e8ecf1' }}>Spin</text>
          <Switch
            checked={wireframe}
            onChange={(ev) => setWireframe(ev.value)}
          />
          <text style={{ fontSize: 13, color: '#e8ecf1' }}>Wireframe</text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ fontSize: 13, color: '#9aa7b4' }}>
            {picked ? `picked: ${picked}` : 'click a shape'}
          </text>
          <text style={{ fontSize: 13, color: '#6f7d8c' }}>
            backend: {backend}
            {backend !== '…' && !shaders ? ' (no shaders)' : ''}
          </text>
          <Button onPress={() => setSpinning((s) => !s)}>
            {spinning ? 'Pause' : 'Play'}
          </Button>
        </box>
      </box>
    </window>
  );
}

const root = await createRoot({ glPolicy: 'auto' });
root.render(<App />);
