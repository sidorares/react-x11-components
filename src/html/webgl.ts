// A page's WebGL on a real GPU: the seam a page's contexts draw through
// (`HtmlScripts.webgl`), and `gpuWebGL`, which is x11-dri's windowless GL
// behind it. Nothing here runs unless a host hands it in; with none a context
// keeps its state and draws nothing (`scripts/webgl.ts`).
//
// **A context draws in the page's process and is read back into its canvas.**
// A `<glarea>` is a surface over the window, so everything a document paints
// after the canvas would have to go over it, and a page's fluid or glow is
// usually under its text; a canvas's pixels are drawn where the document paints
// the canvas, as a 2d one's are (`canvasPut`). So each context has a GL context
// of its own that no window knows of, whose default framebuffer is one this
// makes, and what was drawn is read out as the document paints it (`present`,
// from `PageContexts.settle`): a canvas nobody can see costs no read.
//
// **`x11-dri` is optional, its types are ours, and it is asked for by a name
// the compiler cannot see**, as `quico.ts` and `werift.ts` have theirs: an app
// that did not install it can still type-check against this package, and
// `gpuWebGL` answers null. It is core's optional dependency, so an app that
// has `<glarea>` has it.
//
// **This gives a page the driver, which a browser does not.** Chrome hands
// WebGL to ANGLE, which validates every call and rewrites every shader: what
// a draw reads is bounded, and a shader that hangs is stopped. Nothing does
// that here, so a page's shader reaches the driver as it was written, and an
// out-of-bounds draw reads what the driver lets it. A host that hands this
// in is trusting the pages it shows with that much, and at worst a page takes
// down its own process, which is a tab in the example browser.

declare const Buffer: {
  from(text: string, encoding: 'base64'): Uint8Array;
  from(
    buffer: ArrayBufferLike,
    offset?: number,
    length?: number,
  ): Uint8Array & { toString(encoding: 'base64'): string };
};

/** What a page's context asked for. */
export interface HtmlGLOptions {
  /** WebGL's version: 2 is ES 3.0's. */
  version: 1 | 2;
  width: number;
  height: number;
  alpha: boolean;
  depth: boolean;
  stencil: boolean;
  antialias: boolean;
  premultipliedAlpha: boolean;
}

/** One call: its name, and its arguments as `scripts/webgl.ts` writes them.
 *  An object is `['o', number]`, the number the page's context gave it; bytes
 *  are `['b', view, base64]`; a plain array is `['a', …]`. */
export type HtmlGLCommand = [string, ...unknown[]];

/** A context that draws. */
export interface HtmlGLContext {
  /** Runs the calls in order, and answers what the last one came to. */
  run(commands: HtmlGLCommand[]): unknown;
  /** The drawing buffer takes a new size, and is cleared. */
  resize(width: number, height: number): void;
  /** What has been drawn, as straight RGBA with its top row first. */
  present(into: Uint8ClampedArray): void;
  /** The extensions `getExtension` finds. */
  extensions: readonly string[];
  dispose(): void;
}

/** What makes them. */
export interface HtmlWebGL {
  /** A context, or null where there is none to be had, which leaves the
   *  page one that draws nothing. */
  open(options: HtmlGLOptions): HtmlGLContext | null;
}

// --- x11-dri, as far as this reads it --------------------------------------

type GLName = number;
type Bytes = Uint8Array | Float32Array | Int32Array | Uint32Array | Uint16Array;

interface DriGL extends Record<string, unknown> {
  [name: string]: unknown;
}

/** The constants read here, by value: `gl`'s are the same, and a page's are
 *  WebGL's, which are ES's. */
const GL = {
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  RENDERBUFFER: 0x8d41,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  DEPTH_ATTACHMENT: 0x8d00,
  RGBA8: 0x8058,
  RGB8: 0x8051,
  DEPTH24_STENCIL8: 0x88f0,
  DEPTH_COMPONENT24: 0x81a6,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x100,
  STENCIL_BUFFER_BIT: 0x400,
  NEAREST: 0x2600,
  SCISSOR_TEST: 0xc11,
  BACK: 0x405,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  DELETE_STATUS: 0x8b80,
  VALIDATE_STATUS: 0x8b83,
  VERTEX_PROGRAM_POINT_SIZE: 0x8642,
  ARRAY_BUFFER: 0x8892,
  /** Where a page's own `pixelStorei` names begin: `UNPACK_FLIP_Y_WEBGL`
   *  and its kin, which no GL has. */
  WEBGL_PIXEL_STORE: 0x9240,
};

