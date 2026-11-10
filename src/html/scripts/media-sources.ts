// A page's media sources on the host's side: the devices its
// `getUserMedia` opens over `HtmlScripts.mediaDevices`, a canvas a
// `captureStream()` captures, a Web Audio stream destination's synth
// (`webaudio.ts`), and a peer connection receiver's (`peers.ts` registers
// those), each a number the page's tracks are over (`mediastream.ts`, the
// `md…` ops and `__md…` entries).
//
// Only primitives cross: a source is a number, what an entry is handed is
// JSON, and an error is its name and its message, which the page's realm
// makes into its own `DOMException`. A device's id never reaches the page:
// it is handed a digest of the id and its origin, as a browser keeps one
// site's ids apart from another's. And a device's label, its id and what it
// can do are kept from a page that has not been allowed its kind.

import {
  NO_MEDIA_DEVICES,
  copyFrame,
  frameToRgba,
  mediaError,
} from '../media-devices.js';
import type {
  HtmlMediaDevices,
  MediaAudioData,
  MediaDeviceCapabilities,
  MediaDeviceDescription,
  MediaSettings,
  MediaSourceEvents,
  MediaSourceLike,
  MediaVideoFrame,
  ShownSource,
} from '../media-devices.js';
import type { CanvasPixels } from './host.js';
import { selectSettings } from './constraints.js';
import type { Constrainable, ConstraintSet } from './constraints.js';
import type { BufferClass } from './platform.js';

declare const Buffer: BufferClass;

type Primitive = string | number | boolean | null | undefined;

/** What the page's sources are opened over, and how the page is told. */
export interface SourceSeams {
  /** The seam, read as each request is made. */
  devices(): HtmlMediaDevices | undefined;
  /** The page's origin, which a device's id is digested with. */
  origin(): string;
  /** Whether it has none anyone could be asked to trust (`DomHost.originless`):
   *  a user is asked about an origin, and a device's id would be one for every
   *  sandbox. */
  originless(): boolean;
  /** An entry of the page's, with its input. */
  tell(entry: string, input: unknown): void;
  /** Whether the user has granted the document a camera or a microphone,
   *  which lets it be told of that kind's devices before it captures
   *  (Media Capture, "device information can be exposed"). Absent, none is. */
  granted?(name: 'camera' | 'microphone'): boolean;
  /** Whether the document may use a camera or a microphone (Permissions
   *  Policy). Absent, it may. */
  allowed?(name: 'camera' | 'microphone'): boolean;
  /** The canvas an element's number names, as a `captureStream()` reads
   *  it, or null where it names none. */
  canvas?(element: number): CanvasFeed | null;
  /** A media element's audio goes to an `audiooutput` device from now on,
   *  by its host id, or to the default for `''`. */
  sink?(element: number, deviceId: string): void;
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
  /** What reads its frames host-side (`read`): a `VideoFrames` sink, an
   *  audio sink, the size watch. The source is listened to with `video` or
   *  `audio` only while there is one. */
  readers: Set<(frame: MediaVideoFrame | MediaAudioData) => void>;
  /** The page's media elements watching its size (`mdSize`). */
  sized: number;
  /** The size the page was last told, as `width x height`, or ''. */
  size: string;
  /** The size watch's own reader, while there is one. */
  unsize: (() => void) | null;
  /** Its last muted state, which a reader that comes is told of. */
  muted: boolean;
  /** Its newest video frame, while something reads its frames: what a
   *  reader that comes is handed first, since a canvas that is never drawn
   *  on again gives no other. */
  last: MediaVideoFrame | null;
  ended: boolean;
  /** Video frames it has handed out, and when it was registered: what a
   *  `<video>`'s `getVideoPlaybackQuality()` counts. */
  frames: number;
  since: number;
  /** The page's media elements whose canvases may draw it (`mdKeep`), and
   *  while there are any, the reader that holds a copy of its newest frame
   *  for them (`kept`, by `frames`), which `mdPixels` answers from. */
  keeps: number;
  unkeep: (() => void) | null;
  kept: MediaVideoFrame | null;
  keptAt: number;
  /** `kept` as RGBA, and the frame it was made from. */
  rgba: Uint8ClampedArray | null;
  rgbaAt: number;
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

export class PageSources {
  private readonly _held = new Map<number, Held>();
  private readonly _ids = new Map<MediaSourceLike, number>();
  private _seq = 0;
  /** The kinds of device this document may be told about, since a
   *  `getUserMedia` of them succeeded. */
  private readonly _exposed = { audio: false, video: false };
  /** What each source a `getUserMedia` opened is, as its constraints are
   *  fitted to it: what `applyConstraints` sets it with. A source with
   *  none is held to what it runs at (`fixed`); one that can be set
   *  otherwise — a screen, say — has a view of its own, with no device
   *  id. */
  private readonly _views = new Map<number, Constrainable>();
  /** A display's picture as it was picked, by its source's number: what
   *  its `applyConstraints` fits a size to, as `getDisplayMedia` did. */
  private readonly _displays = new Map<number, MediaSettings>();
  /** What makes this document's group ids its own. */
  private readonly _salt = `${Date.now()}.${Math.random()}`;
  /** The `applyConstraints` under way, one after another. */
  private _applying: Promise<void> = Promise.resolve();
  private _disposed = false;

