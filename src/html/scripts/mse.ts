// Media Source Extensions, as a page's scripts see it: a `MediaSource`, which
// a media element opens through an object URL, and the `SourceBuffer`
// interface a player reads off the global before it makes one.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` calls it with what it reaches
// the element by.
//
// **What plays a page's media is a player the host mounts over the box, which
// opens a URL** (`videos.ts`, `sounds.ts`), and nothing hands it bytes as a
// page appends them. So `isTypeSupported` says no to every type, and hls.js,
// which asks it before it chooses, goes on to `canPlayType` and sets the
// playlist as the element's `src`, where the player has it. A yes to what
// `canPlayType` says yes to would take those streams from a player that plays
// them to a buffer nothing reads.
//
// **A clip is another matter.** Apple's product pages make a `MediaSource` in
// every browser that is not Safari, without asking, and `addSourceBuffer` a
// few seconds of VP9 in WebM that they fetched whole, which they scrub with
// the scroll. That is the one type `addSourceBuffer` takes, where the host's
// player plays VP9 (`clips.ts`): what is appended is kept on the host's side,
// and when the page ends the stream the host hands the player a file of it.
// Asked first, `isTypeSupported` still says no, since a streaming player would
// append and show nothing until its end.
//
// **A page's other types have the path they always had**: `addSourceBuffer`
// throws the `NotSupportedError` a browser throws for a type it cannot decode.
// A stream that ends with no `SourceBuffer` fails its element, as Chrome's
// does given no tracks.
//
// A worker's global has none of it (`WINDOW_ONLY`), and
// `canConstructInDedicatedWorker` says so.

/** What `installDom` hands this. */
export interface MseDeps {
  DOMException: unknown;
  EventTarget: unknown;
  /** Sets a target's `on<type>` handler, which takes its place among
   *  its listeners as it is first set (HTML 8.1.8.1). */
  setHandler(target: unknown, type: string, value: unknown): void;
  Event: unknown;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  /** Runs a step in a task of its own, in order with the media element's
   *  (HTML's "queue a media element task"). */
  task(fn: () => void): void;
  /** Asks the host (`mse…`, `clips.ts`): a primitive each way. */
  host(op: string, a?: unknown, b?: unknown, c?: unknown): unknown;
  /** Bytes as base64, the form they cross to the host in. */
  base64(bytes: Uint8Array): string;
}

/** The media element a source is attached to, as the source tells it. */
export interface MseElement {
  /** The element, as the host numbers it. */
  id: number;
  durationChanged(duration: number): void;
  /** The stream ended with nothing to play. */
  failed(): void;
  /** The stream's head has been read: its length and its picture's size. */
  metadata(duration: number, width: number, height: number): void;
  /** What is buffered moved. */
  buffered(): void;
  /** The stream has ended, with something to play. */
  ended(): void;
}

export interface MseInstalled {
  interfaces: Record<string, unknown>;
  isSource(value: unknown): boolean;
  /** MSE 3.15.1, attaching to a media element: false where the source is
   *  not closed, which is a failure of the element's. */
  attach(source: unknown, element: MseElement): boolean;
  /** MSE 3.15.2, detaching from a media element. */
  detach(source: unknown): void;
  /** What a source has buffered, as a `TimeRanges`. */
  buffered(source: unknown): unknown;
  /** Whether it has `time`, and how far on it has it from there. */
  ahead(source: unknown, time: number): number;
}