/** How many samples `antialias` asks for: what Chrome's default comes to. */
const SAMPLES = 4;

const VIEWS: Record<string, (b: ArrayBuffer, n: number) => Bytes> = {
  Uint8Array: (b, n) => new Uint8Array(b, 0, n),
  Uint8ClampedArray: (b, n) => new Uint8Array(b, 0, n),
  Int8Array: (b, n) => new Uint8Array(b, 0, n),
  Float32Array: (b, n) => new Float32Array(b, 0, n >> 2),
  Int32Array: (b, n) => new Int32Array(b, 0, n >> 2),
  Uint32Array: (b, n) => new Uint32Array(b, 0, n >> 2),
  Int16Array: (b, n) => new Uint16Array(b, 0, n >> 1),
  Uint16Array: (b, n) => new Uint16Array(b, 0, n >> 1),
};

/** Base64 as a view of its kind, on memory of its own: a view of the
 *  runtime's pooled `Buffer` is at an offset no `Float32Array` can start at. */
function bytesOf(view: string, base64: string): Bytes {
  const data = Buffer.from(base64, 'base64');
  const whole = new ArrayBuffer(data.length);
  new Uint8Array(whole).set(data);
  return (VIEWS[view] ?? VIEWS.Uint8Array)(whole, data.length);
}

/**
 * GLSL as a desktop context takes it. ES 1.00 goes as it is: x11-dri puts the
 * `#version 100` a core profile asks for on it, and ARB_ES2_compatibility does
 * the rest. ES 3.00 has no such door on a Mac, which has no
 * ARB_ES3_compatibility, so it is said as GLSL 4.10, which reads all but a
 * few of the same words.
 */
export function desktopGlsl(source: string, core: boolean): string {
  if (!core) return source;
  const ES3 = /^(\s*(?:\/\/[^\n]*\n\s*)*)#version\s+300\s+es\b/;
  if (!ES3.test(source)) return source;
  return source.replace(ES3, '$1#version 410 core');
}

class GpuContext implements HtmlGLContext {
  readonly extensions: readonly string[];
  private readonly _names = new Map<number, GLName>();
  private _fbo = 0;
  private _resolve = 0;
  private _storage: GLName[] = [];
  private _width: number;
  private _height: number;
  private _read: Uint8Array;
  /** What the page has bound, which `present` has to put back. */
  private _drawBound = 0;
  private _readBound = 0;
  /** What stands for WebGL's default vertex array, where GL has none. */
  private _vertexArray = 0;

  constructor(
    private readonly _gl: DriGL,
    private readonly _current: () => void,
    private readonly _destroy: () => void,
    private readonly _core: boolean,
    private readonly _options: HtmlGLOptions,
  ) {
    this._width = Math.max(1, _options.width);
    this._height = Math.max(1, _options.height);
    this._read = new Uint8Array(this._width * this._height * 4);
    this.extensions = _options.version === 2 ? EXTENSIONS_2 : EXTENSIONS_1;
    this._current();
    this._framebuffers();
    // WebGL starts at the size of its drawing buffer, where a context with
    // no window starts at nothing, and a page that never says draws nothing
    this._call('viewport', 0, 0, this._width, this._height);
    this._call('scissor', 0, 0, this._width, this._height);
    // `gl_PointSize` is written by a shader in ES, and only where this is on
    // in a desktop context; and WebGL has a default vertex array, where a
    // core profile has none to bind, and every attribute and every draw with
    // none bound is an error that leaves nothing drawn
    if (this._core) {
      this._call('enable', GL.VERTEX_PROGRAM_POINT_SIZE);
      this._vertexArray = this._call('createVertexArray') as GLName;
      this._call('bindVertexArray', this._vertexArray);
    }
  }