  constructor(private readonly _seams: SourceSeams) {}

  /** A source the page's tracks are over: numbered, and listened to for
   *  its muted state and its end, and for its frames while something
   *  reads them (`read`). */
  register(source: MediaSourceLike): number {
    const known = this._ids.get(source);
    if (known !== undefined) {
      const held = this._held.get(known);
      if (held) held.tracks += 1;
      return known;
    }
    const id = ++this._seq;
    this._ids.set(source, id);
    const held: Held = {
      source,
      tracks: 1,
      readers: new Set(),
      sized: 0,
      size: '',
      unsize: null,
      muted: false,
      ended: false,
      last: null,
      frames: 0,
      since: Date.now(),
      keeps: 0,
      unkeep: null,
      kept: null,
      keptAt: 0,
      rgba: null,
      rgbaAt: -1,
    };
    this._held.set(id, held);
    this._listen(id, held);
    return id;
  }

  /** A source by its number, while a track is over it. */
  get(id: number): MediaSourceLike | null {
    return this._held.get(id)?.source ?? null;
  }

  /**
   * A source's frames, to `fn`, until the function it answers is called:
   * one listener on the source however many read it, and frames asked of
   * it only while any does. Nothing is read of a source no track is over.
   */
  read(
    id: number,
    fn: (frame: MediaVideoFrame | MediaAudioData) => void,
  ): () => void {
    const held = this._held.get(id);
    if (!held || held.ended) return () => {};
    held.readers.add(fn);
    if (held.readers.size === 1) this._listen(id, held);
    else if (held.last) fn(held.last);
    return () => {
      if (!held.readers.delete(fn)) return;
      if (held.readers.size === 0 && this._held.get(id) === held) {
        held.last = null;
        this._listen(id, held);
      }
    };
  }

  /**
   * A source as a peer connection's sender reads it (`peers.ts`): a source
   * of its own whose `listen` reads frames through `read`, as one reader
   * among the others, and whose `stop` stops only that, where the source's
   * own `listen` would take it from the host and its `stop` would end it for
   * every track. Null where no track is over the number.
   */
  tap(id: number): MediaSourceLike | null {
    const held = this._held.get(id);
    if (!held) return null;
    const { source } = held;
    let off: (() => void) | null = null;
    return {
      kind: source.kind,
      label: source.label,
      listen: (events) => {
        off?.();
        off = null;
        const video = source.kind === 'video' ? events.video : undefined;
        const audio = source.kind === 'audio' ? events.audio : undefined;
        if (video) {
          off = this.read(id, (frame) => video(frame as MediaVideoFrame));
        } else if (audio) {
          off = this.read(id, (data) => audio(data as MediaAudioData));
        }
      },
      settings: () => source.settings(),
      capabilities: () => source.capabilities(),
      reconfigure: () => Promise.resolve(false),
      stop: () => {
        off?.();
        off = null;
      },
    };
  }

  /** A source as `<Html>` mounts it over a media element, or null where no
   *  track is over it any more. */
  shown(id: number, enabled: boolean): ShownSource | null {
    const held = this._held.get(id);
    if (!held) return null;
    const { source } = held;
    return {
      kind: source.kind,
      id,
      enabled,
      present: () => source.present?.() ?? null,
      read: (fn) => this.read(id, fn),
      settings: () => source.settings(),
    };
  }

  /** What an `AnalyserNode` hears of each audio source, by its number:
   *  the last samples it gave, a channel's mean, kept while a page asks. */
  private readonly _taps = new Map<
    number,
    {
      ring: Float32Array;
      at: number;
      filled: number;
      asked: number;
      off(): void;
    }
  >();

  /**
   * The newest `count` samples an audio source gave, mono, oldest first, as
   * base64 of their float32s: what a page's `AnalyserNode` reads
   * (`webaudio.ts`). Its chunks are kept from the first ask, and let go once
   * no page has asked for three seconds; '' until any has come.
   */
  private _samples(id: number, count: number): string {
    const held = this._held.get(id);
    if (!held || held.source.kind !== 'audio') return '';
    const n = Math.max(0, Math.min(32768, Math.floor(count) || 0));
    let tap = this._taps.get(id);
    if (!tap) {
      const made = {
        ring: new Float32Array(32768),
        at: 0,
        filled: 0,
        asked: Date.now(),
        off: () => {},
      };
      tap = made;
      this._taps.set(id, made);
      made.off = this.read(id, (data) => {
        const chunk = data as MediaAudioData;
        if (Date.now() - made.asked > 3000) {
          made.off();
          this._taps.delete(id);
          return;
        }
        const { ring } = made;
        const channels = chunk.channels.length || 1;
        for (let i = 0; i < chunk.frames; i++) {
          let v = 0;
          for (const c of chunk.channels) v += c[i] ?? 0;
          ring[made.at] = v / channels;
          made.at = (made.at + 1) % ring.length;
        }
        made.filled = Math.min(ring.length, made.filled + chunk.frames);
      });
    }
    tap.asked = Date.now();
    if (!tap.filled || !n) return '';
    const out = new Float32Array(n);
    const have = Math.min(n, tap.filled);
    const { ring } = tap;
    for (let i = 0; i < have; i++) {
      out[n - have + i] = ring[(tap.at - have + i + ring.length) % ring.length];
    }
    return Buffer.from(out.buffer, 0, out.byteLength).toString('base64');
  }

