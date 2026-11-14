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
// Constraints are the host's to fit (`constraints.ts`, SelectSettings): a
// page's are handed over as JSON, and what comes back is the settings they
// came to or the name of the one nothing could meet, which is an
// `OverconstrainedError` here.
//
// A track handed to another realm (`transfer`, `adopt`) keeps its source
// where it was: the track made of it reaches the source through a port back
// to the realm that opened it, which serves it (`serve`), so a frame's or a
// worker's track stops, clones and is constrained over that port, and hears
// its source mute and end over it.

/** What `installDom` hands this. */
export interface MediaStreamsDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  EventTarget: unknown;
  /** Sets a target's `on<type>` handler, which takes its place among
   *  its listeners as it is first set (HTML 8.1.8.1). */
  setHandler(target: unknown, type: string, value: unknown): void;
  Event: unknown;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  /** Whether the page is a secure context, which `mediaDevices` needs. */
  secure: boolean;
  /** The realm's `MessageChannel`, whose ports a track handed to another
   *  realm reaches its source back through. */
  MessageChannel: unknown;
  /** Whether the window has transient activation, which `getDisplayMedia`
   *  needs (HTML 6.4.1). Absent, it never has. */
  activated?(): boolean;
  /** Runs `fn` in a task of its own, which no page can cancel. */
  later?(fn: () => void): void;
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
  /** What a track gives a sink such as a peer connection's sender (Media
   *  Capture 4.3.1): its source's media while it is live and enabled,
   *  black frames or silence while it is disabled, nothing once it ended. */
  output(track: unknown): 'enabled' | 'disabled' | 'ended';
  /** `fn` whenever a track is disabled, enabled again or ended, until the
   *  function it answers is called. */
  watchOutput(track: unknown, fn: () => void): () => void;
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
  /** Whether a track has been handed to another realm already, which a
   *  second transfer of it is a `DataCloneError` for. */
  detached(track: unknown): boolean;
  /**
   * A track's transfer (Media Capture Extensions, "Transferable
   * MediaStreamTrack"): what the track is, as data, and the port the track
   * made of it over there reaches its source through, from a realm that
   * serves it here. Nothing is given up until `commit`: `abort` closes the
   * port where the message it was in could not be sent.
   */
  transfer(track: unknown): {
    data: unknown;
    port: unknown;
    commit(): void;
    abort(): void;
  };
  /** The track a transfer made in this realm, over the port it came with. */
  adopt(data: unknown, port: unknown): unknown;
  /**
   * What a media element plays of a stream (Media Capture 6): the first
   * live track of a kind — its host source, whether it is enabled — or null
   * where there is none.
   */
  firstLive(
    stream: unknown,
    kind: 'audio' | 'video',
  ): { source: number; enabled: boolean } | null;
  /** Whether a stream has a live track, or a live track of a kind. */
  active(stream: unknown, kind?: 'audio' | 'video'): boolean;
  /** `fn` whenever a stream's tracks change — one added, removed, ended
   *  or enabled — until the function it answers is called. */
  watch(stream: unknown, fn: () => void): () => void;
  /** `fn(width, height)` each time a video source's size is known anew,
   *  until the function it answers is called. */
  watchSize(
    source: number,
    fn: (width: number, height: number) => void,
  ): () => void;
  /** A media element's `setSinkId`: settles once the host has the device
   *  whose id the page was handed, or rejects. */
  setSink(element: number, sinkId: string): Promise<void>;
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
  const setHandler: Any = D.setHandler;
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
   *  names them, and called on what is not of its interface a
   *  `TypeError`. */
  const handler = (
    proto: Any,
    name: string,
    brand: (s: Any) => boolean,
  ): void => {
    const get = function (this: Any) {
      slotOf(this, brand);
      return this._handlers[name] ?? null;
    };
    const set = function (this: Any, fn: Any) {
      slotOf(this, brand);
      setHandler(
        this,
        name,
        typeof fn === 'function' || (typeof fn === 'object' && fn) ? fn : null,
      );
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
    /** Where a track handed over from another realm reaches its source,
     *  or null for one over a source of this realm's host. */
    home: Home | null;
    /** Whether it was handed to another realm (`[[IsDetached]]`). */
    detached: boolean;
    /** Whether it is a peer connection receiver's, whose source's settings
     *  are what the far side sends. */
    remote?: boolean;
  }

  /**
   * A source of another realm's host, as tracks handed over from there
   * reach it: a port back to that realm, which serves it (`serve`), what
   * this realm's tracks over it are, and the `applyConstraints` waiting on
   * an answer over it.
   */
  interface Home {
    port: Any;
    tracks: Set<Any>;
    waiting: Map<number, { resolve(v: Any): void; reject(e: Any): void }>;
    seq: number;
  }

  const MessageChannel: Any = D.MessageChannel;
  const portPost: Any = (MessageChannel as Any).prototype
    ? new MessageChannel().port1.postMessage
    : null;
  const post = (port: Any, message: Any): void => {
    apply(portPost, port, [message]);
  };
  /** Hears what arrives at a port: its handler set as the facade's own
   *  handlers are, so a page's `EventTarget.prototype` is not asked. */
  const hear = (port: Any, fn: (data: Any) => void): void => {
    setHandler(port, 'message', (e: Any) => fn(e.data));
    port.start();
  };

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
      const s: TrackSlot = slotOf(this, (x) => x.track);
      if (s.enabled === !!on) return;
      s.enabled = !!on;
      trackChanged(this);
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
      if (s.state === 'live') retain(s);
      // a canvas's track clones as one, of the same canvas
      const copy = makeTrack(
        s.kind,
        s.source,
        s.label,
        s.muted,
        s.canvas ? CanvasCaptureMediaStreamTrack : MediaStreamTrack,
        s.home,
      );
      const c: TrackSlot = apply(wmGet, slots, [copy]);
      c.canvas = s.canvas;
      c.enabled = s.enabled;
      c.state = s.state;
      c.contentHint = s.contentHint;
      c.settings = s.settings;
      c.capabilities = s.capabilities;
      c.constraints = s.constraints;
      c.remote = s.remote;
      return copy;
    }
    stop(): void {
      const s: TrackSlot = slotOf(this, (x) => x.track);
      if (s.state === 'ended') return;
      s.state = 'ended';
      release(this, s);
      trackChanged(this);
    }
    getCapabilities(): Any {
      return { ...slotOf(this, (s) => s.track).capabilities };
    }
    getConstraints(): Any {
      return { ...slotOf(this, (s) => s.track).constraints };
    }
    getSettings(): Any {
      const s: TrackSlot = slotOf(this, (x) => x.track);
      // a received video track is as large as the last frame its source
      // put together, and 0 by 0 before the first; an ended one keeps what
      // it last was
      if (s.remote && s.kind === 'video' && s.state === 'live' && !s.home) {
        const text = call('mdSettings', s.source);
        const now = typeof text === 'string' && text ? JSON.parse(text) : {};
        s.settings = {
          ...s.settings,
          width: Number(now.width) || 0,
          height: Number(now.height) || 0,
        };
      }
      return { ...s.settings };
    }
    /** Settled by the host, which fits the track's source to the
     *  constraints (`constraints.ts`): the settings they came to, or an
     *  `OverconstrainedError` naming the one it cannot meet. An ended
     *  track's resolves and changes nothing. */
    applyConstraints(constraints: Any = undefined): Promise<void> {
      let s: TrackSlot;
      let asked: Any;
      try {
        s = slotOf(this, (x) => x.track);
        if (constraints === undefined || constraints === null) asked = {};
        else if (typeof constraints !== 'object') {
          throw typeError(
            "Failed to execute 'applyConstraints' on 'MediaStreamTrack': The provided value is not of type 'MediaTrackConstraints'.",
          );
        } else asked = JSON.parse(stringify(constraints));
      } catch (error) {
        return P.reject(error);
      }
      if (s.state === 'ended') return P.resolve(undefined);
      const asking = s.home
        ? askHome(s.home, asked)
        : ask('mdApply', { source: s.source, constraints: asked });
      return asking.then((answer: Any) => {
        s.constraints = asked;
        if (answer?.settings)
          s.settings = { ...s.settings, ...answer.settings };
        return undefined;
      });
    }
  }
  for (const name of ['mute', 'unmute', 'ended']) {
    handler(MediaStreamTrack.prototype, name, (s) => s.track);
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
    home: Home | null = null,
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
      home,
      detached: false,
    };
    apply(wmSet, slots, [track, s]);
    if (home) home.tracks.add(track);
    else {
      let set = bySource.get(source);
      if (!set) bySource.set(source, (set = new Set()));
      set.add(track);
    }
    return track;
  };

  /** A track's hold on its source gone: told to the host, or to the realm
   *  its source is of. */
  const release = (track: Any, s: TrackSlot): void => {
    if (s.home) {
      s.home.tracks.delete(track);
      post(s.home.port, { op: 'stop' });
    } else {
      bySource.get(s.source)?.delete(track);
      call('mdStop', s.source);
    }
  };
  /** Another hold on a track's source: a clone's. */
  const retain = (s: TrackSlot): void => {
    if (s.home) post(s.home.port, { op: 'clone' });
    else call('mdClone', s.source);
  };

  /** What becomes of a source, told to a track over it: muted, unmuted,
   *  or its end. */
  const tellTrack = (track: Any, what: string): void => {
    const s: TrackSlot = apply(wmGet, slots, [track]);
    if (!s || s.state === 'ended') return;
    if (what === 'ended') {
      s.state = 'ended';
      s.home?.tracks.delete(track);
      bySource.get(s.source)?.delete(track);
      fire(track, new Event('ended'));
      trackChanged(track);
    } else {
      const muted = what === 'muted';
      if (s.muted === muted) return;
      s.muted = muted;
      fire(track, new Event(muted ? 'mute' : 'unmute'));
    }
  };

  /** Who else hears of a source of this realm's host: the realms its
   *  tracks were handed to, over their ports. */
  const watchers = new Map<number, Set<(what: string) => void>>();

  /** A source served over a port to a realm a track of it was handed to:
   *  what that realm's tracks ask of it, and what becomes of it told
   *  back. `target` is this realm's host's source, or a home of this
   *  realm's, which a track handed on again goes on through. */
  const serve = (
    port: Any,
    target: {
      clone(): void;
      stop(): void;
      apply(constraints: Any): Promise<Any>;
      watch(fn: (what: string) => void): void;
    },
  ): void => {
    hear(port, (m: Any) => {
      if (!m || typeof m !== 'object') return;
      if (m.op === 'clone') target.clone();
      else if (m.op === 'stop') target.stop();
      else if (m.op === 'apply') {
        target.apply(m.constraints).then(
          (answer: Any) => post(port, { applied: m.id, ok: true, answer }),
          (e: Any) =>
            post(port, {
              applied: m.id,
              ok: false,
              error: {
                name: String(e?.name ?? 'Error'),
                message: String(e?.message ?? ''),
                constraint: e?.constraint,
              },
            }),
        );
      }
    });
    target.watch((what) => post(port, { ev: what }));
  };
  const sourceTarget = (source: number) => ({
    clone: () => call('mdClone', source),
    stop: () => call('mdStop', source),
    apply: (constraints: Any) => ask('mdApply', { source, constraints }),
    watch: (fn: (what: string) => void) => {
      let set = watchers.get(source);
      if (!set) watchers.set(source, (set = new Set()));
      set.add(fn);
    },
  });
  const homeTarget = (home: Home) => ({
    clone: () => post(home.port, { op: 'clone' }),
    stop: () => post(home.port, { op: 'stop' }),
    apply: (constraints: Any) => askHome(home, constraints),
    watch: (fn: (what: string) => void) => {
      home.tracks.add({ relay: fn });
    },
  });

  /** A home over a port a transfer brought: what arrives on it told to
   *  this realm's tracks over it. */
  const homeOf = (port: Any): Home => {
    const home: Home = { port, tracks: new Set(), waiting: new Map(), seq: 0 };
    hear(port, (m: Any) => {
      if (!m || typeof m !== 'object') return;
      if (typeof m.ev === 'string') {
        for (const track of [...home.tracks]) {
          if (track && typeof track.relay === 'function') track.relay(m.ev);
          else tellTrack(track, m.ev);
        }
      } else if (typeof m.applied === 'number') {
        const w = home.waiting.get(m.applied);
        if (!w) return;
        home.waiting.delete(m.applied);
        if (m.ok) w.resolve(m.answer);
        else w.reject(errorOf(m.error));
      }
    });
    return home;
  };
  const askHome = (home: Home, constraints: Any): Promise<Any> =>
    new P((resolve: Any, reject: Any) => {
      const id = ++home.seq;
      home.waiting.set(id, { resolve, reject });
      post(home.port, { op: 'apply', id, constraints });
    });

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

  /** What `devicechange` is told with (Media Capture 9.4): the devices
   *  there are, and of them those the user plugged in just now. */
  class DeviceChangeEvent extends Event {
    constructor(type: string, init: Any = undefined) {
      if (arguments.length < 1) {
        throw typeError(
          "Failed to construct 'DeviceChangeEvent': 1 argument required, but only 0 present.",
        );
      }
      super(type, init);
      const given = init?.devices;
      const devices: Any[] =
        given === undefined || given === null ? [] : [...given];
      for (const d of devices) {
        if (!apply(wmGet, slots, [d])?.device) {
          throw typeError(
            "Failed to construct 'DeviceChangeEvent': Failed to read the 'devices' property from 'DeviceChangeEventInit': Failed to convert value to 'MediaDeviceInfo'.",
          );
        }
      }
      apply(wmSet, slots, [
        this,
        {
          change: true,
          devices: Object.freeze(devices),
          inserted: Object.freeze([]),
        },
      ]);
    }
    get devices(): Any {
      return slotOf(this, (s) => s.change).devices;
    }
    get userInsertedDevices(): Any {
      return slotOf(this, (s) => s.change).inserted;
    }
  }

  const isTrack = (v: Any): boolean => {
    const s = v && typeof v === 'object' ? apply(wmGet, slots, [v]) : null;
    return !!s?.track;
  };

  // what becomes of a host source: its tracks' muted state and their end,
  // and its size, for the media elements that show it
  entry('__mdSource', () => {
    const [source, what, width, height] = input() as [
      number,
      string,
      number,
      number,
    ];
    if (what === 'size') {
      for (const fn of [...(sizeWatchers.get(source) ?? [])]) {
        fn(width, height);
      }
      return null;
    }
    for (const fn of [...(watchers.get(source) ?? [])]) fn(what);
    if (what === 'ended') watchers.delete(source);
    const tracks = bySource.get(source);
    if (!tracks) return null;
    for (const track of [...tracks]) tellTrack(track, what);
    return null;
  });

  // what watches a stream's tracks (`internals.watch`), by the stream's
  // slot, and each source's size (`internals.watchSize`)
  const streamWatchers = new Map<Any, Set<() => void>>();
  const sizeWatchers = new Map<number, Set<(w: number, h: number) => void>>();
  // what watches a track's output (`internals.watchOutput`): a sender
  const outputWatchers = new Map<Any, Set<() => void>>();
  /** A track's output changed, as its senders are told. An ended track
   *  changes no more, so what watches it goes. */
  const outputChanged = (track: Any): void => {
    const fns = outputWatchers.get(track);
    if (!fns) return;
    const s: TrackSlot = apply(wmGet, slots, [track]);
    if (s?.state === 'ended') outputWatchers.delete(track);
    for (const fn of [...fns]) fn();
  };
  /** A track changed — ended or enabled — and the streams it is in are
   *  told, and its senders. */
  const trackChanged = (track: Any): void => {
    for (const [slot, fns] of [...streamWatchers]) {
      if (!slot.tracks.includes(track)) continue;
      for (const fn of [...fns]) fn();
    }
    outputChanged(track);
  };
  const streamChanged = (slot: Any): void => {
    for (const fn of [...(streamWatchers.get(slot) ?? [])]) fn();
  };

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
      slotOf(this, (s) => s.stream);
      if (arguments.length < 1) {
        throw typeError(
          "Failed to execute 'getTrackById' on 'MediaStream': 1 argument required, but only 0 present.",
        );
      }
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
      if (s.tracks.includes(track)) return;
      s.tracks.push(track);
      streamChanged(s);
    }
    removeTrack(track: Any): void {
      const s: StreamSlot = slotOf(this, (x) => x.stream);
      if (!isTrack(track)) {
        throw typeError(
          "Failed to execute 'removeTrack' on 'MediaStream': parameter 1 is not of type 'MediaStreamTrack'.",
        );
      }
      const at = s.tracks.indexOf(track);
      if (at < 0) return;
      s.tracks.splice(at, 1);
      streamChanged(s);
    }
    clone(): Any {
      const s: StreamSlot = slotOf(this, (x) => x.stream);
      return new MediaStream(s.tracks.map((t: Any) => t.clone()));
    }
  }
  for (const name of ['addtrack', 'removetrack']) {
    handler(MediaStream.prototype, name, (s) => s.stream);
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
      try {
        slotOf(this, (s) => s.devices);
      } catch (error) {
        return P.reject(error);
      }
      return ask('mdDevices', {}).then((list: Any[]) => list.map(deviceInfo));
    }
    getSupportedConstraints(): Any {
      slotOf(this, (s) => s.devices);
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
        'voiceIsolation',
        'latency',
        'channelCount',
        'deviceId',
        'groupId',
        // a display's (Screen Capture 5.4)
        'displaySurface',
        'logicalSurface',
        'cursor',
        'restrictOwnAudio',
        'suppressLocalAudioPlayback',
      ]) {
        out[name] = true;
      }
      return out;
    }
    getUserMedia(constraints: Any = {}): Promise<Any> {
      try {
        slotOf(this, (s) => s.devices);
      } catch (error) {
        return P.reject(error);
      }
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
    /**
     * Screen Capture 5.2: after a user's gesture only, an
     * `InvalidStateError` otherwise; a `TypeError` for options that are no
     * `DisplayMediaStreamOptions`, for `video: false`, `advanced`, and a
     * `min` or an `exact`, since a page may not require a display's size;
     * then the host's picker, and a stream of a picture and, where asked
     * and there is one, its sound.
     */
    getDisplayMedia(options: Any = undefined): Promise<Any> {
      let video: Any;
      let audio: Any;
      let monitors = true;
      let controller: Any = null;
      try {
        if (!(this instanceof MediaDevices)) throw illegal();
        const o = options ?? {};
        if (typeof o !== 'object' && typeof o !== 'function') {
          throw typeError(
            "Failed to execute 'getDisplayMedia' on 'MediaDevices': The provided value is not of type 'DisplayMediaStreamOptions'.",
          );
        }
        if (o.controller !== undefined) {
          const c = o.controller && apply(wmGet, slots, [o.controller]);
          if (!c?.controller) {
            throw typeError(
              "Failed to execute 'getDisplayMedia' on 'MediaDevices': Failed to read the 'controller' property from 'DisplayMediaStreamOptions': Failed to convert value to 'CaptureController'.",
            );
          }
          controller = c;
        }
        // the enums, read in the dictionary's order (Web IDL 3.2.17)
        const enums: [string, string[]][] = [
          ['audioSelection', ['preferred']],
          ['monitorTypeSurfaces', ['include', 'exclude']],
          ['selfBrowserSurface', ['include', 'exclude']],
          ['surfaceSwitching', ['include', 'exclude']],
          ['systemAudio', ['include', 'exclude']],
          ['windowAudio', ['system', 'window', 'exclude']],
        ];
        for (const [name, values] of enums) {
          const v = o[name];
          if (v === undefined) continue;
          if (!values.includes(String(v))) {
            throw typeError(
              `Failed to execute 'getDisplayMedia' on 'MediaDevices': Failed to read the '${name}' property from 'DisplayMediaStreamOptions': The provided value '${String(v)}' is not a valid enum value of type ${name[0].toUpperCase()}${name.slice(1)}PreferenceEnum.`,
            );
          }
        }
        video = o.video === undefined ? true : o.video;
        audio = o.audio === undefined ? false : o.audio;
        if (video === false) {
          throw typeError(
            "Failed to execute 'getDisplayMedia' on 'MediaDevices': video must be requested",
          );
        }
        const checked = (c: Any, kind: string): Any => {
          if (c === true || c === false || c === null) return c;
          if (typeof c !== 'object') return !!c;
          if (c.advanced !== undefined) {
            throw typeError(
              `Failed to execute 'getDisplayMedia' on 'MediaDevices': Advanced constraints are not supported for ${kind}.`,
            );
          }
          for (const name of Object.keys(c)) {
            const v = c[name];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              if (v.min !== undefined || v.exact !== undefined) {
                throw typeError(
                  `Failed to execute 'getDisplayMedia' on 'MediaDevices': min and exact constraints are not supported for ${kind}.`,
                );
              }
            }
          }
          return JSON.parse(stringify(c));
        };
        video = checked(video, 'video');
        audio = checked(audio, 'audio');
        monitors = o.monitorTypeSurfaces !== 'exclude';
        const surface =
          video && typeof video === 'object'
            ? typeof video.displaySurface === 'object' && video.displaySurface
              ? video.displaySurface.ideal
              : video.displaySurface
            : undefined;
        if (!monitors && surface === 'monitor') {
          throw typeError(
            "Failed to execute 'getDisplayMedia' on 'MediaDevices': displaySurface 'monitor' contradicts monitorTypeSurfaces 'exclude'.",
          );
        }
      } catch (error) {
        return P.reject(error);
      }
      if (controller?.bound) {
        return P.reject(
          domError(
            "Failed to execute 'getDisplayMedia' on 'MediaDevices': A CaptureController may only be used with a single getDisplayMedia() call.",
            'InvalidStateError',
          ),
        );
      }
      if (!deps.activated?.()) {
        return P.reject(
          domError(
            "Failed to execute 'getDisplayMedia' on 'MediaDevices': getDisplayMedia() requires transient activation (user gesture).",
            'InvalidStateError',
          ),
        );
      }
      if (controller) controller.bound = true;
      const capture = ask('mdGetDisplayMedia', {
        video: video === true ? {} : video,
        audio: audio === true ? {} : audio || false,
        monitors,
      }).then((tracks: Any[]) => {
        const stream = new MediaStream(TOKEN);
        const s: StreamSlot = apply(wmGet, slots, [stream]);
        for (const t of tracks) {
          const track = makeTrack(t.kind, t.source, t.label, false);
          const ts: TrackSlot = apply(wmGet, slots, [track]);
          ts.settings = t.settings ?? {};
          ts.capabilities = t.capabilities ?? {};
          const asked = t.kind === 'audio' ? audio : video;
          ts.constraints = asked && typeof asked === 'object' ? asked : {};
          s.tracks.push(track);
        }
        if (controller) {
          // the window in which a focus decision may still be made: the
          // task the promise is resolved in (Screen Capture 5.1.2)
          controller.track = s.tracks.find((t: Any) => t.kind === 'video');
          controller.open = true;
          deps.later?.(() => (controller.open = false));
        }
        return stream;
      });
      if (controller) {
        capture.catch(() => {
          controller.failed = true;
        });
      }
      return capture;
    }
  }
  handler(MediaDevices.prototype, 'devicechange', (s) => s.devices);

  /** Screen Capture 5.1: what a page holds to steer a capture it starts —
   *  where the focus goes as it does, here a choice nobody acts on. */
  const FOCUS_BEHAVIORS = [
    'focus-capturing-application',
    'focus-captured-surface',
    'no-focus-change',
  ];
  class CaptureController extends EventTarget {
    constructor() {
      super();
      apply(wmSet, slots, [
        this,
        {
          controller: true,
          focus: null,
          bound: false,
          track: null,
          open: false,
          failed: false,
          decided: false,
        },
      ]);
    }
    /**
     * Where the focus goes as a capture starts (5.1.2): before the capture,
     * while its promise waits, and in the task it resolves in — once, and
     * only for a window or a tab, since a monitor has no focus to take. The
     * choice is kept, and nothing here acts on it.
     */
    setFocusBehavior(behavior: Any): void {
      const s = slotOf(this, (x) => x.controller);
      if (arguments.length === 0) {
        throw typeError(
          "Failed to execute 'setFocusBehavior' on 'CaptureController': 1 argument required, but only 0 present.",
        );
      }
      const value = String(behavior);
      if (!FOCUS_BEHAVIORS.includes(value)) {
        throw typeError(
          `Failed to execute 'setFocusBehavior' on 'CaptureController': The provided value '${value}' is not a valid enum value of type CaptureStartFocusBehavior.`,
        );
      }
      const refuse = (why: string) =>
        domError(
          `Failed to execute 'setFocusBehavior' on 'CaptureController': ${why}`,
          'InvalidStateError',
        );
      if (s.bound) {
        if (s.failed) throw refuse('The capture failed.');
        if (s.decided) throw refuse('The focus behavior was already set.');
        if (s.track) {
          const ts = apply(wmGet, slots, [s.track]);
          if (ts?.state !== 'live') throw refuse('The capture has stopped.');
          if (!s.open) throw refuse('It is too late to decide the focus.');
          const surface = ts?.settings?.displaySurface;
          if (surface !== 'window' && surface !== 'browser') {
            throw refuse('Only a window or a tab can be focused.');
          }
        }
        s.decided = true;
      }
      s.focus = value;
    }
  }
  const mediaDevices = new MediaDevices(TOKEN);
  apply(wmSet, slots, [mediaDevices, { devices: true }]);

  const interfaces: Record<string, unknown> = {
    MediaStream,
    MediaStreamTrack,
    CanvasCaptureMediaStreamTrack,
    MediaStreamTrackEvent,
    OverconstrainedError,
    DeviceChangeEvent,
  };
  if (deps.secure) {
    interfaces.MediaDevices = MediaDevices;
    interfaces.MediaDeviceInfo = MediaDeviceInfo;
    interfaces.InputDeviceInfo = InputDeviceInfo;
    interfaces.CaptureController = CaptureController;
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
    DeviceChangeEvent,
    CaptureController,
  });

  return {
    interfaces,
    mediaDevices: deps.secure ? mediaDevices : null,
    internals: {
      track: (kind, source, label, muted) => {
        const track = makeTrack(kind, source, label, muted);
        apply(wmGet, slots, [track]).remote = true;
        return track;
      },
      sourceOf: (track: Any) => {
        const s =
          track && typeof track === 'object'
            ? apply(wmGet, slots, [track])
            : null;
        return s?.track ? s.source : -1;
      },
      output: (track: Any) => {
        const s: TrackSlot | undefined =
          track && typeof track === 'object'
            ? apply(wmGet, slots, [track])
            : undefined;
        if (!s?.track || s.state === 'ended') return 'ended';
        return s.enabled ? 'enabled' : 'disabled';
      },
      watchOutput: (track: Any, fn: () => void) => {
        const s: TrackSlot | undefined =
          track && typeof track === 'object'
            ? apply(wmGet, slots, [track])
            : undefined;
        if (!s?.track || s.state === 'ended') return () => {};
        const set: Set<() => void> = outputWatchers.get(track) ?? new Set();
        outputWatchers.set(track, set);
        set.add(fn);
        return () => {
          set.delete(fn);
          if (!set.size && outputWatchers.get(track) === set) {
            outputWatchers.delete(track);
          }
        };
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
        streamChanged(s);
        fire(stream, new MediaStreamTrackEvent('addtrack', { track }));
      },
      removeTrack: (stream: Any, track: Any) => {
        const s: StreamSlot = apply(wmGet, slots, [stream]);
        const at = s ? s.tracks.indexOf(track) : -1;
        if (at < 0) return;
        s.tracks.splice(at, 1);
        streamChanged(s);
        fire(stream, new MediaStreamTrackEvent('removetrack', { track }));
      },
      end: (track: Any, told: boolean) => {
        const s: TrackSlot = apply(wmGet, slots, [track]);
        if (!s || s.state === 'ended') return;
        s.state = 'ended';
        bySource.get(s.source)?.delete(track);
        if (told) fire(track, new Event('ended'));
        trackChanged(track);
      },
      uuid,
      detached: (track: Any) => {
        const s = track && apply(wmGet, slots, [track]);
        return !!s?.track && s.detached;
      },
      transfer: (track: Any) => {
        const s: TrackSlot = apply(wmGet, slots, [track]);
        const channel = new MessageChannel();
        const data = {
          kind: s.kind,
          id: s.id,
          label: s.label,
          state: s.state,
          enabled: s.enabled,
          muted: s.muted,
          contentHint: s.contentHint,
          constraints: s.constraints,
          settings: s.settings,
          capabilities: s.capabilities,
        };
        return {
          data,
          port: channel.port2,
          commit: () => {
            // the track's hold on its source is the one over there now:
            // it ends here without stopping it, and tells nothing
            const live = s.state === 'live';
            s.detached = true;
            s.state = 'ended';
            s.home?.tracks.delete(track);
            bySource.get(s.source)?.delete(track);
            // a sender of it sends nothing from now on
            outputChanged(track);
            if (live) {
              serve(
                channel.port1,
                s.home ? homeTarget(s.home) : sourceTarget(s.source),
              );
            } else channel.port1.close();
          },
          abort: () => {
            channel.port1.close();
            channel.port2.close();
          },
        };
      },
      adopt: (data: Any, port: Any) => {
        const home = homeOf(port);
        const kind = data?.kind === 'audio' ? 'audio' : 'video';
        const track = makeTrack(
          kind,
          -1,
          String(data?.label ?? ''),
          !!data?.muted,
          MediaStreamTrack,
          home,
        );
        const s: TrackSlot = apply(wmGet, slots, [track]);
        s.id = String(data?.id ?? s.id);
        s.enabled = data?.enabled !== false;
        s.state = data?.state === 'ended' ? 'ended' : 'live';
        if (HINTS[kind].includes(data?.contentHint)) {
          s.contentHint = data.contentHint;
        }
        s.constraints = data?.constraints ?? {};
        s.settings = data?.settings ?? {};
        s.capabilities = data?.capabilities ?? {};
        if (s.state === 'ended') home.tracks.delete(track);
        return track;
      },
      firstLive: (stream: Any, kind: 'audio' | 'video') => {
        const s = stream ? apply(wmGet, slots, [stream]) : null;
        if (!s?.stream) return null;
        for (const t of s.tracks) {
          const ts: TrackSlot = apply(wmGet, slots, [t]);
          if (ts.kind === kind && ts.state === 'live') {
            return { source: ts.source, enabled: ts.enabled };
          }
        }
        return null;
      },
      active: (stream: Any, kind?: 'audio' | 'video') => {
        const s = stream ? apply(wmGet, slots, [stream]) : null;
        if (!s?.stream) return false;
        return s.tracks.some((t: Any) => {
          const ts: TrackSlot = apply(wmGet, slots, [t]);
          return ts.state === 'live' && (!kind || ts.kind === kind);
        });
      },
      watch: (stream: Any, fn: () => void) => {
        const s = stream ? apply(wmGet, slots, [stream]) : null;
        if (!s?.stream) return () => {};
        let fns = streamWatchers.get(s);
        if (!fns) streamWatchers.set(s, (fns = new Set()));
        fns.add(fn);
        return () => {
          fns!.delete(fn);
          if (!fns!.size) streamWatchers.delete(s);
        };
      },
      setSink: (element: number, sinkId: string) =>
        ask('mdSink', { element, sinkId }).then(() => undefined),
      watchSize: (source: number, fn: (w: number, h: number) => void) => {
        let fns = sizeWatchers.get(source);
        if (!fns) sizeWatchers.set(source, (fns = new Set()));
        fns.add(fn);
        call('mdSize', source, true);
        return () => {
          if (!fns!.delete(fn)) return;
          if (!fns!.size) sizeWatchers.delete(source);
          call('mdSize', source, false);
        };
      },
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