  private _call(name: string, ...args: unknown[]): unknown {
    const fn = this._gl[name] as ((...a: unknown[]) => unknown) | undefined;
    return typeof fn === 'function' ? fn.apply(this._gl, args) : undefined;
  }

  /** The default framebuffer WebGL has and a windowless context does not:
   *  multisampled where the page asked, with what resolves it beside it. */
  private _framebuffers(): void {
    const { alpha, depth, stencil, antialias } = this._options;
    const gl = (name: string, ...a: unknown[]): number =>
      this._call(name, ...a) as number;
    for (const name of this._storage) gl('deleteRenderbuffer', name);
    this._storage = [];
    if (this._fbo) gl('deleteFramebuffer', this._fbo);
    if (this._resolve) gl('deleteFramebuffer', this._resolve);
    const storage = (format: number): GLName => {
      const name = gl('createRenderbuffer');
      gl('bindRenderbuffer', GL.RENDERBUFFER, name);
      if (antialias) {
        gl(
          'renderbufferStorageMultisample',
          GL.RENDERBUFFER,
          SAMPLES,
          format,
          this._width,
          this._height,
        );
      } else {
        gl(
          'renderbufferStorage',
          GL.RENDERBUFFER,
          format,
          this._width,
          this._height,
        );
      }
      this._storage.push(name);
      return name;
    };
    this._fbo = gl('createFramebuffer');
    gl('bindFramebuffer', GL.FRAMEBUFFER, this._fbo);
    gl(
      'framebufferRenderbuffer',
      GL.FRAMEBUFFER,
      GL.COLOR_ATTACHMENT0,
      GL.RENDERBUFFER,
      storage(alpha ? GL.RGBA8 : GL.RGB8),
    );
    if (depth || stencil) {
      gl(
        'framebufferRenderbuffer',
        GL.FRAMEBUFFER,
        stencil ? GL.DEPTH_STENCIL_ATTACHMENT : GL.DEPTH_ATTACHMENT,
        GL.RENDERBUFFER,
        storage(stencil ? GL.DEPTH24_STENCIL8 : GL.DEPTH_COMPONENT24),
      );
    }
    this._resolve = 0;
    if (antialias) {
      const color = gl('createRenderbuffer');
      gl('bindRenderbuffer', GL.RENDERBUFFER, color);
      // the format of what it resolves: a blit out of a multisampled buffer
      // into another format is an error, and leaves what it was
      gl(
        'renderbufferStorage',
        GL.RENDERBUFFER,
        alpha ? GL.RGBA8 : GL.RGB8,
        this._width,
        this._height,
      );
      this._storage.push(color);
      this._resolve = gl('createFramebuffer');
      gl('bindFramebuffer', GL.FRAMEBUFFER, this._resolve);
      gl(
        'framebufferRenderbuffer',
        GL.FRAMEBUFFER,
        GL.COLOR_ATTACHMENT0,
        GL.RENDERBUFFER,
        color,
      );
    }
    gl('bindFramebuffer', GL.FRAMEBUFFER, this._fbo);
    gl('bindRenderbuffer', GL.RENDERBUFFER, 0);
    this._drawBound = this._fbo;
    this._readBound = this._fbo;
    gl('clearColor', 0, 0, 0, 0);
    gl(
      'clear',
      GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT,
    );
  }

  resize(width: number, height: number): void {
    this._current();
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    this._read = new Uint8Array(this._width * this._height * 4);
    this._framebuffers();
  }

  /** An argument as `scripts/webgl.ts` wrote it. */
  private _argument(arg: unknown): unknown {
    if (!Array.isArray(arg)) return arg;
    if (arg[0] === 'o') return this._names.get(arg[1] as number) ?? 0;
    if (arg[0] === 'b') return bytesOf(arg[1] as string, arg[2] as string);
    if (arg[0] === 'a') return arg.slice(1);
    return arg;
  }

  run(commands: HtmlGLCommand[]): unknown {
    this._current();
    let answer: unknown;
    for (const [name, ...args] of commands) {
      answer = this._command(name, args.map(this._argument, this));
    }
    return answer;
  }

