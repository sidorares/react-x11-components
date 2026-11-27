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

import { discardFrame, keepFrame, peekFrame } from './frame-store.js';

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
  /** As `run`, where nothing is asked of what it came to: a context a thread
   *  away posts the calls and goes on, since each one asked and slept on is a
   *  round trip. Absent where `run` is as cheap. */
  post?(commands: HtmlGLCommand[]): void;
  /** What has been drawn, as straight RGBA with its top row first. */
  present(into: Uint8ClampedArray): void;
  /** What has been drawn, kept where the pixels will be taken from
   *  (`frame-store.ts`), and its number: a frame is handed to a canvas as
   *  that, where `present` copies it to wherever the caller is. Absent where
   *  a context cannot keep one. */
  snapshot?(): { id: number; width: number; height: number } | null;
  /** A kept frame no one will take, let go. */
  discard?(id: number): void;
  /** A kept frame's pixels, which stay kept: a read of one that something
   *  other than a canvas is to hold. */
  frameData?(id: number): Uint8ClampedArray | null;
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
  WAIT_FAILED: 0x911d,
  TEXTURE_SWIZZLE_R: 0x8e42,
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

/** What a core profile has for the formats it lost: the format and sized
 *  internal format to upload as, and the swizzle (r, g, b, a) that makes a
 *  sampler read them as the legacy format did. 0 and 1 are `ZERO` and `ONE`,
 *  0x1903 and 0x1904 the red and green channels. */
const LEGACY_FORMATS: Record<
  number,
  { format: number; internal: number; swizzle: number[] }