  /** What the source is listened to with: its frames handed to every
   *  reader where there is one. */
  private _listen(id: number, held: Held): void {
    const fan = (frame: MediaVideoFrame | MediaAudioData) => {
      if (held.source.kind === 'video') {
        held.last = frame as MediaVideoFrame;
        held.frames += 1;
      }
      for (const read of [...held.readers]) read(frame);
    };
    const reading = held.readers.size > 0;
    held.source.listen({
      muted: (muted) => {
        if (held.ended || held.muted === muted) return;
        held.muted = muted;
        this._tell('__mdSource', [id, muted ? 'muted' : 'unmuted']);
      },
      ended: () => {
        if (held.ended) return;
        held.ended = true;
        held.readers.clear();
        held.last = null;
        this._tell('__mdSource', [id, 'ended']);
      },
      changed: () => this._sizeFrom(id, held, held.source.settings()),
      ...(reading &&
        (held.source.kind === 'video'
          ? { video: fan as (frame: MediaVideoFrame) => void }
          : { audio: fan as (data: MediaAudioData) => void })),
    });
  }

  /**
   * The page's media elements watch a video source's size (`mdSize`): told
   * as `__mdSource [id, 'size', width, height]` once it is known and each
   * time it changes. A source that shows itself (`present`) says its size
   * in its settings, and its frames are not read for it, since a camera's
   * would have to cross into JavaScript; any other is read, since a canvas
   * that is never drawn on has no size to tell.
   */
  private _watchSize(id: number, on: boolean): void {
    const held = this._held.get(id);
    if (!held || held.source.kind !== 'video') return;
    held.sized = Math.max(0, held.sized + (on ? 1 : -1));
    if (held.sized === 0) {
      held.unsize?.();
      held.unsize = null;
      held.size = '';
      return;
    }
    if (held.unsize) {
      // a watcher that comes is told what the others were, a task later
      if (held.size) {
        const [w, h] = held.size.split('x').map(Number);
        const later = setTimeout(() => {
          if (this._held.get(id) === held && held.size === `${w}x${h}`) {
            this._tell('__mdSource', [id, 'size', w, h]);
          }
        }, 0);
        (later as { unref?(): void }).unref?.();
      }
      return;
    }
    // begun a task later, as anything the page's op asked for is told: the
    // page is in the middle of the op, and a source may hand a reader its
    // frame as it is first read
    let off: (() => void) | null = null;
    let stopped = false;
    held.unsize = () => {
      stopped = true;
      off?.();
    };
    const later = setTimeout(() => {
      if (stopped || this._held.get(id) !== held) return;
      // a source that shows itself says its size in its settings, and its
      // frames are not read for it
      if (held.source.present?.()) {
        this._sizeFrom(id, held, held.source.settings(), true);
        return;
      }
      off = this.read(id, (frame) => {
        this._sizeFrom(id, held, frame as MediaVideoFrame);
      });
    }, 0);
    (later as { unref?(): void }).unref?.();
  }

  private _sizeFrom(
    id: number,
    held: Held,
    at: { width?: number; height?: number },
    told = false,
  ): void {
    if (!held.unsize) return;
    const { width, height } = at;
    if (!(width! > 0 && height! > 0)) return;
    const size = `${width}x${height}`;
    if (size === held.size && !told) return;
    held.size = size;
    this._tell('__mdSource', [id, 'size', width, height]);
  }

  /**
   * A media element of the page's that shows a video source, and could
   * draw it on a canvas, comes (`on`) or goes: while any is there, a copy
   * of the source's newest frame is held, since `drawImage` has to have it
   * in hand as it is asked and no source hands one over on demand. A
   * camera's frames cross into JavaScript for it, which is why only a
   * realm with a canvas asks.
   */
  private _keep(id: number, on: boolean): void {
    const held = this._held.get(id);
    if (!held || held.source.kind !== 'video') return;
    held.keeps = Math.max(0, held.keeps + (on ? 1 : -1));
    if (held.keeps && !held.unkeep) {
      held.unkeep = this.read(id, (frame) => {
        held.kept = copyFrame(frame as MediaVideoFrame, held.kept);
        held.keptAt = held.frames;
      });
    } else if (!held.keeps && held.unkeep) {
      held.unkeep();
      held.unkeep = null;
      held.kept = held.rgba = null;
      held.rgbaAt = -1;
    }
  }

