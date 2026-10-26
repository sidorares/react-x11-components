// Media Capture and Streams, as a page's scripts see it: `MediaStream`,
// `MediaStreamTrack` and `navigator.mediaDevices`, over the host's media
// sources (`media-sources.ts`, the `md…` ops and `__md…` entries, over the
// `HtmlScripts.mediaDevices` seam).
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` calls it with what it reaches
// the host by.
//
// A track is a number for a host source: a device's, a canvas's
// (`captureStream()`), or a peer connection receiver's (`webrtc.ts` makes
// those through `internals`). Its frames stay host-side. What the page holds — the tracks, the streams, the device
// lists, every rejection — is made here, of the page's own classes.
//
// This is the first slice of docs/prd-webrtc.md's workstream 2: enough for
// a peer connection's tracks and for `getUserMedia` over the fake devices.
// Constraints are read as far as a number or an `exact`, `ideal`, `min` or
// `max` of one; fitness distance, `applyConstraints` and `getDisplayMedia`
// come with the rest of it.

/** What `installDom` hands this. */
export interface MediaStreamsDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  EventTarget: unknown;
  Event: unknown;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  /** Whether the page is a secure context, which `mediaDevices` needs. */
  secure: boolean;
}

/** What a peer connection's facade makes tracks and streams with. */
export interface MediaStreamsInternals {
  /** A track over a host source, as a receiver's is: muted where asked. */
  track(
    kind: 'audio' | 'video',
    source: number,
    label: string,
    muted: boolean,
  ): unknown;
  /** The host source a track is over, or -1 for what is not a track. */
  sourceOf(track: unknown): number;
  isTrack(value: unknown): boolean;
  isStream(value: unknown): boolean;
  /** A stream with an id the page did not choose: a remote one's. */
  stream(id: string): unknown;
  /** Adds a track to a stream and fires `addtrack`, as a remote stream's
   *  tracks come. */
  addTrack(stream: unknown, track: unknown): void;
  /** Removes it and fires `removetrack`. */
  removeTrack(stream: unknown, track: unknown): void;
  /** Ends a track: with `ended` where `told`, as a stopped transceiver's
   *  receiver's is, and with none where its connection closed. */
  end(track: unknown, told: boolean): void;
  /** A fresh id, as a track's and a stream's are made. */
  uuid(): string;
  /**
   * `canvas.captureStream(frameRequestRate)`, its rate already checked: a
   * stream of one `CanvasCaptureMediaStreamTrack` over a host source of
   * the canvas's pixels, the canvas the element numbered `element`.
   */
  captureCanvas(
    canvas: unknown,
    element: number,
    rate: number | null,
    width: number,
    height: number,
  ): unknown;
}

export function installMediaStreams(deps: MediaStreamsDeps): {
  interfaces: Record<string, unknown>;
  mediaDevices: unknown;
  internals: MediaStreamsInternals;
} {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const call: Any = D.call;
  const entry: Any = D.entry;
  const input: Any = D.input;
  const DOMException: Any = D.DOMException;
  const EventTarget: Any = D.EventTarget;
  const Event: Any = D.Event;
  const fire: Any = D.fire;

  const P: Any = Promise;
  const WM: Any = WeakMap;
  const wmGet: Any = WM.prototype.get;
  const wmSet: Any = WM.prototype.set;
  const apply: Any = Reflect.apply;
  const random: Any = Math.random;
  const floor: Any = Math.floor;
  const stringify: Any = JSON.stringify;
  const TOKEN = Object.freeze(Object.create(null));

  const typeError = (message: string): Any => new TypeError(message);
  const domError = (message: string, name: string): Any =>
    new DOMException(message, name);
  const illegal = (): Any => typeError('Illegal invocation');
  const illegalConstructor = (): Any => typeError('Illegal constructor');

  const uuid = (): string => {
    const hex = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
      else if (i === 14) out += '4';
      else if (i === 19) out += hex[8 + floor(apply(random, Math, []) * 4)];
      else out += hex[floor(apply(random, Math, []) * 16)];
    }
    return out;
  };

  const slots = new WM();
  const slotOf = (self: Any, check: (s: Any) => boolean): Any => {
    const s = apply(wmGet, slots, [self]);
    if (!s || !check(s)) throw illegal();
    return s;
  };
  /** An event handler IDL attribute, its accessors named as Web IDL
   *  names them. */
  const handler = (proto: Any, name: string): void => {
    const get = function (this: Any) {
      return this._handlers[name] ?? null;
    };
    const set = function (this: Any, fn: Any) {
      this._handlers[name] =
        typeof fn === 'function' || (typeof fn === 'object' && fn) ? fn : null;
    };
    Object.defineProperty(get, 'name', { value: `get on${name}` });
    Object.defineProperty(set, 'name', { value: `set on${name}` });
    Object.defineProperty(proto, 'on' + name, {
      get,
      set,
      enumerable: true,
      configurable: true,
    });
  };
  /** Classes made Web IDL interfaces: their members enumerable, as IDL's
   *  are, and their objects' class strings their names. */
  const idl = (classes: Record<string, Any>): void => {
    for (const name of Object.getOwnPropertyNames(classes)) {
      const C = classes[name];
      for (const on of [C.prototype, C]) {
        for (const key of Object.getOwnPropertyNames(on)) {
          if (['constructor', 'prototype', 'length', 'name'].includes(key)) {
            continue;
          }
          const d = Object.getOwnPropertyDescriptor(on, key)!;
          if (d.enumerable || (!d.get && typeof d.value !== 'function')) {
            continue;
          }
          Object.defineProperty(on, key, { ...d, enumerable: true });
        }
      }
      Object.defineProperty(C.prototype, Symbol.toStringTag, {
        value: name,
        configurable: true,
      });
    }
  };

  // --- tracks -----------------------------------------------------------------

  /** The tracks over each host source, which its events reach. */
  const bySource = new Map<number, Set<Any>>();

  interface TrackSlot {
    track: true;
    kind: 'audio' | 'video';
    id: string;
    label: string;
    enabled: boolean;
    muted: boolean;
    state: 'live' | 'ended';
    source: number;
    contentHint: string;
    settings: Any;
    capabilities: Any;
    constraints: Any;
    /** The canvas a `captureStream()` track captures, or null. */
    canvas: Any;
  }

  const HINTS: Record<string, string[]> = {
    audio: ['', 'speech', 'speech-recognition', 'music'],
    video: ['', 'motion', 'detail', 'text'],
  };

  class MediaStreamTrack extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor();
    }
    get kind(): string {
      return slotOf(this, (s) => s.track).kind;
    }
    get id(): string {
      return slotOf(this, (s) => s.track).id;
    }
    get label(): string {
      return slotOf(this, (s) => s.track).label;
    }
    get enabled(): boolean {
      return slotOf(this, (s) => s.track).enabled;
    }
    set enabled(on: boolean) {
      slotOf(this, (s) => s.track).enabled = !!on;
    }
    get muted(): boolean {
      return slotOf(this, (s) => s.track).muted;
    }
    get readyState(): string {
      return slotOf(this, (s) => s.track).state;
    }
    get contentHint(): string {
      return slotOf(this, (s) => s.track).contentHint;
    }
    set contentHint(hint: string) {
      const s: TrackSlot = slotOf(this, (x) => x.track);
      const value = String(hint);
      if (HINTS[s.kind].includes(value)) s.contentHint = value;
    }
    clone(): Any {
      const s: TrackSlot = slotOf(this, (x) => x.track);
      if (s.state === 'live') call('mdClone', s.source);
      // a canvas's track clones as one, of the same canvas
      const copy = makeTrack(
        s.kind,
        s.source,
        s.label,
        s.muted,
        s.canvas ? CanvasCaptureMediaStreamTrack : MediaStreamTrack,
      );
      const c: TrackSlot = apply(wmGet, slots, [copy]);
      c.canvas = s.canvas;
      c.enabled = s.enabled;
      c.state = s.state;
      c.contentHint = s.contentHint;
      c.settings = s.settings;
      c.capabilities = s.capabilities;
      c.constraints = s.constraints;
      return copy;
    }
    stop(): void {
      const s: TrackSlot = slotOf(this, (x) => x.track);
      if (s.state === 'ended') return;
      s.state = 'ended';
      bySource.get(s.source)?.delete(this);
      call('mdStop', s.source);
    }
    getCapabilities(): Any {
      return { ...slotOf(this, (s) => s.track).capabilities };
    }
    getConstraints(): Any {
      return { ...slotOf(this, (s) => s.track).constraints };
    }
    getSettings(): Any {
      return { ...slotOf(this, (s) => s.track).settings };
    }
    applyConstraints(constraints: Any = {}): Promise<void> {
      let s: TrackSlot;
      try {
        s = slotOf(this, (x) => x.track);
      } catch (error) {
        return P.reject(error);
      }
      s.constraints = { ...constraints };
      return P.resolve(undefined);
    }
  }
  for (const name of ['mute', 'unmute', 'ended']) {
    handler(MediaStreamTrack.prototype, name);
  }

  /** A canvas's track (Media Capture from DOM Elements, 3.2): the canvas,
   *  and a frame asked for. */
  class CanvasCaptureMediaStreamTrack extends MediaStreamTrack {
    get canvas(): Any {
      const s = slotOf(this, (x) => x.track && x.canvas);
      return s.canvas;
    }
    requestFrame(): void {
      const s: TrackSlot = slotOf(this, (x) => x.track && x.canvas);
      if (s.state === 'live') call('mdRequestFrame', s.source);
    }
  }

  const makeTrack = (
    kind: 'audio' | 'video',
    source: number,
    label: string,
    muted: boolean,
    Kind: Any = MediaStreamTrack,
  ): Any => {
    const track = new Kind(TOKEN);
    const s: TrackSlot = {
      track: true,
      kind,
      id: uuid(),
      label,
      enabled: true,
      muted,
      state: 'live',
      source,
      contentHint: '',
      settings: {},
      capabilities: {},
      constraints: {},
      canvas: null,
    };
    apply(wmSet, slots, [track, s]);
    let set = bySource.get(source);
    if (!set) bySource.set(source, (set = new Set()));
    set.add(track);
    return track;
  };

  class MediaStreamTrackEvent extends Event {
    constructor(type: string, init: Any) {
      if (!init || !isTrack(init.track)) {
        throw typeError(
          "Failed to construct 'MediaStreamTrackEvent': required member track is undefined.",
        );
      }
      super(type, init);
      apply(wmSet, slots, [this, { event: true, track: init.track }]);
    }
    get track(): Any {
      return slotOf(this, (s) => s.event).track;
    }
  }

  const isTrack = (v: Any): boolean => {
    const s = v && typeof v === 'object' ? apply(wmGet, slots, [v]) : null;
    return !!s?.track;
  };

  // what becomes of a host source: its tracks' muted state and their end
  entry('__mdSource', () => {
    const [source, what] = input() as [number, string];
    const tracks = bySource.get(source);
    if (!tracks) return null;
    for (const track of [...tracks]) {
      const s: TrackSlot = apply(wmGet, slots, [track]);
      if (s.state === 'ended') continue;
      if (what === 'ended') {
        s.state = 'ended';
        tracks.delete(track);
        fire(track, new Event('ended'));
      } else {
        const muted = what === 'muted';
        if (s.muted === muted) continue;
        s.muted = muted;
        fire(track, new Event(muted ? 'mute' : 'unmute'));
      }
    }
    return null;
  });

  // --- streams ----------------------------------------------------------------

  interface StreamSlot {
    stream: true;
    id: string;
    tracks: Any[];
  }

  class MediaStream extends EventTarget {
    constructor(init: Any = undefined) {
      super();
      const s: StreamSlot = { stream: true, id: uuid(), tracks: [] };
      apply(wmSet, slots, [this, s]);
      if (init === TOKEN) return;
      let from: Any[] = [];
      if (init !== undefined) {
        const other = init && apply(wmGet, slots, [init]);
        if (other?.stream) from = other.tracks;
        else if (init && typeof init[Symbol.iterator] === 'function') {
          from = [...init];
          for (const t of from) {
            if (!isTrack(t)) {
              throw typeError(
                "Failed to construct 'MediaStream': the provided value is not of type 'MediaStreamTrack'.",
              );
            }
          }
        } else {
          throw typeError(
            "Failed to construct 'MediaStream': The provided value cannot be converted to a sequence.",
          );
        }
      }
      for (const t of from) if (!s.tracks.includes(t)) s.tracks.push(t);
    }
    get id(): string {
      return slotOf(this, (s) => s.stream).id;
    }
    get active(): boolean {
      return slotOf(this, (s) => s.stream).tracks.some(
        (t: Any) => apply(wmGet, slots, [t]).state === 'live',
      );
    }
    getTracks(): Any[] {
      return slotOf(this, (s) => s.stream).tracks.slice();
    }
    getAudioTracks(): Any[] {
      return this.getTracks().filter((t: Any) => t.kind === 'audio');
    }
    getVideoTracks(): Any[] {
      return this.getTracks().filter((t: Any) => t.kind === 'video');
    }
    getTrackById(id: string): Any {
      const key = String(id);
      return this.getTracks().find((t: Any) => t.id === key) ?? null;
    }
    addTrack(track: Any): void {
      const s: StreamSlot = slotOf(this, (x) => x.stream);
      if (!isTrack(track)) {
        throw typeError(
          "Failed to execute 'addTrack' on 'MediaStream': parameter 1 is not of type 'MediaStreamTrack'.",
        );
      }
      if (!s.tracks.includes(track)) s.tracks.push(track);
    }
    removeTrack(track: Any): void {
      const s: StreamSlot = slotOf(this, (x) => x.stream);
      if (!isTrack(track)) {
        throw typeError(
          "Failed to execute 'removeTrack' on 'MediaStream': parameter 1 is not of type 'MediaStreamTrack'.",
        );
      }
      const at = s.tracks.indexOf(track);
      if (at >= 0) s.tracks.splice(at, 1);
    }
    clone(): Any {
      const s: StreamSlot = slotOf(this, (x) => x.stream);
      return new MediaStream(s.tracks.map((t: Any) => t.clone()));
    }
  }
  for (const name of ['addtrack', 'removetrack']) {
    handler(MediaStream.prototype, name);
  }

  const isStream = (v: Any): boolean => {
    const s = v && typeof v === 'object' ? apply(wmGet, slots, [v]) : null;
    return !!s?.stream;
  };

  // --- devices ----------------------------------------------------------------

  interface DeviceSlot {
    device: true;
    deviceId: string;
    kind: string;
    label: string;
    groupId: string;
    capabilities: Any;
  }

  class MediaDeviceInfo {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
    }
    get deviceId(): string {
      return slotOf(this, (s) => s.device).deviceId;
    }
    get kind(): string {
      return slotOf(this, (s) => s.device).kind;
    }
    get label(): string {
      return slotOf(this, (s) => s.device).label;
    }
    get groupId(): string {
      return slotOf(this, (s) => s.device).groupId;
    }
    toJSON(): Any {
      const s: DeviceSlot = slotOf(this, (x) => x.device);
      return {
        deviceId: s.deviceId,
        kind: s.kind,
        label: s.label,
        groupId: s.groupId,
      };
    }
  }
  class InputDeviceInfo extends MediaDeviceInfo {
    getCapabilities(): Any {
      return { ...slotOf(this, (s) => s.device).capabilities };
    }
  }

  const deviceInfo = (d: Any): Any => {
    const info =
      d.kind === 'audiooutput'
        ? new MediaDeviceInfo(TOKEN)
        : new InputDeviceInfo(TOKEN);
    apply(wmSet, slots, [
      info,
      {
        device: true,
        deviceId: String(d.deviceId),
        kind: String(d.kind),
        label: String(d.label),
        groupId: String(d.groupId),
        capabilities: d.capabilities ?? {},
      },
    ]);
    return info;
  };

  class OverconstrainedError extends DOMException {
    constructor(constraint: string, message = '') {
      super(String(message), 'OverconstrainedError');
      apply(wmSet, slots, [
        this,
        { overconstrained: true, constraint: String(constraint) },
      ]);
    }
    get constraint(): string {
      return slotOf(this, (s) => s.overconstrained).constraint;
    }
  }

  /** What a host answer's error comes to, of this realm's classes. */
  const errorOf = (e: Any): Any =>
    e?.name === 'OverconstrainedError'
      ? new OverconstrainedError(e.constraint ?? '', e.message ?? '')
      : e?.name === 'TypeError'
        ? typeError(String(e.message ?? ''))
        : domError(String(e?.message ?? ''), String(e?.name || 'AbortError'));

  // a request of the host's, settled by an entry
  let requestSeq = 0;
  const waiting = new Map<
    number,
    { resolve(v: Any): void; reject(e: Any): void }
  >();
  const ask = (op: string, payload: Any): Promise<Any> =>
    new P((resolve: Any, reject: Any) => {
      const req = ++requestSeq;
      waiting.set(req, { resolve, reject });
      call(op, req, stringify(payload));
    });
  entry('__mdSettled', () => {
    const [req, ok, payload] = input() as [number, boolean, Any];
    const w = waiting.get(req);
    if (!w) return null;
    waiting.delete(req);
    if (ok) w.resolve(payload);
    else w.reject(errorOf(payload));
    return null;
  });

  /** A constraint as far as is read here: true, false, an object's
   *  members, or nothing. */
  const requested = (c: Any): boolean =>
    c === true || (c !== null && typeof c === 'object');

  class MediaDevices extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor();
    }
    enumerateDevices(): Promise<Any[]> {
      return ask('mdDevices', {}).then((list: Any[]) => list.map(deviceInfo));
    }
    getSupportedConstraints(): Any {
      const out: Any = {};
      for (const name of [
        'width',
        'height',
        'aspectRatio',
        'frameRate',
        'facingMode',
        'resizeMode',
        'sampleRate',
        'sampleSize',
        'echoCancellation',
        'autoGainControl',
        'noiseSuppression',
        'latency',
        'channelCount',
        'deviceId',
        'groupId',
      ]) {
        out[name] = true;
      }
      return out;
    }
    getUserMedia(constraints: Any = {}): Promise<Any> {
      if (constraints === null || typeof constraints !== 'object') {
        return P.reject(
          typeError(
            "Failed to execute 'getUserMedia' on 'MediaDevices': The provided value is not of type 'MediaStreamConstraints'.",
          ),
        );
      }
      const audio = constraints.audio;
      const video = constraints.video;
      if (!requested(audio) && !requested(video)) {
        return P.reject(
          typeError(
            "Failed to execute 'getUserMedia' on 'MediaDevices': At least one of audio and video must be requested",
          ),
        );
      }
      const plain = (c: Any): Any =>
        c === true ? true : requested(c) ? JSON.parse(stringify(c)) : false;
      return ask('mdGetUserMedia', {
        audio: plain(audio),
        video: plain(video),
      }).then((tracks: Any[]) => {
        const stream = new MediaStream(TOKEN);
        const s: StreamSlot = apply(wmGet, slots, [stream]);
        for (const t of tracks) {
          const track = makeTrack(t.kind, t.source, t.label, false);
          const ts: TrackSlot = apply(wmGet, slots, [track]);
          ts.settings = t.settings ?? {};
          ts.capabilities = t.capabilities ?? {};
          const asked = t.kind === 'audio' ? audio : video;
          ts.constraints =
            asked && typeof asked === 'object' ? plain(asked) : {};
          s.tracks.push(track);
        }
        return stream;
      });
    }
  }
  handler(MediaDevices.prototype, 'devicechange');
  const mediaDevices = new MediaDevices(TOKEN);

  const interfaces: Record<string, unknown> = {
    MediaStream,
    MediaStreamTrack,
    CanvasCaptureMediaStreamTrack,
    MediaStreamTrackEvent,
    OverconstrainedError,
  };
  if (deps.secure) {
    interfaces.MediaDevices = MediaDevices;
    interfaces.MediaDeviceInfo = MediaDeviceInfo;
    interfaces.InputDeviceInfo = InputDeviceInfo;
  }
  idl({
    MediaStream,
    MediaStreamTrack,
    CanvasCaptureMediaStreamTrack,
    MediaStreamTrackEvent,
    OverconstrainedError,
    MediaDevices,
    MediaDeviceInfo,
    InputDeviceInfo,
  });

  return {
    interfaces,
    mediaDevices: deps.secure ? mediaDevices : null,
    internals: {
      track: (kind, source, label, muted) =>
        makeTrack(kind, source, label, muted),
      sourceOf: (track: Any) => {
        const s =
          track && typeof track === 'object'
            ? apply(wmGet, slots, [track])
            : null;
        return s?.track ? s.source : -1;
      },
      isTrack,
      isStream,
      stream: (id: string) => {
        const stream = new MediaStream(TOKEN);
        apply(wmGet, slots, [stream]).id = String(id);
        return stream;
      },
      addTrack: (stream: Any, track: Any) => {
        const s: StreamSlot = apply(wmGet, slots, [stream]);
        if (!s || s.tracks.includes(track)) return;
        s.tracks.push(track);
        fire(stream, new MediaStreamTrackEvent('addtrack', { track }));
      },
      removeTrack: (stream: Any, track: Any) => {
        const s: StreamSlot = apply(wmGet, slots, [stream]);
        const at = s ? s.tracks.indexOf(track) : -1;
        if (at < 0) return;
        s.tracks.splice(at, 1);
        fire(stream, new MediaStreamTrackEvent('removetrack', { track }));
      },
      end: (track: Any, told: boolean) => {
        const s: TrackSlot = apply(wmGet, slots, [track]);
        if (!s || s.state === 'ended') return;
        s.state = 'ended';
        bySource.get(s.source)?.delete(track);
        if (told) fire(track, new Event('ended'));
      },
      uuid,
      captureCanvas: (
        canvas: Any,
        element: number,
        rate: number | null,
        width: number,
        height: number,
      ) => {
        const source = call(
          'mdCanvas',
          element,
          rate === null ? '' : String(rate),
        );
        const stream = new MediaStream(TOKEN);
        if (typeof source !== 'number') return stream;
        const track = makeTrack(
          'video',
          source,
          '',
          false,
          CanvasCaptureMediaStreamTrack,
        );
        const s: TrackSlot = apply(wmGet, slots, [track]);
        s.canvas = canvas;
        s.settings =
          rate === null
            ? { width, height, resizeMode: 'none' }
            : { width, height, frameRate: rate, resizeMode: 'none' };
        apply(wmGet, slots, [stream]).tracks.push(track);
        return stream;
      },
    },
  };
}
