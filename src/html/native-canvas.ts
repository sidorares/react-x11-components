// EXPERIMENTAL, off unless REACT_X11_NATIVE_CANVAS=1 on the Cocoa backend
// (docs/prd-native-canvas.md): a page's 2d canvas drawn on the host's native
// context. The realm records commands (`scripts/dom.ts`, `rec`), this
// replays them on a `Surface`, and `<Html>` shows the surface itself, on a
// layer where react-x11 can (`LayerSurface`). Solid and linear/radial paints
// only: a canvas that uses a shadow, a pattern or an operator the context
// makes differently goes on in the realm from then on (`nativeBail`), and a
// readback needs react-x11's `readPixels`.

import * as core from 'react-x11';
import { Image as NtkImage } from 'react-x11/ntk';
import { newSurface } from './surfaces.js';
import type { SurfaceLike } from './surfaces.js';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Matrix = number[];

let nativeApp: unknown = null;

/** `<Html>` tells which app draws, once it paints a canvas. */
export function setNativeApp(app: unknown): void {
  nativeApp = app;
}

function process_env(name: string): boolean {
  return (globalThis as Any).process?.env?.[name] === '1';
}

export function nativeCanvasEnabled(): boolean {
  const process = (globalThis as Any).process;
  const env = process?.env;
  // the Cocoa backend's: where nothing replays a canvas, it would show none
  return (
    env?.REACT_X11_NATIVE_CANVAS === '1' &&
    process?.platform === 'darwin' &&
    (env.REACT_X11_BACKEND ?? 'cocoa') === 'cocoa'
  );
}

const M = 0;
const L = 1;
const Q = 2;
const C = 3;

const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

const invert = (m: Matrix): Matrix | null => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
};