  /**
   * The newest frame of a video source held for the page's canvases, as
   * `frames,width,height|` and its RGBA in base64; the count alone where it
   * is the frame `known` says the page has; '' where none is held.
   */
  private _pixels(id: number, known: string): string {
    const held = this._held.get(id);
    const frame = held?.kept;
    if (!held || !frame) return '';
    const at = String(held.keptAt);
    if (at === known) return at;
    if (held.rgbaAt !== held.keptAt) {
      held.rgba = frameToRgba(frame, held.rgba ?? undefined);
      held.rgbaAt = held.keptAt;
    }
    const rgba = held.rgba!;
    const base64 = Buffer.from(
      rgba.buffer,
      rgba.byteOffset,
      rgba.byteLength,
    ).toString('base64');
    return `${at},${frame.width},${frame.height}|${base64}`;
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
          this._views.delete(id);
          this._displays.delete(id);
          this._ids.delete(held.source);
          held.readers.clear();
          held.unsize?.();
          held.unsize = null;
          held.unkeep?.();
          held.unkeep = null;
          held.last = held.kept = null;
          held.rgba = null;
          held.source.stop();
        }
        return null;
      }
      case 'mdSize':
        this._watchSize(Number(a), b === true);
        return null;
      case 'mdKeep':
        this._keep(Number(a), b === true);
        return null;
      case 'mdPixels':
        return this._pixels(Number(a), text(b));
      case 'mdSamples':
        return this._samples(Number(a), Number(b));
      case 'mdFrames': {
        // the frames a video source has handed out; one that shows itself
        // is not read, and has had its rate's worth since it began
        const held = this._held.get(Number(a));
        if (!held) return 0;
        if (held.source.present?.()) {
          const rate = held.source.settings().frameRate ?? 30;
          return Math.floor(((Date.now() - held.since) / 1000) * rate);
        }
        return held.frames;
      }
      case 'mdCanvas': {
        const feed = this._seams.canvas?.(Number(a)) ?? null;
        if (!feed) return null;
        const rate = typeof b === 'string' && b !== '' ? Number(b) : null;
        return this.register(canvasSource(feed, rate));
      }
      case 'mdSynth':
        return this.register(synthSource(Number(a) || 48000));
      case 'mdSynthGraph': {
        const source = this._held.get(Number(a))?.source as
          Partial<SynthSource> | undefined;
        if (typeof b === 'string') {
          try {
            source?.graph?.(JSON.parse(b) as SynthGraph);
          } catch {
            // what the page's realm told is its own to get right
          }
        }
        return null;
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
      case 'mdApply':
        this._apply(Number(a), text(b));
        return null;
      case 'mdGetDisplayMedia':
        void this._getDisplayMedia(Number(a), text(b));
        return null;
      case 'mdSink':
        void this._setSink(Number(a), text(b));
        return null;
      default:
        return null;
    }
  }

  /** The document goes: every source it opened is stopped. */
  dispose(): void {
    this._disposed = true;
    for (const tap of this._taps.values()) tap.off();
    this._taps.clear();
    for (const held of this._held.values()) {
      try {
        held.source.stop();
      } catch {}
    }
    this._held.clear();
    this._views.clear();
    this._displays.clear();
    this._ids.clear();
  }

  private _tell(entry: string, input: unknown): void {
    if (!this._disposed) this._seams.tell(entry, input);
  }

  private _seam(): HtmlMediaDevices {
    return this._seams.devices() ?? NO_MEDIA_DEVICES;
  }

  /** A device's id as this document is handed it: the same in every
   *  document of its origin. */
  private _deviceId(device: MediaDeviceDescription): string {
    return digest(this._seams.origin(), device.deviceId);
  }

  /** A device's group as this document is handed it: a document's own,
   *  which no other document's matches (Media Capture 9.2.1). */
  private _groupId(device: MediaDeviceDescription): string {
    return digest(`${this._seams.origin()}\n${this._salt}`, device.groupId);
  }

  /** A device as its constraints are fitted to it. */
  private _view(device: MediaDeviceDescription): Constrainable {
    return {
      kind: device.kind === 'videoinput' ? 'video' : 'audio',
      deviceId: this._deviceId(device),
      groupId: this._groupId(device),
      capabilities: device.capabilities,
      defaults: device.defaults,
      modes: device.modes,
    };
  }

  /** Whether the document may be told about a kind of device: its
   *  "camera information can be exposed" and "microphone information can
   *  be exposed" — a `getUserMedia` of it succeeded here, or a track of
   *  such a device is live. Not whether the kind is allowed: Firefox and
   *  Safari keep a page that has not captured to empty ids whatever its
   *  permission, as WPT holds them to. */
  private _exposes(kind: 'audio' | 'video'): boolean {
    if (this._exposed[kind]) return true;
    // a grant the user made, as Chrome reads one it remembers: Meet takes
    // devices with no id for none at all, and asks for no capture
    if (this._seams.granted?.(kind === 'audio' ? 'microphone' : 'camera')) {
      return true;
    }
    for (const id of this._held.keys()) {
      const view = this._views.get(id);
      // a device's: a screen's view has no device id, and says nothing of
      // the cameras
      if (view?.kind === kind && view.deviceId !== undefined) return true;
    }
    return false;
  }

  /** Whether the document may use a kind of device at all: a frame's
   *  `allow`, or the `Permissions-Policy` it was served with. */
  private _usable(name: 'camera' | 'microphone'): boolean {
    return this._seams.allowed?.(name) ?? true;
  }

  /**
   * Media Capture's "creating a list of device info objects": the
   * microphones, then the cameras, then the speakers, each the system's
   * default first. A kind the document may not be told about is one entry
   * with no id, no group and no label, and a speaker is listed only where
   * a microphone is (Audio Output Devices API, 3.1).
   */
  private async _devices(req: number): Promise<void> {
    try {
      const list = await this._seam().devices();
      const mic = this._exposes('audio');
      const cam = this._exposes('video');
      const info = (d: MediaDeviceDescription, exposed: boolean) => {
        if (!exposed)
          return { deviceId: '', groupId: '', kind: d.kind, label: '' };
        const ids = { deviceId: this._deviceId(d), groupId: this._groupId(d) };
        return {
          ...ids,
          kind: d.kind,
          label: d.label,
          capabilities:
            d.kind === 'audiooutput'
              ? undefined
              : { ...d.capabilities, ...ids },
        };
      };
      const of = (kind: string, exposed: boolean, usable: boolean) => {
        if (!usable) return [];
        const all = list.filter((d) => d.kind === kind);
        return (exposed ? all : all.slice(0, 1)).map((d) => info(d, exposed));
      };
      const shown = [
        ...of('audioinput', mic, this._usable('microphone')),
        ...of('videoinput', cam, this._usable('camera')),
        ...(mic ? of('audiooutput', true, true) : []),
      ];
      this._tell('__mdSettled', [req, true, shown]);
    } catch (error) {
      this._tell('__mdSettled', [req, false, errorOf(error)]);
    }
  }

  /** Whether a failure of `getUserMedia` may say what it was, rather than
   *  that permission was denied (Media Capture's "getUserMedia specific
   *  failure is allowed"). */
  private _specific(kinds: ('audio' | 'video')[]): boolean {
    // no seam is a machine with no devices, which is no one's refusal
    const seam = this._seams.devices();
    if (!seam || seam === NO_MEDIA_DEVICES) return true;
    const origin = this._seams.origin();
    return !kinds.some(
      (kind) =>
        seam.permission?.(
          kind === 'video' ? 'camera' : 'microphone',
          origin,
        ) === 'denied',
    );
  }

  private async _getUserMedia(req: number, json: string): Promise<void> {
    const origin = this._seams.origin();
    const fail = (error: unknown) =>
      this._tell('__mdSettled', [req, false, errorOf(error)]);
    const denied = () => mediaError('NotAllowedError', 'Permission denied.');
    if (this._seams.originless()) {
      fail(denied());
      return;
    }
    let asked: { audio: unknown; video: unknown };
    try {
      asked = JSON.parse(json) as { audio: unknown; video: unknown };
    } catch {
      fail(mediaError('AbortError', 'The request could not be read.'));
      return;
    }
    const seam = this._seam();
    const wants: ['audio' | 'video', ConstraintSet][] = [];
    if (asked.audio) wants.push(['audio', asConstraints(asked.audio)]);
    if (asked.video) wants.push(['video', asConstraints(asked.video)]);
    const kinds = wants.map(([kind]) => kind);
    if (
      (kinds.includes('audio') && !this._usable('microphone')) ||
      (kinds.includes('video') && !this._usable('camera'))
    ) {
      fail(denied());
      return;
    }
    try {
      const list = await seam.devices();
      const chosen: {
        kind: 'audio' | 'video';
        device: MediaDeviceDescription;
        view: Constrainable;
        settings: MediaSettings;
      }[] = [];
      for (const [kind, constraints] of wants) {
        const of = list.filter(
          (d) => d.kind === (kind === 'audio' ? 'audioinput' : 'videoinput'),
        );
        if (!of.length) {
          throw this._specific(kinds)
            ? mediaError(
                'NotFoundError',
                `There is no ${kind === 'audio' ? 'microphone' : 'camera'}.`,
              )
            : denied();
        }
        const views = of.map((d) => this._view(d));
        const selected = selectSettings(views, constraints);
        if ('failed' in selected) {
          throw this._specific(kinds)
            ? mediaError(
                'OverconstrainedError',
                `No ${kind === 'audio' ? 'microphone' : 'camera'} can meet ${selected.failed}.`,
                selected.failed,
              )
            : denied();
        }
        const {
          deviceId: _id,
          groupId: _group,
          ...settings
        } = selected.settings;
        chosen.push({
          kind,
          device: of[selected.index],
          view: views[selected.index],
          settings,
        });
      }
      const allowed = seam.request
        ? await seam.request({
            origin,
            camera: kinds.includes('video'),
            microphone: kinds.includes('audio'),
            display: false,
          })
        : true;
      if (!allowed) throw denied();
      // what the document may be told from here on: the kinds it asked for
      for (const kind of kinds) this._exposed[kind] = true;
      const tracks: unknown[] = [];
      const opened: MediaSourceLike[] = [];
      try {
        for (const { kind, device, view, settings } of chosen) {
          const source = await seam.open(device.deviceId, settings);
          opened.push(source);
          const ids = { deviceId: view.deviceId, groupId: view.groupId };
          tracks.push({
            source: 0,
            kind,
            label: source.label || device.label,
            settings: { ...settings, ...source.settings(), ...ids },
            capabilities: { ...source.capabilities(), ...ids },
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
        const id = this.register(source);
        (tracks[i] as { source: number }).source = id;
        this._views.set(id, chosen[i].view);
      });
      this._tell('__mdSettled', [req, true, tracks]);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * A track's `applyConstraints`: SelectSettings over its source — a
   * device's every mode, or what any other source runs at — and the source
   * set to what it came to, or the constraint it could not meet. In the
   * order they were asked for, as 4.3.8 has it.
   */
  private _apply(req: number, json: string): void {
    this._applying = this._applying.then(async () => {
      try {
        const { source: id, constraints } = JSON.parse(json) as {
          source: number;
          constraints: unknown;
        };
        const held = this._held.get(id);
        if (!held) {
          // its source has stopped: nothing to set
          this._tell('__mdSettled', [req, true, { settings: null }]);
          return;
        }
        const source = held.source;
        // a display is fitted as `getDisplayMedia` fitted it, from what was
        // picked, its shape kept
        const native = this._displays.get(id);
        if (native) {
          const fitted = displayFit(native, asConstraint(constraints));
          if (typeof fitted === 'string') {
            throw mediaError(
              'OverconstrainedError',
              `The display cannot meet ${fitted}.`,
              fitted,
            );
          }
          await source.reconfigure(fitted);
          this._tell('__mdSettled', [
            req,
            true,
            { settings: { ...displayDefaults(source), ...source.settings() } },
          ]);
          return;
        }
        const device = this._views.get(id);
        const view: Constrainable = device ?? {
          kind: source.kind,
          capabilities: source.capabilities(),
          defaults: {},
          fixed: source.settings(),
        };
        const selected = selectSettings([view], asConstraints(constraints));
        if ('failed' in selected) {
          throw mediaError(
            'OverconstrainedError',
            `The track cannot meet ${selected.failed}.`,
            selected.failed,
          );
        }
        const {
          deviceId: _id,
          groupId: _group,
          ...settings
        } = selected.settings;
        if (device) await source.reconfigure(settings);
        const ids =
          device?.deviceId !== undefined
            ? { deviceId: device.deviceId, groupId: device.groupId }
            : {};
        this._tell('__mdSettled', [
          req,
          true,
          { settings: { ...settings, ...source.settings(), ...ids } },
        ]);
      } catch (error) {
        this._tell('__mdSettled', [req, false, errorOf(error)]);
      }
    });
  }

  /**
   * A media element's `setSinkId` (Audio Output Devices API 2.1): the
   * output whose id the page was handed, which it sees only once a
   * microphone is allowed it, as Chrome lists outputs.
   */
  private async _setSink(req: number, json: string): Promise<void> {
    const origin = this._seams.origin();
    try {
      const { element, sinkId } = JSON.parse(json) as {
        element: number;
        sinkId: string;
      };
      if (sinkId === '') {
        this._seams.sink?.(element, '');
        this._tell('__mdSettled', [req, true, null]);
        return;
      }
      // outputs are listed to a document that has captured sound, as
      // `enumerateDevices` lists them
      const list = this._exposes('audio') ? await this._seam().devices() : [];
      const device = list.find(
        (d) =>
          d.kind === 'audiooutput' && digest(origin, d.deviceId) === sinkId,
      );
      if (!device) {
        throw mediaError('NotFoundError', 'There is no such audio output.');
      }
      this._seams.sink?.(element, device.deviceId);
      this._tell('__mdSettled', [req, true, null]);
    } catch (error) {
      this._tell('__mdSettled', [req, false, errorOf(error)]);
    }
  }

  /**
   * `getDisplayMedia` (Screen Capture 5.2), once the page's realm has
   * checked its activation and its constraints' types: asked of the host
   * (`request`), then its picker (`display`), and the picture fitted to the
   * constraints — downscaled to fit their `max`, and to their width or
   * height precisely, its shape kept — as a browser fits one. A `max` that
   * nothing could meet rejects with an `OverconstrainedError` naming it.
   */
  private async _getDisplayMedia(req: number, json: string): Promise<void> {
    const origin = this._seams.origin();
    const fail = (error: unknown) =>
      this._tell('__mdSettled', [req, false, errorOf(error)]);
    if (this._seams.originless()) {
      fail(mediaError('NotAllowedError', 'Permission denied.'));
      return;
    }
    let asked: { video: unknown; audio: unknown; monitors: boolean };
    try {
      asked = JSON.parse(json) as typeof asked;
    } catch {
      fail(mediaError('AbortError', 'The request could not be read.'));
      return;
    }
    const seam = this._seam();
    const video = asConstraint(asked.video);
    const audio = asked.audio
      ? asConstraint(asked.audio === true ? {} : asked.audio)
      : null;
    try {
      const impossible = displayImpossible(video);
      if (impossible) {
        throw mediaError(
          'OverconstrainedError',
          `No display can meet ${impossible}.`,
          impossible,
        );
      }
      if (!seam.display) {
        throw mediaError('NotFoundError', 'There is no display to capture.');
      }
      const ask = {
        origin,
        camera: false,
        microphone: false,
        display: true,
      };
      const allowed = seam.request ? await seam.request(ask) : true;
      if (!allowed) throw mediaError('NotAllowedError', 'Permission denied.');
      const surface = stringOf(video.displaySurface);
      const cursor = stringOf(video.cursor);
      const got = await seam.display(ask, {
        ...((surface === 'monitor' ||
          surface === 'window' ||
          surface === 'browser') && { displaySurface: surface }),
        monitors: asked.monitors !== false,
        ...((cursor === 'always' ||
          cursor === 'motion' ||
          cursor === 'never') && { cursor }),
        audio: !!audio,
      });
      if (!got) {
        throw mediaError('NotAllowedError', 'Nothing was chosen to share.');
      }
      const picture = 'kind' in got ? got : got.video;
      const sound = 'kind' in got ? null : (got.audio ?? null);
      if (this._disposed) {
        picture.stop();
        sound?.stop();
        return;
      }
      const native = picture.settings();
      const fitted = displayFit(native, video);
      if (typeof fitted !== 'string') await picture.reconfigure(fitted);
      const id = this.register(picture);
      this._displays.set(id, native);
      // a surface has an id as a device does, the same in its settings and
      // its capabilities, and digested as theirs are
      const surfaceId = {
        deviceId: digest(origin, `display:${picture.label}`),
      };
      const tracks: unknown[] = [
        {
          source: id,
          kind: 'video',
          label: picture.label || 'screen',
          settings: {
            ...displayDefaults(picture),
            ...picture.settings(),
            ...surfaceId,
          },
          capabilities: {
            ...capabilitiesOf(picture.capabilities()),
            ...surfaceId,
          },
        },
      ];
      if (sound && audio) {
        tracks.push({
          source: this.register(sound),
          kind: 'audio',
          label: sound.label || 'System Audio',
          settings: {
            ...sound.settings(),
            suppressLocalAudioPlayback:
              booleanOf(audio.suppressLocalAudioPlayback) ?? false,
            restrictOwnAudio: booleanOf(audio.restrictOwnAudio) ?? false,
          },
          capabilities: capabilitiesOf(sound.capabilities()),
        });
      } else sound?.stop();
      this._tell('__mdSettled', [req, true, tracks]);
    } catch (error) {
      fail(error);
    }
  }
}

type Constraint = Record<string, unknown>;

/** A constraint as far as the display's fit reads one: its members, or
 *  none. */
const asConstraint = (c: unknown): Constraint =>
  typeof c === 'object' && c ? (c as Constraint) : {};

/** A source's capabilities, as `getCapabilities()` answers them. */
const capabilitiesOf = (
  caps: MediaDeviceCapabilities,
): Record<string, unknown> => ({ ...caps });

/** A display's settings a picker left out: what Chrome's fake desktop
 *  answers. */
function displayDefaults(source: MediaSourceLike): MediaSettings {
  const caps = source.capabilities();
  return {
    displaySurface: caps.displaySurface ?? 'monitor',
    logicalSurface: caps.logicalSurface ?? true,
    cursor: 'never',
  };
}

const DISPLAY_NUMBERS = ['width', 'height', 'frameRate'] as const;

/** A display constraint no picture could meet: a `max` under 1, or a
 *  `min` over its `max` (the first `applyConstraints` can be handed and
 *  `getDisplayMedia` cannot, its realm having refused a `min`). */
export function displayImpossible(c: Constraint): string | null {
  for (const key of DISPLAY_NUMBERS) {
    const v = c[key];
    if (typeof v !== 'object' || !v) continue;
    const o = v as Record<string, unknown>;
    const max = typeof o.max === 'number' ? o.max : undefined;
    const min = typeof o.min === 'number' ? o.min : undefined;
    if (max !== undefined && max <= 0) return key;
    if (max !== undefined && min !== undefined && min > max) return key;
  }
  return null;
}

/**
 * A display's settings for its constraints: a width or a height asked for,
 * the other from the picture's shape; then downscaled, shape kept, to fit
 * a `max` of either; a frame rate asked for, held to its `max`. Never
 * larger than the picture, which a display can only scale down.
 */
export function displayFit(
  native: MediaSettings,
  c: Constraint,
): MediaSettings | string {
  const impossible = displayImpossible(c);
  if (impossible) return impossible;
  const W = native.width ?? 0;
  const H = native.height ?? 0;
  if (!(W > 0 && H > 0)) return { ...native };
  const ratio = W / H;
  const want = (key: string): number | undefined => {
    const v = c[key];
    if (typeof v === 'number') return v;
    if (typeof v !== 'object' || !v) return undefined;
    const o = v as Record<string, unknown>;
    return typeof o.exact === 'number'
      ? o.exact
      : typeof o.ideal === 'number'
        ? o.ideal
        : undefined;
  };
  const max = (key: string): number => {
    const v = c[key];
    const m =
      typeof v === 'object' && v ? (v as Record<string, unknown>).max : null;
    return typeof m === 'number' ? m : Infinity;
  };
  let width = W;
  let height = H;
  const w = want('width');
  const h = want('height');
  if (w !== undefined && w > 0) {
    width = Math.min(W, w);
    height = h !== undefined && h > 0 ? Math.min(H, h) : width / ratio;
  } else if (h !== undefined && h > 0) {
    height = Math.min(H, h);
    width = height * ratio;
  }
  const scale = Math.min(1, max('width') / width, max('height') / height);
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  if (scale < 1) {
    // rounded up past a max is not under it
    width = Math.min(width, max('width'));
    height = Math.min(height, max('height'));
  }
  let frameRate = want('frameRate') ?? native.frameRate ?? 30;
  frameRate = Math.max(1, Math.min(frameRate, max('frameRate')));
  if (native.frameRate !== undefined)
    frameRate = Math.min(frameRate, native.frameRate);
  return { ...native, width, height, frameRate };
}

const stringOf = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (typeof v !== 'object' || !v) return undefined;
  const o = v as Record<string, unknown>;
  const x = o.exact ?? o.ideal;
  return typeof x === 'string' ? x : undefined;
};

const booleanOf = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'object' || !v) return undefined;
  const o = v as Record<string, unknown>;
  const x = o.exact ?? o.ideal;
  return typeof x === 'boolean' ? x : undefined;
};

declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;
declare const setInterval: (fn: () => void, ms: number) => unknown;
declare const clearInterval: (handle: unknown) => void;

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
      format: 'I420',
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
      const had = !!events?.video;
      events = next;
      if (stopped) return;
      next.muted(false);
      // watched once, whoever listens; a reader that comes is handed the
      // canvas as it is now
      unwatch ??= feed.watch(changed);
      if (events.video && !had) emit();
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

/** One of what a Web Audio stream destination renders (`webaudio.ts`'s
 *  `render`): an oscillator or a constant source, through the gains of its
 *  path, from its start to its stop in the context's seconds. */
export type SynthVoice =
  | {
      kind: 'oscillator';
      type: 'sine' | 'square' | 'sawtooth' | 'triangle' | 'custom';
      frequency: number;
      detune: number;
      real: number[] | null;
      imag: number[] | null;
      gain: number;
      start: number;
      stop: number | null;
    }
  | {
      kind: 'constant';
      offset: number;
      gain: number;
      start: number;
      stop: number | null;
    };

/** What a destination renders, as the page's realm told it: whether its
 *  context runs, the context's time when it was told, and the voices. */
export interface SynthGraph {
  running: boolean;
  time: number;
  voices: SynthVoice[];
}

export interface SynthSource extends MediaSourceLike {
  graph(graph: SynthGraph): void;
}

