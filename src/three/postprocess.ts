// `<effectComposer>` — the scene drawn into a texture, then through a chain
// of full-screen passes. A port of react-x11's `src/postprocess3d.js`.
//
// Everything else in the 3D tree draws *to the window*. Post-processing is
// the one thing that cannot: an effect that reads the image it is modifying
// needs the image to exist somewhere it can be sampled, which means a
// framebuffer object with a texture attached. That single requirement is why
// this is direct-only — the GLX protocol has no FBOs to encode.
//
// Two full-size colour targets ping-pong — read one, write the other,
// swap — and the last pass writes framebuffer 0, the buffer that gets
// presented. A pass never reads the target it is writing, which is
// undefined behaviour in every GL there has ever been.
/* The one file-wide `any`: the GL façade (camelCase ES 2). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GL = any;

import type { DirectRenderer, CompiledProgram } from './renderer-direct.js';
import type { EffectComposer, Pass, ShaderPass } from './passes.js';
import { BloomPass, VignettePass } from './passes.js';
import { now } from './globals.js';

/**
 * Post shaders run at `highp`, both stages: `varying vec2 vUv` is declared
 * by our vertex shader and again by the pass's fragment shader (that is how
 * three.js's post shaders are written), and GLSL ES fails to link when the
 * two precisions disagree. `mediump` guarantees only ~10 bits, which at
 * 1080p is coarser than a texel — visible as stair-stepping in any blur.
 */
const PRECISION = 'precision highp float;\n';

/**
 * The full-screen triangle strip, in clip space. No uv attribute: the quad
 * covers exactly [-1, 1], so the vertex shader derives the coordinate free.
 */
const QUAD_VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

const QUAD_VERTEX_SHADER = `${PRECISION}attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

/** Hand the image on unchanged — the last pass of a chain that went wrong. */
const COPY_SHADER = `uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tDiffuse, vUv);
}`;

const VIGNETTE_SHADER = `uniform sampler2D tDiffuse;
uniform float offset;
uniform float darkness;
varying vec2 vUv;
void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  // 0 at the centre, 1 in the corners
  float d = distance(vUv, vec2(0.5)) * 1.41421356;
  float v = smoothstep(offset, 1.0, d);
  gl_FragColor = vec4(texel.rgb * (1.0 - v * darkness), texel.a);
}`;

// FXAA, the reduced form: find the local luma gradient from four diagonal
// neighbours, then blend along it. Worth having because the direct backend
// has no multisampling — an FBO with an MSAA attachment is an ES 3 feature —
// so this is the only antialiasing a composed scene can get.
const FXAA_SHADER = `uniform sampler2D tDiffuse;
uniform vec2 texelSize;
varying vec2 vUv;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float SPAN_MAX = 8.0;
const float REDUCE_MUL = 0.125;
const float REDUCE_MIN = 0.0078125;