  private _command(name: string, a: unknown[]): unknown {
    switch (name) {
      case 'createBuffer':
      case 'createFramebuffer':
      case 'createProgram':
      case 'createRenderbuffer':
      case 'createTexture':
      case 'createVertexArray':
      case 'createQuery':
        // the page numbered it: the first argument is that number as written
        this._names.set(a[0] as number, this._call(name) as GLName);
        return undefined;
      case 'createShader':
        this._names.set(a[0] as number, this._call(name, a[1]) as GLName);
        return undefined;
      case 'shaderSource':
        return this._call(name, a[0], desktopGlsl(a[1] as string, this._core));
      case 'bindFramebuffer': {
        const bound = (a[1] as number) || this._fbo;
        if (a[0] !== GL.READ_FRAMEBUFFER) this._drawBound = bound;
        if (a[0] !== GL.DRAW_FRAMEBUFFER) this._readBound = bound;
        return this._call(name, a[0], bound);
      }
      case 'bindVertexArray':
        return this._call(name, (a[0] as number) || this._vertexArray);
      case 'bufferData':
        return this._call(
          name,
          a[0],
          typeof a[1] === 'number' ? new Uint8Array(a[1]) : a[1],
          a[2],
        );
      case 'clearDepth':
        return this._call('clearDepthf', a[0]);
      case 'pixelStorei':
        return (a[0] as number) < GL.WEBGL_PIXEL_STORE
          ? this._call(name, a[0], a[1])
          : undefined;
      case 'uniform1fv':
      case 'uniform2fv':
      case 'uniform3fv':
      case 'uniform4fv':
        return this._call(name, a[0], floats(a[1]));
      case 'uniform1iv':
        return this._call(name, a[0], ints(a[1]));
      case 'uniform2iv':
      case 'uniform3iv':
      case 'uniform4iv':
        return this._call(
          `uniform${name[7]}i`,
          a[0],
          ...Array.from(ints(a[1])).slice(0, Number(name[7])),
        );
      case 'uniformMatrix2fv':
      case 'uniformMatrix3fv':
      case 'uniformMatrix4fv':
        return this._call(name, a[0], a[1], floats(a[2]));
      case 'drawBuffers':
        return this._call(
          name,
          (a[0] as number[]).map((b) =>
            b === GL.BACK ? GL.COLOR_ATTACHMENT0 : b,
          ),
        );
      case 'readBuffer':
        return this._call(name, a[0] === GL.BACK ? GL.COLOR_ATTACHMENT0 : a[0]);
      case 'getShaderParameter':
      case 'getProgramParameter': {
        const value = this._call(name, a[0], a[1]) as number;
        return BOOLEAN_STATUS.has(a[1] as number) ? !!value : value;
      }
      case 'getUniformLocation': {
        const at = this._call(name, a[0], a[1]) as number;
        return at < 0 ? null : at;
      }
      case 'readPixels': {
        const [x, y, w, h, format, type, bytes] = a as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        const into = new Uint8Array(bytes);
        this._call(name, x, y, w, h, format, type, into);
        return Buffer.from(
          into.buffer,
          into.byteOffset,
          into.byteLength,
        ).toString('base64');
      }
      default:
        return this._call(name, ...a);
    }
  }

  present(into: Uint8ClampedArray): void {
    this._current();
    const gl = (name: string, ...a: unknown[]): unknown =>
      this._call(name, ...a);
    const width = this._width;
    const height = this._height;
    const scissored = gl('isEnabled', GL.SCISSOR_TEST);
    let source = this._fbo;
    if (this._resolve) {
      if (scissored) gl('disable', GL.SCISSOR_TEST);
      gl('bindFramebuffer', GL.READ_FRAMEBUFFER, this._fbo);
      gl('bindFramebuffer', GL.DRAW_FRAMEBUFFER, this._resolve);
      gl(
        'blitFramebuffer',
        0,
        0,
        width,
        height,
        0,
        0,
        width,
        height,
        GL.COLOR_BUFFER_BIT,
        GL.NEAREST,
      );
      if (scissored) gl('enable', GL.SCISSOR_TEST);
      source = this._resolve;
    }
    gl('bindFramebuffer', GL.READ_FRAMEBUFFER, source);
    const read = this._read;
    gl('readPixels', 0, 0, width, height, GL.RGBA, GL.UNSIGNED_BYTE, read);
    gl('bindFramebuffer', GL.READ_FRAMEBUFFER, this._readBound);
    gl('bindFramebuffer', GL.DRAW_FRAMEBUFFER, this._drawBound);
    const stride = width * 4;
    const rows = Math.min(height, Math.floor(into.length / stride));
    for (let y = 0; y < rows; y += 1) {
      const from = (height - 1 - y) * stride;
      into.set(read.subarray(from, from + stride), y * stride);
    }
    // with no alpha to hold, GL reads each pixel as opaque already
    if (this._options.alpha && this._options.premultipliedAlpha) {
      straighten(into);
    }
  }

