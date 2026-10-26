// A page's media sources on the host's side: the devices its
// `getUserMedia` opens over `HtmlScripts.mediaDevices`, a canvas a
// `captureStream()` captures, and a peer connection receiver's (`peers.ts`
// registers those), each a number the page's tracks are over
// (`mediastream.ts`, the `md…` ops and `__md…` entries).
//
// Only primitives cross: a source is a number, what an entry is handed is
// JSON, and an error is its name and its message, which the page's realm
// makes into its own `DOMException`. A device's id never reaches the page:
// it is handed a digest of the id and its origin, as a browser keeps one
// site's ids apart from another's. And a device's label, its id and what it
// can do are kept from a page that has not been allowed its kind.

import { NO_MEDIA_DEVICES, mediaError } from '../media-devices.js';
import type {
  HtmlMediaDevices,
  MediaDeviceCapabilities,
  MediaDeviceDescription,
  MediaSettings,
  MediaSourceEvents,
  MediaSourceLike,
} from '../media-devices.js';
import type { CanvasPixels } from './host.js';

type Primitive = string | number | boolean | null | undefined;

/** What the page's sources are opened over, and how the page is told. */
export interface SourceSeams {
  /** The seam, read as each request is made. */
  devices(): HtmlMediaDevices | undefined;
  /** The page's origin, which a device's id is digested with. */
  origin(): string;
  /** An entry of the page's, with its input. */
  tell(entry: string, input: unknown): void;
  /** The canvas an element's number names, as a `captureStream()` reads
   *  it, or null where it names none. */
  canvas?(element: number): CanvasFeed | null;
}

/** A canvas's pixels as the host has them, and when they change. */
export interface CanvasFeed {
  /** Its pixels, or null before a script drew any. */
  pixels(): CanvasPixels | null;
  /** Tells `changed` at each change, until the function it answers is
   *  called. */
  watch(changed: () => void): () => void;
}

/** A canvas's source, which a `requestFrame()` asks a frame of. */
export interface CanvasSource extends MediaSourceLike {
  requestFrame(): void;
}

interface Held {
  source: MediaSourceLike;
  /** The page's tracks over it, which stop it as the last of them goes. */
  tracks: number;
}

/** A device's id as one origin sees it: 64 hex digits, as Chrome's are. It
 *  keeps two origins apart and is no secret, so FNV-1a over four seeds is
 *  enough. */
function digest(origin: string, id: string): string {
  const text = `${origin}\n${id}`;
  let out = '';
  for (const seed of [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]) {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    for (let round = 0; round < 2; round++) {
      h ^= h >>> 15;
      h = Math.imul(h, 0x2c1b3c6d) >>> 0;
      out += h.toString(16).padStart(8, '0');
    }
  }
  return out;
}

const NUMBERS = [
  'width',
  'height',
  'aspectRatio',
  'frameRate',
  'sampleRate',
  'sampleSize',
  'channelCount',
  'latency',
] as const;
const BOOLEANS = [
  'echoCancellation',
  'autoGainControl',
  'noiseSuppression',
] as const;

type Constraint = Record<string, unknown>;

/** The settings a kind's constraints come to on a device, or the name of
 *  the one it cannot meet. */