void main() {
  vec3 nw = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * texelSize).rgb;
  vec3 ne = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * texelSize).rgb;
  vec3 sw = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * texelSize).rgb;
  vec3 se = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * texelSize).rgb;
  vec4 texel = texture2D(tDiffuse, vUv);

  float lumaNW = dot(nw, LUMA);
  float lumaNE = dot(ne, LUMA);
  float lumaSW = dot(sw, LUMA);
  float lumaSE = dot(se, LUMA);
  float lumaM = dot(texel.rgb, LUMA);
  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

  // the edge runs perpendicular to the luma gradient
  vec2 dir = vec2(
    -((lumaNW + lumaNE) - (lumaSW + lumaSE)),
     ((lumaNW + lumaSW) - (lumaNE + lumaSE))
  );
  float reduce = max(
    (lumaNW + lumaNE + lumaSW + lumaSE) * 0.25 * REDUCE_MUL,
    REDUCE_MIN
  );
  float scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * scale, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * texelSize;

  vec3 inner = 0.5 * (
    texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
  );
  vec3 outer = inner * 0.5 + 0.25 * (
    texture2D(tDiffuse, vUv - dir * 0.5).rgb +
    texture2D(tDiffuse, vUv + dir * 0.5).rgb
  );
  // the wider blend overshot the local range, so keep the narrow one
  float lumaOuter = dot(outer, LUMA);
  vec3 color = (lumaOuter < lumaMin || lumaOuter > lumaMax) ? inner : outer;
  gl_FragColor = vec4(color, texel.a);
}`;

const BLOOM_BRIGHT_SHADER = `uniform sampler2D tDiffuse;
uniform float threshold;
varying vec2 vUv;
void main() {
  vec3 color = texture2D(tDiffuse, vUv).rgb;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  // a soft knee rather than a step, so a surface drifting past the
  // threshold brightens gradually instead of popping on
  float keep = smoothstep(threshold, threshold + 0.15, luma);
  gl_FragColor = vec4(color * keep, 1.0);
}`;

// A separable nine-tap Gaussian sampled at five points: each off-centre tap
// sits between two texels and lets the bilinear filter average them, which
// is nine texels' worth of blur for five fetches.
const BLOOM_BLUR_SHADER = `uniform sampler2D tDiffuse;
uniform vec2 direction;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  sum += (texture2D(tDiffuse, vUv + direction * 1.3846153846).rgb +
          texture2D(tDiffuse, vUv - direction * 1.3846153846).rgb) * 0.3162162162;
  sum += (texture2D(tDiffuse, vUv + direction * 3.2307692308).rgb +
          texture2D(tDiffuse, vUv - direction * 3.2307692308).rgb) * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

const BLOOM_COMPOSITE_SHADER = `uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float strength;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  gl_FragColor = vec4(base.rgb + texture2D(tBloom, vUv).rgb * strength, base.a);
}`;

/** Single-shader passes: one program, one draw, fields straight to uniforms. */
const SIMPLE_PASSES: Record<
  string,
  {
    fragmentShader: string;
    uniforms: (gl: GL, program: CompiledProgram, pass: Pass) => void;
  }
> = {
  vignettePass: {
    fragmentShader: VIGNETTE_SHADER,
    uniforms(gl, program, pass) {
      const vignette = pass as VignettePass;
      gl.uniform1f(program.uniform('offset'), vignette.offset);
      gl.uniform1f(program.uniform('darkness'), vignette.darkness);
    },
  },
  fxaaPass: {
    fragmentShader: FXAA_SHADER,
    // `texelSize` is one of the uniforms every pass gets
    uniforms() {},
  },
};

/** The GL a render target needs, beyond what drawing a mesh needs. */
const FBO_ENTRY_POINTS = [
  'createFramebuffer',
  'bindFramebuffer',
  'framebufferTexture2D',
  'createRenderbuffer',
  'bindRenderbuffer',
  'renderbufferStorage',
  'framebufferRenderbuffer',
  'checkFramebufferStatus',
  'deleteFramebuffer',
  'deleteRenderbuffer',
];

const half = (n: number) => Math.max(1, n >> 1);

interface RenderTarget {
  framebuffer: unknown;
  texture: unknown;
  depth: unknown;
  width: number;
  height: number;
}

interface FrameInfo {
  width: number;
  height: number;
}

/**
 * The pass chain for one surface: its render targets, its programs and the
 * full-screen quad they all draw. Owned by the canvas, which lends it the
 * direct renderer — so a pass that will not build is reported exactly the
 * way a material that will not build is, and `<shaderPass uniforms>` takes
 * exactly what `<shaderMaterial uniforms>` takes.
 */
export class PostProcessor {
  private owner: DirectRenderer;
  private targets: (RenderTarget | null)[] = [null, null];
  private bloom: (RenderTarget | null)[] = [null, null];
  private width = 0;
  private height = 0;
  private programs = new Map<string, { program: unknown } | CompiledProgram>();
  private quad: unknown = null;
  private passes: Pass[] | null = null;
  private read = 0;
  private startedAt: number | null = null;
  private _usable: boolean | undefined;

  constructor(owner: DirectRenderer) {
    this.owner = owner;
  }

