// A media element's text tracks, as a page's scripts see them (HTML
// 4.8.11.11 and WebVTT): `TextTrackList`, `TextTrack`, `TextTrackCueList`,
// `TextTrackCue`, `VTTCue`, `VTTRegion` and `TrackEvent`, what
// `addTextTrack` and a `<track>` make, a `<track>`'s WebVTT file fetched and
// parsed, the automatic selection of a `default` track, and the cues'
// `enter`, `exit` and `cuechange` as the element's time moves.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing.
//
// Nothing here draws a cue: the tracks are state a page reads, and what a
// browser renders over the video is not rendered.

/** What `installDom` hands this. */
export interface TextTrackDeps {
  DOMException: unknown;
  EventTarget: unknown;
  Event: unknown;
  /** Sets a target's `on<type>` handler (HTML 8.1.8.1). */
  setHandler(target: unknown, type: string, value: unknown): void;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  /** A timer the page cannot see or cancel. */
  later(fn: () => void, ms: number): void;
  /** The realm's own `fetch`, not the page's. */
  fetch(url: string, init: unknown): Promise<unknown>;
  /** The document a cue's HTML is made in. */
  document(): unknown;
  /** Whether a node is a media element, and a `<track>`. */
  isMedia(node: unknown): boolean;
  isTrack(node: unknown): boolean;
  /** Where a media element's clock is, whether it plays, its ready state,
   *  and whether it shows its poster, which no cue is current under. */
  clock(media: unknown): {
    time: number;
    paused: boolean;
    ready: number;
    poster: boolean;
  };
  /** A media element paused, as a cue's `pauseOnExit` has it. */
  pause(media: unknown): void;
}