export function installMse(deps: MseDeps): MseInstalled {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const DOMException: Any = D.DOMException;
  const EventTarget: Any = D.EventTarget;
  const setHandler: Any = D.setHandler;
  const Event: Any = D.Event;
  const fire: Any = D.fire;
  const task: Any = D.task;
  const host: Any = D.host;
  const base64: Any = D.base64;
  const parse: Any = JSON.parse;
  const isView: Any = ArrayBuffer.isView;
  const classOf: Any = Object.prototype.toString;
  const Uint8: Any = Uint8Array;

  const WM: Any = WeakMap;
  const wmGet: Any = WM.prototype.get;
  const wmSet: Any = WM.prototype.set;
  const apply: Any = Reflect.apply;
  const TOKEN = Object.freeze(Object.create(null));

  const typeError = (message: string): Any => new TypeError(message);
  const illegal = (): Any => typeError('Illegal invocation');
  const illegalConstructor = (name: string): Any =>
    typeError(`Failed to construct '${name}': Illegal constructor`);
  const failed = (method: string, message: string): string =>
    `Failed to execute '${method}' on 'MediaSource': ${message}`;
  const notOpen = (context: string): Any =>
    new DOMException(
      `${context}: The MediaSource's readyState is not 'open'.`,
      'InvalidStateError',
    );

  const slots = new WM();
  const slotOf = (self: Any, tag: string): Any => {
    const s =
      self && typeof self === 'object' ? apply(wmGet, slots, [self]) : null;
    if (!s || !s[tag]) throw illegal();
    return s;
  };

  /** An event handler IDL attribute, which the realm's `EventTarget`
   *  runs from `_handlers` as it dispatches. */
  const handler = (proto: Any, name: string): void => {
    const get = function (this: Any) {
      return this._handlers[name] ?? null;
    };
    const set = function (this: Any, fn: Any) {
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

  class SourceBufferList extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor('SourceBufferList');
      apply(wmSet, slots, [this, { list: true, items: [] }]);
    }
    get length(): number {
      return slotOf(this, 'list').items.length;
    }
  }
  handler(SourceBufferList.prototype, 'addsourcebuffer');
  handler(SourceBufferList.prototype, 'removesourcebuffer');
  // Web IDL 3.7.8: an interface with an indexed getter and a length
  Object.defineProperty(SourceBufferList.prototype, Symbol.iterator, {
    value: Array.prototype.values,
    writable: true,
    configurable: true,
  });

  /** A list's indexed getter: its items as its own numbered properties. */
  const listed = (list: Any): void => {
    const { items } = slotOf(list, 'list');
    // an `EventTarget`'s own fields are the realm's: only the numbers go
    for (let i = items.length; i in list; i += 1) delete list[i];
    items.forEach((item: Any, i: number) => {
      Object.defineProperty(list, i, {
        value: item,
        enumerable: true,
        configurable: true,
      });
    });
  };
  const addTo = (list: Any, item: Any): void => {
    slotOf(list, 'list').items.push(item);
    listed(list);
    task(() => fire(list, new Event('addsourcebuffer')));
  };
  const removeFrom = (list: Any, item: Any): void => {
    const s = slotOf(list, 'list');
    const at = s.items.indexOf(item);
    if (at < 0) return;
    s.items.splice(at, 1);
    listed(list);
    task(() => fire(list, new Event('removesourcebuffer')));
  };

  /** A `TimeRanges` of `[start, end]` pairs. */
  const timeRanges = (ranges: Any): Any => {
    const bound = (i: Any, at: number): number => {
      const n = +i >>> 0;
      if (n >= ranges.length) {
        throw new DOMException(
          `The index provided (${n}) is greater than the maximum bound (${ranges.length}).`,
          'IndexSizeError',
        );
      }
      return ranges[n][at];
    };
    return {
      length: ranges.length,
      start: (i: Any) => bound(i, 0),
      end: (i: Any) => bound(i, 1),
    };
  };

  const sbFailed = (method: string, message: string): string =>
    `Failed to execute '${method}' on 'SourceBuffer': ${message}`;
  const sbInvalid = (method: string, message: string): Any =>
    new DOMException(sbFailed(method, message), 'InvalidStateError');

  class SourceBuffer extends EventTarget {
    constructor(token: Any = undefined, source: Any = null, id = 0) {
      super();
      if (token !== TOKEN) throw illegalConstructor('SourceBuffer');
      apply(wmSet, slots, [
        this,
        {
          sourceBuffer: true,
          source,
          id,
          updating: false,
          removed: false,
          mode: 'segments',
          offset: 0,
          windowStart: 0,
          windowEnd: Infinity,
          ranges: [],
        },
      ]);
    }
    get updating(): boolean {
      return slotOf(this, 'sourceBuffer').updating;
    }
    get buffered(): Any {
      return timeRanges(slotOf(this, 'sourceBuffer').ranges);
    }
    get mode(): string {
      return slotOf(this, 'sourceBuffer').mode;
    }
    set mode(v: Any) {
      const s = slotOf(this, 'sourceBuffer');
      const mode = `${v}`;
      if (mode === 'segments' || mode === 'sequence') s.mode = mode;
    }
    get timestampOffset(): number {
      return slotOf(this, 'sourceBuffer').offset;
    }
    set timestampOffset(v: Any) {
      slotOf(this, 'sourceBuffer').offset = +v;
    }
    get appendWindowStart(): number {
      return slotOf(this, 'sourceBuffer').windowStart;
    }
    set appendWindowStart(v: Any) {
      slotOf(this, 'sourceBuffer').windowStart = +v;
    }
    get appendWindowEnd(): number {
      return slotOf(this, 'sourceBuffer').windowEnd;
    }
    set appendWindowEnd(v: Any) {
      slotOf(this, 'sourceBuffer').windowEnd = +v;
    }
    /** MSE 3.5, `appendBuffer`: the bytes on the host's side at once, and
     *  what they came to told a task later, as a parser's would be. */
    appendBuffer(data: Any): void {
      const s = slotOf(this, 'sourceBuffer');
      let bytes: Any = null;
      if (isView(data)) {
        bytes = new Uint8(data.buffer, data.byteOffset, data.byteLength);
      } else if (apply(classOf, data, []) === '[object ArrayBuffer]') {
        bytes = new Uint8(data);
      }
      if (!bytes) {
        throw typeError(
          sbFailed(
            'appendBuffer',
            "The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.",
          ),
        );
      }
      if (s.removed) {
        throw sbInvalid(
          'appendBuffer',
          'This SourceBuffer has been removed from the parent media source.',
        );
      }
      if (s.updating) {
        throw sbInvalid(
          'appendBuffer',
          "This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.",
        );
      }
      const media = slotOf(s.source, 'source');
      if (media.state === 'ended') {
        media.state = 'open';
        task(() => fire(s.source, new Event('sourceopen')));
      }
      s.updating = true;
      const told = parse(host('mseAppend', s.id, base64(bytes)));
      // one task for all of it: a page that reads and appends as a stream
      // arrives has a few hundred of these, each a turn of a busy thread
      task(() => {
        if (s.removed) return;
        fire(this, new Event('updatestart'));
        s.updating = false;
        s.ranges = told.ranges;
        if (told.failed) {
          fire(this, new Event('error'));
          fire(this, new Event('updateend'));
          if (media.state === 'open') s.source.endOfStream('decode');
          return;
        }
        if (told.width !== undefined) {
          media.duration = told.duration;
          media.element?.metadata(told.duration, told.width, told.height);
        }
        media.element?.buffered();
        fire(this, new Event('update'));
        fire(this, new Event('updateend'));
      });
    }
    /** MSE 3.5, `abort`: nothing is ever under way past a task, so all there
     *  is to stop is the append that task has not reported. */
    abort(): void {
      const s = slotOf(this, 'sourceBuffer');
      if (s.removed || slotOf(s.source, 'source').state !== 'open') {
        throw sbInvalid(
          'abort',
          'This SourceBuffer has been removed from the parent media source.',
        );
      }
    }
    /** MSE 3.5: nothing else is a type a clip's player takes. */
    changeType(type: Any): void {
      slotOf(this, 'sourceBuffer');
      throw new DOMException(
        sbFailed('changeType', `The type provided ('${type}') is unsupported.`),
        'NotSupportedError',
      );
    }
    /** MSE 3.5, `remove`. */
    remove(start: Any, end: Any): void {
      const s = slotOf(this, 'sourceBuffer');
      const from = +start;
      const to = +end;
      if (s.removed) {
        throw sbInvalid(
          'remove',
          'This SourceBuffer has been removed from the parent media source.',
        );
      }
      if (s.updating) {
        throw sbInvalid(
          'remove',
          "This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.",
        );
      }
      const media = slotOf(s.source, 'source');
      if (!(from >= 0) || from > media.duration) {
        throw typeError(
          sbFailed(
            'remove',
            `The start provided (${from}) is outside the range (0, ${media.duration}).`,
          ),
        );
      }
      if (!(to > from)) {
        throw typeError(
          sbFailed(
            'remove',
            `The end value provided (${to}) must be greater than the start value provided (${from}).`,
          ),
        );
      }
      s.updating = true;
      const told = parse(host('mseRemove', s.id, from, to));
      task(() => {
        if (s.removed) return;
        fire(this, new Event('updatestart'));
        s.updating = false;
        s.ranges = told.ranges;
        fire(this, new Event('update'));
        fire(this, new Event('updateend'));
      });
    }
  }
  for (const name of ['updatestart', 'update', 'updateend', 'error', 'abort']) {
    handler(SourceBuffer.prototype, name);
  }

  class MediaSource extends EventTarget {
    constructor() {
      super();
      apply(wmSet, slots, [
        this,
        {
          source: true,
          state: 'closed',
          duration: NaN,
          element: null,
          buffers: new SourceBufferList(TOKEN),
          active: new SourceBufferList(TOKEN),
        },
      ]);
    }
    get sourceBuffers(): Any {
      return slotOf(this, 'source').buffers;
    }
    get activeSourceBuffers(): Any {
      return slotOf(this, 'source').active;
    }
    get readyState(): string {
      return slotOf(this, 'source').state;
    }
    get duration(): number {
      const s = slotOf(this, 'source');
      return s.state === 'closed' ? NaN : s.duration;
    }
    set duration(v: Any) {
      const s = slotOf(this, 'source');
      const duration = +v;
      const context = "Failed to set the 'duration' property on 'MediaSource'";
      if (duration !== duration) {
        throw typeError(`${context}: The duration is not a number.`);
      }
      if (duration < 0) {
        throw typeError(
          `${context}: The duration provided (${duration}) is less than the minimum bound (0).`,
        );
      }
      if (s.state !== 'open') throw notOpen(context);
      if (duration === s.duration) return;
      s.duration = duration;
      s.element.durationChanged(duration);
    }
    /** MSE 3.3: a type the host keeps a clip of (`clips.ts`), and no other. */
    addSourceBuffer(type: Any): Any {
      const s = slotOf(this, 'source');
      if (arguments.length < 1) {
        throw typeError(
          failed('addSourceBuffer', '1 argument required, but only 0 present.'),
        );
      }
      const named = `${type}`;
      if (!named) {
        throw typeError(
          failed('addSourceBuffer', 'The type provided is empty'),
        );
      }
      const id =
        s.state === 'closed' ? 0 : Number(host('mseOpen', named, s.element.id));
      if (!id) {
        throw new DOMException(
          failed(
            'addSourceBuffer',
            `The type provided ('${named}') is unsupported.`,
          ),
          'NotSupportedError',
        );
      }
      if (s.state !== 'open') {
        host('mseClose', id);
        throw notOpen("Failed to execute 'addSourceBuffer' on 'MediaSource'");
      }
      const buffer = new SourceBuffer(TOKEN, this, id);
      addTo(s.buffers, buffer);
      addTo(s.active, buffer);
      return buffer;
    }
    /** MSE 3.3. */
    removeSourceBuffer(sourceBuffer: Any): void {
      const s = slotOf(this, 'source');
      const held =
        sourceBuffer && typeof sourceBuffer === 'object'
          ? apply(wmGet, slots, [sourceBuffer])
          : null;
      if (!held?.sourceBuffer) {
        throw typeError(
          failed(
            'removeSourceBuffer',
            arguments.length < 1
              ? '1 argument required, but only 0 present.'
              : "parameter 1 is not of type 'SourceBuffer'.",
          ),
        );
      }
      if (held.source !== this) {
        throw new DOMException(
          failed(
            'removeSourceBuffer',
            'The SourceBuffer provided is not contained in this MediaSource.',
          ),
          'NotFoundError',
        );
      }
      held.removed = true;
      held.updating = false;
      removeFrom(s.active, sourceBuffer);
      removeFrom(s.buffers, sourceBuffer);
      host('mseClose', held.id);
    }
    /** MSE 3.3, the end of stream algorithm: `ended`, and with something
     *  buffered the stream's length is as far as that goes, and the host
     *  hands the player what it kept. A stream with no tracks, or told of a
     *  failure, fails the element, a task after `sourceended`, as Chrome's
     *  does. */
    endOfStream(error: Any = undefined): void {
      const s = slotOf(this, 'source');
      if (error !== undefined && error !== 'network' && error !== 'decode') {
        throw typeError(
          failed(
            'endOfStream',
            `The provided value '${error}' is not a valid enum value of type EndOfStreamError.`,
          ),
        );
      }
      if (s.state !== 'open') {
        throw notOpen("Failed to execute 'endOfStream' on 'MediaSource'");
      }
      const buffers = slotOf(s.buffers, 'list').items;
      if (
        buffers.some((b: Any) => apply(wmGet, slots, [b]).updating === true)
      ) {
        throw new DOMException(
          failed(
            'endOfStream',
            "The 'updating' attribute is true on one or more of this MediaSource's SourceBuffers.",
          ),
          'InvalidStateError',
        );
      }
      s.state = 'ended';
      const { element } = s;
      const whole = error === undefined && buffers.length > 0;
      task(() => fire(this, new Event('sourceended')));
      if (!whole) {
        task(() => element.failed());
        return;
      }
      let end = 0;
      for (const b of buffers) {
        const buffer = apply(wmGet, slots, [b]);
        for (const range of buffer.ranges) end = Math.max(end, range[1]);
        host('mseEnd', buffer.id);
      }
      if (end > 0 && end !== s.duration) {
        s.duration = end;
        element.durationChanged(end);
      }
      task(() => element.ended());
    }
    /** MSE 3.3. Held to its bounds and kept nowhere: `seekable` reads no
     *  source, and with nothing buffered there is nothing to seek in. */
    setLiveSeekableRange(start: Any, end: Any): void {
      const s = slotOf(this, 'source');
      if (arguments.length < 2) {
        throw typeError(
          failed(
            'setLiveSeekableRange',
            `2 arguments required, but only ${arguments.length} present.`,
          ),
        );
      }
      const from = +start;
      const to = +end;
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw typeError(
          failed(
            'setLiveSeekableRange',
            'The provided double value is non-finite.',
          ),
        );
      }
      if (s.state !== 'open') {
        throw notOpen(
          "Failed to execute 'setLiveSeekableRange' on 'MediaSource'",
        );
      }
      if (from < 0 || from > to) {
        throw typeError(
          failed(
            'setLiveSeekableRange',
            `The start value provided (${from}) is outside the range [0, ${to}].`,
          ),
        );
      }
    }
    clearLiveSeekableRange(): void {
      const s = slotOf(this, 'source');
      if (s.state !== 'open') {
        throw notOpen(
          "Failed to execute 'clearLiveSeekableRange' on 'MediaSource'",
        );
      }
    }
    static get canConstructInDedicatedWorker(): boolean {
      return false;
    }
    static isTypeSupported(type: Any): boolean {
      if (arguments.length < 1) {
        throw typeError(
          failed('isTypeSupported', '1 argument required, but only 0 present.'),
        );
      }
      void `${type}`;
      return false;
    }
  }
  for (const name of ['sourceopen', 'sourceended', 'sourceclose']) {
    handler(MediaSource.prototype, name);
  }

  const interfaces = { MediaSource, SourceBuffer, SourceBufferList };
  idl(interfaces);

  return {
    interfaces,
    isSource(value: Any): boolean {
      const s =
        value && typeof value === 'object'
          ? apply(wmGet, slots, [value])
          : null;
      return !!s?.source;
    },
    attach(source: Any, element: MseElement): boolean {
      const s = slotOf(source, 'source');
      if (s.state !== 'closed') return false;
      s.state = 'open';
      s.element = element;
      task(() => fire(source, new Event('sourceopen')));
      return true;
    },
    detach(source: Any): void {
      const s = slotOf(source, 'source');
      s.state = 'closed';
      s.duration = NaN;
      s.element = null;
      for (const b of [...slotOf(s.buffers, 'list').items]) {
        const buffer = apply(wmGet, slots, [b]);
        buffer.removed = true;
        buffer.updating = false;
        host('mseClose', buffer.id);
      }
      slotOf(s.active, 'list').items.length = 0;
      slotOf(s.buffers, 'list').items.length = 0;
      listed(s.active);
      listed(s.buffers);
      task(() => fire(s.active, new Event('removesourcebuffer')));
      task(() => fire(s.buffers, new Event('removesourcebuffer')));
      task(() => fire(source, new Event('sourceclose')));
    },
    buffered(source: Any): Any {
      const [first] = slotOf(slotOf(source, 'source').active, 'list').items;
      return timeRanges(first ? apply(wmGet, slots, [first]).ranges : []);
    },
    ahead(source: Any, time: number): number {
      const [first] = slotOf(slotOf(source, 'source').active, 'list').items;
      if (!first) return -1;
      for (const [start, end] of apply(wmGet, slots, [first]).ranges) {
        if (time >= start && time < end) return end - time;
      }
      return -1;
    },
  };
}