  dispose(): void {
    this._destroy();
  }
}

/** Straight colour from premultiplied, which is what a canvas's picture is
 *  read as. */
function straighten(pixels: Uint8ClampedArray): void {
  for (let i = 3; i < pixels.length; i += 4) {
    const a = pixels[i];
    if (a === 0 || a === 255) continue;
    const scale = 255 / a;
    pixels[i - 3] *= scale;
    pixels[i - 2] *= scale;
    pixels[i - 1] *= scale;
  }
}

const floats = (v: unknown): Float32Array =>
  v instanceof Float32Array ? v : new Float32Array(v as number[]);
const ints = (v: unknown): Int32Array =>
  v instanceof Int32Array ? v : new Int32Array(v as number[]);

const BOOLEAN_STATUS = new Set([
  GL.COMPILE_STATUS,
  GL.LINK_STATUS,
  GL.DELETE_STATUS,
  GL.VALIDATE_STATUS,
]);

/** What `getExtension` finds, which is what asks nothing of a page's calls
 *  that the GL behind them does not do anyway. */
const EXTENSIONS_2 = [
  'EXT_color_buffer_float',
  'EXT_color_buffer_half_float',
  'OES_texture_float_linear',
];
const EXTENSIONS_1 = [
  'OES_element_index_uint',
  'OES_texture_float',
  'OES_texture_float_linear',
  'OES_texture_half_float',
];

interface DriModule {
  gl: DriGL;
  apple?: {
    Context: new (options: Record<string, unknown>) => {
      makeCurrent(): void;
      destroy(): void;
    };
  };
  Gpu?: new (options: Record<string, unknown>) => {
    gl: DriGL;
    createSurface(width: number, height: number): { destroy(): void };
    makeCurrent(surface: unknown): void;
    destroy(): void;
  };
}

/**
 * x11-dri's GL behind a page's contexts: a CGL context on a Mac, and on Linux
 * an EGL one over a GBM surface on the first render node. Null where it is not
 * installed, which nothing need say more about than a page's contexts drawing
 * nothing. Only the Mac's has been run.
 */
export async function gpuWebGL(): Promise<HtmlWebGL | null> {
  let dri: DriModule;
  try {
    const name = 'x11-dri';
    const loaded = (await import(/* @vite-ignore */ name)) as DriModule & {
      default?: DriModule;
    };
    dri = loaded.default ?? loaded;
  } catch {
    return null;
  }
  return {
    open(options) {
      try {
        const apple = dri.apple;
        if (apple) {
          const context = new apple.Context({
            alphaSize: 8,
            depthSize: 24,
            stencilSize: 8,
            doubleBuffer: false,
            profile: 'core',
          });
          context.makeCurrent();
          return new GpuContext(
            dri.gl,
            () => context.makeCurrent(),
            () => context.destroy(),
            true,
            options,
          );
        }
        if (dri.Gpu) {
          const gpu = new dri.Gpu({
            depthSize: 24,
            stencilSize: 8,
            glVersion: 3,
          });
          const surface = gpu.createSurface(1, 1);
          gpu.makeCurrent(surface);
          return new GpuContext(
            gpu.gl,
            () => gpu.makeCurrent(surface),
            () => {
              surface.destroy();
              gpu.destroy();
            },
            false,
            options,
          );
        }
      } catch {
        // no GPU this process can reach: a healthy machine with no picture
      }
      return null;
    },
  };
}
