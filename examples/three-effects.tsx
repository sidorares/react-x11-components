/** @jsxImportSource @react-x11/components/three */
// Run with: npm run examples:three-effects   (needs an X server / DISPLAY,
// and a `npm run build` first — see examples/three.tsx for why.)
//
// The direct-only side of the scene graph: `<effectComposer>` and its
// passes, which exist only where there are framebuffer objects to render
// into — a DRI3 connection with the x11-dri addon. The GLX protocol
// encodes no FBOs, so on an indirect connection this example keeps the
// scene and drops the composer, saying so in the status line; the branch
// is the `useSupports('shaders')` one the docs name for degrading scenes.
//
// On show: `<bloomPass>` fed by an unlit "core" that outshines the
// threshold, a custom `<shaderPass>` (rolling scanlines animated through
// the `time` uniform the composer sets when a pass declares it),
// `<vignettePass>`, `<fxaaPass>`, and each pass's `enabled` prop wired to
// a switch — toggling composes live, no re-upload, no remount.
import { useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Switch, createRoot, useSupports } from 'react-x11';

import { Canvas, useFrame } from '../src/index.js';
import type { Group, InstanceSpec, RootState } from '../src/index.js';

/** Full-screen pass over the composed image: rolling CRT-ish scanlines.
 * `tDiffuse` and `vUv` are declared by the pass author, three.js-style;
 * `time` is set by the composer because the shader declares it. */
const SCANLINES_FRAGMENT = `
  uniform sampler2D tDiffuse;
  uniform float time;
  varying vec2 vUv;
  void main() {
    vec3 color = texture2D(tDiffuse, vUv).rgb;
    float line = sin(vUv.y * 220.0 - time * 4.0);
    color *= 0.86 + 0.14 * line;
    gl_FragColor = vec4(color, 1.0);
  }
`;

function Rig({ spinning }: { spinning: boolean }): ReactElement {
  const ring = useRef<Group>(null);
  const halo = useRef<Group>(null);
  useFrame((state, delta) => {
    if (!spinning) return;
    if (ring.current) ring.current.rotation.y += delta * 0.7;
    if (halo.current) {
      halo.current.rotation.z = state.clock.elapsedTime * 0.4;
    }
  });

  // eight satellites on a ring — one geometry upload, eight transforms
  const satellites = useMemo<InstanceSpec[]>(
    () =>
      Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        return {
          position: [Math.cos(angle) * 2.3, 0, Math.sin(angle) * 2.3],
          rotation: [0, -angle, 0],
          scale: 0.26,
          color: i % 2 ? '#39d98a' : '#4f7cff',
        };
      }),
    [],
  );

  return (
    <group ref={ring}>
      {/* unlit, so it renders at full brightness — the bloom source */}
      <mesh>
        <sphereGeometry args={[0.72, 32, 24]} />
        <meshBasicMaterial color="#ffd9a0" />
      </mesh>
      <group ref={halo}>
        <mesh rotation={[Math.PI / 2.4, 0, 0]}>
          <torusGeometry args={[1.45, 0.16, 12, 48]} />
          <meshPhongMaterial color="#7a5cff" shininess={60} />
        </mesh>
      </group>
      <instancedMesh instances={satellites}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial color="#39d98a" />
      </instancedMesh>
    </group>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}): ReactElement {
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Switch checked={value} onChange={(ev) => onChange(ev.value)} />
      <text style={{ fontSize: 13, color: '#e8ecf1' }}>{label}</text>
    </box>
  );
}

function App(): ReactElement {
  const [spinning, setSpinning] = useState(true);
  const [bloom, setBloom] = useState(true);
  const [scanlines, setScanlines] = useState(true);
  const [vignette, setVignette] = useState(true);
  const [fxaa, setFxaa] = useState(true);
  const [backend, setBackend] = useState('…');
  // FBOs exist only on the direct backend; an indirect connection keeps
  // the scene and loses the composer (mounting it there would throw).
  // [react-x11 gap] useSupports('shaders') alone is not enough: it reports
  // the machine's capability, so `NTK_GL_POLICY=indirect` on a DRI3-capable
  // box still answers true. The context's own backend settles it.
  const post = useSupports('shaders') && backend === 'direct';

  return (
    <window
      width={720}
      height={560}
      title="react-x11 components — three effects"
    >
      <box
        style={{
          flexGrow: 1,
          padding: 12,
          gap: 12,
          backgroundColor: '#141925',
        }}
      >
        <Canvas
          style={{ flexGrow: 1 }}
          glx={{ DEPTH_SIZE: 24 }}
          camera={{ position: [0, 2.4, 7], target: [0, 0, 0], fov: 45 }}
          frameloop="demand"
          onCreated={(state: RootState) => setBackend(state.backend ?? '?')}
          fallback={(error: Error) => (
            <box
              style={{
                flexGrow: 1,
                padding: 20,
                gap: 8,
                justifyContent: 'center',
                backgroundColor: '#0b0e14',
              }}
            >
              <text style={{ fontSize: 15, color: '#e8ecf1' }}>
                No GL on this X server
              </text>
              <text style={{ fontSize: 12, color: '#9aa7b4' }}>
                {error.message}
              </text>
            </box>
          )}
        >
          <color attach="background" args={['#0b0e14']} />
          <ambientLight intensity={0.22} />
          {/* the light sits where the core is — everything is lit from it */}
          <pointLight position={[0, 0, 0]} intensity={1.1} />
          <directionalLight position={[-5, 4, 6]} intensity={0.25} />
          <Rig spinning={spinning} />
          {post ? (
            <effectComposer>
              <bloomPass
                enabled={bloom}
                threshold={0.55}
                strength={1.0}
                radius={1.2}
              />
              <shaderPass
                enabled={scanlines}
                fragmentShader={SCANLINES_FRAGMENT}
              />
              <vignettePass enabled={vignette} offset={0.42} darkness={0.62} />
              <fxaaPass enabled={fxaa} />
            </effectComposer>
          ) : null}
        </Canvas>

        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Toggle label="Spin" value={spinning} onChange={setSpinning} />
          <Toggle label="Bloom" value={bloom} onChange={setBloom} />
          <Toggle label="Scanlines" value={scanlines} onChange={setScanlines} />
          <Toggle label="Vignette" value={vignette} onChange={setVignette} />
          <Toggle label="FXAA" value={fxaa} onChange={setFxaa} />
          <box style={{ flexGrow: 1 }} />
          <text style={{ fontSize: 13, color: '#6f7d8c' }}>
            {post
              ? `backend: ${backend}`
              : `backend: ${backend} — no FBOs, composer skipped`}
          </text>
        </box>
      </box>
    </window>
  );
}

const root = await createRoot({ glPolicy: 'auto' });
root.render(<App />);
