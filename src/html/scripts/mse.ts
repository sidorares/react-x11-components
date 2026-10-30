// Media Source Extensions, as a page's scripts see it: a `MediaSource`, which
// a media element opens through an object URL, and the `SourceBuffer`
// interface a player reads off the global before it makes one.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` calls it with what it reaches
// the element by.
//
// **No type is supported, and that is what keeps a stream playing.** What
// plays a page's media is a player the host mounts over the box, which
// opens a URL (`videos.ts`, `sounds.ts`), and nothing hands it bytes a page
// appended. So `isTypeSupported` says no to every type, and hls.js, which
// asks it before it chooses, goes on to `canPlayType` and sets the playlist
// as the element's `src`, where the player has it. A yes to what
// `canPlayType` says yes to would take those streams from a player that
// plays them to a buffer nothing reads.
//
// **A page that does not ask still has to find the API.** Apple's product
// pages make a `MediaSource` in every browser that is not Safari, so here
// `new MediaSource` works, a media element opens it, and `addSourceBuffer`
// throws the `NotSupportedError` a browser throws for a type it cannot
// decode, the failure such a page has a path for. With no `SourceBuffer`
// there is nothing to play, so however a stream ends, its element fails, as
// Chrome's does given no tracks. `SourceBuffer` is the interface alone,
// since hls.js looks for `appendBuffer` and `remove` on its prototype, and
// no instance of it is ever made.
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
}

/** The media element a source is attached to, as the source tells it. */
export interface MseElement {
  durationChanged(duration: number): void;
  /** The stream ended with nothing to play. */
  failed(): void;
}

export interface MseInstalled {
  interfaces: Record<string, unknown>;
  isSource(value: unknown): boolean;
  /** MSE 3.15.1, attaching to a media element: false where the source is
   *  not closed, which is a failure of the element's. */
  attach(source: unknown, element: MseElement): boolean;
  /** MSE 3.15.2, detaching from a media element. */
  detach(source: unknown): void;
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
      apply(wmSet, slots, [this, { list: true }]);
    }
    get length(): number {
      slotOf(this, 'list');
      return 0;
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

  class SourceBuffer extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor('SourceBuffer');
    }
  }
  /** A member of an interface nothing is an instance of. */
  const noInstance = (name: string, length: number): Any => {
    const { member } = {
      member() {
        throw illegal();
      },
    };
    Object.defineProperty(member, 'name', { value: name, configurable: true });
    Object.defineProperty(member, 'length', {
      value: length,
      configurable: true,
    });
    return member;
  };
  for (const name of ['updating', 'buffered']) {
    Object.defineProperty(SourceBuffer.prototype, name, {
      get: noInstance(`get ${name}`, 0),
      enumerable: true,
      configurable: true,
    });
  }
  for (const name of [
    'mode',
    'timestampOffset',
    'appendWindowStart',
    'appendWindowEnd',
    'onupdatestart',
    'onupdate',
    'onupdateend',
    'onerror',
    'onabort',
  ]) {
    Object.defineProperty(SourceBuffer.prototype, name, {
      get: noInstance(`get ${name}`, 0),
      set: noInstance(`set ${name}`, 1),
      enumerable: true,
      configurable: true,
    });
  }
  for (const [name, length] of [
    ['appendBuffer', 1],
    ['abort', 0],
    ['changeType', 1],
    ['remove', 2],
  ] as [string, number][]) {
    Object.defineProperty(SourceBuffer.prototype, name, {
      value: noInstance(name, length),
      writable: true,
      enumerable: true,
      configurable: true,
    });
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
    /** MSE 3.3: nothing passes step 2, that the type is supported, so the
     *  state it goes on to ask about never comes up. */
    addSourceBuffer(type: Any): Any {
      slotOf(this, 'source');
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
      throw new DOMException(
        failed(
          'addSourceBuffer',
          `The type provided ('${named}') is unsupported.`,
        ),
        'NotSupportedError',
      );
    }
    /** MSE 3.3: anything it is handed is no `SourceBuffer`. */
    removeSourceBuffer(sourceBuffer: Any): void {
      slotOf(this, 'source');
      throw typeError(
        failed(
          'removeSourceBuffer',
          arguments.length < 1
            ? '1 argument required, but only 0 present.'
            : "parameter 1 is not of type 'SourceBuffer'.",
        ),
      );
    }
    /** MSE 3.3, the end of stream algorithm: `ended`, and with no tracks
     *  the element fails whatever the error was, a task after
     *  `sourceended`, as Chrome's does. */
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
      s.state = 'ended';
      const { element } = s;
      task(() => fire(this, new Event('sourceended')));
      task(() => element.failed());
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
      task(() => fire(s.active, new Event('removesourcebuffer')));
      task(() => fire(s.buffers, new Event('removesourcebuffer')));
      task(() => fire(source, new Event('sourceclose')));
    },
  };
}