function settingsFor(
  constraint: Constraint,
  device: MediaDeviceDescription,
): MediaSettings | string {
  const out: MediaSettings = { ...device.defaults };
  const caps = device.capabilities;
  for (const key of NUMBERS) {
    const c = constraint[key];
    if (c === undefined) continue;
    const range = caps[key];
    const o = (typeof c === 'object' && c ? c : {}) as Record<string, unknown>;
    const exact = typeof c === 'number' ? undefined : o.exact;
    const min = typeof o.min === 'number' ? o.min : undefined;
    const max = typeof o.max === 'number' ? o.max : undefined;
    if (range) {
      if (typeof exact === 'number' && (exact < range.min || exact > range.max))
        return key;
      if (min !== undefined && min > range.max) return key;
      if (max !== undefined && max < range.min) return key;
    }
    let value =
      typeof c === 'number'
        ? c
        : typeof exact === 'number'
          ? exact
          : typeof o.ideal === 'number'
            ? o.ideal
            : undefined;
    if (value === undefined) continue;
    if (min !== undefined) value = Math.max(min, value);
    if (max !== undefined) value = Math.min(max, value);
    if (range) value = Math.min(range.max, Math.max(range.min, value));
    out[key] = value;
  }
  for (const key of BOOLEANS) {
    const c = constraint[key];
    const value =
      typeof c === 'boolean'
        ? c
        : typeof c === 'object' && c
          ? ((c as Record<string, unknown>).exact ??
            (c as Record<string, unknown>).ideal)
          : undefined;
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export class PageSources {
  private readonly _held = new Map<number, Held>();
  private readonly _ids = new Map<MediaSourceLike, number>();
  private _seq = 0;
  /** The kinds a `getUserMedia` of this document was allowed. */
  private readonly _granted = { camera: false, microphone: false };
  private _disposed = false;

  constructor(private readonly _seams: SourceSeams) {}

  /** A source the page's tracks are over: numbered, and listened to for
   *  its muted state and its end, once. */
  register(source: MediaSourceLike): number {
    const known = this._ids.get(source);
    if (known !== undefined) {
      const held = this._held.get(known);
      if (held) held.tracks += 1;
      return known;
    }
    const id = ++this._seq;
    this._ids.set(source, id);
    this._held.set(id, { source, tracks: 1 });
    source.listen({
      muted: (muted) =>
        this._tell('__mdSource', [id, muted ? 'muted' : 'unmuted']),
      ended: () => this._tell('__mdSource', [id, 'ended']),
    });
    return id;
  }

  /** A source by its number, while a track is over it. */
  get(id: number): MediaSourceLike | null {
    return this._held.get(id)?.source ?? null;
  }

  /** An op of the facade's whose name starts with `md`. */
  op(op: string, a: Primitive, b: Primitive): Primitive {
    const text = (v: Primitive): string => (typeof v === 'string' ? v : '');
    switch (op) {
      case 'mdClone': {
        const held = this._held.get(Number(a));
        if (held) held.tracks += 1;
        return null;
      }
      case 'mdStop': {
        const id = Number(a);
        const held = this._held.get(id);
        if (!held) return null;
        held.tracks -= 1;
        if (held.tracks <= 0) {
          this._held.delete(id);
          this._ids.delete(held.source);
          held.source.stop();
        }
        return null;
      }
      case 'mdCanvas': {
        const feed = this._seams.canvas?.(Number(a)) ?? null;
        if (!feed) return null;
        const rate = typeof b === 'string' && b !== '' ? Number(b) : null;
        return this.register(canvasSource(feed, rate));
      }
      case 'mdRequestFrame': {
        const source = this._held.get(Number(a))?.source as
          Partial<CanvasSource> | undefined;
        source?.requestFrame?.();
        return null;
      }
      case 'mdDevices':
        void this._devices(Number(a));
        return null;
      case 'mdGetUserMedia':
        void this._getUserMedia(Number(a), text(b));
        return null;
      default:
        return null;
    }
  }

  /** The document goes: every source it opened is stopped. */
  dispose(): void {
    this._disposed = true;
    for (const held of this._held.values()) {
      try {
        held.source.stop();
      } catch {}
    }
    this._held.clear();
    this._ids.clear();
  }

  private _tell(entry: string, input: unknown): void {
    if (!this._disposed) this._seams.tell(entry, input);
  }

  private _seam(): HtmlMediaDevices {
    return this._seams.devices() ?? NO_MEDIA_DEVICES;
  }

  private _allowed(name: 'camera' | 'microphone'): boolean {
    return (
      this._granted[name] ||
      this._seam().permission?.(name, this._seams.origin()) === 'granted'
    );
  }

  private async _devices(req: number): Promise<void> {
    const origin = this._seams.origin();
    try {
      const list = await this._seam().devices();
      const shown: unknown[] = [];
      const kinds = new Set<string>();
      for (const d of list) {
        const name = d.kind === 'videoinput' ? 'camera' : 'microphone';
        if (this._allowed(name)) {
          shown.push({
            deviceId: digest(origin, d.deviceId),
            groupId: digest(origin, d.groupId),
            kind: d.kind,
            label: d.label,
            capabilities: d.kind === 'audiooutput' ? undefined : d.capabilities,
          });
        } else if (!kinds.has(d.kind)) {
          // what a page not allowed the kind is shown: that there is one
          kinds.add(d.kind);
          shown.push({ deviceId: '', groupId: '', kind: d.kind, label: '' });
        }
      }
      this._tell('__mdSettled', [req, true, shown]);
    } catch (error) {
      this._tell('__mdSettled', [req, false, errorOf(error)]);
    }
  }

  private async _getUserMedia(req: number, json: string): Promise<void> {
    const origin = this._seams.origin();
    const fail = (error: unknown) =>
      this._tell('__mdSettled', [req, false, errorOf(error)]);
    let asked: { audio: unknown; video: unknown };
    try {
      asked = JSON.parse(json) as { audio: unknown; video: unknown };
    } catch {
      fail(mediaError('AbortError', 'The request could not be read.'));
      return;
    }
    const seam = this._seam();
    const wants: ['audio' | 'video', Constraint][] = [];
    if (asked.audio) wants.push(['audio', asConstraint(asked.audio)]);
    if (asked.video) wants.push(['video', asConstraint(asked.video)]);
    try {
      const list = await seam.devices();
      const chosen: [
        'audio' | 'video',
        MediaDeviceDescription,
        MediaSettings,
      ][] = [];
      for (const [kind, constraint] of wants) {
        const found = chooseDevice(list, kind, constraint, origin);
        if (typeof found === 'string') {
          throw mediaError(
            found === 'deviceId' ? 'OverconstrainedError' : 'NotFoundError',
            found === 'deviceId'
              ? 'No device has the id asked for.'
              : `There is no ${kind === 'audio' ? 'microphone' : 'camera'}.`,
            found === 'deviceId' ? 'deviceId' : undefined,
          );
        }
        const settings = settingsFor(constraint, found);
        if (typeof settings === 'string') {
          throw mediaError(
            'OverconstrainedError',
            `The ${kind} device cannot meet ${settings}.`,
            settings,
          );
        }
        chosen.push([kind, found, settings]);
      }
      const allowed = seam.request
        ? await seam.request({
            origin,
            camera: chosen.some(([k]) => k === 'video'),
            microphone: chosen.some(([k]) => k === 'audio'),
            display: false,
          })
        : true;
      if (!allowed) throw mediaError('NotAllowedError', 'Permission denied.');
      const tracks: unknown[] = [];
      const opened: MediaSourceLike[] = [];
      try {
        for (const [kind, device, settings] of chosen) {
          const source = await seam.open(device.deviceId, settings);
          opened.push(source);
          const ids = {
            deviceId: digest(origin, device.deviceId),
            groupId: digest(origin, device.groupId),
          };
          tracks.push({
            source: 0,
            kind,
            label: source.label || device.label,
            settings: { ...source.settings(), ...ids },
            capabilities: { ...capabilitiesOf(source.capabilities()), ...ids },
          });
        }
      } catch (error) {
        for (const source of opened) source.stop();
        throw error;
      }
      if (this._disposed) {
        for (const source of opened) source.stop();
        return;
      }
      opened.forEach((source, i) => {
        (tracks[i] as { source: number }).source = this.register(source);
      });
      for (const [kind] of chosen) {
        this._granted[kind === 'video' ? 'camera' : 'microphone'] = true;
      }
      this._tell('__mdSettled', [req, true, tracks]);
    } catch (error) {
      fail(error);
    }
  }
}

declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

/**
 * A canvas's frames (Media Capture from DOM Elements, 3.1): one each time
 * its pixels change where no rate was given, at most `rate` a second where
 * one was, and only at `requestFrame()` where it is 0. A frame is made only
 * where something reads frames, from the host's copy of the canvas's
 * pixels, converted to I420.
 */
export function canvasSource(
  feed: CanvasFeed,
  rate: number | null,
): CanvasSource {
  let events: MediaSourceEvents | null = null;
  let unwatch: (() => void) | null = null;
  let stopped = false;
  let last = -Infinity;
  let waiting: unknown = null;
  let asked = false;
  const start = Date.now();

  const emit = () => {
    const pixels = feed.pixels();
    if (!events?.video || !pixels || stopped) return;
    last = Date.now();
    events.video({
      ...i420Of(pixels),
      timestamp: (last - start) * 1000,
    });
  };
  const changed = () => {
    if (stopped) return;
    if (rate === null) emit();
    else if (rate === 0) {
      if (asked) {
        asked = false;
        emit();
      }
    } else if (waiting === null) {
      const due = last + 1000 / rate - Date.now();
      if (due <= 0) emit();
      else {
        waiting = setTimeout(() => {
          waiting = null;
          emit();
        }, due);
        (waiting as { unref?(): void }).unref?.();
      }
    }
  };

  return {
    kind: 'video',
    label: '',
    listen(next) {
      events = next;
      if (stopped) return;
      next.muted(false);
      unwatch = feed.watch(changed);
      if (events.video) emit();
    },
    settings() {
      const pixels = feed.pixels();
      const size = pixels ? { width: pixels.width, height: pixels.height } : {};
      return rate === null ? size : { ...size, frameRate: rate };
    },
    capabilities: () => ({}),
    reconfigure: () => Promise.resolve(false),
    requestFrame() {
      if (stopped) return;
      if (rate === 0) asked = true;
      emit();
    },
    stop() {
      stopped = true;
      unwatch?.();
      unwatch = null;
      if (waiting !== null) clearTimeout(waiting);
      waiting = null;
    },
  };
}

/**
 * Straight RGBA as I420, BT.601 at video range, as a browser's canvas
 * capture converts it: each chroma sample the mean of the two-by-two
 * pixels it covers, an odd size's last row and column rounded up.
 */
export function i420Of(pixels: CanvasPixels): {
  width: number;
  height: number;
  planes: [Uint8Array, Uint8Array, Uint8Array];
  strides: [number, number, number];
} {
  const { width, height, data } = pixels;
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  const y = new Uint8Array(width * height);
  const cb = new Uint8Array(cw * ch);
  const cr = new Uint8Array(cw * ch);
  for (let row = 0; row < height; row++) {
    for (let x = 0; x < width; x++) {
      const i = (row * width + x) * 4;
      y[row * width + x] =
        (16 +
          (65.738 * data[i] + 129.057 * data[i + 1] + 25.064 * data[i + 2]) /
            256 +
          0.5) |
        0;
    }
  }
  for (let row = 0; row < ch; row++) {
    for (let x = 0; x < cw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < 2; dy++) {
        const py = row * 2 + dy;
        if (py >= height) continue;
        for (let dx = 0; dx < 2; dx++) {
          const px = x * 2 + dx;
          if (px >= width) continue;
          const i = (py * width + px) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      cb[row * cw + x] =
        (128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256 + 0.5) | 0;
      cr[row * cw + x] =
        (128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256 + 0.5) | 0;
    }
  }
  return { width, height, planes: [y, cb, cr], strides: [width, cw, cw] };
}

function asConstraint(c: unknown): Constraint {
  return typeof c === 'object' && c ? (c as Constraint) : {};
}

/** A device's capabilities, as `getCapabilities()` answers them. */
function capabilitiesOf(
  caps: MediaDeviceCapabilities,
): Record<string, unknown> {
  return { ...caps };
}

/** The device a kind's constraints take: the first of the kind, or the
 *  first whose id they name; or why there is none. */
function chooseDevice(
  list: MediaDeviceDescription[],
  kind: 'audio' | 'video',
  constraint: Constraint,
  origin: string,
): MediaDeviceDescription | 'none' | 'deviceId' {
  const wanted = kind === 'audio' ? 'audioinput' : 'videoinput';
  const of = list.filter((d) => d.kind === wanted);
  if (!of.length) return 'none';
  const c = constraint.deviceId;
  const named = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.map(String) : [];
  const exact =
    typeof c === 'object' && c && !Array.isArray(c)
      ? named((c as Record<string, unknown>).exact)
      : [];
  const ideal =
    typeof c === 'object' && c && !Array.isArray(c)
      ? named((c as Record<string, unknown>).ideal)
      : named(c);
  if (exact.length) {
    return (
      of.find((d) => exact.includes(digest(origin, d.deviceId))) ?? 'deviceId'
    );
  }
  return of.find((d) => ideal.includes(digest(origin, d.deviceId))) ?? of[0];
}

/** An error as it crosses to the page: its name and its message. */
function errorOf(error: unknown): {
  name: string;
  message: string;
  constraint?: string;
} {
  const e = error as {
    name?: unknown;
    message?: unknown;
    constraint?: unknown;
  };
  return {
    name: typeof e?.name === 'string' && e.name ? e.name : 'AbortError',
    message: String(e?.message ?? error),
    ...(typeof e?.constraint === 'string' ? { constraint: e.constraint } : {}),
  };
}