> = {
  // ALPHA: no colour, and the one channel is alpha
  0x1906: { format: 0x1903, internal: 0x8229, swizzle: [0, 0, 0, 0x1903] },
  // LUMINANCE: the one channel is grey, and opaque
  0x1909: {
    format: 0x1903,
    internal: 0x8229,
    swizzle: [0x1903, 0x1903, 0x1903, 1],
  },
  // LUMINANCE_ALPHA: grey, and alpha
  0x190a: {
    format: 0x8227,
    internal: 0x822b,
    swizzle: [0x1903, 0x1903, 0x1903, 0x1904],
  },
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
  /** A framebuffer the drawing buffer is turned over into to be read
   *  (`_flipInto`), made as it is first read and again at a new size. */
  private _flip: { fbo: GLName; color: GLName } | null = null;

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
    if (this._flip) {
      gl('deleteFramebuffer', this._flip.fbo);
      gl('deleteRenderbuffer', this._flip.color);
      this._flip = null;
    }
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
    let drew = false;
    for (const [name, ...args] of commands) {
      answer = this._command(name, args.map(this._argument, this));
      if (!drew && (name.startsWith('draw') || name === 'fenceSync')) {
        drew = true;
      }
    }
    // a browser flushes what a task drew as the task ends. A fence the page
    // polls (`getSyncParameter`) is signaled only once its commands have been
    // sent to the GPU, and with no flush they waited for the next read of the
    // frame: a panel's frames came in bursts, smooth and then slow.
    if (drew) this._call('flush');
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
      case 'getSyncParameter':
      case 'clientWaitSync':
        // a sync object deleted or unknown is an error value in WebGL, where
        // the driver's binding throws
        try {
          return this._call(name, ...a);
        } catch {
          return name === 'clientWaitSync' ? GL.WAIT_FAILED : null;
        }
      case 'fenceSync':
        // the page numbered it, as it did a buffer: what it waits on is the
        // GPU's, which the glass of rida.dev limits its frames in flight by
        this._names.set(a[0] as number, this._call(name, a[1], a[2]) as GLName);
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
      case 'texImage2D':
      case 'texSubImage2D': {
        if (statsOn()) {
          const sub = name === 'texSubImage2D';
          const w = Number(a[sub ? 4 : 3]);
          const h = Number(a[sub ? 5 : 4]);
          const data = a[a.length - 1] as { byteLength?: number } | null;
          noteUpload(name, w, h, data?.byteLength ?? w * h * 4);
        }
        // a core profile has no ALPHA, LUMINANCE or LUMINANCE_ALPHA, which
        // WebGL does: they are one or two channels, read through a swizzle
        // as the legacy format would be
        const legacy = this._core ? LEGACY_FORMATS[a[6] as number] : undefined;
        if (!legacy) return this._call(name, ...a);
        const args = [...a];
        args[6] = legacy.format;
        if (name === 'texImage2D') args[2] = legacy.internal;
        const out = this._call(name, ...args);
        legacy.swizzle.forEach((value, i) =>
          this._call('texParameteri', a[0], GL.TEXTURE_SWIZZLE_R + i, value),
        );
        return out;
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
        // a page reading the default framebuffer reads what it resolves
        // into, then has its own bindings back
        const fromDefault =
          this._resolve !== 0 && this._readBound === this._fbo;
        if (fromDefault) {
          this._call('bindFramebuffer', GL.READ_FRAMEBUFFER, this._resolved());
        }
        this._call(name, x, y, w, h, format, type, into);
        if (fromDefault) {
          this._call('bindFramebuffer', GL.READ_FRAMEBUFFER, this._readBound);
          this._call('bindFramebuffer', GL.DRAW_FRAMEBUFFER, this._drawBound);
        }
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

  /** The framebuffer a read of the drawing buffer is made from: the
   *  default one, or what it resolves into where it is multisampled. GL
   *  refuses `readPixels` from a multisampled framebuffer
   *  (`INVALID_OPERATION`), which is every context that kept WebGL's
   *  `antialias`, and so every page that read its canvas back. */
  private _resolved(): number {
    if (!this._resolve) return this._fbo;
    const gl = (name: string, ...a: unknown[]): unknown =>
      this._call(name, ...a);
    const scissored = gl('isEnabled', GL.SCISSOR_TEST);
    if (scissored) gl('disable', GL.SCISSOR_TEST);
    gl('bindFramebuffer', GL.READ_FRAMEBUFFER, this._fbo);
    gl('bindFramebuffer', GL.DRAW_FRAMEBUFFER, this._resolve);
    gl(
      'blitFramebuffer',
      0,
      0,
      this._width,
      this._height,
      0,
      0,
      this._width,
      this._height,
      GL.COLOR_BUFFER_BIT,
      GL.NEAREST,
    );
    if (scissored) gl('enable', GL.SCISSOR_TEST);
    return this._resolve;
  }

  /** Reads a framebuffer top row first into `into`: copied to one of its
   *  own turned over, which is how a read comes out the right way up with no
   *  pass over the pixels here. */
  private _flipInto(source: number, into: Uint8Array): void {
    const gl = (name: string, ...a: unknown[]): unknown =>
      this._call(name, ...a);
    const width = this._width;
    const height = this._height;
    if (!this._flip) {
      const color = gl('createRenderbuffer') as GLName;
      gl('bindRenderbuffer', GL.RENDERBUFFER, color);
      gl('renderbufferStorage', GL.RENDERBUFFER, GL.RGBA8, width, height);
      gl('bindRenderbuffer', GL.RENDERBUFFER, 0);
      const fbo = gl('createFramebuffer') as GLName;
      gl('bindFramebuffer', GL.FRAMEBUFFER, fbo);
      gl(
        'framebufferRenderbuffer',
        GL.FRAMEBUFFER,
        GL.COLOR_ATTACHMENT0,
        GL.RENDERBUFFER,
        color,
      );
      this._flip = { fbo, color };
    }
    const scissored = gl('isEnabled', GL.SCISSOR_TEST);
    if (scissored) gl('disable', GL.SCISSOR_TEST);
    gl('bindFramebuffer', GL.READ_FRAMEBUFFER, source);
    gl('bindFramebuffer', GL.DRAW_FRAMEBUFFER, this._flip.fbo);
    gl(
      'blitFramebuffer',
      0,
      0,
      width,
      height,
      0,
      height,
      width,
      0,
      GL.COLOR_BUFFER_BIT,
      GL.NEAREST,
    );
    if (scissored) gl('enable', GL.SCISSOR_TEST);
    gl('bindFramebuffer', GL.READ_FRAMEBUFFER, this._flip.fbo);
    gl('readPixels', 0, 0, width, height, GL.RGBA, GL.UNSIGNED_BYTE, into);
  }

  present(into: Uint8ClampedArray): void {
    this._current();
    const gl = (name: string, ...a: unknown[]): unknown =>
      this._call(name, ...a);
    const width = this._width;
    const height = this._height;
    const source = this._resolved();
    if (into.length === width * height * 4) {
      // the rows turned on the GPU, where GL's are bottom up, and read in
      // place: the turn was a copy of the whole frame, 13 MB at 2x
      this._flipInto(
        source,
        new Uint8Array(into.buffer, into.byteOffset, into.byteLength),
      );
      gl('bindFramebuffer', GL.READ_FRAMEBUFFER, this._readBound);
      gl('bindFramebuffer', GL.DRAW_FRAMEBUFFER, this._drawBound);
      if (this._options.alpha && this._options.premultipliedAlpha) {
        straighten(into);
      }
      return;
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

  snapshot(): { id: number; width: number; height: number } | null {
    const width = this._width;
    const height = this._height;
    const data = new Uint8ClampedArray(width * height * 4);
    this.present(data);
    return { id: keepFrame({ width, height, data }), width, height };
  }

  discard(id: number): void {
    discardFrame(id);
  }

  frameData(id: number): Uint8ClampedArray | null {
    return peekFrame(id)?.data ?? null;
  }

  dispose(): void {
    this._destroy();
  }
}

/** Straight colour from premultiplied, by alpha and colour, built the way a
 *  clamped array rounds `colour * 255 / alpha`, which is what the loop it
 *  replaces did a pixel at a time. */
let UNPREMULTIPLIED: Uint8ClampedArray | null = null;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Straight colour from premultiplied, which is what a canvas's picture is
 *  read as. A picture at 2x is millions of pixels and most of a glass panel's
 *  are neither clear nor opaque, so this is a lookup and a word a pixel. */
function straighten(pixels: Uint8ClampedArray): void {
  if (!UNPREMULTIPLIED) {
    const table = new Uint8ClampedArray(256 * 256);
    for (let a = 1; a < 255; a += 1) {
      const scale = 255 / a;
      for (let c = 0; c < 256; c += 1) table[(a << 8) | c] = c * scale;
    }
    UNPREMULTIPLIED = table;
  }
  const table = UNPREMULTIPLIED;
  if (LITTLE_ENDIAN && (pixels.byteOffset & 3) === 0) {
    const words = new Uint32Array(
      pixels.buffer,
      pixels.byteOffset,
      pixels.length >> 2,
    );
    for (let j = 0; j < words.length; j += 1) {
      const w = words[j];
      const a = w >>> 24;
      if (a === 0 || a === 255) continue;
      const base = a << 8;
      words[j] =
        ((a << 24) |
          (table[base | ((w >>> 16) & 255)] << 16) |
          (table[base | ((w >>> 8) & 255)] << 8) |
          table[base | (w & 255)]) >>>
        0;
    }
    return;
  }
  for (let i = 3; i < pixels.length; i += 4) {
    const a = pixels[i];
    if (a === 0 || a === 255) continue;
    const base = a << 8;
    pixels[i - 3] = table[base | pixels[i - 3]];
    pixels[i - 2] = table[base | pixels[i - 2]];
    pixels[i - 1] = table[base | pixels[i - 1]];
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

// x11-dri is not safe to call from two threads at once: two threads each
// making a context and clearing it abort the process in malloc, its
// bindings' state being the process's. So every call into a context, from
// whichever thread, is made holding one lock in memory the threads share
// (`useGpuLock`), and a glass panel's thread draws while the page's waits
// for its turn rather than the other way round.
let gpuMade: Int32Array | null = null;
/** Made at first use, which keeps this module free of side effects. */
const gpuWord = (): Int32Array =>
  (gpuMade ??= new Int32Array(new SharedArrayBuffer(4)));
/** How long a turn may be waited for before the holder is taken to be gone
 *  with the lock, as a thread terminated in the middle of a call is. */
const STALE_MS = 5_000;
declare const performance: { now(): number };

/** The memory the lock is in, to hand to a thread (`useGpuLock`). */
/** `RX_GLSTATS=1`: what a page uploads as textures, a line a second on
 *  stderr, for measuring what a stage moves. Read once, here, at no cost
 *  where it is off. */
let uploadStats: boolean | undefined;
const statsOn = (): boolean =>
  (uploadStats ??= !!(
    globalThis as { process?: { env?: Record<string, string> } }
  ).process?.env?.RX_GLSTATS);
const uploads = { at: 0, n: 0, bytes: 0, max: 0, maxDims: '' };
function noteUpload(name: string, w: number, h: number, bytes: number): void {
  uploads.n += 1;
  uploads.bytes += bytes;
  if (bytes > uploads.max) {
    uploads.max = bytes;
    uploads.maxDims = `${name} ${w}x${h}`;
  }
  const now = Date.now();
  if (!uploads.at) uploads.at = now;
  if (now - uploads.at < 1000) return;
  (
    globalThis as { process?: { stderr?: { write(s: string): void } } }
  ).process?.stderr?.write(
    `[glstats] ${uploads.n} uploads, ${(uploads.bytes / 1048576).toFixed(2)} MB, largest ${(uploads.max / 1048576).toFixed(2)} MB (${uploads.maxDims})\n`,
  );
  uploads.at = now;
  uploads.n = 0;
  uploads.bytes = 0;
  uploads.max = 0;
}

export function gpuLockBuffer(): SharedArrayBuffer {
  return gpuWord().buffer as SharedArrayBuffer;
}

/** This thread takes its turns on the lock another made. */
export function useGpuLock(buffer: SharedArrayBuffer): void {
  gpuMade = new Int32Array(buffer);
}

function withGpu<T>(call: () => T): T {
  const word = gpuWord();
  const started = performance.now();
  while (Atomics.compareExchange(word, 0, 0, 1) !== 0) {
    if (performance.now() - started > STALE_MS) break;
    Atomics.wait(word, 0, 1, 10);
  }
  try {
    return call();
  } finally {
    Atomics.store(word, 0, 0);
    Atomics.notify(word, 0, 1);
  }
}

/** A context whose every call takes its turn on the GPU. */
function inTurns(inner: HtmlGLContext): HtmlGLContext {
  const turn =
    <A extends unknown[], R>(call: (...args: A) => R) =>
    (...args: A): R =>
      withGpu(() => call.apply(inner, args));
  const { snapshot, discard, frameData } = inner;
  return {
    extensions: inner.extensions,
    run: turn(inner.run),
    resize: turn(inner.resize),
    present: turn(inner.present),
    dispose: turn(inner.dispose),
    ...(snapshot && { snapshot: turn(snapshot) }),
    ...(discard && { discard: turn(discard) }),
    ...(frameData && { frameData: turn(frameData) }),
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
      const made = withGpu(() => open(options));
      return made && inTurns(made);
    },
  };
  function open(options: HtmlGLOptions): HtmlGLContext | null {
    {
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
    }
  }
}
