// The DOM a page's scripts see: `document`, its elements, events, timers,
// `location`, storage and `fetch` — built inside the page's context, of the
// context's own classes, over a bridge that carries primitives.
//
// **This function is source text.** `engine.ts` hands it to the context
// through `Function.prototype.toString()` and runs it there, so it closes
// over nothing: no import is reachable from inside it, only the `bridge` it
// is called with and the context's own built-ins. That is what keeps every
// object a page touches the context's — a host object handed in has the
// host's `Function` as its `constructor.constructor`, and that reaches the
// host's `process` (docs/prd-html-scripts.md, "the five leaks"). Types are
// imported for the type checker and are gone at run time. A `__name` helper
// is the one name the transpiler may call that is not here, and the engine
// gives the context one.
//
// The tree is the host's: `<Html>`'s domhandler document. A node here is a
// wrapper around an id, one wrapper an id, so `getElementById('a') ===
// getElementById('a')`; what a node is, holds and says is asked of the host
// by op name (`host.ts`), and an error comes back as a string the wrapper
// throws as its own `DOMException`.
//
// The host calls in through the entries at the bottom, `__exec`, `__event`,
// `__timer` and the rest, each run as a `vm.Script` with a timeout, and each
// handed what it needs as a JSON string in `__in` — a data property this
// defines, so that no page can put a setter where the host writes. None of
// them lets a page's exception out: a script's, a listener's and a timer's
// are reported, as a browser reports them, and the page goes on.
//
// Classic scripts over a basic DOM, phase 1 of the PRD, and phase 2's
// `MutationObserver` and `XMLHttpRequest`. Shadow DOM, custom elements,
// workers, canvas and `document.write` are not here.

import type { installRaster, PathData } from './raster.js';
import type { installWebGL } from './webgl.js';

// The page context's own built-ins this reaches by name, for the type
// checker alone: they are the context's at run time (see above), and
// `src/` compiles with no runtime's globals declared (`./platform.ts`).
declare const queueMicrotask: (fn: () => void) => void;
declare const setTimeout: (fn: () => void, ms?: number) => unknown;

/** What crosses the bridge: nothing that has a `constructor`. */
export type Primitive = string | number | boolean | null | undefined;

/** The host's side: an op and up to four primitives in, one out. */
export type Bridge = (
  op: string,
  a?: Primitive,
  b?: Primitive,
  c?: Primitive,
  d?: Primitive,
) => Primitive;

// Everything below runs in the page's context and is typed loosely: what it
// is handed and what it hands a page are the page's to shape.
export function installDom(
  bridge: Bridge,
  webgl: typeof installWebGL,
  raster: typeof installRaster,
  namedAccess: boolean,
): void {
  // strict, so that no page reads `caller` or `arguments` off a function of
  // this one's on its way up the stack
  'use strict';
  type Any = any;
  const G: Any = globalThis;

  // The context's own `FinalizationRegistry`, kept for this facade's own
  // registries (whose cleanup only calls the bridge) and wrapped for the
  // page's (`FinalizationRegistry` is replaced below): a page's cleanup is
  // run by V8 as a platform task, outside any entry and so outside the
  // timeout, where a loop would wedge the pane with nothing to stop it.
  const RealFinalizationRegistry: Any =
    typeof FinalizationRegistry === 'function' ? FinalizationRegistry : null;

  // --- the bridge -------------------------------------------------------------

  /** An op's answer, or the host's error thrown as a `DOMException`. */
  const call = (
    op: string,
    a?: Primitive,
    b?: Primitive,
    c?: Primitive,
    d?: Primitive,
  ): Any => {
    const r = bridge(op, a, b, c, d);
    if (typeof r === 'string' && r.charCodeAt(0) === 1) {
      const parts = r.split('\u0001');
      throw new DOMException(parts[2] ?? '', parts[1] || 'Error');
    }
    if (MUTATES.has(op)) {
      mutated();
      if (customElementsDefined) takeReactions();
    } else if (customElementsDefined && (op === 'clone' || op === 'import')) {
      takeReactions();
    }
    return r;
  };
  /** Whether the page has defined a custom element, after which an op that
   *  changes the tree may have custom element reactions to run
   *  (`takeReactions`). */
  let customElementsDefined = false;
  /** The ops that change the tree, which the host records
   *  (`host.ts`, "what changed"). */
  const MUTATES = new Set([
    'setText',
    'insert',
    'replace',
    'remove',
    'replaceData',
    'splitText',
    'adoptNode',
    'rangeDelete',
    'rangeContents',
    'rangeInsert',
    'rangeSurround',
    'setAttr',
    'delAttr',
    'setStyle',
    'setHtml',
    'adjacent',
    'setTitle',
  ]);
  const idList = (s: Any): number[] =>
    typeof s === 'string' && s ? s.split(',').map(Number) : [];

  // --- errors ------------------------------------------------------------------

  /** The legacy codes (WebIDL 2.8.1), each the name it is the code of,
   *  and the constant a page compares one with. */
  const CODES: Record<string, number> = {
    IndexSizeError: 1,
    HierarchyRequestError: 3,
    WrongDocumentError: 4,
    InvalidCharacterError: 5,
    NoModificationAllowedError: 7,
    NotFoundError: 8,
    NotSupportedError: 9,
    InUseAttributeError: 10,
    InvalidStateError: 11,
    SyntaxError: 12,
    InvalidModificationError: 13,
    NamespaceError: 14,
    InvalidAccessError: 15,
    TypeMismatchError: 17,
    SecurityError: 18,
    NetworkError: 19,
    AbortError: 20,
    URLMismatchError: 21,
    QuotaExceededError: 22,
    TimeoutError: 23,
    InvalidNodeTypeError: 24,
    DataCloneError: 25,
  };
  class DOMException extends Error {
    readonly code: number;
    constructor(message = '', name = 'Error') {
      super(message);
      Object.defineProperty(this, 'name', { value: name, configurable: true });
      this.code = CODES[name] ?? 0;
    }
  }
  [
    'INDEX_SIZE_ERR',
    'DOMSTRING_SIZE_ERR',
    'HIERARCHY_REQUEST_ERR',
    'WRONG_DOCUMENT_ERR',
    'INVALID_CHARACTER_ERR',
    'NO_DATA_ALLOWED_ERR',
    'NO_MODIFICATION_ALLOWED_ERR',
    'NOT_FOUND_ERR',
    'NOT_SUPPORTED_ERR',
    'INUSE_ATTRIBUTE_ERR',
    'INVALID_STATE_ERR',
    'SYNTAX_ERR',
    'INVALID_MODIFICATION_ERR',
    'NAMESPACE_ERR',
    'INVALID_ACCESS_ERR',
    'VALIDATION_ERR',
    'TYPE_MISMATCH_ERR',
    'SECURITY_ERR',
    'NETWORK_ERR',
    'ABORT_ERR',
    'URL_MISMATCH_ERR',
    'QUOTA_EXCEEDED_ERR',
    'TIMEOUT_ERR',
    'INVALID_NODE_TYPE_ERR',
    'DATA_CLONE_ERR',
  ].forEach((name, i) => {
    for (const on of [DOMException, DOMException.prototype]) {
      Object.defineProperty(on, name, { value: i + 1, enumerable: true });
    }
  });

  /** A page's exception, reported as a browser reports one it caught: on
   *  the console, and as an `error` event at the window. */
  let reporting = false;
  /** What a thrown value says of itself: its message, and its stack where
   *  it has one. */
  const describe = (error: Any): { message: string; text: string } => {
    let message: string;
    try {
      message =
        error && typeof error === 'object' && 'message' in error
          ? `${error.name ?? 'Error'}: ${error.message}`
          : String(error);
    } catch {
      message = 'an exception that could not be read';
    }
    let stack = '';
    try {
      stack = typeof error?.stack === 'string' ? error.stack : '';
    } catch {}
    return { message, text: stack || message };
  };
  const report = (error: Any): void => {
    const { message, text } = describe(error);
    bridge('log', 'error', `Uncaught ${text}`);
    if (reporting) return;
    reporting = true;
    try {
      // where it was thrown, as its stack's first frame says
      const stack = typeof error?.stack === 'string' ? error.stack : '';
      const at = /\n\s+at (?:[^\n]*?\()?([^\s()]+?):(\d+):(\d+)\)?/.exec(stack);
      const ev = new ErrorEvent('error', {
        message: `Uncaught ${message}`,
        error,
        cancelable: true,
        filename: at ? at[1] : '',
        lineno: at ? Number(at[2]) : 0,
        colno: at ? Number(at[3]) : 0,
      });
      dispatch(windowTarget, ev);
    } catch {
    } finally {
      reporting = false;
    }
  };

  // --- events ------------------------------------------------------------------

  interface Listener {
    fn: Any;
    capture: boolean;
    once: boolean;
    passive: boolean;
    signal?: Any;
  }

  const NONE = 0;
  const CAPTURING_PHASE = 1;
  const AT_TARGET = 2;
  const BUBBLING_PHASE = 3;

  /** An event's attributes are accessors on `Event.prototype`, as WebIDL
   *  makes every attribute, over state of the event's own that only the
   *  dispatch writes. GitHub's delegated-events, which its sites' click
   *  analytics run under, takes `currentTarget`'s descriptor off the
   *  prototype to shadow it on the event while a delegated handler runs,
   *  and puts the prototype's getter back on the event after. With the
   *  attribute a field there was no descriptor to take, the handler read
   *  the document it listens on, and every click on github.blog threw on
   *  `document.tagName`. The accessor it leaves on the event has no
   *  setter, which is why the dispatch writes the state and never the
   *  attribute. */
  class Event {
    static readonly NONE = NONE;
    static readonly CAPTURING_PHASE = CAPTURING_PHASE;
    static readonly AT_TARGET = AT_TARGET;
    static readonly BUBBLING_PHASE = BUBBLING_PHASE;
    /** The event's own, not the prototype's: `[LegacyUnforgeable]`. */
    isTrusted = false;
    _type: string;
    _bubbles: boolean;
    _cancelable: boolean;
    _composed: boolean;
    _timeStamp: number;
    _target: Any = null;
    _currentTarget: Any = null;
    _phase = NONE;
    /** DOM's canceled flag, which `defaultPrevented` reads. */
    _canceled = false;
    _stop = false;
    _stopNow = false;
    _passive = false;
    _path: Any[] = [];
    constructor(type: string, init: Any = {}) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to construct 'Event': 1 argument required");
      }
      this._type = String(type);
      this._bubbles = !!init.bubbles;
      this._cancelable = !!init.cancelable;
      this._composed = !!init.composed;
      this._timeStamp = now();
    }
    get type(): string {
      return this._type;
    }
    get target(): Any {
      return this._target;
    }
    get currentTarget(): Any {
      return this._currentTarget;
    }
    get eventPhase(): number {
      return this._phase;
    }
    get bubbles(): boolean {
      return this._bubbles;
    }
    get cancelable(): boolean {
      return this._cancelable;
    }
    get composed(): boolean {
      return this._composed;
    }
    get defaultPrevented(): boolean {
      return this._canceled;
    }
    get timeStamp(): number {
      return this._timeStamp;
    }
    get srcElement(): Any {
      return this._target;
    }
    get returnValue(): boolean {
      return !this._canceled;
    }
    set returnValue(v: boolean) {
      if (!v) this.preventDefault();
    }
    get cancelBubble(): boolean {
      return this._stop;
    }
    set cancelBubble(v: boolean) {
      if (v) this._stop = true;
    }
    preventDefault(): void {
      if (this._cancelable && !this._passive) this._canceled = true;
    }
    stopPropagation(): void {
      this._stop = true;
    }
    stopImmediatePropagation(): void {
      this._stop = true;
      this._stopNow = true;
    }
    composedPath(): Any[] {
      return this._phase === NONE ? [] : this._path.slice();
    }
    initEvent(type: string, bubbles = false, cancelable = false): void {
      this._type = String(type);
      this._bubbles = !!bubbles;
      this._cancelable = !!cancelable;
    }
  }
  class UIEvent extends Event {
    readonly detail: number;
    readonly view: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.detail = Number(init.detail ?? 0);
      this.view = init.view ?? null;
    }
    /** The legacy initializer a `createEvent('UIEvents')` is set with. */
    initUIEvent(
      type: string,
      bubbles = false,
      cancelable = false,
      view: Any = null,
      detail = 0,
    ): void {
      this.initEvent(type, bubbles, cancelable);
      (this as Any).view = view ?? null;
      (this as Any).detail = Number(detail) | 0;
    }
  }
  class FocusEvent extends UIEvent {
    readonly relatedTarget: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.relatedTarget = init.relatedTarget ?? null;
    }
  }
  class MouseEvent extends UIEvent {
    readonly screenX: number;
    readonly screenY: number;
    readonly clientX: number;
    readonly clientY: number;
    readonly button: number;
    readonly buttons: number;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly relatedTarget: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.clientX = Number(init.clientX ?? 0);
      this.clientY = Number(init.clientY ?? 0);
      this.screenX = Number(init.screenX ?? this.clientX);
      this.screenY = Number(init.screenY ?? this.clientY);
      this.button = Number(init.button ?? 0);
      this.buttons = Number(init.buttons ?? 0);
      this.ctrlKey = !!init.ctrlKey;
      this.shiftKey = !!init.shiftKey;
      this.altKey = !!init.altKey;
      this.metaKey = !!init.metaKey;
      this.relatedTarget = init.relatedTarget ?? null;
    }
    get x(): number {
      return this.clientX;
    }
    get y(): number {
      return this.clientY;
    }
    get pageX(): number {
      return this.clientX + viewport().scrollX;
    }
    get pageY(): number {
      return this.clientY + viewport().scrollY;
    }
    get offsetX(): number {
      const r = this.target?.getBoundingClientRect?.();
      return r ? this.clientX - r.left : this.clientX;
    }
    get offsetY(): number {
      const r = this.target?.getBoundingClientRect?.();
      return r ? this.clientY - r.top : this.clientY;
    }
    getModifierState(key: string): boolean {
      return (
        (key === 'Shift' && this.shiftKey) ||
        (key === 'Control' && this.ctrlKey) ||
        (key === 'Alt' && this.altKey) ||
        (key === 'Meta' && this.metaKey)
      );
    }
  }
  class PointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    readonly width: number;
    readonly height: number;
    readonly pressure: number;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.pointerId = Number(init.pointerId ?? 1);
      this.pointerType = String(init.pointerType ?? 'mouse');
      this.isPrimary = init.isPrimary ?? true;
      this.width = Number(init.width ?? 1);
      this.height = Number(init.height ?? 1);
      // a mouse's is half with a button held and none without (4.1.3)
      this.pressure = Number(init.pressure ?? (this.buttons ? 0.5 : 0));
    }
  }
  class WheelEvent extends MouseEvent {
    static readonly DOM_DELTA_PIXEL = 0;
    static readonly DOM_DELTA_LINE = 1;
    static readonly DOM_DELTA_PAGE = 2;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly deltaZ: number;
    readonly deltaMode: number;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.deltaX = Number(init.deltaX ?? 0);
      this.deltaY = Number(init.deltaY ?? 0);
      this.deltaZ = Number(init.deltaZ ?? 0);
      this.deltaMode = Number(init.deltaMode ?? 0);
    }
  }
  class KeyboardEvent extends UIEvent {
    readonly key: string;
    readonly code: string;
    readonly location: number;
    readonly repeat: boolean;
    readonly isComposing: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.key = String(init.key ?? '');
      this.code = String(init.code ?? '');
      this.location = Number(init.location ?? 0);
      this.repeat = !!init.repeat;
      this.isComposing = !!init.isComposing;
      this.ctrlKey = !!init.ctrlKey;
      this.shiftKey = !!init.shiftKey;
      this.altKey = !!init.altKey;
      this.metaKey = !!init.metaKey;
    }
    get keyCode(): number {
      return keyCodeOf(this.key);
    }
    get which(): number {
      return keyCodeOf(this.key);
    }
    get charCode(): number {
      return this.type === 'keypress' && this.key.length === 1
        ? this.key.charCodeAt(0)
        : 0;
    }
    getModifierState(key: string): boolean {
      return MouseEvent.prototype.getModifierState.call(this, key);
    }
  }
  class InputEvent extends UIEvent {
    readonly data: string | null;
    readonly inputType: string;
    readonly isComposing: boolean;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.data = init.data ?? null;
      this.inputType = String(init.inputType ?? '');
      this.isComposing = !!init.isComposing;
    }
  }
  class SubmitEvent extends Event {
    readonly submitter: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.submitter = init.submitter ?? null;
    }
  }
  class CustomEvent extends Event {
    readonly detail: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.detail = init.detail ?? null;
    }
    initCustomEvent(type: string, b: boolean, c: boolean, detail: Any): void {
      this.initEvent(type, b, c);
      (this as Any).detail = detail;
    }
  }
  class ErrorEvent extends Event {
    readonly message: string;
    readonly error: Any;
    readonly filename: string;
    readonly lineno: number;
    readonly colno: number;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.message = String(init.message ?? '');
      this.error = init.error ?? null;
      this.filename = String(init.filename ?? '');
      this.lineno = Number(init.lineno ?? 0);
      this.colno = Number(init.colno ?? 0);
    }
  }
  /** `unhandledrejection` (HTML 8.1.6.3): the promise and its reason. */
  class PromiseRejectionEvent extends Event {
    readonly promise: Any;
    readonly reason: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.promise = init.promise;
      this.reason = init.reason;
    }
  }

  class HashChangeEvent extends Event {
    readonly oldURL: string;
    readonly newURL: string;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.oldURL = String(init.oldURL ?? '');
      this.newURL = String(init.newURL ?? '');
    }
  }
  class MessageEvent extends Event {
    readonly data: Any;
    readonly origin: string;
    readonly lastEventId: string;
    readonly source: Any;
    readonly ports: Any[];
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.data = init.data === undefined ? null : init.data;
      this.origin = String(init.origin ?? '');
      this.lastEventId = String(init.lastEventId ?? '');
      this.source = init.source ?? null;
      this.ports = Array.from(init.ports ?? []);
    }
  }
  class PopStateEvent extends Event {
    readonly state: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.state = init.state ?? null;
    }
  }
  /** A dialog's or a popover's `beforetoggle` and `toggle` (HTML 6.12.1):
   *  the state it was in and the one it is going to. */
  class ToggleEvent extends Event {
    readonly oldState: string;
    readonly newState: string;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.oldState = String(init.oldState ?? '');
      this.newState = String(init.newState ?? '');
    }
  }

  /** The legacy `keyCode` a page still branches on, from the key. */
  const KEY_CODES: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    CapsLock: 20,
    Escape: 27,
    ' ': 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Insert: 45,
    Delete: 46,
    Meta: 91,
  };
  const keyCodeOf = (key: string): number => {
    if (key in KEY_CODES) return KEY_CODES[key];
    if (key.length === 1) {
      const c = key.toUpperCase().charCodeAt(0);
      return c;
    }
    const f = /^F(\d+)$/.exec(key);
    return f ? 111 + Number(f[1]) : 0;
  };

  /** Where `on<type>` handlers are compiled from attributes, by text. */
  const compiled = new Map<string, Any>();

  class EventTarget {
    _listeners: Record<string, Listener[]> = Object.create(null);
    _handlers: Record<string, Any> = Object.create(null);
    addEventListener(type: string, fn: Any, options: Any = {}): void {
      if (!fn) return;
      const opts =
        typeof options === 'boolean' ? { capture: options } : options || {};
      const list = (this._listeners[type] ??= []);
      const capture = !!opts.capture;
      if (list.some((l) => l.fn === fn && l.capture === capture)) return;
      const signal = opts.signal;
      if (signal?.aborted) return;
      const listener: Listener = {
        fn,
        capture,
        once: !!opts.once,
        passive: !!opts.passive,
        signal,
      };
      list.push(listener);
      signal?.addEventListener?.('abort', () =>
        this.removeEventListener(type, fn, { capture }),
      );
    }
    removeEventListener(type: string, fn: Any, options: Any = {}): void {
      const capture =
        typeof options === 'boolean' ? options : !!options?.capture;
      const list = this._listeners[type];
      if (!list) return;
      const at = list.findIndex((l) => l.fn === fn && l.capture === capture);
      if (at >= 0) list.splice(at, 1);
    }
    dispatchEvent(event: Any): boolean {
      if (!(event instanceof Event)) {
        throw new TypeError(
          "Failed to execute 'dispatchEvent': parameter 1 is not of type 'Event'.",
        );
      }
      event.isTrusted = false;
      // a click a page dispatches still runs what a click does
      if (event.type === 'click' && event instanceof MouseEvent) {
        return activated(this, event);
      }
      return dispatch(this, event);
    }
  }

  /** The events whose `on…` attribute on `<body>` is the window's handler
   *  (HTML 8.1.8.2, the window-reflecting body element event handlers):
   *  Acid3 starts with `<body onload="update()">`. */
  const WINDOW_REFLECTING = new Set([
    'afterprint',
    'beforeprint',
    'beforeunload',
    'blur',
    'error',
    'focus',
    'hashchange',
    'languagechange',
    'load',
    'message',
    'messageerror',
    'offline',
    'online',
    'pagehide',
    'pageshow',
    'popstate',
    'rejectionhandled',
    'resize',
    'scroll',
    'storage',
    'unhandledrejection',
    'unload',
  ]);
  /** The `on<type>` handler of a target, a property's or its attribute's. */
  const handlerOf = (target: Any, type: string): Any => {
    const own = target._handlers[type];
    if (own !== undefined) return own;
    if (target === windowTarget && WINDOW_REFLECTING.has(type)) {
      const body = document.body;
      return body instanceof HTMLBodyElement
        ? attributeHandler(body, type)
        : null;
    }
    if (!(target instanceof Element)) return null;
    return attributeHandler(target, type);
  };
  /** An element's `on<type>` attribute, compiled once for its text. */
  const attributeHandler = (target: Any, type: string): Any => {
    const text = target.getAttribute(`on${type}`);
    if (text === null) return null;
    let fn = compiled.get(text);
    if (!fn) {
      try {
        fn = new Function('event', text);
      } catch (error) {
        report(error);
        fn = () => {};
      }
      compiled.set(text, fn);
    }
    return fn;
  };

  const invoke = (target: Any, event: Any, phase: number): void => {
    // the window's listeners are kept on a target of their own, and hear
    // the window as what they are on, as `this` and `currentTarget`
    const self = target === windowTarget ? G : target;
    event._currentTarget = self;
    event._phase = phase;
    if (phase !== CAPTURING_PHASE) {
      const handler = handlerOf(target, event._type);
      if (typeof handler === 'function') {
        try {
          const result = handler.call(self, event);
          if (result === false) event.preventDefault();
        } catch (error) {
          report(error);
        }
        if (event._stopNow) return;
      }
    }
    const list = target._listeners[event._type];
    if (!list?.length) return;
    for (const l of list.slice()) {
      if (phase === CAPTURING_PHASE && !l.capture) continue;
      if (phase === BUBBLING_PHASE && l.capture) continue;
      if (!list.includes(l)) continue;
      if (l.once) list.splice(list.indexOf(l), 1);
      event._passive = l.passive;
      try {
        if (typeof l.fn === 'function') l.fn.call(self, event);
        else if (typeof l.fn?.handleEvent === 'function') {
          l.fn.handleEvent(event);
        }
      } catch (error) {
        report(error);
      }
      event._passive = false;
      if (event._stopNow) return;
    }
  };

  /** DOM 2.9, "dispatch": capture down the path, the target, and up again
   *  where the event bubbles. A node's path runs through its document to the
   *  window, but for a `load`. Whether it was not cancelled. */
  const dispatch = (target: Any, event: Any): boolean => {
    const path: Any[] = [target];
    if (target instanceof Node) {
      for (let at = parentFor(target, event); at; at = parentFor(at, event)) {
        path.push(at);
      }
      if (path[path.length - 1] === document && event._type !== 'load') {
        path.push(windowTarget);
      }
    }
    event._target = target === windowTarget ? G : target;
    event._path = path.map((t) => (t === windowTarget ? G : t));
    event._stop = false;
    event._stopNow = false;
    for (let i = path.length - 1; i > 0 && !event._stop; i -= 1) {
      invoke(path[i], event, CAPTURING_PHASE);
    }
    if (!event._stop) invoke(path[0], event, AT_TARGET);
    if (event._bubbles) {
      for (let i = 1; i < path.length && !event._stop; i += 1) {
        invoke(path[i], event, BUBBLING_PHASE);
      }
    }
    event._phase = NONE;
    event._currentTarget = null;
    return !event._canceled;
  };

  // --- animations (Web Animations 1) -------------------------------------------

  /** An animation's `finish`, `cancel` and `remove`. */
  class AnimationPlaybackEvent extends Event {
    readonly currentTime: number | null;
    readonly timelineTime: number | null;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.currentTime = init.currentTime ?? null;
      this.timelineTime = init.timelineTime ?? null;
    }
  }

  /** The timing an effect is made with, checked as `EffectTiming` is: a
   *  number alone is its duration. */
  const timingOf = (options: Any): Any => {
    const given =
      typeof options === 'number' || options === undefined || options === null
        ? { duration: options ?? 'auto' }
        : options;
    const timing = {
      delay: Number(given.delay ?? 0),
      endDelay: Number(given.endDelay ?? 0),
      fill: String(given.fill ?? 'auto'),
      iterationStart: Number(given.iterationStart ?? 0),
      iterations: given.iterations === undefined ? 1 : Number(given.iterations),
      duration: given.duration ?? 'auto',
      direction: String(given.direction ?? 'normal'),
      easing: String(given.easing ?? 'linear'),
    };
    const duration = timing.duration;
    if (
      duration !== 'auto' &&
      !(typeof duration === 'number' && duration >= 0)
    ) {
      throw new TypeError(
        `Failed to execute 'animate' on 'Element': duration must be non-negative or auto.`,
      );
    }
    if (!(timing.iterations >= 0) || !(timing.iterationStart >= 0)) {
      throw new TypeError(
        `Failed to execute 'animate' on 'Element': iterations must be non-negative.`,
      );
    }
    return timing;
  };

  /**
   * Keyframes as `getKeyframes` lists them, from either form `animate`
   * takes (Web Animations 1, 6.6.3): a list of frames, whose offsets are in
   * order between 0 and 1 where they are given; or one object of a list
   * for each property, each list spread from 0 to 1 — one value alone at 1
   * — and the frames that makes merged where two meet, `offset`, `easing`
   * and `composite` handed to them in order, the easings again from the
   * first where they run out. A frame with no offset is spread evenly
   * between the two around it that have one, the first at 0 and the last
   * at 1 (6.6.2, "compute missing keyframe offsets").
   */
  const keyframesOf = (given: Any): Any[] => {
    if (given === null || given === undefined) return [];
    if (typeof given !== 'object') {
      throw new TypeError(
        "Failed to execute 'animate' on 'Element': The provided value is not of type '(object or sequence<object>)'.",
      );
    }
    let frames: Any[];
    if (typeof given[Symbol.iterator] === 'function') {
      frames = Array.from(given as Iterable<Any>, (frame) => ({
        ...(frame ?? {}),
        offset:
          frame?.offset === null || frame?.offset === undefined
            ? null
            : Number(frame.offset),
      }));
      let last = -Infinity;
      for (const { offset } of frames) {
        if (offset === null) continue;
        if (!(offset >= 0 && offset <= 1)) {
          throw new TypeError(
            "Failed to execute 'animate' on 'Element': Offsets must be null or in the range [0,1].",
          );
        }
        if (offset < last) {
          throw new TypeError(
            "Failed to execute 'animate' on 'Element': Offsets must be monotonically non-decreasing.",
          );
        }
        last = offset;
      }
    } else {
      const byOffset = new Map<number, Any>();
      for (const [name, values] of Object.entries(given)) {
        if (name === 'offset' || name === 'easing' || name === 'composite') {
          continue;
        }
        const list = Array.isArray(values) ? values : [values];
        list.forEach((v, i) => {
          const at = list.length === 1 ? 1 : i / (list.length - 1);
          let frame = byOffset.get(at);
          if (!frame) byOffset.set(at, (frame = { offset: null }));
          frame[name] = v;
        });
      }
      frames = [...byOffset.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, frame]) => frame);
      const listOf = (v: Any): Any[] =>
        v === undefined ? [] : Array.isArray(v) ? v : [v];
      listOf(given.offset).forEach((o, i) => {
        if (frames[i]) frames[i].offset = o === null ? null : Number(o);
      });
      const easings = listOf(given.easing);
      const composites = listOf(given.composite);
      frames.forEach((frame, i) => {
        if (easings.length) frame.easing = easings[i % easings.length];
        if (i < composites.length) frame.composite = composites[i];
      });
    }
    const offsets: (number | null)[] = frames.map((f) => f.offset);
    const n = frames.length;
    if (n > 1 && offsets[0] === null) offsets[0] = 0;
    if (n > 0 && offsets[n - 1] === null) offsets[n - 1] = 1;
    for (let i = 1; i < n - 1; i += 1) {
      if (offsets[i] !== null) continue;
      let j = i + 1;
      while (offsets[j] === null) j += 1;
      const from = offsets[i - 1]!;
      const to = offsets[j]!;
      for (let k = i; k < j; k += 1) {
        offsets[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
      }
      i = j;
    }
    return frames.map((frame, i) => ({
      ...frame,
      offset: frame.offset,
      easing: String(frame.easing ?? 'linear'),
      composite: String(frame.composite ?? 'auto'),
      computedOffset: offsets[i],
    }));
  };

  /** A keyframe's property by the name a page gives it, as CSS names it
   *  (Web Animations 1, 6.6.1, "IDL attribute name to animation property
   *  name"): `cssFloat` and `cssOffset`, a capital letter a hyphen and the
   *  letter, and a custom property as written. Null for one no CSS
   *  property is named by — `offset`, `easing` and `composite` are the
   *  frame's own, and a hyphenated name is ignored, as a browser does. */
  const keyframeProperty = (name: string): string | null => {
    if (name.startsWith('--')) return name.length > 2 ? name : null;
    if (name === 'cssFloat') return 'float';
    if (name === 'cssOffset') return 'offset';
    if (
      name === 'offset' ||
      name === 'easing' ||
      name === 'composite' ||
      name === 'computedOffset' ||
      name === 'float' ||
      !/^[A-Za-z]+$/.test(name)
    ) {
      return null;
    }
    return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  };

  /** The order animations are made in, which is the order they composite
   *  in (Web Animations 1, 5.4.2), and the id the host knows each by. */
  let animationSeq = 0;

  /** What an animation animates: its target, its keyframes and its timing
   *  (`KeyframeEffect`). `<Html>` draws it, from what the host is told of
   *  it (`Animation._report`). */
  class AnimationEffect {
    _timing: Any = timingOf(undefined);
    _animation: Any = null;
    getTiming(): Any {
      return { ...this._timing };
    }
    updateTiming(timing: Any = {}): void {
      this._timing = timingOf({ ...this._timing, ...timing });
      this._described = null;
      this._animation?._schedule();
    }
    /** The effect as the host is told it (`_hostEffect`), made again where
     *  its frames or its timing change. */
    _described: string | null = null;
    /** How long one run of it lasts, and all of them, and when it ends. */
    getComputedTiming(): Any {
      const t = this._timing;
      const duration = t.duration === 'auto' ? 0 : t.duration;
      const activeDuration = duration * t.iterations || 0;
      const endTime = Math.max(t.delay + activeDuration + t.endDelay, 0);
      const localTime = this._animation?.currentTime ?? null;
      let progress: number | null = null;
      let currentIteration: number | null = null;
      if (localTime !== null) {
        const active = localTime - t.delay;
        if (active >= 0 && active <= activeDuration) {
          const iterations = duration > 0 ? active / duration : t.iterations;
          currentIteration = Math.min(Math.floor(iterations), t.iterations - 1);
          progress = duration > 0 ? iterations - currentIteration : 1;
        }
      }
      return {
        ...this.getTiming(),
        duration,
        activeDuration,
        endTime,
        localTime,
        progress,
        currentIteration,
      };
    }
  }
  class KeyframeEffect extends AnimationEffect {
    _target: Any;
    _pseudo: string | null;
    composite = 'replace';
    iterationComposite = 'replace';
    _frames: Any[];
    constructor(target: Any, keyframes: Any, options?: Any) {
      super();
      if (target instanceof KeyframeEffect) {
        this._target = target.target;
        this._pseudo = target.pseudoElement;
        this._frames = target._frames.map((f: Any) => ({ ...f }));
        this._timing = target.getTiming();
        return;
      }
      this._target = target ?? null;
      this._pseudo =
        options && typeof options === 'object' && options.pseudoElement
          ? String(options.pseudoElement)
          : null;
      this._frames = keyframesOf(keyframes);
      this._timing = timingOf(options);
    }
    get target(): Any {
      return this._target;
    }
    set target(target: Any) {
      this._target = target ?? null;
      this._animation?._report();
    }
    get pseudoElement(): string | null {
      return this._pseudo;
    }
    set pseudoElement(pseudo: Any) {
      this._pseudo = pseudo === null ? null : String(pseudo);
      this._described = null;
      this._animation?._report();
    }
    getKeyframes(): Any[] {
      return this._frames.map((f) => ({ ...f }));
    }
    setKeyframes(keyframes: Any): void {
      this._frames = keyframesOf(keyframes);
      this._described = null;
      this._animation?._report();
    }
    /** The CSS properties its frames set, by their CSS names. */
    _properties(): string[] {
      const out = new Set<string>();
      for (const frame of this._frames) {
        for (const name of Object.keys(frame)) {
          const prop = keyframeProperty(name);
          if (prop) out.add(prop);
        }
      }
      return [...out];
    }
    /**
     * The effect as the host is told it (`readEffect`, `css/scripted.ts`):
     * a JSON string, the one thing of it that crosses — its pseudo-element,
     * its frames, each its computed offset, its easing and its properties'
     * values by their CSS names, and its timing, a duration of `auto` 0 and
     * an infinite count null. Null for a pseudo-element that is neither
     * `::before` nor `::after`, which `<Html>` draws no animation of.
     */
    _hostEffect(): string | null {
      if (this._described !== null) return this._described || null;
      const p = this._pseudo;
      const pseudo =
        p === null
          ? ''
          : p === '::before' || p === ':before'
            ? 'before'
            : p === '::after' || p === ':after'
              ? 'after'
              : null;
      if (pseudo === null) {
        this._described = '';
        return null;
      }
      const frames = this._frames.map((frame) => {
        const props: [string, string][] = [];
        for (const [name, value] of Object.entries(frame)) {
          const prop = keyframeProperty(name);
          if (prop === null || value === null || value === undefined) continue;
          props.push([prop, String(value)]);
        }
        return [frame.computedOffset, String(frame.easing), props];
      });
      const t = this._timing;
      const timing = [
        t.delay,
        t.endDelay,
        t.fill,
        t.iterationStart,
        t.iterations === Infinity ? null : t.iterations,
        t.duration === 'auto' ? 0 : t.duration,
        t.direction,
        t.easing,
      ];
      this._described = JSON.stringify([pseudo, frames, timing]);
      return this._described;
    }
  }

  /** The document's timeline: its time is the page's clock. */
  class AnimationTimeline {
    get currentTime(): number | null {
      return now();
    }
  }
  class DocumentTimeline extends AnimationTimeline {
    _origin: number;
    constructor(options: Any = {}) {
      super();
      this._origin = Number(options?.originTime ?? 0);
    }
    override get currentTime(): number | null {
      return now() - this._origin;
    }
  }
  const documentTimeline = new DocumentTimeline();

  /** The animations a page has made that are running or paused, or that
   *  finished and fill forwards: what `getAnimations` lists. */
  const liveAnimations = new Set<Any>();

  /**
   * An animation a page started (`animate`, `new Animation`): when it
   * started, how fast it runs, its promises and its events. It runs for as
   * long as its timing says and then finishes, as one does in a browser:
   * `finished` resolves and `finish` is told, so a page that hides a panel
   * once it has faded, or waits for the fade to go on, goes on. One that
   * never finished kept every panel a menu had faded out on screen.
   *
   * What it animates is `<Html>`'s to draw, and the host is told, as
   * primitives, whenever its effect or where its time is changes
   * (`_report`, the `animation` op): `<Html>` samples its frames on its own
   * clock from where it was told the time was, as it samples a CSS
   * animation, so what is drawn is where the timing here says it is, and a
   * finished one is held where it finished, its fill saying what it
   * leaves.
   */
  class Animation extends EventTarget {
    id = '';
    replaceState = 'active';
    /** Which it is to the host, and where it is in the composite order. */
    _hostId = ++animationSeq;
    /** The element the host was last told it animates, and what it was
     *  told, which the same again is not told twice. */
    _toldTo: Any = null;
    _told = '';
    _effect: Any = null;
    _timeline: Any;
    /** The timeline's time it started at, where it is running. */
    _start: number | null = null;
    /** Its own time where it is paused, or finished, or has not started. */
    _held: number | null = null;
    _rate = 1;
    _paused = false;
    _timer = 0;
    _finishedPromise: Any;
    _settle: Any = null;
    _done = false;
    constructor(effect: Any = null, timeline: Any = documentTimeline) {
      super();
      this._timeline = timeline;
      this.effect = effect;
      this._newFinished();
    }
    get effect(): Any {
      return this._effect;
    }
    set effect(effect: Any) {
      if (this._effect) this._effect._animation = null;
      this._effect = effect ?? null;
      if (effect) effect._animation = this;
      this._schedule();
    }
    get timeline(): Any {
      return this._timeline;
    }
    get startTime(): number | null {
      return this._start;
    }
    set startTime(v: Any) {
      if (v === null) {
        this._held = this.currentTime;
        this._start = null;
      } else {
        this._start = Number(v);
        this._held = null;
        this._paused = false;
      }
      this._schedule();
    }
    get currentTime(): number | null {
      if (this._held !== null) return this._held;
      if (this._start === null) return null;
      return (this._timeline.currentTime - this._start) * this._rate;
    }
    set currentTime(v: Any) {
      if (v === null) {
        throw new TypeError(
          "Failed to set the 'currentTime' property on 'Animation': currentTime may not be changed from resolved to unresolved",
        );
      }
      const time = Number(v);
      if (this._paused || this._start === null) this._held = time;
      else this._start = this._timeline.currentTime - time / (this._rate || 1);
      this._done = false;
      this._schedule();
    }
    get playbackRate(): number {
      return this._rate;
    }
    set playbackRate(v: Any) {
      const time = this.currentTime;
      this._rate = Number(v);
      if (time !== null) this.currentTime = time;
    }
    updatePlaybackRate(v: Any): void {
      this.playbackRate = v;
    }
    get pending(): boolean {
      return false;
    }
    get ready(): Any {
      return Promise.resolve(this);
    }
    get finished(): Any {
      return this._finishedPromise;
    }
    get playState(): string {
      const time = this.currentTime;
      if (time === null && !this._paused) return 'idle';
      if (this._paused) return 'paused';
      if (this._ended(time!)) return 'finished';
      return 'running';
    }
    /** Where its effect ends, in its own time. */
    _end(): number {
      return this._effect ? this._effect.getComputedTiming().endTime : 0;
    }
    _ended(time: number): boolean {
      return this._rate > 0
        ? time >= this._end()
        : this._rate < 0
          ? time <= 0
          : false;
    }
    play(): void {
      const time = this.currentTime;
      const end = this._end();
      let from = time;
      if (this._rate > 0 && (time === null || time < 0 || time >= end)) {
        from = 0;
      } else if (this._rate < 0 && (time === null || time <= 0 || time > end)) {
        if (end === Infinity) {
          throw new DOMException(
            "Failed to execute 'play' on 'Animation': Cannot play reversed Animation with infinite target effect end.",
            'InvalidStateError',
          );
        }
        from = end;
      } else if (time === null) from = 0;
      if (this._settle === null) this._newFinished();
      this._paused = false;
      this._held = null;
      this._done = false;
      this._start =
        this._timeline.currentTime - (from ?? 0) / (this._rate || 1);
      this._schedule();
    }
    pause(): void {
      if (this._paused) return;
      const time = this.currentTime ?? (this._rate < 0 ? this._end() : 0);
      this._held = time;
      this._start = null;
      this._paused = true;
      this._schedule();
    }
    reverse(): void {
      this._rate = -this._rate;
      this.play();
    }
    finish(): void {
      const end = this._end();
      if (this._rate === 0 || (this._rate > 0 && end === Infinity)) {
        throw new DOMException(
          "Failed to execute 'finish' on 'Animation': Cannot finish Animation with a playbackRate of 0 or an infinite target effect end.",
          'InvalidStateError',
        );
      }
      this._paused = false;
      this._held = null;
      this._start =
        this._timeline.currentTime - (this._rate > 0 ? end : 0) / this._rate;
      this._schedule();
    }
    cancel(): void {
      if (this.playState === 'idle') return;
      clearTimer(this._timer);
      this._timer = 0;
      if (this._settle) {
        const reject = this._settle.reject;
        this._settle = null;
        reject(new DOMException('The user aborted a request.', 'AbortError'));
      }
      this._newFinished();
      this._start = null;
      this._held = null;
      this._paused = false;
      this._done = false;
      liveAnimations.delete(this);
      this._report();
      this._tell('cancel', null);
    }
    persist(): void {
      this.replaceState = 'persisted';
    }
    /**
     * Its effect's values as they come to now, written into its target's
     * `style` attribute (Web Animations 1, 4.4.13): what a page keeps once
     * it cancels the animation, as `anim.commitStyles(); anim.cancel()`
     * does. `<Html>` works them out, with this animation at the top of
     * the element's effects.
     */
    commitStyles(): void {
      const effect = this._effect;
      const target = effect?.target;
      if (!(target instanceof Element) || effect.pseudoElement !== null) {
        throw new DOMException(
          "Failed to execute 'commitStyles' on 'Animation': Animation effect target is not an element, or is a pseudo-element.",
          'NoModificationAllowedError',
        );
      }
      const values = call(
        'animationValues',
        target._id,
        this._hostId,
        effect._properties().join('\u0000'),
      );
      if (typeof values !== 'string') {
        throw new DOMException(
          "Failed to execute 'commitStyles' on 'Animation': Target element is not rendered.",
          'InvalidStateError',
        );
      }
      if (!values) return;
      // an SVG element's as much as an HTML element's
      const style = (target as Any).style;
      for (const pair of values.split('\u0001')) {
        const [prop, value] = pair.split('\u0000');
        style.setProperty(prop, value);
      }
    }
    /**
     * Tell the host what it animates and where its time is: its effect
     * (`KeyframeEffect._hostEffect`), and `1,<time>,<rate>` where it runs
     * from that time, `0,<time>,<rate>` where it is held there — paused,
     * finished; or, where it has no effect — idle, cancelled, replaced, of
     * no element — that the element it was told of has it no longer.
     */
    _report(): void {
      const effect = this._effect;
      const target = effect?.target ?? null;
      const time = this.currentTime;
      const described =
        target instanceof Element &&
        time !== null &&
        this.replaceState !== 'removed'
          ? effect._hostEffect()
          : null;
      if (this._toldTo && (this._toldTo !== target || described === null)) {
        call('animation', this._toldTo._id, this._hostId, null, null);
        this._toldTo = null;
        this._told = '';
      }
      if (described === null) return;
      const running = this._start !== null && !this._paused;
      // held, it is where it is; running, where it started says where it
      // is from now on, which the same start does not change
      const play = running
        ? `1,${time},${this._rate}`
        : `0,${time},${this._rate}`;
      const told = `${described}\u0000${running ? `s${this._start}` : play}\u0000${this._rate}`;
      if (told === this._told) return;
      this._toldTo = target;
      this._told = told;
      call('animation', target._id, this._hostId, described, play);
    }
    _newFinished(): void {
      this._finishedPromise = new Promise((resolve, reject) => {
        this._settle = { resolve, reject };
      });
      // a cancelled animation's promise is handled (Web Animations 1,
      // 4.4.15): no page has to listen for it
      this._finishedPromise.catch(() => {});
    }
    /** Where it is now, and when it finishes from there: a timer at that
     *  time, and the finish itself where that is now; and the host told
     *  where it is. */
    _schedule(): void {
      this._reschedule();
      this._report();
    }
    _reschedule(): void {
      clearTimer(this._timer);
      this._timer = 0;
      const time = this.currentTime;
      if (time === null) {
        liveAnimations.delete(this);
        return;
      }
      const fill = this._effect?.getTiming().fill;
      if (this._paused) {
        liveAnimations.add(this);
        return;
      }
      if (this._ended(time)) {
        if (fill === 'forwards' || fill === 'both') liveAnimations.add(this);
        else liveAnimations.delete(this);
        if (!this._done) this._finish();
        return;
      }
      liveAnimations.add(this);
      const left =
        this._rate > 0 ? (this._end() - time) / this._rate : time / -this._rate;
      if (!Number.isFinite(left)) return;
      this._timer = setTimer(() => this._schedule(), left, [], false);
    }
    _finish(): void {
      this._done = true;
      const held = this._rate > 0 ? this._end() : 0;
      this._start = null;
      this._held = held;
      // the host hears it is held before the page hears it finished
      this._report();
      const settle = this._settle;
      this._settle = null;
      settle?.resolve(this);
      this._tell('finish', held);
      this._replaceOlder();
    }
    /**
     * The finished animations of its target that fill and that this one
     * and the others finished after them cover every property of, removed
     * (Web Animations 1, 5.5, "removing replaced animations"): a page that
     * fades a panel in and out with `fill: forwards`, a new animation each
     * time, would otherwise keep every one of them on the element, each
     * sampled at every restyle.
     */
    _replaceOlder(): void {
      const target = this._effect?.target;
      if (!target || !this._replaceable()) return;
      const pseudo = this._effect.pseudoElement;
      const later: Any[] = [];
      const mine = [...liveAnimations]
        .filter(
          (a) =>
            a._effect?.target === target &&
            a._effect.pseudoElement === pseudo &&
            a._replaceable(),
        )
        .sort((a, b) => b._hostId - a._hostId);
      for (const a of mine) {
        const covered = new Set<string>();
        for (const b of later) {
          for (const p of b._effect._properties()) covered.add(p);
        }
        const props = a._effect._properties();
        later.push(a);
        if (a === mine[0] || !props.every((p: string) => covered.has(p))) {
          continue;
        }
        a.replaceState = 'removed';
        liveAnimations.delete(a);
        a._report();
        a._tell('remove', a.currentTime);
      }
    }
    /** Whether it may be replaced by later ones: finished, filling, not
     *  persisted, and of an element (Web Animations 1, 5.5). */
    _replaceable(): boolean {
      const fill = this._effect?.getTiming().fill;
      return (
        this.replaceState === 'active' &&
        this.playState === 'finished' &&
        (fill === 'forwards' || fill === 'both') &&
        this._effect?.target instanceof Element
      );
    }
    /** An event of its own, told in a task after the change, as the
     *  document's pending animation events are (Web Animations 1, 4.4.18). */
    _tell(type: string, currentTime: number | null): void {
      const timelineTime = this._timeline.currentTime;
      setTimer(
        () => {
          const ev = new AnimationPlaybackEvent(type, {
            currentTime,
            timelineTime,
          });
          ev.isTrusted = true;
          dispatch(this, ev);
        },
        0,
        [],
        false,
      );
    }
  }
  for (const type of ['finish', 'cancel', 'remove']) {
    Object.defineProperty(Animation.prototype, `on${type}`, {
      get(this: Any): Any {
        return this._handlers[type] ?? null;
      },
      set(this: Any, fn: Any) {
        this._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
    });
  }
  /** The animations running on `target`, or on what it holds as well. */
  const animationsOf = (target: Any, subtree: boolean): Any[] =>
    [...liveAnimations].filter((a) => {
      const on = a.effect?.target;
      if (!on) return false;
      return on === target || (subtree && target.contains?.(on));
    });

  /** The mouse, the one pointer there is (Pointer Events 3): the buttons
   *  held, as the DOM's mask, kept from the presses and releases told
   *  rather than from a move's, which carry none on macOS; and its capture,
   *  the element asked for (`pending`) and the one its events go to; and
   *  whether a cancelled pointerdown keeps the mouse's events back. */
  const MOUSE_ID = 1;
  const pointer: { held: number; pending: Any; target: Any; quiet: boolean } = {
    held: 0,
    pending: null,
    target: null,
    quiet: false,
  };

  // --- nodes -------------------------------------------------------------------

  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XML_NS = 'http://www.w3.org/XML/1998/namespace';
  const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

  const wrappers = new Map<number, Any>();

  /** The wrapper of a node id, made the first time it is asked for. */
  const wrap = (id: number): Any => {
    if (!id) return null;
    let node = wrappers.get(id);
    if (node) return node;
    const info = String(call('info', id));
    const bar = info.indexOf('|');
    const type = Number(info.slice(0, bar));
    let name = info.slice(bar + 1);
    // an element's namespace where it was made in one (`~` for none), and
    // an XML document's content type
    let ns: string | null | undefined;
    const nul = name.indexOf('\u0000');
    if (nul >= 0) {
      ns = name.slice(nul + 1);
      name = name.slice(0, nul);
      if (ns === '~') ns = null;
    }
    const Kind =
      type === 1
        ? ns === undefined
          ? (ELEMENT_CLASSES[name] ??
            (SVG_TAGS.has(name)
              ? (SVG_CLASSES[name] ?? SVGElement)
              : HTMLElement))
          : ns === HTML_NS
            ? (ELEMENT_CLASSES[name] ?? HTMLElement)
            : ns === SVG_NS
              ? (SVG_CLASSES[name.slice(name.indexOf(':') + 1)] ?? SVGElement)
              : Element
        : type === 9 && ns
          ? XMLDocument
          : type === 3
            ? Text
            : type === 8
              ? Comment
              : type === 9
                ? Document
                : type === 10
                  ? DocumentType
                  : name === '#shadow-root'
                    ? ShadowRoot
                    : DocumentFragment;
    node = Object.create(Kind.prototype);
    Object.assign(node, new EventTarget());
    node._id = id;
    node._name = name;
    if (type === 1) node._ns = ns;
    if (type === 9) node._type = ns ?? null;
    // what a class's fields would have set, which no constructor ran for
    if (Kind === Document || Kind === XMLDocument) {
      node._ready = 'loading';
      node._current = null;
    }
    wrappers.set(id, node);
    return node;
  };
  const wrapAll = (s: Any): Any[] => idList(s).map(wrap);
  const idOf = (node: Any, what = 'parameter'): number => {
    if (!node || typeof node._id !== 'number') {
      throw new TypeError(`${what} is not of type 'Node'.`);
    }
    return node._id;
  };

  /** A list a page indexes and iterates, as a `NodeList` or an
   *  `HTMLCollection` is — not live: a copy as it was asked for. */
  class NodeList extends Array {}
  class HTMLCollection extends Array {}
  const list = (items: Any[]): Any => {
    const out: Any = Object.setPrototypeOf(items.slice(), NodeList.prototype);
    out.item = (i: number) => out[i] ?? null;
    out.namedItem = (name: string) =>
      items.find(
        (n) =>
          n.getAttribute?.('id') === name || n.getAttribute?.('name') === name,
      ) ?? null;
    return out;
  };

  /** An `HTMLCollection` (DOM 4.2.10.2): a list whose members are also
   *  its properties by id and by name, as `document.forms.form` and
   *  `form.elements.first` read them. Not live: a copy as it was asked
   *  for. */
  const collection = (items: Any[]): Any => {
    const out = list(items);
    for (const el of items) {
      for (const key of [el.getAttribute?.('id'), el.getAttribute?.('name')]) {
        if (key && !(key in out)) out[key] = el;
      }
    }
    return out;
  };

  /** A string a node is given: what a page passes, converted here. */
  const str = (v: Any): string => String(v);

  class Node extends EventTarget {
    static readonly ELEMENT_NODE = 1;
    static readonly ATTRIBUTE_NODE = 2;
    static readonly TEXT_NODE = 3;
    static readonly CDATA_SECTION_NODE = 4;
    static readonly PROCESSING_INSTRUCTION_NODE = 7;
    static readonly COMMENT_NODE = 8;
    static readonly DOCUMENT_NODE = 9;
    static readonly DOCUMENT_TYPE_NODE = 10;
    static readonly DOCUMENT_FRAGMENT_NODE = 11;
    static readonly DOCUMENT_POSITION_DISCONNECTED = 1;
    static readonly DOCUMENT_POSITION_PRECEDING = 2;
    static readonly DOCUMENT_POSITION_FOLLOWING = 4;
    static readonly DOCUMENT_POSITION_CONTAINS = 8;
    static readonly DOCUMENT_POSITION_CONTAINED_BY = 16;
    _id = 0;
    _name = '';
    constructor() {
      super();
      throw new TypeError('Illegal constructor');
    }
    get nodeType(): number {
      return 0;
    }
    get nodeName(): string {
      return this._name;
    }
    get ownerDocument(): Any {
      return wrap(Number(call('owner', this._id)));
    }
    get parentNode(): Any {
      return wrap(call('parent', this._id));
    }
    get parentElement(): Any {
      const p = this.parentNode;
      return p instanceof Element ? p : null;
    }
    get childNodes(): Any {
      return list(wrapAll(call('kids', this._id)));
    }
    get firstChild(): Any {
      return wrap(call('first', this._id));
    }
    get lastChild(): Any {
      return wrap(call('last', this._id));
    }
    get nextSibling(): Any {
      return wrap(call('next', this._id));
    }
    get previousSibling(): Any {
      return wrap(call('prev', this._id));
    }
    get isConnected(): boolean {
      return !!call('connected', this._id);
    }
    get textContent(): Any {
      return call('text', this._id);
    }
    set textContent(v: Any) {
      call('setText', this._id, v === null ? '' : str(v));
    }
    get nodeValue(): Any {
      return null;
    }
    set nodeValue(_v: Any) {}
    get baseURI(): string {
      return String(call('base'));
    }
    hasChildNodes(): boolean {
      return !!call('first', this._id);
    }
    getRootNode(options?: Any): Any {
      let at: Any = this;
      for (;;) {
        for (let p = at.parentNode; p; p = p.parentNode) at = p;
        if (!(options?.composed && at instanceof ShadowRoot)) return at;
        at = at.host;
      }
    }
    contains(other: Any): boolean {
      if (!other) return false;
      return !!call('contains', this._id, idOf(other));
    }
    isSameNode(other: Any): boolean {
      return this === other;
    }
    isEqualNode(other: Any): boolean {
      return !!other && call('equal', this._id, idOf(other));
    }
    compareDocumentPosition(other: Any): number {
      return Number(call('position', this._id, idOf(other)));
    }
    appendChild(child: Any): Any {
      call('insert', this._id, idOf(child), 0);
      return child;
    }
    insertBefore(child: Any, before: Any): Any {
      call('insert', this._id, idOf(child), before ? idOf(before) : 0);
      return child;
    }
    removeChild(child: Any): Any {
      if (child?.parentNode !== this) {
        throw new DOMException(
          'The node to be removed is not a child of this node.',
          'NotFoundError',
        );
      }
      call('remove', child._id);
      return child;
    }
    replaceChild(child: Any, old: Any): Any {
      call('replace', this._id, idOf(child), idOf(old));
      return old;
    }
    cloneNode(deep = false): Any {
      return wrap(call('clone', this._id, !!deep));
    }
    /** Adjacent texts made one, and empty ones taken out (DOM 4.4). */
    normalize(): void {
      const walk = (node: Any): void => {
        let child = node.firstChild;
        while (child) {
          if (child.nodeType !== 3) {
            walk(child);
            child = child.nextSibling;
            continue;
          }
          let next = child.nextSibling;
          if (!child.length) {
            child.remove();
            child = next;
            continue;
          }
          let data = '';
          while (next && next.nodeType === 3) {
            data += next.data;
            const after = next.nextSibling;
            next.remove();
            next = after;
          }
          if (data) child.appendData(data);
          child = next;
        }
      };
      walk(this);
    }
    lookupNamespaceURI(): null {
      return null;
    }
  }
  // the constants on every node too, as WebIDL puts them on the prototype
  for (const name of Object.getOwnPropertyNames(Node)) {
    if (!/^[A-Z_]+$/.test(name)) continue;
    Object.defineProperty(Node.prototype, name, {
      value: (Node as Any)[name],
      enumerable: true,
    });
  }
  const nodeTypeOf = (n: number) => ({
    get(): number {
      return n;
    },
  });

  /** What `append`, `before` and their kin take: nodes, and strings that
   *  are text. */
  const nodesFrom = (items: Any[]): number => {
    if (items.length === 1 && items[0] instanceof Node) return items[0]._id;
    const fragment = Number(call('create', 'fragment', ''));
    for (const item of items) {
      const id =
        item instanceof Node
          ? item._id
          : Number(call('create', 'text', str(item)));
      call('insert', fragment, id, 0);
    }
    return fragment;
  };

  /** ParentNode (DOM 4.2.6): what an element, a document and a fragment
   *  have of their children. */
  class ParentNode extends Node {
    get children(): Any {
      return list(wrapAll(call('kids', this._id, 'elements')));
    }
    get childElementCount(): number {
      return idList(call('kids', this._id, 'elements')).length;
    }
    get firstElementChild(): Any {
      return wrap(idList(call('kids', this._id, 'elements'))[0] ?? 0);
    }
    get lastElementChild(): Any {
      const ids = idList(call('kids', this._id, 'elements'));
      return wrap(ids[ids.length - 1] ?? 0);
    }
    append(...items: Any[]): void {
      call('insert', this._id, nodesFrom(items), 0);
    }
    prepend(...items: Any[]): void {
      call(
        'insert',
        this._id,
        nodesFrom(items),
        Number(call('first', this._id)),
      );
    }
    replaceChildren(...items: Any[]): void {
      call('setText', this._id, '');
      if (items.length) call('insert', this._id, nodesFrom(items), 0);
    }
    querySelector(selector: Any): Any {
      return wrap(Number(call('query', this._id, str(selector), false)));
    }
    querySelectorAll(selector: Any): Any {
      return list(wrapAll(call('query', this._id, str(selector), true)));
    }
    getElementsByTagName(tag: Any): Any {
      return list(wrapAll(call('byTag', this._id, str(tag))));
    }
    getElementsByClassName(names: Any): Any {
      return list(wrapAll(call('byClass', this._id, str(names))));
    }
  }

  /** ChildNode (DOM 4.2.8): an element's and a character data node's
   *  moves among its siblings, each class's methods calling these. */
  const childBefore = (node: Any, items: Any[]): void => {
    const parent = call('parent', node._id);
    if (parent) call('insert', parent, nodesFrom(items), node._id);
  };
  const childAfter = (node: Any, items: Any[]): void => {
    const parent = call('parent', node._id);
    if (parent) {
      call('insert', parent, nodesFrom(items), Number(call('next', node._id)));
    }
  };
  const childReplace = (node: Any, items: Any[]): void => {
    const parent = call('parent', node._id);
    if (!parent) return;
    call('insert', parent, nodesFrom(items), node._id);
    call('remove', node._id);
  };

  class CharacterData extends Node {
    get data(): string {
      return String(call('text', this._id));
    }
    set data(v: Any) {
      call('setText', this._id, v === null ? '' : str(v));
    }
    override get nodeValue(): Any {
      return this.data;
    }
    override set nodeValue(v: Any) {
      this.data = v;
    }
    override get textContent(): Any {
      return this.data;
    }
    override set textContent(v: Any) {
      this.data = v;
    }
    get length(): number {
      return this.data.length;
    }
    // what changes the data goes through the host, which moves the ranges
    // in it as DOM 4.10's "replace data" has them
    appendData(s: Any): void {
      call('replaceData', this._id, this.length, 0, str(s));
    }
    insertData(offset: Any, s: Any): void {
      call('replaceData', this._id, Number(offset) >>> 0, 0, str(s));
    }
    deleteData(offset: Any, count: Any): void {
      call(
        'replaceData',
        this._id,
        Number(offset) >>> 0,
        Number(count) >>> 0,
        '',
      );
    }
    replaceData(offset: Any, count: Any, s: Any): void {
      call(
        'replaceData',
        this._id,
        Number(offset) >>> 0,
        Number(count) >>> 0,
        str(s),
      );
    }
    substringData(offset: Any, count: Any): string {
      const data = this.data;
      const at = Number(offset) >>> 0;
      if (at > data.length) {
        throw new DOMException(
          `The offset ${at} is greater than the node's length (${data.length}).`,
          'IndexSizeError',
        );
      }
      return data.substr(at, Number(count) >>> 0);
    }
    get nextElementSibling(): Any {
      return wrap(Number(call('next', this._id, 'element')));
    }
    get previousElementSibling(): Any {
      return wrap(Number(call('prev', this._id, 'element')));
    }
    before(...items: Any[]): void {
      childBefore(this, items);
    }
    after(...items: Any[]): void {
      childAfter(this, items);
    }
    replaceWith(...items: Any[]): void {
      childReplace(this, items);
    }
    remove(): void {
      call('remove', this._id);
    }
  }
  class Text extends CharacterData {
    /** The text and the texts either side of it, run together. */
    get wholeText(): string {
      let first: Any = this;
      while (first.previousSibling?.nodeType === 3) {
        first = first.previousSibling;
      }
      let out = '';
      for (let at = first; at?.nodeType === 3; at = at.nextSibling) {
        out += at.data;
      }
      return out;
    }
    splitText(offset: Any): Any {
      return wrap(Number(call('splitText', this._id, Number(offset) >>> 0)));
    }
  }
  Object.defineProperty(Text.prototype, 'nodeType', nodeTypeOf(3));
  class Comment extends CharacterData {}
  // never made here — HTML has no CDATA outside foreign content, and no
  // processing instruction — but a polyfill patches their prototypes
  class CDATASection extends Text {}
  class ProcessingInstruction extends CharacterData {
    get target(): string {
      return '';
    }
  }
  Object.defineProperty(Comment.prototype, 'nodeType', nodeTypeOf(8));

  class DocumentType extends Node {
    _ids(): string[] {
      return String(call('doctype', this._id)).split('\u0000');
    }
    get name(): string {
      return this._ids()[0];
    }
    get publicId(): string {
      return this._ids()[1] ?? '';
    }
    get systemId(): string {
      return this._ids()[2] ?? '';
    }
    before(...items: Any[]): void {
      childBefore(this, items);
    }
    after(...items: Any[]): void {
      childAfter(this, items);
    }
    replaceWith(...items: Any[]): void {
      childReplace(this, items);
    }
    remove(): void {
      call('remove', this._id);
    }
  }
  Object.defineProperty(DocumentType.prototype, 'nodeType', nodeTypeOf(10));

  class DocumentFragment extends ParentNode {
    getElementById(id: Any): Any {
      return wrap(
        Number(call('query', this._id, `#${cssEscape(str(id))}`, false)),
      );
    }
  }
  Object.defineProperty(DocumentFragment.prototype, 'nodeType', nodeTypeOf(11));
  class ShadowRoot extends DocumentFragment {
    get host(): Any {
      return wrap(Number(call('shadowHost', this._id)));
    }
    get mode(): string {
      return String(call('shadowMode', this._id));
    }
    get delegatesFocus(): boolean {
      return call('shadowDelegates', this._id) === true;
    }
    get slotAssignment(): string {
      return 'named';
    }
    get innerHTML(): string {
      return String(call('html', this._id, false));
    }
    set innerHTML(v: Any) {
      call('setHtml', this._id, v === null ? '' : str(v));
    }
    get activeElement(): Any {
      return null;
    }
    get adoptedStyleSheets(): Any[] {
      return [];
    }
    set adoptedStyleSheets(_v: Any) {}
  }
  /** Where an event goes from a node: its parent, and out of a shadow tree
   *  to its host where the event is composed, as most a user makes are. */
  const parentFor = (node: Any, event: Any): Any =>
    node instanceof ShadowRoot
      ? event._composed
        ? node.host
        : null
      : node.parentNode;

  // --- elements ------------------------------------------------------------------

  /** A `DOMTokenList` over an attribute: `classList`, `relList`. */
  class DOMTokenList {
    _el: Any;
    _attr: string;
    constructor(el: Any, attr: string) {
      this._el = el;
      this._attr = attr;
    }
    _tokens(): string[] {
      return (this._el.getAttribute(this._attr) ?? '')
        .split(/[\t\n\f\r ]+/)
        .filter(Boolean);
    }
    _set(tokens: string[]): void {
      this._el.setAttribute(this._attr, [...new Set(tokens)].join(' '));
    }
    get length(): number {
      return this._tokens().length;
    }
    get value(): string {
      return this._el.getAttribute(this._attr) ?? '';
    }
    set value(v: Any) {
      this._el.setAttribute(this._attr, str(v));
    }
    item(i: number): string | null {
      return this._tokens()[i] ?? null;
    }
    contains(token: Any): boolean {
      return this._tokens().includes(str(token));
    }
    add(...tokens: Any[]): void {
      this._set([...this._tokens(), ...tokens.map(str)]);
    }
    remove(...tokens: Any[]): void {
      const gone = new Set(tokens.map(str));
      this._set(this._tokens().filter((t) => !gone.has(t)));
    }
    toggle(token: Any, force?: boolean): boolean {
      const t = str(token);
      const has = this.contains(t);
      const on = force === undefined ? !has : !!force;
      if (on && !has) this.add(t);
      if (!on && has) this.remove(t);
      return on;
    }
    replace(old: Any, next: Any): boolean {
      const tokens = this._tokens();
      const at = tokens.indexOf(str(old));
      if (at < 0) return false;
      tokens[at] = str(next);
      this._set(tokens);
      return true;
    }
    forEach(fn: Any, self?: Any): void {
      this._tokens().forEach((t, i) => fn.call(self, t, i, this));
    }
    [Symbol.iterator](): Iterator<string> {
      return this._tokens()[Symbol.iterator]();
    }
    toString(): string {
      return this.value;
    }
  }

  /** `el.style`: the `style` attribute's declarations, read and written by
   *  the host with `<Html>`'s own parser, so a page and the cascade agree
   *  on what it wrote. */
  const kebab = (name: string): string =>
    name.startsWith('--')
      ? name
      : name
          .replace(/^(webkit|moz|ms)(?=[A-Z])/, '-$1')
          .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const camel = (name: string): string =>
    name
      .replace(/^-(webkit|moz|ms)-/, '$1-')
      .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  /** A property's name as a declaration keeps it: a custom property's as
   *  written, since `--Tabs-x` and `--tabs-x` are two (CSS Variables 1,
   *  2), and any other's in lower case. */
  const cssName = (name: Any): string => {
    const n = str(name);
    return n.startsWith('--') ? n : n.toLowerCase();
  };
  const styleOf = (el: Any): Any => {
    const target = {
      getPropertyValue: (name: Any) =>
        String(call('style', el._id, cssName(name)) ?? ''),
      getPropertyPriority: (name: Any) =>
        String(call('stylePriority', el._id, cssName(name)) ?? ''),
      setProperty: (name: Any, value: Any, priority: Any = '') =>
        void call(
          'setStyle',
          el._id,
          cssName(name),
          value === null || value === undefined ? '' : str(value),
          str(priority),
        ),
      removeProperty: (name: Any) => {
        const was = target.getPropertyValue(name);
        call('setStyle', el._id, cssName(name), '', '');
        return was;
      },
      item: (i: number) =>
        String(call('styleNames', el._id) ?? '')
          .split(',')
          .filter(Boolean)[i] ?? '',
      get length(): number {
        return String(call('styleNames', el._id) ?? '')
          .split(',')
          .filter(Boolean).length;
      },
      get cssText(): string {
        return String(call('styleText', el._id) ?? '');
      },
      set cssText(v: Any) {
        el.setAttribute('style', str(v));
      },
    } as Any;
    // `cssFloat` is `float`, a word JavaScript once kept for itself
    const property = (key: string): string =>
      key === 'cssFloat' ? 'float' : kebab(key);
    return new Proxy(target, {
      get(t, key) {
        if (typeof key !== 'string' || key in t) return t[key as Any];
        return t.getPropertyValue(property(key));
      },
      set(t, key, value) {
        if (typeof key !== 'string') return false;
        if (key === 'cssText') t.cssText = value;
        else t.setProperty(property(key), value);
        return true;
      },
    });
  };

  /** `el.dataset`: the `data-*` attributes, by their names in camel case. */
  const datasetOf = (el: Any): Any =>
    new Proxy(Object.create(null), {
      get(_t, key) {
        if (typeof key !== 'string') return undefined;
        return el.getAttribute(`data-${kebab(key)}`) ?? undefined;
      },
      set(_t, key, value) {
        if (typeof key !== 'string') return false;
        el.setAttribute(`data-${kebab(key)}`, str(value));
        return true;
      },
      deleteProperty(_t, key) {
        if (typeof key === 'string') el.removeAttribute(`data-${kebab(key)}`);
        return true;
      },
      has(_t, key) {
        return typeof key === 'string' && el.hasAttribute(`data-${kebab(key)}`);
      },
      ownKeys() {
        return el
          .getAttributeNames()
          .filter((n: string) => n.startsWith('data-'))
          .map((n: string) => camel(n.slice(5)));
      },
      getOwnPropertyDescriptor(_t, key) {
        if (typeof key !== 'string') return undefined;
        const value = el.getAttribute(`data-${kebab(key)}`);
        return value === null
          ? undefined
          : { value, writable: true, enumerable: true, configurable: true };
      },
    });

  /** A rectangle as `getBoundingClientRect` hands one over: the viewport's
   *  coordinates, which are the document's less the scroll. */
  class DOMRect {
    x: number;
    y: number;
    width: number;
    height: number;
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
    }
    get left(): number {
      return Math.min(this.x, this.x + this.width);
    }
    get top(): number {
      return Math.min(this.y, this.y + this.height);
    }
    get right(): number {
      return Math.max(this.x, this.x + this.width);
    }
    get bottom(): number {
      return Math.max(this.y, this.y + this.height);
    }
    toJSON(): Any {
      const { x, y, width, height, left, top, right, bottom } = this;
      return { x, y, width, height, left, top, right, bottom };
    }
  }

  /** Where an element is in the document, in CSS pixels; null where it has
   *  no box. */
  const docRect = (el: Any): number[] | null => {
    const r = call('rect', el._id);
    return typeof r === 'string' && r ? r.split(',').map(Number) : null;
  };
  /** Where an element is as the offset attributes measure it, from one
   *  walk up its boxes: its `offsetParent`'s id, then x, y, width and
   *  height in CSS pixels, from that one's padding edge, as layout put it
   *  before a transform or a scroll moved it (CSSOM View 7,
   *  `HtmlHandle.offsetRect`). Null where it has no box. */
  const offsetOf = (el: Any): number[] | null => {
    const r = call('offset', el._id);
    return typeof r === 'string' && r ? r.split(',').map(Number) : null;
  };
  /** A `long` from layout's pixels: rounded, as Blink rounds its layout
   *  units, and never -0. */
  const rounded = (v: number | undefined): number => Math.round(v ?? 0) + 0;
  /** Where a scroll container is scrolled to, how far it can be and its
   *  scrollport, in CSS pixels — x, y, width, height, clientWidth,
   *  clientHeight, clientTop, clientLeft — or null for an element that is
   *  none (`HtmlHandle.scrollState`). */
  const scrollStateOf = (el: Any): number[] | null => {
    const r = call('scrollState', el._id);
    return typeof r === 'string' && r ? r.split(',').map(Number) : null;
  };

  // --- attribute nodes ---------------------------------------------------------------
  //
  // An `Attr` is one object for as long as its element has the attribute,
  // as DOM has it, so `el.attributes[0] === el.getAttributeNode(name)`; its
  // value is the element's, read as it is asked. Taken off, it keeps the
  // value it had. `attributes` is live: React empties an element with
  // `while (attributes.length) removeAttributeNode(attributes[0])`.

  class Attr {
    _el: Any;
    _name: string;
    _value: string;
    constructor(name: string, el: Any, value = '') {
      this._name = name;
      this._el = el;
      this._value = value;
    }
    get nodeType(): number {
      return 2;
    }
    get nodeName(): string {
      return this._name;
    }
    get name(): string {
      return this._name;
    }
    get localName(): string {
      return this._name;
    }
    get namespaceURI(): Any {
      return null;
    }
    get prefix(): Any {
      return null;
    }
    get specified(): boolean {
      return true;
    }
    get ownerElement(): Any {
      return this._el;
    }
    get ownerDocument(): Any {
      return document;
    }
    get value(): string {
      return this._el ? (this._el.getAttribute(this._name) ?? '') : this._value;
    }
    set value(v: Any) {
      this._value = str(v);
      if (this._el) this._el.setAttribute(this._name, this._value);
    }
    get nodeValue(): string {
      return this.value;
    }
    set nodeValue(v: Any) {
      this.value = v;
    }
    get textContent(): string {
      return this.value;
    }
    set textContent(v: Any) {
      this.value = v;
    }
    cloneNode(): Any {
      return new Attr(this._name, null, this.value);
    }
  }
  const attrNodes = new WeakMap<object, Map<string, Any>>();
  const attrsOf = (el: Any): Map<string, Any> => {
    let attrs = attrNodes.get(el);
    if (!attrs) attrNodes.set(el, (attrs = new Map()));
    return attrs;
  };
  const attrOf = (el: Any, name: string): Any => {
    const attrs = attrsOf(el);
    let attr = attrs.get(name);
    if (!attr) attrs.set(name, (attr = new Attr(name, el)));
    return attr;
  };
  /** An attribute node off its element, keeping the value it had. */
  const detachAttr = (attr: Any): void => {
    const el = attr._el;
    if (!el) return;
    attr._value = el.getAttribute(attr._name) ?? attr._value;
    attr._el = null;
    attrNodes.get(el)?.delete(attr._name);
  };

  class NamedNodeMap {
    _el: Any;
    constructor(el: Any) {
      this._el = el;
    }
    get length(): number {
      return this._el.getAttributeNames().length;
    }
    item(i: Any): Any {
      const name = this._el.getAttributeNames()[Number(i)];
      return name === undefined ? null : attrOf(this._el, name);
    }
    getNamedItem(name: Any): Any {
      return this._el.getAttributeNode(name);
    }
    getNamedItemNS(_ns: Any, name: Any): Any {
      return this._el.getAttributeNode(name);
    }
    setNamedItem(attr: Any): Any {
      return this._el.setAttributeNode(attr);
    }
    setNamedItemNS(attr: Any): Any {
      return this._el.setAttributeNode(attr);
    }
    removeNamedItem(name: Any): Any {
      const attr = this._el.getAttributeNode(name);
      if (!attr) {
        throw new DOMException(
          `No item with name '${str(name)}' was found.`,
          'NotFoundError',
        );
      }
      return this._el.removeAttributeNode(attr);
    }
    removeNamedItemNS(_ns: Any, name: Any): Any {
      return this.removeNamedItem(name);
    }
    [Symbol.iterator](): Iterator<Any> {
      return this._el
        .getAttributeNames()
        .map((name: string) => attrOf(this._el, name))
        [Symbol.iterator]();
    }
  }
  /** An element's `attributes`: one map for the element, indexed live. */
  const attributeMaps = new WeakMap<object, Any>();
  const INDEX = /^(?:0|[1-9]\d*)$/;
  const namedNodeMapOf = (el: Any): Any => {
    let map = attributeMaps.get(el);
    if (map) return map;
    map = new Proxy(new NamedNodeMap(el), {
      get(target: Any, key: Any): Any {
        if (typeof key === 'string' && INDEX.test(key)) {
          return target.item(Number(key)) ?? undefined;
        }
        return Reflect.get(target, key, target);
      },
      has(target: Any, key: Any): boolean {
        if (typeof key === 'string' && INDEX.test(key)) {
          return Number(key) < target.length;
        }
        return Reflect.has(target, key);
      },
      ownKeys(target: Any): Any[] {
        return [
          ...target._el
            .getAttributeNames()
            .map((_: Any, i: number) => String(i)),
          ...Reflect.ownKeys(target),
        ];
      },
      getOwnPropertyDescriptor(target: Any, key: Any): Any {
        if (typeof key === 'string' && INDEX.test(key)) {
          const value = target.item(Number(key));
          return value
            ? { value, enumerable: true, configurable: true, writable: false }
            : undefined;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    attributeMaps.set(el, map);
    return map;
  };

  class Element extends ParentNode {
    _classList: Any;
    _dataset: Any;
    _style: Any;
    /** The namespace the element was made in, where one was named: none
     *  is HTML's, as the parser makes every element here. */
    _ns: string | null | undefined;
    /** Its qualified name, upper-cased where it is HTML's in an HTML
     *  document (DOM 4.9). */
    get tagName(): string {
      if (this._ns === undefined) return this._name.toUpperCase();
      return this._ns === HTML_NS && !this.ownerDocument?._type
        ? this._name.toUpperCase()
        : this._name;
    }
    override get nodeName(): string {
      return this.tagName;
    }
    get localName(): string {
      if (this._ns === undefined) return this._name;
      return this._name.slice(this._name.indexOf(':') + 1);
    }
    get namespaceURI(): string | null {
      return this._ns === undefined ? HTML_NS : this._ns;
    }
    get prefix(): string | null {
      const colon = this._ns === undefined ? -1 : this._name.indexOf(':');
      return colon < 0 ? null : this._name.slice(0, colon);
    }
    get id(): string {
      return this.getAttribute('id') ?? '';
    }
    set id(v: Any) {
      this.setAttribute('id', v);
    }
    get className(): string {
      return this.getAttribute('class') ?? '';
    }
    set className(v: Any) {
      this.setAttribute('class', v);
    }
    get classList(): Any {
      return (this._classList ??= new DOMTokenList(this, 'class'));
    }
    // `[PutForwards=value]`: the list's value, which is the attribute
    set classList(v: Any) {
      this.setAttribute('class', v);
    }
    get slot(): string {
      return this.getAttribute('slot') ?? '';
    }
    set slot(v: Any) {
      this.setAttribute('slot', v);
    }
    get attributes(): Any {
      return namedNodeMapOf(this);
    }
    getAttributeNode(name: Any): Any {
      const n = str(name).toLowerCase();
      return this.hasAttribute(n) ? attrOf(this, n) : null;
    }
    getAttributeNodeNS(_ns: Any, name: Any): Any {
      return this.getAttributeNode(name);
    }
    setAttributeNode(attr: Any): Any {
      if (!(attr instanceof Attr)) {
        throw new TypeError("parameter 1 is not of type 'Attr'.");
      }
      if (attr._el === this) return attr;
      if (attr._el) {
        throw new DOMException(
          'The node provided is an attribute node that is already an attribute of another Element; attribute nodes must be explicitly cloned.',
          'InUseAttributeError',
        );
      }
      const old = this.getAttributeNode(attr.name);
      if (old) detachAttr(old);
      this.setAttribute(attr.name, attr._value);
      attr._el = this;
      attrsOf(this).set(attr.name, attr);
      return old;
    }
    setAttributeNodeNS(attr: Any): Any {
      return this.setAttributeNode(attr);
    }
    removeAttributeNode(attr: Any): Any {
      if (!(attr instanceof Attr) || attr._el !== this) {
        throw new DOMException(
          'The node provided is owned by another element.',
          'NotFoundError',
        );
      }
      this.removeAttribute(attr.name);
      return attr;
    }
    getAttributeNames(): string[] {
      const names = call('attrs', this._id);
      return typeof names === 'string' && names ? names.split('\u0000') : [];
    }
    getAttribute(name: Any): string | null {
      const v = call('attr', this._id, str(name).toLowerCase());
      return typeof v === 'string' ? v : null;
    }
    getAttributeNS(_ns: Any, name: Any): string | null {
      return this.getAttribute(name);
    }
    hasAttribute(name: Any): boolean {
      return this.getAttribute(name) !== null;
    }
    hasAttributes(): boolean {
      return this.getAttributeNames().length > 0;
    }
    setAttribute(name: Any, value: Any): void {
      const n = str(name).toLowerCase();
      if (!/^[^\s"'>/=\u0000-\u001f]+$/.test(n)) {
        throw new DOMException(
          `'${n}' is not a valid attribute name.`,
          'InvalidCharacterError',
        );
      }
      call('setAttr', this._id, n, str(value));
    }
    setAttributeNS(_ns: Any, name: Any, value: Any): void {
      this.setAttribute(String(name).replace(/^.*:/, ''), value);
    }
    removeAttribute(name: Any): void {
      const n = str(name).toLowerCase();
      const attr = attrNodes.get(this)?.get(n);
      if (attr) detachAttr(attr);
      call('delAttr', this._id, n);
    }
    removeAttributeNS(_ns: Any, name: Any): void {
      this.removeAttribute(name);
    }
    toggleAttribute(name: Any, force?: boolean): boolean {
      const has = this.hasAttribute(name);
      const on = force === undefined ? !has : !!force;
      if (on && !has) this.setAttribute(name, '');
      if (!on && has) this.removeAttribute(name);
      return on;
    }
    get innerHTML(): string {
      return String(call('html', this._id, false));
    }
    set innerHTML(v: Any) {
      call('setHtml', this._id, v === null ? '' : str(v));
    }
    get outerHTML(): string {
      return String(call('html', this._id, true));
    }
    set outerHTML(v: Any) {
      call('adjacent', this._id, 'beforebegin', str(v));
      call('remove', this._id);
    }
    insertAdjacentHTML(where: Any, html: Any): void {
      call('adjacent', this._id, str(where).toLowerCase(), str(html));
    }
    insertAdjacentText(where: Any, text: Any): void {
      this.insertAdjacentElement(where, document.createTextNode(text));
    }
    insertAdjacentElement(where: Any, el: Any): Any {
      const w = str(where).toLowerCase();
      if (w === 'beforebegin') this.before(el);
      else if (w === 'afterbegin') this.prepend(el);
      else if (w === 'beforeend') this.append(el);
      else if (w === 'afterend') this.after(el);
      else throw new DOMException(`'${w}' is not a position.`, 'SyntaxError');
      return el;
    }
    matches(selector: Any): boolean {
      return !!call('matches', this._id, str(selector));
    }
    webkitMatchesSelector(selector: Any): boolean {
      return this.matches(selector);
    }
    closest(selector: Any): Any {
      return wrap(Number(call('closest', this._id, str(selector))));
    }
    getBoundingClientRect(): Any {
      const r = docRect(this);
      if (!r) return new DOMRect();
      const v = viewport();
      return new DOMRect(r[0] - v.scrollX, r[1] - v.scrollY, r[2], r[3]);
    }
    getClientRects(): Any {
      const r = docRect(this);
      return list(r ? [this.getBoundingClientRect()] : []);
    }
    // Pointer Events 3, 10.1: the pointer's events go to this element until
    // it lets go or the buttons are released. A pointer with no button held
    // is not captured, as Chrome has it, and the capture changes hands
    // before the pointer's next event (`takeCapture`).
    setPointerCapture(pointerId: Any): void {
      if (Number(pointerId) !== MOUSE_ID) {
        throw new DOMException(
          'No active pointer with that id',
          'NotFoundError',
        );
      }
      if (!this.isConnected) {
        throw new DOMException(
          'The element is not in a document',
          'InvalidStateError',
        );
      }
      if (pointer.held) pointer.pending = this;
    }
    releasePointerCapture(pointerId: Any): void {
      if (Number(pointerId) !== MOUSE_ID) {
        throw new DOMException(
          'No active pointer with that id',
          'NotFoundError',
        );
      }
      if (pointer.pending === this) pointer.pending = null;
    }
    hasPointerCapture(pointerId: Any): boolean {
      return Number(pointerId) === MOUSE_ID && pointer.pending === this;
    }
    // A scroll container's are its scrollport's and its content's
    // (`scrollState`); the viewport's are the document's scrolling
    // element's, as `scrollingElement` is the root (CSSOM View 7). An
    // element that is neither answers with its border box and scrolls
    // nothing.
    get clientWidth(): number {
      const s = scrollStateOf(this);
      if (s) return Math.round(s[4]);
      if (this._viewport()) return viewport().width;
      return Math.round(docRect(this)?.[2] ?? 0);
    }
    get clientHeight(): number {
      const s = scrollStateOf(this);
      if (s) return Math.round(s[5]);
      if (this._viewport()) return viewport().height;
      return Math.round(docRect(this)?.[3] ?? 0);
    }
    get clientTop(): number {
      return Math.round(scrollStateOf(this)?.[6] ?? 0);
    }
    get clientLeft(): number {
      return Math.round(scrollStateOf(this)?.[7] ?? 0);
    }
    get scrollWidth(): number {
      const s = scrollStateOf(this);
      if (s) return Math.round(s[2]);
      if (this._viewport()) {
        return Math.max(viewport().width, Math.round(docRect(this)?.[2] ?? 0));
      }
      return this.clientWidth;
    }
    get scrollHeight(): number {
      const s = scrollStateOf(this);
      if (s) return Math.round(s[3]);
      if (this._viewport()) {
        return Math.max(viewport().height, Math.round(docRect(this)?.[3] ?? 0));
      }
      return this.clientHeight;
    }
    get scrollTop(): number {
      if (this._viewport()) return viewport().scrollY;
      return scrollStateOf(this)?.[1] ?? 0;
    }
    set scrollTop(v: Any) {
      this._scrollTo(undefined, Number(v));
    }
    get scrollLeft(): number {
      if (this._viewport()) return viewport().scrollX;
      return scrollStateOf(this)?.[0] ?? 0;
    }
    set scrollLeft(v: Any) {
      this._scrollTo(Number(v), undefined);
    }
    /** Whether this element's scrolling is the viewport's: the root's. */
    _viewport(): boolean {
      return this === document.documentElement;
    }
    /** Scroll this element, an axis left where it is where it is not a
     *  number: the viewport for the root. */
    _scrollTo(x: number | undefined, y: number | undefined): void {
      const ok = (v: number | undefined) =>
        v !== undefined && Number.isFinite(v);
      if (this._viewport()) {
        const v = viewport();
        call('scrollTo', ok(x) ? x : v.scrollX, ok(y) ? y : v.scrollY);
        return;
      }
      call(
        'scrollElement',
        this._id,
        ok(x) ? x : undefined,
        ok(y) ? y : undefined,
      );
    }
    scroll(a?: Any, b?: Any): void {
      this.scrollTo(a, b);
    }
    scrollTo(a?: Any, b?: Any): void {
      if (a && typeof a === 'object') {
        this._scrollTo(
          a.left === undefined ? undefined : Number(a.left),
          a.top === undefined ? undefined : Number(a.top),
        );
      } else if (a !== undefined) this._scrollTo(Number(a), Number(b));
    }
    scrollBy(a?: Any, b?: Any): void {
      const by =
        a && typeof a === 'object'
          ? { x: Number(a.left ?? 0), y: Number(a.top ?? 0) }
          : { x: Number(a ?? 0), y: Number(b ?? 0) };
      this._scrollTo(
        this.scrollLeft + (Number.isFinite(by.x) ? by.x : 0),
        this.scrollTop + (Number.isFinite(by.y) ? by.y : 0),
      );
    }
    /** Brought into view through every scroll container around it whose
     *  scroll moves it, the innermost first, and then the viewport (CSSOM
     *  View 7.1): its top at the top of each, or its middle, its end or
     *  as little as shows it, as `block` asks. A container moves no box
     *  positioned against something outside it, nor what that box holds,
     *  so it is not scrolled for one: a box absolute in a `position:
     *  relative` wrapper around a scrolling list scrolled the list as far
     *  as the box was below its top. One fixed to the viewport, or in a
     *  box that is, is moved by no scroll but that of a scroll container
     *  inside that box, so the viewport is not scrolled either, as Chrome
     *  has it: measured where the scroll draws it, a bar fixed `top:
     *  30px` on a page scrolled 500px scrolled the page 30px on. */
    scrollIntoView(arg?: Any): void {
      const block =
        arg && typeof arg === 'object'
          ? str(arg.block ?? 'start')
          : arg === false
            ? 'end'
            : 'start';
      const place = (top: number, height: number, port: number) => {
        if (block === 'center') return top - (port - height) / 2;
        if (block === 'end') return top - (port - height);
        if (block === 'nearest') {
          if (top < 0) return top;
          if (top + height > port) return top + height - port;
          return 0;
        }
        return top;
      };
      for (let at = this.parentElement; at; at = at.parentElement) {
        if (at === document.documentElement) break;
        const s = scrollStateOf(at);
        if (!s || call('scrollMoves', at._id, this._id) !== true) continue;
        const me = docRect(this);
        const port = docRect(at);
        if (!me || !port) return;
        const top = me[1] - (port[1] + s[6]);
        const by = place(top, me[3], s[5]);
        if (by) call('scrollElement', at._id, undefined, s[1] + by);
      }
      if (call('atViewport', this._id) === true) return;
      const r = docRect(this);
      if (!r) return;
      const v = viewport();
      call(
        'scrollTo',
        v.scrollX,
        v.scrollY + place(r[1] - v.scrollY, r[3], v.height),
      );
    }
    /** A shadow root `<Html>` draws, as it draws a declarative one: the
     *  host's boxes are the tree's, with the host's children in its
     *  slots. */
    attachShadow(init: Any): Any {
      const mode = init?.mode;
      if (mode !== 'open' && mode !== 'closed') {
        throw new TypeError(
          `Failed to execute 'attachShadow' on 'Element': The provided value '${String(mode)}' is not a valid enum value of type ShadowRootMode.`,
        );
      }
      return wrap(
        Number(call('attachShadow', this._id, mode, !!init?.delegatesFocus)),
      );
    }
    get shadowRoot(): Any {
      return wrap(Number(call('shadowRoot', this._id)));
    }
    animate(keyframes: Any, options?: Any): Any {
      const effect = new KeyframeEffect(this, keyframes, options);
      const animation = new Animation(effect, documentTimeline);
      if (options && typeof options === 'object' && options.id) {
        animation.id = String(options.id);
      }
      animation.play();
      return animation;
    }
    getAnimations(options?: Any): Any[] {
      return animationsOf(this, !!options?.subtree);
    }
    get nextElementSibling(): Any {
      return wrap(Number(call('next', this._id, 'element')));
    }
    get previousElementSibling(): Any {
      return wrap(Number(call('prev', this._id, 'element')));
    }
    before(...items: Any[]): void {
      childBefore(this, items);
    }
    after(...items: Any[]): void {
      childAfter(this, items);
    }
    replaceWith(...items: Any[]): void {
      childReplace(this, items);
    }
    remove(): void {
      call('remove', this._id);
    }
  }
  Object.defineProperty(Element.prototype, 'nodeType', nodeTypeOf(1));

  // WAI-ARIA's ARIAMixin, which every element has: `role` and each
  // `aria-*` attribute reflected as a nullable string, null where the
  // attribute is absent and null set removing it. github.blog opens a
  // header menu with `toggle.ariaExpanded = "true"; menu.ariaHidden =
  // "false"` and shows it by the attribute, `.dropdown[aria-hidden=true]
  // { visibility: hidden }`: an expando took what the script set, and the
  // menu stayed hidden. The element references (`ariaControlsElements`
  // and the rest) are not here.
  for (const name of [
    'role',
    'ariaAtomic',
    'ariaAutoComplete',
    'ariaBrailleLabel',
    'ariaBrailleRoleDescription',
    'ariaBusy',
    'ariaChecked',
    'ariaColCount',
    'ariaColIndex',
    'ariaColIndexText',
    'ariaColSpan',
    'ariaCurrent',
    'ariaDescription',
    'ariaDisabled',
    'ariaExpanded',
    'ariaHasPopup',
    'ariaHidden',
    'ariaInvalid',
    'ariaKeyShortcuts',
    'ariaLabel',
    'ariaLevel',
    'ariaLive',
    'ariaModal',
    'ariaMultiLine',
    'ariaMultiSelectable',
    'ariaOrientation',
    'ariaPlaceholder',
    'ariaPosInSet',
    'ariaPressed',
    'ariaReadOnly',
    'ariaRelevant',
    'ariaRequired',
    'ariaRoleDescription',
    'ariaRowCount',
    'ariaRowIndex',
    'ariaRowIndexText',
    'ariaRowSpan',
    'ariaSelected',
    'ariaSetSize',
    'ariaSort',
    'ariaValueMax',
    'ariaValueMin',
    'ariaValueNow',
    'ariaValueText',
  ]) {
    const attr = name === 'role' ? name : `aria-${name.slice(4).toLowerCase()}`;
    Object.defineProperty(Element.prototype, name, {
      get(this: Any): string | null {
        return this.getAttribute(attr);
      },
      set(this: Any, v: Any) {
        if (v === null) this.removeAttribute(attr);
        else this.setAttribute(attr, v);
      },
      configurable: true,
    });
  }

  class HTMLElement extends Element {
    /** A custom element's `super()` (HTML 3.2.3, `[HTMLConstructor]`): the
     *  element its upgrade is constructing, or a new one, as its definition
     *  says (`constructCustom`). Anything else is an illegal constructor,
     *  as every interface's here is. */
    constructor() {
      const made = constructCustom(new.target);
      if (!made) super();
      return made;
    }
    attachInternals(): Any {
      return attachInternals(this);
    }
    get style(): Any {
      return (this._style ??= styleOf(this));
    }
    set style(v: Any) {
      this.setAttribute('style', v);
    }
    get dataset(): Any {
      return (this._dataset ??= datasetOf(this));
    }
    // HTML 6.1: `until-found` is a state of its own, and every falsy value
    // but `false` itself takes the attribute off as well
    get hidden(): boolean | string {
      const value = this.getAttribute('hidden');
      if (value === null) return false;
      return value.toLowerCase() === 'until-found' ? 'until-found' : true;
    }
    set hidden(v: Any) {
      if (typeof v === 'string' && v.toLowerCase() === 'until-found') {
        this.setAttribute('hidden', 'until-found');
      } else if (
        v === false ||
        v === '' ||
        v == null ||
        v === 0 ||
        Number.isNaN(v)
      ) {
        this.removeAttribute('hidden');
      } else this.setAttribute('hidden', '');
    }
    get title(): string {
      return this.getAttribute('title') ?? '';
    }
    set title(v: Any) {
      this.setAttribute('title', v);
    }
    get lang(): string {
      return this.getAttribute('lang') ?? '';
    }
    set lang(v: Any) {
      this.setAttribute('lang', v);
    }
    get dir(): string {
      return this.getAttribute('dir') ?? '';
    }
    set dir(v: Any) {
      this.setAttribute('dir', v);
    }
    get tabIndex(): number {
      const t = parseInt(this.getAttribute('tabindex') ?? '', 10);
      return Number.isFinite(t) ? t : -1;
    }
    set tabIndex(v: Any) {
      this.setAttribute('tabindex', String(Math.trunc(Number(v))));
    }
    get accessKey(): string {
      return this.getAttribute('accesskey') ?? '';
    }
    set accessKey(v: Any) {
      this.setAttribute('accesskey', v);
    }
    get draggable(): boolean {
      return this.getAttribute('draggable') === 'true';
    }
    set draggable(v: Any) {
      this.setAttribute('draggable', v ? 'true' : 'false');
    }
    /** The attribute's state (HTML 6.8.1): CodeMirror sets `false` on every
     *  widget it draws, and a page whose script is strict mode code threw
     *  where it could not. */
    get contentEditable(): string {
      const value = this.getAttribute('contenteditable')?.toLowerCase();
      if (value === '' || value === 'true') return 'true';
      return value === 'false' || value === 'plaintext-only'
        ? value
        : 'inherit';
    }
    set contentEditable(v: Any) {
      const value = str(v).toLowerCase();
      if (value === 'inherit') this.removeAttribute('contenteditable');
      else if (
        value === 'true' ||
        value === 'false' ||
        value === 'plaintext-only'
      ) {
        this.setAttribute('contenteditable', value);
      } else {
        throw new DOMException(
          `The value provided ('${str(v)}') is not one of 'true', 'false', 'plaintext-only', or 'inherit'.`,
          'SyntaxError',
        );
      }
    }
    get isContentEditable(): boolean {
      return false;
    }
    get innerText(): string {
      return String(call('text', this._id, 'rendered'));
    }
    set innerText(v: Any) {
      this.textContent = v;
    }
    get outerText(): string {
      return this.innerText;
    }
    set outerText(v: Any) {
      this.replaceWith(document.createTextNode(str(v)));
    }
    // CSSOM View 7: the border box as laid out, which no transform turns
    // or scales, placed from the offset parent's padding edge
    get offsetWidth(): number {
      return rounded(offsetOf(this)?.[3]);
    }
    get offsetHeight(): number {
      return rounded(offsetOf(this)?.[4]);
    }
    get offsetLeft(): number {
      return rounded(offsetOf(this)?.[1]);
    }
    get offsetTop(): number {
      return rounded(offsetOf(this)?.[2]);
    }
    get offsetParent(): Any {
      const r = offsetOf(this);
      return r ? wrap(r[0]) : null;
    }
    focus(): void {
      call('focus', this._id);
    }
    blur(): void {
      if (document.activeElement === this) call('blur');
    }
    click(): void {
      if (isDisabled(this)) return;
      activated(
        this,
        new PointerEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: G,
        }),
      );
    }
  }
  class SVGElement extends Element {
    get style(): Any {
      return (this._style ??= styleOf(this));
    }
    // `[PutForwards=cssText]`, as an HTML element's is
    set style(v: Any) {
      this.style.cssText = v;
    }
    get dataset(): Any {
      return (this._dataset ??= datasetOf(this));
    }
    override get namespaceURI(): string | null {
      return this._ns === undefined ? SVG_NS : this._ns;
    }
    override get tagName(): string {
      return this._name;
    }
  }
  /** An SVG length an element's attribute is (SVG 2, 4.6.10), read from
   *  the attribute each time: nothing animates one here, so its animated
   *  value is its base one. */
  const animatedLength = (el: Any, name: string): Any => {
    const length = (): Any => {
      const raw = el.getAttribute(name) ?? '0';
      const value = parseFloat(raw) || 0;
      return {
        value,
        valueInSpecifiedUnits: value,
        valueAsString: raw,
        unitType: /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?\s*$/i.test(raw)
          ? 1
          : 0,
      };
    };
    return {
      get baseVal(): Any {
        return length();
      },
      get animVal(): Any {
        return length();
      },
    };
  };
  const lengths = (Kind: Any, names: string[]): void => {
    for (const name of names) {
      Object.defineProperty(Kind.prototype, name, {
        get(this: Any) {
          return animatedLength(this, name);
        },
        configurable: true,
      });
    }
  };
  class SVGGraphicsElement extends SVGElement {
    getBBox(): Any {
      const r = this.getBoundingClientRect();
      return new DOMRect(0, 0, r.width, r.height);
    }
  }
  class SVGSVGElement extends SVGGraphicsElement {}
  lengths(SVGSVGElement, ['x', 'y', 'width', 'height']);
  class SVGRectElement extends SVGGraphicsElement {}
  lengths(SVGRectElement, ['x', 'y', 'width', 'height', 'rx', 'ry']);
  class SVGCircleElement extends SVGGraphicsElement {}
  lengths(SVGCircleElement, ['cx', 'cy', 'r']);
  /** Text's: what it holds counted, and nothing measured, since no layout
   *  here sets a drawing's text. */
  class SVGTextContentElement extends SVGGraphicsElement {
    getNumberOfChars(): number {
      return this.textContent.length;
    }
  }
  class SVGTextElement extends SVGTextContentElement {}
  class SVGTSpanElement extends SVGTextContentElement {}
  const SVG_CLASSES: Record<string, Any> = {
    svg: SVGSVGElement,
    rect: SVGRectElement,
    circle: SVGCircleElement,
    text: SVGTextElement,
    tspan: SVGTSpanElement,
    g: SVGGraphicsElement,
    path: SVGGraphicsElement,
    line: SVGGraphicsElement,
    polyline: SVGGraphicsElement,
    polygon: SVGGraphicsElement,
    ellipse: SVGGraphicsElement,
    use: SVGGraphicsElement,
    image: SVGGraphicsElement,
  };
  const SVG_TAGS = new Set([
    'svg',
    'g',
    'path',
    'circle',
    'ellipse',
    'rect',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'use',
    'defs',
    'symbol',
    'lineargradient',
    'radialgradient',
    'stop',
    'clippath',
    'mask',
    'pattern',
    'image',
    'foreignobject',
  ]);

  /** Whether a control is disabled: its own attribute, or a disabled
   *  `<fieldset>` around it. */
  const isDisabled = (el: Any): boolean =>
    FORM_TAGS.has(el._name) && !!call('disabled', el._id);
  const FORM_TAGS = new Set([
    'button',
    'input',
    'select',
    'textarea',
    'optgroup',
    'option',
    'fieldset',
  ]);

  /** A reflected URL: the attribute resolved against the document's base,
   *  as `a.href` and `img.src` read. */
  const urlProperty = (attr: string) => ({
    get(this: Any): string {
      const raw = this.getAttribute(attr);
      return raw === null ? '' : String(call('resolve', raw));
    },
    set(this: Any, v: Any) {
      this.setAttribute(attr, v);
    },
    configurable: true,
  });
  const reflect = (attr: string) => ({
    get(this: Any): string {
      return this.getAttribute(attr) ?? '';
    },
    set(this: Any, v: Any) {
      this.setAttribute(attr, v);
    },
    configurable: true,
  });
  const flag = (attr: string) => ({
    get(this: Any): boolean {
      return this.hasAttribute(attr);
    },
    set(this: Any, v: Any) {
      this.toggleAttribute(attr, !!v);
    },
    configurable: true,
  });

  /** The form a control is in: the one its `form` attribute names, or the
   *  one around it. */
  const formOf = (el: Any): Any => {
    const named = el.getAttribute('form');
    if (named !== null) return document.getElementById(named);
    return el.closest('form');
  };

  /** Where a URL is: its parts, as `location` and `a.pathname` read them. */
  const urlParts = (href: string): Any => {
    const json = call('url', href, '');
    return typeof json === 'string' && json ? JSON.parse(json) : null;
  };
  const URL_PARTS = [
    'protocol',
    'host',
    'hostname',
    'port',
    'pathname',
    'search',
    'hash',
    'origin',
    'username',
    'password',
  ];

  class HTMLAnchorElement extends HTMLElement {
    get text(): string {
      return this.textContent;
    }
    set text(v: Any) {
      this.textContent = v;
    }
    override toString(): string {
      return (this as Any).href;
    }
  }
  Object.defineProperty(
    HTMLAnchorElement.prototype,
    'href',
    urlProperty('href'),
  );
  for (const name of ['target', 'rel', 'download', 'hreflang', 'type']) {
    Object.defineProperty(HTMLAnchorElement.prototype, name, reflect(name));
  }
  // each part but the origin set as well, which sets the `href` to the
  // address with it, and nothing where the link has none (HTML 4.6.6)
  for (const part of URL_PARTS) {
    Object.defineProperty(HTMLAnchorElement.prototype, part, {
      get(this: Any): string {
        return urlParts(this.href)?.[part] ?? '';
      },
      ...(part !== 'origin' && {
        set(this: Any, v: Any) {
          const json = call('setUrl', this.href, part, str(v));
          if (typeof json === 'string' && json) {
            this.href = JSON.parse(json).href;
          }
        },
      }),
      configurable: true,
    });
  }
  class HTMLAreaElement extends HTMLAnchorElement {}

  /** An image's width or height: as it is drawn, in the document; as its
   *  style says, in a frame's, which nothing here draws; and its
   *  attribute's elsewhere (HTML 4.8.4.3.15, the `width` IDL attribute). */
  const imageSize = (img: Any, side: 'width' | 'height'): number => {
    const doc = img.ownerDocument;
    if (doc === document && img.isConnected) {
      return side === 'width' ? img.offsetWidth : img.offsetHeight;
    }
    if (doc && doc !== document && img.getRootNode() === doc) {
      const style = getComputedStyle(img);
      const px = /^([\d.]+)px$/.exec(style?.[side] ?? '');
      if (px) return Math.round(Number(px[1]));
    }
    return Number(img.getAttribute(side)) >>> 0;
  };
  class HTMLImageElement extends HTMLElement {
    get complete(): boolean {
      return true;
    }
    get naturalWidth(): number {
      return this.offsetWidth;
    }
    get naturalHeight(): number {
      return this.offsetHeight;
    }
    get width(): number {
      return imageSize(this, 'width');
    }
    set width(v: Any) {
      this.setAttribute('width', v);
    }
    get height(): number {
      return imageSize(this, 'height');
    }
    set height(v: Any) {
      this.setAttribute('height', v);
    }
    get currentSrc(): string {
      return (this as Any).src;
    }
    decode(): Promise<void> {
      return Promise.resolve();
    }
  }
  Object.defineProperty(HTMLImageElement.prototype, 'src', urlProperty('src'));
  for (const name of ['alt', 'srcset', 'sizes', 'loading', 'decoding']) {
    Object.defineProperty(HTMLImageElement.prototype, name, reflect(name));
  }

  class HTMLScriptElement extends HTMLElement {
    get text(): string {
      return this.textContent;
    }
    set text(v: Any) {
      this.textContent = v;
    }
  }
  Object.defineProperty(HTMLScriptElement.prototype, 'src', urlProperty('src'));
  for (const name of ['type', 'charset', 'crossOrigin', 'integrity']) {
    Object.defineProperty(HTMLScriptElement.prototype, name, reflect(name));
  }
  for (const name of ['async', 'defer', 'noModule']) {
    Object.defineProperty(
      HTMLScriptElement.prototype,
      name,
      flag(name.toLowerCase()),
    );
  }

  class HTMLLinkElement extends HTMLElement {}
  Object.defineProperty(HTMLLinkElement.prototype, 'href', urlProperty('href'));
  for (const name of ['rel', 'media', 'type', 'as']) {
    Object.defineProperty(HTMLLinkElement.prototype, name, reflect(name));
  }

  class HTMLTemplateElement extends HTMLElement {
    get content(): Any {
      return wrap(Number(call('content', this._id)));
    }
  }

  class HTMLDetailsElement extends HTMLElement {}
  Object.defineProperty(HTMLDetailsElement.prototype, 'open', flag('open'));
  // A dialog (HTML 4.11.4). Whether one is modal is the host's (`modal`):
  // `:modal` reads it, the cascade puts the dialog in the top layer for it,
  // and taking the dialog out of the document ends it there. What is the
  // page's is here — its return value, what had the focus before it was
  // shown, its events, and the order the modal ones were opened in, which
  // Escape closes the last of (`closeRequest`).
  interface DialogState {
    returnValue: string;
    /** What had the focus as it was shown, given it back as it closes. */
    previous: Any;
    /** The state its pending `toggle` started from, while one is. */
    toggleFrom: string | null;
  }
  const dialogStates = new WeakMap<Any, DialogState>();
  const dialogState = (el: Any): DialogState => {
    let state = dialogStates.get(el);
    if (!state) {
      state = { returnValue: '', previous: null, toggleFrom: null };
      dialogStates.set(el, state);
    }
    return state;
  };
  /** The modal dialogs, in the order they were opened: the last one the
   *  host still says is modal is the top layer's top. */
  const modalDialogs: Any[] = [];
  const isModalDialog = (el: Any): boolean => call('modal', el._id) === true;
  /** `beforetoggle`, as it opens (cancelable) or closes (not). Whether it
   *  was not cancelled. */
  const beforeToggle = (el: Any, from: string, to: string): boolean => {
    const ev = new ToggleEvent('beforetoggle', {
      cancelable: to === 'open',
      oldState: from,
      newState: to,
    });
    ev.isTrusted = true;
    return dispatch(el, ev);
  };
  /** `toggle`, in a task of its own, one for any number of changes before
   *  it runs, from the state the first started from (HTML 4.11.4.1,
   *  "queue a dialog toggle event task"). */
  const queueToggle = (el: Any, from: string): void => {
    const state = dialogState(el);
    if (state.toggleFrom !== null) return;
    state.toggleFrom = from;
    setTimer(
      () => {
        const old = state.toggleFrom ?? from;
        state.toggleFrom = null;
        const now = el.hasAttribute('open') ? 'open' : 'closed';
        const ev = new ToggleEvent('toggle', { oldState: old, newState: now });
        ev.isTrusted = true;
        dispatch(el, ev);
      },
      0,
      [],
      false,
    );
  };
  /** What can take the focus in a dialog that has nothing `autofocus`. */
  const FOCUSABLE_IN_DIALOG =
    'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),iframe,summary,[tabindex],[contenteditable]:not([contenteditable=false])';
  /** HTML 4.11.4.2, "dialog focusing steps": the dialog where it is
   *  `autofocus`, else the first focusable area in it with `autofocus`,
   *  else the first, else the dialog. */
  const focusDialog = (el: Any): void => {
    let control: Any = el.hasAttribute('autofocus') ? el : null;
    if (!control) {
      const found = Array.from(el.querySelectorAll(FOCUSABLE_IN_DIALOG));
      control =
        found.find((c: Any) => c.hasAttribute('autofocus')) ?? found[0] ?? el;
    }
    control.focus();
  };
  /** HTML 4.11.4.2, "close the dialog": not drawn, not modal, the focus
   *  given back, and `close` told in a task of its own. */
  const closeDialog = (el: Any, result: string | null): void => {
    if (!el.hasAttribute('open')) return;
    beforeToggle(el, 'open', 'closed');
    if (!el.hasAttribute('open')) return;
    queueToggle(el, 'open');
    el.removeAttribute('open');
    const wasModal = isModalDialog(el);
    if (wasModal) {
      call('modal', el._id, false);
      const i = modalDialogs.indexOf(el);
      if (i >= 0) modalDialogs.splice(i, 1);
    }
    const state = dialogState(el);
    if (result !== null) state.returnValue = result;
    const previous = state.previous;
    state.previous = null;
    if (previous?.isConnected && previous !== el) {
      const active = document.activeElement;
      if (wasModal || (active && el.contains(active))) previous.focus();
    }
    setTimer(
      () => {
        const ev = new Event('close');
        ev.isTrusted = true;
        dispatch(el, ev);
      },
      0,
      [],
      false,
    );
  };
  /** A close request (HTML 7.7.2) — Escape, not cancelled — at the top
   *  modal dialog: `cancel`, which a page may cancel, and then closed. A
   *  browser groups the dialogs opened with no press between them, and one
   *  Escape closes them all; this closes one at a time. */
  const closeRequest = (): void => {
    while (modalDialogs.length) {
      const top = modalDialogs[modalDialogs.length - 1];
      if (isModalDialog(top)) {
        requestClose(top, null);
        return;
      }
      modalDialogs.pop();
    }
  };
  const requestClose = (el: Any, result: string | null): void => {
    if (!el.hasAttribute('open')) return;
    const ev = new Event('cancel', { cancelable: true });
    ev.isTrusted = true;
    if (!dispatch(el, ev)) return;
    closeDialog(el, result);
  };
  class HTMLDialogElement extends HTMLElement {
    get returnValue(): string {
      return dialogState(this).returnValue;
    }
    set returnValue(v: Any) {
      dialogState(this).returnValue = String(v);
    }
    show(): void {
      if (this.hasAttribute('open')) {
        if (!isModalDialog(this)) return;
        throw new DOMException(
          "Failed to execute 'show' on 'HTMLDialogElement': The dialog is already open as a modal dialog, and therefore cannot be opened as a non-modal dialog.",
          'InvalidStateError',
        );
      }
      if (!beforeToggle(this, 'closed', 'open')) return;
      if (this.hasAttribute('open')) return;
      queueToggle(this, 'closed');
      this.setAttribute('open', '');
      dialogState(this).previous = document.activeElement;
      focusDialog(this);
    }
    showModal(): void {
      if (this.hasAttribute('open')) {
        if (isModalDialog(this)) return;
        throw new DOMException(
          "Failed to execute 'showModal' on 'HTMLDialogElement': The dialog is already open as a non-modal dialog, and therefore cannot be opened as a modal dialog.",
          'InvalidStateError',
        );
      }
      if (!this.isConnected) {
        throw new DOMException(
          "Failed to execute 'showModal' on 'HTMLDialogElement': The element is not in a Document.",
          'InvalidStateError',
        );
      }
      if (!beforeToggle(this, 'closed', 'open')) return;
      if (this.hasAttribute('open') || !this.isConnected) return;
      queueToggle(this, 'closed');
      this.setAttribute('open', '');
      call('modal', this._id, true);
      // last, where one taken out of the document and put back was before
      const was = modalDialogs.indexOf(this);
      if (was >= 0) modalDialogs.splice(was, 1);
      modalDialogs.push(this);
      dialogState(this).previous = document.activeElement;
      focusDialog(this);
    }
    close(result?: Any): void {
      closeDialog(this, result === undefined ? null : String(result));
    }
    requestClose(result?: Any): void {
      requestClose(this, result === undefined ? null : String(result));
    }
  }
  Object.defineProperty(HTMLDialogElement.prototype, 'open', flag('open'));

  class HTMLLabelElement extends HTMLElement {
    get htmlFor(): string {
      return this.getAttribute('for') ?? '';
    }
    set htmlFor(v: Any) {
      this.setAttribute('for', v);
    }
    get control(): Any {
      const id = this.getAttribute('for');
      if (id !== null) return document.getElementById(id);
      return this.querySelector(
        'button,input:not([type=hidden]),select,textarea',
      );
    }
    get form(): Any {
      return this.control?.form ?? null;
    }
  }

  /** What every form control has: its form, its name, whether it is
   *  disabled, and HTML's validity, a little of it. */
  class FormControl extends HTMLElement {
    // reflected from attributes, on the prototype below
    declare name: string;
    declare disabled: boolean;
    declare required: boolean;
    get form(): Any {
      return formOf(this);
    }
    get labels(): Any {
      const id = this.id;
      const out: Any[] = id
        ? Array.from(document.querySelectorAll(`label[for="${cssEscape(id)}"]`))
        : [];
      const around = this.closest('label');
      if (around && !out.includes(around)) out.push(around);
      return list(out);
    }
    get willValidate(): boolean {
      return !isDisabled(this);
    }
    get validationMessage(): string {
      return '';
    }
    get validity(): Any {
      return { valid: this.checkValidity() };
    }
    checkValidity(): boolean {
      return !(
        this.hasAttribute('required') &&
        (this as Any).value === '' &&
        !isDisabled(this)
      );
    }
    reportValidity(): boolean {
      return this.checkValidity();
    }
    setCustomValidity(): void {}
  }
  for (const name of ['name', 'autocomplete']) {
    Object.defineProperty(FormControl.prototype, name, reflect(name));
  }
  for (const name of ['disabled', 'required', 'autofocus']) {
    Object.defineProperty(FormControl.prototype, name, flag(name));
  }

  /** A control's value, as the widget holds it. */
  const controlValue = (el: Any): Any => call('value', el._id);

  class HTMLInputElement extends FormControl {
    get type(): string {
      const t = (this.getAttribute('type') ?? '').toLowerCase();
      return INPUT_TYPES.has(t) ? t : 'text';
    }
    set type(v: Any) {
      this.setAttribute('type', v);
    }
    // HTML 4.10.5.4's value modes: the attribute for a box and a radio
    // ("default/on") and for what is no field ("default"), nothing for a
    // file, and what was typed for the rest ("value")
    get value(): string {
      const type = this.type;
      if (type === 'checkbox' || type === 'radio') {
        return this.getAttribute('value') ?? 'on';
      }
      if (DEFAULT_MODE.has(type)) return this.getAttribute('value') ?? '';
      if (type === 'file') return '';
      const v = controlValue(this);
      return typeof v === 'string' ? v : (this.getAttribute('value') ?? '');
    }
    set value(v: Any) {
      const type = this.type;
      if (type === 'checkbox' || type === 'radio' || DEFAULT_MODE.has(type)) {
        this.setAttribute('value', v === null ? '' : v);
      } else if (type !== 'file') {
        call('setValue', this._id, v === null ? '' : str(v));
      }
    }
    get valueAsNumber(): number {
      return this.value === '' ? NaN : Number(this.value);
    }
    set valueAsNumber(v: number) {
      this.value = String(v);
    }
    get defaultValue(): string {
      return this.getAttribute('value') ?? '';
    }
    set defaultValue(v: Any) {
      this.setAttribute('value', v);
    }
    get checked(): boolean {
      return controlValue(this) === true;
    }
    set checked(v: Any) {
      call('setValue', this._id, !!v);
    }
    get defaultChecked(): boolean {
      return this.hasAttribute('checked');
    }
    set defaultChecked(v: Any) {
      this.toggleAttribute('checked', !!v);
    }
    get indeterminate(): boolean {
      return false;
    }
    set indeterminate(_v: Any) {}
    get files(): Any {
      return list([]);
    }
    select(): void {}
    setSelectionRange(): void {}
    setRangeText(): void {}
    // the caret is the widget's, as `setSelectionRange` leaves it
    get selectionStart(): number {
      return this.value.length;
    }
    set selectionStart(_v: Any) {}
    get selectionEnd(): number {
      return this.value.length;
    }
    set selectionEnd(_v: Any) {}
    stepUp(): void {}
    stepDown(): void {}
    showPicker(): void {}
  }
  for (const name of [
    'placeholder',
    'min',
    'max',
    'step',
    'pattern',
    'accept',
    'alt',
    'inputMode',
    'size',
  ]) {
    Object.defineProperty(
      HTMLInputElement.prototype,
      name,
      reflect(name.toLowerCase()),
    );
  }
  for (const name of ['readOnly', 'multiple']) {
    Object.defineProperty(
      HTMLInputElement.prototype,
      name,
      flag(name.toLowerCase()),
    );
  }
  Object.defineProperty(HTMLInputElement.prototype, 'maxLength', {
    get(this: Any): number {
      const n = parseInt(this.getAttribute('maxlength') ?? '', 10);
      return Number.isFinite(n) ? n : -1;
    },
    set(this: Any, v: Any) {
      this.setAttribute('maxlength', String(v));
    },
  });
  const DEFAULT_MODE = new Set([
    'hidden',
    'submit',
    'image',
    'reset',
    'button',
  ]);
  const INPUT_TYPES = new Set([
    'hidden',
    'text',
    'search',
    'tel',
    'url',
    'email',
    'password',
    'date',
    'month',
    'week',
    'time',
    'datetime-local',
    'number',
    'range',
    'color',
    'checkbox',
    'radio',
    'file',
    'submit',
    'image',
    'reset',
    'button',
  ]);

  class HTMLTextAreaElement extends FormControl {
    get type(): string {
      return 'textarea';
    }
    get value(): string {
      const v = controlValue(this);
      return typeof v === 'string' ? v : this.textContent;
    }
    set value(v: Any) {
      call('setValue', this._id, v === null ? '' : str(v));
    }
    get defaultValue(): string {
      return this.textContent;
    }
    set defaultValue(v: Any) {
      this.textContent = v;
    }
    get textLength(): number {
      return this.value.length;
    }
    select(): void {}
    setSelectionRange(): void {}
  }
  for (const name of ['placeholder', 'rows', 'cols', 'wrap']) {
    Object.defineProperty(HTMLTextAreaElement.prototype, name, reflect(name));
  }
  Object.defineProperty(
    HTMLTextAreaElement.prototype,
    'readOnly',
    flag('readonly'),
  );

  class HTMLOptionElement extends HTMLElement {
    get value(): string {
      return this.getAttribute('value') ?? this.text;
    }
    set value(v: Any) {
      this.setAttribute('value', v);
    }
    get text(): string {
      return this.textContent.replace(/[\t\n\f\r ]+/g, ' ').trim();
    }
    set text(v: Any) {
      this.textContent = v;
    }
    get label(): string {
      return this.getAttribute('label') ?? this.text;
    }
    set label(v: Any) {
      this.setAttribute('label', v);
    }
    get selected(): boolean {
      const select = this.closest('select');
      return select
        ? select.selectedOptions.includes(this)
        : this.hasAttribute('selected');
    }
    set selected(v: Any) {
      const select = this.closest('select');
      if (v && select) select.value = this.value;
      else this.toggleAttribute('selected', !!v);
    }
    get defaultSelected(): boolean {
      return this.hasAttribute('selected');
    }
    set defaultSelected(v: Any) {
      this.toggleAttribute('selected', !!v);
    }
    get index(): number {
      const select = this.closest('select');
      return select ? Array.from(select.options).indexOf(this) : 0;
    }
    get form(): Any {
      return this.closest('select')?.form ?? null;
    }
  }
  Object.defineProperty(
    HTMLOptionElement.prototype,
    'disabled',
    flag('disabled'),
  );

  class HTMLSelectElement extends FormControl {
    declare multiple: boolean;
    get type(): string {
      return this.hasAttribute('multiple') ? 'select-multiple' : 'select-one';
    }
    get options(): Any {
      const options = Array.from(this.querySelectorAll('option'));
      const out: Any = list(options);
      out.selectedIndex = this.selectedIndex;
      out.add = (option: Any, before?: Any) =>
        this.insertBefore(option, before ?? null);
      out.remove = (i: number) => (options[i] as Any)?.remove();
      return out;
    }
    get length(): number {
      return this.options.length;
    }
    get value(): string {
      return this.selectedOptions[0]?.value ?? '';
    }
    set value(v: Any) {
      call('setValue', this._id, str(v));
    }
    /** The options chosen: those `selected`, as `<Html>` keeps them, and
     *  in a list of one the last of those, or else the first that can be
     *  (HTML 4.10.7, "selectedness setting algorithm"). */
    get selectedOptions(): Any {
      const options = Array.from(this.querySelectorAll('option')) as Any[];
      const marked = options.filter((o) => o.hasAttribute('selected'));
      if (this.multiple) return list(marked);
      const chosen =
        marked[marked.length - 1] ??
        (Number(this.getAttribute('size')) > 1
          ? null
          : options.find((o) => !o.disabled));
      return list(chosen ? [chosen] : []);
    }
    get selectedIndex(): number {
      const options = Array.from(this.querySelectorAll('option')) as Any[];
      return options.indexOf(this.selectedOptions[0]);
    }
    set selectedIndex(i: number) {
      const options = Array.from(this.querySelectorAll('option')) as Any[];
      const option = options[i];
      if (option) this.value = option.value;
      else for (const o of options) o.removeAttribute('selected');
    }
    item(i: number): Any {
      return this.options[i] ?? null;
    }
    add(option: Any, before?: Any): void {
      this.insertBefore(
        option,
        typeof before === 'number' ? this.options[before] : (before ?? null),
      );
    }
  }
  Object.defineProperty(
    HTMLSelectElement.prototype,
    'multiple',
    flag('multiple'),
  );

  class HTMLButtonElement extends FormControl {
    get type(): string {
      const t = (this.getAttribute('type') ?? '').toLowerCase();
      return t === 'reset' || t === 'button' ? t : 'submit';
    }
    set type(v: Any) {
      this.setAttribute('type', v);
    }
    get value(): string {
      return this.getAttribute('value') ?? '';
    }
    set value(v: Any) {
      this.setAttribute('value', v);
    }
  }

  class HTMLFieldSetElement extends FormControl {
    get elements(): Any {
      return list(Array.from(this.querySelectorAll(CONTROLS)));
    }
  }

  const CONTROLS = 'button,fieldset,input,object,output,select,textarea';

  class HTMLFormElement extends HTMLElement {
    /** The controls the form owns: those in it, and those in its tree
     *  that name it by its `form` attribute, in tree order — an image
     *  button not among them (HTML 4.10.18.1). */
    get elements(): Any {
      const root = this.getRootNode();
      const scope = root.querySelectorAll ? root : this;
      const own = (
        Array.from(scope.querySelectorAll(CONTROLS)) as Any[]
      ).filter(
        (el) =>
          el.form === this &&
          !(el.localName === 'input' && el.type === 'image'),
      );
      return collection(own);
    }
    get length(): number {
      return this.elements.length;
    }
    get action(): string {
      const raw = this.getAttribute('action');
      return raw ? String(call('resolve', raw)) : String(call('location'));
    }
    set action(v: Any) {
      this.setAttribute('action', v);
    }
    get method(): string {
      return (this.getAttribute('method') ?? '').toLowerCase() === 'post'
        ? 'post'
        : 'get';
    }
    set method(v: Any) {
      this.setAttribute('method', v);
    }
    submit(): void {
      call('submit', this._id, 0);
    }
    requestSubmit(submitter?: Any): void {
      const id = submitter ? idOf(submitter) : 0;
      if (!call('validate', this._id, id)) return;
      const ev = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter: submitter ?? null,
      });
      ev.isTrusted = true;
      if (dispatch(this, ev)) call('submit', this._id, id);
    }
    reset(): void {
      const ev = new Event('reset', { bubbles: true, cancelable: true });
      ev.isTrusted = true;
      if (dispatch(this, ev)) call('reset', this._id);
    }
    checkValidity(): boolean {
      return this.elements.every((el: Any) => el.checkValidity?.() ?? true);
    }
    reportValidity(): boolean {
      return !!call('validate', this._id, 0);
    }
  }
  for (const name of ['name', 'target', 'enctype', 'autocomplete']) {
    Object.defineProperty(HTMLFormElement.prototype, name, reflect(name));
  }
  Object.defineProperty(
    HTMLFormElement.prototype,
    'noValidate',
    flag('novalidate'),
  );

  /** A frame's document, the page's own origin's, and null for another's
   *  (`frameDocument`). */
  const frameDocumentOf = (frame: Any): Any => {
    const id = Number(call('frameDocument', frame._id));
    return id ? wrap(id) : null;
  };

  // --- a frame's window ------------------------------------------------------
  //
  // What `contentWindow` hands out is a WindowProxy (HTML 7.2.3): one for
  // the frame, whatever it has gone on to, which is the window of the
  // document it holds now — so a page that keeps it, as Sandpack does
  // before it sends the frame to its bundler, still has it — and is there
  // for another origin's frame too, with only what HTML lets a page reach
  // across origins: `location` to send it somewhere, `postMessage`, and the
  // window's relations. A frame has no realm of its own here, so its window
  // holds the page's own globals as they were before any page code ran
  // (`realmGlobals`): Contentsquare builds what it calls its pure window
  // from a hidden frame's `RegExp`, `JSON` and `Node.prototype`, and Sentry
  // takes `fetch` from one, for versions the page has not wrapped.

  /** The globals a frame's window shares with the page: everything the
   *  facade defined as a value, before any page code ran, but what is the
   *  window's own (`OWN_PER_WINDOW`). Taken at the end of `installDom`. */
  let realmGlobals: [string, Any][] = [];
  const OWN_PER_WINDOW = new Set([
    'window',
    'self',
    'frames',
    'globalThis',
    'top',
    'parent',
    'opener',
    'frameElement',
    'document',
    'location',
    'history',
    'visualViewport',
    'scrollTo',
    'scroll',
    'scrollBy',
    'postMessage',
    'addEventListener',
    'removeEventListener',
    'dispatchEvent',
  ]);
  const crossOrigin = (): Any =>
    new DOMException(
      `Blocked a frame with origin "${location.origin}" from accessing a cross-origin frame.`,
      'SecurityError',
    );
  /** The window each frame's document has (HTML 7.2.2), made as it is
   *  first reached. */
  const frameWindows = new WeakMap<object, Any>();
  /** Each frame's WindowProxy, and the frame each is of. */
  const frameProxies = new WeakMap<object, Any>();
  const proxiedFrames = new WeakMap<object, Any>();
  /** The window a document is the document of: the page's, a frame's
   *  where it is the frame's document now, and none for any other. */
  const windowOfDocument = (doc: Any): Any => {
    if (doc === document) return G;
    const frame = wrap(Number(call('frameElement', doc._id)));
    return frame && frameDocumentOf(frame) === doc ? frameProxyOf(frame) : null;
  };
  /** The window of a frame's document: the realm's globals, and its own
   *  document, place, events and size. */
  const frameWindowOf = (doc: Any, frame: Any): Any => {
    let win = frameWindows.get(doc);
    if (win) return win;
    const proxy = frameProxyOf(frame);
    const target = new EventTarget();
    win = Object.create(Window.prototype);
    for (const [name, value] of realmGlobals) {
      Object.defineProperty(win, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    const size = (): number[] =>
      String(call('frameSize', doc._id)).split(' ').map(Number);
    const own: Record<string, () => Any> = {
      window: () => proxy,
      self: () => proxy,
      frames: () => proxy,
      globalThis: () => proxy,
      parent: () => windowOfDocument(frame.ownerDocument) ?? proxy,
      top: () => G,
      opener: () => null,
      frameElement: () => frame,
      document: () => doc,
      closed: () => false,
      length: () => 0,
      innerWidth: () => size()[0],
      innerHeight: () => size()[1],
      outerWidth: () => size()[0],
      outerHeight: () => size()[1],
      scrollX: () => 0,
      scrollY: () => 0,
      pageXOffset: () => 0,
      pageYOffset: () => 0,
      devicePixelRatio: () => viewport().dpr,
    };
    for (const [name, get] of Object.entries(own)) {
      Object.defineProperty(win, name, {
        get,
        configurable: true,
        enumerable: false,
      });
    }
    // `location` set is a navigation, as the page's is
    Object.defineProperty(win, 'location', {
      get: () => frameLocationOf(frame),
      set: (v: Any) => {
        frameLocationOf(frame).href = v;
      },
      configurable: true,
      enumerable: true,
    });
    let name = frame.getAttribute('name') ?? '';
    Object.defineProperty(win, 'name', {
      get: () => name,
      set: (v: Any) => {
        name = str(v);
      },
      configurable: true,
    });
    const methods: Record<string, Any> = {
      addEventListener: (type: Any, fn: Any, options?: Any) =>
        target.addEventListener(type, fn, options),
      removeEventListener: (type: Any, fn: Any, options?: Any) =>
        target.removeEventListener(type, fn, options),
      dispatchEvent: (event: Any) => {
        if (!(event instanceof Event)) throw new TypeError('not an Event');
        event.isTrusted = false;
        return dispatch(target, event);
      },
      postMessage: (message: Any, options?: Any) =>
        postTo(target, message, options),
      scrollTo() {},
      scroll() {},
      scrollBy() {},
    };
    for (const [key, value] of Object.entries(methods)) {
      Object.defineProperty(win, key, {
        value,
        writable: true,
        configurable: true,
      });
    }
    for (const type of ['load', 'error', 'message', 'resize', 'unload']) {
      Object.defineProperty(win, `on${type}`, {
        get: () => target._handlers[type] ?? null,
        set: (fn: Any) => {
          target._handlers[type] = typeof fn === 'function' ? fn : null;
        },
        configurable: true,
      });
    }
    Object.defineProperty(win, Symbol.toStringTag, {
      value: 'Window',
      configurable: true,
    });
    frameWindows.set(doc, win);
    return win;
  };
  /** What a page may reach of another origin's window (HTML 7.2.3.1,
   *  CrossOriginProperties), and nothing else. */
  const crossOriginWindow = (frame: Any, proxy: Any): Any => ({
    window: proxy,
    self: proxy,
    frames: proxy,
    get location() {
      return frameLocationOf(frame);
    },
    set location(v: Any) {
      frameLocationOf(frame).href = v;
    },
    get parent() {
      return windowOfDocument(frame.ownerDocument) ?? proxy;
    },
    top: G,
    opener: null,
    closed: false,
    length: 0,
    close() {},
    focus() {},
    blur() {},
    // nothing of another origin's runs here, so nothing hears it
    postMessage() {},
  });
  /** A frame's WindowProxy: the window of the document it holds now where
   *  that is the page's origin's, and else what may be reached across
   *  origins, the rest of it a `SecurityError`. */
  /**
   * The frames whose documents the browser runs in realms of their own
   * (`ScriptEngine.link`), by the frame element's id: each one's global,
   * which the frame's window here is while it is linked — a same-origin
   * frame's window, as a browser's is, its `document` the one its own
   * scripts write to.
   */
  const linkedFrames = new Map<number, Any>();
  /** Where this realm is a frame's: the global of the realm it is in, the
   *  window that stands for that here, and its frame's id there. */
  let parentLink: { global: Any; window: Any; frame: number } | null = null;
  /** A message posted to another page realm's window (`__message`), where
   *  it is cloned and told with the window that stands for this one there:
   *  `from` is 0 for a frame's parent, or this realm's frame there. */
  const deliverInto =
    (global: Any, from: number) =>
    (message: Any, options?: Any): void => {
      // the origin a message is meant for is the window's it is posted to
      // (HTML 9.4.3), which another origin's frame is not this one's
      if (!originAllowed(options, str(global.__origin()))) return;
      global.__message(message, location.origin, from);
    };
  /** The frames whose realms are another origin's (`__linkFrame`): what is
   *  reached of their windows is what crosses origins, and no more. */
  const crossLinked = new Set<number>();
  const frameProxyOf = (frame: Any): Any => {
    let proxy = frameProxies.get(frame);
    if (proxy) return proxy;
    const current = (): Any => {
      if (crossLinked.has(frame._id)) return null;
      const linked = linkedFrames.get(frame._id);
      if (linked) return linked;
      const doc = frameDocumentOf(frame);
      return doc ? frameWindowOf(doc, frame) : null;
    };
    let cross: Any = null;
    const across = (): Any => (cross ??= crossOriginWindow(frame, proxy));
    // what a cross-origin window answers undefined to rather than throwing,
    // so that `await` and `instanceof` do not (HTML 7.2.3.3)
    const silent = (key: PropertyKey): boolean =>
      key === 'then' ||
      key === Symbol.toStringTag ||
      key === Symbol.hasInstance ||
      key === Symbol.isConcatSpreadable;
    proxy = new Proxy(
      {},
      {
        get(_t, key) {
          const linked = linkedFrames.get(frame._id);
          if (linked && key === 'postMessage') return deliverInto(linked, 0);
          const win = current();
          if (win) return Reflect.get(win, key, win);
          const others = across();
          if (Object.prototype.hasOwnProperty.call(others, key)) {
            return others[key as string];
          }
          if (silent(key)) return undefined;
          throw crossOrigin();
        },
        set(_t, key, value) {
          const win = current();
          if (win) return Reflect.set(win, key, value, win);
          if (key !== 'location') throw crossOrigin();
          across().location = value;
          return true;
        },
        has(_t, key) {
          const win = current();
          return win ? key in win : key in across();
        },
        ownKeys() {
          const win = current();
          return Reflect.ownKeys(win ?? across());
        },
        // every property a configurable one, since the target holds none
        // of them and a proxy may not say otherwise of one it does not hold
        getOwnPropertyDescriptor(_t, key) {
          const win = current();
          const found = Reflect.getOwnPropertyDescriptor(win ?? across(), key);
          if (found) found.configurable = true;
          else if (!win && !silent(key)) throw crossOrigin();
          return found;
        },
        defineProperty(_t, key, descriptor) {
          const win = current();
          if (!win) throw crossOrigin();
          return Reflect.defineProperty(win, key, {
            ...descriptor,
            configurable: true,
          });
        },
        deleteProperty(_t, key) {
          const win = current();
          if (!win) throw crossOrigin();
          return Reflect.deleteProperty(win, key);
        },
        getPrototypeOf() {
          const win = current();
          return win ? Object.getPrototypeOf(win) : null;
        },
        setPrototypeOf(_t, proto) {
          const win = current();
          return (win ? Object.getPrototypeOf(win) : null) === proto;
        },
        preventExtensions() {
          return false;
        },
      },
    );
    frameProxies.set(frame, proxy);
    proxiedFrames.set(proxy, frame);
    return proxy;
  };
  /** Each frame's `location`: where its document is from, and a way to
   *  send it elsewhere, which the page may do of any frame (HTML 7.10.1) —
   *  only reading it is its origin's. */
  const frameLocations = new WeakMap<object, Any>();
  const frameLocationOf = (frame: Any): Any => {
    let loc = frameLocations.get(frame);
    if (loc) return loc;
    const at = (): string => {
      if (!frameDocumentOf(frame)) throw crossOrigin();
      return String(call('frameLocation', frame._id));
    };
    const go = (url: Any): void => {
      call('frameNavigate', frame._id, String(call('resolve', str(url))));
    };
    loc = Object.create(Object.getPrototypeOf(location), {
      href: {
        get: at,
        set: go,
        enumerable: true,
      },
      assign: {
        value(url: Any) {
          at();
          go(url);
        },
      },
      replace: { value: go },
      reload: {
        value() {
          go(at());
        },
      },
      toString: {
        value(): string {
          return at();
        },
      },
    });
    for (const part of URL_PARTS) {
      Object.defineProperty(loc, part, {
        get(): string {
          return urlParts(at())?.[part] ?? '';
        },
        set(v: Any) {
          const url = new URL(at());
          (url as Any)[part] = v;
          go(url.href);
        },
        enumerable: true,
      });
    }
    frameLocations.set(frame, loc);
    return loc;
  };
  class HTMLIFrameElement extends HTMLElement {
    get contentDocument(): Any {
      if (!this.isConnected) return null;
      // another origin's document is none of this one's to read
      if (crossLinked.has(this._id)) return null;
      const linked = linkedFrames.get(this._id);
      return linked ? linked.document : frameDocumentOf(this);
    }
    get contentWindow(): Any {
      return this.isConnected ? frameProxyOf(this) : null;
    }
    /** SVG 1.1's `GetSVGDocument`, which every engine kept: the document
     *  the frame holds. */
    getSVGDocument(): Any {
      return this.contentDocument;
    }
  }
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', urlProperty('src'));
  for (const name of [
    'srcdoc',
    'name',
    'width',
    'height',
    'allow',
    'loading',
    'referrerPolicy',
  ]) {
    Object.defineProperty(
      HTMLIFrameElement.prototype,
      name,
      reflect(name === 'referrerPolicy' ? 'referrerpolicy' : name),
    );
  }
  // --- <canvas> --------------------------------------------------------------

  /** Pixels a page holds: straight RGBA, as a canvas reads them out. */
  class ImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace = 'srgb';
    constructor(a: Any, b: Any, c?: Any) {
      if (a instanceof Uint8ClampedArray) {
        const width = Number(b) >>> 0;
        if (!width || a.length % (4 * width)) {
          throw new DOMException(
            "Failed to construct 'ImageData': The input data length is not a multiple of (4 * width).",
            'IndexSizeError',
          );
        }
        const height = a.length / (4 * width);
        if (c !== undefined && Number(c) >>> 0 !== height) {
          throw new DOMException(
            "Failed to construct 'ImageData': The input data length is not equal to (4 * width * height).",
            'IndexSizeError',
          );
        }
        this.data = a;
        this.width = width;
        this.height = height;
      } else {
        const width = Math.abs(Math.trunc(Number(a)));
        const height = Math.abs(Math.trunc(Number(b)));
        if (!width || !height) {
          throw new DOMException(
            `Failed to construct 'ImageData': The source ${width ? 'height' : 'width'} is zero or not a number.`,
            'IndexSizeError',
          );
        }
        this.data = new Uint8ClampedArray(width * height * 4);
        this.width = width;
        this.height = height;
      }
    }
  }

  /** WebGL's interfaces and a canvas's context of it (`webgl.ts`). */
  const WEBGL = webgl(Event);

  /**
   * What a 2d canvas holds: its bitmap, straight RGBA, in this realm, so
   * that what a page reads back is what it wrote, at once; and the part of
   * it that changed since the host last had it, which goes to the host once
   * a task (`flushCanvases`) for the browser to draw over the canvas's box,
   * as the tree's changes go to `<Html>` once a task.
   */
  interface CanvasState {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    /** What changed, as x0, y0, x1, y1, or null. */
    dirty: number[] | null;
    context: Any;
    /** The kind of context it has, where it has one. */
    kind: string | null;
  }
  const canvases = new WeakMap<object, CanvasState>();
  const dirtyCanvases = new Set<Any>();
  let canvasFlush = false;
  /** A canvas's `width` or `height` attribute (HTML 4.12.5): a valid
   *  non-negative integer, or its default. */
  const canvasSize = (canvas: Any, name: string, fallback: number): number => {
    const v = canvas.getAttribute(name);
    const m = v === null ? null : /^[\t\n\f\r ]*\+?(\d+)/.exec(v);
    return m ? Number(m[1]) : fallback;
  };
  /** A canvas's bitmap, made anew — cleared — where its size changed. */
  const canvasState = (canvas: Any): CanvasState => {
    const width = canvasSize(canvas, 'width', 300);
    const height = canvasSize(canvas, 'height', 150);
    let state = canvases.get(canvas);
    if (!state) {
      state = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
        dirty: null,
        context: null,
        kind: null,
      };
      canvases.set(canvas, state);
    } else if (state.width !== width || state.height !== height) {
      // setting either is a new bitmap, and the context's state as it
      // starts (HTML 4.12.5.1)
      state.width = width;
      state.height = height;
      state.data = new Uint8ClampedArray(width * height * 4);
      if (state.context instanceof CanvasRenderingContext2D) {
        state.context._reset();
      }
      markCanvas(canvas, state, 0, 0, width, height);
    }
    return state;
  };
  const markCanvas = (
    canvas: Any,
    state: CanvasState,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void => {
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(state.width, Math.ceil(x1));
    y1 = Math.min(state.height, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) {
      // a bitmap made anew with nothing drawn is a change all the same
      if (!(state.width === 0 || state.height === 0)) return;
    }
    const d = state.dirty;
    state.dirty = d
      ? [
          Math.min(d[0], x0),
          Math.min(d[1], y0),
          Math.max(d[2], x1),
          Math.max(d[3], y1),
        ]
      : [x0, y0, x1, y1];
    dirtyCanvases.add(canvas);
    if (!canvasFlush) {
      canvasFlush = true;
      queueMicrotask(flushCanvases);
    }
  };
  /** What changed in each canvas, to the host: the rectangle and its
   *  pixels as base64, since a string is what crosses. */
  const flushCanvases = (): void => {
    canvasFlush = false;
    for (const canvas of dirtyCanvases) {
      const state = canvases.get(canvas);
      if (!state?.dirty) continue;
      const [x0, y0, x1, y1] = state.dirty;
      state.dirty = null;
      const w = Math.max(0, x1 - x0);
      const h = Math.max(0, y1 - y0);
      const rows = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y += 1) {
        const from = ((y0 + y) * state.width + x0) * 4;
        rows.set(state.data.subarray(from, from + w * 4), y * w * 4);
      }
      call(
        'canvasPut',
        idOf(canvas),
        [state.width, state.height, x0, y0, w, h].join(','),
        base64OfBytes(rows),
      );
    }
    dirtyCanvases.clear();
  };
  /** Bytes as base64, a table and a chunk at a time. */
  function base64OfBytes(bytes: Uint8Array): string {
    // the runtime's own where it has one (Node 26, Bun): native, and a
    // canvas's or a worker's megabytes are many
    const native = (bytes as Any).toBase64;
    if (typeof native === 'function') return native.call(bytes);
    const letters =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const parts: string[] = [];
    const chunk: number[] = [];
    const flush = () => {
      parts.push(String.fromCharCode.apply(null, chunk));
      chunk.length = 0;
    };
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      chunk.push(
        letters.charCodeAt(n >> 18),
        letters.charCodeAt((n >> 12) & 63),
        letters.charCodeAt((n >> 6) & 63),
        letters.charCodeAt(n & 63),
      );
      if (chunk.length >= 8192) flush();
    }
    if (i < bytes.length) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
      chunk.push(
        letters.charCodeAt(n >> 18),
        letters.charCodeAt((n >> 12) & 63),
        i + 1 < bytes.length ? letters.charCodeAt((n >> 6) & 63) : 61,
        61,
      );
    }
    flush();
    return parts.join('');
  }
  /** A colour a page names, as straight RGBA bytes, or null where it is not
   *  one: the host's CSS parser's answer, kept by its text. */
  const colours = new Map<string, number[] | null>();
  const colourOf = (value: string): number[] | null => {
    let rgba = colours.get(value);
    if (rgba === undefined) {
      const answer = call('color', value);
      rgba =
        typeof answer === 'string' && answer
          ? answer.split(',').map(Number)
          : null;
      colours.set(value, rgba);
    }
    return rgba;
  };

  /** Paths, their fills and strokes, gradients and patterns, rasterized
   *  into the bitmap this realm holds (`raster.ts`). */
  const RASTER = raster(colourOf);
  const IDENTITY = [1, 0, 0, 1, 0, 0];

  /** The state `save` and `restore` keep (HTML 4.12.5.1.2). */
  const CONTEXT_STATE = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDashOffset: 0,
    shadowBlur: 0,
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    direction: 'inherit',
    letterSpacing: '0px',
    wordSpacing: '0px',
    filter: 'none',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
  };

  /**
   * A canvas's 2d context, over the bitmap this realm holds. Pixels in and
   * out — `getImageData`, `putImageData`, `createImageData` — are exact;
   * paths are filled, stroked and clipped to with colours, gradients and
   * patterns of another canvas, through every compositing operator
   * (`raster.ts`); and another canvas is drawn where the transform keeps a
   * rectangle one. Text and an image are kept as state and drawn as
   * nothing: a font's outlines and an image's pixels are the host's.
   */
  class CanvasRenderingContext2D {
    _canvas: Any;
    _state: Any = { ...CONTEXT_STATE };
    _stack: Any[] = [];
    _matrix: number[] = [1, 0, 0, 1, 0, 0];
    _dash: number[] = [];
    /** The current path, in the canvas's pixels: each point mapped by the
     *  transform there was as it was added. */
    _path: PathData = RASTER.newPath();
    /** What the clips there are leave of each pixel, 0 to 1, or null for
     *  none: `save` keeps it, and a clip makes a new one. */
    _clip: Float32Array | null = null;
    constructor(canvas: Any) {
      this._canvas = canvas;
    }
    get canvas(): Any {
      return this._canvas;
    }
    _reset(): void {
      this._state = { ...CONTEXT_STATE };
      this._stack = [];
      this._matrix = [1, 0, 0, 1, 0, 0];
      this._dash = [];
      this._path = RASTER.newPath();
      this._clip = null;
    }
    getContextAttributes(): Any {
      return {
        alpha: true,
        colorSpace: 'srgb',
        desynchronized: false,
        willReadFrequently: false,
      };
    }
    save(): void {
      this._stack.push({
        state: { ...this._state },
        matrix: this._matrix.slice(),
        dash: this._dash.slice(),
        clip: this._clip,
      });
    }
    restore(): void {
      const was = this._stack.pop();
      if (!was) return;
      this._state = was.state;
      this._matrix = was.matrix;
      this._dash = was.dash;
      this._clip = was.clip;
    }
    reset(): void {
      this._reset();
      const state = canvasState(this._canvas);
      state.data.fill(0);
      markCanvas(this._canvas, state, 0, 0, state.width, state.height);
    }
    // the transform
    setTransform(a: Any = 1, b = 0, c = 0, d = 1, e = 0, f = 0): void {
      if (typeof a === 'object' && a !== null) {
        this._matrix = [
          a.a ?? a.m11 ?? 1,
          a.b ?? a.m12 ?? 0,
          a.c ?? a.m21 ?? 0,
          a.d ?? a.m22 ?? 1,
          a.e ?? a.m41 ?? 0,
          a.f ?? a.m42 ?? 0,
        ];
        return;
      }
      const m = [a, b, c, d, e, f].map(Number);
      if (m.every(Number.isFinite)) this._matrix = m;
    }
    resetTransform(): void {
      this._matrix = [1, 0, 0, 1, 0, 0];
    }
    transform(a: Any, b: Any, c: Any, d: Any, e: Any, f: Any): void {
      const n = [a, b, c, d, e, f].map(Number);
      if (!n.every(Number.isFinite)) return;
      const [ma, mb, mc, md, me, mf] = this._matrix;
      this._matrix = [
        ma * n[0] + mc * n[1],
        mb * n[0] + md * n[1],
        ma * n[2] + mc * n[3],
        mb * n[2] + md * n[3],
        ma * n[4] + mc * n[5] + me,
        mb * n[4] + md * n[5] + mf,
      ];
    }
    translate(x: Any, y: Any): void {
      this.transform(1, 0, 0, 1, x, y);
    }
    scale(x: Any, y: Any): void {
      this.transform(x, 0, 0, y, 0, 0);
    }
    rotate(angle: Any): void {
      const a = Number(angle);
      this.transform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0);
    }
    getTransform(): Any {
      const [a, b, c, d, e, f] = this._matrix;
      return {
        a,
        b,
        c,
        d,
        e,
        f,
        is2D: true,
        isIdentity: a === 1 && !b && !c && d === 1 && !e && !f,
      };
    }
    /** A rectangle in the canvas's pixels, where the transform keeps it
     *  one: null where it turns or skews it. */
    _rect(x: Any, y: Any, w: Any, h: Any): number[] | null {
      const [a, b, c, d, e, f] = this._matrix;
      if (b !== 0 || c !== 0) return null;
      const n = [x, y, w, h].map(Number);
      if (!n.every(Number.isFinite)) return null;
      const x0 = a * n[0] + e;
      const x1 = a * (n[0] + n[2]) + e;
      const y0 = d * n[1] + f;
      const y1 = d * (n[1] + n[3]) + f;
      return [
        Math.min(x0, x1),
        Math.min(y0, y1),
        Math.max(x0, x1),
        Math.max(y0, y1),
      ];
    }
    /** Pixels whose centres a rectangle covers, clipped to the bitmap. */
    _pixels(r: number[], state: CanvasState): number[] {
      return [
        Math.max(0, Math.round(r[0])),
        Math.max(0, Math.round(r[1])),
        Math.min(state.width, Math.round(r[2])),
        Math.min(state.height, Math.round(r[3])),
      ];
    }
    clearRect(x: Any, y: Any, w: Any, h: Any): void {
      const r = this._rect(x, y, w, h);
      if (!r || this._clip) {
        // turned, or cut by a clip: what the rectangle covers, cleared
        const path = RASTER.newPath();
        path.rect(Number(x), Number(y), Number(w), Number(h), this._matrix);
        this._paint(
          (target, draw) =>
            RASTER.fill(target, path, IDENTITY, 'nonzero', draw),
          {
            paint: RASTER.solid([0, 0, 0, 255]),
            alpha: 1,
            op: 'destination-out',
            clip: this._clip,
          },
        );
        return;
      }
      const state = canvasState(this._canvas);
      const [x0, y0, x1, y1] = this._pixels(r, state);
      for (let py = y0; py < y1; py += 1) {
        state.data.fill(
          0,
          (py * state.width + x0) * 4,
          (py * state.width + x1) * 4,
        );
      }
      markCanvas(this._canvas, state, x0, y0, x1, y1);
    }
    fillRect(x: Any, y: Any, w: Any, h: Any): void {
      const style = this._state.fillStyle;
      const rgba = typeof style === 'string' ? colourOf(style) : null;
      const r = this._rect(x, y, w, h);
      const op = this._state.globalCompositeOperation;
      if (!rgba || !r || this._clip || op !== 'source-over') {
        // anything but a colour over what is there in a rectangle of
        // pixels is a path: `copy` among them, which clears what the
        // rectangle leaves
        const path = RASTER.newPath();
        path.rect(Number(x), Number(y), Number(w), Number(h), this._matrix);
        this._fillPath(path, 'nonzero');
        return;
      }
      const state = canvasState(this._canvas);
      const [x0, y0, x1, y1] = this._pixels(r, state);
      const alpha =
        (rgba[3] / 255) * Math.min(1, Math.max(0, this._state.globalAlpha));
      const data = state.data;
      for (let py = y0; py < y1; py += 1) {
        for (let px = x0; px < x1; px += 1) {
          const o = (py * state.width + px) * 4;
          if (alpha >= 1 || data[o + 3] === 0) {
            data[o] = rgba[0];
            data[o + 1] = rgba[1];
            data[o + 2] = rgba[2];
            data[o + 3] = alpha * 255;
            continue;
          }
          // source-over, straight colours
          const da = data[o + 3] / 255;
          const oa = alpha + da * (1 - alpha);
          for (let k = 0; k < 3; k += 1) {
            data[o + k] =
              (rgba[k] * alpha + data[o + k] * da * (1 - alpha)) / oa;
          }
          data[o + 3] = oa * 255;
        }
      }
      markCanvas(this._canvas, state, x0, y0, x1, y1);
    }
    strokeRect(x: Any, y: Any, w: Any, h: Any): void {
      const path = RASTER.newPath();
      path.rect(Number(x), Number(y), Number(w), Number(h), this._matrix);
      this._strokePath(path);
    }
    createImageData(a: Any, b?: Any): Any {
      if (a instanceof ImageData) return new ImageData(a.width, a.height);
      return new ImageData(a, b);
    }
    getImageData(sx: Any, sy: Any, sw: Any, sh: Any): Any {
      let x = Math.trunc(Number(sx));
      let y = Math.trunc(Number(sy));
      let w = Math.trunc(Number(sw));
      let h = Math.trunc(Number(sh));
      if (!w || !h) {
        throw new DOMException(
          `Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The source ${w ? 'height' : 'width'} is 0.`,
          'IndexSizeError',
        );
      }
      if (w < 0) {
        x += w;
        w = -w;
      }
      if (h < 0) {
        y += h;
        h = -h;
      }
      const state = canvasState(this._canvas);
      const out = new ImageData(w, h);
      const fromX = Math.max(0, x);
      const toX = Math.min(state.width, x + w);
      for (let row = 0; row < h; row += 1) {
        const py = y + row;
        if (py < 0 || py >= state.height || toX <= fromX) continue;
        out.data.set(
          state.data.subarray(
            (py * state.width + fromX) * 4,
            (py * state.width + toX) * 4,
          ),
          (row * w + (fromX - x)) * 4,
        );
      }
      return out;
    }
    putImageData(
      image: Any,
      dx: Any,
      dy: Any,
      dirtyX: Any = 0,
      dirtyY: Any = 0,
      dirtyWidth: Any = image?.width,
      dirtyHeight: Any = image?.height,
    ): void {
      if (!(image instanceof ImageData)) {
        throw new TypeError(
          "Failed to execute 'putImageData' on 'CanvasRenderingContext2D': parameter 1 is not of type 'ImageData'.",
        );
      }
      // HTML 4.12.5.1.15, the dirty rectangle made positive and cut to the
      // image, then put without the transform, the alpha or the clip
      let [x, y, w, h] = [dirtyX, dirtyY, dirtyWidth, dirtyHeight].map((v) =>
        Math.trunc(Number(v)),
      );
      const ox = Math.trunc(Number(dx));
      const oy = Math.trunc(Number(dy));
      if (![x, y, w, h, ox, oy].every(Number.isFinite)) return;
      if (w < 0) {
        x += w;
        w = -w;
      }
      if (h < 0) {
        y += h;
        h = -h;
      }
      if (x < 0) {
        w += x;
        x = 0;
      }
      if (y < 0) {
        h += y;
        y = 0;
      }
      w = Math.min(w, image.width - x);
      h = Math.min(h, image.height - y);
      const state = canvasState(this._canvas);
      const x0 = Math.max(x, -ox);
      const y0 = Math.max(y, -oy);
      const x1 = Math.min(x + w, state.width - ox);
      const y1 = Math.min(y + h, state.height - oy);
      if (x1 <= x0 || y1 <= y0) return;
      for (let row = y0; row < y1; row += 1) {
        state.data.set(
          image.data.subarray(
            (row * image.width + x0) * 4,
            (row * image.width + x1) * 4,
          ),
          ((row + oy) * state.width + x0 + ox) * 4,
        );
      }
      markCanvas(this._canvas, state, x0 + ox, y0 + oy, x1 + ox, y1 + oy);
    }
    drawImage(source: Any, ...args: Any[]): void {
      // another canvas, an `ImageData`'s pixels being no source: what this
      // realm has the pixels of
      const from =
        source instanceof HTMLCanvasElement ? canvasState(source) : null;
      if (!from || !from.width || !from.height) return;
      let [sx, sy, sw, sh] = [0, 0, from.width, from.height];
      let dx: number;
      let dy: number;
      let dw: number;
      let dh: number;
      if (args.length >= 8) {
        [sx, sy, sw, sh, dx, dy, dw, dh] = args.map(Number);
      } else if (args.length >= 4) {
        [dx, dy, dw, dh] = args.map(Number);
      } else {
        [dx, dy] = args.map(Number);
        dw = sw;
        dh = sh;
      }
      const r = this._rect(dx, dy, dw, dh);
      if (!r || !sw || !sh) return;
      const state = canvasState(this._canvas);
      const [x0, y0, x1, y1] = this._pixels(r, state);
      const alpha = Math.min(1, Math.max(0, this._state.globalAlpha));
      const copy = this._state.globalCompositeOperation === 'copy';
      const data = state.data;
      for (let py = y0; py < y1; py += 1) {
        const fy = Math.floor(sy + ((py + 0.5 - r[1]) / (r[3] - r[1])) * sh);
        if (fy < 0 || fy >= from.height) continue;
        for (let px = x0; px < x1; px += 1) {
          const fx = Math.floor(sx + ((px + 0.5 - r[0]) / (r[2] - r[0])) * sw);
          if (fx < 0 || fx >= from.width) continue;
          const i = (fy * from.width + fx) * 4;
          const o = (py * state.width + px) * 4;
          const sa = (from.data[i + 3] / 255) * alpha;
          const da = data[o + 3] / 255;
          const oa = copy ? sa : sa + da * (1 - sa);
          for (let k = 0; k < 3; k += 1) {
            data[o + k] = oa
              ? (from.data[i + k] * sa +
                  (copy ? 0 : data[o + k] * da * (1 - sa))) /
                oa
              : 0;
          }
          data[o + 3] = oa * 255;
        }
      }
      markCanvas(this._canvas, state, x0, y0, x1, y1);
    }
    // the current path, its points mapped by the transform as they are added
    beginPath(): void {
      this._path = RASTER.newPath();
    }
    closePath(): void {
      this._path.close();
    }
    moveTo(x: Any, y: Any): void {
      this._path.moveTo(Number(x), Number(y), this._matrix);
    }
    lineTo(x: Any, y: Any): void {
      this._path.lineTo(Number(x), Number(y), this._matrix);
    }
    rect(x: Any, y: Any, w: Any, h: Any): void {
      this._path.rect(Number(x), Number(y), Number(w), Number(h), this._matrix);
    }
    roundRect(x: Any, y: Any, w: Any, h: Any, radii?: Any): void {
      this._path.roundRect(
        Number(x),
        Number(y),
        Number(w),
        Number(h),
        radii,
        this._matrix,
      );
    }
    arc(x: Any, y: Any, r: Any, a0: Any, a1: Any, ccw?: Any): void {
      this._path.ellipse(
        Number(x),
        Number(y),
        Number(r),
        Number(r),
        0,
        Number(a0),
        Number(a1),
        !!ccw,
        this._matrix,
      );
    }
    arcTo(x1: Any, y1: Any, x2: Any, y2: Any, r: Any): void {
      this._path.arcTo(
        Number(x1),
        Number(y1),
        Number(x2),
        Number(y2),
        Number(r),
        this._matrix,
      );
    }
    ellipse(
      x: Any,
      y: Any,
      rx: Any,
      ry: Any,
      rot: Any,
      a0: Any,
      a1: Any,
      ccw?: Any,
    ): void {
      this._path.ellipse(
        Number(x),
        Number(y),
        Number(rx),
        Number(ry),
        Number(rot),
        Number(a0),
        Number(a1),
        !!ccw,
        this._matrix,
      );
    }
    quadraticCurveTo(cx: Any, cy: Any, x: Any, y: Any): void {
      this._path.quadTo(
        Number(cx),
        Number(cy),
        Number(x),
        Number(y),
        this._matrix,
      );
    }
    bezierCurveTo(
      c1x: Any,
      c1y: Any,
      c2x: Any,
      c2y: Any,
      x: Any,
      y: Any,
    ): void {
      this._path.cubicTo(
        Number(c1x),
        Number(c1y),
        Number(c2x),
        Number(c2y),
        Number(x),
        Number(y),
        this._matrix,
      );
    }
    /** The path a call names, mapped into the canvas's pixels: a `Path2D`
     *  through the transform there is now, or the current path, which is
     *  in them already — and the fill rule after it. */
    _pathArgs(a: Any, b: Any): [PathData, number[], string] {
      const given = RASTER.pathOf(a);
      if (given) return [given, this._matrix, str(b ?? 'nonzero')];
      return [this._path, IDENTITY, str(a ?? 'nonzero')];
    }
    /** How a fill or a stroke with a style is drawn, or null for a style
     *  that paints nothing. */
    _drawOf(style: Any): Any {
      const paint =
        typeof style === 'string'
          ? (() => {
              const rgba = colourOf(style);
              return rgba ? RASTER.solid(rgba) : null;
            })()
          : RASTER.paintOf(style, this._matrix);
      if (!paint) return null;
      return {
        paint,
        alpha: this._state.globalAlpha,
        op: this._state.globalCompositeOperation,
        clip: this._clip,
      };
    }
    /** Draw into the bitmap and mark what changed. */
    _paint(draw: (target: Any, how: Any) => number[] | null, how: Any): void {
      if (!how) return;
      const state = canvasState(this._canvas);
      const changed = draw(state, how);
      if (changed) {
        markCanvas(
          this._canvas,
          state,
          changed[0],
          changed[1],
          changed[2],
          changed[3],
        );
      }
    }
    _fillPath(path: PathData, rule: string, m: number[] = IDENTITY): void {
      this._paint(
        (target, how) => RASTER.fill(target, path, m, rule, how),
        this._drawOf(this._state.fillStyle),
      );
    }
    _strokeStyle(): Any {
      return {
        width: this._state.lineWidth,
        cap: this._state.lineCap,
        join: this._state.lineJoin,
        miterLimit: this._state.miterLimit,
        dash: this._dash,
        dashOffset: this._state.lineDashOffset,
      };
    }
    /** The scale the transform gives a pen's width. */
    _penScale(): number {
      const m = this._matrix;
      return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    }
    _strokePath(path: PathData, m: number[] = IDENTITY): void {
      // the pen is the transform's now: a path already in the canvas's
      // pixels is stroked with a width the transform scales
      const style = this._strokeStyle();
      const s = this._penScale();
      const pen =
        m === IDENTITY
          ? {
              ...style,
              width: style.width * s,
              dash: style.dash.map((d: number) => d * s),
              dashOffset: style.dashOffset * s,
            }
          : style;
      this._paint(
        (target, how) => RASTER.stroke(target, path, m, pen, how),
        this._drawOf(this._state.strokeStyle),
      );
    }
    fill(a?: Any, b?: Any): void {
      const [path, m, rule] = this._pathArgs(a, b);
      this._fillPath(path, rule, m);
    }
    stroke(a?: Any): void {
      const given = RASTER.pathOf(a);
      if (given) this._strokePath(given, this._matrix);
      else this._strokePath(this._path);
    }
    clip(a?: Any, b?: Any): void {
      const [path, m, rule] = this._pathArgs(a, b);
      const state = canvasState(this._canvas);
      this._clip = RASTER.clipMask(
        state.width,
        state.height,
        path,
        m,
        rule,
        this._clip,
      );
    }
    isPointInPath(a: Any, b: Any, c?: Any, d?: Any): boolean {
      const given = RASTER.pathOf(a);
      if (given) {
        return RASTER.contains(
          given,
          this._matrix,
          Number(b),
          Number(c),
          str(d ?? 'nonzero'),
        );
      }
      return RASTER.contains(
        this._path,
        IDENTITY,
        Number(a),
        Number(b),
        str(c ?? 'nonzero'),
      );
    }
    isPointInStroke(a: Any, b: Any, c?: Any): boolean {
      const given = RASTER.pathOf(a);
      const style = this._strokeStyle();
      if (given) {
        return RASTER.strokeContains(
          given,
          this._matrix,
          style,
          Number(b),
          Number(c),
        );
      }
      return RASTER.strokeContains(
        this._path,
        IDENTITY,
        { ...style, width: style.width * this._penScale() },
        Number(a),
        Number(b),
      );
    }
    fillText(): void {}
    strokeText(): void {}
    /** A width as a sans-serif's average character, the text being drawn
     *  as nothing yet. */
    measureText(text: Any): Any {
      const size = parseFloat(
        /(\d+(?:\.\d+)?)px/.exec(this._state.font)?.[1] ?? '10',
      );
      const width = str(text).length * size * 0.55;
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: size * 0.8,
        actualBoundingBoxDescent: size * 0.2,
        fontBoundingBoxAscent: size * 0.9,
        fontBoundingBoxDescent: size * 0.25,
      };
    }
    setLineDash(segments: Any): void {
      this._dash = Array.from(segments ?? [], Number);
    }
    getLineDash(): number[] {
      return this._dash.slice();
    }
    createLinearGradient(x0: Any, y0: Any, x1: Any, y1: Any): Any {
      const [a, b, c, d] = finiteArgs('createLinearGradient', [x0, y0, x1, y1]);
      return RASTER.makeLinear(a, b, c, d);
    }
    createRadialGradient(
      x0: Any,
      y0: Any,
      r0: Any,
      x1: Any,
      y1: Any,
      r1: Any,
    ): Any {
      const [a, b, c, d, e, f] = finiteArgs('createRadialGradient', [
        x0,
        y0,
        r0,
        x1,
        y1,
        r1,
      ]);
      return RASTER.makeRadial(a, b, c, d, e, f);
    }
    createConicGradient(angle: Any, x: Any, y: Any): Any {
      const [a, b, c] = finiteArgs('createConicGradient', [angle, x, y]);
      return RASTER.makeConic(a, b, c);
    }
    /** A pattern of another canvas, as it is now: an image's pixels are
     *  the host's, and one is no pattern here. */
    createPattern(source: Any, repetition: Any): Any {
      const rep =
        repetition === null || repetition === '' ? 'repeat' : str(repetition);
      if (!['repeat', 'repeat-x', 'repeat-y', 'no-repeat'].includes(rep)) {
        throw new DOMException(
          `The provided type ('${rep}') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.`,
          'SyntaxError',
        );
      }
      if (!(source instanceof HTMLCanvasElement)) return null;
      const from = canvasState(source);
      if (!from.width || !from.height) {
        throw new DOMException(
          "Failed to execute 'createPattern' on 'CanvasRenderingContext2D': The image argument is a canvas element with a width or height of 0.",
          'InvalidStateError',
        );
      }
      return RASTER.makePattern(
        { data: from.data.slice(), width: from.width, height: from.height },
        rep,
      );
    }
    drawFocusIfNeeded(): void {}
  }
  /** Numbers a gradient is made from, each finite or a `TypeError`. */
  const finiteArgs = (method: string, args: Any[]): number[] =>
    args.map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        throw new TypeError(
          `Failed to execute '${method}' on 'CanvasRenderingContext2D': The provided double value is non-finite.`,
        );
      }
      return n;
    });
  for (const name of Object.keys(CONTEXT_STATE)) {
    Object.defineProperty(CanvasRenderingContext2D.prototype, name, {
      get(this: Any) {
        return this._state[name];
      },
      set(this: Any, v: Any) {
        const was = this._state[name];
        // what a style is set to is kept as text, and one that is not a
        // colour, nor a gradient or a pattern, is ignored
        if (name === 'fillStyle' || name === 'strokeStyle') {
          if (typeof v === 'string') {
            if (colourOf(v)) this._state[name] = v;
          } else if (v && typeof v === 'object') this._state[name] = v;
          return;
        }
        // a width and a miter limit of none, or less, are ignored
        if (
          (name === 'lineWidth' || name === 'miterLimit') &&
          !(Number(v) > 0)
        ) {
          return;
        }
        this._state[name] =
          typeof was === 'number'
            ? Number.isFinite(Number(v))
              ? Number(v)
              : was
            : typeof was === 'boolean'
              ? !!v
              : str(v);
      },
      configurable: true,
      enumerable: true,
    });
  }

  class HTMLCanvasElement extends HTMLElement {
    get width(): number {
      return canvasSize(this, 'width', 300);
    }
    set width(v: Any) {
      this.setAttribute('width', String(Number(v) >>> 0));
      canvasState(this);
    }
    get height(): number {
      return canvasSize(this, 'height', 150);
    }
    set height(v: Any) {
      this.setAttribute('height', String(Number(v) >>> 0));
      canvasState(this);
    }
    /** A context of a kind, the same each time, and none of another kind
     *  once the canvas has one (HTML 4.12.5): a 2d context, or a WebGL
     *  one that draws nothing (`webgl.ts`). */
    getContext(type: Any, options?: Any): Any {
      let kind = str(type);
      if (kind === 'experimental-webgl') kind = 'webgl';
      if (kind !== '2d' && kind !== 'webgl' && kind !== 'webgl2') return null;
      const state = canvasState(this);
      if (state.context) return state.kind === kind ? state.context : null;
      state.kind = kind;
      state.context =
        kind === '2d'
          ? new CanvasRenderingContext2D(this)
          : WEBGL.context(this, kind, options);
      return state.context;
    }
    toDataURL(): string {
      return 'data:,';
    }
    toBlob(callback: Any): void {
      setTimeout(() => callback?.(null), 0);
    }
  }
  /**
   * What a page asked of a media element, by its wrapper: whether it plays,
   * whether it is muted, how loud and how fast, where it was sought to, and
   * the promises `play()` handed out that no task has settled. A field the
   * page never set is null, and is the markup's.
   */
  interface MediaAsk {
    paused: boolean | null;
    muted: boolean | null;
    volume: number;
    playbackRate: number;
    time: number;
    pending: { resolve: (v?: Any) => void; reject: (e: Any) => void }[];
    /** How many times a `pause()` paused it: a `play()` whose task finds
     *  another count was paused since. */
    pauses: number;
  }
  const mediaAsks = new WeakMap<Any, MediaAsk>();
  const askOf = (el: Any): MediaAsk => {
    let ask = mediaAsks.get(el);
    if (!ask) {
      ask = {
        paused: null,
        muted: null,
        volume: 1,
        playbackRate: 1,
        time: 0,
        pending: [],
        pauses: 0,
      };
      mediaAsks.set(el, ask);
    }
    return ask;
  };
  /** A media element's event, in a task of its own (HTML's "queue a media
   *  element task"), on a timer of the facade's that no page replaces. */
  const mediaTask = (fn: () => void): void => {
    setTimer(fn, 0, [], false);
  };
  const fireMedia = (el: Any, type: string): void => {
    const ev = new Event(type);
    ev.isTrusted = true;
    dispatch(el, ev);
  };
  /** A WebIDL `double`: a number that is finite, or a `TypeError`. */
  const mediaNumber = (v: Any, name: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new TypeError(
        `Failed to set the '${name}' property on 'HTMLMediaElement': The provided double value is non-finite.`,
      );
    }
    return n;
  };
  class HTMLMediaElement extends HTMLElement {
    static readonly NETWORK_EMPTY = 0;
    static readonly HAVE_NOTHING = 0;
    // a media element here never loads (HTML 4.8.11): no data, no duration
    // and no tracks. What it is told to do is the player's: `<Html>` mounts
    // core's `<video>` over a video it can show, and hands it what the page
    // asked here (`mediaState`), so `paused`, `muted`, `volume`,
    // `playbackRate` and `currentTime` are what the page asked, and the
    // events are the ones HTML fires as it asks.
    /** Paused until the page plays it, but for one with `autoplay`, which
     *  the player plays from the start. */
    get paused(): boolean {
      return askOf(this).paused ?? !this.hasAttribute('autoplay');
    }
    get ended(): boolean {
      return false;
    }
    get seeking(): boolean {
      return false;
    }
    get readyState(): number {
      return 0;
    }
    get networkState(): number {
      return 0;
    }
    get duration(): number {
      return NaN;
    }
    /** Where the page last sought to: nothing reports where the player
     *  has come to since. */
    get currentTime(): number {
      return askOf(this).time;
    }
    /** HTML 4.8.11.9, seeking: `seeking`, then `timeupdate` and `seeked`
     *  once it is there. */
    set currentTime(v: Any) {
      const time = Math.max(0, mediaNumber(v, 'currentTime'));
      askOf(this).time = time;
      call('mediaState', this._id, 'currentTime', time);
      mediaTask(() => {
        fireMedia(this, 'seeking');
        fireMedia(this, 'timeupdate');
        fireMedia(this, 'seeked');
      });
    }
    get volume(): number {
      return askOf(this).volume;
    }
    set volume(v: Any) {
      const volume = mediaNumber(v, 'volume');
      if (volume < 0 || volume > 1) {
        throw new DOMException(
          `Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${volume}) is outside the range [0, 1].`,
          'IndexSizeError',
        );
      }
      const ask = askOf(this);
      if (ask.volume === volume) return;
      ask.volume = volume;
      call('mediaState', this._id, 'volume', volume);
      mediaTask(() => fireMedia(this, 'volumechange'));
    }
    get playbackRate(): number {
      return askOf(this).playbackRate;
    }
    set playbackRate(v: Any) {
      const rate = mediaNumber(v, 'playbackRate');
      const ask = askOf(this);
      if (ask.playbackRate === rate) return;
      ask.playbackRate = rate;
      call('mediaState', this._id, 'playbackRate', rate);
      mediaTask(() => fireMedia(this, 'ratechange'));
    }
    defaultPlaybackRate = 1;
    /** Its own state from the first, which the `muted` attribute only
     *  starts it in (HTML 4.8.11.12): `defaultMuted` is the attribute. */
    get muted(): boolean {
      return askOf(this).muted ?? this.hasAttribute('muted');
    }
    set muted(v: Any) {
      const muted = !!v;
      const was = this.muted;
      // the page's from now on, whatever the attribute comes to say
      askOf(this).muted = muted;
      call('mediaState', this._id, 'muted', muted);
      if (was !== muted) mediaTask(() => fireMedia(this, 'volumechange'));
    }
    get currentSrc(): string {
      return '';
    }
    get error(): Any {
      return null;
    }
    get buffered(): Any {
      return noTimeRanges;
    }
    get played(): Any {
      return noTimeRanges;
    }
    get seekable(): Any {
      return noTimeRanges;
    }
    get textTracks(): Any {
      return trackListOf(this, TextTrackList);
    }
    get audioTracks(): Any {
      return trackListOf(this, AudioTrackList);
    }
    get videoTracks(): Any {
      return trackListOf(this, VideoTrackList);
    }
    /**
     * HTML 4.8.11.8, the internal play steps, for media that is ready as
     * soon as it is asked: playing at once, and in a task `play` where it
     * was paused, then `playing` and the promise kept — unless a `pause()`
     * came between, which turns the promise down.
     */
    play(): Promise<void> {
      const ask = askOf(this);
      const was = this.paused;
      const pauses = ask.pauses;
      ask.paused = false;
      call('mediaState', this._id, 'paused', false);
      const promise = new Promise<void>((resolve, reject) => {
        ask.pending.push({ resolve, reject });
      });
      mediaTask(() => {
        if (was) fireMedia(this, 'play');
        if (ask.pauses !== pauses) return;
        if (was) fireMedia(this, 'playing');
        const pending = ask.pending;
        ask.pending = [];
        for (const p of pending) p.resolve();
      });
      return promise;
    }
    /** The internal pause steps: paused at once, and in a task
     *  `timeupdate`, `pause` and the promises `play()` handed out before it
     *  turned down, as Chrome turns them down. */
    pause(): void {
      const ask = askOf(this);
      const was = this.paused;
      ask.paused = true;
      call('mediaState', this._id, 'paused', true);
      if (was) return;
      ask.pauses += 1;
      const pending = ask.pending;
      ask.pending = [];
      mediaTask(() => {
        fireMedia(this, 'timeupdate');
        fireMedia(this, 'pause');
        for (const p of pending) {
          p.reject(
            new DOMException(
              'The play() request was interrupted by a call to pause().',
              'AbortError',
            ),
          );
        }
      });
    }
    load(): void {}
    canPlayType(): string {
      return '';
    }
  }

  for (const name of ['autoplay', 'controls', 'loop', 'playsInline']) {
    Object.defineProperty(
      HTMLMediaElement.prototype,
      name,
      flag(name.toLowerCase()),
    );
  }
  Object.defineProperty(
    HTMLMediaElement.prototype,
    'defaultMuted',
    flag('muted'),
  );
  for (const name of ['preload', 'crossOrigin']) {
    Object.defineProperty(
      HTMLMediaElement.prototype,
      name,
      reflect(name.toLowerCase()),
    );
  }
  Object.defineProperty(HTMLMediaElement.prototype, 'src', urlProperty('src'));
  class HTMLVideoElement extends HTMLMediaElement {
    get videoWidth(): number {
      return 0;
    }
    get videoHeight(): number {
      return 0;
    }
  }
  Object.defineProperty(
    HTMLVideoElement.prototype,
    'poster',
    urlProperty('poster'),
  );
  class HTMLAudioElement extends HTMLMediaElement {}
  /** A media element's list of tracks: none, since nothing loads. */
  class TrackList extends EventTarget {
    get length(): number {
      return 0;
    }
    getTrackById(): Any {
      return null;
    }
    [Symbol.iterator](): Iterator<Any> {
      return [][Symbol.iterator]();
    }
  }
  class TextTrackList extends TrackList {}
  class AudioTrackList extends TrackList {}
  class VideoTrackList extends TrackList {}
  const trackLists = new WeakMap<object, Map<Any, Any>>();
  const trackListOf = (media: Any, Kind: Any): Any => {
    let lists = trackLists.get(media);
    if (!lists) trackLists.set(media, (lists = new Map()));
    let list = lists.get(Kind);
    if (!list) lists.set(Kind, (list = new Kind()));
    return list;
  };
  /** A `TimeRanges` with no range in it. */
  const noTimeRanges: Any = {
    length: 0,
    start: () => {
      throw new DOMException('There is no range.', 'IndexSizeError');
    },
    end: () => {
      throw new DOMException('There is no range.', 'IndexSizeError');
    },
  };
  class HTMLSourceElement extends HTMLElement {}
  Object.defineProperty(HTMLSourceElement.prototype, 'src', urlProperty('src'));
  for (const name of ['type', 'media', 'sizes', 'srcset']) {
    Object.defineProperty(HTMLSourceElement.prototype, name, reflect(name));
  }
  class HTMLTrackElement extends HTMLElement {}
  class HTMLPictureElement extends HTMLElement {}
  class HTMLPreElement extends HTMLElement {}
  class HTMLBRElement extends HTMLElement {}
  class HTMLHRElement extends HTMLElement {}
  class HTMLTitleElement extends HTMLElement {}
  class HTMLBaseElement extends HTMLElement {}
  class HTMLTimeElement extends HTMLElement {}
  Object.defineProperty(
    HTMLTimeElement.prototype,
    'dateTime',
    reflect('datetime'),
  );
  class HTMLQuoteElement extends HTMLElement {}
  class HTMLDListElement extends HTMLElement {}
  class HTMLTableCaptionElement extends HTMLElement {}
  class HTMLTableColElement extends HTMLElement {}
  class HTMLLegendElement extends HTMLElement {}
  class HTMLOptGroupElement extends HTMLElement {}
  class HTMLDataListElement extends HTMLElement {}
  class HTMLProgressElement extends HTMLElement {}
  class HTMLMeterElement extends HTMLElement {}
  class HTMLOutputElement extends HTMLElement {}
  class HTMLObjectElement extends HTMLElement {
    get contentDocument(): Any {
      return this.hasAttribute('data') && this.isConnected
        ? frameDocumentOf(this)
        : null;
    }
    getSVGDocument(): Any {
      return this.contentDocument;
    }
    get contentWindow(): Any {
      return this.hasAttribute('data') && this.isConnected
        ? frameProxyOf(this)
        : null;
    }
  }
  Object.defineProperty(
    HTMLObjectElement.prototype,
    'data',
    urlProperty('data'),
  );
  for (const name of ['type', 'name', 'width', 'height']) {
    Object.defineProperty(HTMLObjectElement.prototype, name, reflect(name));
  }
  class HTMLEmbedElement extends HTMLElement {}
  class HTMLSlotElement extends HTMLElement {
    assignedNodes(): Any[] {
      return [];
    }
    assignedElements(): Any[] {
      return [];
    }
  }
  class HTMLBodyElement extends HTMLElement {}
  // `document.body.onload` is the window's `onload`, and so are its kin
  for (const type of WINDOW_REFLECTING) {
    Object.defineProperty(HTMLBodyElement.prototype, `on${type}`, {
      get: () => handlerOf(windowTarget, type),
      set: (fn: Any) => {
        windowTarget._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
    });
  }
  class HTMLHeadElement extends HTMLElement {}
  class HTMLHtmlElement extends HTMLElement {}
  class HTMLDivElement extends HTMLElement {}
  class HTMLSpanElement extends HTMLElement {}
  class HTMLParagraphElement extends HTMLElement {}
  class HTMLHeadingElement extends HTMLElement {}
  class HTMLUListElement extends HTMLElement {}
  class HTMLOListElement extends HTMLElement {}
  class HTMLLIElement extends HTMLElement {}
  // --- tables (HTML 4.9): what a table's parts say of each other, worked
  // out from its children each time it is asked

  /** An element's HTML children of the names given. */
  const childrenNamed = (el: Any, names: string[]): Any[] =>
    Array.from(el.children as Any[]).filter(
      (k) => k.namespaceURI === HTML_NS && names.includes(k.localName),
    );
  const indexError = (index: number): DOMException =>
    new DOMException(
      `The index provided (${index}) is outside the range.`,
      'IndexSizeError',
    );
  /** A `long` from what a page passed, as WebIDL converts one. */
  const long = (v: Any, otherwise: number): number =>
    v === undefined ? otherwise : Number(v) | 0;
  /** `insertRow` and `insertCell`: a new child made where `index` says,
   *  of the ones `items` lists — at the end for -1. */
  const insertAt = (
    owner: Any,
    items: Any[],
    index: number,
    tag: string,
  ): Any => {
    if (index < -1 || index > items.length) throw indexError(index);
    const made = owner.ownerDocument.createElement(tag);
    if (index === -1 || index === items.length) owner.appendChild(made);
    else owner.insertBefore(made, items[index]);
    return made;
  };
  const deleteAt = (items: Any[], index: number): void => {
    if (index === -1) {
      items[items.length - 1]?.remove();
      return;
    }
    if (index < 0 || index >= items.length) throw indexError(index);
    items[index].remove();
  };

  class HTMLTableElement extends HTMLElement {
    get caption(): Any {
      return childrenNamed(this, ['caption'])[0] ?? null;
    }
    set caption(v: Any) {
      this.deleteCaption();
      if (v) this.insertBefore(v, this.firstChild);
    }
    createCaption(): Any {
      return (
        this.caption ??
        this.insertBefore(
          this.ownerDocument.createElement('caption'),
          this.firstChild,
        )
      );
    }
    deleteCaption(): void {
      this.caption?.remove();
    }
    /** Where a head goes: before the first child that is neither a
     *  caption nor a column group. */
    _headPlace(): Any {
      return (
        (Array.from(this.children) as Any[]).find(
          (k) => k.localName !== 'caption' && k.localName !== 'colgroup',
        ) ?? null
      );
    }
    _section(v: Any, name: string): void {
      if (v !== null && v?.localName !== name) {
        throw new DOMException(
          `The element provided is not a <${name}>.`,
          'HierarchyRequestError',
        );
      }
    }
    get tHead(): Any {
      return childrenNamed(this, ['thead'])[0] ?? null;
    }
    set tHead(v: Any) {
      this._section(v, 'thead');
      this.deleteTHead();
      if (v) this.insertBefore(v, this._headPlace());
    }
    createTHead(): Any {
      return (
        this.tHead ??
        this.insertBefore(
          this.ownerDocument.createElement('thead'),
          this._headPlace(),
        )
      );
    }
    deleteTHead(): void {
      this.tHead?.remove();
    }
    get tFoot(): Any {
      return childrenNamed(this, ['tfoot'])[0] ?? null;
    }
    set tFoot(v: Any) {
      this._section(v, 'tfoot');
      this.deleteTFoot();
      if (v) this.appendChild(v);
    }
    createTFoot(): Any {
      return (
        this.tFoot ??
        this.appendChild(this.ownerDocument.createElement('tfoot'))
      );
    }
    deleteTFoot(): void {
      this.tFoot?.remove();
    }
    get tBodies(): Any {
      return collection(childrenNamed(this, ['tbody']));
    }
    createTBody(): Any {
      const bodies = childrenNamed(this, ['tbody']);
      const last = bodies[bodies.length - 1];
      return this.insertBefore(
        this.ownerDocument.createElement('tbody'),
        last ? last.nextSibling : null,
      );
    }
    /** The rows of the head, then the body's and the table's own, then
     *  the foot's, each in tree order. */
    get rows(): Any {
      const kids = Array.from(this.children) as Any[];
      const out: Any[] = [];
      for (const k of kids) {
        if (k.localName === 'thead') out.push(...childrenNamed(k, ['tr']));
      }
      for (const k of kids) {
        if (k.localName === 'tr') out.push(k);
        else if (k.localName === 'tbody') {
          out.push(...childrenNamed(k, ['tr']));
        }
      }
      for (const k of kids) {
        if (k.localName === 'tfoot') out.push(...childrenNamed(k, ['tr']));
      }
      return collection(out);
    }
    insertRow(index?: Any): Any {
      const at = long(index, -1);
      const rows = this.rows;
      if (at < -1 || at > rows.length) throw indexError(at);
      const tr = this.ownerDocument.createElement('tr');
      if (!rows.length) {
        const bodies = childrenNamed(this, ['tbody']);
        if (bodies.length) bodies[bodies.length - 1].appendChild(tr);
        else {
          const tbody = this.ownerDocument.createElement('tbody');
          tbody.appendChild(tr);
          this.appendChild(tbody);
        }
      } else if (at === -1 || at === rows.length) {
        rows[rows.length - 1].parentNode.appendChild(tr);
      } else rows[at].parentNode.insertBefore(tr, rows[at]);
      return tr;
    }
    deleteRow(index: Any): void {
      deleteAt(this.rows, long(index, 0));
    }
  }
  class HTMLTableSectionElement extends HTMLElement {
    get rows(): Any {
      return collection(childrenNamed(this, ['tr']));
    }
    insertRow(index?: Any): Any {
      return insertAt(this, this.rows, long(index, -1), 'tr');
    }
    deleteRow(index: Any): void {
      deleteAt(this.rows, long(index, 0));
    }
  }
  class HTMLTableRowElement extends HTMLElement {
    /** Where the row is in its table's `rows`, or -1 in none. */
    get rowIndex(): number {
      let table = this.parentNode;
      if (table && ['thead', 'tbody', 'tfoot'].includes(table.localName)) {
        table = table.parentNode;
      }
      if (!(table instanceof HTMLTableElement)) return -1;
      return Array.from(table.rows).indexOf(this);
    }
    get sectionRowIndex(): number {
      const parent = this.parentNode;
      if (!(
        parent instanceof HTMLTableElement ||
        parent instanceof HTMLTableSectionElement
      )) {
        return -1;
      }
      return Array.from(parent.rows).indexOf(this);
    }
    get cells(): Any {
      return collection(childrenNamed(this, ['td', 'th']));
    }
    insertCell(index?: Any): Any {
      return insertAt(this, this.cells, long(index, -1), 'td');
    }
    deleteCell(index: Any): void {
      deleteAt(this.cells, long(index, 0));
    }
  }
  class HTMLTableCellElement extends HTMLElement {
    get cellIndex(): number {
      const row = this.parentNode;
      return row instanceof HTMLTableRowElement
        ? Array.from(row.cells).indexOf(this)
        : -1;
    }
    get colSpan(): number {
      const n = parseInt(this.getAttribute('colspan') ?? '', 10);
      return n >= 1 ? Math.min(n, 1000) : 1;
    }
    set colSpan(v: Any) {
      this.setAttribute('colspan', String(Number(v) >>> 0));
    }
    get rowSpan(): number {
      const n = parseInt(this.getAttribute('rowspan') ?? '', 10);
      return n >= 0 ? Math.min(n, 65534) : 1;
    }
    set rowSpan(v: Any) {
      this.setAttribute('rowspan', String(Number(v) >>> 0));
    }
  }
  for (const name of ['headers', 'abbr', 'scope']) {
    Object.defineProperty(HTMLTableCellElement.prototype, name, reflect(name));
  }
  // --- CSSOM ---------------------------------------------------------------------
  //
  // A sheet is its rules' text. A `<style>`'s are the host's (`sheetRules`):
  // read from its text the first time they are asked for, kept as the page
  // edits them, and written back as the element's text at the next flush,
  // so `<Html>` draws what a CSS-in-JS library inserts — styled-components
  // and emotion insert every rule with `insertRule` in production, and
  // read `document.styleSheets` to find the sheet to insert into. A
  // `<link>`'s rules are refused where it is another origin's, as a
  // browser refuses them, and are none of the rules it has where it is
  // not; a sheet a page constructs draws nothing, since nothing here
  // adopts one.

  class CSSRuleList extends Array {
    item(i: Any): Any {
      return this[Number(i)] ?? null;
    }
  }
  class StyleSheetList extends Array {
    item(i: Any): Any {
      return this[Number(i)] ?? null;
    }
  }

  /** What a rule's text says before its block, or all of a statement. */
  const preludeOf = (text: string): string => {
    const open = text.indexOf('{');
    return (open < 0 ? text.replace(/;\s*$/, '') : text.slice(0, open)).trim();
  };
  /** What is inside a rule's block. */
  const blockOf = (text: string): string => {
    const open = text.indexOf('{');
    if (open < 0) return '';
    const close = text.lastIndexOf('}');
    return text.slice(open + 1, close > open ? close : text.length);
  };
  /** A media query list, as `MediaList` reads one. */
  const mediaList = (text: string): Any => {
    const items = text
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const list: Any = {
      mediaText: items.join(', '),
      length: items.length,
      item: (i: Any) => items[Number(i)] ?? null,
      toString: () => items.join(', '),
    };
    items.forEach((m, i) => (list[i] = m));
    return list;
  };
  /** A block's declarations, as a rule's `style` reads them: by name, by
   *  index and camel-cased. Read only. */
  const declarationsOf = (block: string): Any => {
    const values = new Map<string, string>();
    for (const part of block.split(/;(?![^(]*\))/)) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const name = part.slice(0, colon).trim();
      if (!name) continue;
      values.set(cssName(name), part.slice(colon + 1).trim());
    }
    const names = [...values.keys()];
    const plain = (name: string): string =>
      (values.get(name) ?? '').replace(/\s*!\s*important$/i, '');
    const style: Any = {
      cssText: block.trim(),
      length: names.length,
      item: (i: Any) => names[Number(i)] ?? '',
      getPropertyValue: (name: Any) => plain(cssName(name)),
      getPropertyPriority: (name: Any) =>
        /!\s*important$/i.test(values.get(cssName(name)) ?? '')
          ? 'important'
          : '',
    };
    names.forEach((name, i) => {
      style[i] = name;
      if (!name.startsWith('--')) {
        style[name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] =
          plain(name);
      }
    });
    return style;
  };

  class CSSRule {
    static readonly STYLE_RULE = 1;
    static readonly CHARSET_RULE = 2;
    static readonly IMPORT_RULE = 3;
    static readonly MEDIA_RULE = 4;
    static readonly FONT_FACE_RULE = 5;
    static readonly PAGE_RULE = 6;
    static readonly KEYFRAMES_RULE = 7;
    static readonly KEYFRAME_RULE = 8;
    static readonly NAMESPACE_RULE = 10;
    static readonly SUPPORTS_RULE = 12;
    _type = 0;
    _text: string;
    parentStyleSheet: Any;
    parentRule: Any = null;
    constructor(text: string, sheet: Any) {
      this._text = text;
      this.parentStyleSheet = sheet;
    }
    get cssText(): string {
      return this._text;
    }
    // setting it does nothing (CSSOM 6.4.1)
    set cssText(_v: Any) {}
    get type(): number {
      return this._type;
    }
  }
  class CSSStyleRule extends CSSRule {
    override _type = 1;
    get selectorText(): string {
      return preludeOf(this._text);
    }
    get style(): Any {
      return declarationsOf(blockOf(this._text));
    }
    set style(v: Any) {
      this.style.cssText = v;
    }
  }
  class CSSGroupingRule extends CSSRule {
    get cssRules(): Any {
      return ruleList(
        JSON.parse(String(call('cssRules', blockOf(this._text)))),
        this.parentStyleSheet,
        this,
      );
    }
    insertRule(): number {
      throw new DOMException(
        'A rule inside another is not edited here.',
        'NotSupportedError',
      );
    }
    deleteRule(): void {
      this.insertRule();
    }
  }
  /** An at-rule's prelude with its name left out: a condition. */
  const conditionOf = (text: string): string =>
    preludeOf(text).replace(/^@[\w-]+\s*/, '');
  class CSSMediaRule extends CSSGroupingRule {
    override _type = 4;
    get conditionText(): string {
      return conditionOf(this._text);
    }
    get media(): Any {
      return mediaList(conditionOf(this._text));
    }
  }
  class CSSSupportsRule extends CSSGroupingRule {
    override _type = 12;
    get conditionText(): string {
      return conditionOf(this._text);
    }
  }
  class CSSImportRule extends CSSRule {
    override _type = 3;
    readonly styleSheet = null;
    get href(): string {
      const m = /^(?:url\(\s*)?(["']?)([^"')]*)\1/i.exec(
        conditionOf(this._text),
      );
      return m ? m[2] : '';
    }
    get media(): Any {
      return mediaList(
        conditionOf(this._text).replace(
          /^(?:url\([^)]*\)|"[^"]*"|'[^']*')/i,
          '',
        ),
      );
    }
  }
  class CSSFontFaceRule extends CSSRule {
    override _type = 5;
    get style(): Any {
      return declarationsOf(blockOf(this._text));
    }
    set style(v: Any) {
      this.style.cssText = v;
    }
  }
  class CSSKeyframesRule extends CSSRule {
    override _type = 7;
    get name(): string {
      return conditionOf(this._text).replace(/^["']|["']$/g, '');
    }
  }
  /** A container condition's parts at its top level: a group in
   *  parentheses, a function, or a word, each as written. */
  const conditionParts = (
    text: string,
  ): { kind: 'group' | 'fn' | 'word'; name: string; inner: string }[] => {
    const out: {
      kind: 'group' | 'fn' | 'word';
      name: string;
      inner: string;
    }[] = [];
    /** The end of the group that opens at `at`, past its `)`. */
    const closing = (at: number): number => {
      let depth = 0;
      for (let i = at; i < text.length; i += 1) {
        if (text[i] === '\\') i += 1;
        else if (text[i] === '(') depth += 1;
        else if (text[i] === ')' && (depth -= 1) === 0) return i + 1;
      }
      return text.length;
    };
    let i = 0;
    while (i < text.length) {
      if (/\s/.test(text[i])) {
        i += 1;
        continue;
      }
      if (text[i] === '(') {
        const end = closing(i);
        out.push({
          kind: 'group',
          name: '',
          inner: text.slice(i + 1, end - 1),
        });
        i = end;
        continue;
      }
      let end = i;
      while (end < text.length && !/[\s()]/.test(text[end])) {
        end += text[end] === '\\' ? 2 : 1;
      }
      const name = text.slice(i, Math.max(end, i + 1));
      if (text[end] === '(') {
        const close = closing(end);
        out.push({ kind: 'fn', name, inner: text.slice(end + 1, close - 1) });
        i = close;
      } else {
        out.push({ kind: 'word', name, inner: '' });
        i = Math.max(end, i + 1);
      }
    }
    return out;
  };
  /** A container condition as CSSOM serializes it (CSS Conditional 5, 3.3,
   *  and CSSOM's "serialize a CSS rule"): the keywords and `style()` in
   *  lower case, white space between the parts one space and none inside a
   *  group's own parentheses, a custom property's `--name: value` with the
   *  value as written, and what is no query of this engine's
   *  (`<general-enclosed>`) as written. */
  const serializeCondition = (text: string, inStyle = false): string =>
    conditionParts(text)
      .map((part) => {
        if (part.kind === 'word') {
          return /^(?:and|or|not)$/i.test(part.name)
            ? part.name.toLowerCase()
            : part.name;
        }
        if (part.kind === 'fn') {
          return part.name.toLowerCase() === 'style'
            ? `style(${serializeQueryIn(part.inner, true)})`
            : `${part.name}(${part.inner})`;
        }
        return `(${serializeQueryIn(part.inner, inStyle)})`;
      })
      .join(' ');
  /** What one pair of parentheses, or a `style()`, holds. */
  const serializeQueryIn = (inner: string, inStyle: boolean): string => {
    const text = inner.trim();
    if (/^(?:\(|not\b)/i.test(text) || /\s(?:and|or)\s/i.test(text)) {
      return serializeCondition(text, inStyle);
    }
    const colon = text.indexOf(':');
    const name = (colon < 0 ? text : text.slice(0, colon)).trim();
    if (inStyle && !name.startsWith('--')) {
      // a range over a custom property, or anything else as written
      return /[<>=]/.test(text) && text.includes('--')
        ? text
            .split(/\s*([<>]=?|=)\s*/)
            .filter((t) => t !== '')
            .join(' ')
        : inner;
    }
    if (colon < 0) return text.replace(/\s+/g, ' ');
    return `${name}: ${text.slice(colon + 1).trim()}`;
  };
  /** An `@container` rule: its container's name, if it gives one, and its
   *  query (CSS Conditional 5, 3.3). */
  class CSSContainerRule extends CSSGroupingRule {
    get conditionText(): string {
      const name = this.containerName;
      return name ? `${name} ${this.containerQuery}` : this.containerQuery;
    }
    get containerName(): string {
      const first = conditionParts(conditionOf(this._text))[0];
      return first?.kind === 'word' &&
        !/^(?:and|or|not|none)$/i.test(first.name) &&
        conditionParts(conditionOf(this._text)).length > 1
        ? first.name
        : '';
    }
    get containerQuery(): string {
      const condition = conditionOf(this._text).trim();
      const name = this.containerName;
      return serializeCondition(
        name ? condition.slice(name.length) : condition,
      );
    }
  }
  const RULE_CLASSES: Record<string, Any> = {
    media: CSSMediaRule,
    supports: CSSSupportsRule,
    container: CSSContainerRule,
    import: CSSImportRule,
    'font-face': CSSFontFaceRule,
    keyframes: CSSKeyframesRule,
  };
  const AT_RULE_TYPES: Record<string, number> = {
    charset: 2,
    page: 6,
    namespace: 10,
  };
  const ruleOf = (text: string, sheet: Any, parent: Any = null): Any => {
    const at = /^@(?:-[a-z]+-)?([a-z-]+)/i.exec(text);
    const kind = at ? at[1].toLowerCase() : '';
    const Rule = RULE_CLASSES[kind] ?? (at ? CSSRule : CSSStyleRule);
    const rule = new Rule(text, sheet);
    if (Rule === CSSRule) rule._type = AT_RULE_TYPES[kind] ?? 0;
    rule.parentRule = parent;
    return rule;
  };
  const ruleList = (texts: string[], sheet: Any, parent: Any): Any => {
    const list = new CSSRuleList();
    for (const text of texts) list.push(ruleOf(text, sheet, parent));
    return list;
  };
  /** The one rule a text is, for `insertRule`. */
  const oneRule = (text: string): string => {
    const rules = JSON.parse(String(call('cssRules', text))) as string[];
    if (rules.length !== 1) {
      throw new DOMException(
        `Failed to parse the rule '${text}'.`,
        'SyntaxError',
      );
    }
    return rules[0];
  };

  class CSSStyleSheet {
    /** The `<style>` or `<link>` it is the sheet of, or none. */
    _owner: Any = null;
    /** Its rules, where they are not the host's: a constructed sheet's, or
     *  a `<link>`'s. */
    _rules: string[] | null = [];
    /** The host's edit of a `<style>`'s rules `_list` is. */
    _version: Any = null;
    _list: Any = null;
    _media = '';
    disabled = false;
    readonly parentStyleSheet = null;
    readonly ownerRule = null;
    readonly type = 'text/css';
    constructor(options: Any = {}) {
      const media = options?.media;
      this._media =
        media === undefined || media === null
          ? ''
          : String(media.mediaText ?? media);
      this.disabled = !!options?.disabled;
    }
    get ownerNode(): Any {
      return this._owner;
    }
    get href(): Any {
      return this._owner instanceof HTMLLinkElement
        ? (this._owner as Any).href
        : null;
    }
    get title(): Any {
      return this._owner?.getAttribute('title') ?? null;
    }
    get media(): Any {
      return mediaList(
        this._owner ? (this._owner.getAttribute('media') ?? '') : this._media,
      );
    }
    get cssRules(): Any {
      const owner = this._owner;
      if (owner instanceof HTMLLinkElement) {
        let origin = '';
        try {
          origin = new URL((owner as Any).href).origin;
        } catch {
          // no address: no origin
        }
        if (origin !== location.origin) {
          throw new DOMException(
            "Failed to read the 'cssRules' property from 'CSSStyleSheet': Cannot access rules",
            'SecurityError',
          );
        }
      }
      if (this._rules) {
        this._list ??= ruleList(this._rules, this, null);
        return this._list;
      }
      const answer = String(call('sheetRules', owner._id, this._version));
      if (answer) {
        const cut = answer.indexOf('\u0000');
        this._version = Number(answer.slice(0, cut));
        this._list = ruleList(JSON.parse(answer.slice(cut + 1)), this, null);
      }
      return this._list;
    }
    get rules(): Any {
      return this.cssRules;
    }
    insertRule(rule: Any, index?: Any): number {
      const at = index === undefined ? 0 : Number(index) >>> 0;
      const text = str(rule);
      if (this._rules) {
        const one = oneRule(text);
        if (at > this._rules.length) {
          throw new DOMException(
            `The index provided (${at}) is larger than the maximum index (${this._rules.length}).`,
            'IndexSizeError',
          );
        }
        this._rules.splice(at, 0, one);
        this._list = null;
        if (!this._owner) readopt(this);
        return at;
      }
      const answer = String(call('sheetInsert', this._owner._id, text, at));
      const first = answer.indexOf('\u0000');
      const second = answer.indexOf('\u0000', first + 1);
      // the list kept, edited as the host's rules were, where it was the
      // rules before the edit: a library that inserts a rule and reads
      // `cssRules.length` for the next one reads no list again
      if (this._list && this._version === Number(answer.slice(0, first))) {
        this._list.splice(at, 0, ruleOf(answer.slice(second + 1), this));
        this._version = Number(answer.slice(first + 1, second));
      }
      return at;
    }
    deleteRule(index: Any): void {
      const at = Number(index) >>> 0;
      if (this._rules) {
        if (at >= this._rules.length) {
          throw new DOMException(
            `The index provided (${at}) is outside the range [0, ${this._rules.length}).`,
            'IndexSizeError',
          );
        }
        this._rules.splice(at, 1);
        this._list = null;
        if (!this._owner) readopt(this);
        return;
      }
      const answer = String(call('sheetDelete', this._owner._id, at));
      const cut = answer.indexOf('\u0000');
      if (this._list && this._version === Number(answer.slice(0, cut))) {
        this._list.splice(at, 1);
        this._version = Number(answer.slice(cut + 1));
      }
    }
    addRule(selector: Any, block: Any, index?: Any): number {
      this.insertRule(
        `${str(selector)} { ${str(block)} }`,
        index === undefined ? this.cssRules.length : index,
      );
      return -1;
    }
    removeRule(index: Any = 0): void {
      this.deleteRule(index);
    }
    replaceSync(text: Any): void {
      if (this._owner) {
        throw new DOMException(
          "Failed to execute 'replaceSync' on 'CSSStyleSheet': Can't call replaceSync on non-constructed CSSStyleSheets.",
          'NotAllowedError',
        );
      }
      // a constructed sheet imports nothing (CSSOM 6.1.2)
      this._rules = (
        JSON.parse(String(call('cssRules', str(text)))) as string[]
      ).filter((rule) => !/^@import\b/i.test(rule));
      this._list = null;
      readopt(this);
    }
    replace(text: Any): Promise<Any> {
      try {
        this.replaceSync(text);
        return Promise.resolve(this);
      } catch (e) {
        return Promise.reject(e);
      }
    }
  }
  const StyleSheet = CSSStyleSheet;

  /** The sheet of a `<style>` or a `<link>`: one object for as long as the
   *  element is. */
  const ownedSheets = new WeakMap<object, Any>();
  const sheetOf = (el: Any): Any => {
    let sheet = ownedSheets.get(el);
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet._owner = el;
      sheet._rules = el instanceof HTMLLinkElement ? [] : null;
      ownedSheets.set(el, sheet);
    }
    return sheet;
  };

  /** `document.adoptedStyleSheets`: the sheets, and the array a page
   *  edits them in, which tells the host as it changes. */
  const adoptedSheets: Any[] = [];
  const adoptable = (sheet: Any): void => {
    if (!(sheet instanceof CSSStyleSheet) || sheet._owner) {
      throw new DOMException(
        "Failed to set the 'adoptedStyleSheets' property on 'Document': Sharing constructed stylesheets in multiple documents is not allowed",
        'NotAllowedError',
      );
    }
  };
  const adopt = (): void => {
    call(
      'adopt',
      JSON.stringify(
        adoptedSheets
          .filter((sheet) => !sheet.disabled)
          .map((sheet) => (sheet._rules as string[]).join('\n')),
      ),
    );
  };
  const adopted: Any = new Proxy(adoptedSheets, {
    set(target: Any, key: Any, value: Any): boolean {
      if (typeof key === 'string' && /^\d+$/.test(key)) adoptable(value);
      target[key] = value;
      adopt();
      return true;
    },
    deleteProperty(target: Any, key: Any): boolean {
      delete target[key];
      adopt();
      return true;
    },
  });
  /** A constructed sheet changed: the document's adopted sheets again,
   *  where it is one of them. */
  const readopt = (sheet: Any): void => {
    if (adoptedSheets.includes(sheet)) adopt();
  };

  class HTMLStyleElement extends HTMLElement {
    get sheet(): Any {
      return this.isConnected ? sheetOf(this) : null;
    }
  }
  for (const name of ['media', 'type']) {
    Object.defineProperty(HTMLStyleElement.prototype, name, reflect(name));
  }
  Object.defineProperty(HTMLLinkElement.prototype, 'sheet', {
    get(this: Any): Any {
      return this.isConnected &&
        /(?:^|\s)stylesheet(?:\s|$)/i.test(this.getAttribute('rel') ?? '')
        ? sheetOf(this)
        : null;
    },
    configurable: true,
  });
  class HTMLMetaElement extends HTMLElement {}
  Object.defineProperty(
    HTMLMetaElement.prototype,
    'httpEquiv',
    reflect('http-equiv'),
  );
  for (const name of ['name', 'content', 'media', 'scheme']) {
    Object.defineProperty(HTMLMetaElement.prototype, name, reflect(name));
  }
  class HTMLUnknownElement extends HTMLElement {}

  const ELEMENT_CLASSES: Record<string, Any> = {
    a: HTMLAnchorElement,
    area: HTMLAreaElement,
    img: HTMLImageElement,
    script: HTMLScriptElement,
    link: HTMLLinkElement,
    template: HTMLTemplateElement,
    details: HTMLDetailsElement,
    dialog: HTMLDialogElement,
    label: HTMLLabelElement,
    input: HTMLInputElement,
    textarea: HTMLTextAreaElement,
    select: HTMLSelectElement,
    option: HTMLOptionElement,
    button: HTMLButtonElement,
    fieldset: HTMLFieldSetElement,
    form: HTMLFormElement,
    iframe: HTMLIFrameElement,
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    audio: HTMLAudioElement,
    source: HTMLSourceElement,
    track: HTMLTrackElement,
    picture: HTMLPictureElement,
    pre: HTMLPreElement,
    br: HTMLBRElement,
    hr: HTMLHRElement,
    title: HTMLTitleElement,
    base: HTMLBaseElement,
    time: HTMLTimeElement,
    q: HTMLQuoteElement,
    blockquote: HTMLQuoteElement,
    dl: HTMLDListElement,
    thead: HTMLTableSectionElement,
    tbody: HTMLTableSectionElement,
    tfoot: HTMLTableSectionElement,
    caption: HTMLTableCaptionElement,
    col: HTMLTableColElement,
    colgroup: HTMLTableColElement,
    legend: HTMLLegendElement,
    optgroup: HTMLOptGroupElement,
    datalist: HTMLDataListElement,
    progress: HTMLProgressElement,
    meter: HTMLMeterElement,
    output: HTMLOutputElement,
    object: HTMLObjectElement,
    embed: HTMLEmbedElement,
    slot: HTMLSlotElement,
    body: HTMLBodyElement,
    head: HTMLHeadElement,
    html: HTMLHtmlElement,
    div: HTMLDivElement,
    span: HTMLSpanElement,
    p: HTMLParagraphElement,
    h1: HTMLHeadingElement,
    h2: HTMLHeadingElement,
    h3: HTMLHeadingElement,
    h4: HTMLHeadingElement,
    h5: HTMLHeadingElement,
    h6: HTMLHeadingElement,
    ul: HTMLUListElement,
    ol: HTMLOListElement,
    li: HTMLLIElement,
    table: HTMLTableElement,
    tr: HTMLTableRowElement,
    td: HTMLTableCellElement,
    th: HTMLTableCellElement,
    style: HTMLStyleElement,
    meta: HTMLMetaElement,
  };

  /** What a click does once it was not cancelled (HTML 6.5.4, activation):
   *  a box ticked before it is asked about and put back after a cancelled
   *  one, a label's click on its control, and the rest — a link followed,
   *  a button pressed, a summary opening its details — the host's. */
  const activated = (target: Any, event: Any): boolean => {
    const input = target instanceof HTMLInputElement ? target : null;
    const checkable =
      input &&
      (input.type === 'checkbox' || input.type === 'radio') &&
      !isDisabled(input);
    const was = checkable ? input.checked : false;
    const radioWas: Any[] =
      checkable && input.type === 'radio' && input.name
        ? (Array.from(
            document.querySelectorAll(
              `input[type=radio][name="${cssEscape(input.name)}"]`,
            ),
          ).filter((r: Any) => r.checked && r.form === input.form) as Any[])
        : [];
    if (checkable) {
      if (input.type === 'checkbox') input.checked = !was;
      else input.checked = true;
    }
    const go = dispatch(target, event);
    if (checkable) {
      if (!go) {
        input.checked = was;
        for (const r of radioWas) r.checked = true;
      } else if (input.type === 'checkbox' || !was) {
        const ev = new InputEvent('input', { bubbles: true, composed: true });
        ev.isTrusted = true;
        dispatch(input, ev);
        const change = new Event('change', { bubbles: true });
        change.isTrusted = true;
        dispatch(input, change);
      }
      return go;
    }
    if (!go) return false;
    // a submit button submits its form and a reset button resets it
    // (HTML 4.10.6, 4.10.5.1.19): here, since a button the page made a
    // moment ago is none `<Html>` has drawn yet
    const role =
      target instanceof HTMLButtonElement ||
      (target instanceof HTMLInputElement &&
        ['submit', 'image', 'reset'].includes(target.type))
        ? target.type
        : '';
    if (role && !isDisabled(target)) {
      const form = target.form;
      if (form && role === 'reset') form.reset();
      else if (form && role !== 'button') {
        if (form.noValidate || target.hasAttribute('formnovalidate')) {
          const ev = new SubmitEvent('submit', {
            bubbles: true,
            cancelable: true,
            submitter: target,
          });
          ev.isTrusted = true;
          if (dispatch(form, ev)) call('submit', form._id, target._id);
        } else form.requestSubmit(target);
      }
      return true;
    }
    // the element whose activation it is: the target, or the nearest
    // element around it that has one
    for (let at: Any = target; at instanceof Element; at = at.parentNode) {
      if (at instanceof HTMLLabelElement) {
        const control = at.control;
        if (control && control !== target && !control.contains(target)) {
          control.click();
          control.focus?.();
        }
        break;
      }
      if (call('activate', at._id)) break;
      if (
        at instanceof HTMLAnchorElement ||
        at instanceof HTMLButtonElement ||
        at instanceof HTMLInputElement
      ) {
        break;
      }
    }
    return true;
  };

  // --- the document --------------------------------------------------------------

  class Document extends ParentNode {
    _ready = 'loading';
    _current: Any = null;
    /** An XML document's content type; null for an HTML one. */
    _type: string | null = null;
    /** What `document.write` has written since `open`, where a page
     *  opened a document of its own: parsed at `close`. */
    _written: string | null = null;
    get documentElement(): Any {
      return wrap(Number(call('root', this._id)));
    }
    get head(): Any {
      return this.querySelector('head');
    }
    get body(): Any {
      return (
        this.querySelector('body') ?? (this._type ? null : this.documentElement)
      );
    }
    get title(): string {
      return String(call('title', this._id));
    }
    set title(v: Any) {
      call('setTitle', str(v), this._id);
    }
    get readyState(): string {
      return this._ready;
    }
    /** The sheets a page constructed and adopted, which `<Html>` applies
     *  after the document's own, as CSSOM orders them: an array a page
     *  may set whole or edit in place, as Chrome's is. */
    get adoptedStyleSheets(): Any {
      return this === document ? adopted : [];
    }
    set adoptedStyleSheets(sheets: Any) {
      if (this !== document) return;
      const list = Array.from(sheets ?? []);
      for (const sheet of list) adoptable(sheet);
      adoptedSheets.splice(0, adoptedSheets.length, ...list);
      adopt();
    }
    get styleSheets(): Any {
      const list = new StyleSheetList();
      const ids = String(call('sheets', this._id));
      for (const id of ids ? ids.split(',') : []) {
        list.push(sheetOf(wrap(Number(id))));
      }
      return list;
    }
    get currentScript(): Any {
      return this._current;
    }
    get URL(): string {
      return String(call('location'));
    }
    get documentURI(): string {
      return this.URL;
    }
    get location(): Any {
      return location;
    }
    set location(v: Any) {
      location.href = v;
    }
    get referrer(): string {
      return '';
    }
    get domain(): string {
      return location.hostname;
    }
    // what a tag manager sets to share a document with its frames, which
    // here are all the page's origin's or nothing of the page's
    set domain(_v: Any) {}
    get cookie(): string {
      return '';
    }
    set cookie(_v: Any) {}
    /** The window: the page's for its document, a frame's for the
     *  document it holds now, and none for one a page made of its own or one
     *  a frame has gone on from. */
    get defaultView(): Any {
      return windowOfDocument(this);
    }
    get characterSet(): string {
      return 'UTF-8';
    }
    get charset(): string {
      return 'UTF-8';
    }
    get contentType(): string {
      return this._type ?? 'text/html';
    }
    get compatMode(): string {
      return 'CSS1Compat';
    }
    get visibilityState(): string {
      return 'visible';
    }
    get hidden(): boolean {
      return false;
    }
    get timeline(): Any {
      return documentTimeline;
    }
    getAnimations(): Any[] {
      return animationsOf(this, true);
    }
    get activeElement(): Any {
      return wrap(Number(call('active'))) ?? this.body;
    }
    get scrollingElement(): Any {
      return this.documentElement;
    }
    get forms(): Any {
      return collection(Array.from(this.getElementsByTagName('form')));
    }
    get images(): Any {
      return collection(Array.from(this.getElementsByTagName('img')));
    }
    get links(): Any {
      return collection(
        Array.from(this.querySelectorAll('a[href],area[href]')),
      );
    }
    get scripts(): Any {
      return this.getElementsByTagName('script');
    }
    get doctype(): Any {
      for (const kid of this.childNodes) if (kid.nodeType === 10) return kid;
      return null;
    }
    get implementation(): Any {
      return implementationOf(this);
    }
    get fonts(): Any {
      return {
        ready: Promise.resolve(),
        check: () => true,
        load: () => Promise.resolve([]),
      };
    }
    hasFocus(): boolean {
      return true;
    }
    getElementById(id: Any): Any {
      return wrap(Number(call('byId', str(id), this._id)));
    }
    getElementsByName(name: Any): Any {
      return this.querySelectorAll(`[name="${cssEscape(str(name))}"]`);
    }
    createElement(tag: Any, options?: Any): Any {
      // an XML document keeps the name's case, and makes it in no
      // namespace but XHTML's (DOM 4.5, `createElement`)
      const name = this._type ? str(tag) : str(tag).toLowerCase();
      // a valid element local name (DOM 4.9): one that starts with a
      // letter and has no white space, NUL, `/` or `>` in it, or one that
      // starts with `:`, `_` or past ASCII and has nothing in it but
      // those, letters, digits, `-` and `.` — `_` is one
      if (
        !/^[A-Za-z][^\s\0/>]*$/.test(name) &&
        !/^[:_\u0080-\uffff][\w\-.:\u0080-\uffff]*$/.test(name)
      ) {
        throw new DOMException(
          `The tag name provided ('${name}') is not a valid name.`,
          'InvalidCharacterError',
        );
      }
      const ns = !this._type
        ? ''
        : this._type === 'application/xhtml+xml'
          ? HTML_NS
          : '~';
      if (ns === '' && this === document && customElementsDefined) {
        const made = createCustom(name, isOption(options));
        if (made) return made;
      }
      return wrap(Number(call('create', 'element', name, this._id, ns)));
    }
    /** An element in a namespace, its name a qualified one (DOM 4.5,
     *  "validate and extract"). */
    createElementNS(namespace: Any, qualifiedName: Any, options?: Any): Any {
      const ns =
        namespace === null || namespace === undefined || namespace === ''
          ? null
          : str(namespace);
      const qualified = str(qualifiedName);
      const colon = qualified.indexOf(':');
      const prefix = colon < 0 ? null : qualified.slice(0, colon);
      const local = colon < 0 ? qualified : qualified.slice(colon + 1);
      if (
        (prefix !== null && !/^[^\s\0/>]+$/.test(prefix)) ||
        (!/^[A-Za-z][^\s\0/>]*$/.test(local) &&
          !/^[:_\u0080-\uffff][\w\-.:\u0080-\uffff]*$/.test(local))
      ) {
        throw new DOMException(
          `The qualified name provided ('${qualified}') contains the invalid name-start character.`,
          'InvalidCharacterError',
        );
      }
      if (
        (prefix !== null && ns === null) ||
        (prefix === 'xml' && ns !== XML_NS) ||
        (qualified === 'xmlns' || prefix === 'xmlns') !== (ns === XMLNS_NS)
      ) {
        throw new DOMException(
          `The namespace and the qualified name ('${qualified}') do not go together.`,
          'NamespaceError',
        );
      }
      if (
        ns === HTML_NS &&
        prefix === null &&
        this === document &&
        customElementsDefined
      ) {
        const made = createCustom(local, isOption(options));
        if (made) return made;
      }
      return wrap(
        Number(call('create', 'element', qualified, this._id, ns ?? '~')),
      );
    }
    createTextNode(data: Any): Any {
      return wrap(Number(call('create', 'text', str(data), this._id)));
    }
    createAttribute(name: Any): Any {
      const n = str(name).toLowerCase();
      if (!/^[^\s\0/=>"']+$/.test(n)) {
        throw new DOMException(
          `The localName provided ('${n}') contains an invalid character.`,
          'InvalidCharacterError',
        );
      }
      return new Attr(n, null);
    }
    createAttributeNS(_ns: Any, name: Any): Any {
      return this.createAttribute(String(name).replace(/^.*:/, ''));
    }
    createComment(data: Any): Any {
      return wrap(Number(call('create', 'comment', str(data), this._id)));
    }
    createDocumentFragment(): Any {
      return wrap(Number(call('create', 'fragment', '', this._id)));
    }
    createEvent(kind: Any): Any {
      const k = str(kind).toLowerCase();
      const Kind = k.startsWith('mouse')
        ? MouseEvent
        : k.startsWith('keyboard')
          ? KeyboardEvent
          : k.startsWith('custom')
            ? CustomEvent
            : k.startsWith('ui')
              ? UIEvent
              : Event;
      return new Kind('');
    }
    createRange(): Any {
      return rangeIn(this);
    }
    createTreeWalker(root: Any, whatToShow?: Any, filter?: Any): Any {
      idOf(
        root,
        "Failed to execute 'createTreeWalker' on 'Document': parameter 1",
      );
      return new TreeWalker(root, whatToShow, filter);
    }
    createNodeIterator(root: Any, whatToShow?: Any, filter?: Any): Any {
      idOf(
        root,
        "Failed to execute 'createNodeIterator' on 'Document': parameter 1",
      );
      return new NodeIterator(root, whatToShow, filter);
    }
    importNode(node: Any, deep = false): Any {
      return wrap(Number(call('import', idOf(node), !!deep, this._id)));
    }
    adoptNode(node: Any): Any {
      call('adoptNode', idOf(node), this._id);
      return node;
    }
    elementFromPoint(x: number, y: number): Any {
      return wrap(Number(call('at', Number(x), Number(y))));
    }
    elementsFromPoint(x: number, y: number): Any[] {
      const top = this.elementFromPoint(x, y);
      const out: Any[] = [];
      for (let at = top; at; at = at.parentElement) out.push(at);
      return out;
    }
    getSelection(): Any {
      return G.getSelection();
    }
    /** The boundary point nearest a point of the viewport's (CSSOM View
     *  6): in the text the document draws there. */
    caretPositionFromPoint(x: Any, y: Any): Any {
      const at = String(call('textAt', Number(x), Number(y)));
      if (!at) return null;
      const [id, offset] = at.split(',');
      const node = wrap(Number(id));
      return node ? new CaretPosition(node, Number(offset)) : null;
    }
    caretRangeFromPoint(x: Any, y: Any): Any {
      const at = this.caretPositionFromPoint(x, y);
      if (!at) return null;
      const range = this.createRange();
      range.setStart(at.offsetNode, at.offset);
      return range;
    }
    /** `document.write`: what a script the parser met writes goes in after
     *  it, as the parser would have read it there. Anywhere else — a script
     *  that runs once the parse has ended, which in a browser would replace
     *  the document — it is refused. */
    write(...parts: Any[]): void {
      const text = parts.map((p) => str(p)).join('');
      if (this !== document) {
        // a document of the page's own, a frame's among them: what is
        // written since `open` is its markup at `close`, and a write to
        // one not opened opens it, as HTML's has it
        if (this._written == null) this.open();
        this._written += text;
        return;
      }
      if (call('write', text) === true) return;
      bridge(
        'log',
        'warn',
        'document.write was ignored: only a script the parser runs as it meets it writes into the document here.',
      );
    }
    writeln(...parts: Any[]): void {
      this.write(...parts, '\n');
    }
    open(): Any {
      // `== null`: a wrapper is made without its class's fields
      if (this !== document && this._written == null) this._written = '';
      return this;
    }
    close(): void {
      if (this === document || this._written == null) return;
      const markup = this._written;
      this._written = null;
      call('fillDocument', this._id, markup);
    }
  }
  /** A document made of XML's rules: `createDocument`'s. */
  class XMLDocument extends Document {}
  Object.defineProperty(Document.prototype, 'nodeType', nodeTypeOf(9));

  // --- ranges -------------------------------------------------------------------
  //
  // A live range is the host's (`ranges.ts`), which moves it as the tree
  // changes; a `Range` holds its id, and lets it go when the page does.

  const rangesHeld = RealFinalizationRegistry
    ? new RealFinalizationRegistry((id: number) => {
        bridge('rangeDrop', id);
      })
    : null;
  /** The document a `Range` being made starts in: `createRange`'s, or the
   *  page's for `new Range()`. */
  let rangeDocument: Any = null;
  const rangeIn = (doc: Any): Any => {
    rangeDocument = doc;
    try {
      return new Range();
    } finally {
      rangeDocument = null;
    }
  };
  const held = (range: Any, id: number): Any => {
    range._id = id;
    rangesHeld?.register(range, id);
    return range;
  };

  class CaretPosition {
    constructor(
      readonly offsetNode: Any,
      readonly offset: number,
    ) {}
    getClientRect(): Any {
      const range = document.createRange();
      range.setStart(this.offsetNode, this.offset);
      return range.getBoundingClientRect();
    }
  }

  class AbstractRange {
    _id = 0;
    /** The two boundary points, as the host has them now. */
    _points(): [Any, number, Any, number] {
      const [a, b, c, d] = String(call('rangeGet', this._id)).split(',');
      return [wrap(Number(a)), Number(b), wrap(Number(c)), Number(d)];
    }
    get startContainer(): Any {
      return this._points()[0];
    }
    get startOffset(): number {
      return this._points()[1];
    }
    get endContainer(): Any {
      return this._points()[2];
    }
    get endOffset(): number {
      return this._points()[3];
    }
    get collapsed(): boolean {
      const [a, b, c, d] = String(call('rangeGet', this._id)).split(',');
      return a === c && b === d;
    }
  }
  class Range extends AbstractRange {
    static readonly START_TO_START = 0;
    static readonly START_TO_END = 1;
    static readonly END_TO_END = 2;
    static readonly END_TO_START = 3;
    constructor() {
      super();
      held(this, Number(call('rangeNew', (rangeDocument ?? document)._id)));
    }
    get commonAncestorContainer(): Any {
      return wrap(Number(call('rangeCommon', this._id)));
    }
    setStart(node: Any, offset: Any): void {
      call('rangeSet', this._id, idOf(node), Number(offset) >>> 0, true);
    }
    setEnd(node: Any, offset: Any): void {
      call('rangeSet', this._id, idOf(node), Number(offset) >>> 0, false);
    }
    setStartBefore(node: Any): void {
      call('rangeBeside', this._id, idOf(node), 'startBefore');
    }
    setStartAfter(node: Any): void {
      call('rangeBeside', this._id, idOf(node), 'startAfter');
    }
    setEndBefore(node: Any): void {
      call('rangeBeside', this._id, idOf(node), 'endBefore');
    }
    setEndAfter(node: Any): void {
      call('rangeBeside', this._id, idOf(node), 'endAfter');
    }
    collapse(toStart = false): void {
      call('rangeCollapse', this._id, !!toStart);
    }
    selectNode(node: Any): void {
      call('rangeSelect', this._id, idOf(node), false);
    }
    selectNodeContents(node: Any): void {
      call('rangeSelect', this._id, idOf(node), true);
    }
    compareBoundaryPoints(how: Any, source: Any): number {
      if (!(source instanceof Range)) {
        throw new TypeError("parameter 2 is not of type 'Range'.");
      }
      return Number(
        call(
          'rangeCompare',
          this._id,
          (Number(how) >>> 0) & 0xffff,
          source._id,
        ),
      );
    }
    deleteContents(): void {
      call('rangeDelete', this._id);
    }
    extractContents(): Any {
      return wrap(Number(call('rangeContents', this._id, true)));
    }
    cloneContents(): Any {
      return wrap(Number(call('rangeContents', this._id, false)));
    }
    insertNode(node: Any): void {
      call('rangeInsert', this._id, idOf(node));
    }
    surroundContents(node: Any): void {
      call('rangeSurround', this._id, idOf(node));
    }
    cloneRange(): Any {
      return held(
        Object.create(Range.prototype),
        Number(call('rangeClone', this._id)),
      );
    }
    detach(): void {}
    isPointInRange(node: Any, offset: Any): boolean {
      return !!call(
        'rangePoint',
        this._id,
        idOf(node),
        Number(offset) >>> 0,
        false,
      );
    }
    comparePoint(node: Any, offset: Any): number {
      return Number(
        call('rangePoint', this._id, idOf(node), Number(offset) >>> 0, true),
      );
    }
    intersectsNode(node: Any): boolean {
      return !!call('rangeIntersects', this._id, idOf(node));
    }
    override toString(): string {
      return String(call('rangeText', this._id));
    }
    /** Where the range's text is drawn, a rectangle a line, as the
     *  document lays it out (CSSOM View 6.2); where it holds no text the
     *  document draws, the box of the element it is in. */
    getClientRects(): Any {
      const flat = String(call('rangeRects', this._id));
      if (!flat) return list([this._elementRect()]);
      const n = flat.split(',').map(Number);
      const v = viewport();
      const out: Any[] = [];
      for (let i = 0; i + 3 < n.length; i += 4) {
        out.push(
          new DOMRect(
            n[i] - v.scrollX,
            n[i + 1] - v.scrollY,
            n[i + 2],
            n[i + 3],
          ),
        );
      }
      return list(out);
    }
    getBoundingClientRect(): Any {
      const rects = Array.from(this.getClientRects() as Iterable<Any>);
      if (rects.length === 1) return rects[0];
      if (!rects.length) return new DOMRect();
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const r of rects) {
        left = Math.min(left, r.left);
        top = Math.min(top, r.top);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
      }
      return new DOMRect(left, top, right - left, bottom - top);
    }
    _elementRect(): Any {
      let at = this.commonAncestorContainer;
      while (at && !(at instanceof Element)) at = at.parentNode;
      return at ? at.getBoundingClientRect() : new DOMRect();
    }
    createContextualFragment(html: Any): Any {
      let context = this.startContainer;
      while (context && !(context instanceof Element)) {
        context = context.parentNode;
      }
      const doc = context?.ownerDocument ?? document;
      const fragment = doc.createDocumentFragment();
      const holder = doc.createElement(context?.localName ?? 'div');
      holder.innerHTML = html;
      while (holder.firstChild) fragment.appendChild(holder.firstChild);
      return fragment;
    }
  }
  for (const name of Object.getOwnPropertyNames(Range)) {
    if (!/^[A-Z_]+$/.test(name)) continue;
    Object.defineProperty(Range.prototype, name, {
      value: (Range as Any)[name],
      enumerable: true,
    });
  }

  /** A document's `implementation` (DOM 4.5.1): the documents and the
   *  doctypes a page makes, each of the document asked. */
  const implementationOf = (doc: Any): Any => ({
    hasFeature: () => true,
    // a document of its own, out of the one drawn: what a sanitizer
    // parses markup into, whose scripts nothing runs
    createHTMLDocument: (title?: Any) =>
      wrap(
        Number(call('newDocument', title === undefined ? null : str(title))),
      ),
    createDocumentType(name: Any, publicId: Any, systemId: Any): Any {
      const n = str(name);
      if (/[\t\n\f\r \0>]/.test(n)) {
        throw new DOMException(
          `The doctype name provided ('${n}') is not valid.`,
          'InvalidCharacterError',
        );
      }
      return wrap(
        Number(call('createDoctype', n, str(publicId), str(systemId), doc._id)),
      );
    },
    createDocument(namespace: Any, qualifiedName: Any, doctype?: Any): Any {
      const ns =
        namespace === null || namespace === undefined ? '' : str(namespace);
      const made = wrap(
        Number(
          call(
            'newXml',
            ns === HTML_NS
              ? 'application/xhtml+xml'
              : ns === SVG_NS
                ? 'image/svg+xml'
                : 'application/xml',
          ),
        ),
      );
      const qualified =
        qualifiedName === null || qualifiedName === undefined
          ? ''
          : str(qualifiedName);
      const root = qualified
        ? made.createElementNS(namespace, qualified)
        : null;
      if (doctype) made.appendChild(doctype);
      if (root) made.appendChild(root);
      return made;
    },
  });
  Object.defineProperty(Document.prototype, 'nodeName', {
    get: () => '#document',
  });

  /** The `on<type>` properties a page sets, for the events it can have. */
  for (const type of [
    'click',
    'dblclick',
    'mousedown',
    'mouseup',
    'mouseover',
    'mouseout',
    'mousemove',
    'keydown',
    'keyup',
    'keypress',
    'input',
    'change',
    'submit',
    'reset',
    'focus',
    'blur',
    'focusin',
    'focusout',
    'load',
    'error',
    'toggle',
    'scroll',
    'resize',
    'contextmenu',
    'wheel',
    'pointerdown',
    'pointerup',
    'pointermove',
    'pointerover',
    'pointerout',
    'pointerenter',
    'pointerleave',
    'gotpointercapture',
    'lostpointercapture',
    'play',
    'playing',
    'pause',
    'timeupdate',
    'seeking',
    'seeked',
    'volumechange',
    'ratechange',
  ]) {
    const property = {
      get(this: Any): Any {
        return this._handlers[type] ?? null;
      },
      set(this: Any, fn: Any) {
        this._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
    };
    Object.defineProperty(HTMLElement.prototype, `on${type}`, property);
    Object.defineProperty(Document.prototype, `on${type}`, property);
  }

  /** `CSS.escape` (CSSOM 2.1.1), for the selectors built here. */
  const cssEscape = (value: string): string => {
    let out = '';
    const first = value.charCodeAt(0);
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      if (c === 0) out += '\uFFFD';
      else if (
        (c >= 1 && c <= 0x1f) ||
        c === 0x7f ||
        (i === 0 && c >= 0x30 && c <= 0x39) ||
        (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2d)
      ) {
        out += `\\${c.toString(16)} `;
      } else if (i === 0 && c === 0x2d && value.length === 1) {
        out += `\\${value[i]}`;
      } else if (
        c >= 0x80 ||
        c === 0x2d ||
        c === 0x5f ||
        (c >= 0x30 && c <= 0x39) ||
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a)
      ) {
        out += value[i];
      } else {
        out += `\\${value[i]}`;
      }
    }
    return out;
  };

  // --- the window ------------------------------------------------------------------

  const windowTarget = new EventTarget();
  const document: Any = wrap(1);

  /** The viewport, in CSS pixels, as the host's pane has it now. */
  const viewport = (): {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    dpr: number;
  } => {
    const [width, height, scrollX, scrollY, dpr] = String(call('viewport'))
      .split(',')
      .map(Number);
    return { width, height, scrollX, scrollY, dpr };
  };

  const now = (): number => Number(bridge('now'));

  // timers: the host keeps the clock, this keeps the callbacks
  let timerSeq = 0;
  const timers = new Map<number, { fn: Any; args: Any[]; repeat: boolean }>();
  const setTimer = (fn: Any, ms: Any, args: Any[], repeat: boolean): number => {
    const id = ++timerSeq;
    timers.set(id, { fn, args, repeat });
    call('timer', id, Math.max(0, Number(ms) || 0), repeat);
    return id;
  };
  const clearTimer = (id: Any): void => {
    if (!timers.delete(Number(id))) return;
    call('clearTimer', Number(id));
  };

  // The page's `FinalizationRegistry`: its cleanup runs through a timer
  // (`setTimer` → `__timer`), which the host runs under the engine's
  // timeout, rather than from V8's platform task where nothing stops it.
  // A real registry underneath does the holding and the validation; its
  // own callback only schedules, so it stays cheap outside the timeout.
  if (RealFinalizationRegistry) {
    class PageFinalizationRegistry {
      private _fr: Any;
      constructor(cleanup: Any) {
        if (typeof cleanup !== 'function') {
          throw new TypeError(
            "Failed to construct 'FinalizationRegistry': parameter 1 is not of type 'Function'.",
          );
        }
        this._fr = new RealFinalizationRegistry((held: Any) => {
          setTimer(() => cleanup(held), 0, [], false);
        });
      }
      register(target: Any, held: Any, token?: Any): void {
        this._fr.register(target, held, token);
      }
      unregister(token: Any): boolean {
        return this._fr.unregister(token);
      }
    }
    Object.defineProperty(
      PageFinalizationRegistry.prototype,
      Symbol.toStringTag,
      {
        value: 'FinalizationRegistry',
        configurable: true,
      },
    );
    Object.defineProperty(PageFinalizationRegistry, 'name', {
      value: 'FinalizationRegistry',
      configurable: true,
    });
    G.FinalizationRegistry = PageFinalizationRegistry;
  }

  /** `location`, over the host's address for the document. */
  const location: Any = {
    get href(): string {
      return String(call('location'));
    },
    set href(v: Any) {
      call('navigate', String(call('resolve', str(v))), false);
    },
    assign(url: Any): void {
      call('navigate', String(call('resolve', str(url))), false);
    },
    replace(url: Any): void {
      call('navigate', String(call('resolve', str(url))), true);
    },
    reload(): void {
      call('reload');
    },
    toString(): string {
      return this.href;
    },
  };
  for (const part of URL_PARTS) {
    Object.defineProperty(location, part, {
      get(): string {
        return urlParts(this.href)?.[part] ?? '';
      },
      set(v: Any) {
        if (part === 'hash') {
          const hash = str(v).replace(/^#?/, '#');
          call('navigate', this.href.split('#')[0] + hash, false);
        } else {
          const url = new URL(this.href);
          (url as Any)[part] = v;
          this.href = url.href;
        }
      },
      enumerable: true,
    });
  }

  /** `URL` (WHATWG URL), its parsing the host's, which has the standard. */
  class URL {
    // its parts, on the prototype below
    declare protocol: string;
    declare host: string;
    declare hostname: string;
    declare port: string;
    declare pathname: string;
    declare search: string;
    declare hash: string;
    declare origin: string;
    _href = '';
    constructor(url: Any, base?: Any) {
      const json = call('url', str(url), base === undefined ? '' : str(base));
      if (typeof json !== 'string' || !json) {
        throw new TypeError(`Failed to construct 'URL': Invalid URL`);
      }
      this._href = JSON.parse(json).href;
    }
    static canParse(url: Any, base?: Any): boolean {
      return !!call('url', str(url), base === undefined ? '' : str(base));
    }
    /** A URL for a blob, this realm's (W3C File API 8.3). */
    static createObjectURL(blob: Any): string {
      if (!(blob instanceof Blob)) {
        throw new TypeError(
          "Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.",
        );
      }
      const origin = str(location.origin);
      const url = `blob:${origin === 'null' ? 'null' : origin}/${str(call('uuid'))}`;
      blobUrls.set(url, blob);
      return url;
    }
    static revokeObjectURL(url: Any): void {
      blobUrls.delete(str(url));
    }
    get href(): string {
      return this._href;
    }
    set href(v: Any) {
      this._href = new URL(v).href;
    }
    get searchParams(): Any {
      const params = new URLSearchParams(this.search);
      params._url = this;
      return params;
    }
    toString(): string {
      return this._href;
    }
    toJSON(): string {
      return this._href;
    }
  }
  for (const part of URL_PARTS) {
    Object.defineProperty(URL.prototype, part, {
      get(this: Any): string {
        return urlParts(this._href)?.[part] ?? '';
      },
      set(this: Any, v: Any) {
        const json = call('setUrl', this._href, part, str(v));
        if (typeof json === 'string' && json)
          this._href = JSON.parse(json).href;
      },
      configurable: true,
    });
  }

  class URLSearchParams {
    _list: [string, string][] = [];
    _url: Any = null;
    constructor(init: Any = '') {
      if (typeof init === 'string') {
        for (const part of init.replace(/^\?/, '').split('&')) {
          if (!part) continue;
          const eq = part.indexOf('=');
          const name = eq < 0 ? part : part.slice(0, eq);
          const value = eq < 0 ? '' : part.slice(eq + 1);
          this._list.push([decode(name), decode(value)]);
        }
      } else if (init && typeof init[Symbol.iterator] === 'function') {
        for (const [k, v] of init) this._list.push([str(k), str(v)]);
      } else if (init && typeof init === 'object') {
        for (const k of Object.keys(init)) this._list.push([k, str(init[k])]);
      }
    }
    _update(): void {
      if (this._url) this._url.search = this.toString();
    }
    get size(): number {
      return this._list.length;
    }
    append(k: Any, v: Any): void {
      this._list.push([str(k), str(v)]);
      this._update();
    }
    delete(k: Any): void {
      this._list = this._list.filter(([n]) => n !== str(k));
      this._update();
    }
    get(k: Any): string | null {
      return this._list.find(([n]) => n === str(k))?.[1] ?? null;
    }
    getAll(k: Any): string[] {
      return this._list.filter(([n]) => n === str(k)).map(([, v]) => v);
    }
    has(k: Any): boolean {
      return this._list.some(([n]) => n === str(k));
    }
    set(k: Any, v: Any): void {
      const at = this._list.findIndex(([n]) => n === str(k));
      if (at < 0) this._list.push([str(k), str(v)]);
      else {
        this._list[at] = [str(k), str(v)];
        this._list = this._list.filter(([n], i) => i <= at || n !== str(k));
      }
      this._update();
    }
    sort(): void {
      this._list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      this._update();
    }
    forEach(fn: Any, self?: Any): void {
      for (const [k, v] of this._list) fn.call(self, v, k, this);
    }
    keys(): Any {
      return this._list.map(([k]) => k)[Symbol.iterator]();
    }
    values(): Any {
      return this._list.map(([, v]) => v)[Symbol.iterator]();
    }
    entries(): Any {
      return this._list.map(([k, v]) => [k, v])[Symbol.iterator]();
    }
    [Symbol.iterator](): Any {
      return this.entries();
    }
    toString(): string {
      return this._list.map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&');
    }
  }
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return s;
    }
  };
  const encode = (s: string): string =>
    encodeURIComponent(s)
      .replace(/%20/g, '+')
      .replace(
        /[!'()~]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );

  /** `Headers`, a list of names and values, names lowercased. */
  class Headers {
    _map = new Map<string, string>();
    constructor(init: Any = {}) {
      if (init instanceof Headers) init = Array.from(init._map.entries());
      if (Array.isArray(init)) for (const [k, v] of init) this.append(k, v);
      else if (init && typeof init === 'object') {
        for (const k of Object.keys(init)) this.append(k, init[k]);
      }
    }
    append(k: Any, v: Any): void {
      const key = str(k).toLowerCase();
      const had = this._map.get(key);
      this._map.set(key, had === undefined ? str(v) : `${had}, ${str(v)}`);
    }
    set(k: Any, v: Any): void {
      this._map.set(str(k).toLowerCase(), str(v));
    }
    get(k: Any): string | null {
      return this._map.get(str(k).toLowerCase()) ?? null;
    }
    has(k: Any): boolean {
      return this._map.has(str(k).toLowerCase());
    }
    delete(k: Any): void {
      this._map.delete(str(k).toLowerCase());
    }
    forEach(fn: Any, self?: Any): void {
      for (const [k, v] of this._map) fn.call(self, v, k, this);
    }
    entries(): Any {
      return this._map.entries();
    }
    keys(): Any {
      return this._map.keys();
    }
    values(): Any {
      return this._map.values();
    }
    [Symbol.iterator](): Any {
      return this._map.entries();
    }
  }

  /** Bytes from base64: what the network's bytes and a worker's buffers
   *  cross the bridge as (`__fetched`, `deserializeClone`). The runtime's
   *  own decoder where it has one (Node 26, Bun), and elsewhere a loop over
   *  a table four letters at a time, where `atob` would build a string a
   *  character at a time: three.js's texture worker hands a page hundreds
   *  of megabytes of pixels, and a letter at a time was ten seconds of
   *  up.com.au's first half minute. */
  const B64 = new Uint8Array(128);
  for (let i = 0; i < 64; i += 1) {
    B64[
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(
        i,
      )
    ] = i;
  }
  function bytesOfBase64(text: string): Uint8Array {
    const native = (Uint8Array as Any).fromBase64;
    if (typeof native === 'function') {
      try {
        return native.call(Uint8Array, text);
      } catch {
        // not padded as the runtime's wants: the loop takes it
      }
    }
    const table = B64;
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === 61) end -= 1;
    const out = new Uint8Array(Math.floor((end * 3) / 4));
    let o = 0;
    let i = 0;
    for (; i + 4 <= end; i += 4) {
      const n =
        (table[text.charCodeAt(i) & 127] << 18) |
        (table[text.charCodeAt(i + 1) & 127] << 12) |
        (table[text.charCodeAt(i + 2) & 127] << 6) |
        table[text.charCodeAt(i + 3) & 127];
      out[o] = n >> 16;
      out[o + 1] = (n >> 8) & 255;
      out[o + 2] = n & 255;
      o += 3;
    }
    // the last two or three letters, two or one byte
    if (i < end) {
      let n = 0;
      let bits = 0;
      for (; i < end; i += 1) {
        n = (n << 6) | table[text.charCodeAt(i) & 127];
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out[o++] = (n >> bits) & 255;
        }
      }
    }
    return out;
  }

  class Response {
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    readonly headers: Any;
    readonly redirected: boolean;
    /** `basic` for the page's own origin, `cors` for another's that let it
     *  read, `opaque` for a `no-cors` request's, which it may not. */
    readonly type: string;
    /** The body as text, where it was given as text, */
    _body: string;
    /** or its bytes, where it was given as bytes — a buffer, a view or a
     *  `Blob`, and what the network answered (`__fetched`): a `.wasm`, an
     *  image, a font, which no text decoding may pass through. */
    _raw: Uint8Array | null = null;
    bodyUsed = false;
    constructor(body: Any = '', init: Any = {}) {
      this._body = '';
      // a stream is read as it is asked for: three.js's loaders hand a
      // fetch's body on through one, to count its progress
      if (body instanceof ReadableStream) this._stream = body;
      else if (body instanceof ArrayBuffer)
        this._raw = new Uint8Array(body.slice(0));
      else if (ArrayBuffer.isView(body)) {
        this._raw = new Uint8Array(
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        );
      } else if (body instanceof Blob) this._raw = body._bytes;
      else this._body = body === null ? '' : str(body);
      this.type = init.type === undefined ? 'default' : str(init.type);
      this.status = Number(init.status ?? 200);
      this.statusText = String(init.statusText ?? '');
      this.headers = new Headers(init.headers ?? {});
      this.url = String(init.url ?? '');
      this.redirected = !!init.redirected;
    }
    get ok(): boolean {
      return this.status >= 200 && this.status < 300;
    }
    /** The body's bytes, read once, as every method reads it. */
    _bytes(): Uint8Array {
      if (this.bodyUsed) throw new TypeError('Body has already been consumed.');
      this.bodyUsed = true;
      return this._raw ?? new TextEncoder().encode(this._body);
    }
    _read(): string {
      if (this.bodyUsed) throw new TypeError('Body has already been consumed.');
      if (this._raw) return new TextDecoder().decode(this._bytes());
      this.bodyUsed = true;
      return this._body;
    }
    /** A body given as a stream, read to its end: the bytes of each chunk,
     *  which has to be a view of them (Fetch, "extract a body"). */
    async _drain(): Promise<Uint8Array> {
      if (this.bodyUsed) throw new TypeError('Body has already been consumed.');
      this.bodyUsed = true;
      const reader = this._stream.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw new TypeError(
            'Failed to read the stream: the chunk is not a Uint8Array.',
          );
        }
        chunks.push(value);
        length += value.length;
      }
      const out = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    }
    text(): Promise<string> {
      if (this._given()) {
        return this._drain().then((bytes) => new TextDecoder().decode(bytes));
      }
      try {
        return Promise.resolve(this._read());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    json(): Promise<Any> {
      return this.text().then((t) => JSON.parse(t));
    }
    bytes(): Promise<Uint8Array> {
      if (this._given()) return this._drain();
      try {
        return Promise.resolve(new Uint8Array(this._bytes()));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    /** Whether the body is a stream the page gave, rather than one this
     *  made of the bytes it holds. */
    _given(): boolean {
      return !!this._stream && !this._made;
    }
    arrayBuffer(): Promise<ArrayBuffer> {
      return this.bytes().then((bytes) => bytes.buffer as ArrayBuffer);
    }
    blob(): Promise<Any> {
      return this.bytes().then(
        (bytes) =>
          new Blob([bytes], { type: this.headers.get('content-type') ?? '' }),
      );
    }
    /** The body as a stream of its bytes, read once, as the methods read
     *  it: what the app router of Next.js reads a server's payload with. */
    get body(): Any {
      if (this._stream) return this._stream;
      const response = this;
      this._made = true;
      this._stream = new ReadableStream({
        pull(controller: Any) {
          const bytes = response._bytes();
          if (bytes.length) controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
      return this._stream;
    }
    _stream: Any = null;
    _made = false;
    clone(): Any {
      if (this.bodyUsed) throw new TypeError('Response body is already used');
      if (this._given()) {
        const [mine, theirs] = this._stream.tee();
        this._stream = mine;
        return new Response(theirs, this);
      }
      return new Response(this._raw ?? this._body, this);
    }
  }

  // `fetch`: the request is the host's, which keeps the browser's network
  // policy and CORS (`_fetchFor`)
  let fetchSeq = 0;
  const fetches = new Map<number, { resolve: Any; reject: Any }>();
  const fetch = (input: Any, init: Any = {}): Promise<Any> =>
    new Promise((resolve, reject) => {
      const id = ++fetchSeq;
      const request = input instanceof Request ? input : null;
      const url =
        typeof input === 'string' ? input : (input?.url ?? str(input));
      // a blob URL is this realm's, read here
      if (url.startsWith('blob:')) {
        const blob = blobUrls.get(url);
        if (!blob) {
          reject(new TypeError('Failed to fetch'));
          return;
        }
        const response = new Response(blob, {
          status: 200,
          headers: blob.type ? { 'content-type': blob.type } : {},
          url,
          type: 'basic',
        });
        resolve(response);
        return;
      }
      const headers = new Headers(init.headers ?? input?.headers ?? {});
      let body = init.body ?? request?._body ?? null;
      init = {
        ...init,
        method: init.method ?? request?.method,
        signal: init.signal ?? request?.signal,
      };
      if (body instanceof FormData) {
        // multipart, as a browser sends one (HTML 4.10.21.8); a file's
        // part is its bytes as UTF-8 text, the bridge carrying text
        const boundary = `----formdata-${Math.random().toString(36).slice(2)}`;
        let out = '';
        for (const [name, value] of body._entries) {
          const file = value instanceof File;
          const quoted = (s: string) =>
            s.replace(/"/g, '%22').replace(/\r?\n|\r/g, '%0D%0A');
          out += `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"`;
          if (file) {
            out += `; filename="${quoted(value.name)}"\r\nContent-Type: ${value.type || 'application/octet-stream'}`;
          }
          out += `\r\n\r\n${file ? new TextDecoder().decode(value._bytes) : value}\r\n`;
        }
        body = `${out}--${boundary}--\r\n`;
        headers.set(
          'content-type',
          `multipart/form-data; boundary=${boundary}`,
        );
      } else if (body instanceof Blob) {
        if (body.type && !headers.has('content-type')) {
          headers.set('content-type', body.type);
        }
        body = new TextDecoder().decode(body._bytes);
      } else if (body instanceof URLSearchParams) {
        body = body.toString();
        if (!headers.has('content-type')) {
          headers.set(
            'content-type',
            'application/x-www-form-urlencoded;charset=UTF-8',
          );
        }
      } else if (body !== null && typeof body !== 'string') {
        body = str(body);
      }
      if (init.signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      fetches.set(id, { resolve, reject });
      init.signal?.addEventListener?.('abort', () => {
        if (!fetches.delete(id)) return;
        call('abortFetch', id);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
      call(
        'fetch',
        id,
        JSON.stringify({
          url: str(url),
          method: str(init.method ?? 'GET').toUpperCase(),
          headers: Array.from(headers._map.entries()),
          body,
          // what the host checks another origin's answer against
          mode: str(init.mode ?? request?.mode ?? 'cors'),
          credentials: str(
            init.credentials ?? request?.credentials ?? 'same-origin',
          ),
        }),
      );
    });

  /** `Request` (Fetch 6.3): what a page hands `fetch`, or keeps, or
   *  compares one with. Its body is text, as a response's is. */
  class Request {
    readonly url: string;
    readonly method: string;
    readonly headers: Any;
    readonly signal: Any;
    readonly mode: string;
    readonly credentials: string;
    readonly cache: string;
    readonly redirect: string;
    readonly referrer = 'about:client';
    readonly referrerPolicy = '';
    readonly integrity = '';
    readonly keepalive: boolean;
    readonly destination = '';
    _body: Any;
    bodyUsed = false;
    constructor(input: Any, init: Any = {}) {
      const from = input instanceof Request ? input : null;
      this.url = new URL(from ? from.url : str(input), location.href).href;
      this.method = str(init.method ?? from?.method ?? 'GET').toUpperCase();
      this.headers = new Headers(init.headers ?? from?.headers ?? {});
      this.signal = init.signal ?? from?.signal ?? new AbortController().signal;
      this.mode = str(init.mode ?? from?.mode ?? 'cors');
      this.credentials = str(
        init.credentials ?? from?.credentials ?? 'same-origin',
      );
      this.cache = str(init.cache ?? from?.cache ?? 'default');
      this.redirect = str(init.redirect ?? from?.redirect ?? 'follow');
      this.keepalive = !!(init.keepalive ?? from?.keepalive);
      this._body = init.body ?? from?._body ?? null;
      if (
        this._body !== null &&
        (this.method === 'GET' || this.method === 'HEAD')
      ) {
        throw new TypeError(
          "Failed to construct 'Request': Request with GET/HEAD method cannot have body.",
        );
      }
    }
    get body(): Any {
      return this._body === null ? null : new Response(this._body).body;
    }
    clone(): Any {
      return new Request(this);
    }
    text(): Promise<string> {
      if (this.bodyUsed)
        return Promise.reject(new TypeError('Body has already been consumed.'));
      this.bodyUsed = true;
      return new Response(this._body).text();
    }
    json(): Promise<Any> {
      return this.text().then((t) => JSON.parse(t));
    }
    arrayBuffer(): Promise<ArrayBuffer> {
      return this.text().then(
        (t) => new TextEncoder().encode(t).buffer as ArrayBuffer,
      );
    }
    blob(): Promise<Any> {
      return this.text().then((t) => new Blob([t]));
    }
  }

  /** What an `XMLHttpRequest` tells of its progress (XHR 6). */
  class ProgressEvent extends Event {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.lengthComputable = !!init.lengthComputable;
      this.loaded = Number(init.loaded ?? 0);
      this.total = Number(init.total ?? 0);
    }
  }

  /**
   * `XMLHttpRequest`, over `fetch`: under the same CORS, through the same
   * network, and asynchronous only — a synchronous one would hold the
   * page's thread for the network, which here is the tab's, and no `vm`
   * timeout covers a wait on a socket. What `responseType` reads is text,
   * JSON or an `ArrayBuffer`; a `document` and a `Blob` are not here.
   */
  class XMLHttpRequest extends EventTarget {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly HEADERS_RECEIVED = 2;
    static readonly LOADING = 3;
    static readonly DONE = 4;
    readonly UNSENT = 0;
    readonly OPENED = 1;
    readonly HEADERS_RECEIVED = 2;
    readonly LOADING = 3;
    readonly DONE = 4;
    readyState = 0;
    status = 0;
    statusText = '';
    responseURL = '';
    responseType = '';
    timeout = 0;
    withCredentials = false;
    readonly upload = new EventTarget();
    _method = 'GET';
    _url = '';
    _headers = new Headers();
    _response: Any = null;
    _text = '';
    _sent = false;
    /** Which `send()` is under way: one an `abort()` or an `open()` left
     *  behind answers nothing. */
    _attempt = 0;
    _controller: Any = null;
    open(method: Any, url: Any, async: Any = true): void {
      if (arguments.length > 2 && !async) {
        throw new DOMException(
          'A synchronous XMLHttpRequest would hold the page for the network; this page has only asynchronous ones.',
          'InvalidAccessError',
        );
      }
      this._attempt += 1;
      this._controller?.abort();
      this._controller = null;
      this._method = str(method).toUpperCase();
      this._url = str(url);
      this._headers = new Headers();
      this._response = null;
      this._text = '';
      this._raw = new Uint8Array(0);
      this._sent = false;
      this.status = 0;
      this.statusText = '';
      this.responseURL = '';
      this._state(1);
    }
    setRequestHeader(name: Any, value: Any): void {
      if (this.readyState !== 1 || this._sent) {
        throw new DOMException(
          "Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.",
          'InvalidStateError',
        );
      }
      this._headers.append(name, value);
    }
    send(body: Any = null): void {
      if (this.readyState !== 1 || this._sent) {
        throw new DOMException(
          "Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.",
          'InvalidStateError',
        );
      }
      this._sent = true;
      const attempt = this._attempt;
      const controller = new AbortController();
      this._controller = controller;
      const bodyless = this._method === 'GET' || this._method === 'HEAD';
      this._progress('loadstart');
      let timer = 0;
      if (this.timeout > 0) {
        timer = setTimer(
          () => {
            if (attempt !== this._attempt || this.readyState === 4) return;
            this._attempt += 1;
            controller.abort();
            this._fail('timeout');
          },
          this.timeout,
          [],
          false,
        );
      }
      fetch(this._url, {
        method: this._method,
        headers: this._headers,
        body: bodyless ? null : body,
        signal: controller.signal,
        credentials: this.withCredentials ? 'include' : 'same-origin',
      }).then(
        (response: Any) => {
          if (attempt !== this._attempt) return undefined;
          this._response = response;
          this.status = response.status;
          this.statusText = response.statusText;
          this.responseURL = response.url;
          this._state(2);
          return response.bytes().then((bytes: Uint8Array) => {
            if (attempt !== this._attempt) return;
            this._raw = bytes;
            this._text = this._decode(bytes);
            this._state(3);
            const size = {
              lengthComputable: true,
              loaded: bytes.length,
              total: bytes.length,
            };
            this._progress('progress', size);
            clearTimer(timer);
            this._state(4);
            this._progress('load', size);
            this._progress('loadend', size);
          });
        },
        () => {
          if (attempt !== this._attempt) return;
          clearTimer(timer);
          this._fail('error');
        },
      );
    }
    abort(): void {
      const under = this._sent && this.readyState !== 4;
      this._attempt += 1;
      this._controller?.abort();
      this._controller = null;
      if (under) this._fail('abort');
      // where it ends, after the events (XHR 3.6.7)
      if (this.readyState === 4) {
        this.readyState = 0;
        this._sent = false;
      }
    }
    getResponseHeader(name: Any): string | null {
      if (this.readyState < 2 || !this._response) return null;
      return this._response.headers.get(name);
    }
    getAllResponseHeaders(): string {
      if (this.readyState < 2 || !this._response) return '';
      const lines: string[] = [];
      this._response.headers.forEach((value: string, name: string) => {
        lines.push(`${name}: ${value}\r\n`);
      });
      return lines.sort().join('');
    }
    overrideMimeType(): void {}
    get responseText(): string {
      if (this.responseType !== '' && this.responseType !== 'text') {
        throw new DOMException(
          "Failed to read 'responseText': the value is only accessible if the object's 'responseType' is '' or 'text'.",
          'InvalidStateError',
        );
      }
      return this.readyState >= 3 ? this._text : '';
    }
    get response(): Any {
      const type = this.responseType;
      if (type === '' || type === 'text') return this.responseText;
      if (this.readyState !== 4) return null;
      if (type === 'json') {
        try {
          return JSON.parse(this._text);
        } catch {
          return null;
        }
      }
      if (type === 'arraybuffer') return this._raw.slice().buffer;
      if (type === 'blob') {
        return new Blob([this._raw], {
          type: this._response?.headers.get('content-type') ?? '',
        });
      }
      return null;
    }
    /** The body's bytes, which `arraybuffer` and `blob` are made of. */
    _raw: Uint8Array = new Uint8Array(0);
    /** A text response (XHR 3.6.9): the bytes decoded as the response's
     *  charset says, and as UTF-8 where it names none this decodes. */
    _decode(bytes: Uint8Array): string {
      const type = this._response?.headers.get('content-type') ?? '';
      const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1];
      try {
        return new TextDecoder(charset ?? 'utf-8').decode(bytes);
      } catch {
        return new TextDecoder().decode(bytes);
      }
    }
    get responseXML(): null {
      return null;
    }
    /** The request failed, timed out or was aborted: done, and said so. */
    _fail(type: 'error' | 'timeout' | 'abort'): void {
      this.status = 0;
      this.statusText = '';
      this._response = null;
      this._text = '';
      this._raw = new Uint8Array(0);
      this._state(4);
      this._progress(type);
      this._progress('loadend');
    }
    _state(state: number): void {
      this.readyState = state;
      const ev = new Event('readystatechange');
      ev.isTrusted = true;
      dispatch(this, ev);
    }
    _progress(type: string, init: Any = {}): void {
      const ev = new ProgressEvent(type, init);
      ev.isTrusted = true;
      dispatch(this, ev);
    }
  }
  for (const type of [
    'readystatechange',
    'loadstart',
    'progress',
    'load',
    'error',
    'abort',
    'timeout',
    'loadend',
  ]) {
    Object.defineProperty(XMLHttpRequest.prototype, `on${type}`, {
      get(this: Any): Any {
        return this._handlers[type] ?? null;
      },
      set(this: Any, fn: Any) {
        this._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
    });
  }

  // --- traversal (DOM 6) ---------------------------------------------------

  const NodeFilter = {
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
    SHOW_ALL: 0xffffffff,
    SHOW_ELEMENT: 0x1,
    SHOW_ATTRIBUTE: 0x2,
    SHOW_TEXT: 0x4,
    SHOW_CDATA_SECTION: 0x8,
    SHOW_ENTITY_REFERENCE: 0x10,
    SHOW_ENTITY: 0x20,
    SHOW_PROCESSING_INSTRUCTION: 0x40,
    SHOW_COMMENT: 0x80,
    SHOW_DOCUMENT: 0x100,
    SHOW_DOCUMENT_TYPE: 0x200,
    SHOW_DOCUMENT_FRAGMENT: 0x400,
    SHOW_NOTATION: 0x800,
  };

  /** What a traversal's `whatToShow` and `filter` say of a node (DOM 6.1,
   *  "filter"): shown or not by its type, and then the filter's answer. */
  class Traversal {
    readonly root: Any;
    readonly whatToShow: number;
    readonly filter: Any;
    _active = false;
    constructor(root: Any, whatToShow: Any, filter: Any) {
      this.root = root;
      this.whatToShow =
        whatToShow === undefined
          ? NodeFilter.SHOW_ALL
          : Number(whatToShow) >>> 0;
      this.filter = filter ?? null;
    }
    _accept(node: Any): number {
      if (this._active) {
        throw new DOMException(
          'A traversal is already running.',
          'InvalidStateError',
        );
      }
      if (!((1 << (node.nodeType - 1)) & this.whatToShow)) return 3;
      const filter = this.filter;
      if (!filter) return 1;
      this._active = true;
      try {
        const answer =
          typeof filter === 'function'
            ? filter.call(undefined, node)
            : filter.acceptNode(node);
        return Number(answer);
      } finally {
        this._active = false;
      }
    }
  }

  class TreeWalker extends Traversal {
    currentNode: Any;
    constructor(root: Any, whatToShow: Any, filter: Any) {
      super(root, whatToShow, filter);
      this.currentNode = root;
    }
    parentNode(): Any {
      let node = this.currentNode;
      while (node && node !== this.root) {
        node = node.parentNode;
        if (node && this._accept(node) === 1) return (this.currentNode = node);
      }
      return null;
    }
    _children(first: boolean): Any {
      let node = first
        ? this.currentNode.firstChild
        : this.currentNode.lastChild;
      while (node) {
        const result = this._accept(node);
        if (result === 1) return (this.currentNode = node);
        if (result === 3) {
          const child = first ? node.firstChild : node.lastChild;
          if (child) {
            node = child;
            continue;
          }
        }
        while (node) {
          const sibling = first ? node.nextSibling : node.previousSibling;
          if (sibling) {
            node = sibling;
            break;
          }
          const parent = node.parentNode;
          if (!parent || parent === this.root || parent === this.currentNode) {
            return null;
          }
          node = parent;
        }
      }
      return null;
    }
    firstChild(): Any {
      return this._children(true);
    }
    lastChild(): Any {
      return this._children(false);
    }
    _siblings(next: boolean): Any {
      let node = this.currentNode;
      if (node === this.root) return null;
      for (;;) {
        let sibling = next ? node.nextSibling : node.previousSibling;
        while (sibling) {
          node = sibling;
          const result = this._accept(node);
          if (result === 1) return (this.currentNode = node);
          sibling = next ? node.firstChild : node.lastChild;
          if (result === 2 || !sibling) {
            sibling = next ? node.nextSibling : node.previousSibling;
          }
        }
        node = node.parentNode;
        if (!node || node === this.root) return null;
        if (this._accept(node) === 1) return null;
      }
    }
    nextSibling(): Any {
      return this._siblings(true);
    }
    previousSibling(): Any {
      return this._siblings(false);
    }
    previousNode(): Any {
      let node = this.currentNode;
      while (node !== this.root) {
        let sibling = node.previousSibling;
        while (sibling) {
          node = sibling;
          let result = this._accept(node);
          while (result !== 2 && node.lastChild) {
            node = node.lastChild;
            result = this._accept(node);
          }
          if (result === 1) return (this.currentNode = node);
          sibling = node.previousSibling;
        }
        if (node === this.root || !node.parentNode) return null;
        node = node.parentNode;
        if (this._accept(node) === 1) return (this.currentNode = node);
      }
      return null;
    }
    nextNode(): Any {
      let node = this.currentNode;
      let result = 1;
      for (;;) {
        while (result !== 2 && node.firstChild) {
          node = node.firstChild;
          result = this._accept(node);
          if (result === 1) return (this.currentNode = node);
        }
        let sibling = null;
        let at = node;
        while (at) {
          if (at === this.root) return null;
          sibling = at.nextSibling;
          if (sibling) break;
          at = at.parentNode;
        }
        if (!sibling) return null;
        node = sibling;
        result = this._accept(node);
        if (result === 1) return (this.currentNode = node);
      }
    }
  }

  const iteratorsHeld = RealFinalizationRegistry
    ? new RealFinalizationRegistry((id: number) => {
        bridge('iterDrop', id);
      })
    : null;

  /** `NodeIterator` (DOM 6.1): the tree in document order from `root`,
   *  with a reference node it is before or after. */
  class NodeIterator extends Traversal {
    _id: number;
    constructor(root: Any, whatToShow: Any, filter: Any) {
      super(root, whatToShow, filter);
      // where it is is the host's, which moves it off a node a removal
      // takes (`ranges.ts`, `NodeIterators`)
      this._id = Number(call('iterNew', idOf(root)));
      iteratorsHeld?.register(this, this._id);
    }
    get referenceNode(): Any {
      return wrap(Number(String(call('iterGet', this._id)).split(',')[0]));
    }
    get pointerBeforeReferenceNode(): boolean {
      return String(call('iterGet', this._id)).endsWith(',true');
    }
    _traverse(next: boolean): Any {
      let accepted = false;
      try {
        for (;;) {
          const node = wrap(Number(call('iterStep', this._id, next)));
          if (!node) return null;
          if (this._accept(node) === 1) {
            accepted = true;
            return node;
          }
        }
      } finally {
        call('iterEnd', this._id, accepted);
      }
    }
    nextNode(): Any {
      return this._traverse(true);
    }
    previousNode(): Any {
      return this._traverse(false);
    }
    detach(): void {}
  }

  /** `DOMParser`: markup made a document of its own, as
   *  `createHTMLDocument` makes one — HTML only, and its scripts never run. */
  class DOMParser {
    parseFromString(markup: Any, type: Any): Any {
      const kind = str(type);
      if (kind !== 'text/html') {
        throw new DOMException(
          `Only text/html is parsed here, not ${kind}.`,
          'NotSupportedError',
        );
      }
      return wrap(Number(call('parseDocument', str(markup))));
    }
  }

  /** `performance`'s marks and measures, and what observes them. */
  const entries: Any[] = [];
  const observers = new Set<Any>();
  const noteEntry = (entry: Any): Any => {
    entries.push(entry);
    for (const observer of observers) {
      if (!observer._types.has(entry.entryType)) continue;
      observer._queue.push(entry);
      if (observer._queue.length === 1) {
        Promise.resolve().then(() => observer._deliver());
      }
    }
    return entry;
  };
  const entryList = (list: Any[]) => ({
    getEntries: () => list.slice(),
    getEntriesByType: (type: Any) =>
      list.filter((e) => e.entryType === str(type)),
    getEntriesByName: (name: Any, type?: Any) =>
      list.filter(
        (e) =>
          e.name === str(name) &&
          (type === undefined || e.entryType === str(type)),
      ),
  });
  class PerformanceObserver {
    static readonly supportedEntryTypes = ['mark', 'measure'];
    _fn: Any;
    _types = new Set<string>();
    _queue: Any[] = [];
    constructor(fn: Any) {
      if (typeof fn !== 'function') {
        throw new TypeError(
          "Failed to construct 'PerformanceObserver': parameter 1 is not of type 'Function'.",
        );
      }
      this._fn = fn;
    }
    observe(options: Any = {}): void {
      for (const type of options.entryTypes ?? [options.type]) {
        if (type !== undefined) this._types.add(str(type));
      }
      observers.add(this);
      if (options.buffered) {
        for (const entry of entries) {
          if (this._types.has(entry.entryType)) this._queue.push(entry);
        }
        if (this._queue.length) Promise.resolve().then(() => this._deliver());
      }
    }
    disconnect(): void {
      observers.delete(this);
      this._queue = [];
    }
    takeRecords(): Any[] {
      const taken = this._queue;
      this._queue = [];
      return taken;
    }
    _deliver(): void {
      const list = this.takeRecords();
      if (!list.length) return;
      try {
        this._fn.call(this, entryList(list), this);
      } catch (e) {
        report(e);
      }
    }
  }

  /** UTF-8, as `TextEncoder` writes it: a lone surrogate is U+FFFD. */
  const utf8Of = (code: number, out: number[]): void => {
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  };
  /** The code point at `i` in a string, and how many units it takes. */
  const scalarAt = (s: string, i: number): [number, number] => {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        return [0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00), 2];
      }
    }
    return [c >= 0xd800 && c <= 0xdfff ? 0xfffd : c, 1];
  };

  /** `TextEncoder` (Encoding 8.2): UTF-8, the only encoding it writes. */
  class TextEncoder {
    get encoding(): string {
      return 'utf-8';
    }
    encode(input: Any = ''): Uint8Array {
      const s = str(input);
      const out: number[] = [];
      for (let i = 0; i < s.length;) {
        const [code, units] = scalarAt(s, i);
        utf8Of(code, out);
        i += units;
      }
      return new Uint8Array(out);
    }
    encodeInto(
      input: Any,
      dest: Uint8Array,
    ): { read: number; written: number } {
      const s = str(input);
      let read = 0;
      let written = 0;
      const bytes: number[] = [];
      while (read < s.length) {
        const [code, units] = scalarAt(s, read);
        bytes.length = 0;
        utf8Of(code, bytes);
        if (written + bytes.length > dest.length) break;
        for (const b of bytes) dest[written++] = b;
        read += units;
      }
      return { read, written };
    }
  }

  /** windows-1252's bytes 0x80 to 0x9F, where it is not latin-1. */
  const CP1252 =
    '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
    '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

  /**
   * `TextDecoder` (Encoding 8.1): UTF-8, with WHATWG's replacement of a
   * malformed sequence by its maximal subpart, streaming, `fatal` and the
   * BOM; UTF-16LE; and windows-1252, which `latin1` and `ascii` name.
   */
  class TextDecoder {
    readonly encoding: string;
    readonly fatal: boolean;
    readonly ignoreBOM: boolean;
    _pending: number[] = [];
    _started = false;
    constructor(label: Any = 'utf-8', options: Any = {}) {
      const name = str(label).trim().toLowerCase();
      if (['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(name)) {
        this.encoding = 'utf-8';
      } else if (['utf-16le', 'utf-16'].includes(name)) {
        this.encoding = 'utf-16le';
      } else if (
        ['windows-1252', 'latin1', 'iso-8859-1', 'ascii', 'us-ascii'].includes(
          name,
        )
      ) {
        this.encoding = 'windows-1252';
      } else {
        throw new RangeError(
          `Failed to construct 'TextDecoder': The encoding label provided ('${str(label)}') is invalid.`,
        );
      }
      this.fatal = !!options?.fatal;
      this.ignoreBOM = !!options?.ignoreBOM;
    }
    decode(input?: Any, options: Any = {}): string {
      let bytes: Uint8Array;
      if (input === undefined || input === null) bytes = new Uint8Array(0);
      else if (ArrayBuffer.isView(input)) {
        bytes = new Uint8Array(
          input.buffer,
          input.byteOffset,
          input.byteLength,
        );
      } else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
      else {
        throw new TypeError(
          "Failed to execute 'decode' on 'TextDecoder': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.",
        );
      }
      const stream = !!options?.stream;
      const all = this._pending.length
        ? Uint8Array.from([...this._pending, ...bytes])
        : bytes;
      this._pending = [];
      const units: number[] = [];
      const bad = (): void => {
        if (this.fatal) {
          throw new TypeError(
            "Failed to execute 'decode' on 'TextDecoder': The encoded data was not valid.",
          );
        }
        units.push(0xfffd);
      };
      const push = (code: number): void => {
        if (code > 0xffff) {
          code -= 0x10000;
          units.push(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
        } else units.push(code);
      };
      const n = all.length;
      let i = 0;
      if (this.encoding === 'windows-1252') {
        for (; i < n; i += 1) {
          const b = all[i];
          units.push(b >= 0x80 && b < 0xa0 ? CP1252.charCodeAt(b - 0x80) : b);
        }
      } else if (this.encoding === 'utf-16le') {
        for (; i + 1 < n; i += 2) units.push(all[i] | (all[i + 1] << 8));
        if (i < n) {
          if (stream) this._pending = [all[i]];
          else bad();
        }
      } else {
        while (i < n) {
          const b = all[i];
          if (b < 0x80) {
            units.push(b);
            i += 1;
            continue;
          }
          let need = 0;
          let code = 0;
          let lower = 0x80;
          let upper = 0xbf;
          if (b >= 0xc2 && b <= 0xdf) {
            need = 1;
            code = b & 0x1f;
          } else if (b >= 0xe0 && b <= 0xef) {
            need = 2;
            code = b & 0xf;
            if (b === 0xe0) lower = 0xa0;
            if (b === 0xed) upper = 0x9f;
          } else if (b >= 0xf0 && b <= 0xf4) {
            need = 3;
            code = b & 0x7;
            if (b === 0xf0) lower = 0x90;
            if (b === 0xf4) upper = 0x8f;
          } else {
            bad();
            i += 1;
            continue;
          }
          let j = 1;
          for (; j <= need && i + j < n; j += 1) {
            const c = all[i + j];
            if (c < lower || c > upper) break;
            lower = 0x80;
            upper = 0xbf;
            code = (code << 6) | (c & 0x3f);
          }
          if (j > need) {
            push(code);
            i += j;
          } else if (i + j >= n && stream) {
            // a sequence the next chunk finishes
            this._pending = Array.from(all.subarray(i));
            break;
          } else {
            // the bytes that began well, as one replacement
            bad();
            i += j;
          }
        }
      }
      if (!stream && this._pending.length) {
        this._pending = [];
        bad();
      }
      let text = '';
      for (let k = 0; k < units.length; k += 8192) {
        text += String.fromCharCode(...units.slice(k, k + 8192));
      }
      if (
        !this._started &&
        text &&
        !this.ignoreBOM &&
        text.charCodeAt(0) === 0xfeff
      ) {
        text = text.slice(1);
      }
      this._started = stream ? this._started || text.length > 0 : false;
      return text;
    }
  }

  /** `crypto`, its randomness the host's: no `subtle`, which a page that
   *  wants one asks for and does without. */
  const crypto = {
    getRandomValues(array: Any): Any {
      if (
        !ArrayBuffer.isView(array) ||
        array instanceof Float32Array ||
        array instanceof Float64Array ||
        array instanceof DataView
      ) {
        throw new DOMException(
          "Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type 'Float32', which is not an integer array type.",
          'TypeMismatchError',
        );
      }
      if (array.byteLength > 65536) {
        throw new DOMException(
          `Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (${array.byteLength}) exceeds the number of bytes of entropy available via this API (65536).`,
          'QuotaExceededError',
        );
      }
      const hex = String(call('random', array.byteLength));
      const bytes = new Uint8Array(
        array.buffer,
        array.byteOffset,
        array.byteLength,
      );
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return array;
    },
    randomUUID: (): string => String(call('uuid')),
    subtle: undefined,
  };

  /** `visualViewport`: the pane's, as `innerWidth` is, at a scale of 1. */
  class VisualViewport extends EventTarget {
    get width(): number {
      return viewport().width;
    }
    get height(): number {
      return viewport().height;
    }
    get offsetLeft(): number {
      return 0;
    }
    get offsetTop(): number {
      return 0;
    }
    get pageLeft(): number {
      return viewport().scrollX;
    }
    get pageTop(): number {
      return viewport().scrollY;
    }
    get scale(): number {
      return 1;
    }
  }

  /** The window's interface. The global is no instance of it — a page's
   *  context has a global of its own — so `instanceof` asks for that
   *  global, and its methods are the window's. */
  class Window extends EventTarget {
    static override [Symbol.hasInstance](value: Any): boolean {
      return (
        value === G ||
        (value !== null &&
          typeof value === 'object' &&
          proxiedFrames.has(value))
      );
    }
  }
  for (const name of [
    'addEventListener',
    'removeEventListener',
    'dispatchEvent',
  ]) {
    Object.defineProperty(Window.prototype, name, {
      value(...args: Any[]): Any {
        return G[name](...args);
      },
      writable: true,
      configurable: true,
    });
  }

  /**
   * A structured clone (HTML 2.7.3), of what this context makes: a
   * primitive as it is; a date, a pattern, a buffer, a view, a map, a set,
   * an array, an error and a plain object as one of its own kind, a blob
   * as itself, since it never changes; what was met before as the copy made
   * of it then, so a cycle is a cycle. A function, a node, a symbol and the
   * rest are a `DataCloneError`.
   */
  const structuredCopy = (value: Any, seen: Map<Any, Any>): Any => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol') {
        throw new DOMException(
          `${String(typeof value === 'symbol' ? 'Symbol()' : value).slice(0, 40)} could not be cloned.`,
          'DataCloneError',
        );
      }
      return value;
    }
    if (seen.has(value)) return seen.get(value);
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    let out: Any;
    if (value instanceof Blob) return value;
    // a node, a window's object, an event: the platform's, and none of
    // them is serializable
    if (value instanceof EventTarget || value instanceof Event) {
      throw new DOMException(
        `${value.constructor?.name ?? 'The object'} object could not be cloned.`,
        'DataCloneError',
      );
    }
    if (tag === 'Date') out = new Date(value.getTime());
    else if (tag === 'RegExp') out = new RegExp(value.source, value.flags);
    else if (tag === 'ArrayBuffer') out = value.slice(0);
    else if (ArrayBuffer.isView(value)) {
      const buffer = structuredCopy(value.buffer, seen);
      const View = value.constructor as Any;
      out =
        tag === 'DataView'
          ? new DataView(buffer, value.byteOffset, value.byteLength)
          : new View(buffer, value.byteOffset, (value as Any).length);
    } else if (tag === 'Map') {
      out = new Map();
      seen.set(value, out);
      for (const [k, v] of value) {
        out.set(structuredCopy(k, seen), structuredCopy(v, seen));
      }
      return out;
    } else if (tag === 'Set') {
      out = new Set();
      seen.set(value, out);
      for (const v of value) out.add(structuredCopy(v, seen));
      return out;
    } else if (tag === 'Error') {
      out = new Error(value.message);
      out.name = value.name;
    } else if (
      tag === 'Boolean' ||
      tag === 'Number' ||
      tag === 'String' ||
      tag === 'BigInt'
    ) {
      out = Object(value.valueOf());
    } else if (Array.isArray(value)) {
      out = new Array(value.length);
    } else if (tag === 'Object') {
      out = {};
    } else {
      throw new DOMException(
        `${tag} object could not be cloned.`,
        'DataCloneError',
      );
    }
    seen.set(value, out);
    if (Array.isArray(value) || tag === 'Object') {
      for (const key of Object.keys(value)) {
        out[key] = structuredCopy(value[key], seen);
      }
    }
    return out;
  };
  /** A message as it crosses: a copy, the page's structured clone. */
  const cloneOf = (value: Any): Any => structuredCopy(value, new Map());

  /**
   * A value as text, for a message to a worker, which runs in a thread of
   * its own that only a string reaches: structured clone's types, kept
   * apart by a tag, and an object met twice met as the first (HTML 2.7.3,
   * "StructuredSerialize"). `deserializeClone` makes it again in this
   * realm.
   */
  const serializeClone = (value: Any): string => {
    const seen = new Map<Any, number>();
    const bytesOf = (b: Uint8Array): string => base64OfBytes(b);
    const walk = (v: Any): Any => {
      if (v === undefined) return { u: 1 };
      if (v === null || typeof v === 'boolean' || typeof v === 'string') {
        return v;
      }
      if (typeof v === 'number') {
        return Number.isFinite(v) && !Object.is(v, -0) ? v : { n: String(v) };
      }
      if (typeof v === 'bigint') return { g: v.toString() };
      if (typeof v !== 'object') {
        throw new DOMException(
          `${String(typeof v === 'symbol' ? 'Symbol()' : v).slice(0, 40)} could not be cloned.`,
          'DataCloneError',
        );
      }
      const at = seen.get(v);
      if (at !== undefined) return { r: at };
      const index = seen.size;
      seen.set(v, index);
      const tag = Object.prototype.toString.call(v).slice(8, -1);
      if (v instanceof Blob) {
        return { i: index, t: 'L', b: bytesOf(v._bytes), y: v.type };
      }
      if (v instanceof EventTarget || v instanceof Event) {
        throw new DOMException(
          `${v.constructor?.name ?? 'The object'} object could not be cloned.`,
          'DataCloneError',
        );
      }
      if (tag === 'Date') return { i: index, t: 'D', v: v.getTime() };
      if (tag === 'RegExp') {
        return { i: index, t: 'R', s: v.source, f: v.flags };
      }
      if (tag === 'ArrayBuffer') {
        return { i: index, t: 'B', b: bytesOf(new Uint8Array(v)) };
      }
      if (ArrayBuffer.isView(v)) {
        return {
          i: index,
          t: 'V',
          c: tag,
          b: walk(v.buffer),
          o: v.byteOffset,
          l: tag === 'DataView' ? v.byteLength : (v as Any).length,
        };
      }
      if (tag === 'Map') {
        return {
          i: index,
          t: 'M',
          e: [...v].map(([k, x]) => [walk(k), walk(x)]),
        };
      }
      if (tag === 'Set') {
        return { i: index, t: 'S', e: [...v].map((x) => walk(x)) };
      }
      if (tag === 'Error') {
        return {
          i: index,
          t: 'E',
          n: str(v.name),
          m: str(v.message),
          k: v.stack === undefined ? undefined : str(v.stack),
        };
      }
      if (
        tag === 'Boolean' ||
        tag === 'Number' ||
        tag === 'String' ||
        tag === 'BigInt'
      ) {
        return { i: index, t: 'P', v: walk(v.valueOf()) };
      }
      if (Array.isArray(v)) {
        const e: Any[] = [];
        for (const key of Object.keys(v)) e.push([key, walk(v[key as Any])]);
        return { i: index, t: 'A', l: v.length, e };
      }
      if (tag !== 'Object') {
        throw new DOMException(
          `${tag} object could not be cloned.`,
          'DataCloneError',
        );
      }
      const e: Any[] = [];
      for (const key of Object.keys(v)) e.push([key, walk(v[key])]);
      return { i: index, t: 'O', e };
    };
    return JSON.stringify(walk(value));
  };
  const deserializeClone = (text: string): Any => {
    const made: Any[] = [];
    const make = (v: Any): Any => {
      if (v === null || typeof v !== 'object') return v;
      if ('u' in v) return undefined;
      if ('n' in v) return Number(v.n === '-0' ? -0 : v.n);
      if ('g' in v) return BigInt(v.g);
      if ('r' in v) return made[v.r];
      let out: Any;
      switch (v.t) {
        case 'L':
          out = new Blob([bytesOfBase64(v.b)], { type: v.y });
          break;
        case 'D':
          out = new Date(v.v);
          break;
        case 'R':
          out = new RegExp(v.s, v.f);
          break;
        case 'B':
          out = bytesOfBase64(v.b).buffer;
          break;
        case 'V': {
          made[v.i] = null;
          const buffer = make(v.b);
          const View = v.c === 'DataView' ? DataView : (G as Any)[v.c];
          out = new View(buffer, v.o, v.l);
          break;
        }
        case 'M':
          out = new Map();
          made[v.i] = out;
          for (const [k, x] of v.e) out.set(make(k), make(x));
          return out;
        case 'S':
          out = new Set();
          made[v.i] = out;
          for (const x of v.e) out.add(make(x));
          return out;
        case 'E': {
          const Kind = (G as Any)[v.n];
          out =
            typeof Kind === 'function' && Kind.prototype instanceof Error
              ? new Kind(v.m)
              : new Error(v.m);
          if (v.k !== undefined) out.stack = v.k;
          break;
        }
        case 'P':
          out = Object(make(v.v));
          break;
        case 'A':
          out = new Array(v.l);
          made[v.i] = out;
          for (const [k, x] of v.e) out[k] = make(x);
          return out;
        default:
          out = {};
          made[v.i] = out;
          for (const [k, x] of v.e) out[k] = make(x);
          return out;
      }
      made[v.i] = out;
      return out;
    };
    return make(JSON.parse(text));
  };

  /** One end of a `MessageChannel` (HTML 9.4.4): what is posted to it is a
   *  task of its own, after the one that posted it, once it is started —
   *  which setting `onmessage` does. React's scheduler is one of these. */
  class MessagePort extends EventTarget {
    _other: Any = null;
    _started = false;
    _closed = false;
    _waiting: Any[] = [];
    postMessage(message: Any): void {
      const other = this._other;
      if (this._closed || !other || other._closed) return;
      const data = cloneOf(message);
      setTimer(() => other._deliver(data), 0, [], false);
    }
    _deliver(data: Any): void {
      if (this._closed) return;
      if (!this._started) {
        this._waiting.push(data);
        return;
      }
      const ev = new MessageEvent('message', { data });
      ev.isTrusted = true;
      dispatch(this, ev);
    }
    start(): void {
      if (this._started) return;
      this._started = true;
      for (const data of this._waiting.splice(0)) {
        setTimer(() => this._deliver(data), 0, [], false);
      }
    }
    close(): void {
      this._closed = true;
    }
    get onmessage(): Any {
      return this._handlers.message ?? null;
    }
    set onmessage(fn: Any) {
      this._handlers.message = typeof fn === 'function' ? fn : null;
      this.start();
    }
  }
  class MessageChannel {
    readonly port1 = new MessagePort();
    readonly port2 = new MessagePort();
    constructor() {
      this.port1._other = this.port2;
      this.port2._other = this.port1;
    }
  }

  /** A `PluginArray` or a `MimeTypeArray` with nothing in it, its methods
   *  on its prototype, so a page that enumerates it meets none of them. */
  class PluginArray {
    get length(): number {
      return 0;
    }
    item(): Any {
      return null;
    }
    namedItem(): Any {
      return null;
    }
    refresh(): void {}
    [Symbol.iterator](): Iterator<Any> {
      return [][Symbol.iterator]();
    }
  }
  class MimeTypeArray extends PluginArray {}

  /** The bytes of what a `Blob` is made of: a string as UTF-8, a buffer or
   *  a view as its bytes, a `Blob` as its own. */
  const blobBytes = (parts: Any): Uint8Array => {
    const chunks: Uint8Array[] = [];
    for (const part of parts ?? []) {
      if (part instanceof Blob) chunks.push(part._bytes);
      else if (part instanceof ArrayBuffer) chunks.push(new Uint8Array(part));
      else if (ArrayBuffer.isView(part)) {
        chunks.push(
          new Uint8Array(part.buffer, part.byteOffset, part.byteLength),
        );
      } else chunks.push(new TextEncoder().encode(str(part)));
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  };
  class Blob {
    _bytes: Uint8Array;
    readonly type: string;
    constructor(parts: Any = [], options: Any = {}) {
      this._bytes = blobBytes(parts);
      const type = str(options?.type ?? '');
      this.type = /^[\x20-\x7e]*$/.test(type) ? type.toLowerCase() : '';
    }
    get size(): number {
      return this._bytes.length;
    }
    slice(start?: Any, end?: Any, type?: Any): Any {
      const blob = new Blob([], { type: type ?? '' });
      blob._bytes = this._bytes.slice(
        start === undefined ? 0 : Number(start),
        end === undefined ? this._bytes.length : Number(end),
      );
      return blob;
    }
    text(): Promise<string> {
      return Promise.resolve(new TextDecoder().decode(this._bytes));
    }
    arrayBuffer(): Promise<ArrayBuffer> {
      return Promise.resolve(this._bytes.slice().buffer);
    }
    bytes(): Promise<Uint8Array> {
      return Promise.resolve(this._bytes.slice());
    }
  }
  /** A worker's location (WorkerLocation, HTML 10.3.4), which `location`
   *  answers in a realm that is a worker's (`__becomeWorker`). */
  let workerLocation: Any = null;

  /** What a page's window has that a worker's global does not
   *  (`__becomeWorker`). */
  const WINDOW_ONLY = new Set([
    'window',
    'document',
    'parent',
    'top',
    'frames',
    'opener',
    'frameElement',
    'history',
    'localStorage',
    'sessionStorage',
    'customElements',
    'getComputedStyle',
    'matchMedia',
    'alert',
    'confirm',
    'prompt',
    'print',
    'open',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'Document',
    'XMLDocument',
    'Element',
    'Node',
    'Text',
    'Comment',
    'CharacterData',
    'DocumentFragment',
    'DocumentType',
    'ShadowRoot',
    'Window',
  ]);

  /** The blob URLs this realm made (`URL.createObjectURL`), to what they
   *  name: what a worker is started from where a library bundles one, as
   *  Parcel does, and what `fetch` reads. */
  const blobUrls = new Map<string, Any>();

  /**
   * A dedicated worker (HTML 10.2.6.3): a script in a realm of its own, in
   * a thread of its own (`workers.ts`), that the page talks to by messages.
   * Started from a URL of the page's origin or a blob URL this realm made,
   * whose script the host is handed as it is; a message is the value
   * serialized (`serializeClone`), since only a string reaches the thread.
   */
  const workers = new Map<number, Any>();
  class Worker extends EventTarget {
    _id = 0;
    constructor(url: Any, options: Any = {}) {
      super();
      const href = str(url);
      let source: string | null = null;
      let resolved: string;
      if (href.startsWith('blob:')) {
        const blob = blobUrls.get(href);
        if (!blob) {
          throw new DOMException(
            `Failed to construct 'Worker': Script at '${href}' cannot be accessed from origin '${location.origin}'.`,
            'SecurityError',
          );
        }
        source = new TextDecoder().decode(blob._bytes);
        resolved = href;
      } else {
        resolved = new URL(href, location.href).href;
        if (new URL(resolved).origin !== location.origin) {
          throw new DOMException(
            `Failed to construct 'Worker': Script at '${resolved}' cannot be accessed from origin '${location.origin}'.`,
            'SecurityError',
          );
        }
      }
      const id = call(
        'workerStart',
        JSON.stringify({
          url: resolved,
          type: options?.type === 'module' ? 'module' : 'classic',
          name: str(options?.name ?? ''),
        }),
        source,
      );
      this._id = Number(id);
      workers.set(this._id, this);
    }
    postMessage(message: Any): void {
      if (!this._id) return;
      call('workerPost', this._id, serializeClone(message));
    }
    terminate(): void {
      if (!this._id) return;
      call('workerEnd', this._id);
      workers.delete(this._id);
      this._id = 0;
    }
  }
  for (const type of ['message', 'messageerror', 'error']) {
    Object.defineProperty(Worker.prototype, `on${type}`, {
      get(this: Any): Any {
        return this._handlers?.[type] ?? null;
      },
      set(this: Any, fn: Any) {
        this._handlers ??= {};
        this._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
    });
  }
  class File extends Blob {
    readonly name: string;
    readonly lastModified: number;
    constructor(parts: Any, name: Any, options: Any = {}) {
      super(parts, options);
      this.name = str(name);
      this.lastModified = Number(options?.lastModified ?? Date.now());
    }
  }

  /** `FormData` (XHR 4): name and value pairs, in order; made from a form,
   *  what the form would submit of its text, its ticked boxes and its
   *  chosen options — its files, of which there are none here, aside. */
  class FormData {
    _entries: [string, Any][] = [];
    constructor(form?: Any) {
      if (form === undefined || form === null) return;
      if (!(form instanceof HTMLFormElement)) {
        throw new TypeError(
          "Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.",
        );
      }
      for (const el of Array.from((form as Any).elements) as Any[]) {
        const name = el.getAttribute('name');
        if (!name || isDisabled(el)) continue;
        if (el instanceof HTMLSelectElement) {
          for (const option of Array.from((el as Any).options) as Any[]) {
            if (option.selected) this.append(name, option.value);
          }
          continue;
        }
        const type = el instanceof HTMLInputElement ? (el as Any).type : '';
        if (type === 'checkbox' || type === 'radio') {
          if ((el as Any).checked) this.append(name, (el as Any).value || 'on');
        } else if (
          !['submit', 'reset', 'button', 'image', 'file'].includes(type) &&
          !(el instanceof HTMLButtonElement)
        ) {
          this.append(name, (el as Any).value);
        }
      }
    }
    _value(value: Any, filename?: Any): Any {
      if (value instanceof Blob) {
        return value instanceof File && filename === undefined
          ? value
          : new File([value], filename === undefined ? 'blob' : str(filename), {
              type: value.type,
            });
      }
      return str(value);
    }
    append(name: Any, value: Any, filename?: Any): void {
      this._entries.push([str(name), this._value(value, filename)]);
    }
    set(name: Any, value: Any, filename?: Any): void {
      const key = str(name);
      const at = this._entries.findIndex(([k]) => k === key);
      const entry: [string, Any] = [key, this._value(value, filename)];
      if (at < 0) {
        this._entries.push(entry);
        return;
      }
      this._entries[at] = entry;
      this._entries = this._entries.filter(([k], i) => i <= at || k !== key);
    }
    get(name: Any): Any {
      return this._entries.find(([k]) => k === str(name))?.[1] ?? null;
    }
    getAll(name: Any): Any[] {
      return this._entries.filter(([k]) => k === str(name)).map(([, v]) => v);
    }
    has(name: Any): boolean {
      return this._entries.some(([k]) => k === str(name));
    }
    delete(name: Any): void {
      this._entries = this._entries.filter(([k]) => k !== str(name));
    }
    forEach(fn: Any, self?: Any): void {
      for (const [k, v] of this._entries) fn.call(self, v, k, this);
    }
    entries(): Iterator<[string, Any]> {
      return this._entries
        .map((e) => [e[0], e[1]] as [string, Any])
        [Symbol.iterator]();
    }
    keys(): Iterator<string> {
      return this._entries.map(([k]) => k)[Symbol.iterator]();
    }
    values(): Iterator<Any> {
      return this._entries.map(([, v]) => v)[Symbol.iterator]();
    }
    [Symbol.iterator](): Iterator<[string, Any]> {
      return this.entries();
    }
  }

  // --- streams -------------------------------------------------------------------
  //
  // WHATWG Streams' default kinds: a readable stream that a source starts,
  // pulls and cancels, read by one reader at a time; a writable one whose
  // sink is written one chunk after the last; and a transform between the
  // two. What it is for is the app router of Next.js, whose first module
  // makes one of the flight data the server inlined, and the libraries
  // that pipe a fetch through a decoder. Byte streams are default ones of
  // bytes, and a reader that brings its own buffer is refused.

  class ReadableStreamDefaultController {
    _stream: Any;
    constructor(stream: Any) {
      this._stream = stream;
    }
    get desiredSize(): number | null {
      const stream = this._stream;
      if (stream._state === 'errored') return null;
      if (stream._state === 'closed') return 0;
      return stream._hwm - stream._queue.length;
    }
    enqueue(chunk: Any): void {
      const stream = this._stream;
      if (stream._closing || stream._state !== 'readable') {
        throw new TypeError(
          'The stream is not in a state that permits enqueue.',
        );
      }
      const read = stream._reads.shift();
      if (read) read.resolve({ value: chunk, done: false });
      else stream._queue.push(chunk);
      stream._pullIfNeeded();
    }
    close(): void {
      const stream = this._stream;
      if (stream._closing || stream._state !== 'readable') {
        throw new TypeError('The stream is not in a state that permits close.');
      }
      stream._closing = true;
      if (!stream._queue.length) stream._finish();
    }
    error(reason: Any): void {
      this._stream._fail(reason);
    }
  }

  class ReadableStream {
    _state: 'readable' | 'closed' | 'errored' = 'readable';
    _queue: Any[] = [];
    _reads: { resolve: Any; reject: Any }[] = [];
    _reader: Any = null;
    _error: Any = undefined;
    _closing = false;
    _source: Any;
    _controller: Any;
    _hwm: number;
    _started = false;
    _pulling = false;
    _pullAgain = false;
    constructor(source: Any = {}, strategy: Any = {}) {
      this._source = source ?? {};
      const hwm = Number(strategy?.highWaterMark ?? 1);
      this._hwm = Number.isNaN(hwm) ? 1 : hwm;
      this._controller = new ReadableStreamDefaultController(this);
      const started = this._source.start
        ? this._source.start.call(this._source, this._controller)
        : undefined;
      Promise.resolve(started).then(
        () => {
          this._started = true;
          this._pullIfNeeded();
        },
        (e) => this._fail(e),
      );
    }
    static from(iterable: Any): Any {
      const it = iterable[Symbol.asyncIterator]
        ? iterable[Symbol.asyncIterator]()
        : iterable[Symbol.iterator]();
      return new ReadableStream({
        pull(controller: Any) {
          return Promise.resolve(it.next()).then((r: Any) => {
            if (r.done) controller.close();
            else controller.enqueue(r.value);
          });
        },
        cancel(reason: Any) {
          return it.return?.(reason);
        },
      });
    }
    _pullIfNeeded(): void {
      if (!this._started || this._state !== 'readable' || this._closing) {
        return;
      }
      if (!this._source.pull) return;
      if (this._queue.length >= this._hwm && !this._reads.length) return;
      if (this._pulling) {
        this._pullAgain = true;
        return;
      }
      this._pulling = true;
      Promise.resolve()
        .then(() => this._source.pull.call(this._source, this._controller))
        .then(
          () => {
            this._pulling = false;
            if (this._pullAgain) {
              this._pullAgain = false;
              this._pullIfNeeded();
            }
          },
          (e: Any) => this._fail(e),
        );
    }
    _finish(): void {
      if (this._state !== 'readable') return;
      this._state = 'closed';
      for (const read of this._reads.splice(0)) {
        read.resolve({ value: undefined, done: true });
      }
      this._reader?._settle();
    }
    _fail(reason: Any): void {
      if (this._state !== 'readable') return;
      this._state = 'errored';
      this._error = reason;
      this._queue = [];
      for (const read of this._reads.splice(0)) read.reject(reason);
      this._reader?._settle();
    }
    _read(): Promise<Any> {
      if (this._queue.length) {
        const value = this._queue.shift();
        if (this._closing && !this._queue.length) this._finish();
        else this._pullIfNeeded();
        return Promise.resolve({ value, done: false });
      }
      if (this._state === 'closed') {
        return Promise.resolve({ value: undefined, done: true });
      }
      if (this._state === 'errored') return Promise.reject(this._error);
      return new Promise((resolve, reject) => {
        this._reads.push({ resolve, reject });
        this._pullIfNeeded();
      });
    }
    _cancel(reason: Any): Promise<void> {
      if (this._state === 'closed') return Promise.resolve();
      if (this._state === 'errored') return Promise.reject(this._error);
      this._queue = [];
      this._finish();
      return Promise.resolve(
        this._source.cancel?.call(this._source, reason),
      ).then(() => undefined);
    }
    get locked(): boolean {
      return !!this._reader;
    }
    getReader(options?: Any): Any {
      if (options?.mode === 'byob') {
        throw new TypeError(
          'A reader that brings its own buffer is not supported here.',
        );
      }
      return new ReadableStreamDefaultReader(this);
    }
    cancel(reason?: Any): Promise<void> {
      if (this._reader) {
        return Promise.reject(
          new TypeError('The stream is locked to a reader.'),
        );
      }
      return this._cancel(reason);
    }
    tee(): Any[] {
      const reader = this.getReader();
      const controllers: Any[] = [];
      let reading: Promise<void> | null = null;
      const pull = (): Promise<void> =>
        (reading ??= reader.read().then(
          (r: Any) => {
            reading = null;
            for (const c of controllers) {
              try {
                if (r.done) c.close();
                else c.enqueue(r.value);
              } catch {
                // that branch was cancelled
              }
            }
          },
          (e: Any) => {
            for (const c of controllers) c.error(e);
          },
        ));
      const branch = (): Any =>
        new ReadableStream({
          start(c: Any) {
            controllers.push(c);
          },
          pull,
        });
      return [branch(), branch()];
    }
    pipeTo(dest: Any, options: Any = {}): Promise<void> {
      const reader = this.getReader();
      const writer = dest.getWriter();
      const signal = options.signal;
      return new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (error?: Any, failed = false): void => {
          if (done) return;
          done = true;
          reader.releaseLock();
          writer.releaseLock();
          if (failed) reject(error);
          else resolve();
        };
        if (signal) {
          const abort = (): void => {
            const reason =
              signal.reason ?? new DOMException('Aborted.', 'AbortError');
            if (!options.preventCancel) reader.cancel(reason).catch(() => {});
            if (!options.preventAbort) writer.abort(reason).catch(() => {});
            finish(reason, true);
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
        }
        const step = (): void => {
          if (done) return;
          reader.read().then(
            (r: Any) => {
              if (done) return;
              if (r.done) {
                const closed = options.preventClose
                  ? Promise.resolve()
                  : writer.close();
                closed.then(
                  () => finish(),
                  (e: Any) => finish(e, true),
                );
                return;
              }
              writer.write(r.value).then(step, (e: Any) => {
                if (!options.preventCancel) reader.cancel(e).catch(() => {});
                finish(e, true);
              });
            },
            (e: Any) => {
              if (!options.preventAbort) writer.abort(e).catch(() => {});
              finish(e, true);
            },
          );
        };
        step();
      });
    }
    pipeThrough(transform: Any, options?: Any): Any {
      this.pipeTo(transform.writable, options).catch(() => {});
      return transform.readable;
    }
    values(options: Any = {}): Any {
      const reader = this.getReader();
      return {
        next: () =>
          reader.read().then((r: Any) => {
            if (r.done) reader.releaseLock();
            return r;
          }),
        return: (value: Any) => {
          const cancelled = options.preventCancel
            ? Promise.resolve()
            : reader.cancel(value);
          return cancelled.then(() => {
            reader.releaseLock();
            return { value, done: true };
          });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
    [Symbol.asyncIterator](options?: Any): Any {
      return this.values(options);
    }
  }

  class ReadableStreamDefaultReader {
    _stream: Any;
    _closed: Promise<void>;
    _resolveClosed!: () => void;
    _rejectClosed!: (e: Any) => void;
    constructor(stream: Any) {
      if (!(stream instanceof ReadableStream)) {
        throw new TypeError('A reader is made of a ReadableStream.');
      }
      if (stream._reader) {
        throw new TypeError('The stream is locked to a reader.');
      }
      this._stream = stream;
      stream._reader = this;
      this._closed = new Promise<void>((resolve, reject) => {
        this._resolveClosed = resolve;
        this._rejectClosed = reject;
      });
      // a reader nobody asks `closed` of rejects quietly
      this._closed.catch(() => {});
      this._settle();
    }
    _settle(): void {
      const stream = this._stream;
      if (stream?._state === 'closed') this._resolveClosed();
      else if (stream?._state === 'errored') this._rejectClosed(stream._error);
    }
    get closed(): Promise<void> {
      return this._closed;
    }
    read(): Promise<Any> {
      if (!this._stream) {
        return Promise.reject(new TypeError('The reader has been released.'));
      }
      return this._stream._read();
    }
    cancel(reason?: Any): Promise<void> {
      if (!this._stream) {
        return Promise.reject(new TypeError('The reader has been released.'));
      }
      return this._stream._cancel(reason);
    }
    releaseLock(): void {
      const stream = this._stream;
      if (!stream) return;
      const released = new TypeError('The reader was released.');
      for (const read of stream._reads.splice(0)) read.reject(released);
      if (stream._state === 'readable') this._rejectClosed(released);
      stream._reader = null;
      this._stream = null;
    }
  }

  class WritableStream {
    _sink: Any;
    _state: 'writable' | 'closing' | 'closed' | 'errored' = 'writable';
    _error: Any = undefined;
    _writer: Any = null;
    _chain: Promise<Any>;
    _controller: Any;
    constructor(sink: Any = {}, _strategy: Any = {}) {
      this._sink = sink ?? {};
      const aborts = new AbortController();
      this._controller = {
        error: (e: Any) => this._fail(e),
        signal: aborts.signal,
        _abort: aborts,
      };
      this._chain = Promise.resolve(
        this._sink.start?.call(this._sink, this._controller),
      );
      this._chain.catch((e: Any) => this._fail(e));
    }
    _fail(reason: Any): void {
      if (this._state === 'errored' || this._state === 'closed') return;
      this._state = 'errored';
      this._error = reason;
    }
    _write(chunk: Any): Promise<void> {
      if (this._state !== 'writable') {
        return Promise.reject(
          this._error ?? new TypeError('The stream is closed.'),
        );
      }
      const written = this._chain.then(() =>
        this._sink.write?.call(this._sink, chunk, this._controller),
      );
      this._chain = written.catch((e: Any) => this._fail(e));
      return written.then(() => undefined);
    }
    _close(): Promise<void> {
      if (this._state !== 'writable') {
        return Promise.reject(
          this._error ?? new TypeError('The stream is closed.'),
        );
      }
      this._state = 'closing';
      const closed = this._chain
        .then(() => this._sink.close?.call(this._sink))
        .then(() => {
          this._state = 'closed';
        });
      this._chain = closed.catch((e: Any) => this._fail(e));
      return closed;
    }
    _abort(reason: Any): Promise<void> {
      if (this._state === 'closed' || this._state === 'errored') {
        return Promise.resolve();
      }
      this._fail(reason);
      this._controller._abort.abort(reason);
      return Promise.resolve(this._sink.abort?.call(this._sink, reason)).then(
        () => undefined,
      );
    }
    get locked(): boolean {
      return !!this._writer;
    }
    getWriter(): Any {
      return new WritableStreamDefaultWriter(this);
    }
    close(): Promise<void> {
      if (this._writer) {
        return Promise.reject(
          new TypeError('The stream is locked to a writer.'),
        );
      }
      return this._close();
    }
    abort(reason?: Any): Promise<void> {
      if (this._writer) {
        return Promise.reject(
          new TypeError('The stream is locked to a writer.'),
        );
      }
      return this._abort(reason);
    }
  }

  class WritableStreamDefaultWriter {
    _stream: Any;
    constructor(stream: Any) {
      if (!(stream instanceof WritableStream)) {
        throw new TypeError('A writer is made of a WritableStream.');
      }
      if (stream._writer) {
        throw new TypeError('The stream is locked to a writer.');
      }
      this._stream = stream;
      stream._writer = this;
    }
    get desiredSize(): number | null {
      return this._stream?._state === 'errored' ? null : 1;
    }
    get ready(): Promise<void> {
      return Promise.resolve();
    }
    get closed(): Promise<void> {
      const stream = this._stream;
      return stream ? stream._chain.then(() => undefined) : Promise.resolve();
    }
    write(chunk: Any): Promise<void> {
      if (!this._stream) {
        return Promise.reject(new TypeError('The writer has been released.'));
      }
      return this._stream._write(chunk);
    }
    close(): Promise<void> {
      if (!this._stream) {
        return Promise.reject(new TypeError('The writer has been released.'));
      }
      return this._stream._close();
    }
    abort(reason?: Any): Promise<void> {
      if (!this._stream) {
        return Promise.reject(new TypeError('The writer has been released.'));
      }
      return this._stream._abort(reason);
    }
    releaseLock(): void {
      if (!this._stream) return;
      this._stream._writer = null;
      this._stream = null;
    }
  }

  class TransformStream {
    readonly readable: Any;
    readonly writable: Any;
    constructor(transformer: Any = {}, _writable?: Any, _readable?: Any) {
      const t = transformer ?? {};
      let out!: Any;
      this.readable = new ReadableStream({
        start(c: Any) {
          out = c;
        },
        cancel(reason: Any) {
          return t.cancel?.call(t, reason);
        },
      });
      const controller = {
        enqueue: (chunk: Any) => out.enqueue(chunk),
        error: (e: Any) => out.error(e),
        terminate: () => {
          try {
            out.close();
          } catch {
            // closed already
          }
        },
        get desiredSize() {
          return out.desiredSize;
        },
      };
      const started = Promise.resolve(t.start?.call(t, controller));
      this.writable = new WritableStream({
        write: (chunk: Any) =>
          started.then(() =>
            t.transform
              ? t.transform.call(t, chunk, controller)
              : controller.enqueue(chunk),
          ),
        close: () =>
          started
            .then(() => t.flush?.call(t, controller))
            .then(() => controller.terminate()),
        abort: (reason: Any) => out.error(reason),
      });
    }
  }

  class TextDecoderStream extends TransformStream {
    readonly encoding: string;
    readonly fatal: boolean;
    readonly ignoreBOM: boolean;
    constructor(label?: Any, options?: Any) {
      const decoder = new TextDecoder(label, options);
      super({
        transform(chunk: Any, c: Any) {
          const text = decoder.decode(chunk, { stream: true });
          if (text) c.enqueue(text);
        },
        flush(c: Any) {
          const text = decoder.decode();
          if (text) c.enqueue(text);
        },
      });
      this.encoding = decoder.encoding;
      this.fatal = decoder.fatal;
      this.ignoreBOM = decoder.ignoreBOM;
    }
  }
  class TextEncoderStream extends TransformStream {
    readonly encoding = 'utf-8';
    constructor() {
      const encoder = new TextEncoder();
      super({
        transform(chunk: Any, c: Any) {
          const bytes = encoder.encode(str(chunk));
          if (bytes.length) c.enqueue(bytes);
        },
      });
    }
  }
  class CountQueuingStrategy {
    readonly highWaterMark: number;
    constructor(init: Any = {}) {
      this.highWaterMark = Number(init.highWaterMark);
    }
    size(): number {
      return 1;
    }
  }
  class ByteLengthQueuingStrategy {
    readonly highWaterMark: number;
    constructor(init: Any = {}) {
      this.highWaterMark = Number(init.highWaterMark);
    }
    size(chunk: Any): number {
      return chunk?.byteLength ?? 0;
    }
  }

  // --- IndexedDB -------------------------------------------------------------------
  //
  // IndexedDB 3, in memory, for as long as the document: a page's databases
  // are an empty profile's each time it loads, as a private window's are.
  // Sites open one whether or not they check for it — an analytics queue,
  // a cache, a framework's persistence — and a missing `indexedDB` threw
  // where an empty one is what a new visitor has. Values are structured
  // clones, keys are ordered as the standard orders them, and a
  // transaction runs its requests in order, a task each round, and commits
  // once a round leaves none queued — after the microtasks its callbacks
  // queued, which is where a promise wrapper's next request comes from.
  // Transactions are not held back for one another, as a browser holds two
  // that write the same store: a page here has no other tab.

  /** A key's type, in the standard's order; 0 for no valid key. */
  const keyType = (key: Any, seen: Set<Any> = new Set()): number => {
    if (typeof key === 'number') return Number.isNaN(key) ? 0 : 1;
    if (key instanceof Date) return Number.isNaN(key.getTime()) ? 0 : 2;
    if (typeof key === 'string') return 3;
    if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) return 4;
    if (Array.isArray(key)) {
      if (seen.has(key)) return 0;
      seen.add(key);
      return key.every((k) => keyType(k, seen) > 0) ? 5 : 0;
    }
    return 0;
  };
  const validKey = (key: Any): boolean => keyType(key) > 0;
  const bytesOf = (key: Any): Uint8Array =>
    key instanceof ArrayBuffer
      ? new Uint8Array(key)
      : new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
  /** Two keys compared (IndexedDB 3, 2.4.3). */
  const cmpKey = (a: Any, b: Any): number => {
    const ta = keyType(a);
    const tb = keyType(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (ta === 1 || ta === 3) return a < b ? -1 : a > b ? 1 : 0;
    if (ta === 2) return cmpKey(a.getTime(), b.getTime());
    if (ta === 4) {
      const x = bytesOf(a);
      const y = bytesOf(b);
      for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
        if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      }
      return cmpKey(x.length, y.length);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const c = cmpKey(a[i], b[i]);
      if (c) return c;
    }
    return cmpKey(a.length, b.length);
  };
  /** A key as a key is handed out: its own copy. */
  const copyKey = (key: Any): Any =>
    key instanceof Date
      ? new Date(key.getTime())
      : Array.isArray(key)
        ? key.map(copyKey)
        : key instanceof ArrayBuffer || ArrayBuffer.isView(key)
          ? bytesOf(key).slice().buffer
          : key;
  const dataError = (message: string): Any =>
    new DOMException(message, 'DataError');
  const checkKey = (key: Any): Any => {
    if (!validKey(key)) {
      throw dataError('The parameter is not a valid key.');
    }
    return copyKey(key);
  };

  /** What a key path names in a value (IndexedDB 3, 2.5.1), or undefined. */
  const atKeyPath = (value: Any, path: Any): Any => {
    if (Array.isArray(path)) {
      const keys = path.map((p) => atKeyPath(value, p));
      return keys.includes(undefined) ? undefined : keys;
    }
    if (path === '') return value;
    let at = value;
    for (const part of String(path).split('.')) {
      if (at === null || at === undefined) return undefined;
      if (typeof at === 'string' && part === 'length') at = at.length;
      else if (typeof at !== 'object' || !(part in at)) return undefined;
      else at = at[part];
    }
    return at;
  };
  /** A generated key put in a value at its key path. */
  const atKeyPathSet = (value: Any, path: string, key: Any): void => {
    const parts = path.split('.');
    let at = value;
    for (const part of parts.slice(0, -1)) {
      if (at[part] === undefined) at[part] = {};
      at = at[part];
    }
    at[parts[parts.length - 1]] = key;
  };
  const validKeyPath = (path: Any): boolean =>
    Array.isArray(path)
      ? path.length > 0 &&
        path.every((p) => typeof p === 'string' && validKeyPath(p))
      : typeof path === 'string' &&
        (path === '' ||
          path
            .split('.')
            .every((part) => /^[A-Za-z_$\u0080-￿][\w$\u0080-￿]*$/.test(part)));

  class IDBKeyRange {
    readonly lower: Any;
    readonly upper: Any;
    readonly lowerOpen: boolean;
    readonly upperOpen: boolean;
    constructor(
      lower: Any,
      upper: Any,
      lowerOpen: boolean,
      upperOpen: boolean,
    ) {
      this.lower = lower;
      this.upper = upper;
      this.lowerOpen = lowerOpen;
      this.upperOpen = upperOpen;
    }
    static only(key: Any): Any {
      const k = checkKey(key);
      return new IDBKeyRange(k, k, false, false);
    }
    static lowerBound(key: Any, open = false): Any {
      return new IDBKeyRange(checkKey(key), undefined, !!open, true);
    }
    static upperBound(key: Any, open = false): Any {
      return new IDBKeyRange(undefined, checkKey(key), true, !!open);
    }
    static bound(
      lower: Any,
      upper: Any,
      lowerOpen = false,
      upperOpen = false,
    ): Any {
      const l = checkKey(lower);
      const u = checkKey(upper);
      const c = cmpKey(l, u);
      if (c > 0 || (c === 0 && (lowerOpen || upperOpen))) {
        throw dataError('The lower key is greater than the upper key.');
      }
      return new IDBKeyRange(l, u, !!lowerOpen, !!upperOpen);
    }
    includes(key: Any): boolean {
      const k = checkKey(key);
      if (this.lower !== undefined) {
        const c = cmpKey(k, this.lower);
        if (c < 0 || (c === 0 && this.lowerOpen)) return false;
      }
      if (this.upper !== undefined) {
        const c = cmpKey(k, this.upper);
        if (c > 0 || (c === 0 && this.upperOpen)) return false;
      }
      return true;
    }
  }
  /** A query as a range: all of them for none, the one a key names. */
  const rangeOf = (query: Any, required = false): Any => {
    if (query instanceof IDBKeyRange) return query;
    if (query === undefined || query === null) {
      if (required) throw dataError('No key or key range specified.');
      return null;
    }
    return IDBKeyRange.only(query);
  };
  const inRange = (range: Any, key: Any): boolean =>
    !range || range.includes(key);

  class DOMStringList extends Array {
    item(i: Any): Any {
      return this[Number(i)] ?? null;
    }
    contains(name: Any): boolean {
      return this.includes(str(name));
    }
  }
  const stringList = (names: Iterable<string>): Any => {
    const list = new DOMStringList();
    for (const name of [...names].sort()) list.push(name);
    return list;
  };

  class IDBVersionChangeEvent extends Event {
    readonly oldVersion: number;
    readonly newVersion: number | null;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.oldVersion = Number(init.oldVersion ?? 0);
      this.newVersion =
        init.newVersion === undefined || init.newVersion === null
          ? null
          : Number(init.newVersion);
    }
  }

  /** An event fired at a request and on, as IndexedDB fires one: at its
   *  transaction and its database after it, where it bubbles. Whether
   *  nothing cancelled it. */
  const fireAt = (targets: Any[], event: Any): boolean => {
    event.isTrusted = true;
    event._target = targets[0];
    event._path = targets;
    event._stop = false;
    event._stopNow = false;
    invoke(targets[0], event, AT_TARGET);
    if (event._bubbles) {
      for (let i = 1; i < targets.length && !event._stop; i += 1) {
        if (targets[i]) invoke(targets[i], event, BUBBLING_PHASE);
      }
    }
    event._phase = NONE;
    event._currentTarget = null;
    return !event._canceled;
  };
  /** `on…` properties for the events a class fires. */
  const handlers = (Class: Any, types: string[]): void => {
    for (const type of types) {
      Object.defineProperty(Class.prototype, `on${type}`, {
        get(this: Any): Any {
          return this._handlers[type] ?? null;
        },
        set(this: Any, fn: Any) {
          this._handlers[type] = typeof fn === 'function' ? fn : null;
        },
        configurable: true,
      });
    }
  };

  class IDBRequest extends EventTarget {
    _result: Any = undefined;
    _error: Any = null;
    _done = false;
    source: Any = null;
    transaction: Any = null;
    get readyState(): string {
      return this._done ? 'done' : 'pending';
    }
    get result(): Any {
      if (!this._done) {
        throw new DOMException(
          'The request has not finished.',
          'InvalidStateError',
        );
      }
      return this._result;
    }
    get error(): Any {
      if (!this._done) {
        throw new DOMException(
          'The request has not finished.',
          'InvalidStateError',
        );
      }
      return this._error;
    }
  }
  handlers(IDBRequest, ['success', 'error']);
  class IDBOpenDBRequest extends IDBRequest {}
  handlers(IDBOpenDBRequest, ['blocked', 'upgradeneeded']);

  interface IdbIndex {
    name: string;
    keyPath: Any;
    unique: boolean;
    multiEntry: boolean;
  }
  interface IdbStore {
    name: string;
    keyPath: Any;
    autoIncrement: boolean;
    current: number;
    records: { key: Any; value: Any }[];
    indexes: Map<string, IdbIndex>;
  }
  interface IdbData {
    name: string;
    version: number;
    stores: Map<string, IdbStore>;
    connections: Set<Any>;
  }
  const idbDatabases = new Map<string, IdbData>();

  /** Where a key is in a store's records, or would go. */
  const findKey = (
    store: IdbStore,
    key: Any,
  ): { i: number; found: boolean } => {
    let lo = 0;
    let hi = store.records.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const c = cmpKey(store.records[mid].key, key);
      if (c === 0) return { i: mid, found: true };
      if (c < 0) lo = mid + 1;
      else hi = mid;
    }
    return { i: lo, found: false };
  };
  /** The keys a value has in an index. */
  const indexKeys = (index: IdbIndex, value: Any): Any[] => {
    const key = atKeyPath(value, index.keyPath);
    if (key === undefined) return [];
    if (index.multiEntry && Array.isArray(key)) {
      const out: Any[] = [];
      for (const k of key) {
        if (validKey(k) && !out.some((o) => cmpKey(o, k) === 0)) out.push(k);
      }
      return out;
    }
    return validKey(key) ? [key] : [];
  };
  /** An index's entries, in its order: by key, then by the record's. */
  const indexEntries = (store: IdbStore, index: IdbIndex): Any[] => {
    const out: Any[] = [];
    for (const record of store.records) {
      for (const key of indexKeys(index, record.value)) {
        out.push({ key, primaryKey: record.key, value: record.value });
      }
    }
    return out.sort(
      (a, b) => cmpKey(a.key, b.key) || cmpKey(a.primaryKey, b.primaryKey),
    );
  };
  const storeEntries = (store: IdbStore): Any[] =>
    store.records.map((r) => ({
      key: r.key,
      primaryKey: r.key,
      value: r.value,
    }));
  const copyStore = (store: IdbStore): IdbStore => ({
    ...store,
    records: store.records.map((r) => ({ ...r })),
    indexes: new Map([...store.indexes].map(([k, v]) => [k, { ...v }])),
  });

  class IDBDatabase extends EventTarget {
    _data: IdbData;
    _closed = false;
    _upgrade: Any = null;
    constructor(data: IdbData) {
      super();
      this._data = data;
    }
    get name(): string {
      return this._data.name;
    }
    get version(): number {
      return this._data.version;
    }
    get objectStoreNames(): Any {
      return stringList(this._data.stores.keys());
    }
    createObjectStore(name: Any, options: Any = {}): Any {
      const tx = this._upgrade;
      if (!tx || tx._finished) {
        throw new DOMException(
          'A store is made only while the database is upgraded.',
          'InvalidStateError',
        );
      }
      const storeName = str(name);
      if (this._data.stores.has(storeName)) {
        throw new DOMException(
          `An object store named '${storeName}' already exists.`,
          'ConstraintError',
        );
      }
      const keyPath = options?.keyPath ?? null;
      if (keyPath !== null && !validKeyPath(keyPath)) {
        throw new DOMException('The key path is not valid.', 'SyntaxError');
      }
      const autoIncrement = !!options?.autoIncrement;
      if (autoIncrement && (keyPath === '' || Array.isArray(keyPath))) {
        throw new DOMException(
          'A key generator takes no empty or array key path.',
          'InvalidAccessError',
        );
      }
      this._data.stores.set(storeName, {
        name: storeName,
        keyPath: Array.isArray(keyPath) ? keyPath.map(str) : keyPath,
        autoIncrement,
        current: 1,
        records: [],
        indexes: new Map(),
      });
      return tx.objectStore(storeName);
    }
    deleteObjectStore(name: Any): void {
      if (!this._upgrade || this._upgrade._finished) {
        throw new DOMException(
          'A store is deleted only while the database is upgraded.',
          'InvalidStateError',
        );
      }
      if (!this._data.stores.delete(str(name))) {
        throw new DOMException(
          `No object store named '${str(name)}'.`,
          'NotFoundError',
        );
      }
    }
    transaction(names: Any, mode: Any = 'readonly'): Any {
      if (this._closed) {
        throw new DOMException(
          'The database connection is closed.',
          'InvalidStateError',
        );
      }
      if (this._upgrade && !this._upgrade._finished) {
        throw new DOMException(
          'A transaction waits for the upgrade to finish.',
          'InvalidStateError',
        );
      }
      const list =
        typeof names === 'string' ? [names] : Array.from(names ?? [], str);
      if (!list.length) {
        throw new DOMException(
          'No object store was named.',
          'InvalidAccessError',
        );
      }
      for (const name of list) {
        if (!this._data.stores.has(name)) {
          throw new DOMException(
            `No object store named '${name}'.`,
            'NotFoundError',
          );
        }
      }
      if (mode !== 'readonly' && mode !== 'readwrite') {
        throw new TypeError(`'${str(mode)}' is not a valid transaction mode.`);
      }
      return new IDBTransaction(this, [...new Set(list)], mode);
    }
    close(): void {
      this._closed = true;
      this._data.connections.delete(this);
    }
  }
  handlers(IDBDatabase, ['abort', 'close', 'error', 'versionchange']);

  class IDBTransaction extends EventTarget {
    _db: Any;
    _names: string[];
    readonly mode: string;
    readonly durability = 'default';
    error: Any = null;
    _queue: { request: Any; op: () => Any }[] = [];
    _finished = false;
    _scheduled = false;
    _settling = false;
    _stores = new Map<string, Any>();
    _undo: () => void;
    _onDone: ((ok: boolean) => void) | null = null;
    constructor(db: Any, names: string[], mode: string) {
      super();
      this._db = db;
      this._names = names;
      this.mode = mode;
      // what a write is undone to where the transaction aborts
      const data: IdbData = db._data;
      if (mode === 'versionchange') {
        const version = data.version;
        const stores = new Map(
          [...data.stores].map(([k, v]) => [k, copyStore(v)]),
        );
        this._undo = () => {
          data.version = version;
          data.stores = stores;
        };
      } else if (mode === 'readwrite') {
        const kept = names.map((name) => copyStore(data.stores.get(name)!));
        this._undo = () => {
          for (const store of kept) data.stores.set(store.name, store);
        };
      } else this._undo = () => {};
      // one with nothing asked of it commits at its first round
      this._schedule();
    }
    get db(): Any {
      return this._db;
    }
    get objectStoreNames(): Any {
      return stringList(
        this.mode === 'versionchange'
          ? this._db._data.stores.keys()
          : this._names,
      );
    }
    objectStore(name: Any): Any {
      const storeName = str(name);
      if (this._finished) {
        throw new DOMException(
          'The transaction has finished.',
          'InvalidStateError',
        );
      }
      const known =
        this.mode === 'versionchange'
          ? this._db._data.stores.has(storeName)
          : this._names.includes(storeName);
      if (!known) {
        throw new DOMException(
          `No object store named '${storeName}' in this transaction.`,
          'NotFoundError',
        );
      }
      let store = this._stores.get(storeName);
      if (!store)
        this._stores.set(
          storeName,
          (store = new IDBObjectStore(this, storeName)),
        );
      return store;
    }
    abort(): void {
      if (this._finished) {
        throw new DOMException(
          'The transaction has finished.',
          'InvalidStateError',
        );
      }
      this._abort(
        new DOMException('The transaction was aborted.', 'AbortError'),
      );
    }
    commit(): void {
      if (this._finished) {
        throw new DOMException(
          'The transaction has finished.',
          'InvalidStateError',
        );
      }
      this._settling = true;
      this._schedule();
    }
    /** A request this transaction runs in its turn: `op` answers its
     *  result or throws its error. */
    _request(source: Any, op: () => Any, into?: Any): Any {
      if (this._finished) {
        throw new DOMException(
          'The transaction has finished.',
          'TransactionInactiveError',
        );
      }
      const request = into ?? new IDBRequest();
      request.source = source;
      request.transaction = this;
      request._done = false;
      this._queue.push({ request, op });
      this._settling = false;
      this._schedule();
      return request;
    }
    _answer(request: Any, op: () => Any): void {
      let result: Any;
      try {
        result = op();
      } catch (error) {
        request._done = true;
        request._result = undefined;
        request._error = error;
        const go = fireAt(
          [request, this, this._db],
          new Event('error', { bubbles: true, cancelable: true }),
        );
        if (go) this._abort(error);
        return;
      }
      request._done = true;
      request._result = result;
      request._error = null;
      fireAt([request], new Event('success'));
    }
    _schedule(): void {
      if (this._scheduled || this._finished) return;
      this._scheduled = true;
      setTimer(() => this._run(), 0, [], false);
    }
    /** A round: every request queued, in order, and those their callbacks
     *  queue; then, where a round left none, one more after the
     *  microtasks, and the commit. */
    _run(): void {
      this._scheduled = false;
      if (this._finished) return;
      while (this._queue.length && !this._finished) {
        const { request, op } = this._queue.shift()!;
        this._answer(request, op);
      }
      if (this._finished) return;
      if (this._queue.length) {
        this._schedule();
        return;
      }
      if (!this._settling) {
        this._settling = true;
        this._schedule();
        return;
      }
      this._finished = true;
      fireAt([this], new Event('complete'));
      this._onDone?.(true);
    }
    /** Aborted: what it wrote undone at once, and what is told of it —
     *  each request still queued failing, then the abort — a task later,
     *  as a browser queues them, so a handler set after `abort()` hears
     *  it. */
    _abort(error: Any): void {
      if (this._finished) return;
      this._finished = true;
      this._undo();
      this.error = error;
      const pending = this._queue;
      this._queue = [];
      setTimer(
        () => {
          for (const { request } of pending) {
            request._done = true;
            request._result = undefined;
            request._error = new DOMException(
              'The transaction was aborted.',
              'AbortError',
            );
            fireAt(
              [request, this, this._db],
              new Event('error', { bubbles: true, cancelable: true }),
            );
          }
          fireAt([this, this._db], new Event('abort', { bubbles: true }));
          this._onDone?.(false);
        },
        0,
        [],
        false,
      );
    }
  }
  handlers(IDBTransaction, ['abort', 'complete', 'error']);

  /** Where a request reads or writes: an object store or an index, and the
   *  entries it orders. */
  const sourceEntries = (source: Any): Any[] =>
    source instanceof IDBIndex
      ? indexEntries(source._store._data, source._data)
      : storeEntries(source._data);

  class IDBObjectStore {
    _tx: Any;
    _name: string;
    constructor(tx: Any, name: string) {
      this._tx = tx;
      this._name = name;
    }
    get _data(): IdbStore {
      const data = this._tx._db._data.stores.get(this._name);
      if (!data) {
        throw new DOMException(
          'The object store was deleted.',
          'InvalidStateError',
        );
      }
      return data;
    }
    get name(): string {
      return this._name;
    }
    get keyPath(): Any {
      const path = this._data.keyPath;
      return Array.isArray(path) ? [...path] : path;
    }
    get autoIncrement(): boolean {
      return this._data.autoIncrement;
    }
    get indexNames(): Any {
      return stringList(this._data.indexes.keys());
    }
    get transaction(): Any {
      return this._tx;
    }
    _writable(): void {
      if (this._tx.mode === 'readonly') {
        throw new DOMException(
          'The transaction is read-only.',
          'ReadOnlyError',
        );
      }
    }
    put(value: Any, key?: Any): Any {
      return this._write(value, key, false);
    }
    add(value: Any, key?: Any): Any {
      return this._write(value, key, true);
    }
    _write(value: Any, key: Any, add: boolean): Any {
      this._writable();
      const data = this._data;
      const clone = structuredCopy(value, new Map());
      let theKey: Any = undefined;
      if (data.keyPath !== null) {
        if (key !== undefined) {
          throw dataError('A store with in-line keys takes no key argument.');
        }
        theKey = atKeyPath(clone, data.keyPath);
        if (theKey === undefined) {
          if (!data.autoIncrement) {
            throw dataError('The key path names nothing in the value.');
          }
        } else theKey = checkKey(theKey);
      } else if (key === undefined) {
        if (!data.autoIncrement) {
          throw dataError('No key was given, and the store makes none.');
        }
      } else theKey = checkKey(key);
      return this._tx._request(this, () => {
        let k = theKey;
        if (k === undefined) {
          if (data.current > 2 ** 53) {
            throw new DOMException(
              'The key generator is spent.',
              'ConstraintError',
            );
          }
          k = data.current;
          data.current += 1;
          if (data.keyPath !== null) atKeyPathSet(clone, data.keyPath, k);
        } else if (
          data.autoIncrement &&
          typeof k === 'number' &&
          k >= data.current
        ) {
          data.current = Math.floor(k) + 1;
        }
        const at = findKey(data, k);
        if (at.found && add) {
          throw new DOMException(
            'A record with that key is in the store already.',
            'ConstraintError',
          );
        }
        for (const index of data.indexes.values()) {
          if (!index.unique) continue;
          for (const ik of indexKeys(index, clone)) {
            const taken = data.records.some(
              (r) =>
                cmpKey(r.key, k) !== 0 &&
                indexKeys(index, r.value).some((x) => cmpKey(x, ik) === 0),
            );
            if (taken) {
              throw new DOMException(
                `Index '${index.name}' takes each key once.`,
                'ConstraintError',
              );
            }
          }
        }
        if (at.found) data.records[at.i] = { key: k, value: clone };
        else data.records.splice(at.i, 0, { key: k, value: clone });
        return copyKey(k);
      });
    }
    get(query: Any): Any {
      const range = rangeOf(query, true);
      return this._tx._request(this, () => {
        const record = this._data.records.find((r) => inRange(range, r.key));
        return record ? structuredCopy(record.value, new Map()) : undefined;
      });
    }
    getKey(query: Any): Any {
      const range = rangeOf(query, true);
      return this._tx._request(this, () => {
        const record = this._data.records.find((r) => inRange(range, r.key));
        return record ? copyKey(record.key) : undefined;
      });
    }
    getAll(queryOrOptions?: Any, count?: Any): Any {
      return readAll(this, queryOrOptions, count, (e) =>
        structuredCopy(e.value, new Map()),
      );
    }
    getAllKeys(queryOrOptions?: Any, count?: Any): Any {
      return readAll(this, queryOrOptions, count, (e) => copyKey(e.primaryKey));
    }
    getAllRecords(options?: Any): Any {
      return readAll(this, options ?? {}, undefined, recordOf, true);
    }
    count(query?: Any): Any {
      const range = rangeOf(query);
      return this._tx._request(
        this,
        () => this._data.records.filter((r) => inRange(range, r.key)).length,
      );
    }
    delete(query: Any): Any {
      this._writable();
      const range = rangeOf(query, true);
      return this._tx._request(this, () => {
        const data = this._data;
        data.records = data.records.filter((r) => !inRange(range, r.key));
        return undefined;
      });
    }
    clear(): Any {
      this._writable();
      return this._tx._request(this, () => {
        this._data.records = [];
        return undefined;
      });
    }
    openCursor(query?: Any, direction?: Any): Any {
      return openCursor(this, query, direction, true);
    }
    openKeyCursor(query?: Any, direction?: Any): Any {
      return openCursor(this, query, direction, false);
    }
    createIndex(name: Any, keyPath: Any, options: Any = {}): Any {
      if (this._tx.mode !== 'versionchange') {
        throw new DOMException(
          'An index is made only while the database is upgraded.',
          'InvalidStateError',
        );
      }
      const data = this._data;
      const indexName = str(name);
      if (data.indexes.has(indexName)) {
        throw new DOMException(
          `An index named '${indexName}' already exists.`,
          'ConstraintError',
        );
      }
      if (!validKeyPath(keyPath)) {
        throw new DOMException('The key path is not valid.', 'SyntaxError');
      }
      if (options?.multiEntry && Array.isArray(keyPath)) {
        throw new DOMException(
          'A multiEntry index takes no array key path.',
          'InvalidAccessError',
        );
      }
      const index: IdbIndex = {
        name: indexName,
        keyPath: Array.isArray(keyPath) ? keyPath.map(str) : keyPath,
        unique: !!options?.unique,
        multiEntry: !!options?.multiEntry,
      };
      data.indexes.set(indexName, index);
      return this.index(indexName);
    }
    deleteIndex(name: Any): void {
      if (this._tx.mode !== 'versionchange') {
        throw new DOMException(
          'An index is deleted only while the database is upgraded.',
          'InvalidStateError',
        );
      }
      if (!this._data.indexes.delete(str(name))) {
        throw new DOMException(
          `No index named '${str(name)}'.`,
          'NotFoundError',
        );
      }
    }
    index(name: Any): Any {
      const indexName = str(name);
      if (!this._data.indexes.has(indexName)) {
        throw new DOMException(
          `No index named '${indexName}'.`,
          'NotFoundError',
        );
      }
      return new IDBIndex(this, indexName);
    }
  }

  class IDBIndex {
    _store: Any;
    _name: string;
    constructor(store: Any, name: string) {
      this._store = store;
      this._name = name;
    }
    get _data(): IdbIndex {
      const data = this._store._data.indexes.get(this._name);
      if (!data) {
        throw new DOMException('The index was deleted.', 'InvalidStateError');
      }
      return data;
    }
    get _tx(): Any {
      return this._store._tx;
    }
    get objectStore(): Any {
      return this._store;
    }
    get name(): string {
      return this._name;
    }
    get keyPath(): Any {
      const path = this._data.keyPath;
      return Array.isArray(path) ? [...path] : path;
    }
    get unique(): boolean {
      return this._data.unique;
    }
    get multiEntry(): boolean {
      return this._data.multiEntry;
    }
    get(query: Any): Any {
      const range = rangeOf(query, true);
      return this._tx._request(this, () => {
        const entry = sourceEntries(this).find((e) => inRange(range, e.key));
        return entry ? structuredCopy(entry.value, new Map()) : undefined;
      });
    }
    getKey(query: Any): Any {
      const range = rangeOf(query, true);
      return this._tx._request(this, () => {
        const entry = sourceEntries(this).find((e) => inRange(range, e.key));
        return entry ? copyKey(entry.primaryKey) : undefined;
      });
    }
    getAll(queryOrOptions?: Any, count?: Any): Any {
      return readAll(this, queryOrOptions, count, (e) =>
        structuredCopy(e.value, new Map()),
      );
    }
    getAllKeys(queryOrOptions?: Any, count?: Any): Any {
      return readAll(this, queryOrOptions, count, (e) => copyKey(e.primaryKey));
    }
    getAllRecords(options?: Any): Any {
      return readAll(this, options ?? {}, undefined, recordOf, true);
    }
    count(query?: Any): Any {
      const range = rangeOf(query);
      return this._tx._request(
        this,
        () => sourceEntries(this).filter((e) => inRange(range, e.key)).length,
      );
    }
    openCursor(query?: Any, direction?: Any): Any {
      return openCursor(this, query, direction, true);
    }
    openKeyCursor(query?: Any, direction?: Any): Any {
      return openCursor(this, query, direction, false);
    }
  }

  /** A record `getAllRecords` answers with (IndexedDB 3, `IDBRecord`): its
   *  key, its primary key and its value, which for a store's record are
   *  its key twice. */
  class IDBRecord {
    readonly _key: Any;
    readonly _primaryKey: Any;
    readonly _value: Any;
    constructor(key: Any, primaryKey: Any, value: Any) {
      this._key = key;
      this._primaryKey = primaryKey;
      this._value = value;
    }
    get key(): Any {
      return this._key;
    }
    get primaryKey(): Any {
      return this._primaryKey;
    }
    get value(): Any {
      return this._value;
    }
    get [Symbol.toStringTag](): string {
      return 'IDBRecord';
    }
  }
  const recordOf = (e: Any): Any =>
    new IDBRecord(
      copyKey(e.key),
      copyKey(e.primaryKey),
      structuredCopy(e.value, new Map()),
    );

  /** Whether `getAll`'s first argument is an `IDBGetAllOptions`
   *  dictionary rather than a query: an object that is no key range and
   *  could be no key — an array, a date or a buffer is a key, or an
   *  invalid one, and a `DataError`. */
  const isGetAllOptions = (value: Any): boolean =>
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof IDBKeyRange) &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(value);

  /** `getAll`, `getAllKeys` and `getAllRecords`, of a store or an index
   *  (IndexedDB 3, "retrieve multiple items"): the records in the query,
   *  in the direction asked — a unique one the first record of each key,
   *  `prev` and `prevunique` from the last key back — and no more of them
   *  than `count`, where 0 is all. A dictionary in place of the query is
   *  read for all three, and then the count after it is not. */
  const readAll = (
    source: Any,
    queryOrOptions: Any,
    count: Any,
    out: (e: Any) => Any,
    dictionary = false,
  ): Any => {
    let query = queryOrOptions;
    let direction = 'next';
    if (dictionary || isGetAllOptions(queryOrOptions)) {
      // a dictionary's members are read in their names' order (WebIDL)
      const options = queryOrOptions ?? {};
      count = options.count;
      const asked = options.direction;
      direction = asked === undefined ? 'next' : str(asked);
      if (!DIRECTIONS.includes(direction)) {
        throw new TypeError(
          `The provided value '${direction}' is not a valid enum value of type IDBCursorDirection.`,
        );
      }
      query = options.query;
    }
    const range = rangeOf(query);
    let most = Infinity;
    if (count !== undefined) {
      // [EnforceRange] unsigned long
      const n = Number(count);
      if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) {
        throw new TypeError(
          "Value is outside the 'unsigned long' value range.",
        );
      }
      if (Math.trunc(n) > 0) most = Math.trunc(n);
    }
    return source._tx._request(source, () => {
      let entries = sourceEntries(source).filter((e) => inRange(range, e.key));
      if (direction.endsWith('unique')) {
        entries = entries.filter(
          (e, i) => i === 0 || cmpKey(e.key, entries[i - 1].key) !== 0,
        );
      }
      if (direction.startsWith('prev')) entries = entries.reverse();
      return entries.slice(0, most).map(out);
    });
  };

  const DIRECTIONS = ['next', 'nextunique', 'prev', 'prevunique'];
  /** The entry a cursor goes to next (IndexedDB 3, "iterate a cursor"):
   *  past where it is, at or past `key` where one is asked for, and in
   *  `primaryKey`'s order past that key where one is. */
  const nextEntry = (cursor: Any, key: Any, primaryKey: Any): Any => {
    const entries = sourceEntries(cursor._source).filter((e: Any) =>
      inRange(cursor._range, e.key),
    );
    const at = cursor._position;
    const forward = cursor.direction.startsWith('next');
    const unique = cursor.direction.endsWith('unique');
    const after = (e: Any): boolean => {
      if (at) {
        const c = cmpKey(e.key, at.key);
        if (forward ? c < 0 : c > 0) return false;
        if (c === 0) {
          if (unique) return false;
          const p = cmpKey(e.primaryKey, at.primaryKey);
          if (forward ? p <= 0 : p >= 0) return false;
        }
      }
      if (key !== undefined) {
        const c = cmpKey(e.key, key);
        if (forward ? c < 0 : c > 0) return false;
        if (c === 0 && primaryKey !== undefined) {
          const p = cmpKey(e.primaryKey, primaryKey);
          if (forward ? p < 0 : p > 0) return false;
        }
      }
      return true;
    };
    const found = (forward ? entries : entries.slice().reverse()).filter(after);
    if (!found.length) return null;
    // `prevunique` lands on the first of the records under the key it finds
    if (!forward && unique) {
      return entries.find((e: Any) => cmpKey(e.key, found[0].key) === 0);
    }
    return found[0];
  };

  class IDBCursor {
    _source: Any;
    _range: Any;
    _request: Any;
    _position: Any = null;
    _value: Any = undefined;
    _got = false;
    readonly direction: string;
    constructor(source: Any, range: Any, direction: string, request: Any) {
      this._source = source;
      this._range = range;
      this.direction = direction;
      this._request = request;
    }
    get source(): Any {
      return this._source;
    }
    get request(): Any {
      return this._request;
    }
    get key(): Any {
      return this._position ? copyKey(this._position.key) : undefined;
    }
    get primaryKey(): Any {
      return this._position ? copyKey(this._position.primaryKey) : undefined;
    }
    _step(key?: Any, primaryKey?: Any, count = 1): void {
      if (!this._got) {
        throw new DOMException(
          'The cursor is being iterated or has iterated past its end.',
          'InvalidStateError',
        );
      }
      this._got = false;
      this._source._tx._request(
        this._source,
        () => {
          let entry: Any = null;
          for (let i = 0; i < count; i += 1) {
            entry = nextEntry(
              this,
              i === 0 ? key : undefined,
              i === 0 ? primaryKey : undefined,
            );
            if (!entry) break;
            this._position = entry;
          }
          if (!entry) {
            this._position = null;
            return null;
          }
          this._value = entry.value;
          this._got = true;
          return this;
        },
        this._request,
      );
    }
    continue(key?: Any): void {
      this._step(key === undefined ? undefined : checkKey(key));
    }
    continuePrimaryKey(key: Any, primaryKey: Any): void {
      this._step(checkKey(key), checkKey(primaryKey));
    }
    advance(count: Any): void {
      const n = Number(count) >>> 0;
      if (!n) throw new TypeError('A cursor advances by one or more.');
      this._step(undefined, undefined, n);
    }
    _store(): Any {
      return this._source instanceof IDBIndex
        ? this._source._store
        : this._source;
    }
    update(value: Any): Any {
      if (!this._got || !(this instanceof IDBCursorWithValue)) {
        throw new DOMException(
          'The cursor has no record.',
          'InvalidStateError',
        );
      }
      const store = this._store();
      const primaryKey = this._position.primaryKey;
      if (store._data.keyPath !== null) {
        const k = atKeyPath(value, store._data.keyPath);
        if (k === undefined || cmpKey(k, primaryKey) !== 0) {
          throw dataError('The value names another key than the record has.');
        }
        return store.put(value);
      }
      return store.put(value, primaryKey);
    }
    delete(): Any {
      if (!this._got || !(this instanceof IDBCursorWithValue)) {
        throw new DOMException(
          'The cursor has no record.',
          'InvalidStateError',
        );
      }
      return this._store().delete(this._position.primaryKey);
    }
  }
  class IDBCursorWithValue extends IDBCursor {
    get value(): Any {
      return structuredCopy(this._value, new Map());
    }
  }
  const openCursor = (
    source: Any,
    query: Any,
    direction: Any,
    withValue: boolean,
  ): Any => {
    const dir = direction === undefined ? 'next' : str(direction);
    if (!DIRECTIONS.includes(dir)) {
      throw new TypeError(`'${dir}' is not a valid cursor direction.`);
    }
    const range = rangeOf(query);
    const request = new IDBRequest();
    const Cursor = withValue ? IDBCursorWithValue : IDBCursor;
    const cursor = new Cursor(source, range, dir, request);
    cursor._got = true;
    cursor._step();
    return request;
  };

  class IDBFactory {
    open(name: Any, version?: Any): Any {
      const dbName = str(name);
      let wanted: number | undefined;
      if (version !== undefined) {
        wanted = Number(version);
        if (!Number.isInteger(wanted) || wanted < 1 || wanted > 2 ** 53 - 1) {
          throw new TypeError('The version is not a whole number from 1.');
        }
      }
      const request = new IDBOpenDBRequest();
      setTimer(
        () => {
          let data = idbDatabases.get(dbName);
          const old = data ? data.version : 0;
          const target = wanted ?? (data ? data.version : 1);
          if (target < old) {
            request._done = true;
            request._error = new DOMException(
              `The requested version (${target}) is less than the existing version (${old}).`,
              'VersionError',
            );
            fireAt(
              [request],
              new Event('error', { bubbles: true, cancelable: true }),
            );
            return;
          }
          if (!data) {
            data = {
              name: dbName,
              version: 0,
              stores: new Map(),
              connections: new Set(),
            };
            idbDatabases.set(dbName, data);
          }
          const db = new IDBDatabase(data);
          data.connections.add(db);
          if (target === old) {
            request._done = true;
            request._result = db;
            fireAt([request], new Event('success'));
            return;
          }
          // the other connections are told, and this one is upgraded
          for (const other of data.connections) {
            if (other !== db && !other._closed) {
              fireAt(
                [other],
                new IDBVersionChangeEvent('versionchange', {
                  oldVersion: old,
                  newVersion: target,
                }),
              );
            }
          }
          const tx = new IDBTransaction(db, [], 'versionchange');
          data.version = target;
          db._upgrade = tx;
          request.transaction = tx;
          request._done = true;
          request._result = db;
          tx._onDone = (ok: boolean) => {
            db._upgrade = null;
            request.transaction = null;
            if (ok) {
              fireAt([request], new Event('success'));
              return;
            }
            db.close();
            if (!old) idbDatabases.delete(dbName);
            request._result = undefined;
            request._error = new DOMException(
              'The upgrade was aborted.',
              'AbortError',
            );
            fireAt(
              [request],
              new Event('error', { bubbles: true, cancelable: true }),
            );
          };
          fireAt(
            [request],
            new IDBVersionChangeEvent('upgradeneeded', {
              oldVersion: old,
              newVersion: target,
            }),
          );
        },
        0,
        [],
        false,
      );
      return request;
    }
    deleteDatabase(name: Any): Any {
      const dbName = str(name);
      const request = new IDBOpenDBRequest();
      setTimer(
        () => {
          const data = idbDatabases.get(dbName);
          const old = data ? data.version : 0;
          for (const other of data?.connections ?? []) {
            if (!other._closed) {
              fireAt(
                [other],
                new IDBVersionChangeEvent('versionchange', {
                  oldVersion: old,
                  newVersion: null,
                }),
              );
            }
          }
          idbDatabases.delete(dbName);
          request._done = true;
          request._result = undefined;
          fireAt(
            [request],
            new IDBVersionChangeEvent('success', {
              oldVersion: old,
              newVersion: null,
            }),
          );
        },
        0,
        [],
        false,
      );
      return request;
    }
    databases(): Promise<Any[]> {
      return Promise.resolve(
        [...idbDatabases.values()].map((d) => ({
          name: d.name,
          version: d.version,
        })),
      );
    }
    cmp(a: Any, b: Any): number {
      checkKey(a);
      checkKey(b);
      return cmpKey(a, b);
    }
  }

  /** `localStorage` and `sessionStorage`, kept by the host per origin. */
  /** Which storage a `Storage` is: the object and the proxy a page holds
   *  both, since the methods are the prototype's and run with either. */
  const storageKinds = new WeakMap<object, 'local' | 'session'>();
  const kindOf = (store: Any): 'local' | 'session' => {
    const kind = storageKinds.get(store);
    if (!kind) throw new TypeError('Illegal invocation');
    return kind;
  };
  const storageKeys = (kind: 'local' | 'session'): string[] => {
    const s = call('storage', kind, 'keys');
    return typeof s === 'string' && s ? s.split('\u0000') : [];
  };
  /** `Storage` (HTML 12.2.1): its methods on its prototype, where a page
   *  patches `setItem` to watch what is written. */
  class Storage {
    getItem(k: Any): Any {
      return call('storage', kindOf(this), 'get', str(k)) ?? null;
    }
    setItem(k: Any, v: Any): void {
      call('storage', kindOf(this), 'set', str(k), str(v));
    }
    removeItem(k: Any): void {
      call('storage', kindOf(this), 'remove', str(k));
    }
    clear(): void {
      call('storage', kindOf(this), 'clear');
    }
    key(i: Any): Any {
      return storageKeys(kindOf(this))[Number(i)] ?? null;
    }
    get length(): number {
      return storageKeys(kindOf(this)).length;
    }
  }
  /** `localStorage` and `sessionStorage`: a `Storage` whose other
   *  properties are its items, as a browser's is. */
  const storage = (kind: 'local' | 'session'): Any => {
    const target = Object.create(Storage.prototype);
    storageKinds.set(target, kind);
    const item = (key: string): Any =>
      call('storage', kind, 'get', key) ?? undefined;
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        if (typeof key !== 'string' || key in t) {
          return Reflect.get(t, key, receiver);
        }
        return item(key);
      },
      set(t, key, value) {
        if (typeof key !== 'string') return Reflect.set(t, key, value);
        call('storage', kind, 'set', key, str(value));
        return true;
      },
      has(t, key) {
        return key in t || (typeof key === 'string' && item(key) !== undefined);
      },
      deleteProperty(_t, key) {
        if (typeof key === 'string') call('storage', kind, 'remove', key);
        return true;
      },
      ownKeys: () => storageKeys(kind),
      getOwnPropertyDescriptor(_t, key) {
        if (typeof key !== 'string') return undefined;
        const value = item(key);
        return value === undefined
          ? undefined
          : { value, writable: true, enumerable: true, configurable: true };
      },
    });
    storageKinds.set(proxy, kind);
    return proxy;
  };

  /** `console`, to the host's log. */
  const show = (v: Any, depth = 0): string => {
    if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
    if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
    if (v instanceof Node) {
      return v instanceof Element ? `<${v.localName}>` : v.nodeName;
    }
    if (typeof v === 'function') return `[Function ${v.name || '(anonymous)'}]`;
    if (v && typeof v === 'object') {
      if (depth > 1) return Array.isArray(v) ? '[Array]' : '[Object]';
      try {
        if (Array.isArray(v))
          return `[${v.map((x) => show(x, depth + 1)).join(', ')}]`;
        return `{ ${Object.keys(v)
          .slice(0, 20)
          .map((k) => `${k}: ${show(v[k], depth + 1)}`)
          .join(', ')} }`;
      } catch {
        return '[Object]';
      }
    }
    return String(v);
  };
  const logTo =
    (level: string) =>
    (...args: Any[]): void => {
      let text: string;
      try {
        text = args.map((a) => show(a)).join(' ');
      } catch {
        text = '(unprintable)';
      }
      bridge('log', level, text);
    };
  const counts = new Map<string, number>();
  const times = new Map<string, number>();
  const console = {
    log: logTo('log'),
    info: logTo('info'),
    debug: logTo('debug'),
    warn: logTo('warn'),
    error: logTo('error'),
    trace: logTo('debug'),
    dir: logTo('log'),
    dirxml: logTo('log'),
    table: logTo('log'),
    group: logTo('log'),
    groupCollapsed: logTo('log'),
    groupEnd: () => {},
    assert: (ok: Any, ...args: Any[]) => {
      if (!ok) logTo('error')('Assertion failed:', ...args);
    },
    count: (label = 'default') => {
      const n = (counts.get(label) ?? 0) + 1;
      counts.set(label, n);
      logTo('log')(`${label}: ${n}`);
    },
    countReset: (label = 'default') => counts.delete(label),
    time: (label = 'default') => times.set(label, now()),
    timeEnd: (label = 'default') => {
      const from = times.get(label);
      times.delete(label);
      if (from !== undefined) logTo('log')(`${label}: ${now() - from} ms`);
    },
    timeLog: (label = 'default') => {
      const from = times.get(label);
      if (from !== undefined) logTo('log')(`${label}: ${now() - from} ms`);
    },
  };

  class AbortSignal extends EventTarget {
    aborted = false;
    reason: Any = undefined;
    onabort: Any = null;
    static abort(reason?: Any): Any {
      const c = new AbortController();
      c.abort(reason);
      return c.signal;
    }
    static timeout(ms: number): Any {
      const c = new AbortController();
      setTimer(
        () => c.abort(new DOMException('signal timed out', 'TimeoutError')),
        ms,
        [],
        false,
      );
      return c.signal;
    }
    throwIfAborted(): void {
      if (this.aborted) throw this.reason;
    }
  }
  class AbortController {
    readonly signal: Any = Object.create(AbortSignal.prototype);
    constructor() {
      Object.assign(this.signal, new EventTarget(), {
        aborted: false,
        reason: undefined,
        onabort: null,
      });
    }
    abort(reason?: Any): void {
      const s = this.signal;
      if (s.aborted) return;
      s.aborted = true;
      s.reason =
        reason ??
        new DOMException('signal is aborted without reason', 'AbortError');
      const ev = new Event('abort');
      if (typeof s.onabort === 'function') {
        try {
          s.onabort(ev);
        } catch (e) {
          report(e);
        }
      }
      dispatch(s, ev);
    }
  }

  /** `matchMedia`: answered by the host from `<Html>`'s own media queries,
   *  each time `matches` is read — no listener hears it change. */
  const matchMedia = (query: Any): Any => {
    const media = str(query);
    return {
      media,
      get matches() {
        return !!call('media', media);
      },
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    };
  };

  /** `getComputedStyle`: the host's `computedStyle`, a declaration that
   *  answers by a property's name, either spelling — and a custom
   *  property's by its name alone, asked for as it is read, since a theme
   *  sets hundreds of them on the root. */
  const getComputedStyle = (el: Any, pseudo?: Any): Any => {
    const which = pseudo ? String(pseudo).replace(/^:+/, '') : '';
    const id = idOf(el, 'element');
    const json = call('computed', id, which);
    const values: Record<string, string> =
      typeof json === 'string' && json ? JSON.parse(json) : {};
    const out: Any = {
      getPropertyValue: (name: Any) => {
        const n = cssName(name);
        if (!n.startsWith('--')) return values[n] ?? '';
        if (!json) return '';
        return String(call('customProperty', id, which, n) ?? '');
      },
      getPropertyPriority: () => '',
      length: Object.keys(values).length,
      item: (i: number) => Object.keys(values)[i] ?? '',
      cssText: '',
    };
    for (const [name, value] of Object.entries(values)) {
      out[name] = value;
      out[camel(name)] = value;
    }
    return out;
  };

  const base64 =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const btoa = (input: Any): string => {
    const s = str(input);
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i);
      const b = s.charCodeAt(i + 1);
      const c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) {
        throw new DOMException(
          'The string to be encoded contains characters outside of the Latin1 range.',
          'InvalidCharacterError',
        );
      }
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += base64[(n >> 18) & 63] + base64[(n >> 12) & 63];
      out += i + 1 < s.length ? base64[(n >> 6) & 63] : '=';
      out += i + 2 < s.length ? base64[n & 63] : '=';
    }
    return out;
  };
  const atob = (input: Any): string => {
    const s = str(input)
      .replace(/[\t\n\f\r ]+/g, '')
      .replace(/=+$/, '');
    let out = '';
    let bits = 0;
    let n = 0;
    for (const ch of s) {
      const v = base64.indexOf(ch);
      if (v < 0) {
        throw new DOMException(
          'The string to be decoded is not correctly encoded.',
          'InvalidCharacterError',
        );
      }
      n = (n << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((n >> bits) & 255);
      }
    }
    return out;
  };

  /** Observers a page makes at its start. `IntersectionObserver` reports
   *  what it observes once, as in view — what a lazy loader waits for —
   *  and `ResizeObserver` each size its targets come to. `MutationObserver`
   *  is below. */
  /** What an `IntersectionObserver` hands its callback. A page tells the
   *  native interface from none by this one: Next.js installs the W3C
   *  polyfill where it is missing, and the polyfill measures every target
   *  again at every mutation of the document, a whole layout a time —
   *  react.dev's tutorial ran it without end. */
  class IntersectionObserverEntry {
    _init: Any;
    constructor(init: Any) {
      this._init = init;
    }
  }
  // on the prototype, as the native interface's are: a polyfill asks
  // `'intersectionRatio' in IntersectionObserverEntry.prototype`
  for (const name of [
    'time',
    'target',
    'rootBounds',
    'boundingClientRect',
    'intersectionRect',
    'isIntersecting',
    'intersectionRatio',
  ]) {
    Object.defineProperty(IntersectionObserverEntry.prototype, name, {
      get(this: Any) {
        return this._init[name];
      },
      configurable: true,
      enumerable: true,
    });
  }
  class IntersectionObserver {
    _fn: Any;
    constructor(fn: Any) {
      this._fn = fn;
    }
    observe(el: Any): void {
      setTimer(
        () =>
          this._fn(
            [
              new IntersectionObserverEntry({
                target: el,
                isIntersecting: true,
                intersectionRatio: 1,
                boundingClientRect: el.getBoundingClientRect(),
                intersectionRect: el.getBoundingClientRect(),
                rootBounds: null,
                time: now(),
              }),
            ],
            this,
          ),
        0,
        [],
        false,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): Any[] {
      return [];
    }
  }
  /** An element's border box and its content box, in CSS pixels, or null
   *  where it has no box. */
  const boxSizesOf = (el: Any): number[] | null => {
    const r = docRect(el);
    if (!r) return null;
    const e = call('edges', el._id);
    const [pt, pr, pb, pl, bt, br, bb, bl] =
      typeof e === 'string' && e
        ? e.split(',').map(Number)
        : [0, 0, 0, 0, 0, 0, 0, 0];
    return [
      r[2],
      r[3],
      Math.max(0, r[2] - pl - pr - bl - br),
      Math.max(0, r[3] - pt - pb - bt - bb),
      pl,
      pt,
    ];
  };
  class ResizeObserverSize {
    readonly inlineSize: number;
    readonly blockSize: number;
    constructor(inline: number, block: number) {
      this.inlineSize = inline;
      this.blockSize = block;
    }
  }
  class ResizeObserverEntry {
    readonly target: Any;
    readonly contentRect: Any;
    readonly contentBoxSize: Any;
    readonly borderBoxSize: Any;
    readonly devicePixelContentBoxSize: Any;
    constructor(target: Any, sizes: number[]) {
      const [bw, bh, cw, ch, x, y] = sizes;
      const dpr = viewport().dpr || 1;
      this.target = target;
      this.contentRect = new DOMRect(x, y, cw, ch);
      this.contentBoxSize = [new ResizeObserverSize(cw, ch)];
      this.borderBoxSize = [new ResizeObserverSize(bw, bh)];
      this.devicePixelContentBoxSize = [
        new ResizeObserverSize(Math.round(cw * dpr), Math.round(ch * dpr)),
      ];
    }
  }
  /** The observers observing something, and whether their sizes are to
   *  be looked at again: a tenth of a second after the last look, while
   *  any observes, as nothing tells this realm a layout came out
   *  otherwise. */
  const resizing = new Set<Any>();
  let resizeLook = false;
  const lookAgain = (ms: number): void => {
    if (resizeLook || !resizing.size) return;
    resizeLook = true;
    setTimer(
      () => {
        resizeLook = false;
        for (const observer of [...resizing]) observer._look();
        lookAgain(100);
      },
      ms,
      [],
      false,
    );
  };
  /**
   * Told each size its targets come to (Resize Observer 1): once as one is
   * observed, where it has a size, and again whenever its content box
   * changes — React components that size a canvas to its container, as
   * Rive's do, wait for a size their container has only once the
   * stylesheet is in, and were told 0 by 0 for good.
   */
  class ResizeObserver {
    _fn: Any;
    /** The size last told for each target, content box width and height,
     *  0 by 0 to start with, which is told only where it changes. */
    _told = new Map<Any, number[]>();
    constructor(fn: Any) {
      if (typeof fn !== 'function') {
        throw new TypeError(
          "Failed to construct 'ResizeObserver': parameter 1 is not of type 'Function'.",
        );
      }
      this._fn = fn;
    }
    observe(el: Any): void {
      if (!this._told.has(el)) this._told.set(el, [0, 0]);
      resizing.add(this);
      lookAgain(0);
    }
    unobserve(el: Any): void {
      this._told.delete(el);
      if (!this._told.size) resizing.delete(this);
    }
    disconnect(): void {
      this._told.clear();
      resizing.delete(this);
    }
    _look(): void {
      const entries: Any[] = [];
      for (const [el, told] of this._told) {
        const sizes = boxSizesOf(el) ?? [0, 0, 0, 0, 0, 0];
        if (sizes[2] === told[0] && sizes[3] === told[1]) continue;
        this._told.set(el, [sizes[2], sizes[3]]);
        entries.push(new ResizeObserverEntry(el, sizes));
      }
      if (!entries.length) return;
      try {
        this._fn.call(this, entries, this);
      } catch (e) {
        report(e);
      }
    }
  }
  /** What a `MutationObserver` is handed (DOM 4.3.4). */
  class MutationRecord {
    readonly type: string;
    readonly target: Any;
    readonly addedNodes: Any;
    readonly removedNodes: Any;
    readonly previousSibling: Any;
    readonly nextSibling: Any;
    readonly attributeName: string | null;
    readonly attributeNamespace = null;
    readonly oldValue: string | null;
    constructor(raw: Any[]) {
      this.type = raw[0];
      this.target = wrap(raw[1]);
      this.addedNodes = list(raw[2].map(wrap));
      this.removedNodes = list(raw[3].map(wrap));
      this.previousSibling = wrap(raw[4]);
      this.nextSibling = wrap(raw[5]);
      this.attributeName = raw[6];
      this.oldValue = raw[7];
    }
  }

  /** The observers observing, by id, which the host queues records for as
   *  the tree changes (`host.ts`, `_queue`). */
  let observerSeq = 0;
  const observing = new Map<number, Any>();
  /** Whether the microtask that hands the observers their records is
   *  queued (DOM 4.3, "queue a mutation observer microtask"). */
  let notifying = false;
  /** After an op that changed the tree: a microtask that hands each
   *  observer what it was queued, in the order they were made. A callback
   *  that changes the tree again queues the next. */
  const mutated = (): void => {
    if (notifying || !observing.size) return;
    notifying = true;
    Promise.resolve().then(() => {
      notifying = false;
      for (const id of idList(call('observed'))) {
        const observer = observing.get(id);
        if (!observer) continue;
        const records = observer.takeRecords();
        if (!records.length) continue;
        try {
          observer._fn.call(observer, records, observer);
        } catch (e) {
          report(e);
        }
      }
    });
  };

  class MutationObserver {
    _fn: Any;
    readonly _id = ++observerSeq;
    constructor(fn: Any) {
      if (typeof fn !== 'function') {
        throw new TypeError(
          "Failed to construct 'MutationObserver': parameter 1 is not of type 'Function'.",
        );
      }
      this._fn = fn;
    }
    observe(target: Any, options: Any = {}): void {
      const id = idOf(target, 'parameter 1');
      let { attributes, characterData } = options;
      // implied by what asks for them (DOM 4.3.1, `observe()`)
      if (
        attributes === undefined &&
        (options.attributeOldValue !== undefined ||
          options.attributeFilter !== undefined)
      ) {
        attributes = true;
      }
      if (
        characterData === undefined &&
        options.characterDataOldValue !== undefined
      ) {
        characterData = true;
      }
      const fail = (why: string) => {
        throw new TypeError(
          `Failed to execute 'observe' on 'MutationObserver': ${why}`,
        );
      };
      if (!options.childList && !attributes && !characterData) {
        fail(
          "The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.",
        );
      }
      if (options.attributeOldValue && !attributes) {
        fail(
          "The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.",
        );
      }
      if (options.attributeFilter !== undefined && !attributes) {
        fail(
          "The options object may only set 'attributeFilter' when 'attributes' is true or not present.",
        );
      }
      if (options.characterDataOldValue && !characterData) {
        fail(
          "The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.",
        );
      }
      observing.set(this._id, this);
      call(
        'observe',
        this._id,
        id,
        JSON.stringify({
          childList: !!options.childList,
          attributes: !!attributes,
          characterData: !!characterData,
          subtree: !!options.subtree,
          attributeOldValue: !!options.attributeOldValue,
          characterDataOldValue: !!options.characterDataOldValue,
          attributeFilter:
            options.attributeFilter === undefined
              ? null
              : Array.from(options.attributeFilter, (n: Any) => str(n)),
        }),
      );
    }
    disconnect(): void {
      observing.delete(this._id);
      call('disconnect', this._id);
    }
    takeRecords(): Any[] {
      const raw = JSON.parse(String(call('takeRecords', this._id)));
      return raw.map((r: Any[]) => new MutationRecord(r));
    }
  }

  const [userAgent, language] = String(call('navigator')).split('\u0000');
  const navigator = {
    userAgent,
    appName: 'Netscape',
    appVersion: userAgent.replace(/^Mozilla\//, ''),
    platform: 'Linux x86_64',
    vendor: '',
    language,
    languages: [language],
    onLine: true,
    cookieEnabled: false,
    doNotTrack: '1',
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
    webdriver: false,
    pdfViewerEnabled: false,
    // none, as a browser that shows no PDF has none: what a script counts
    plugins: new PluginArray(),
    mimeTypes: new MimeTypeArray(),
    // `clipboard` and `serviceWorker` are left out rather than undefined:
    // a page asks for them with `in`, and takes one that is there for one
    // it can use
    sendBeacon: () => false,
    javaEnabled: () => false,
  };

  const history = {
    get length(): number {
      return 1;
    },
    state: null as Any,
    scrollRestoration: 'auto',
    back: () => void call('go', -1),
    forward: () => void call('go', 1),
    go: (n = 0) => void (n ? call('go', Number(n)) : call('reload')),
    // the address the document is at changes; the browser's history and
    // its address bar do not — a phase 1 limit
    pushState(state: Any, _title: Any, url?: Any) {
      this.state = state ?? null;
      if (url !== undefined && url !== null) {
        call('setLocation', String(call('resolve', str(url))));
      }
    },
    replaceState(state: Any, title: Any, url?: Any) {
      this.pushState(state, title, url);
    },
  };

  // An accessor of a base interface answers for any node, as a browser's
  // does, where a kind of node answers it its own way: a page that takes
  // one off the prototype and calls it on a node — Contentsquare reads
  // `nodeType` so, off a frame's `Node.prototype`, for a version no page
  // has wrapped — gets what the node's own kind says, where the base's
  // answered as no kind at all, 0 for every element.
  for (const [Base, names] of [
    [Node, ['nodeType', 'nodeName', 'nodeValue', 'textContent']],
    [Element, ['tagName', 'namespaceURI']],
  ] as [Any, string[]][]) {
    for (const name of names) {
      const base = Object.getOwnPropertyDescriptor(Base.prototype, name)!;
      // by the node's prototype, since an element reads `textContent` and
      // `tagName` through this one as often as a page reads them
      const kinds = new WeakMap<object, PropertyDescriptor>();
      const kind = (node: Any): PropertyDescriptor => {
        const proto = Object.getPrototypeOf(node);
        let found = kinds.get(proto);
        if (found) return found;
        found = base;
        for (
          let at = proto;
          at && at !== Base.prototype;
          at = Object.getPrototypeOf(at)
        ) {
          const own = Object.getOwnPropertyDescriptor(at, name);
          if (own) {
            found = own;
            break;
          }
        }
        if (proto) kinds.set(proto, found);
        return found;
      };
      Object.defineProperty(Base.prototype, name, {
        get() {
          const found = kind(this);
          return found.get ? found.get.call(this) : found.value;
        },
        set(v: Any) {
          kind(this).set?.call(this, v);
        },
        configurable: true,
        enumerable: base.enumerable,
      });
    }
  }

  // --- custom elements -----------------------------------------------------------
  //
  // HTML 4.13. The registry is the window's, and so is each element's custom
  // element state, definition and reaction queue: kept here by its wrapper
  // (`customOf`), where no page reads it. GitHub's pages start their React
  // apps from an element's `connectedCallback`, so a page that defines none
  // draws only what its server sent, and a Primer page hides that until a
  // script reveals it.
  //
  // What happens to an element in the tree is the host's to say: once a name
  // is defined, it notes each element that may be a custom element as it is
  // put into the document, taken out, moved to another document, given
  // another attribute value or copied into the document (`DomHost`'s
  // `_custom…`). After each op that can do one of those the facade takes the
  // notes (`takeReactions`) and runs the callbacks and upgrades they come to,
  // as `[CEReactions]` runs them: before the DOM method that made the change
  // returns. A method that is several ops runs them after each, where HTML
  // runs them once at its end — which a page sees only from a callback that
  // reads the tree half way through such a method.

  interface CustomDefinition {
    name: string;
    /** Its own name, or the element an `is` extends. */
    localName: string;
    ctor: Any;
    observed: Set<string>;
    callbacks: Record<string, Any>;
    /** The elements its upgrades are constructing (HTML 4.13.4), each
     *  `CONSTRUCTED` once its constructor's `super()` has returned it. */
    stack: Any[];
    formAssociated: boolean;
    disableInternals: boolean;
    disableShadow: boolean;
  }
  /** An element's custom element state, definition and reaction queue:
   *  each reaction an upgrade or a callback with its arguments. */
  interface CustomState {
    state: 'undefined' | 'failed' | 'precustomized' | 'custom';
    def: CustomDefinition | null;
    queue: ({ upgrade: CustomDefinition } | { fn: Any; args: Any[] })[];
    internals: Any;
  }
  const customOf = new WeakMap<Any, CustomState>();
  const customFor = (el: Any): CustomState => {
    let custom = customOf.get(el);
    if (!custom) {
      custom = { state: 'undefined', def: null, queue: [], internals: null };
      customOf.set(el, custom);
    }
    return custom;
  };
  const definitions = new Map<string, CustomDefinition>();
  const definitionOf = new Map<Any, CustomDefinition>();
  /** `whenDefined`'s promises, by name, until the name is defined. */
  const waitingFor = new Map<string, { promise: Any; resolve: Any }>();
  let defining = false;
  const CONSTRUCTED = {};
  const RESERVED_NAMES = new Set([
    'annotation-xml',
    'color-profile',
    'font-face',
    'font-face-src',
    'font-face-uri',
    'font-face-format',
    'font-face-name',
    'missing-glyph',
  ]);
  /** A valid custom element name (HTML 4.13.2), as `<Html>` reads one. */
  const customName = (name: string): boolean =>
    /^[a-z][^\s\0/>:A-Z]*$/.test(name) &&
    name.includes('-') &&
    !RESERVED_NAMES.has(name);
  /** `createElement`'s `{ is }`. */
  const isOption = (options: Any): string | null =>
    options && typeof options === 'object' && options.is != null
      ? str(options.is)
      : null;

  /** The definition for a local name and an `is` value in this window's
   *  document (HTML 4.13.4, "look up a custom element definition"). */
  const lookUp = (
    local: string,
    is: string | null,
  ): CustomDefinition | null => {
    const own = definitions.get(local);
    if (own && own.localName === local) return own;
    if (is === null) return null;
    const extending = definitions.get(is);
    return extending?.localName === local ? extending : null;
  };
  /** The definition an element would be upgraded with: its own name's, or
   *  its `is`'s, where it is an HTML element of this window's document. */
  const definitionFor = (el: Any): CustomDefinition | null => {
    if (el.namespaceURI !== HTML_NS || el.ownerDocument !== document) {
      return null;
    }
    return lookUp(el.localName, el.getAttribute('is'));
  };

  // the custom element reactions stack (HTML 4.13.6): an element queue a
  // `[CEReactions]` method's steps fill, whose reactions run as it ends, and
  // the backup queue for what is enqueued outside one, run at a microtask
  const reactionStack: Any[][] = [];
  let backupQueue: Any[] | null = null;
  const enqueueElement = (el: Any): void => {
    const top = reactionStack[reactionStack.length - 1];
    if (top) {
      top.push(el);
      return;
    }
    if (!backupQueue) {
      const queue: Any[] = (backupQueue = []);
      Promise.resolve().then(() => {
        backupQueue = null;
        invokeReactions(queue);
      });
    }
    backupQueue.push(el);
  };
  const enqueueCallback = (el: Any, name: string, args: Any[]): void => {
    const custom = customOf.get(el);
    const def = custom?.def;
    const fn = def?.callbacks[name];
    if (!fn) return;
    if (name === 'attributeChangedCallback' && !def!.observed.has(args[0])) {
      return;
    }
    custom!.queue.push({ fn, args });
    enqueueElement(el);
  };
  const enqueueUpgrade = (el: Any, def: CustomDefinition): void => {
    customFor(el).queue.push({ upgrade: def });
    enqueueElement(el);
  };
  const invokeReactions = (queue: Any[]): void => {
    for (const el of queue) {
      const custom = customOf.get(el);
      if (!custom) continue;
      while (custom.queue.length) {
        const reaction = custom.queue.shift()!;
        try {
          if ('upgrade' in reaction) upgrade(el, reaction.upgrade);
          else reaction.fn.apply(el, reaction.args);
        } catch (error) {
          report(error);
        }
      }
    }
  };
  /** `steps` run as a `[CEReactions]` method's are: the reactions they
   *  enqueue run as they end, thrown or not. */
  const withReactions = <T>(steps: () => T): T => {
    reactionStack.push([]);
    try {
      return steps();
    } finally {
      invokeReactions(reactionStack.pop()!);
    }
  };

  /** What happened to the elements that may be custom elements, as the
   *  host noted it, run: a custom element's callbacks, and an element put
   *  into the document or copied into it upgraded where it has a
   *  definition (DOM 4.2.3, "insert", and 4.5, "clone"). */
  const takeReactions = (): void => {
    const raw = bridge('ceTake');
    if (typeof raw !== 'string' || !raw) return;
    const log: Any[][] = JSON.parse(raw);
    withReactions(() => {
      for (const [kind, id, a, b, c] of log) {
        const el = wrap(id);
        if (!el) continue;
        const custom = customOf.get(el);
        if (custom?.state === 'custom') {
          if (kind === 'c') enqueueCallback(el, 'connectedCallback', []);
          else if (kind === 'd') {
            enqueueCallback(el, 'disconnectedCallback', []);
          } else if (kind === 'a') {
            enqueueCallback(el, 'adoptedCallback', [wrap(a), wrap(b)]);
          } else if (kind === 't') {
            enqueueCallback(el, 'attributeChangedCallback', [a, b, c, null]);
          }
        } else if (
          (kind === 'c' || kind === 'u') &&
          (!custom || custom.state === 'undefined')
        ) {
          const def = definitionFor(el);
          if (def) enqueueUpgrade(el, def);
        }
      }
    });
  };

  /** An element made a custom element by its definition (HTML 4.13.5,
   *  "upgrade an element"): the callbacks for the attributes it observes
   *  and for its being in the document queued, and its constructor run
   *  over it. One that throws is left failed, and never upgraded again. */
  const upgrade = (el: Any, def: CustomDefinition): void => {
    const custom = customFor(el);
    if (custom.state !== 'undefined') return;
    custom.def = def;
    custom.state = 'failed';
    for (const name of el.getAttributeNames()) {
      if (def.observed.has(name)) {
        enqueueCallback(el, 'attributeChangedCallback', [
          name,
          null,
          el.getAttribute(name),
          null,
        ]);
      }
    }
    if (el.isConnected) enqueueCallback(el, 'connectedCallback', []);
    def.stack.push(el);
    try {
      if (def.disableShadow && el.shadowRoot) {
        throw new DOMException(
          'The element has a shadow root its definition disables.',
          'NotSupportedError',
        );
      }
      custom.state = 'precustomized';
      const made = new def.ctor();
      if (made !== el) {
        throw new TypeError(
          "Failed to construct 'CustomElement': The result must be the element being upgraded.",
        );
      }
    } catch (error) {
      custom.def = null;
      custom.state = 'failed';
      custom.queue.length = 0;
      throw error;
    } finally {
      def.stack.pop();
    }
    custom.state = 'custom';
    call('ceDefined', el._id);
  };

  /** A custom element's `super()` (HTML 3.2.3, `[HTMLConstructor]`): the
   *  element being upgraded, given the constructor's prototype, or, where
   *  none is, a new element of the definition — `new` called on its
   *  class, and `createElement`. Null for a constructor with no
   *  definition, whose construction is illegal. */
  const constructCustom = (target: Any): Any => {
    const def = target ? definitionOf.get(target) : undefined;
    if (!def) return null;
    const stack = def.stack;
    if (!stack.length) {
      const el = wrap(
        Number(call('create', 'element', def.localName, document._id, '')),
      );
      Object.setPrototypeOf(el, target.prototype);
      customOf.set(el, { state: 'custom', def, queue: [], internals: null });
      call('ceDefined', el._id);
      return el;
    }
    const el = stack[stack.length - 1];
    if (el === CONSTRUCTED) {
      throw new DOMException(
        "Failed to construct 'HTMLElement': This instance is already constructed",
        'InvalidStateError',
      );
    }
    Object.setPrototypeOf(el, target.prototype);
    stack[stack.length - 1] = CONSTRUCTED;
    return el;
  };

  /** An element `createElement` makes with a definition (DOM 4.9, "create
   *  an element", its custom elements synchronous): an autonomous one by
   *  its constructor, which has to hand back an element as a parser would
   *  make it — no attributes, no children, no parent — or is reported and
   *  an `HTMLUnknownElement` made in its place; a customized built-in made
   *  and upgraded at once. Null where the name has no definition. */
  const createCustom = (local: string, is: string | null): Any => {
    const def = lookUp(local, is);
    if (!def) return null;
    if (def.localName === def.name) {
      try {
        const made = new def.ctor();
        if (!(made instanceof HTMLElement)) {
          throw new TypeError(
            "Failed to execute 'createElement' on 'Document': The result must implement HTMLElement interface",
          );
        }
        const wrong = made.hasAttributes()
          ? 'The result must not have attributes'
          : made.hasChildNodes()
            ? 'The result must not have children'
            : made.parentNode
              ? 'The result must not have a parent'
              : made.ownerDocument !== document
                ? 'The result must be in the same document'
                : made.localName !== local
                  ? 'The result must have the same localName'
                  : null;
        if (wrong) {
          throw new DOMException(
            `Failed to execute 'createElement' on 'Document': ${wrong}`,
            'NotSupportedError',
          );
        }
        return made;
      } catch (error) {
        report(error);
        const el = wrap(
          Number(call('create', 'element', local, document._id, '')),
        );
        Object.setPrototypeOf(el, HTMLUnknownElement.prototype);
        customFor(el).state = 'failed';
        return el;
      }
    }
    const el = wrap(Number(call('create', 'element', local, document._id, '')));
    try {
      upgrade(el, def);
    } catch (error) {
      report(error);
    }
    return el;
  };

  /** Whether a value is a constructor, asked without calling it. */
  const isConstructor = (value: Any): boolean => {
    if (typeof value !== 'function') return false;
    try {
      Reflect.construct(String, [], value);
      return true;
    } catch {
      return false;
    }
  };
  const callbacksOf = (proto: Any, names: string[]): Record<string, Any> => {
    const out: Record<string, Any> = {};
    for (const name of names) {
      const value = proto[name];
      if (value === undefined) continue;
      if (typeof value !== 'function') {
        throw new TypeError(
          `Failed to execute 'define' on 'CustomElementRegistry': The '${name}' property on the prototype is not a function.`,
        );
      }
      out[name] = value;
    }
    return out;
  };
  const stringsOf = (value: Any): string[] =>
    value === undefined || value === null ? [] : Array.from(value, str);

  class CustomElementRegistry {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    /** HTML 4.13.4, `define()`. */
    define(name: Any, ctor: Any, options?: Any): void {
      const n = str(name);
      const fail = (message: string, kind: string): never => {
        throw new DOMException(
          `Failed to execute 'define' on 'CustomElementRegistry': ${message}`,
          kind,
        );
      };
      if (!isConstructor(ctor)) {
        throw new TypeError(
          "Failed to execute 'define' on 'CustomElementRegistry': The provided value is not of type 'CustomElementConstructor'.",
        );
      }
      if (!customName(n)) {
        fail(`"${n}" is not a valid custom element name`, 'SyntaxError');
      }
      if (definitions.has(n)) {
        fail(
          `the name "${n}" has already been used with this registry`,
          'NotSupportedError',
        );
      }
      if (definitionOf.has(ctor)) {
        fail(
          'this constructor has already been used with this registry',
          'NotSupportedError',
        );
      }
      let local = n;
      const extending = options?.extends;
      if (extending !== undefined && extending !== null) {
        local = str(extending);
        if (customName(local) || !/^[a-z][a-z0-9]*$/.test(local)) {
          fail(
            `"${local}" is not an HTML element to extend`,
            'NotSupportedError',
          );
        }
      }
      if (defining) {
        fail(
          'this registry is already defining an element',
          'NotSupportedError',
        );
      }
      defining = true;
      let def: CustomDefinition;
      try {
        const proto = ctor.prototype;
        if (
          proto === null ||
          (typeof proto !== 'object' && typeof proto !== 'function')
        ) {
          throw new TypeError(
            "Failed to execute 'define' on 'CustomElementRegistry': The prototype of the constructor is not an object.",
          );
        }
        const callbacks = callbacksOf(proto, [
          'connectedCallback',
          'disconnectedCallback',
          'adoptedCallback',
          'attributeChangedCallback',
        ]);
        const observed = new Set(
          callbacks.attributeChangedCallback
            ? stringsOf(ctor.observedAttributes)
            : [],
        );
        const disabled = new Set(stringsOf(ctor.disabledFeatures));
        const formAssociated = !!ctor.formAssociated;
        if (formAssociated) {
          Object.assign(
            callbacks,
            callbacksOf(proto, [
              'formAssociatedCallback',
              'formResetCallback',
              'formDisabledCallback',
              'formStateRestoreCallback',
            ]),
          );
        }
        def = {
          name: n,
          localName: local,
          ctor,
          observed,
          callbacks,
          stack: [],
          formAssociated,
          disableInternals: disabled.has('internals'),
          disableShadow: disabled.has('shadow'),
        };
      } finally {
        defining = false;
      }
      definitions.set(n, def);
      definitionOf.set(ctor, def);
      customElementsDefined = true;
      withReactions(() => {
        for (const id of idList(call('ceDefine', n, local))) {
          enqueueUpgrade(wrap(id), def);
        }
        const waiting = waitingFor.get(n);
        if (waiting) {
          waitingFor.delete(n);
          waiting.resolve(ctor);
        }
      });
    }
    get(name: Any): Any {
      return definitions.get(str(name))?.ctor;
    }
    getName(ctor: Any): string | null {
      return definitionOf.get(ctor)?.name ?? null;
    }
    whenDefined(name: Any): Promise<Any> {
      const n = str(name);
      if (!customName(n)) {
        return Promise.reject(
          new DOMException(
            `Failed to execute 'whenDefined' on 'CustomElementRegistry': "${n}" is not a valid custom element name`,
            'SyntaxError',
          ),
        );
      }
      const def = definitions.get(n);
      if (def) return Promise.resolve(def.ctor);
      let waiting = waitingFor.get(n);
      if (!waiting) {
        let resolve: Any;
        const promise = new Promise((ok) => (resolve = ok));
        waitingFor.set(n, (waiting = { promise, resolve }));
      }
      return waiting.promise;
    }
    /** Every element in `root` that has a definition and was not upgraded,
     *  upgraded, in shadow-including tree order. */
    upgrade(root: Any): void {
      const id = idOf(root);
      if (!customElementsDefined) return;
      withReactions(() => {
        for (const found of idList(call('ceCandidates', id))) {
          const el = wrap(found);
          const custom = customOf.get(el);
          if (custom && custom.state !== 'undefined') continue;
          const def = definitionFor(el);
          if (def) enqueueUpgrade(el, def);
        }
      });
    }
  }
  const customElements = Object.create(CustomElementRegistry.prototype);

  /** A custom element's states, which `:state()` would read: a set of
   *  strings. */
  class CustomStateSet extends Set<string> {
    override add(value: Any): this {
      return super.add(str(value));
    }
  }
  /** What a custom element is given to say what a built-in says of itself
   *  (HTML 4.13.7): its states, and a form value and validity that no form
   *  reads here. */
  class ElementInternals {
    _el: Any;
    _states = new CustomStateSet();
    _value: Any = null;
    _valid = true;
    _message = '';
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    get shadowRoot(): Any {
      return this._el.shadowRoot;
    }
    get states(): Any {
      return this._states;
    }
    get form(): Any {
      return customOf.get(this._el)?.def?.formAssociated
        ? this._el.closest('form')
        : null;
    }
    get labels(): Any {
      return list([]);
    }
    get willValidate(): boolean {
      return !!customOf.get(this._el)?.def?.formAssociated;
    }
    get validationMessage(): string {
      return this._message;
    }
    get validity(): Any {
      return { valid: this._valid };
    }
    setFormValue(value: Any): void {
      this._value = value;
    }
    setValidity(flags?: Any, message?: Any): void {
      this._valid = !flags || !Object.values(flags).some(Boolean);
      this._message = this._valid ? '' : str(message ?? '');
    }
    checkValidity(): boolean {
      return this._valid;
    }
    reportValidity(): boolean {
      return this._valid;
    }
  }
  /** HTML 4.13.7.1, `attachInternals()`. */
  const attachInternals = (el: Any): Any => {
    const custom = customOf.get(el);
    const fail = (message: string): never => {
      throw new DOMException(
        `Failed to execute 'attachInternals' on 'HTMLElement': ${message}`,
        'NotSupportedError',
      );
    };
    const def = custom?.def ?? definitionFor(el);
    if (!def || def.localName !== def.name) {
      fail('Unable to attach ElementInternals to non-custom elements.');
    }
    if (def!.disableInternals) {
      fail('ElementInternals is disabled by disabledFeature static field.');
    }
    if (custom?.internals) {
      fail('ElementInternals for the specified element was already attached.');
    }
    if (custom?.state !== 'precustomized' && custom?.state !== 'custom') {
      fail(
        'The attachInternals() function cannot be called prior to the execution of the custom element constructor.',
      );
    }
    const internals = Object.create(ElementInternals.prototype);
    Object.assign(internals, {
      _el: el,
      _states: new CustomStateSet(),
      _value: null,
      _valid: true,
      _message: '',
    });
    custom!.internals = internals;
    return internals;
  };

  // --- the selection ---------------------------------------------------------------
  //
  // The page's selection (Selection API): none, or one range of the
  // document's, which the host keeps live as the tree changes, and which way
  // it was made. It is the page's alone: what a drag selects in a document
  // is `<Html>`'s own, and the two are not one yet. It is what an editing
  // host is typed at, and what CodeMirror reads its caret from and writes
  // it to.

  /** A boundary point's length check: an offset past a node's end is an
   *  `IndexSizeError`, and a doctype is no place to be. */
  const checkPoint = (node: Any, offset: number): void => {
    if (node?.nodeType === 10) {
      throw new DOMException(
        'A doctype is no boundary.',
        'InvalidNodeTypeError',
      );
    }
    const length =
      node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8
        ? node.data.length
        : node.childNodes.length;
    if (offset > length) {
      throw new DOMException(
        `The offset ${offset} is larger than the node's length (${length}).`,
        'IndexSizeError',
      );
    }
  };
  /** -1, 0 or 1 as one boundary point is before, at or after another. */
  const comparePoints = (a: Any, ao: number, b: Any, bo: number): number => {
    const range = document.createRange();
    range.setStart(a, ao);
    return -range.comparePoint(b, bo);
  };

  class Selection {
    _range: Any = null;
    _backward = false;
    _told = false;
    /** `selectionchange`, once a task however many changes it made
     *  (Selection API 4.1). */
    _changed(): void {
      if (this._told) return;
      this._told = true;
      setTimer(
        () => {
          this._told = false;
          dispatch(document, new Event('selectionchange'));
        },
        0,
        [],
        false,
      );
    }
    _set(range: Any, backward: boolean): void {
      this._range = range;
      this._backward = backward;
      this._changed();
    }
    get rangeCount(): number {
      return this._range ? 1 : 0;
    }
    get anchorNode(): Any {
      const r = this._range;
      return r ? (this._backward ? r.endContainer : r.startContainer) : null;
    }
    get anchorOffset(): number {
      const r = this._range;
      return r ? (this._backward ? r.endOffset : r.startOffset) : 0;
    }
    get focusNode(): Any {
      const r = this._range;
      return r ? (this._backward ? r.startContainer : r.endContainer) : null;
    }
    get focusOffset(): number {
      const r = this._range;
      return r ? (this._backward ? r.startOffset : r.endOffset) : 0;
    }
    get isCollapsed(): boolean {
      return !this._range || this._range.collapsed;
    }
    get type(): string {
      return !this._range ? 'None' : this._range.collapsed ? 'Caret' : 'Range';
    }
    get direction(): string {
      return !this._range || this._range.collapsed
        ? 'none'
        : this._backward
          ? 'backward'
          : 'forward';
    }
    getRangeAt(index: Any): Any {
      if (Number(index) !== 0 || !this._range) {
        throw new DOMException(
          `${index} is not a valid index.`,
          'IndexSizeError',
        );
      }
      return this._range;
    }
    getComposedRanges(): Any[] {
      const r = this._range;
      if (!r) return [];
      return [r.cloneRange()];
    }
    addRange(range: Any): void {
      if (!(range instanceof Range) || this._range) return;
      const root = range.startContainer?.getRootNode?.();
      if (root !== document) return;
      this._set(range, false);
    }
    removeRange(range: Any): void {
      if (range !== this._range) {
        throw new DOMException('The range is not selected.', 'NotFoundError');
      }
      this.removeAllRanges();
    }
    removeAllRanges(): void {
      if (!this._range) return;
      this._set(null, false);
    }
    empty(): void {
      this.removeAllRanges();
    }
    collapse(node: Any, offset: Any = 0): void {
      if (node == null) {
        this.removeAllRanges();
        return;
      }
      const at = Number(offset) >>> 0;
      checkPoint(node, at);
      if (node.getRootNode() !== document) return;
      const range = document.createRange();
      range.setStart(node, at);
      this._set(range, false);
    }
    setPosition(node: Any, offset: Any = 0): void {
      this.collapse(node, offset);
    }
    collapseToStart(): void {
      const r = this._range;
      if (!r)
        throw new DOMException('There is no selection.', 'InvalidStateError');
      this.collapse(r.startContainer, r.startOffset);
    }
    collapseToEnd(): void {
      const r = this._range;
      if (!r)
        throw new DOMException('There is no selection.', 'InvalidStateError');
      this.collapse(r.endContainer, r.endOffset);
    }
    extend(node: Any, offset: Any = 0): void {
      if (!this._range) {
        throw new DOMException('There is no selection.', 'InvalidStateError');
      }
      if (node.getRootNode() !== document) return;
      this.setBaseAndExtent(this.anchorNode, this.anchorOffset, node, offset);
    }
    setBaseAndExtent(
      anchor: Any,
      anchorOffset: Any,
      focus: Any,
      focusOffset: Any,
    ): void {
      const ao = Number(anchorOffset) >>> 0;
      const fo = Number(focusOffset) >>> 0;
      checkPoint(anchor, ao);
      checkPoint(focus, fo);
      if (
        anchor.getRootNode() !== document ||
        focus.getRootNode() !== document
      ) {
        return;
      }
      const range = document.createRange();
      const backward = comparePoints(anchor, ao, focus, fo) > 0;
      if (backward) {
        range.setStart(focus, fo);
        range.setEnd(anchor, ao);
      } else {
        range.setStart(anchor, ao);
        range.setEnd(focus, fo);
      }
      this._set(range, backward);
    }
    selectAllChildren(node: Any): void {
      if (node?.nodeType === 10) {
        throw new DOMException(
          'A doctype is no boundary.',
          'InvalidNodeTypeError',
        );
      }
      if (node.getRootNode() !== document) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      this._set(range, false);
    }
    deleteFromDocument(): void {
      this._range?.deleteContents();
    }
    containsNode(node: Any, partly: Any = false): boolean {
      const r = this._range;
      if (!r || node.getRootNode() !== document) return false;
      if (partly) return r.intersectsNode(node);
      const parent = node.parentNode;
      if (!parent) return false;
      const index = Array.prototype.indexOf.call(parent.childNodes, node);
      return (
        r.comparePoint(parent, index) === 0 &&
        r.comparePoint(parent, index + 1) === 0
      );
    }
    /** A move by a letter, as `modify` moves at its finest; a coarser one
     *  moves nothing here. */
    modify(alter: Any, direction: Any, granularity: Any): void {
      const node = this.focusNode;
      if (!node || node.nodeType !== 3 || String(granularity) !== 'character') {
        return;
      }
      const back = direction === 'backward' || direction === 'left';
      const to = Math.max(
        0,
        Math.min(node.data.length, this.focusOffset + (back ? -1 : 1)),
      );
      if (alter === 'extend') this.extend(node, to);
      else this.collapse(node, to);
    }
    toString(): string {
      return this._range ? this._range.toString() : '';
    }
  }
  const selection = new Selection();

  // --- editing --------------------------------------------------------------------
  //
  // What a browser does with a key typed, or a press, in an editing host
  // (HTML 6.8, Input Events 2): a `beforeinput` the page may cancel, the
  // change to the DOM at the selection, and an `input`. CodeMirror cancels
  // the keys it has a command for and reads every other change back from
  // the DOM it sees made, through its `MutationObserver`.

  /** The editing host an element is in, or null. */
  const editingHostOf = (node: Any): Any => {
    for (let at = node; at; at = at.parentNode) {
      if (at.nodeType !== 1) continue;
      const v = at.getAttribute('contenteditable');
      if (v === null) continue;
      const value = v.trim().toLowerCase();
      if (value === 'false') return null;
      if (value !== '' && value !== 'true' && value !== 'plaintext-only') {
        continue;
      }
      let host = at;
      for (
        let up = at.parentNode;
        up && up.nodeType === 1;
        up = up.parentNode
      ) {
        const u = up.getAttribute('contenteditable');
        if (u === null) continue;
        const w = u.trim().toLowerCase();
        if (w === 'false') break;
        if (w === '' || w === 'true' || w === 'plaintext-only') host = up;
      }
      return host;
    }
    return null;
  };

  /** The selection's range where it is in `host`, put at the host's start
   *  where it is anywhere else, as focusing a host puts it. */
  const editRange = (host: Any): Any => {
    const r = selection._range;
    if (r && host.contains(r.startContainer) && host.contains(r.endContainer)) {
      return r;
    }
    selection.collapse(host, 0);
    return selection._range;
  };

  /** The text node a collapsed boundary point is at the end of, or the
   *  start of, made where there is none: where text typed there goes. */
  const textAt = (node: Any, offset: number): [Any, number] => {
    if (node.nodeType === 3) return [node, offset];
    const before = node.childNodes[offset - 1];
    if (before?.nodeType === 3) return [before, before.data.length];
    const after = node.childNodes[offset];
    if (after?.nodeType === 3) return [after, 0];
    const text = document.createTextNode('');
    node.insertBefore(text, after ?? null);
    return [text, 0];
  };

  /** The text node next to `node` in tree order inside `host`, forwards or
   *  back, that has text: where a delete at a node's edge goes on into. */
  const textBeside = (host: Any, node: Any, back: boolean): Any => {
    const walker = document.createTreeWalker(host, 4);
    walker.currentNode = node;
    for (;;) {
      const next = back ? walker.previousNode() : walker.nextNode();
      if (!next) return null;
      if (next.data.length) return next;
    }
  };

  /** Where a letter before or after an offset ends: a surrogate pair is
   *  one letter. */
  const letterEdge = (data: string, at: number, back: boolean): number => {
    if (back) {
      const low = data.charCodeAt(at - 1);
      return at - (low >= 0xdc00 && low <= 0xdfff && at >= 2 ? 2 : 1);
    }
    const high = data.charCodeAt(at);
    return (
      at + (high >= 0xd800 && high <= 0xdbff && at + 1 < data.length ? 2 : 1)
    );
  };

  /** Whether white space a host holds keeps its line feeds, so a line
   *  break is a line feed and not a `<br>`. */
  const keepsLines = (host: Any): boolean => {
    if (/^plaintext-only$/i.test(host.getAttribute('contenteditable') ?? '')) {
      return true;
    }
    const ws = getComputedStyle(host).getPropertyValue('white-space');
    return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(ws);
  };

  /**
   * An edit of an editing host at the selection, as `inputType` names it
   * (Input Events 2): told as a `beforeinput`, made where it was not
   * cancelled, and told as an `input`. Whether anything was told: false
   * where the selection is in no editing host.
   */
  const edit = (host: Any, inputType: string, data: string | null): void => {
    const range = editRange(host);
    if (!range) return;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: G,
      inputType,
      data,
    };
    if (!dispatch(host, trusted(new InputEvent('beforeinput', init)))) return;
    const back = inputType === 'deleteContentBackward';
    if (inputType.startsWith('delete')) {
      if (range.collapsed) {
        let [node, offset] = textAt(range.startContainer, range.startOffset);
        if (back ? offset === 0 : offset === node.data.length) {
          const next = textBeside(host, node, back);
          if (!next) return;
          node = next;
          offset = back ? next.data.length : 0;
        }
        const edge = letterEdge(node.data, offset, back);
        const from = Math.min(offset, edge);
        node.deleteData(from, Math.abs(offset - edge));
        selection.collapse(node, from);
      } else {
        range.deleteContents();
        selection.collapse(range.startContainer, range.startOffset);
      }
    } else {
      if (!range.collapsed) range.deleteContents();
      const insert =
        inputType === 'insertText'
          ? data
          : inputType === 'insertParagraph' || inputType === 'insertLineBreak'
            ? keepsLines(host)
              ? '\n'
              : null
            : null;
      if (insert !== null) {
        const [node, offset] = textAt(range.startContainer, range.startOffset);
        node.insertData(offset, insert);
        selection.collapse(node, offset + insert.length);
      } else {
        const br = document.createElement('br');
        range.insertNode(br);
        const parent = br.parentNode;
        const index = Array.prototype.indexOf.call(parent.childNodes, br);
        selection.collapse(parent, index + 1);
      }
    }
    dispatch(
      host,
      trusted(new InputEvent('input', { ...init, cancelable: false })),
    );
  };

  /** What a key not cancelled does in an editing host: the edit it is, if
   *  any, and whether it was one — which keeps it from the host's own
   *  defaults, as Space scrolling the pane. */
  const editForKey = (target: Any, e: Any): boolean => {
    if (e.ctrlKey || e.metaKey) return false;
    const host = editingHostOf(target);
    if (!host) return false;
    const key = String(e.key ?? '');
    if (key === 'Backspace') edit(host, 'deleteContentBackward', null);
    else if (key === 'Delete') edit(host, 'deleteContentForward', null);
    else if (key === 'Enter') {
      edit(host, e.shiftKey ? 'insertLineBreak' : 'insertParagraph', null);
    } else if (
      [...key].length === 1 &&
      key.codePointAt(0)! >= 0x20 &&
      key !== '\u007f'
    ) {
      edit(host, 'insertText', key);
    } else return false;
    return true;
  };

  /** What a press not cancelled does in an editing host: it focuses it and
   *  puts the caret at the letter nearest the press. */
  const editForPress = (target: Any, x: number, y: number): boolean => {
    const host = editingHostOf(target);
    if (!host) return false;
    host.focus();
    const at = document.caretPositionFromPoint(x, y);
    if (at && host.contains(at.offsetNode)) {
      selection.collapse(at.offsetNode, at.offset);
    } else editRange(host);
    return true;
  };

  /** Events dispatched as the user agent's own. */
  const trusted = (ev: Any): Any => {
    ev.isTrusted = true;
    return ev;
  };

  // --- the global ------------------------------------------------------------------

  const define = (name: string, value: Any): void => {
    Object.defineProperty(G, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };
  /** A window attribute, `[Replaceable]` where HTML says so: what a page
   *  assigns takes its place, as a classic script's top-level `var length`
   *  does, where it was dropped and the name went on reading the window's.
   *  `closed` and `isSecureContext` are only read. */
  const getter = (name: string, get: () => Any): void => {
    const replaceable = name !== 'closed' && name !== 'isSecureContext';
    Object.defineProperty(G, name, {
      get,
      ...(replaceable && {
        set(v: Any) {
          Object.defineProperty(G, name, {
            value: v,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        },
      }),
      configurable: true,
      enumerable: false,
    });
  };

  const classes: Record<string, Any> = {
    DOMException,
    Event,
    UIEvent,
    FocusEvent,
    MouseEvent,
    PointerEvent,
    KeyboardEvent,
    InputEvent,
    SubmitEvent,
    CustomEvent,
    ErrorEvent,
    HashChangeEvent,
    PopStateEvent,
    ToggleEvent,
    AnimationPlaybackEvent,
    AnimationEffect,
    KeyframeEffect,
    AnimationTimeline,
    DocumentTimeline,
    Animation,
    EventTarget,
    Node,
    CharacterData,
    Text,
    Comment,
    CDATASection,
    ProcessingInstruction,
    Attr,
    NamedNodeMap,
    DocumentType,
    DocumentFragment,
    ShadowRoot,
    Document,
    HTMLDocument: Document,
    XMLDocument,
    AbstractRange,
    Range,
    Element,
    HTMLElement,
    CustomElementRegistry,
    CustomStateSet,
    ElementInternals,
    SVGElement,
    SVGGraphicsElement,
    SVGSVGElement,
    SVGRectElement,
    SVGCircleElement,
    SVGTextContentElement,
    SVGTextElement,
    SVGTSpanElement,
    HTMLAnchorElement,
    HTMLAreaElement,
    HTMLImageElement,
    HTMLScriptElement,
    HTMLLinkElement,
    HTMLTemplateElement,
    HTMLDetailsElement,
    HTMLDialogElement,
    HTMLLabelElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    HTMLOptionElement,
    HTMLButtonElement,
    HTMLFieldSetElement,
    HTMLFormElement,
    HTMLIFrameElement,
    HTMLCanvasElement,
    HTMLMediaElement,
    HTMLVideoElement,
    HTMLAudioElement,
    HTMLSourceElement,
    HTMLTrackElement,
    HTMLPictureElement,
    HTMLPreElement,
    HTMLBRElement,
    HTMLHRElement,
    HTMLTitleElement,
    HTMLBaseElement,
    HTMLTimeElement,
    HTMLQuoteElement,
    HTMLDListElement,
    HTMLTableSectionElement,
    HTMLTableCaptionElement,
    HTMLTableColElement,
    HTMLLegendElement,
    HTMLOptGroupElement,
    HTMLDataListElement,
    HTMLProgressElement,
    HTMLMeterElement,
    HTMLOutputElement,
    HTMLObjectElement,
    HTMLEmbedElement,
    HTMLSlotElement,
    TextTrackList,
    AudioTrackList,
    VideoTrackList,
    HTMLBodyElement,
    HTMLHeadElement,
    HTMLHtmlElement,
    HTMLDivElement,
    HTMLSpanElement,
    HTMLParagraphElement,
    HTMLHeadingElement,
    HTMLUListElement,
    HTMLOListElement,
    HTMLLIElement,
    HTMLTableElement,
    HTMLTableRowElement,
    HTMLTableCellElement,
    HTMLStyleElement,
    HTMLMetaElement,
    HTMLUnknownElement,
    DOMTokenList,
    DOMRect,
    NodeList,
    HTMLCollection,
    URL,
    URLSearchParams,
    Headers,
    WheelEvent,
    Worker,
    ImageData,
    CanvasRenderingContext2D,
    ...RASTER.classes,
    ...WEBGL.classes,
    Response,
    AbortController,
    AbortSignal,
    IntersectionObserver,
    IntersectionObserverEntry,
    ResizeObserver,
    ResizeObserverEntry,
    ResizeObserverSize,
    MutationObserver,
    MutationRecord,
    XMLHttpRequest,
    ProgressEvent,
    TextEncoder,
    TextDecoder,
    VisualViewport,
    PromiseRejectionEvent,
    NodeFilter,
    TreeWalker,
    NodeIterator,
    DOMParser,
    PerformanceObserver,
    MessageEvent,
    MessageChannel,
    MessagePort,
    Window,
    PluginArray,
    MimeTypeArray,
    Blob,
    File,
    FormData,
    Request,
    Storage,
    IDBFactory,
    IDBDatabase,
    IDBTransaction,
    IDBObjectStore,
    IDBIndex,
    IDBCursor,
    IDBCursorWithValue,
    IDBRecord,
    IDBKeyRange,
    IDBRequest,
    IDBOpenDBRequest,
    IDBVersionChangeEvent,
    DOMStringList,
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamDefaultController,
    WritableStream,
    WritableStreamDefaultWriter,
    TransformStream,
    TextDecoderStream,
    TextEncoderStream,
    CountQueuingStrategy,
    ByteLengthQueuingStrategy,
    CSSStyleSheet,
    StyleSheet,
    StyleSheetList,
    CSSRuleList,
    CSSRule,
    CSSStyleRule,
    CSSGroupingRule,
    CSSMediaRule,
    CSSSupportsRule,
    CSSContainerRule,
    CSSImportRule,
    CSSFontFaceRule,
    CSSKeyframesRule,
  };
  for (const [name, value] of Object.entries(classes)) define(name, value);

  define('window', G);
  define('self', G);
  define('top', G);
  define('parent', G);
  define('frames', G);
  define('opener', null);
  define('frameElement', null);
  define('document', document);
  // an address assigned to it is a navigation, as `location.href = …` is:
  // a data property took the string in place of the location, and every
  // read of it after was the string's
  Object.defineProperty(G, 'location', {
    get: () => workerLocation ?? location,
    set: (v: Any) => {
      if (!workerLocation) location.href = v;
    },
    configurable: false,
    enumerable: true,
  });
  define('history', history);
  define('navigator', navigator);
  // Bun's context has a `console` of its own that no definition on the
  // global replaces — a page reads it whatever this defines — but whose
  // methods are its to set: they are set where there is one, as they are
  // on Node's, and this one defined where there is none
  const own = G.console;
  if (own && typeof own === 'object') {
    for (const key of Object.keys(console)) {
      try {
        own[key] = (console as Any)[key];
      } catch {}
    }
  } else {
    define('console', console);
  }
  define('indexedDB', new IDBFactory());
  define('localStorage', storage('local'));
  define('sessionStorage', storage('session'));
  define('fetch', fetch);
  // WebAssembly's compile, as the page's. The runtime's asynchronous one
  // settles its promise from a task of the host's, in a context that runs
  // its microtasks only when the engine enters it, so what waited on it
  // waited for the next timer or event: a module is compiled at once
  // instead, in the promise, and what waits on it runs before the entry
  // that asked ends. And its streaming compile is the host's: Node's takes
  // only its own `Response`, and what it refuses anything else with is an
  // error of the host's realm, whose `constructor.constructor` is the
  // host's `Function`. Both are replaced before any page code runs, and
  // nothing keeps the runtime's after.
  const wasm = G.WebAssembly;
  if (wasm && typeof wasm === 'object') {
    const Module = wasm.Module;
    const Instance = wasm.Instance;
    const method = (name: string, fn: Any) =>
      Object.defineProperty(wasm, name, {
        value: fn,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    const compile = (bytes: Any): Promise<Any> =>
      new Promise((ok) => ok(new Module(bytes)));
    const instantiate = (source: Any, imports?: Any): Promise<Any> =>
      new Promise((ok) => {
        if (source instanceof Module) ok(new Instance(source, imports));
        else {
          const module = new Module(source);
          ok({ module, instance: new Instance(module, imports) });
        }
      });
    const bytesOf = async (source: Any, name: string): Promise<Any> => {
      const response = await source;
      if (!(response instanceof Response)) {
        throw new TypeError(
          `WebAssembly.${name}(): Argument 0 must be provided and must be a Response or Response promise`,
        );
      }
      const type = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (type !== 'application/wasm') {
        throw new TypeError(
          `WebAssembly.${name}(): Incorrect response MIME type. Expected 'application/wasm'.`,
        );
      }
      if (!response.ok) {
        throw new TypeError(
          `WebAssembly.${name}(): HTTP status code is not ok`,
        );
      }
      return response.arrayBuffer();
    };
    method('compile', function compile_(bytes: Any) {
      return compile(bytes);
    });
    method('instantiate', function instantiate_(source: Any, imports?: Any) {
      return instantiate(source, imports);
    });
    method('compileStreaming', async function compileStreaming(source: Any) {
      return compile(await bytesOf(source, 'compileStreaming'));
    });
    method(
      'instantiateStreaming',
      async function instantiateStreaming(source: Any, imports?: Any) {
        const module = await compile(
          await bytesOf(source, 'instantiateStreaming'),
        );
        return { module, instance: new Instance(module, imports) };
      },
    );
    for (const [name, fn] of [
      ['compile', 'compile'],
      ['instantiate', 'instantiate'],
    ]) {
      Object.defineProperty(wasm[name], 'name', { value: fn });
    }
  }
  define('matchMedia', matchMedia);
  define('getComputedStyle', getComputedStyle);
  define('btoa', btoa);
  define('atob', atob);
  define('CSS', {
    escape: (v: Any) => cssEscape(str(v)),
    // what `<Html>` answers an `@supports` with: false only where it knows
    // a property it does not draw, and true for the rest, as the modern
    // engine a page tests for. vercel.com sent an engine that answered
    // false to `var()` to its old-browser page.
    supports: (...args: Any[]): boolean =>
      call(
        'supports',
        args.length >= 2 ? `(${str(args[0])}: ${str(args[1])})` : str(args[0]),
      ) === true,
  });
  define('customElements', customElements);
  const timeOrigin = Date.now() - now();
  define('performance', {
    now,
    timeOrigin,
    mark(name: Any, options: Any = {}) {
      return noteEntry({
        name: str(name),
        entryType: 'mark',
        startTime: Number(options?.startTime ?? now()),
        duration: 0,
        detail: options?.detail ?? null,
      });
    },
    measure(name: Any, start?: Any, end?: Any) {
      const at = (mark: Any, otherwise: number): number => {
        if (typeof mark === 'number') return mark;
        if (mark === undefined || mark === null) return otherwise;
        const found = entries.filter((e) => e.name === str(mark)).at(-1);
        return found ? found.startTime : otherwise;
      };
      const options = start && typeof start === 'object' ? start : null;
      const from = at(options ? options.start : start, 0);
      const to = at(options ? options.end : end, now());
      return noteEntry({
        name: str(name),
        entryType: 'measure',
        startTime: from,
        duration: to - from,
        detail: options?.detail ?? null,
      });
    },
    clearMarks(name?: Any) {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i];
        if (
          e.entryType === 'mark' &&
          (name === undefined || e.name === str(name))
        ) {
          entries.splice(i, 1);
        }
      }
    },
    clearMeasures(name?: Any) {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i];
        if (
          e.entryType === 'measure' &&
          (name === undefined || e.name === str(name))
        ) {
          entries.splice(i, 1);
        }
      }
    },
    clearResourceTimings() {},
    setResourceTimingBufferSize() {},
    getEntries: () => entries.slice(),
    getEntriesByType: (type: Any) => entryList(entries).getEntriesByType(type),
    getEntriesByName: (name: Any, type?: Any) =>
      entryList(entries).getEntriesByName(name, type),
    // the legacy timing, where a page reads how long it took to load
    timing: {
      navigationStart: timeOrigin,
      fetchStart: timeOrigin,
      responseStart: timeOrigin,
      responseEnd: timeOrigin,
      domLoading: timeOrigin,
      domInteractive: 0,
      domContentLoadedEventStart: 0,
      domContentLoadedEventEnd: 0,
      domComplete: 0,
      loadEventStart: 0,
      loadEventEnd: 0,
    },
    navigation: { type: 0, redirectCount: 0 },
    toJSON: () => ({ timeOrigin }),
  });
  define('screen', {
    get width() {
      return viewport().width;
    },
    get height() {
      return viewport().height;
    },
    get availWidth() {
      return viewport().width;
    },
    get availHeight() {
      return viewport().height;
    },
    colorDepth: 24,
    pixelDepth: 24,
  });
  // The interfaces of the window's own objects, which a page asks
  // `instanceof` of and reads prototypes from — mazda.com.au's scripts ask
  // for `Location` — each object made the one instance of its own.
  for (const [name, object] of [
    ['Location', location],
    ['History', history],
    ['Navigator', navigator],
    ['Screen', G.screen],
  ] as [string, Any][]) {
    const Interface = { [name]: class {} }[name];
    Object.defineProperty(Interface.prototype, Symbol.toStringTag, {
      value: name,
      configurable: true,
    });
    Object.setPrototypeOf(object, Interface.prototype);
    define(name, Interface);
  }
  getter('innerWidth', () => viewport().width);
  getter('innerHeight', () => viewport().height);
  getter('outerWidth', () => viewport().width);
  getter('outerHeight', () => viewport().height);
  getter('scrollX', () => viewport().scrollX);
  getter('scrollY', () => viewport().scrollY);
  getter('pageXOffset', () => viewport().scrollX);
  getter('pageYOffset', () => viewport().scrollY);
  getter('devicePixelRatio', () => viewport().dpr);
  getter('isSecureContext', () => location.protocol === 'https:');
  getter('origin', () => location.origin);
  // The window's own strings, made strings as they are set, as a
  // browser's are: a classic script's `var name = 1` sets the window's
  // name, and `typeof name` is a string after it, as it is there.
  let windowName = '';
  let windowStatus = '';
  Object.defineProperty(G, 'name', {
    get: () => windowName,
    set: (v: Any) => {
      windowName = str(v);
    },
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(G, 'status', {
    get: () => windowStatus,
    set: (v: Any) => {
      windowStatus = str(v);
    },
    configurable: true,
    enumerable: false,
  });
  getter('closed', () => false);
  // no frames, which is what `length` counts
  getter('length', () => 0);
  for (const at of ['screenX', 'screenY', 'screenLeft', 'screenTop']) {
    getter(at, () => 0);
  }
  define('visualViewport', new VisualViewport());
  define('crypto', crypto);
  // `new Image()`, `new Option()` and `new Audio()`: the elements, made
  // as `createElement` makes them (HTML 4.8.4.1, 4.10.10, 4.8.10)
  const Image = function (width?: Any, height?: Any): Any {
    const img = document.createElement('img');
    if (width !== undefined) img.setAttribute('width', str(width));
    if (height !== undefined) img.setAttribute('height', str(height));
    return img;
  } as Any;
  Image.prototype = HTMLImageElement.prototype;
  const Option = function (
    text?: Any,
    value?: Any,
    defaultSelected?: Any,
    selected?: Any,
  ): Any {
    const option = document.createElement('option');
    if (text !== undefined) option.textContent = str(text);
    if (value !== undefined) option.setAttribute('value', str(value));
    if (defaultSelected) option.setAttribute('selected', '');
    if (selected) option.selected = true;
    return option;
  } as Any;
  Option.prototype = HTMLOptionElement.prototype;
  const Audio = function (src?: Any): Any {
    const audio = document.createElement('audio');
    audio.setAttribute('preload', 'auto');
    if (src !== undefined) audio.setAttribute('src', str(src));
    return audio;
  } as Any;
  Audio.prototype = HTMLAudioElement.prototype;
  define('Image', Image);
  define('Option', Option);
  define('Audio', Audio);
  define('scrollTo', (x: Any, y?: Any) => {
    const to = typeof x === 'object' && x ? x : { left: x, top: y };
    const v = viewport();
    call(
      'scrollTo',
      Number(to.left ?? v.scrollX) || 0,
      Number(to.top ?? v.scrollY) || 0,
    );
  });
  define('scroll', G.scrollTo);
  define('scrollBy', (x: Any, y?: Any) => {
    const by = typeof x === 'object' && x ? x : { left: x, top: y };
    const v = viewport();
    call(
      'scrollTo',
      v.scrollX + (Number(by.left) || 0),
      v.scrollY + (Number(by.top) || 0),
    );
  });
  define('setTimeout', (fn: Any, ms?: Any, ...args: Any[]) =>
    setTimer(fn, ms, args, false),
  );
  define('setInterval', (fn: Any, ms?: Any, ...args: Any[]) =>
    setTimer(fn, ms, args, true),
  );
  define('clearTimeout', clearTimer);
  define('clearInterval', clearTimer);
  define('requestAnimationFrame', (fn: Any) =>
    setTimer(() => fn(now()), 16, [], false),
  );
  define('cancelAnimationFrame', clearTimer);
  define('requestIdleCallback', (fn: Any) =>
    setTimer(
      () => fn({ didTimeout: false, timeRemaining: () => 10 }),
      1,
      [],
      false,
    ),
  );
  define('cancelIdleCallback', clearTimer);
  define('queueMicrotask', (fn: Any) => {
    Promise.resolve().then(() => {
      try {
        fn();
      } catch (e) {
        report(e);
      }
    });
  });
  define('structuredClone', (value: Any) => structuredCopy(value, new Map()));
  define('reportError', report);
  define('alert', (message?: Any) =>
    bridge(
      'log',
      'info',
      `alert: ${message === undefined ? '' : str(message)}`,
    ),
  );
  define('confirm', (message?: Any) => {
    bridge(
      'log',
      'info',
      `confirm, answered no: ${message === undefined ? '' : str(message)}`,
    );
    return false;
  });
  define('prompt', (message?: Any) => {
    bridge(
      'log',
      'info',
      `prompt, answered nothing: ${message === undefined ? '' : str(message)}`,
    );
    return null;
  });
  // to where its name says, a new tab where it names none (HTML 7.2.2.1)
  define('open', (url?: Any, target?: Any) => {
    const name = target === undefined || target === '' ? '_blank' : str(target);
    if (url) call('open', String(call('resolve', str(url))), name);
    return null;
  });
  define('close', () => {});
  define('focus', () => {});
  define('blur', () => {});
  define('print', () => {});
  define('stop', () => {});
  /** Whether a message may go where `options` says it is meant for: any
   *  origin, this one, or one written as this one is (HTML 9.4.3). Every
   *  realm a message goes to here is this page's origin's. */
  function originAllowed(options?: Any, to: string = location.origin): boolean {
    const target =
      options && typeof options === 'object'
        ? (options.targetOrigin ?? '/')
        : options === undefined
          ? '/'
          : str(options);
    if (target === '*' || target === '/') return true;
    let origin: string;
    try {
      origin = new URL(target).origin;
    } catch {
      throw new DOMException(
        `Invalid target origin '${target}' in a call to 'postMessage'.`,
        'SyntaxError',
      );
    }
    return origin === to;
  }

  // a message to a window, this one's or a frame's: a task of its own,
  // after this one, where the origin it is meant for is this one's (HTML
  // 9.4.3), from the page, whose code is all that runs here
  const postTo = (to: Any, message: Any, options?: Any): void => {
    if (!originAllowed(options)) return;
    const data = cloneOf(message);
    setTimer(
      () => {
        const ev = new MessageEvent('message', {
          data,
          origin: location.origin,
          source: G,
        });
        ev.isTrusted = true;
        dispatch(to, ev);
      },
      0,
      [],
      false,
    );
  };
  define('postMessage', (message: Any, options?: Any) =>
    postTo(windowTarget, message, options),
  );
  Object.defineProperty(G, Symbol.toStringTag, {
    value: 'Window',
    configurable: true,
  });
  define('getSelection', () => selection);
  define('Selection', Selection);
  define('CaretPosition', CaretPosition);
  for (const name of ['addEventListener', 'removeEventListener']) {
    define(name, (...args: Any[]) => (windowTarget as Any)[name](...args));
  }
  define('dispatchEvent', (event: Any) => {
    if (!(event instanceof Event)) throw new TypeError('not an Event');
    event.isTrusted = false;
    return dispatch(windowTarget, event);
  });
  for (const type of [
    'load',
    'error',
    'resize',
    'scroll',
    'hashchange',
    'popstate',
    'unload',
    'beforeunload',
    'message',
    'focus',
    'blur',
    'keydown',
    'click',
    'unhandledrejection',
    'rejectionhandled',
    'pageshow',
    'pagehide',
    'online',
    'offline',
  ]) {
    Object.defineProperty(G, `on${type}`, {
      get: () => handlerOf(windowTarget, type),
      set: (fn: Any) => {
        windowTarget._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
    });
  }

  // Named access on the window (HTML 7.2.2.3): an element is a global by
  // its `id` — `target`, as WPT's tests and many an old page read it — and
  // an `embed`, a `form`, an `img` or an `object` by its `name`, and a
  // frame's window by the frame's. Asked of the host's index of the
  // document's names (`named`), and only for a name no global has: the
  // proxy is the next link of the chain under the global, so everything
  // the window defines, and every `var` and function a page declares,
  // shadows it, as in a browser. A worker's global has none, and nor does
  // a window where the runtime refuses the proxy (`namedAccessWorks`).
  if (namedAccess) {
    const lookup = (key: string | symbol): Any => {
      if (typeof key !== 'string' || !key || workerLocation) return undefined;
      const found = idList(call('named', key, document._id)).map(wrap);
      if (!found.length) return undefined;
      for (const el of found) {
        const tag = el.localName;
        if (
          (tag === 'iframe' || tag === 'frame') &&
          el.getAttribute('name') === key
        ) {
          const frame = el.contentWindow;
          if (frame) return frame;
        }
      }
      return found.length === 1 ? found[0] : collection(found);
    };
    const named = new Proxy(Object.create(Object.getPrototypeOf(G)), {
      has: (target: Any, key: string | symbol) =>
        Reflect.has(target, key) || lookup(key) !== undefined,
      get: (target: Any, key: string | symbol, receiver: Any) =>
        Reflect.has(target, key)
          ? Reflect.get(target, key, receiver)
          : lookup(key),
      getOwnPropertyDescriptor: (target: Any, key: string | symbol) => {
        const own = Reflect.getOwnPropertyDescriptor(target, key);
        if (own) return own;
        const value = lookup(key);
        return value === undefined
          ? undefined
          : { value, writable: true, enumerable: false, configurable: true };
      },
    });
    Object.setPrototypeOf(G, named);
  }

  // What a frame's window shares with this one (`frameWindowOf`): every
  // global defined as a value, as it is before any page code runs.
  realmGlobals = Object.getOwnPropertyNames(G).flatMap((name) => {
    if (OWN_PER_WINDOW.has(name) || name.startsWith('__')) return [];
    const found = Object.getOwnPropertyDescriptor(G, name);
    return found && 'value' in found ? [[name, found.value]] : [];
  }) as [string, Any][];

  // --- the entries -------------------------------------------------------------------
  //
  // What the host runs. Each reads its input from `__in`, set to '' as it
  // is read, and answers a primitive.

  Object.defineProperty(G, '__in', {
    value: '',
    writable: true,
    configurable: false,
    enumerable: false,
  });
  const input = (): Any => {
    const raw = G.__in;
    G.__in = '';
    return typeof raw === 'string' && raw ? JSON.parse(raw) : null;
  };
  const entry = (name: string, fn: () => Primitive): void => {
    Object.defineProperty(G, name, {
      value: () => {
        try {
          // what the host changed on its own since the page last did
          if (customElementsDefined) takeReactions();
          return fn();
        } catch (error) {
          report(error);
          return false;
        }
      },
      writable: false,
      configurable: false,
      enumerable: false,
    });
  };

  // a page's classic script is about to run: the host runs it as a script
  // of its own (`ScriptEngine.exec`), its declarations the window's
  // `currentScript` stays the script's through the microtasks it queued,
  // which run as the script ends (`microtaskMode: 'afterEvaluate'`), and
  // is put back by the entry after (`__ran`): HTML runs the microtask
  // checkpoint inside running the script, before it puts `currentScript`
  // back (8.1.4.6). Turbopack's chunks read it from a promise's callback.
  entry('__exec', () => {
    const [script] = input();
    document._current = script ? wrap(script) : null;
    return true;
  });
  entry('__ran', () => {
    document._current = null;
    return true;
  });

  // an event `<Html>` was told of, dispatched as the browser would, and
  // whether its default goes on
  /** The element the pointer is over, as its moves were told: what it
   *  leaves when it moves onto another (UI Events 4.3.3). */
  let hovered: Any = null;
  entry('__event', () => {
    const e = input();
    let target = wrap(e.target);
    if (!target) return true;
    const v = viewport();
    const mods = {
      shiftKey: !!e.shiftKey,
      ctrlKey: !!e.ctrlKey,
      altKey: !!e.altKey,
      metaKey: !!e.metaKey,
    };
    const trusted = (ev: Any): Any => {
      ev.isTrusted = true;
      return ev;
    };
    const related = e.relatedTarget ? wrap(e.relatedTarget) : null;
    /** Pointer Events 3, 10.4, "process pending pointer capture": the
     *  capture changes hands, each side told, before the pointer's next
     *  event. An element taken out of the document has lost it, which the
     *  document is told (10.5). */
    const takeCapture = (at: Any): void => {
      if (pointer.pending && !pointer.pending.isConnected) {
        pointer.pending = null;
      }
      if (pointer.target === pointer.pending) return;
      const was = pointer.target;
      pointer.target = pointer.pending;
      const told = {
        ...at,
        bubbles: true,
        cancelable: false,
        composed: false,
        relatedTarget: null,
      };
      if (was) {
        dispatch(
          was.isConnected ? was : document,
          trusted(new PointerEvent('lostpointercapture', told)),
        );
      }
      if (pointer.target) {
        dispatch(
          pointer.target,
          trusted(new PointerEvent('gotpointercapture', told)),
        );
      }
    };
    switch (e.type) {
      case 'click':
      case 'dblclick': {
        const Kind = e.type === 'click' ? PointerEvent : MouseEvent;
        return dispatch(
          target,
          trusted(
            new Kind(e.type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: G,
              detail: e.detail ?? 1,
              clientX: (e.x ?? 0) - v.scrollX,
              clientY: (e.y ?? 0) - v.scrollY,
              button: e.button ?? 0,
              buttons: 0,
              ...mods,
            }),
          ),
        );
      }
      case 'mousedown':
      case 'mouseup': {
        // the DOM's mask bit of the DOM's button
        const bit = [1, 4, 2, 8, 16][e.button ?? 0] ?? 0;
        const down = e.type === 'mousedown';
        // a press of a button held is a release that was never told, off
        // the document: the earlier press is over
        if (down && pointer.held & bit) {
          pointer.held = 0;
          pointer.pending = null;
          pointer.quiet = false;
        }
        const wasHeld = pointer.held;
        pointer.held = down ? wasHeld | bit : wasHeld & ~bit;
        const at = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: G,
          detail: e.detail ?? 1,
          clientX: (e.x ?? 0) - v.scrollX,
          clientY: (e.y ?? 0) - v.scrollY,
          button: e.button ?? 0,
          buttons: pointer.held,
          ...mods,
        };
        // a release of a button the document never saw pressed is a
        // mouse's alone
        if (!down && !(wasHeld & bit)) {
          return dispatch(target, trusted(new MouseEvent(e.type, at)));
        }
        takeCapture(at);
        const to = pointer.target ?? target;
        // the first button pressed is a pointerdown and the last released
        // a pointerup; a button between is a move (Pointer Events 3, 4.1.3)
        const first = down ? !wasHeld : !pointer.held;
        const type = first
          ? down
            ? 'pointerdown'
            : 'pointerup'
          : 'pointermove';
        const pointerGo = dispatch(
          to,
          trusted(
            new PointerEvent(type, {
              ...at,
              cancelable: type !== 'pointermove',
            }),
          ),
        );
        // a cancelled pointerdown keeps the mouse's events back until the
        // release, and its default with them (11.2), as Chrome has it
        if (type === 'pointerdown') pointer.quiet = !pointerGo;
        const mouseGo = pointer.quiet
          ? true
          : dispatch(to, trusted(new MouseEvent(e.type, at)));
        if (type === 'pointerup') {
          // the capture is let go once the buttons are (10.2)
          pointer.quiet = false;
          pointer.pending = null;
          takeCapture(at);
        }
        // a press in an editing host focuses it and puts the caret there,
        // which leaves nothing for the document's own selection to do
        if (
          type === 'pointerdown' &&
          (e.button ?? 0) === 0 &&
          pointerGo &&
          mouseGo &&
          editForPress(to, at.clientX, at.clientY)
        ) {
          return false;
        }
        return pointerGo && mouseGo;
      }
      case 'mousemove': {
        const at = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: G,
          clientX: (e.x ?? 0) - v.scrollX,
          clientY: (e.y ?? 0) - v.scrollY,
          button: 0,
          // a move's own buttons are none on macOS: the presses told are
          buttons: (e.buttons ?? 0) | pointer.held,
          ...mods,
        };
        takeCapture(at);
        // a captured pointer is over the element that took it, for its
        // moves and its boundary events alike (10.1)
        target = pointer.target ?? target;
        const was = hovered?.isConnected ? hovered : null;
        if (was !== target) {
          // out of the one, over the other, and left and entered every
          // element between them and the nearest both are in, which hear
          // it without bubbling
          const elementsUp = (n: Any): Any[] => {
            const out: Any[] = [];
            for (let at = n; at && at.nodeType === 1; at = at.parentNode) {
              out.push(at);
            }
            return out;
          };
          const left = was ? elementsUp(was) : [];
          const entered = elementsUp(target);
          const both = new Set(left.filter((n) => entered.includes(n)));
          const leaving = left.filter((n) => !both.has(n));
          const entering = entered.filter((n) => !both.has(n)).reverse();
          for (const [Kind, prefix] of [
            [PointerEvent, 'pointer'],
            [MouseEvent, 'mouse'],
          ] as const) {
            if (was) {
              dispatch(
                was,
                trusted(
                  new Kind(`${prefix}out`, { ...at, relatedTarget: target }),
                ),
              );
            }
            for (const n of leaving) {
              dispatch(
                n,
                trusted(
                  new Kind(`${prefix}leave`, {
                    ...at,
                    bubbles: false,
                    cancelable: false,
                    relatedTarget: target,
                  }),
                ),
              );
            }
            dispatch(
              target,
              trusted(new Kind(`${prefix}over`, { ...at, relatedTarget: was })),
            );
            for (const n of entering) {
              dispatch(
                n,
                trusted(
                  new Kind(`${prefix}enter`, {
                    ...at,
                    bubbles: false,
                    cancelable: false,
                    relatedTarget: was,
                  }),
                ),
              );
            }
          }
          hovered = target;
        }
        const go = dispatch(
          target,
          trusted(new PointerEvent('pointermove', { ...at, button: -1 })),
        );
        if (pointer.quiet) return go;
        return dispatch(target, trusted(new MouseEvent('mousemove', at)));
      }
      case 'wheel':
        return dispatch(
          target,
          trusted(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: G,
              clientX: (e.x ?? 0) - v.scrollX,
              clientY: (e.y ?? 0) - v.scrollY,
              deltaX: e.deltaX ?? 0,
              deltaY: e.deltaY ?? 0,
              deltaMode: 0,
              ...mods,
            }),
          ),
        );
      case 'contextmenu':
        return dispatch(
          target,
          trusted(
            new PointerEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: G,
              clientX: (e.x ?? 0) - v.scrollX,
              clientY: (e.y ?? 0) - v.scrollY,
              button: 2,
              buttons: 2,
              ...mods,
            }),
          ),
        );
      case 'keydown':
      case 'keyup': {
        const go = dispatch(
          target,
          trusted(
            new KeyboardEvent(e.type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: G,
              key: e.key,
              code: e.code,
              ...mods,
            }),
          ),
        );
        // Escape the page let be is a close request, at the top modal
        // dialog (HTML 7.7.2)
        if (go && e.type === 'keydown' && e.key === 'Escape') closeRequest();
        // a key typed in an editing host is an edit of it, and its own
        if (go && e.type === 'keydown' && editForKey(target, e)) return false;
        return go;
      }
      case 'input':
        return dispatch(
          target,
          trusted(new InputEvent('input', { bubbles: true, composed: true })),
        );
      case 'change':
        return dispatch(
          target,
          trusted(new Event('change', { bubbles: true })),
        );
      case 'submit':
        return dispatch(
          target,
          trusted(
            new SubmitEvent('submit', {
              bubbles: true,
              cancelable: true,
              submitter: e.submitter ? wrap(e.submitter) : null,
            }),
          ),
        );
      case 'reset':
        return dispatch(
          target,
          trusted(new Event('reset', { bubbles: true, cancelable: true })),
        );
      case 'focusin':
        dispatch(
          target,
          trusted(new FocusEvent('focus', { relatedTarget: related })),
        );
        return dispatch(
          target,
          trusted(
            new FocusEvent('focusin', {
              bubbles: true,
              relatedTarget: related,
            }),
          ),
        );
      case 'focusout':
        dispatch(
          target,
          trusted(new FocusEvent('blur', { relatedTarget: related })),
        );
        return dispatch(
          target,
          trusted(
            new FocusEvent('focusout', {
              bubbles: true,
              relatedTarget: related,
            }),
          ),
        );
      case 'toggle':
        return dispatch(target, trusted(new Event('toggle')));
      // a `<link>`'s sheet applied, or not to be had: neither bubbles
      case 'load':
      case 'error':
        return dispatch(target, trusted(new Event(e.type)));
      default:
        return true;
    }
  });

  // a timer the host's clock fired
  entry('__timer', () => {
    const [id] = input();
    const timer = timers.get(id);
    if (!timer) return false;
    if (!timer.repeat) timers.delete(id);
    if (typeof timer.fn === 'function') timer.fn(...timer.args);
    else (0, eval)(str(timer.fn));
    return true;
  });

  // a message a worker posted, to its `Worker` here; or, in a worker, one
  // the page posted to it, to the worker's global (id 0)
  entry('__workerMessage', () => {
    const [id, text] = input();
    const target = id === 0 ? windowTarget : workers.get(id);
    if (!target) return false;
    let data: Any;
    try {
      data = deserializeClone(str(text));
    } catch {
      const ev = new MessageEvent('messageerror', {});
      ev.isTrusted = true;
      dispatch(target, ev);
      return true;
    }
    const ev = new MessageEvent('message', { data, origin: '' });
    ev.isTrusted = true;
    dispatch(target, ev);
    return true;
  });

  // what a worker's script threw that nothing there caught, to its `Worker`
  entry('__workerError', () => {
    const [id, message, filename, lineno, colno] = input();
    const target = workers.get(id);
    if (!target) return false;
    const ev = new ErrorEvent('error', {
      message: str(message),
      filename: str(filename),
      lineno: Number(lineno) || 0,
      colno: Number(colno) || 0,
      cancelable: true,
    });
    ev.isTrusted = true;
    dispatch(target, ev);
    return true;
  });

  /**
   * This realm is a dedicated worker's (`worker-thread.ts`): what a page's
   * window has and a worker's global does not goes — the document, the
   * window and what a window is in, the storage, the dialogs and the
   * elements' interfaces, which a library looks for to tell where it runs —
   * and what a worker's has comes: `postMessage`, `close`, `importScripts`,
   * its location and its name.
   */
  entry('__becomeWorker', () => {
    const { url, name } = input();
    for (const key of Object.getOwnPropertyNames(G)) {
      if (
        /^(HTML|SVG)/.test(key) ||
        WINDOW_ONLY.has(key) ||
        key.startsWith('webkit')
      ) {
        try {
          delete (G as Any)[key];
        } catch {}
      }
    }
    const here = new URL(str(url));
    workerLocation = {
      href: here.href,
      origin: here.origin,
      protocol: here.protocol,
      host: here.host,
      hostname: here.hostname,
      port: here.port,
      pathname: here.pathname,
      search: here.search,
      hash: here.hash,
      toString: () => here.href,
    };
    const scope = (label: string): Any => {
      const fn: Any = function () {
        throw new TypeError('Illegal constructor');
      };
      Object.defineProperty(fn, 'name', { value: label });
      Object.defineProperty(fn, Symbol.hasInstance, {
        value: (v: Any) => v === G,
      });
      return fn;
    };
    define('WorkerGlobalScope', scope('WorkerGlobalScope'));
    define('DedicatedWorkerGlobalScope', scope('DedicatedWorkerGlobalScope'));
    define('name', str(name));
    define('postMessage', function postMessage(message: Any): void {
      call('workerPostOut', serializeClone(message));
    });
    define('close', function close(): void {
      call('workerClose');
    });
    // each script fetched and run in turn, before this returns (HTML
    // 10.3.4): the host waits for it, the thread it is in being the
    // worker's own
    define('importScripts', function importScripts(...urls: Any[]): void {
      for (const u of urls) {
        const href = new URL(str(u), workerLocation!.href).href;
        const code = call('importScript', href);
        if (typeof code !== 'string') {
          throw new DOMException(
            `Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '${href}' failed to load.`,
            'NetworkError',
          );
        }
        (0, eval)(`${code}\n//# sourceURL=${href}`);
      }
    });
    // an error nothing here caught is the `Worker`'s too, where the page
    // hears it
    windowTarget.addEventListener('error', (ev: Any) => {
      if (ev.defaultPrevented) return;
      call(
        'workerErrorOut',
        JSON.stringify([
          str(ev.message),
          str(ev.filename),
          Number(ev.lineno) || 0,
          Number(ev.colno) || 0,
        ]),
      );
    });
    return true;
  });

  // what came of a `fetch`
  entry('__fetched', () => {
    const [id, answer] = input();
    const pending = fetches.get(id);
    if (!pending) return false;
    fetches.delete(id);
    if (typeof answer === 'string') pending.reject(new TypeError(answer));
    else {
      // the network's bytes, which cross as base64: a string is all that
      // crosses, and one of raw bytes is mostly escapes once it is JSON
      const response = new Response(
        typeof answer.base64 === 'string' ? '' : answer.body,
        {
          status: answer.status,
          statusText: answer.statusText,
          headers: answer.headers,
          url: answer.url,
          redirected: answer.redirected,
          type: answer.type ?? 'basic',
        },
      );
      if (typeof answer.base64 === 'string') {
        response._raw = bytesOfBase64(answer.base64);
      }
      pending.resolve(response);
    }
    return true;
  });

  // where the document has got to: `DOMContentLoaded`, then `load`
  entry('__ready', () => {
    const [state] = input();
    document._ready = state;
    const change = new Event('readystatechange');
    change.isTrusted = true;
    dispatch(document, change);
    if (state === 'interactive') {
      const ev = new Event('DOMContentLoaded', { bubbles: true });
      ev.isTrusted = true;
      dispatch(document, ev);
    } else if (state === 'complete') {
      const ev = new Event('load');
      ev.isTrusted = true;
      dispatch(windowTarget, ev);
    }
    return true;
  });

  // a script of a frame's document, the page's own origin's: run here, in
  // the page's realm, with the frame's window and document for the names a
  // script reaches them by — a frame has no realm of its own here, so what
  // it declares is its function's and not a window's (`_frameScripts`)
  entry('__frameScript', () => {
    const [id, code, url] = input();
    const doc = wrap(id);
    if (!doc) return false;
    const win = windowOfDocument(doc);
    if (!win) return false;
    try {
      new Function(
        'window',
        'self',
        'document',
        'parent',
        'top',
        'frames',
        `${code}\n//# sourceURL=${String(url).replace(/\s/g, '%20')}`,
      ).call(win, win, win, doc, win.parent, win.top, win);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  });

  // the viewport scrolled: `scroll` at the document, which bubbles to the
  // window (CSSOM View 13.1, run the scroll steps) — what CodeMirror
  // measures its lines again on once it has come into view
  entry('__scrolled', () => {
    const ev = new Event('scroll', { bubbles: true });
    ev.isTrusted = true;
    return dispatch(document, ev);
  });

  // --- realms linked: a frame's and the page it is in ------------------
  //
  // The browser runs a frame's document in a realm of its own and hands
  // each realm the other's global through a data slot (`ScriptEngine.link`)
  // — two page realms of one origin, which reach each other as a browser's
  // same-origin frames do.

  Object.defineProperty(G, '__handed', {
    value: undefined,
    writable: true,
    configurable: false,
    enumerable: false,
  });
  const handed = (): Any => {
    const value = G.__handed;
    G.__handed = undefined;
    return value;
  };
  // a frame of this page's runs in its own realm: its window here is that
  // realm's global from now on
  entry('__linkFrame', () => {
    const [id, cross] = input();
    linkedFrames.set(Number(id), handed());
    if (cross) crossLinked.add(Number(id));
    else crossLinked.delete(Number(id));
    return true;
  });
  entry('__unlinkFrame', () => {
    const [id] = input();
    linkedFrames.delete(Number(id));
    crossLinked.delete(Number(id));
    return true;
  });
  // this realm is a frame's: its parent and its top are the page's, behind
  // a window that posts to it with this one as the source
  entry('__linkParent', () => {
    const [id, cross] = input();
    const global = handed();
    const frame = Number(id);
    if (cross) {
      // a parent of another origin's: what crosses origins and no more
      // (HTML 7.2.3), and no element it is in
      const blocked = (): Any =>
        new DOMException(
          `Blocked a frame with origin "${location.origin}" from accessing a cross-origin frame.`,
          'SecurityError',
        );
      const allowed: Any = {
        postMessage: deliverInto(global, frame),
        closed: false,
        length: 0,
        opener: null,
        close() {},
        focus() {},
        blur() {},
      };
      const window: Any = new Proxy(
        {},
        {
          get(_t, key) {
            if (key === 'window' || key === 'self' || key === 'frames') {
              return window;
            }
            if (key === 'parent' || key === 'top') return window;
            if (key === 'location') {
              return {
                set href(_v: Any) {},
                replace() {},
                assign() {},
              };
            }
            if (Object.prototype.hasOwnProperty.call(allowed, key)) {
              return allowed[key as string];
            }
            if (
              key === 'then' ||
              key === Symbol.toStringTag ||
              key === Symbol.hasInstance ||
              key === Symbol.isConcatSpreadable
            ) {
              return undefined;
            }
            throw blocked();
          },
          set(_t, key) {
            if (key === 'location') return true;
            throw blocked();
          },
          has: (_t, key) =>
            key in allowed ||
            key === 'window' ||
            key === 'self' ||
            key === 'parent' ||
            key === 'top' ||
            key === 'location',
          ownKeys: () => Reflect.ownKeys(allowed),
          getOwnPropertyDescriptor(_t, key) {
            const found = Reflect.getOwnPropertyDescriptor(allowed, key);
            if (found) found.configurable = true;
            return found;
          },
          defineProperty() {
            throw blocked();
          },
          deleteProperty() {
            throw blocked();
          },
          getPrototypeOf: () => null,
          preventExtensions: () => false,
        },
      );
      proxiedFrames.set(window, null);
      parentLink = { global, window, frame };
      define('parent', window);
      define('top', window);
      Object.defineProperty(G, 'frameElement', {
        get: () => null,
        configurable: true,
      });
      return true;
    }
    const window: Any = new Proxy(
      {},
      {
        get(_t, key) {
          if (key === 'postMessage') return deliverInto(global, frame);
          return Reflect.get(global, key, global);
        },
        set: (_t, key, value) => Reflect.set(global, key, value, global),
        has: (_t, key) => key in global,
        ownKeys: () => Reflect.ownKeys(global),
        // every property a configurable one, as `frameProxyOf`'s are
        getOwnPropertyDescriptor(_t, key) {
          const found = Reflect.getOwnPropertyDescriptor(global, key);
          if (found) found.configurable = true;
          return found;
        },
        defineProperty: (_t, key, descriptor) =>
          Reflect.defineProperty(global, key, {
            ...descriptor,
            configurable: true,
          }),
        deleteProperty: (_t, key) => Reflect.deleteProperty(global, key),
        getPrototypeOf: () => Object.getPrototypeOf(global),
        preventExtensions: () => false,
      },
    );
    proxiedFrames.set(window, null);
    parentLink = { global, window, frame };
    const top = Reflect.get(global, 'top', global);
    define('parent', window);
    define('top', top === global ? window : top);
    Object.defineProperty(G, 'frameElement', {
      get: () => global.__frameElement(frame),
      configurable: true,
    });
    return true;
  });
  // A message from another realm of this page: cloned here, as it is
  // posted, and told as a task of its own, its source the window that
  // stands for the realm it came from — `from` 0 for this realm's parent,
  // else the frame of this realm's it is.
  Object.defineProperty(G, '__message', {
    value: (message: Any, origin: Any, from: Any) => {
      const data = cloneOf(message);
      const source =
        from === 0 ? (parentLink?.window ?? null) : frameProxyOf(wrap(from));
      setTimer(
        () => {
          const ev = new MessageEvent('message', {
            data,
            origin: str(origin),
            source,
          });
          ev.isTrusted = true;
          dispatch(windowTarget, ev);
        },
        0,
        [],
        false,
      );
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
  // this realm's origin, which a message posted to it from another realm
  // is held to (`deliverInto`)
  Object.defineProperty(G, '__origin', {
    value: () => str(G.location?.origin ?? location.origin),
    writable: false,
    configurable: false,
    enumerable: false,
  });
  // the element a frame of this page's is, for that frame's `frameElement`
  Object.defineProperty(G, '__frameElement', {
    value: (id: Any) => wrap(Number(id)),
    writable: false,
    configurable: false,
    enumerable: false,
  });

  // a plain event at an element: a script's `load` or `error`
  entry('__fire', () => {
    const [id, type] = input();
    const target = wrap(id);
    if (!target) return false;
    const ev = new Event(String(type));
    ev.isTrusted = true;
    return dispatch(target, ev);
  });

  // nothing: run so that the microtasks a promise the host settled queued
  // run (`microtaskMode: 'afterEvaluate'`)
  entry('__drain', () => true);

  // What a module threw, or failed to fetch, parse or link with, which the
  // host hands in through `__thrown` without reading it
  // (`ScriptEngine._fault`): a data slot no page can make a setter of, as
  // `__in` is, and named apart from the entry that reads it. A timeout is the
  // host's to report, and answered so.
  Object.defineProperty(G, '__thrown', {
    value: undefined,
    writable: true,
    configurable: false,
    enumerable: false,
  });
  Object.defineProperty(G, '__promise', {
    value: undefined,
    writable: true,
    configurable: false,
    enumerable: false,
  });
  // A promise of the page's rejected with nothing to catch it, handed in
  // through `__thrown` and `__promise` as a module's error is: told as
  // `unhandledrejection`, which a page can cancel, and reported as a
  // browser reports it where none does.
  entry('__rejected', () => {
    const reason = G.__thrown;
    const promise = G.__promise;
    G.__thrown = undefined;
    G.__promise = undefined;
    const ev = new PromiseRejectionEvent('unhandledrejection', {
      promise,
      reason,
      cancelable: true,
    });
    ev.isTrusted = true;
    if (!dispatch(windowTarget, ev)) return true;
    bridge('log', 'error', `Uncaught (in promise) ${describe(reason).text}`);
    return true;
  });

  entry('__fault', () => {
    const error = G.__thrown;
    G.__thrown = undefined;
    if (
      error &&
      typeof error === 'object' &&
      error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
    ) {
      return 'timeout';
    }
    report(error);
    return true;
  });
}