export function installTextTracks(D: TextTrackDeps): {
  interfaces: Record<string, unknown>;
  internals: {
    listOf(media: unknown): unknown;
    add(
      media: unknown,
      kind: unknown,
      label: unknown,
      language: unknown,
    ): unknown;
    trackOf(element: unknown): unknown;
    readyStateOf(element: unknown): number;
    sync(media: unknown): void;
    srcChanged(element: unknown): void;
    timeMarchesOn(media: unknown, seeked: boolean): void;
    watch(media: unknown): void;
    dirty(): void;
    sweep(tracks: ArrayLike<unknown>): void;
    pending(media: unknown): boolean;
    whenReady(media: unknown, fn: () => void): void;
  };
} {
  type Any = any;
  const DOMException: Any = D.DOMException;
  const EventTarget: Any = D.EventTarget;
  const Event: Any = D.Event;

  // --- lists, indexed as legacy platform objects are -----------------------

  /** A list's items, by the proxy the page holds. */
  const ITEMS = new WeakMap<object, () => Any[]>();
  const indexed = (target: Any, items: () => Any[]): Any => {
    const isIndex = (p: Any): boolean =>
      typeof p === 'string' && /^(0|[1-9]\d*)$/.test(p);
    const proxy: Any = new Proxy(target, {
      get(t, p, r) {
        if (isIndex(p)) return items()[Number(p)];
        return Reflect.get(t, p, r === proxy ? t : r);
      },
      has(t, p) {
        if (isIndex(p)) return Number(p) < items().length;
        return Reflect.has(t, p);
      },
      set(t, p, v, r): boolean {
        if (isIndex(p)) return false;
        return Reflect.set(t, p, v, r === proxy ? t : r);
      },
      defineProperty(t, p, d) {
        if (isIndex(p)) return false;
        return Reflect.defineProperty(t, p, d);
      },
      deleteProperty(t, p) {
        if (isIndex(p)) return !(Number(p) < items().length);
        return Reflect.deleteProperty(t, p);
      },
      ownKeys(t) {
        const keys: (string | symbol)[] = [];
        const n = items().length;
        for (let i = 0; i < n; i += 1) keys.push(String(i));
        return [...keys, ...Reflect.ownKeys(t)];
      },
      getOwnPropertyDescriptor(t, p) {
        if (isIndex(p)) {
          const list = items();
          const i = Number(p);
          if (i >= list.length) return undefined;
          return {
            value: list[i],
            writable: false,
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(t, p);
      },
    });
    ITEMS.set(proxy, items);
    ITEMS.set(target, items);
    return proxy;
  };
  const itemsOf = (list: Any): Any[] => {
    const items = ITEMS.get(list);
    if (!items) throw new TypeError('Illegal invocation');
    return items();
  };
  let making = false;
  const illegal = (): never => {
    throw new TypeError('Illegal constructor');
  };

  const handlers = (Class: Any, types: string[]): void => {
    for (const type of types) {
      Object.defineProperty(Class.prototype, `on${type}`, {
        get(this: Any): Any {
          return this._handlers?.[type] ?? null;
        },
        set(this: Any, fn: Any) {
          D.setHandler(this, type, typeof fn === 'function' ? fn : null);
        },
        configurable: true,
        enumerable: true,
      });
    }
  };

  class TrackEvent extends Event {
    #track: Any;
    constructor(type: Any, init?: Any) {
      super(type, init);
      this.#track = init?.track ?? null;
      if (this.#track !== null && !(this.#track instanceof TextTrack)) {
        throw new TypeError(
          "Failed to construct 'TrackEvent': The provided value is not of type '(AudioTrack or TextTrack or VideoTrack)'.",
        );
      }
    }
    get track(): Any {
      return this.#track;
    }
  }

  // --- the list of a media element's tracks ---------------------------------

  interface MediaState {
    list: Any;
    /** The tracks `addTextTrack` made, in the order made. */
    added: Any[];
    /** Its `<track>`s' tracks, as last synced, in tree order. */
    elements: Any[];
    /** The tracks in the list now. */
    tracks: Any[];
    /** The time the cues were last brought up to, and the cues active
     *  then. */
    last: number;
    /** A `change` owed to the list, in a task of its own. */
    changeOwed: boolean;
    /** The automatic selection owed, a task after a `<track>` came. */
    selectOwed: boolean;
    /** What waits for its pending text tracks: the ready state it was
     *  held at (4.8.11.11.1, "blocked on its pending text tracks"). */
    waiting: (() => void)[];
  }
  const MEDIA = new WeakMap<object, MediaState>();
  /** The media elements whose tracks are kept up to date. */
  const watched = new Set<Any>();

  class TextTrackList extends EventTarget {
    constructor() {
      if (!making) illegal();
      super();
    }
    get length(): number {
      return itemsOf(this).length;
    }
    getTrackById(id: Any): Any {
      const key = String(id);
      return itemsOf(this).find((t: Any) => t.id === key) ?? null;
    }
    [Symbol.iterator](): Iterator<Any> {
      return itemsOf(this)[Symbol.iterator]();
    }
  }
  handlers(TextTrackList, ['change', 'addtrack', 'removetrack']);

  const mediaState = (media: Any): MediaState => {
    let state = MEDIA.get(media);
    if (!state) {
      making = true;
      let list: Any;
      try {
        list = new TextTrackList();
      } finally {
        making = false;
      }
      state = {
        list: null,
        added: [],
        elements: [],
        tracks: [],
        last: 0,
        changeOwed: false,
        selectOwed: false,
        waiting: [],
      };
      const s = state;
      state.list = indexed(list, () => s.tracks);
      MEDIA.set(media, state);
      watched.add(media);
    }
    return state;
  };

  // --- a track ----------------------------------------------------------------

  type Mode = 'disabled' | 'hidden' | 'showing';
  interface TrackState {
    kind: string;
    label: string;
    language: string;
    mode: Mode;
    /** The `<track>` it is of, or null for one `addTextTrack` made. */
    element: Any;
    media: Any;
    /** 0 not loaded, 1 loading, 2 loaded, 3 failed (`HTMLTrackElement`'s
     *  readyState). */
    ready: number;
    cues: Any[];
    cueList: Any;
    activeList: Any;
    /** Whether a script or the selection has set its mode: a `default`
     *  track is chosen only while nothing has. */
    chosen: boolean;
    /** The load under way, so that one a new `src` overtook is dropped. */
    load: number;
    /** The address the cues were loaded from. */
    url: string;
    /** The cues active the last time it was looked at, for `cuechange`. */
    activeKey: string;
  }
  const TRACKS = new WeakMap<object, TrackState>();
  const trackState = (track: Any): TrackState => {
    const state = TRACKS.get(track);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  };

  const KINDS = [
    'subtitles',
    'captions',
    'descriptions',
    'chapters',
    'metadata',
  ];
  const MODES = ['disabled', 'hidden', 'showing'];

  class TextTrack extends EventTarget {
    constructor() {
      if (!making) illegal();
      super();
    }
    get kind(): string {
      const s = trackState(this);
      return s.element ? String(s.element.kind) : s.kind;
    }
    get label(): string {
      const s = trackState(this);
      return s.element ? String(s.element.label) : s.label;
    }
    get language(): string {
      const s = trackState(this);
      return s.element ? String(s.element.srclang) : s.language;
    }
    get id(): string {
      const s = trackState(this);
      return s.element ? String(s.element.id ?? '') : '';
    }
    get inBandMetadataTrackDispatchType(): string {
      return '';
    }
    get mode(): string {
      return trackState(this).mode;
    }
    set mode(v: Any) {
      const value = String(v);
      if (!MODES.includes(value)) return;
      setMode(this, value as Mode, true);
    }
    get cues(): Any {
      const s = trackState(this);
      return s.mode === 'disabled' ? null : s.cueList;
    }
    get activeCues(): Any {
      const s = trackState(this);
      return s.mode === 'disabled' ? null : s.activeList;
    }
    addCue(cue: Any): void {
      if (!(cue instanceof TextTrackCue)) {
        throw new TypeError(
          "Failed to execute 'addCue' on 'TextTrack': parameter 1 is not of type 'TextTrackCue'.",
        );
      }
      const c = cueState(cue);
      if (c.track && c.track !== this) {
        const other = trackState(c.track);
        other.cues = other.cues.filter((x: Any) => x !== cue);
        c.active = false;
      }
      const s = trackState(this);
      // a cue added again is the last of those that start and end with it
      c.order = cueSerial += 1;
      if (!s.cues.includes(cue)) s.cues.push(cue);
      c.track = this;
      sortCues(s);
      cuesChanged(s);
    }
    removeCue(cue: Any): void {
      if (!(cue instanceof TextTrackCue)) {
        throw new TypeError(
          "Failed to execute 'removeCue' on 'TextTrack': parameter 1 is not of type 'TextTrackCue'.",
        );
      }
      const s = trackState(this);
      const at = s.cues.indexOf(cue);
      if (at < 0) {
        throw new DOMException(
          "Failed to execute 'removeCue' on 'TextTrack': The specified cue is not listed in the TextTrack's list of cues.",
          'NotFoundError',
        );
      }
      s.cues.splice(at, 1);
      const c = cueState(cue);
      c.track = null;
      c.active = false;
      cuesChanged(s);
    }
  }
  handlers(TextTrack, ['cuechange']);

  const makeTrack = (
    kind: string,
    label: string,
    language: string,
    element: Any,
    media: Any,
  ): Any => {
    making = true;
    let track: Any;
    let cueList: Any;
    let activeList: Any;
    try {
      track = new TextTrack();
      cueList = new TextTrackCueList();
      activeList = new TextTrackCueList();
    } finally {
      making = false;
    }
    const state: TrackState = {
      kind,
      label,
      language,
      mode: 'disabled',
      element,
      media,
      ready: 0,
      cues: [],
      cueList: null,
      activeList: null,
      chosen: false,
      load: 0,
      url: '',
      activeKey: '',
    };
    state.cueList = indexed(cueList, () => state.cues);
    state.activeList = indexed(activeList, () =>
      state.cues.filter((c: Any) => cueState(c).active),
    );
    TRACKS.set(track, state);
    return track;
  };

  const setMode = (track: Any, mode: Mode, script: boolean): void => {
    const s = trackState(track);
    if (script) s.chosen = true;
    if (s.mode === mode) return;
    s.mode = mode;
    if (mode === 'disabled') {
      for (const c of s.cues) cueState(c).active = false;
      s.activeKey = '';
    }
    // a `<track>` loads once its track is wanted (4.8.11.11.3)
    if (mode !== 'disabled' && s.element && s.ready === 0) startLoad(track);
    if (s.media) {
      const m = mediaState(s.media);
      if (!m.changeOwed) {
        m.changeOwed = true;
        D.later(() => {
          m.changeOwed = false;
          D.fire(m.list, new Event('change'));
        }, 0);
      }
      cuesChanged(s);
    }
  };

  // --- cues ---------------------------------------------------------------------

  interface CueState {
    track: Any;
    id: string;
    start: number;
    end: number;
    pauseOnExit: boolean;
    active: boolean;
    /** Its place among the cues, for the order of those that start and end
     *  together. */
    order: number;
  }
  const CUES = new WeakMap<object, CueState>();
  let cueSerial = 0;
  const cueState = (cue: Any): CueState => {
    const state = CUES.get(cue);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  };
  const sortCues = (s: TrackState): void => {
    s.cues.sort((a: Any, b: Any) => {
      const x = cueState(a);
      const y = cueState(b);
      return x.start - y.start || y.end - x.end || x.order - y.order;
    });
  };
  /** The cues of a track changed: the time marches on at once, so a cue
   *  added where the clock is is active as `addCue` returns. One that shows
   *  its poster holds no cue active yet: no `cuechange` comes of a track
   *  loading before it plays. */
  const cuesChanged = (s: TrackState): void => {
    const media = s.media;
    if (media) timeMarchesOn(media, false);
  };
  const finite = (v: Any, name: string, of: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new TypeError(
        `Failed to set the '${name}' property on '${of}': The provided double value is non-finite.`,
      );
    }
    return n;
  };

  class TextTrackCueList {
    constructor() {
      if (!making) illegal();
    }
    get length(): number {
      return itemsOf(this).length;
    }
    getCueById(id: Any): Any {
      const key = String(id);
      if (key === '') return null;
      return itemsOf(this).find((c: Any) => cueState(c).id === key) ?? null;
    }
    [Symbol.iterator](): Iterator<Any> {
      return itemsOf(this)[Symbol.iterator]();
    }
  }

  class TextTrackCue extends EventTarget {
    constructor(start?: Any, end?: Any) {
      if (new.target === TextTrackCue) illegal();
      super();
      CUES.set(this, {
        track: null,
        id: '',
        start: Number(start) || 0,
        end: Number(end) || 0,
        pauseOnExit: false,
        active: false,
        order: (cueSerial += 1),
      });
    }
    get track(): Any {
      return cueState(this).track;
    }
    get id(): string {
      return cueState(this).id;
    }
    set id(v: Any) {
      cueState(this).id = String(v);
    }
    get startTime(): number {
      return cueState(this).start;
    }
    set startTime(v: Any) {
      const c = cueState(this);
      c.start = finite(v, 'startTime', 'TextTrackCue');
      if (c.track) {
        sortCues(trackState(c.track));
        cuesChanged(trackState(c.track));
      }
    }
    get endTime(): number {
      return cueState(this).end;
    }
    set endTime(v: Any) {
      const c = cueState(this);
      const n = Number(v);
      // an end at infinity is a cue that lasts as long as the media
      c.end = n === Infinity ? n : finite(v, 'endTime', 'TextTrackCue');
      if (c.track) {
        sortCues(trackState(c.track));
        cuesChanged(trackState(c.track));
      }
    }
    get pauseOnExit(): boolean {
      return cueState(this).pauseOnExit;
    }
    set pauseOnExit(v: Any) {
      cueState(this).pauseOnExit = !!v;
    }
  }
  handlers(TextTrackCue, ['enter', 'exit']);

  // --- VTTCue and VTTRegion (WebVTT 6) -------------------------------------

  interface VttState {
    vertical: string;
    snapToLines: boolean;
    line: number | 'auto';
    lineAlign: string;
    position: number | 'auto';
    positionAlign: string;
    size: number;
    align: string;
    text: string;
    region: Any;
  }
  const VTT = new WeakMap<object, VttState>();
  const vttState = (cue: Any): VttState => {
    const state = VTT.get(cue);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  };
  const enumIn = (v: Any, values: string[]): string | null => {
    const s = String(v);
    return values.includes(s) ? s : null;
  };
  const autoOrNumber = (v: Any, name: string): number | 'auto' => {
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      return finite(v, name, 'VTTCue');
    }
    if (String(v) === 'auto') return 'auto';
    if (typeof v === 'string') {
      throw new TypeError(
        `Failed to set the '${name}' property on 'VTTCue': The provided value '${v}' is not a valid enum value of type AutoKeyword.`,
      );
    }
    return finite(v, name, 'VTTCue');
  };

  class VTTCue extends TextTrackCue {
    constructor(startTime: Any, endTime: Any, text: Any) {
      if (arguments.length < 3) {
        throw new TypeError(
          `Failed to construct 'VTTCue': 3 arguments required, but only ${arguments.length} present.`,
        );
      }
      const start = Number(startTime);
      const end = Number(endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new TypeError(
          "Failed to construct 'VTTCue': The provided double value is non-finite.",
        );
      }
      super(start, end);
      VTT.set(this, {
        vertical: '',
        snapToLines: true,
        line: 'auto',
        lineAlign: 'start',
        position: 'auto',
        positionAlign: 'auto',
        size: 100,
        align: 'center',
        text: String(text),
        region: null,
      });
    }
    get region(): Any {
      return vttState(this).region;
    }
    set region(v: Any) {
      if (v !== null && v !== undefined && !(v instanceof VTTRegion)) {
        throw new TypeError(
          "Failed to set the 'region' property on 'VTTCue': The provided value is not of type 'VTTRegion'.",
        );
      }
      vttState(this).region = v ?? null;
    }
    get vertical(): string {
      return vttState(this).vertical;
    }
    set vertical(v: Any) {
      const value = enumIn(v, ['', 'rl', 'lr']);
      if (value !== null) vttState(this).vertical = value;
    }
    get snapToLines(): boolean {
      return vttState(this).snapToLines;
    }
    set snapToLines(v: Any) {
      vttState(this).snapToLines = !!v;
    }
    get line(): number | 'auto' {
      return vttState(this).line;
    }
    set line(v: Any) {
      vttState(this).line = autoOrNumber(v, 'line');
    }
    get lineAlign(): string {
      return vttState(this).lineAlign;
    }
    set lineAlign(v: Any) {
      const value = enumIn(v, ['start', 'center', 'end']);
      if (value !== null) vttState(this).lineAlign = value;
    }
    get position(): number | 'auto' {
      return vttState(this).position;
    }
    set position(v: Any) {
      const value = autoOrNumber(v, 'position');
      if (value !== 'auto' && (value < 0 || value > 100)) {
        throw new DOMException(
          `Failed to set the 'position' property on 'VTTCue': The value provided (${value}) is outside the range [0, 100].`,
          'IndexSizeError',
        );
      }
      vttState(this).position = value;
    }
    get positionAlign(): string {
      return vttState(this).positionAlign;
    }
    set positionAlign(v: Any) {
      const value = enumIn(v, ['line-left', 'center', 'line-right', 'auto']);
      if (value !== null) vttState(this).positionAlign = value;
    }
    get size(): number {
      return vttState(this).size;
    }
    set size(v: Any) {
      const value = finite(v, 'size', 'VTTCue');
      if (value < 0 || value > 100) {
        throw new DOMException(
          `Failed to set the 'size' property on 'VTTCue': The value provided (${value}) is outside the range [0, 100].`,
          'IndexSizeError',
        );
      }
      vttState(this).size = value;
    }
    get align(): string {
      return vttState(this).align;
    }
    set align(v: Any) {
      const value = enumIn(v, ['start', 'center', 'end', 'left', 'right']);
      if (value !== null) vttState(this).align = value;
    }
    get text(): string {
      return vttState(this).text;
    }
    set text(v: Any) {
      vttState(this).text = String(v);
    }
    getCueAsHTML(): Any {
      return cueFragment(vttState(this).text);
    }
  }

  interface RegionState {
    id: string;
    width: number;
    lines: number;
    regionAnchorX: number;
    regionAnchorY: number;
    viewportAnchorX: number;
    viewportAnchorY: number;
    scroll: string;
  }
  const REGIONS = new WeakMap<object, RegionState>();
  const regionState = (r: Any): RegionState => {
    const state = REGIONS.get(r);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  };
  const percent = (v: Any, name: string): number => {
    const n = finite(v, name, 'VTTRegion');
    if (n < 0 || n > 100) {
      throw new DOMException(
        `Failed to set the '${name}' property on 'VTTRegion': The value provided (${n}) is outside the range [0, 100].`,
        'IndexSizeError',
      );
    }
    return n;
  };
  class VTTRegion {
    constructor() {
      REGIONS.set(this, {
        id: '',
        width: 100,
        lines: 3,
        regionAnchorX: 0,
        regionAnchorY: 100,
        viewportAnchorX: 0,
        viewportAnchorY: 100,
        scroll: '',
      });
    }
    get id(): string {
      return regionState(this).id;
    }
    set id(v: Any) {
      regionState(this).id = String(v);
    }
    get width(): number {
      return regionState(this).width;
    }
    set width(v: Any) {
      regionState(this).width = percent(v, 'width');
    }
    get lines(): number {
      return regionState(this).lines;
    }
    set lines(v: Any) {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        throw new TypeError(
          "Failed to set the 'lines' property on 'VTTRegion': Value is not of type 'unsigned long'.",
        );
      }
      regionState(this).lines = Math.trunc(n) >>> 0;
    }
    get regionAnchorX(): number {
      return regionState(this).regionAnchorX;
    }
    set regionAnchorX(v: Any) {
      regionState(this).regionAnchorX = percent(v, 'regionAnchorX');
    }
    get regionAnchorY(): number {
      return regionState(this).regionAnchorY;
    }
    set regionAnchorY(v: Any) {
      regionState(this).regionAnchorY = percent(v, 'regionAnchorY');
    }
    get viewportAnchorX(): number {
      return regionState(this).viewportAnchorX;
    }
    set viewportAnchorX(v: Any) {
      regionState(this).viewportAnchorX = percent(v, 'viewportAnchorX');
    }
    get viewportAnchorY(): number {
      return regionState(this).viewportAnchorY;
    }
    set viewportAnchorY(v: Any) {
      regionState(this).viewportAnchorY = percent(v, 'viewportAnchorY');
    }
    get scroll(): string {
      return regionState(this).scroll;
    }
    set scroll(v: Any) {
      const value = enumIn(v, ['', 'up']);
      if (value !== null) regionState(this).scroll = value;
    }
  }

  // --- the WebVTT parser (WebVTT 6.1) --------------------------------------

  /** A timestamp at `at` of `line`, and where it ends, or null. */
  const timestamp = (line: string, at: number): [number, number] | null => {
    const digits = (): string => {
      let s = '';
      while (at < line.length && line[at] >= '0' && line[at] <= '9') {
        s += line[at];
        at += 1;
      }
      return s;
    };
    const first = digits();
    if (!first) return null;
    let hoursFirst = first.length !== 2 || Number(first) > 59;
    if (line[at] !== ':') return null;
    at += 1;
    const second = digits();
    if (second.length !== 2) return null;
    let hours = 0;
    let minutes: number;
    let seconds: number;
    if (hoursFirst || line[at] === ':') {
      if (line[at] !== ':') return null;
      at += 1;
      const third = digits();
      if (third.length !== 2) return null;
      hours = Number(first);
      minutes = Number(second);
      seconds = Number(third);
      hoursFirst = true;
    } else {
      minutes = Number(first);
      seconds = Number(second);
    }
    if (line[at] !== '.') return null;
    at += 1;
    const fraction = digits();
    if (fraction.length !== 3) return null;
    if (minutes > 59 || seconds > 59) return null;
    return [
      hours * 3600 + minutes * 60 + seconds + Number(fraction) / 1000,
      at,
    ];
  };

  const skipSpace = (line: string, at: number): number => {
    while (
      at < line.length &&
      (line[at] === ' ' || line[at] === '\t' || line[at] === '\f')
    ) {
      at += 1;
    }
    return at;
  };

  /** A cue's timings and settings, or null where the line is none. */
  const timings = (
    line: string,
  ): { start: number; end: number; settings: string } | null => {
    let at = skipSpace(line, 0);
    const start = timestamp(line, at);
    if (!start) return null;
    at = skipSpace(line, start[1]);
    if (line.slice(at, at + 3) !== '-->') return null;
    at = skipSpace(line, at + 3);
    const end = timestamp(line, at);
    if (!end) return null;
    return { start: start[0], end: end[0], settings: line.slice(end[1]) };
  };

  /** A setting's number: digits with a point, and `%` where it is a
   *  percentage. */
  const parsePercent = (v: string): number | null => {
    if (!/^\d+(\.\d+)?%$/.test(v)) return null;
    const n = Number(v.slice(0, -1));
    return n >= 0 && n <= 100 ? n : null;
  };

  const applySettings = (
    cue: Any,
    settings: string,
    regions: Map<string, Any>,
  ) => {
    const s = vttState(cue);
    for (const setting of settings.split(/[ \t]+/)) {
      const colon = setting.indexOf(':');
      if (colon <= 0 || colon === setting.length - 1) continue;
      const name = setting.slice(0, colon);
      const value = setting.slice(colon + 1);
      if (name === 'region') {
        s.region = regions.get(value) ?? null;
      } else if (name === 'vertical') {
        if (value === 'rl' || value === 'lr') s.vertical = value;
      } else if (name === 'line') {
        const [pos, align] = value.split(',');
        if (align !== undefined) {
          if (!['start', 'center', 'end'].includes(align)) continue;
        }
        let line: number | null = null;
        let snap = true;
        if (pos.endsWith('%')) {
          line = parsePercent(pos);
          snap = false;
        } else if (/^-?\d+(\.\d+)?$/.test(pos)) {
          line = Number(pos);
        }
        if (line === null) continue;
        s.line = line;
        s.snapToLines = snap;
        if (align !== undefined) s.lineAlign = align;
      } else if (name === 'position') {
        const [pos, align] = value.split(',');
        const n = parsePercent(pos);
        if (n === null) continue;
        if (
          align !== undefined &&
          !['line-left', 'center', 'line-right'].includes(align)
        ) {
          continue;
        }
        s.position = n;
        if (align !== undefined) s.positionAlign = align;
      } else if (name === 'size') {
        const n = parsePercent(value);
        if (n !== null) s.size = n;
      } else if (name === 'align') {
        if (['start', 'center', 'end', 'left', 'right'].includes(value)) {
          s.align = value;
        }
      }
    }
    if (
      s.region &&
      (s.vertical !== '' || s.line !== 'auto' || s.size !== 100)
    ) {
      s.region = null;
    }
  };

  /** A WebVTT file's cues, or null where it is no WebVTT file. */
  const parseVtt = (input: string): Any[] | null => {
    let text = input.replace(/\u0000/g, '�');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r\n|\r|\n/);
    const head = lines[0] ?? '';
    if (!/^WEBVTT([ \t].*)?$/.test(head)) return null;
    const cues: Any[] = [];
    const regions = new Map<string, Any>();
    let i = 1;
    // the header, to the first blank line, unless a cue's timings come
    // first
    while (i < lines.length && lines[i] !== '' && !lines[i].includes('-->')) {
      i += 1;
    }
    let seenCue = false;
    while (i < lines.length) {
      while (i < lines.length && lines[i] === '') i += 1;
      if (i >= lines.length) break;
      const block: string[] = [];
      let arrow = false;
      while (i < lines.length && lines[i] !== '') {
        // the arrow is a cue's timings as its first line, or its second
        // after an identifier; anywhere else it starts the next block
        // (WebVTT 6.1, "collect a WebVTT block")
        if (lines[i].includes('-->')) {
          const count = block.length + 1;
          if (count === 1 || (count === 2 && !arrow)) arrow = true;
          else break;
        }
        block.push(lines[i]);
        i += 1;
      }
      const first = block[0];
      if (/^NOTE($|[ \t])/.test(first)) continue;
      if (!seenCue && /^(STYLE|REGION)[ \t]*$/.test(first)) {
        if (first.startsWith('REGION')) {
          const region = new VTTRegion();
          for (const line of block.slice(1)) {
            for (const setting of line.split(/[ \t]+/)) {
              const colon = setting.indexOf(':');
              if (colon <= 0) continue;
              const name = setting.slice(0, colon);
              const value = setting.slice(colon + 1);
              if (name === 'id') regionState(region).id = value;
              else if (name === 'width') {
                const n = parsePercent(value);
                if (n !== null) regionState(region).width = n;
              } else if (name === 'lines' && /^\d+$/.test(value)) {
                regionState(region).lines = Number(value);
              } else if (name === 'scroll' && value === 'up') {
                regionState(region).scroll = 'up';
              }
            }
          }
          const id = regionState(region).id;
          if (id) regions.set(id, region);
        }
        continue;
      }
      let at = 0;
      let id = '';
      if (!block[0].includes('-->')) {
        id = block[0];
        at = 1;
      }
      if (at >= block.length) continue;
      const timing = timings(block[at]);
      if (!timing) continue;
      seenCue = true;
      const cue = new VTTCue(
        timing.start,
        timing.end,
        block.slice(at + 1).join('\n'),
      );
      cueState(cue).id = id;
      applySettings(cue, timing.settings, regions);
      cues.push(cue);
    }
    return cues;
  };

  // --- a cue's text as HTML (WebVTT 6.4) -----------------------------------

  const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    lrm: '‎',
    rlm: '‏',
    nbsp: ' ',
    quot: '"',
    apos: "'",
  };
  const decode = (s: string): string =>
    s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
      if (name[0] === '#') {
        const code =
          name[1] === 'x' || name[1] === 'X'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[name] ?? whole;
    });

  const cueFragment = (text: string): Any => {
    const doc: Any = D.document();
    const fragment = doc.createDocumentFragment();
    const stack: Any[] = [fragment];
    const TAGS: Record<string, string> = {
      c: 'span',
      i: 'i',
      b: 'b',
      u: 'u',
      ruby: 'ruby',
      rt: 'rt',
      v: 'span',
      lang: 'span',
    };
    const open: string[] = [];
    // an empty cue is one empty text node
    if (text === '') fragment.appendChild(doc.createTextNode(''));
    let at = 0;
    while (at < text.length) {
      const lt = text.indexOf('<', at);
      const chunk = text.slice(at, lt < 0 ? text.length : lt);
      if (chunk)
        stack[stack.length - 1].appendChild(doc.createTextNode(decode(chunk)));
      if (lt < 0) break;
      const gt = text.indexOf('>', lt);
      const tag = text.slice(lt + 1, gt < 0 ? text.length : gt);
      at = gt < 0 ? text.length : gt + 1;
      if (tag.startsWith('/')) {
        // an end tag's name is all of it, as WebVTT's tokenizer reads it:
        // `</ b>` closes no `<b>`
        const name = tag.slice(1);
        const where = open.lastIndexOf(name);
        if (where >= 0) {
          open.length = where;
          stack.length = where + 1;
        }
        continue;
      }
      if (/^\d/.test(tag)) {
        // a timestamp inside the cue: a processing instruction
        const stamp = timestamp(tag, 0);
        if (stamp) {
          stack[stack.length - 1].appendChild(
            doc.createProcessingInstruction('timestamp', tag),
          );
        }
        continue;
      }
      const space = tag.search(/[ \t\n\f]/);
      const head = space < 0 ? tag : tag.slice(0, space);
      const annotation = space < 0 ? '' : tag.slice(space + 1).trim();
      const [name, ...classes] = head.split('.');
      const html = TAGS[name];
      if (!html) continue;
      if (name === 'rt' && open[open.length - 1] !== 'ruby') continue;
      const el = doc.createElement(html);
      const cls = classes.filter(Boolean).join(' ');
      if (cls) el.className = cls;
      if (name === 'v' && annotation) el.title = decode(annotation);
      if (name === 'lang' && annotation) el.lang = annotation;
      stack[stack.length - 1].appendChild(el);
      stack.push(el);
      open.push(name);
    }
    return fragment;
  };

  // --- a `<track>`'s track and its loading (4.8.11.11.3) ------------------

  const ELEMENT_TRACK = new WeakMap<object, Any>();
  const trackOf = (element: Any): Any => {
    let track = ELEMENT_TRACK.get(element);
    if (!track) {
      track = makeTrack(
        String(element.kind ?? 'subtitles'),
        String(element.label ?? ''),
        String(element.srclang ?? ''),
        element,
        null,
      );
      ELEMENT_TRACK.set(element, track);
    }
    const s = trackState(track);
    // what it is read from its element each time, as the attributes are
    s.kind = String(element.kind ?? 'subtitles');
    s.label = String(element.label ?? '');
    s.language = String(element.srclang ?? '');
    const parent = element.parentNode;
    if (parent && D.isMedia(parent)) sync(parent);
    return track;
  };

  let loads = 0;
  const startLoad = (track: Any): void => {
    const s = trackState(track);
    const element = s.element;
    if (!element || !s.media) return;
    const load = (loads += 1);
    s.load = load;
    // a task later, as the track's processing model runs in parallel
    D.later(() => {
      // one taken out of its media element since loads nothing
      if (s.load !== load || !s.media) return;
      s.ready = 1;
      const url = String(element.src ?? '');
      s.url = url;
      const failed = (): void => {
        if (s.load !== load) return;
        s.ready = 3;
        D.fire(element, new Event('error'));
        settled(s.media);
      };
      if (!url) {
        failed();
        return;
      }
      const cors = s.media.getAttribute?.('crossorigin');
      const init =
        cors === null || cors === undefined
          ? { mode: 'same-origin', credentials: 'same-origin' }
          : {
              mode: 'cors',
              credentials:
                cors === 'use-credentials' ? 'include' : 'same-origin',
            };
      D.fetch(url, init).then(
        (response: Any) => {
          if (s.load !== load) return;
          if (!response.ok) return failed();
          return response.text().then((body: string) => {
            if (s.load !== load) return;
            const cues = parseVtt(body);
            if (!cues) return failed();
            for (const cue of cues) {
              cueState(cue).track = track;
              s.cues.push(cue);
            }
            sortCues(s);
            s.ready = 2;
            D.fire(element, new Event('load'));
            cuesChanged(s);
            settled(s.media);
          }, failed);
        },
        () => failed(),
      );
    }, 0);
  };

  /** A `<track>`'s `src` changed: its cues gone, and loaded again where it
   *  is wanted. */
  const srcChanged = (element: Any): void => {
    const track = ELEMENT_TRACK.get(element);
    if (!track) return;
    const s = trackState(track);
    // the same address again loads nothing, as every browser has it
    if (s.ready === 2 && String(element.src ?? '') === s.url) return;
    // a load under way is let go, and told as a failure, as Chromium tells
    // it: what it would have brought never comes
    if (s.ready === 1) {
      D.later(() => D.fire(element, new Event('error')), 0);
    }
    s.load = loads += 1;
    for (const c of s.cues) cueState(c).track = null;
    s.cues.length = 0;
    s.ready = 0;
    if (s.mode !== 'disabled' && s.media) startLoad(track);
  };

  // --- the list kept in step with the `<track>`s (4.8.11.11.1) -------------

  const sync = (media: Any): void => {
    const m = mediaState(media);
    const elements: Any[] = [];
    for (const child of Array.from(media.children as ArrayLike<Any>)) {
      if (D.isTrack(child)) elements.push(child);
    }
    const before = m.elements;
    m.elements = elements;
    const tracks = elements.map((el) => {
      let track = ELEMENT_TRACK.get(el);
      if (!track) {
        track = makeTrack(
          String(el.kind ?? 'subtitles'),
          String(el.label ?? ''),
          String(el.srclang ?? ''),
          el,
          media,
        );
        ELEMENT_TRACK.set(el, track);
      }
      return track;
    });
    const was = m.tracks;
    m.tracks = [...tracks, ...m.added];
    for (const el of before) {
      if (!elements.includes(el)) {
        const track = ELEMENT_TRACK.get(el);
        if (!track) continue;
        const s = trackState(track);
        s.media = null;
        D.later(() => {
          D.fire(m.list, new TrackEvent('removetrack', { track }));
        }, 0);
      }
    }
    for (const track of tracks) {
      if (was.includes(track)) continue;
      const s = trackState(track);
      s.media = media;
      D.later(() => {
        D.fire(m.list, new TrackEvent('addtrack', { track }));
      }, 0);
      // a track already wanted loads as it comes to the element
      if (s.mode !== 'disabled' && s.ready === 0) startLoad(track);
    }
    if (tracks.some((t) => !was.includes(t)) && !m.selectOwed) {
      // a task after the track came, as the selection is queued
      m.selectOwed = true;
      D.later(() => {
        m.selectOwed = false;
        select(media);
        settled(media);
      }, 0);
    }
  };

  /** Whether a media element's tracks hold its ready state: one wanted and
   *  not yet loaded or failed, or the selection still owed. */
  const pending = (media: Any): boolean => {
    const m = MEDIA.get(media);
    if (!m) return false;
    if (m.selectOwed) return true;
    return m.tracks.some((t: Any) => {
      const s = trackState(t);
      return (
        s.element &&
        s.mode !== 'disabled' &&
        (s.ready === 1 || (s.ready === 0 && s.load !== 0))
      );
    });
  };
  /** What waited for the tracks, let go once none is pending. */
  const settled = (media: Any): void => {
    if (!media) return;
    const m = MEDIA.get(media);
    if (!m || !m.waiting.length || pending(media)) return;
    const waiting = m.waiting;
    m.waiting = [];
    for (const fn of waiting) fn();
  };

  /** HTML's automatic text track selection: the first `default` track of
   *  each kind shown, where nothing else of the kind is, and a `default`
   *  metadata track hidden. */
  const select = (media: Any): void => {
    const m = mediaState(media);
    const groups: Record<string, string[]> = {
      text: ['subtitles', 'captions'],
      descriptions: ['descriptions'],
      chapters: ['chapters'],
    };
    for (const kinds of Object.values(groups)) {
      const of = m.tracks.filter((t: Any) =>
        kinds.includes(trackState(t).kind),
      );
      if (of.some((t: Any) => trackState(t).mode === 'showing')) continue;
      const pick = of.find((t: Any) => {
        const s = trackState(t);
        return (
          s.element && !s.chosen && s.mode === 'disabled' && s.element.default
        );
      });
      if (pick) setMode(pick, 'showing', false);
    }
    for (const t of m.tracks) {
      const s = trackState(t);
      if (
        s.kind === 'metadata' &&
        s.element &&
        !s.chosen &&
        s.mode === 'disabled' &&
        s.element.default
      ) {
        setMode(t, 'hidden', false);
      }
    }
  };

  const add = (media: Any, kind: Any, label: Any, language: Any): Any => {
    const k = String(kind);
    if (!KINDS.includes(k)) {
      throw new TypeError(
        `Failed to execute 'addTextTrack' on 'HTMLMediaElement': The provided value '${k}' is not a valid enum value of type TextTrackKind.`,
      );
    }
    const m = mediaState(media);
    sync(media);
    const track = makeTrack(
      k,
      label === undefined ? '' : String(label),
      language === undefined ? '' : String(language),
      null,
      media,
    );
    trackState(track).mode = 'hidden';
    m.added.push(track);
    m.tracks = [...m.tracks, track];
    D.later(() => {
      D.fire(m.list, new TrackEvent('addtrack', { track }));
    }, 0);
    return track;
  };

  // --- time marches on (4.8.11.8) --------------------------------------------

  const timeMarchesOn = (media: Any, seeked: boolean): void => {
    const m = MEDIA.get(media);
    if (!m) return;
    const { time, paused, ready, poster } = D.clock(media);
    // nothing is current before the element knows its media, or under its
    // poster (4.8.11.8, step 1): what was current exits
    const none = poster || ready === 0;
    const last = m.last;
    m.last = time;
    const entering: [Any, Any][] = [];
    const exiting: [Any, Any][] = [];
    const missed: [Any, Any][] = [];
    const touched = new Set<Any>();
    const normal = !seeked && !none && time >= last;
    for (const track of m.tracks) {
      const s = trackState(track);
      if (s.mode === 'disabled') continue;
      for (const cue of s.cues) {
        const c = cueState(cue);
        const now = !none && c.start <= time && time < c.end;
        if (now && !c.active) {
          c.active = true;
          entering.push([cue, track]);
          touched.add(track);
        } else if (!now && c.active) {
          c.active = false;
          exiting.push([cue, track]);
          touched.add(track);
        } else if (!now && normal && c.start >= last && c.end <= time) {
          missed.push([cue, track]);
          touched.add(track);
        }
      }
    }
    if (!entering.length && !exiting.length && !missed.length) return;
    // a cue that ends while it plays, whose `pauseOnExit` is set, pauses it
    if (
      normal &&
      !paused &&
      [...exiting, ...missed].some(([cue]) => cueState(cue).pauseOnExit)
    ) {
      D.pause(media);
    }
    const byTime = (a: [Any, Any], b: [Any, Any]): number =>
      cueState(a[0]).start - cueState(b[0]).start ||
      cueState(a[0]).order - cueState(b[0]).order;
    // an exit is at the later of the cue's end and its start, so a cue that
    // ends before it starts exits after it enters (step 11)
    const exitAt = (cue: Any): number =>
      Math.max(cueState(cue).end, cueState(cue).start);
    const events: [Any, string, number][] = [];
    for (const [cue] of missed) {
      events.push([cue, 'enter', cueState(cue).start]);
      events.push([cue, 'exit', exitAt(cue)]);
    }
    for (const [cue] of entering)
      events.push([cue, 'enter', cueState(cue).start]);
    for (const [cue] of exiting) events.push([cue, 'exit', exitAt(cue)]);
    events.sort(
      (a, b) =>
        a[2] - b[2] ||
        (a[1] === b[1] ? 0 : a[1] === 'exit' ? -1 : 1) ||
        byTime([a[0], null], [b[0], null]),
    );
    D.later(() => {
      for (const [cue, type] of events) D.fire(cue, new Event(type));
      for (const track of m.tracks) {
        if (!touched.has(track)) continue;
        D.fire(track, new Event('cuechange'));
        const el = trackState(track).element;
        if (el) D.fire(el, new Event('cuechange'));
      }
    }, 0);
  };

  /** Tree changes: the watched media elements' `<track>`s looked at again
   *  after the task. */
  let dirtyOwed = false;
  const dirty = (): void => {
    if (dirtyOwed || watched.size === 0) return;
    dirtyOwed = true;
    D.later(() => {
      dirtyOwed = false;
      for (const media of watched) sync(media);
    }, 0);
  };

  return {
    interfaces: {
      TextTrackList,
      TextTrack,
      TextTrackCueList,
      TextTrackCue,
      VTTCue,
      VTTRegion,
      TrackEvent,
    },
    internals: {
      listOf: (media: Any) => {
        sync(media);
        return mediaState(media).list;
      },
      add,
      trackOf,
      readyStateOf: (element: Any) => {
        const track = ELEMENT_TRACK.get(element);
        return track ? trackState(track).ready : 0;
      },
      sync,
      srcChanged,
      timeMarchesOn,
      watch: (media: Any) => {
        mediaState(media);
      },
      dirty,
      sweep: (tracks: ArrayLike<Any>) => {
        for (const track of Array.from(tracks)) {
          const parent = track.parentNode;
          if (parent && D.isMedia(parent)) sync(parent);
        }
      },
      pending: (media: Any) => {
        sync(media);
        return pending(media);
      },
      whenReady: (media: Any, fn: () => void) => {
        mediaState(media).waiting.push(fn);
        settled(media);
      },
    },
  };
}