const css = (c: number[]): string =>
  `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;

/** A clip, with what is needed to tell when it cannot change a draw. */
interface DrawState {
  desc: Any;
  alpha: number;
  op: string;
  user: Matrix;
  clips: number[] | undefined;
  hash: number;
}
const NO_STATE: DrawState = {
  desc: null,
  alpha: 1,
  op: 'source-over',
  user: [1, 0, 0, 1, 0, 0],
  clips: undefined,
  hash: 0,
};

interface Clip {
  cmds: number[];
  m: Matrix;
  rule: string;
  /** a rectangle, a rectangle with round corners, or any other path */
  kind: 'rect' | 'rrect' | 'path';
  box: number[];
  /** the corners' size, for 'rrect' */
  r: number;
}

/** The device box of a path's points (control points bound the curves). */
function pathBox(cmds: number[], t: Matrix): number[] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    const px = t[0] * x + t[2] * y + t[4];
    const py = t[1] * x + t[3] * y + t[5];
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  };
  for (let i = 0; i < cmds.length;) {
    switch (cmds[i]) {
      case M:
      case L:
        add(cmds[i + 1], cmds[i + 2]);
        i += 3;
        break;
      case Q:
        add(cmds[i + 1], cmds[i + 2]);
        add(cmds[i + 3], cmds[i + 4]);
        i += 5;
        break;
      case C:
        add(cmds[i + 1], cmds[i + 2]);
        add(cmds[i + 3], cmds[i + 4]);
        add(cmds[i + 5], cmds[i + 6]);
        i += 7;
        break;
      default:
        i += 1;
    }
  }
  return x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : null;
}

function rectBox(x: number, y: number, w: number, h: number, t: Matrix) {
  const xs = [x, x + w, x, x + w];
  const ys = [y, y, y + h, y + h];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < 4; i++) {
    const px = t[0] * xs[i] + t[2] * ys[i] + t[4];
    const py = t[1] * xs[i] + t[3] * ys[i] + t[5];
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  return [x0, y0, x1, y1];
}

/** Sorts a clip path: four straight sides, or four sides and four round
 *  corners (a box with `border-radius`), under a transform that keeps the
 *  sides straight; anything else is just a path. */
function classify(cmds: number[], m: Matrix, rule: string): Clip {
  const clip: Clip = { cmds, m, rule, kind: 'path', box: [0, 0, 0, 0], r: 0 };
  const box = pathBox(cmds, m);
  if (!box) return clip;
  clip.box = box;
  if (m[1] !== 0 || m[2] !== 0) return clip;
  // the segments, in their own space
  let lines = 0;
  let curves = 0;
  let moves = 0;
  let closes = 0;
  let after = false;
  for (let i = 0; i < cmds.length;) {
    switch (cmds[i]) {
      case M:
        // closePath starts the next subpath where this one began
        if (!after) moves++;
        i += 3;
        break;
      case L:
        lines++;
        i += 3;
        break;
      case Q:
        return clip;
      case C:
        curves++;
        i += 7;
        break;
      default:
        closes++;
        i += 1;
        after = true;
        continue;
    }
    after = false;
  }
  if (moves !== 1 || closes > 1) return clip;
  if (curves === 0 && (lines === 3 || lines === 4)) {
    // a rectangle if every side is along an axis and it has four corners
    const pts: number[][] = [];
    for (let i = 0; i < cmds.length;) {
      if (cmds[i] === M || cmds[i] === L) {
        pts.push([cmds[i + 1], cmds[i + 2]]);
        i += 3;
      } else i += 1;
    }
    if (pts.length === 4 || pts.length === 5) {
      const n = pts.length === 5 ? 4 : 4;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        if (a[0] !== b[0] && a[1] !== b[1]) ok = false;
      }
      if (ok) clip.kind = 'rect';
    }
    return clip;
  }
  if (curves === 4 && lines >= 4 && lines <= 5) {
    // the corner's size is how far the path starts along the top side
    const r = Math.abs(cmds[1] - Math.min(cmds[1], ...cornerXs(cmds)));
    const first = cmds[1];
    const minX = Math.min(...cornerXs(cmds));
    const rr = first - minX;
    if (rr > 0 && Number.isFinite(rr)) {
      clip.kind = 'rrect';
      clip.r = Math.max(rr, r) * Math.max(Math.abs(m[0]), Math.abs(m[3]));
    }
  }
  return clip;
}

function cornerXs(cmds: number[]): number[] {
  const xs: number[] = [];
  for (let i = 0; i < cmds.length;) {
    switch (cmds[i]) {
      case M:
      case L:
        xs.push(cmds[i + 1]);
        i += 3;
        break;
      case C:
        xs.push(cmds[i + 1], cmds[i + 3], cmds[i + 5]);
        i += 7;
        break;
      default:
        i += 1;
    }
  }
  return xs;
}

/** Whether a draw within `b` is cut by nothing the clip does. */
function holds(clip: Clip, b: number[]): boolean {
  const c = clip.box;
  if (clip.kind === 'path') return false;
  if (b[0] < c[0] || b[1] < c[1] || b[2] > c[2] || b[3] > c[3]) return false;
  if (clip.kind === 'rect') return true;
  const r = clip.r;
  return (
    (b[1] >= c[1] + r && b[3] <= c[3] - r) ||
    (b[0] >= c[0] + r && b[2] <= c[2] - r)
  );
}

const TILE = 64;
const scratch = new Float64Array(1);
const words = new Int32Array(scratch.buffer);

/** FNV-style mix of anything a command is made of. */
function mix(h: number, v: unknown): number {
  if (typeof v === 'number') {
    scratch[0] = v;
    h = Math.imul(h ^ words[0], 16777619);
    return Math.imul(h ^ words[1], 16777619);
  }
  if (typeof v === 'string') {
    for (let i = 0; i < v.length; i++)
      h = Math.imul(h ^ v.charCodeAt(i), 16777619);
    return Math.imul(h ^ 0x9e37, 16777619);
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) h = mix(h, v[i]);
    return Math.imul(h ^ v.length, 16777619);
  }
  if (v && typeof v === 'object') {
    for (const k in v as Any) h = mix(mix(h, k), (v as Any)[k]);
    return h;
  }
  return Math.imul(h ^ (v === true ? 1 : v === false ? 2 : 3), 16777619);
}

/** react-x11's `LayerSurface` (3.1), which a layer shows as it is. */
interface LayerLike {
  readonly surface: SurfaceLike | null;
  readonly closed: boolean;
  draw(fn: (ctx: Any) => void, options?: { full?: boolean }): void;
  close(): void;
}

export class NativeCanvas {
  surface: SurfaceLike | null = null;
  /** Where the frames are, when a layer can show them as they are. */
  layer: LayerLike | null = null;
  ctx: Any = null;
  width = 0;
  height = 0;
  /** Batches that came before there was an app to draw them with. */
  pending: Array<[string, string]> = [];
  readonly images = new Map<number, unknown>();
  readonly clips = new Map<number, Clip>();
  version = 0;

  constructor(readonly lookup: (id: number) => NativeCanvas | null) {}

  /** Given up: the page draws on in its own realm (`nativeDrop`). */
  dropped = false;
  dispose(): void {
    this.dropped = true;
    this.layer?.close();
    this.layer = null;
    this.surface?.destroy?.();
    this.surface = null;
    this.ctx = null;
    this.pending = [];
  }

  /** A batch: the canvas's size, and the commands as JSON. */
  run(size: string, json: string): void {
    if (this.dropped) return;
    if (!this.surface) {
      this.dirty = null;
      this.pending.push([size, json]);
      if (this.pending.length > 400) this.absorb(this.pending.shift()![1]);
      return;
    }
    this.play(size, json);
  }

  /** The definitions in a batch nobody will draw. */
  private absorb(json: string): void {
    for (const c of JSON.parse(json) as Any[][]) {
      if (c[0] === 'K') {
        this.clipHash.set(c[1], mix(7, [c[2], c[3], c[4]]));
        this.clips.set(c[1], classify(c[2], c[3], c[4]));
      } else if (c[0] === 'D' || c[0] === 'DX') this.define(c);
      else if (c[0] === 'U') this.one(null, c);
    }
  }

  /** The surface, made at the first paint. */
  ensure(): SurfaceLike | null {
    if (this.surface) return this.surface;
    if (!nativeApp || !this.pending.length) return null;
    const batches = this.pending;
    this.pending = [];
    for (const [size, json] of batches) this.play(size, json);
    return this.surface;
  }

  private open(w: number, h: number): void {
    this.layer?.close();
    this.layer = null;
    this.surface?.destroy?.();
    this.surface = null;
    this.ctx = null;
    if (w <= 0 || h <= 0 || !nativeApp) return;
    this.width = w;
    this.height = h;
    const make = (core as Any).createLayerSurface;
    if (
      typeof make === 'function' &&
      typeof (nativeApp as Any).createSharedSurface === 'function' &&
      !process_env('REACT_X11_NO_LAYER_CANVAS')
    ) {
      try {
        this.layer = make(nativeApp, { width: w, height: h }) as LayerLike;
        // a layer has no frame until the first draw: the surface is made
        // then, and `ctx` follows each frame
        return;
      } catch {
        this.layer = null;
      }
    }
    const s = newSurface(nativeApp, w, h);
    if (!s) return;
    this.surface = s;
    this.ctx = s.getContext('2d');
  }

  clipHash = new Map<number, number>();
  /** How draws are made, by the id the page gave (`D`). */
  readonly states = new Map<number, DrawState>();
  private define(c: Any[]): void {
    if (c[0] === 'DX') {
      this.states.clear();
      return;
    }
    const [, id, desc, alpha, op, user, clips] = c;
    let hash = mix(11, [desc, alpha, op, user]);
    if (clips)
      for (const k of clips as number[])
        hash = mix(hash, this.clipHash.get(k) ?? 0);
    this.states.set(id, { desc, alpha, op, user, clips, hash });
  }
  private state(sid: number): DrawState {
    return this.states.get(sid) ?? NO_STATE;
  }

  /** The tiles' signatures of the last frame that began with a full clear. */
  prevSig: Int32Array | null = null;
  /** What the last batch changed: null all of it, or a box in pixels. */
  dirty: number[] | null | 'none' = null;

  /**
   * The signature of each 64-pixel tile of a frame: what, in order, draws
   * anywhere in it. A frame that begins with a full clear is its commands
   * and nothing else, so a tile whose signature is the last frame's is the
   * pixels it was, and the frame need not draw there, nor the document
   * show it again.
   */
  private plan(
    cmds: Any[][],
    w: number,
    h: number,
  ): {
    sig: Int32Array;
    full: boolean;
    boxes: (number[] | null)[];
    bounds: number[] | null;
    drew: boolean;
  } {
    const cols = Math.ceil(w / TILE);
    const rows = Math.ceil(h / TILE);
    const sig = new Int32Array(cols * rows);
    const boxes: (number[] | null)[] = new Array(cmds.length).fill(null);
    let full = false;
    let started = false;
    let wipes = false;
    const ub = [Infinity, Infinity, -Infinity, -Infinity];
    for (let n = 0; n < cmds.length; n++) {
      const c = cmds[n];
      let b: number[] | null = null;
      let sidAt = -1;
      switch (c[0]) {
        case 'K':
          this.clipHash.set(c[1], mix(7, [c[2], c[3], c[4]]));
          this.clips.set(c[1], classify(c[2], c[3], c[4]));
          continue;
        case 'D':
        case 'DX':
          this.define(c);
          continue;
        case 'X':
          if (!started) full = true;
          else wipes = true;
          continue;
        case 'U':
          continue;
        case 'CR': {
          sidAt = 5;
          const st = this.state(c[5]);
          b = rectBox(c[1], c[2], c[3], c[4], st.user);
          if (
            !started &&
            !(st.clips && st.clips.length) &&
            b[0] <= 0 &&
            b[1] <= 0 &&
            b[2] >= w &&
            b[3] >= h
          ) {
            full = true;
            continue;
          }
          break;
        }
        case 'FR': {
          sidAt = 5;
          const st = this.state(c[5]);
          b = rectBox(c[1], c[2], c[3], c[4], st.user);
          // an opaque fill of all of it leaves nothing of what was there
          if (
            !started &&
            !(st.clips && st.clips.length) &&
            st.op === 'source-over' &&
            st.alpha === 1 &&
            st.desc?.rgba?.[3] === 255 &&
            b[0] <= 0 &&
            b[1] <= 0 &&
            b[2] >= w &&
            b[3] >= h
          ) {
            full = true;
          }
          break;
        }
        case 'F':
          sidAt = 4;
          b = pathBox(c[1], c[2]);
          break;
        case 'S':
          sidAt = 4;
          b = pathBox(c[1], c[2]);
          if (b) {
            const grow = c[3][0] * Math.max(c[3][3], 2) * 2;
            b = [b[0] - grow, b[1] - grow, b[2] + grow, b[3] + grow];
          }
          break;
        case 'T': {
          sidAt = 10;
          // as far as the text can reach, and well past
          const fs = parseFloat(
            String(c[2]).match(/(\d+(?:\.\d+)?)px/)?.[1] ?? '32',
          );
          const len = String(c[1]).length * fs + fs;
          b = rectBox(
            c[5] - len,
            c[6] - 2 * fs,
            2 * len,
            3 * fs,
            this.state(c[10]).user,
          );
          break;
        }
        case 'I':
          sidAt = 11;
          b = rectBox(c[6], c[7], c[8], c[9], this.state(c[11]).user);
          break;
        case 'P':
          b = [c[1], c[2], c[1] + c[3], c[2] + c[4]];
          break;
        default:
          continue;
      }
      started = true;
      boxes[n] = b;
      if (b) {
        if (b[0] < ub[0]) ub[0] = b[0];
        if (b[1] < ub[1]) ub[1] = b[1];
        if (b[2] > ub[2]) ub[2] = b[2];
        if (b[3] > ub[3]) ub[3] = b[3];
      }
      if (!b) {
        // it could be anywhere: whatever else is in this frame, this is
        full = false;
        this.unknown = true;
        continue;
      }
      let hv = mix(0x811c9dc5, c[0]);
      for (let i = 1; i < c.length; i++) {
        if (i === sidAt) hv = mix(hv, this.state(c[i]).hash);
        else if (c[0] === 'I' && i === 1 && c[1][0] === 'c') {
          hv = mix(hv, this.lookup(c[1][1])?.version ?? -1);
        } else if (c[0] === 'I' && i === 1 && c[1][0] === 't') {
          hv = mix(hv, ++this.counter);
        } else if (c[0] === 'P' && i === 5) {
          hv = mix(hv, ++this.counter);
        } else hv = mix(hv, c[i]);
      }
      const x0 = Math.max(0, Math.floor((b[0] - 2) / TILE));
      const y0 = Math.max(0, Math.floor((b[1] - 2) / TILE));
      const x1 = Math.min(cols - 1, Math.floor((b[2] + 2) / TILE));
      const y1 = Math.min(rows - 1, Math.floor((b[3] + 2) / TILE));
      for (let ty = y0; ty <= y1; ty++)
        for (let tx = x0; tx <= x1; tx++) {
          const t = ty * cols + tx;
          sig[t] = Math.imul(sig[t] ^ hv, 16777619);
        }
    }
    return {
      sig,
      full,
      boxes,
      bounds: wipes || ub[0] > ub[2] ? null : ub,
      drew: started,
    };
  }
  private unknown = false;
  private counter = 0;

  private play(size: string, json: string): void {
    const [w, h] = size.split(',').map(Number);
    if (
      w !== this.width ||
      h !== this.height ||
      !(this.surface || this.layer)
    ) {
      this.open(w, h);
      this.prevSig = null;
    }
    const layer = this.layer;
    const ctx0 = this.ctx;
    if (!ctx0 && !layer) return;
    const cmds: Any[][] = JSON.parse(json);
    this.unknown = false;
    const plan = this.plan(cmds, w, h);
    // where this frame differs from the last, if it can be told
    let rect: number[] | null = null;
    let same = false;
    const prev = this.prevSig;
    if (plan.full && !this.unknown && prev && prev.length === plan.sig.length) {
      const cols = Math.ceil(w / TILE);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -1;
      let y1 = -1;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] === plan.sig[i]) continue;
        const tx = i % cols;
        const ty = (i - tx) / cols;
        if (tx < x0) x0 = tx;
        if (tx > x1) x1 = tx;
        if (ty < y0) y0 = ty;
        if (ty > y1) y1 = ty;
      }
      if (x1 < 0) same = true;
      else {
        rect = [
          x0 * TILE,
          y0 * TILE,
          Math.min(w, (x1 + 1) * TILE),
          Math.min(h, (y1 + 1) * TILE),
        ];
        if (rect[0] <= 0 && rect[1] <= 0 && rect[2] >= w && rect[3] >= h)
          rect = null;
      }
    }
    this.prevSig = plan.full && !this.unknown ? plan.sig : null;
    if (same || (!plan.full && !plan.drew && !this.unknown)) {
      // nothing it draws differs: what is there is what it would make
      for (const c of cmds) if (c[0] === 'K' || c[0] === 'U') this.one(ctx0, c);
      this.dirty = 'none';
      return;
    }
    const replay = (ctx: Any): void => {
      this.replay(ctx, cmds, plan, rect);
    };
    if (layer) {
      // every pixel drawn, or the frame before it carried over and the
      // changed tiles drawn on it
      layer.draw(
        (ctx) => {
          this.ctx = ctx;
          replay(ctx);
        },
        { full: !!plan.full && !rect && !this.unknown },
      );
      this.surface = layer.surface;
    } else replay(ctx0);
    this.finish(plan, rect, w, h);
  }

  private replay(
    ctx: Any,
    cmds: Any[][],
    plan: { boxes: Array<number[] | null> },
    rect: number[] | null,
  ): void {
    if (rect) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
      ctx.clip();
    }
    for (let n = 0; n < cmds.length; n++) {
      const c = cmds[n];
      if (rect) {
        const b = plan.boxes[n];
        if (
          b &&
          (b[2] + 2 < rect[0] ||
            b[0] - 2 > rect[2] ||
            b[3] + 2 < rect[1] ||
            b[1] - 2 > rect[3])
        )
          continue;
      }
      this.one(ctx, c);
    }
    if (rect) ctx.restore();
  }

  private finish(
    plan: { full: boolean; bounds: number[] | null },
    rect: number[] | null,
    w: number,
    h: number,
  ): void {
    this.version += 1;
    if (rect) this.dirty = rect;
    else if (!plan.full && plan.bounds && !this.unknown) {
      // not a frame of its own: what it drew is where it changed
      const b = plan.bounds;
      const x0 = Math.max(0, Math.floor(b[0] - 2));
      const y0 = Math.max(0, Math.floor(b[1] - 2));
      const x1 = Math.min(w, Math.ceil(b[2] + 2));
      const y1 = Math.min(h, Math.ceil(b[3] + 2));
      this.dirty =
        x1 <= x0 || y1 <= y0 || (x0 <= 0 && y0 <= 0 && x1 >= w && y1 >= h)
          ? null
          : [x0, y0, x1, y1];
    } else this.dirty = null;
  }

  /** What the last batch changed, once: 'none', a box, or null for all. */
  takeDirty(): number[] | null | 'none' {
    const d = this.dirty;
    this.dirty = null;
    return d === 'none' || d === null ? d : [...d, this.width, this.height];
  }

  private path(ctx: Any, cmds: number[], t: Matrix): void {
    ctx.beginPath();
    const px = (x: number, y: number) => t[0] * x + t[2] * y + t[4];
    const py = (x: number, y: number) => t[1] * x + t[3] * y + t[5];
    for (let i = 0; i < cmds.length;) {
      switch (cmds[i]) {
        case M:
          ctx.moveTo(
            px(cmds[i + 1], cmds[i + 2]),
            py(cmds[i + 1], cmds[i + 2]),
          );
          i += 3;
          break;
        case L:
          ctx.lineTo(
            px(cmds[i + 1], cmds[i + 2]),
            py(cmds[i + 1], cmds[i + 2]),
          );
          i += 3;
          break;
        case Q:
          ctx.quadraticCurveTo(
            px(cmds[i + 1], cmds[i + 2]),
            py(cmds[i + 1], cmds[i + 2]),
            px(cmds[i + 3], cmds[i + 4]),
            py(cmds[i + 3], cmds[i + 4]),
          );
          i += 5;
          break;
        case C:
          ctx.bezierCurveTo(
            px(cmds[i + 1], cmds[i + 2]),
            py(cmds[i + 1], cmds[i + 2]),
            px(cmds[i + 3], cmds[i + 4]),
            py(cmds[i + 3], cmds[i + 4]),
            px(cmds[i + 5], cmds[i + 6]),
            py(cmds[i + 5], cmds[i + 6]),
          );
          i += 7;
          break;
        default:
          ctx.closePath();
          i += 1;
      }
    }
  }

  private style(ctx: Any, desc: Any): string | object | null {
    if (!desc) return null;
    if (desc.rgba) return css(desc.rgba);
    let g: Any;
    if (desc.k === 'l') {
      g = ctx.createLinearGradient(desc.x0, desc.y0, desc.x1, desc.y1);
    } else if (desc.k === 'r') {
      g = ctx.createRadialGradient(
        desc.x0,
        desc.y0,
        desc.r0,
        desc.x1,
        desc.y1,
        desc.r1,
      );
    } else return null;
    for (const s of desc.stops)
      g.addColorStop(s[0], css([s[1], s[2], s[3], s[4]]));
    return g;
  }

  /** What every draw is under: the clips, the transform, alpha, operator. */
  private frame(
    ctx: Any,
    user: Matrix,
    clips: number[] | undefined,
    alpha: number,
    op: string,
    box?: number[] | null,
  ): boolean {
    ctx.save();
    if (clips) {
      for (const id of clips) {
        const c = this.clips.get(id);
        if (!c) continue;
        if (box && holds(c, box)) continue;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (c.kind === 'rect') {
          ctx.beginPath();
          ctx.rect(
            c.box[0],
            c.box[1],
            c.box[2] - c.box[0],
            c.box[3] - c.box[1],
          );
        } else this.path(ctx, c.cmds, c.m);
        ctx.clip(c.rule);
      }
    }
    if (!invert(user)) {
      ctx.restore();
      return false;
    }
    ctx.setTransform(user[0], user[1], user[2], user[3], user[4], user[5]);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
    return true;
  }

  private one(ctx: Any, c: Any[]): void {
    this.one2(ctx, c);
  }

  private one2(ctx: Any, c: Any[]): void {
    switch (c[0]) {
      case 'K':
      case 'D':
      case 'DX':
        // told to `plan` already
        return;
      case 'X':
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.restore();
        return;
      case 'U': {
        const [, id, w, h, b64] = c;
        const bytes = Buffer.from(b64, 'base64');
        this.images.set(
          id,
          new NtkImage({
            width: w,
            height: h,
            data: new Uint8ClampedArray(
              bytes.buffer,
              bytes.byteOffset,
              bytes.length,
            ),
          } as Any),
        );
        return;
      }
      case 'F': {
        const [, cmds, m, rule, sid] = c;
        const { desc, alpha, op, user, clips } = this.state(sid);
        const style = this.style(ctx, desc);
        if (!style) return;
        if (!this.frame(ctx, user, clips, alpha, op, pathBox(cmds, m))) return;
        const inv = invert(user)!;
        this.path(ctx, cmds, mul(inv, m));
        ctx.fillStyle = style;
        ctx.fill(rule);
        ctx.restore();
        return;
      }
      case 'FR': {
        const [, x, y, w, h, sid] = c;
        const { desc, alpha, op, user, clips } = this.state(sid);
        const style = this.style(ctx, desc);
        if (!style) return;
        if (!this.frame(ctx, user, clips, alpha, op, rectBox(x, y, w, h, user)))
          return;
        ctx.fillStyle = style;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
        return;
      }
      case 'CR': {
        const [, x, y, w, h, sid] = c;
        const { user, clips } = this.state(sid);
        if (
          !this.frame(
            ctx,
            user,
            clips,
            1,
            'source-over',
            rectBox(x, y, w, h, user),
          )
        )
          return;
        ctx.clearRect(x, y, w, h);
        ctx.restore();
        return;
      }
      case 'S': {
        const [, cmds, m, st, sid] = c;
        const { desc, alpha, op, user, clips } = this.state(sid);
        const style = this.style(ctx, desc);
        if (!style) return;
        const pb = pathBox(cmds, m);
        if (pb) {
          const grow =
            st[0] *
            Math.max(st[3], 2) *
            Math.max(1, Math.abs(user[0]), Math.abs(user[3]));
          pb[0] -= grow;
          pb[1] -= grow;
          pb[2] += grow;
          pb[3] += grow;
        }
        if (!this.frame(ctx, user, clips, alpha, op, pb)) return;
        const inv = invert(user)!;
        this.path(ctx, cmds, mul(inv, m));
        ctx.strokeStyle = style;
        ctx.lineWidth = st[0];
        ctx.lineCap = st[1];
        ctx.lineJoin = st[2];
        ctx.miterLimit = st[3];
        ctx.setLineDash(st[4]);
        ctx.lineDashOffset = st[5];
        ctx.stroke();
        ctx.restore();
        return;
      }
      case 'T': {
        const [, text, font, align, base, x, y, max, stroke, lw, sid] = c;
        const { desc, alpha, op, user, clips } = this.state(sid);
        const style = this.style(ctx, desc);
        if (!style) return;
        if (!this.frame(ctx, user, clips, alpha, op)) return;
        ctx.font = font;
        ctx.textAlign = align;
        ctx.textBaseline = base;
        if (stroke) {
          ctx.strokeStyle = style;
          ctx.lineWidth = lw;
          ctx.strokeText(text, x, y, max ?? undefined);
        } else {
          ctx.fillStyle = style;
          ctx.fillText(text, x, y, max ?? undefined);
        }
        ctx.restore();
        return;
      }
      case 'I': {
        const [, src, sx, sy, sw, sh, dx, dy, dw, dh, smooth, sid] = c;
        const { alpha, op, user, clips } = this.state(sid);
        let image: Any;
        if (src[0] === 'c') {
          image = this.lookup(src[1])?.ensure() ?? null;
        } else if (src[0] === 'u') {
          image = this.images.get(src[1]);
        } else {
          const bytes = Buffer.from(src[3], 'base64');
          image = new NtkImage({
            width: src[1],
            height: src[2],
            data: new Uint8ClampedArray(
              bytes.buffer,
              bytes.byteOffset,
              bytes.length,
            ),
          } as Any);
        }
        if (!image) return;
        if (
          !this.frame(
            ctx,
            user,
            clips,
            alpha,
            op,
            rectBox(dx, dy, dw, dh, user),
          )
        )
          return;
        ctx.imageSmoothingEnabled = !!smooth;
        ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
        ctx.restore();
        return;
      }
      case 'P': {
        const [, x, y, w, h, b64] = c;
        const bytes = Buffer.from(b64, 'base64');
        ctx.putImageData(
          {
            data: new Uint8ClampedArray(
              bytes.buffer,
              bytes.byteOffset,
              bytes.length,
            ),
            width: w,
            height: h,
          },
          x,
          y,
        );
        return;
      }
    }
  }

  /** Pixels as straight RGBA, base64, read now. Needs react-x11's
   *  `readPixels` on the context (a core with it): without it a canvas
   *  cannot be read back, and says so once. */
  read(x: number, y: number, w: number, h: number): string {
    this.ensure();
    const ctx = this.ctx;
    if (!ctx) return '';
    if (typeof ctx.readPixels !== 'function') {
      if (!warned) {
        warned = true;
        (globalThis as Any).console?.warn(
          'react-x11-components: REACT_X11_NATIVE_CANVAS needs a react-x11 whose 2d context has readPixels',
        );
      }
      return '';
    }
    const { data } = ctx.readPixels(x, y, w, h) as { data: Uint8ClampedArray };
    return Buffer.from(data.buffer, data.byteOffset, data.length).toString(
      'base64',
    );
  }
}

let warned = false;

declare const Buffer: Any;