/**
 * A Web Audio stream destination's track: the voices its graph reaches,
 * summed, in 10 ms chunks of one channel at the context's rate, a chunk
 * for each 10 ms of the context's clock while it runs. A custom wave is
 * its harmonics, normalized to a peak of 1 as Web Audio normalizes one.
 */
export function synthSource(sampleRate: number): SynthSource {
  let events: MediaSourceEvents | null = null;
  let timer: unknown = null;
  let stopped = false;
  let graph: SynthGraph = { running: false, time: 0, voices: [] };
  let told = Date.now();
  let made = 0;
  const frames = Math.round(sampleRate / 100);

  /** The context's time at a host time, while it runs. */
  const contextTime = (at: number) =>
    graph.time + (graph.running ? (at - told) / 1000 : 0);

  const sample = (voice: SynthVoice, t: number): number => {
    if (t < voice.start || (voice.stop !== null && t >= voice.stop)) return 0;
    if (voice.kind === 'constant') return voice.offset * voice.gain;
    const f = voice.frequency * Math.pow(2, voice.detune / 1200);
    const phase = (f * (t - voice.start)) % 1;
    let v: number;
    switch (voice.type) {
      case 'square':
        v = phase < 0.5 ? 1 : -1;
        break;
      case 'sawtooth':
        v = 2 * (phase < 0.5 ? phase : phase - 1);
        break;
      case 'triangle':
        v =
          phase < 0.25
            ? 4 * phase
            : phase < 0.75
              ? 2 - 4 * phase
              : 4 * phase - 4;
        break;
      case 'custom': {
        const real = voice.real ?? [];
        const imag = voice.imag ?? [];
        let sum = 0;
        let peak = 0;
        for (let k = 1; k < Math.max(real.length, imag.length); k++) {
          const a = real[k] ?? 0;
          const b = imag[k] ?? 0;
          sum +=
            a * Math.cos(2 * Math.PI * k * phase) +
            b * Math.sin(2 * Math.PI * k * phase);
          peak += Math.abs(a) + Math.abs(b);
        }
        v = peak ? sum / peak : 0;
        break;
      }
      default:
        v = Math.sin(2 * Math.PI * phase);
    }
    return v * voice.gain;
  };

  const chunk = () => {
    if (!events?.audio || stopped || !graph.running) return;
    const due = Math.floor((contextTime(Date.now()) * sampleRate) / frames);
    for (; made < due; made++) {
      const data = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const t = (made * frames + i) / sampleRate;
        let v = 0;
        for (const voice of graph.voices) v += sample(voice, t);
        data[i] = Math.max(-1, Math.min(1, v));
      }
      events.audio({
        sampleRate,
        channels: [data],
        frames,
        timestamp: (made * frames * 1e6) / sampleRate,
      });
    }
  };
  const run = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (stopped || !events?.audio || !graph.running) return;
    timer = setInterval(chunk, 10);
    (timer as { unref?(): void }).unref?.();
  };

  return {
    kind: 'audio',
    label: 'MediaStreamAudioDestinationNode',
    listen(next) {
      events = next;
      if (stopped) return;
      next.muted(false);
      // a chunk for each 10 ms from the context's time now, not from its
      // start
      made = Math.floor((contextTime(Date.now()) * sampleRate) / frames);
      run();
    },
    graph(next) {
      graph = next;
      told = Date.now();
      run();
    },
    settings: () => ({ sampleRate, channelCount: 1, sampleSize: 32 }),
    capabilities: () => ({}),
    reconfigure: () => Promise.resolve(false),
    stop() {
      stopped = true;
      run();
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

/** What a kind of a page's request asks, as a constraint set: `true` is
 *  none. */
function asConstraints(c: unknown): ConstraintSet {
  return typeof c === 'object' && c ? (c as ConstraintSet) : {};
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
