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
export function installDom(bridge: Bridge): void {
  // strict, so that no page reads `caller` or `arguments` off a function of
  // this one's on its way up the stack
  'use strict';
  type Any = any;
  const G: Any = globalThis;

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
    if (MUTATES.has(op)) mutated();
    return r;
  };
  /** The ops that change the tree, which the host records
   *  (`host.ts`, "what changed"). */
  const MUTATES = new Set([
    'setText',
    'insert',
    'remove',
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

  const CODES: Record<string, number> = {
    IndexSizeError: 1,
    HierarchyRequestError: 3,
    WrongDocumentError: 4,
    InvalidCharacterError: 5,
    NotFoundError: 8,
    NotSupportedError: 9,
    InvalidStateError: 11,
    SyntaxError: 12,
    InvalidAccessError: 15,
    TypeMismatchError: 17,
    QuotaExceededError: 22,
    TimeoutError: 23,
    DataCloneError: 25,
    InUseAttributeError: 10,
    AbortError: 20,
  };
  class DOMException extends Error {
    readonly code: number;
    constructor(message = '', name = 'Error') {
      super(message);
      Object.defineProperty(this, 'name', { value: name, configurable: true });
      this.code = CODES[name] ?? 0;
    }
  }

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
      const ev = new ErrorEvent('error', { message, error, cancelable: true });
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

  class Event {
    static readonly NONE = NONE;
    static readonly CAPTURING_PHASE = CAPTURING_PHASE;
    static readonly AT_TARGET = AT_TARGET;
    static readonly BUBBLING_PHASE = BUBBLING_PHASE;
    readonly type: string;
    readonly bubbles: boolean;
    readonly cancelable: boolean;
    readonly composed: boolean;
    readonly timeStamp: number;
    isTrusted = false;
    target: Any = null;
    currentTarget: Any = null;
    eventPhase = NONE;
    defaultPrevented = false;
    _stop = false;
    _stopNow = false;
    _passive = false;
    _path: Any[] = [];
    constructor(type: string, init: Any = {}) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to construct 'Event': 1 argument required");
      }
      this.type = String(type);
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.composed = !!init.composed;
      this.timeStamp = now();
    }
    get srcElement(): Any {
      return this.target;
    }
    get returnValue(): boolean {
      return !this.defaultPrevented;
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
      if (this.cancelable && !this._passive) this.defaultPrevented = true;
    }
    stopPropagation(): void {
      this._stop = true;
    }
    stopImmediatePropagation(): void {
      this._stop = true;
      this._stopNow = true;
    }
    composedPath(): Any[] {
      return this.eventPhase === NONE ? [] : this._path.slice();
    }
    initEvent(type: string, bubbles = false, cancelable = false): void {
      (this as Any).type = String(type);
      (this as Any).bubbles = !!bubbles;
      (this as Any).cancelable = !!cancelable;
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
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.pointerId = Number(init.pointerId ?? 1);
      this.pointerType = String(init.pointerType ?? 'mouse');
      this.isPrimary = init.isPrimary ?? true;
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

  /** The `on<type>` handler of a target, a property's or its attribute's. */
  const handlerOf = (target: Any, type: string): Any => {
    const own = target._handlers[type];
    if (own !== undefined) return own;
    if (!(target instanceof Element)) return null;
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
    event.currentTarget = target;
    event.eventPhase = phase;
    if (phase !== CAPTURING_PHASE) {
      const handler = handlerOf(target, event.type);
      if (typeof handler === 'function') {
        try {
          const result = handler.call(target, event);
          if (result === false) event.preventDefault();
        } catch (error) {
          report(error);
        }
        if (event._stopNow) return;
      }
    }
    const list = target._listeners[event.type];
    if (!list?.length) return;
    for (const l of list.slice()) {
      if (phase === CAPTURING_PHASE && !l.capture) continue;
      if (phase === BUBBLING_PHASE && l.capture) continue;
      if (!list.includes(l)) continue;
      if (l.once) list.splice(list.indexOf(l), 1);
      event._passive = l.passive;
      try {
        if (typeof l.fn === 'function') l.fn.call(target, event);
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
      if (path[path.length - 1] === document && event.type !== 'load') {
        path.push(windowTarget);
      }
    }
    event.target = target === windowTarget ? G : target;
    event._path = path.map((t) => (t === windowTarget ? G : t));
    event._stop = false;
    event._stopNow = false;
    for (let i = path.length - 1; i > 0 && !event._stop; i -= 1) {
      invoke(path[i], event, CAPTURING_PHASE);
    }
    if (!event._stop) invoke(path[0], event, AT_TARGET);
    if (event.bubbles) {
      for (let i = 1; i < path.length && !event._stop; i += 1) {
        invoke(path[i], event, BUBBLING_PHASE);
      }
    }
    event.eventPhase = NONE;
    event.currentTarget = null;
    return !event.defaultPrevented;
  };

  // --- nodes -------------------------------------------------------------------

  const wrappers = new Map<number, Any>();

  /** The wrapper of a node id, made the first time it is asked for. */
  const wrap = (id: number): Any => {
    if (!id) return null;
    let node = wrappers.get(id);
    if (node) return node;
    const info = String(call('info', id));
    const bar = info.indexOf('|');
    const type = Number(info.slice(0, bar));
    const name = info.slice(bar + 1);
    const Kind =
      type === 1
        ? (ELEMENT_CLASSES[name] ??
          (SVG_TAGS.has(name) ? SVGElement : HTMLElement))
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
    // what a class's fields would have set, which no constructor ran for
    if (Kind === Document) {
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
      return this === document ? null : document;
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
      if (old?.parentNode !== this) {
        throw new DOMException(
          'The node to be replaced is not a child of this node.',
          'NotFoundError',
        );
      }
      if (child !== old) {
        call('insert', this._id, idOf(child), old._id);
        call('remove', old._id);
      }
      return old;
    }
    cloneNode(deep = false): Any {
      return wrap(call('clone', this._id, !!deep));
    }
    normalize(): void {}
    lookupNamespaceURI(): null {
      return null;
    }
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
      call('setText', this._id, str(v));
    }
    override get nodeValue(): Any {
      return this.data;
    }
    override set nodeValue(v: Any) {
      this.data = v;
    }
    get length(): number {
      return this.data.length;
    }
    appendData(s: Any): void {
      this.data += str(s);
    }
    substringData(offset: number, count: number): string {
      return this.data.substr(offset, count);
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
    get wholeText(): string {
      return this.data;
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
    get name(): string {
      return 'html';
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
      ? event.composed
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
  const styleOf = (el: Any): Any => {
    const target = {
      getPropertyValue: (name: Any) =>
        String(call('style', el._id, str(name).toLowerCase()) ?? ''),
      getPropertyPriority: (name: Any) =>
        String(call('stylePriority', el._id, str(name).toLowerCase()) ?? ''),
      setProperty: (name: Any, value: Any, priority: Any = '') =>
        void call(
          'setStyle',
          el._id,
          str(name).toLowerCase(),
          value === null || value === undefined ? '' : str(value),
          str(priority),
        ),
      removeProperty: (name: Any) => {
        const was = target.getPropertyValue(name);
        call('setStyle', el._id, str(name).toLowerCase(), '', '');
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
        return el.getAttribute('style') ?? '';
      },
      set cssText(v: Any) {
        el.setAttribute('style', str(v));
      },
    } as Any;
    return new Proxy(target, {
      get(t, key) {
        if (typeof key !== 'string' || key in t) return t[key as Any];
        return t.getPropertyValue(kebab(key));
      },
      set(t, key, value) {
        if (typeof key !== 'string') return false;
        if (key === 'cssText') t.cssText = value;
        else t.setProperty(kebab(key), value);
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
    get tagName(): string {
      return this._name.toUpperCase();
    }
    override get nodeName(): string {
      return this.tagName;
    }
    get localName(): string {
      return this._name;
    }
    get namespaceURI(): string {
      return 'http://www.w3.org/1999/xhtml';
    }
    get prefix(): null {
      return null;
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
    get slot(): string {
      return this.getAttribute('slot') ?? '';
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
    get clientWidth(): number {
      return Math.round(docRect(this)?.[2] ?? 0);
    }
    get clientHeight(): number {
      return Math.round(docRect(this)?.[3] ?? 0);
    }
    get clientTop(): number {
      return 0;
    }
    get clientLeft(): number {
      return 0;
    }
    get scrollWidth(): number {
      return this.clientWidth;
    }
    get scrollHeight(): number {
      return this.clientHeight;
    }
    get scrollTop(): number {
      return 0;
    }
    set scrollTop(_v: number) {}
    get scrollLeft(): number {
      return 0;
    }
    set scrollLeft(_v: number) {}
    scrollIntoView(): void {
      const r = docRect(this);
      if (r) call('scrollTo', viewport().scrollX, r[1]);
    }
    scroll(): void {}
    scrollTo(): void {}
    scrollBy(): void {}
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
    animate(): Any {
      return {
        finished: Promise.resolve(),
        cancel() {},
        finish() {},
        play() {},
        pause() {},
        onfinish: null,
      };
    }
    getAnimations(): Any[] {
      return [];
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

  class HTMLElement extends Element {
    get style(): Any {
      return (this._style ??= styleOf(this));
    }
    set style(v: Any) {
      this.setAttribute('style', v);
    }
    get dataset(): Any {
      return (this._dataset ??= datasetOf(this));
    }
    get hidden(): boolean {
      return this.hasAttribute('hidden');
    }
    set hidden(v: Any) {
      this.toggleAttribute('hidden', !!v);
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
    get draggable(): boolean {
      return this.getAttribute('draggable') === 'true';
    }
    get contentEditable(): string {
      return this.getAttribute('contenteditable') ?? 'inherit';
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
    get offsetWidth(): number {
      return Math.round(docRect(this)?.[2] ?? 0);
    }
    get offsetHeight(): number {
      return Math.round(docRect(this)?.[3] ?? 0);
    }
    get offsetLeft(): number {
      return Math.round(docRect(this)?.[0] ?? 0);
    }
    get offsetTop(): number {
      return Math.round(docRect(this)?.[1] ?? 0);
    }
    get offsetParent(): Any {
      return docRect(this) ? document.body : null;
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
    get dataset(): Any {
      return (this._dataset ??= datasetOf(this));
    }
    override get namespaceURI(): string {
      return 'http://www.w3.org/2000/svg';
    }
    override get tagName(): string {
      return this._name;
    }
  }
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
  for (const part of URL_PARTS) {
    Object.defineProperty(HTMLAnchorElement.prototype, part, {
      get(this: Any): string {
        return urlParts(this.href)?.[part] ?? '';
      },
      configurable: true,
    });
  }
  class HTMLAreaElement extends HTMLAnchorElement {}

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
      return this.offsetWidth;
    }
    set width(v: Any) {
      this.setAttribute('width', v);
    }
    get height(): number {
      return this.offsetHeight;
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
  class HTMLDialogElement extends HTMLElement {
    show(): void {
      this.setAttribute('open', '');
    }
    showModal(): void {
      this.setAttribute('open', '');
    }
    close(): void {
      this.removeAttribute('open');
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
    get selectionStart(): number {
      return this.value.length;
    }
    get selectionEnd(): number {
      return this.value.length;
    }
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
      const v = controlValue(this);
      return typeof v === 'string' ? v : '';
    }
    set value(v: Any) {
      call('setValue', this._id, str(v));
    }
    get selectedOptions(): Any {
      const value = this.value;
      const options = Array.from(this.querySelectorAll('option')) as Any[];
      const first = options.find((o) => o.value === value);
      return list(first ? [first] : []);
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
    get elements(): Any {
      const own = Array.from(document.querySelectorAll(CONTROLS)).filter(
        (el: Any) => el.form === this,
      ) as Any[];
      const out: Any = list(own);
      for (const el of own) {
        const name = el.getAttribute('name') || el.getAttribute('id');
        if (name && !(name in out)) out[name] = el;
      }
      return out;
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

  class HTMLIFrameElement extends HTMLElement {
    get contentWindow(): null {
      return null;
    }
    get contentDocument(): null {
      return null;
    }
  }
  class HTMLCanvasElement extends HTMLElement {
    getContext(): null {
      return null;
    }
    toDataURL(): string {
      return 'data:,';
    }
  }
  class HTMLMediaElement extends HTMLElement {
    static readonly NETWORK_EMPTY = 0;
    static readonly HAVE_NOTHING = 0;
    // a media element here never loads: at rest, before its first frame,
    // as a browser has one that has not started (HTML 4.8.11)
    get paused(): boolean {
      return true;
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
    get currentTime(): number {
      return 0;
    }
    set currentTime(_v: Any) {}
    volume = 1;
    playbackRate = 1;
    defaultPlaybackRate = 1;
    get muted(): boolean {
      return this.hasAttribute('muted');
    }
    set muted(v: Any) {
      this.toggleAttribute('muted', !!v);
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
    play(): Promise<void> {
      return Promise.reject(
        new DOMException(
          'Media does not play from a script here.',
          'NotSupportedError',
        ),
      );
    }
    pause(): void {}
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
  class HTMLTableSectionElement extends HTMLElement {}
  class HTMLTableCaptionElement extends HTMLElement {}
  class HTMLTableColElement extends HTMLElement {}
  class HTMLLegendElement extends HTMLElement {}
  class HTMLOptGroupElement extends HTMLElement {}
  class HTMLDataListElement extends HTMLElement {}
  class HTMLProgressElement extends HTMLElement {}
  class HTMLMeterElement extends HTMLElement {}
  class HTMLOutputElement extends HTMLElement {}
  class HTMLObjectElement extends HTMLElement {}
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
  class HTMLHeadElement extends HTMLElement {}
  class HTMLHtmlElement extends HTMLElement {}
  class HTMLDivElement extends HTMLElement {}
  class HTMLSpanElement extends HTMLElement {}
  class HTMLParagraphElement extends HTMLElement {}
  class HTMLHeadingElement extends HTMLElement {}
  class HTMLUListElement extends HTMLElement {}
  class HTMLOListElement extends HTMLElement {}
  class HTMLLIElement extends HTMLElement {}
  class HTMLTableElement extends HTMLElement {}
  class HTMLTableRowElement extends HTMLElement {}
  class HTMLTableCellElement extends HTMLElement {}
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
      values.set(
        name.startsWith('--') ? name : name.toLowerCase(),
        part.slice(colon + 1).trim(),
      );
    }
    const names = [...values.keys()];
    const plain = (name: string): string =>
      (values.get(name) ?? '').replace(/\s*!\s*important$/i, '');
    const style: Any = {
      cssText: block.trim(),
      length: names.length,
      item: (i: Any) => names[Number(i)] ?? '',
      getPropertyValue: (name: Any) => plain(str(name)),
      getPropertyPriority: (name: Any) =>
        /!\s*important$/i.test(values.get(str(name)) ?? '') ? 'important' : '',
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
  }
  class CSSKeyframesRule extends CSSRule {
    override _type = 7;
    get name(): string {
      return conditionOf(this._text).replace(/^["']|["']$/g, '');
    }
  }
  const RULE_CLASSES: Record<string, Any> = {
    media: CSSMediaRule,
    supports: CSSSupportsRule,
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
    get documentElement(): Any {
      return wrap(Number(call('root', this._id)));
    }
    get head(): Any {
      return this.querySelector('head');
    }
    get body(): Any {
      return this.querySelector('body') ?? this.documentElement;
    }
    get title(): string {
      return String(call('title'));
    }
    set title(v: Any) {
      call('setTitle', str(v));
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
      // a document a page made of its own draws nothing, and has no sheet
      if (this !== document) return list;
      const ids = String(call('sheets'));
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
    get cookie(): string {
      return '';
    }
    set cookie(_v: Any) {}
    get defaultView(): Any {
      return G;
    }
    get characterSet(): string {
      return 'UTF-8';
    }
    get charset(): string {
      return 'UTF-8';
    }
    get contentType(): string {
      return 'text/html';
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
    get activeElement(): Any {
      return wrap(Number(call('active'))) ?? this.body;
    }
    get scrollingElement(): Any {
      return this.documentElement;
    }
    get forms(): Any {
      return this.getElementsByTagName('form');
    }
    get images(): Any {
      return this.getElementsByTagName('img');
    }
    get links(): Any {
      return this.querySelectorAll('a[href],area[href]');
    }
    get scripts(): Any {
      return this.getElementsByTagName('script');
    }
    get doctype(): Any {
      return null;
    }
    get implementation(): Any {
      return {
        hasFeature: () => true,
        // a document of its own, out of the one drawn: what a sanitizer
        // parses markup into, whose scripts nothing runs
        createHTMLDocument: (title?: Any) =>
          wrap(
            Number(
              call('newDocument', title === undefined ? null : str(title)),
            ),
          ),
      };
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
      return wrap(Number(call('byId', str(id))));
    }
    getElementsByName(name: Any): Any {
      return this.querySelectorAll(`[name="${cssEscape(str(name))}"]`);
    }
    createElement(tag: Any): Any {
      const name = str(tag).toLowerCase();
      // a valid element local name (DOM 4.9): one that starts with a
      // letter and has no white space, NUL, `/` or `>` in it, or one that
      // starts with `:`, `_` or past ASCII and has nothing in it but
      // those, letters, digits, `-` and `.` — `_` is one
      if (
        !/^[a-z][^\s\0/>]*$/.test(name) &&
        !/^[:_\u0080-\uffff][\w\-.:\u0080-\uffff]*$/.test(name)
      ) {
        throw new DOMException(
          `The tag name provided ('${name}') is not a valid name.`,
          'InvalidCharacterError',
        );
      }
      return wrap(Number(call('create', 'element', name)));
    }
    createElementNS(_ns: Any, tag: Any): Any {
      return this.createElement(String(tag).replace(/^.*:/, ''));
    }
    createTextNode(data: Any): Any {
      return wrap(Number(call('create', 'text', str(data))));
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
      return wrap(Number(call('create', 'comment', str(data))));
    }
    createDocumentFragment(): Any {
      return wrap(Number(call('create', 'fragment', '')));
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
      return {
        selectNodeContents() {},
        setStart() {},
        setEnd() {},
        collapse() {},
        getBoundingClientRect: () => new DOMRect(),
        getClientRects: () => list([]),
        createContextualFragment: (html: Any) => {
          const fragment = document.createDocumentFragment();
          const holder = document.createElement('div');
          holder.innerHTML = html;
          while (holder.firstChild) fragment.appendChild(holder.firstChild);
          return fragment;
        },
      };
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
      return node.cloneNode(deep);
    }
    adoptNode(node: Any): Any {
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
    write(..._parts: Any[]): void {
      bridge(
        'log',
        'warn',
        'document.write was ignored: this browser runs scripts after the document is parsed.',
      );
    }
    writeln(...parts: Any[]): void {
      this.write(...parts);
    }
    open(): Any {
      return this;
    }
    close(): void {}
  }
  Object.defineProperty(Document.prototype, 'nodeType', nodeTypeOf(9));
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

  class Response {
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    readonly headers: Any;
    readonly redirected: boolean;
    readonly type = 'basic';
    _body: string;
    bodyUsed = false;
    constructor(body: Any = '', init: Any = {}) {
      this._body = body === null ? '' : str(body);
      this.status = Number(init.status ?? 200);
      this.statusText = String(init.statusText ?? '');
      this.headers = new Headers(init.headers ?? {});
      this.url = String(init.url ?? '');
      this.redirected = !!init.redirected;
    }
    get ok(): boolean {
      return this.status >= 200 && this.status < 300;
    }
    _read(): string {
      if (this.bodyUsed) throw new TypeError('Body has already been consumed.');
      this.bodyUsed = true;
      return this._body;
    }
    text(): Promise<string> {
      try {
        return Promise.resolve(this._read());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    json(): Promise<Any> {
      return this.text().then((t) => JSON.parse(t));
    }
    arrayBuffer(): Promise<ArrayBuffer> {
      return this.text().then((t) => {
        const bytes = new Uint8Array(t.length);
        for (let i = 0; i < t.length; i += 1) bytes[i] = t.charCodeAt(i) & 255;
        return bytes.buffer;
      });
    }
    blob(): Promise<Any> {
      return this.text().then(
        (t) => new Blob([t], { type: this.headers.get('content-type') ?? '' }),
      );
    }
    /** The body as a stream of its bytes, read once, as the methods read
     *  it: what the app router of Next.js reads a server's payload with. */
    get body(): Any {
      if (this._stream) return this._stream;
      const response = this;
      this._stream = new ReadableStream({
        pull(controller: Any) {
          const text = response._read();
          if (text) controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
      return this._stream;
    }
    _stream: Any = null;
    clone(): Any {
      return new Response(this._body, this);
    }
  }

  // `fetch`: the request is the host's, which keeps the browser's network
  // policy, and same-origin, since there is no CORS here to apply
  let fetchSeq = 0;
  const fetches = new Map<number, { resolve: Any; reject: Any }>();
  const fetch = (input: Any, init: Any = {}): Promise<Any> =>
    new Promise((resolve, reject) => {
      const id = ++fetchSeq;
      const request = input instanceof Request ? input : null;
      const url =
        typeof input === 'string' ? input : (input?.url ?? str(input));
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
   * `XMLHttpRequest`, over `fetch`: the same origin's, through the same
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
      }).then(
        (response: Any) => {
          if (attempt !== this._attempt) return undefined;
          this._response = response;
          this.status = response.status;
          this.statusText = response.statusText;
          this.responseURL = response.url;
          this._state(2);
          return response.text().then((text: string) => {
            if (attempt !== this._attempt) return;
            this._text = text;
            this._state(3);
            const size = {
              lengthComputable: true,
              loaded: text.length,
              total: text.length,
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
      if (type === 'arraybuffer') {
        const bytes = new Uint8Array(this._text.length);
        for (let i = 0; i < this._text.length; i += 1) {
          bytes[i] = this._text.charCodeAt(i) & 255;
        }
        return bytes.buffer;
      }
      return null;
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

  /** `NodeIterator` (DOM 6.1): the tree in document order from `root`,
   *  with a reference node it is before or after. */
  class NodeIterator extends Traversal {
    referenceNode: Any;
    pointerBeforeReferenceNode = true;
    constructor(root: Any, whatToShow: Any, filter: Any) {
      super(root, whatToShow, filter);
      this.referenceNode = root;
    }
    _following(node: Any): Any {
      if (node.firstChild) return node.firstChild;
      for (let at = node; at && at !== this.root; at = at.parentNode) {
        if (at.nextSibling) return at.nextSibling;
      }
      return null;
    }
    _preceding(node: Any): Any {
      if (node === this.root) return null;
      let at = node.previousSibling;
      if (!at) return node.parentNode;
      while (at.lastChild) at = at.lastChild;
      return at;
    }
    _traverse(next: boolean): Any {
      let node = this.referenceNode;
      let before = this.pointerBeforeReferenceNode;
      for (;;) {
        if (next) {
          if (!before) {
            node = this._following(node);
            if (!node) return null;
          } else before = false;
        } else if (before) {
          node = this._preceding(node);
          if (!node) return null;
        } else before = true;
        if (this._accept(node) === 1) break;
      }
      this.referenceNode = node;
      this.pointerBeforeReferenceNode = before;
      return node;
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
      return value === G;
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

  /** `localStorage` and `sessionStorage`, kept by the host per origin. */
  const storage = (kind: 'local' | 'session'): Any => {
    const api = {
      getItem: (k: Any) => call('storage', kind, 'get', str(k)) ?? null,
      setItem: (k: Any, v: Any) =>
        void call('storage', kind, 'set', str(k), str(v)),
      removeItem: (k: Any) => void call('storage', kind, 'remove', str(k)),
      clear: () => void call('storage', kind, 'clear'),
      key: (i: number) => keys()[i] ?? null,
      get length(): number {
        return keys().length;
      },
    } as Any;
    const keys = (): string[] => {
      const s = call('storage', kind, 'keys');
      return typeof s === 'string' && s ? s.split('\u0000') : [];
    };
    return new Proxy(api, {
      get(t, key) {
        if (typeof key !== 'string' || key in t) return t[key as Any];
        return t.getItem(key) ?? undefined;
      },
      set(t, key, value) {
        if (typeof key !== 'string') return false;
        t.setItem(key, value);
        return true;
      },
      deleteProperty(t, key) {
        if (typeof key === 'string') t.removeItem(key);
        return true;
      },
      ownKeys: () => keys(),
      getOwnPropertyDescriptor(t, key) {
        if (typeof key !== 'string') return undefined;
        const value = t.getItem(key);
        return value === null
          ? undefined
          : { value, writable: true, enumerable: true, configurable: true };
      },
    });
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
   *  once — no listener hears it change. */
  const matchMedia = (query: Any): Any => {
    const media = str(query);
    return {
      media,
      matches: !!call('media', media),
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    };
  };

  /** `getComputedStyle`: the host's `computedStyle`, a declaration that
   *  answers by a property's name, either spelling. */
  const getComputedStyle = (el: Any, pseudo?: Any): Any => {
    const which = pseudo ? String(pseudo).replace(/^:+/, '') : '';
    const json = call('computed', idOf(el, 'element'), which);
    const values: Record<string, string> =
      typeof json === 'string' && json ? JSON.parse(json) : {};
    const out: Any = {
      getPropertyValue: (name: Any) => values[str(name).toLowerCase()] ?? '',
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

  /** Observers a page makes at its start. `IntersectionObserver` and
   *  `ResizeObserver` report what they observe once, as in view and at its
   *  size — what a lazy loader waits for. `MutationObserver` is below. */
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
              {
                target: el,
                isIntersecting: true,
                intersectionRatio: 1,
                boundingClientRect: el.getBoundingClientRect(),
                intersectionRect: el.getBoundingClientRect(),
                rootBounds: null,
                time: now(),
              },
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
  class ResizeObserver {
    _fn: Any;
    constructor(fn: Any) {
      this._fn = fn;
    }
    observe(el: Any): void {
      setTimer(
        () => {
          const r = el.getBoundingClientRect();
          this._fn(
            [
              {
                target: el,
                contentRect: r,
                borderBoxSize: [{ inlineSize: r.width, blockSize: r.height }],
              },
            ],
            this,
          );
        },
        0,
        [],
        false,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
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

  // --- the global ------------------------------------------------------------------

  const define = (name: string, value: Any): void => {
    Object.defineProperty(G, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };
  const getter = (name: string, get: () => Any): void => {
    Object.defineProperty(G, name, {
      get,
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
    Element,
    HTMLElement,
    SVGElement,
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
    Response,
    AbortController,
    AbortSignal,
    IntersectionObserver,
    ResizeObserver,
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
    get: () => location,
    set: (v: Any) => {
      location.href = v;
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
  define('localStorage', storage('local'));
  define('sessionStorage', storage('session'));
  define('fetch', fetch);
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
  define('customElements', {
    define(name: Any) {
      bridge(
        'log',
        'warn',
        `customElements.define('${str(name)}') was ignored: custom elements are not supported here.`,
      );
    },
    get: () => undefined,
    whenDefined: () => new Promise(() => {}),
    upgrade() {},
  });
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
  define('open', (url?: Any) => {
    if (url) call('open', String(call('resolve', str(url))));
    return null;
  });
  define('close', () => {});
  define('focus', () => {});
  define('blur', () => {});
  define('print', () => {});
  define('stop', () => {});
  // a message to this window: a task of its own, after this one, where
  // the origin it is meant for is this one's (HTML 9.4.3)
  define('postMessage', (message: Any, options?: Any) => {
    const target =
      options && typeof options === 'object'
        ? (options.targetOrigin ?? '/')
        : options === undefined
          ? '/'
          : str(options);
    if (target !== '*' && target !== '/') {
      let origin: string;
      try {
        origin = new URL(target).origin;
      } catch {
        throw new DOMException(
          `Invalid target origin '${target}' in a call to 'postMessage'.`,
          'SyntaxError',
        );
      }
      if (origin !== location.origin) return;
    }
    const data = cloneOf(message);
    setTimer(
      () => {
        const ev = new MessageEvent('message', {
          data,
          origin: location.origin,
          source: G,
        });
        ev.isTrusted = true;
        dispatch(windowTarget, ev);
      },
      0,
      [],
      false,
    );
  });
  Object.defineProperty(G, Symbol.toStringTag, {
    value: 'Window',
    configurable: true,
  });
  define('getSelection', () => ({
    rangeCount: 0,
    isCollapsed: true,
    type: 'None',
    toString: () => '',
    removeAllRanges() {},
    addRange() {},
    getRangeAt() {
      throw new DOMException('No range.', 'IndexSizeError');
    },
  }));
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
      get: () => windowTarget._handlers[type] ?? null,
      set: (fn: Any) => {
        windowTarget._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
    });
  }

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

  // a page's script, run as a classic script is: in the global scope, its
  // declarations the window's
  // `currentScript` stays the script's through the microtasks it queued,
  // which run as this entry ends (`microtaskMode: 'afterEvaluate'`), and
  // is put back by the entry after (`__ran`): HTML runs the microtask
  // checkpoint inside running the script, before it puts `currentScript`
  // back (8.1.4.6). Turbopack's chunks read it from a promise's callback.
  entry('__exec', () => {
    const [code, url, script] = input();
    document._current = script ? wrap(script) : null;
    try {
      (0, eval)(`${code}\n//# sourceURL=${String(url).replace(/\s/g, '%20')}`);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  });
  entry('__ran', () => {
    document._current = null;
    return true;
  });

  // an event `<Html>` was told of, dispatched as the browser would, and
  // whether its default goes on
  entry('__event', () => {
    const e = input();
    const target = wrap(e.target);
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
    switch (e.type) {
      case 'click':
      case 'dblclick':
      case 'mousedown':
      case 'mouseup': {
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
              buttons: e.type === 'mousedown' ? 1 : 0,
              ...mods,
            }),
          ),
        );
      }
      case 'keydown':
      case 'keyup':
        return dispatch(
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

  // what came of a `fetch`
  entry('__fetched', () => {
    const [id, answer] = input();
    const pending = fetches.get(id);
    if (!pending) return false;
    fetches.delete(id);
    if (typeof answer === 'string') pending.reject(new TypeError(answer));
    else {
      pending.resolve(
        new Response(answer.body, {
          status: answer.status,
          statusText: answer.statusText,
          headers: answer.headers,
          url: answer.url,
          redirected: answer.redirected,
        }),
      );
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
