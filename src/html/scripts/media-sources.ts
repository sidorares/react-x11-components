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

import { NO_MEDIA_DEVICES, mediaError } from '../media-devices.js';
import type {
  HtmlMediaDevices,
  MediaDeviceDescription,
  MediaSettings,
  MediaSourceEvents,
  MediaSourceLike,
} from '../media-devices.js';
import type { CanvasPixels } from './host.js';
import { selectSettings } from './constraints.js';
import type { Constrainable, ConstraintSet } from './constraints.js';

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
  /** Whether the document may use a camera or a microphone (Permissions
   *  Policy). Absent, it may. */
  allowed?(name: 'camera' | 'microphone'): boolean;
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
  /** What makes this document's group ids its own. */
  private readonly _salt = `${Date.now()}.${Math.random()}`;
  /** The `applyConstraints` under way, one after another. */
  private _applying: Promise<void> = Promise.resolve();
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
          this._views.delete(id);
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
    this._views.clear();
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
}

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