  /**
   * Bind the scene's render target, so the surface's clear and the scene's
   * draws land in a texture. False means "draw straight to the window" —
   * because there is nothing to compose, or because something is missing —
   * and is the answer the caller acts on.
   */
  begin(gl: GL, info: FrameInfo, composer: EffectComposer): boolean {
    this.passes = null;
    const passes = composer.enabled
      ? composer.passes.filter((pass) => pass.enabled)
      : [];
    if (passes.length === 0) return false;
    if (!this.usable(gl)) return false;
    if (!this.ensureTargets(gl, info.width, info.height)) return false;

    this.passes = passes;
    this.read = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0]!.framebuffer);
    return true;
  }

  /**
   * Run the chain. Each pass reads the target the previous one wrote; the
   * last writes framebuffer 0, which is what `SwapBuffers` presents.
   */
  end(gl: GL, info: FrameInfo): boolean {
    const passes = this.passes;
    this.passes = null;
    if (!passes) return false;

    // a full-screen quad is not part of the scene: nothing occludes it,
    // nothing culls it, and it replaces rather than blends with what is there
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(false);

    for (let i = 0; i < passes.length; i++) {
      const last = i === passes.length - 1;
      const source = this.targets[this.read]!;
      const target = last ? null : this.targets[this.read ^ 1];
      this.runPass(gl, passes[i], source, target, info);
      if (!last) this.read ^= 1;
    }

    // hand the context back as the scene expects to find it
    gl.bindFramebuffer(gl.FRAMEBUFFER, 0);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    return true;
  }

  private runPass(
    gl: GL,
    pass: Pass,
    source: RenderTarget,
    target: RenderTarget | null,
    info: FrameInfo,
  ): void {
    if (pass instanceof BloomPass) {
      this.bloomPass(gl, pass, source, target, info);
      return;
    }
    const program = this.programFor(gl, pass);
    // A pass whose shader will not build hands the image on unchanged. The
    // alternative is a frame of whatever was last in the target, which reads
    // as a corrupt renderer rather than as one broken effect.
    if (!program) {
      this.copy(gl, source, target, info);
      return;
    }

    this.bindTarget(gl, target, info);
    gl.useProgram(program.program);
    this.bindSource(gl, program, 'tDiffuse', source, 0);
    this.commonUniforms(gl, program, info);
    const simple = SIMPLE_PASSES[pass.kind];
    if (simple) simple.uniforms(gl, program, pass);
    else this.userUniforms(gl, program, pass as ShaderPass);
    this.drawQuad(gl, program);
  }

  /**
   * Bright pass, blur across, blur down, composite — four draws, the middle
   * two at half resolution. Blurring at half size is both cheaper and wider:
   * the same kernel covers twice as many source pixels.
   */
  private bloomPass(
    gl: GL,
    pass: BloomPass,
    source: RenderTarget,
    target: RenderTarget | null,
    info: FrameInfo,
  ): void {
    const bright = this.programFor(gl, pass, 'bright', BLOOM_BRIGHT_SHADER);
    const blur = this.programFor(gl, pass, 'blur', BLOOM_BLUR_SHADER);
    const composite = this.programFor(
      gl,
      pass,
      'composite',
      BLOOM_COMPOSITE_SHADER,
    );
    const scratch = this.ensureBloom(gl, info.width, info.height);
    if (!bright || !blur || !composite || !scratch) {
      this.copy(gl, source, target, info);
      return;
    }

    const radius = pass.radius;

    this.bindTarget(gl, scratch[0], info);
    gl.useProgram(bright.program);
    this.bindSource(gl, bright, 'tDiffuse', source, 0);
    gl.uniform1f(bright.uniform('threshold'), pass.threshold);
    this.drawQuad(gl, bright);

    // separable: across the half-size target, then down it
    gl.useProgram(blur.program);
    for (const [from, to, direction] of [
      [0, 1, [radius / scratch[0].width, 0]],
      [1, 0, [0, radius / scratch[0].height]],
    ] as const) {
      this.bindTarget(gl, scratch[to], info);
      this.bindSource(gl, blur, 'tDiffuse', scratch[from], 0);
      gl.uniform2fv(blur.uniform('direction'), new Float32Array(direction));
      this.drawQuad(gl, blur);
    }

    this.bindTarget(gl, target, info);
    gl.useProgram(composite.program);
    this.bindSource(gl, composite, 'tDiffuse', source, 0);
    this.bindSource(gl, composite, 'tBloom', scratch[0], 1);
    gl.uniform1f(composite.uniform('strength'), pass.strength);
    this.drawQuad(gl, composite);
  }

  /** The image, unchanged, into `target` — a pass that could not run. */
  private copy(
    gl: GL,
    source: RenderTarget,
    target: RenderTarget | null,
    info: FrameInfo,
  ): void {
    const program = this.programFor(gl, COPY_PASS);
    if (!program) return;
    this.bindTarget(gl, target, info);
    gl.useProgram(program.program);
    this.bindSource(gl, program, 'tDiffuse', source, 0);
    this.drawQuad(gl, program);
  }

  /** `null` is the window's own framebuffer, the one that gets presented. */
  private bindTarget(
    gl: GL,
    target: RenderTarget | null,
    info: FrameInfo,
  ): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : 0);
    gl.viewport(
      0,
      0,
      target ? target.width : info.width,
      target ? target.height : info.height,
    );
  }

  private bindSource(
    gl: GL,
    program: CompiledProgram,
    name: string,
    target: RenderTarget,
    unit: number,
  ): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(program.uniform(name), unit);
  }

  /**
   * The three a post shader almost always wants. They are *set*, not
   * injected — a pass that does not declare one gets no location back and
   * the write is dropped, which is what keeps a shader copied from three.js
   * (where these names are the author's to define) compiling unchanged.
   */
  private commonUniforms(
    gl: GL,
    program: CompiledProgram,
    info: FrameInfo,
  ): void {
    const { width, height } = info;
    gl.uniform2fv(
      program.uniform('resolution'),
      new Float32Array([width, height]),
    );
    gl.uniform2fv(
      program.uniform('texelSize'),
      new Float32Array([1 / Math.max(1, width), 1 / Math.max(1, height)]),
    );
    const time = now();
    if (this.startedAt === null) this.startedAt = time;
    gl.uniform1f(program.uniform('time'), (time - this.startedAt) / 1000);
  }

  /** `<shaderPass uniforms>`, in three.js's `{ name: { value } }` shape. */
  private userUniforms(
    gl: GL,
    program: CompiledProgram,
    pass: ShaderPass,
  ): void {
    const uniforms = pass.uniforms;
    if (!uniforms) return;
    for (const [name, entry] of Object.entries(uniforms)) {
      this.owner.setUniform(gl, program.uniform(name), entry.value);
    }
  }

  private drawQuad(gl: GL, program: CompiledProgram): void {
    const location = program.attribute('position');
    if (location < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer(gl));
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private quadBuffer(gl: GL): unknown {
    if (this.quad) return this.quad;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);
    return this.quad;
  }

  /**
   * One program per pass configuration. A `<shaderPass>` is keyed by its
   * source, so editing the GLSL recompiles and changing a uniform does not.
   */
  private programFor(
    gl: GL,
    pass: Pass | typeof COPY_PASS,
    part = '',
    override: string | null = null,
  ): CompiledProgram | null {
    const kind = pass.kind;
    const custom = kind === 'shaderPass';
    const shader = pass as unknown as Partial<ShaderPass>;
    const fragmentShader =
      override ??
      (custom ? shader.fragmentShader : SIMPLE_PASSES[kind]?.fragmentShader) ??
      COPY_SHADER;
    const vertexShader =
      custom && shader.vertexShader ? shader.vertexShader : QUAD_VERTEX_SHADER;

    const signature = custom
      ? `shaderPass|${vertexShader}|${fragmentShader}`
      : `${kind}|${part}`;
    const cached = this.programs.get(signature);
    if (cached) return cached.program ? (cached as CompiledProgram) : null;

    const entry = this.owner.compile(
      gl,
      { vertex: vertexShader, fragment: `${PRECISION}${fragmentShader}` },
      signature,
      `<${kind}>`,
    );
    this.programs.set(signature, entry);
    return entry.program ? (entry as CompiledProgram) : null;
  }

  /**
   * Does this context have framebuffer objects? The direct backend exposes
   * whatever `x11-dri` provides, so "the GL has no FBOs" is a real state.
   * Reported once; the scene then draws to the window uncomposed, which is
   * the same picture without the effects.
   */
  private usable(gl: GL): boolean {
    if (this._usable !== undefined) return this._usable;
    const missing = FBO_ENTRY_POINTS.filter(
      (name) => typeof gl[name] !== 'function',
    );
    this._usable = missing.length === 0;
    if (!this._usable) {
      this.owner.report(
        'post-unavailable',
        `<effectComposer>: this GL context is missing ${missing.join(', ')}, ` +
          'so the scene cannot be rendered to a texture and the passes are ' +
          'skipped. Check with `npm ls x11-dri`.',
        'GL_POST_UNAVAILABLE',
      );
    }
    return this._usable;
  }

  private ensureTargets(
    gl: GL,
    width: number,
    height: number,
  ): (RenderTarget | null)[] | null {
    if (this.width !== width || this.height !== height) this.release(gl);
    if (this.targets[0] && this.targets[1]) return this.targets;
    this.width = width;
    this.height = height;
    // only the scene's target needs depth: everything after it is a quad
    // drawn with the depth test off
    this.targets[0] ??= this.createTarget(gl, width, height, { depth: true });
    this.targets[1] ??= this.createTarget(gl, width, height);
    if (this.targets[0] && this.targets[1]) return this.targets;
    this.release(gl);
    return null;
  }

  private ensureBloom(
    gl: GL,
    width: number,
    height: number,
  ): RenderTarget[] | null {
    if (this.bloom[0] && this.bloom[1]) return this.bloom as RenderTarget[];
    const w = half(width);
    const h = half(height);
    this.bloom[0] ??= this.createTarget(gl, w, h);
    this.bloom[1] ??= this.createTarget(gl, w, h);
    if (this.bloom[0] && this.bloom[1]) return this.bloom as RenderTarget[];
    this.releaseTargets(gl, this.bloom);
    return null;
  }

  private createTarget(
    gl: GL,
    width: number,
    height: number,
    { depth = false } = {},
  ): RenderTarget | null {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // null pixels: the storage is allocated and the contents are whatever
    // the first draw into it writes
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // a surface is almost never a power of two, and ES 2 allows an NPOT
    // texture only with CLAMP_TO_EDGE and no mipmaps
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    let depthBuffer: unknown = null;
    if (depth) {
      depthBuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
      gl.renderbufferStorage(
        gl.RENDERBUFFER,
        gl.DEPTH_COMPONENT16,
        width,
        height,
      );
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        depthBuffer,
      );
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, 0);

    const target: RenderTarget = {
      framebuffer,
      texture,
      depth: depthBuffer,
      width,
      height,
    };
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this.owner.report(
        'post-target',
        `<effectComposer>: a ${width}x${height} render target is not ` +
          `complete (status 0x${(status >>> 0).toString(16)}), so the ` +
          'passes are skipped and the scene draws to the window directly.',
        'GL_POST_TARGET_FAILED',
      );
      this.destroyTarget(gl, target);
      return null;
    }
    return target;
  }

  private destroyTarget(gl: GL, target: RenderTarget | null): void {
    if (!target) return;
    gl.deleteFramebuffer(target.framebuffer);
    gl.deleteTexture(target.texture);
    if (target.depth) gl.deleteRenderbuffer(target.depth);
  }

  private releaseTargets(gl: GL, list: (RenderTarget | null)[]): void {
    for (let i = 0; i < list.length; i++) {
      this.destroyTarget(gl, list[i]);
      list[i] = null;
    }
  }

  /** Every render target, on a resize or on the way out. */
  private release(gl: GL): void {
    if (!gl) {
      this.targets = [null, null];
      this.bloom = [null, null];
      return;
    }
    this.releaseTargets(gl, this.targets);
    this.releaseTargets(gl, this.bloom);
  }

  dispose(gl: GL): void {
    this.release(gl);
    if (gl) {
      for (const { program } of this.programs.values()) {
        if (program) gl.deleteProgram(program);
      }
      if (this.quad) gl.deleteBuffer(this.quad);
    }
    this.programs.clear();
    this.quad = null;
    this.passes = null;
    this.width = 0;
    this.height = 0;
  }
}

/** The stand-in pass `copy` compiles its program under. */
const COPY_PASS = { kind: 'copy' } as const;
