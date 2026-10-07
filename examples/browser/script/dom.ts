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
    TimeoutError: 23,
    DataCloneError: 25,
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
  const report = (error: Any): void => {
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
    bridge('log', 'error', `Uncaught ${stack || message}`);
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
  class HashChangeEvent extends Event {
    readonly oldURL: string;
    readonly newURL: string;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.oldURL = String(init.oldURL ?? '');
      this.newURL = String(init.newURL ?? '');
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
      for (let at = target.parentNode; at; at = at.parentNode) path.push(at);
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
    getRootNode(): Any {
      let at: Any = this;
      for (let p = at.parentNode; p; p = p.parentNode) at = p;
      return at;
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
      const names = this.getAttributeNames();
      const attrs = names.map((name: string) => ({
        name,
        localName: name,
        value: this.getAttribute(name),
        ownerElement: this,
        specified: true,
        namespaceURI: null,
      }));
      const out: Any = list(attrs);
      out.getNamedItem = (n: string) =>
        attrs.find((a: Any) => a.name === n.toLowerCase()) ?? null;
      return out;
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
      call('delAttr', this._id, str(name).toLowerCase());
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
    get shadowRoot(): null {
      return null;
    }
    attachShadow(): never {
      throw new DOMException(
        'Shadow DOM is not supported by this browser.',
        'NotSupportedError',
      );
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
  class HTMLStyleElement extends HTMLElement {}
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
    video: HTMLMediaElement,
    audio: HTMLMediaElement,
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
      return wrap(Number(call('root')));
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
        createHTMLDocument: () => {
          throw new DOMException('Not supported here.', 'NotSupportedError');
        },
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
      if (!/^[a-z][^\s"'>/=]*$/i.test(name)) {
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
    createTreeWalker(): never {
      throw new DOMException(
        'TreeWalker is not supported here.',
        'NotSupportedError',
      );
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
      const url =
        typeof input === 'string' ? input : (input?.url ?? str(input));
      const headers = new Headers(init.headers ?? input?.headers ?? {});
      let body = init.body ?? null;
      if (body instanceof URLSearchParams) {
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
    clipboard: undefined,
    serviceWorker: undefined,
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
    DocumentType,
    DocumentFragment,
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
    HTMLVideoElement: HTMLMediaElement,
    HTMLAudioElement: HTMLMediaElement,
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
  define('location', location);
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
    supports: () => false,
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
  define('performance', {
    now,
    timeOrigin: Date.now() - now(),
    mark() {},
    measure() {},
    getEntriesByType: () => [],
    getEntriesByName: () => [],
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
  define('structuredClone', (v: Any) =>
    v === undefined ? undefined : JSON.parse(JSON.stringify(v)),
  );
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
  define('postMessage', () => {});
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
  entry('__exec', () => {
    const [code, url, script] = input();
    document._current = script ? wrap(script) : null;
    try {
      (0, eval)(`${code}\n//# sourceURL=${String(url).replace(/\s/g, '%20')}`);
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      document._current = null;
    }
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
}
