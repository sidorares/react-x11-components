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
import type { installStreams } from './streams.js';
import type { installWebTransport } from './webtransport.js';
import type { installWebSocket } from './websocket.js';
import type { installDataChannels } from './datachannel.js';
import type { installMediaStreams } from './mediastream.js';
import type { installWebAudio } from './webaudio.js';
import type { installWebRTC } from './webrtc.js';
import type { installRtcTransports } from './rtc-transports.js';
import type { installWebGL } from './webgl.js';
import type { installGeometry } from './geometry.js';

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
  streams: typeof installStreams,
  transport: typeof installWebTransport,
  socket: typeof installWebSocket,
  mediaStreams: typeof installMediaStreams,
  dataChannels: typeof installDataChannels,
  webrtc: typeof installWebRTC,
  rtcTransports: typeof installRtcTransports,
  webaudio: typeof installWebAudio,
  geometry: typeof installGeometry,
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
  // and its `WeakRef`, which holds the scroll timelines a frame measures
  // again without keeping one the page let go (`heldTimelines`)
  const RealWeakRef: Any = typeof WeakRef === 'function' ? WeakRef : null;
  /** The scroll-driven timelines a page holds — weakly, where the context
   *  can — each measured again at every frame (`snapTimelines`), which a
   *  scroll, or a change to the document, asks for while there is one. */
  const heldTimelines = new Set<Any>();

  // --- the bridge -------------------------------------------------------------

  /** An op's answer, or the host's error thrown as a `DOMException`. */
  const call = (
    op: string,
    a?: Primitive,
    b?: Primitive,
    c?: Primitive,
    d?: Primitive,
  ): Any => {
    // anything but reading a computed style, a frame's document or a
    // field's selection may change one, and encoding a bitmap reads only
    // what it is handed
    if (
      op !== 'computed' &&
      op !== 'customProperty' &&
      op !== 'frameDocument' &&
      op !== 'selection' &&
      op !== 'fontFaces' &&
      op !== 'fontMatch' &&
      op !== 'encodeImage'
    ) {
      opEpoch += 1;
    }
    const r = bridge(op, a, b, c, d);
    if (typeof r === 'string' && r.charCodeAt(0) === 1) {
      const parts = r.split('\u0001');
      throw new DOMException(parts[2] ?? '', parts[1] || 'Error');
    }
    if (mutatesHas.call(MUTATES, op)) {
      mutated();
      // a scroll timeline's time is measured again at the next frame
      if (heldTimelines.size) wantFrame();
      if (takesNotes) takeReactions();
    } else if (
      customElementsDefined &&
      !copying &&
      (op === 'clone' || op === 'import')
    ) {
      takeReactions();
    }
    return r;
  };
  /** Set while a copy is made whose registries are pinned after the op
   *  (`copyOf`), so its upgrades wait for them. */
  let copying = false;
  /** Counts the ops but the reads of a computed style and of a frame's
   *  document, which a computed style read again since none ran answers as
   *  it was (`getComputedStyle`), and a frame's document (`frameDocumentOf`).
   *  A frame's counted as a change: the Guardian's ad wrapper reads every
   *  frame's window from a `String.prototype` method it replaces, which
   *  `getComputedStyle` calls, so each read moved the count, and the next
   *  read of the style read all of it again — 17.7 million ops in a load. */
  let opEpoch = 0;
  /** Whether the page has defined a custom element, after which an op that
   *  changes the tree may have custom element reactions to run
   *  (`takeReactions`). */
  let customElementsDefined = false;
  /** Whether the host notes anything for the facade to take after an op
   *  (`takeReactions`): what happens to custom elements, once one is
   *  defined, and what is connected, once a node has a scoped registry. */
  let takesNotes = false;
  /** The ops that change the tree, which the host records
   *  (`host.ts`, "what changed"), asked through `Set.prototype.has` as it
   *  was before any page code ran: a page that changes the prototype
   *  stops no op. */
  const mutatesHas = Set.prototype.has;
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
    'write',
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
  /** An error event's fields for what was thrown: its message, and where
   *  it was thrown, as its stack's first frame says. */
  const errorInit = (error: Any, prefix = ''): Any => {
    const { message } = describe(error);
    let stack = '';
    try {
      stack = typeof error?.stack === 'string' ? error.stack : '';
    } catch {}
    const at = /\n\s+at (?:[^\n]*?\()?([^\s()]+?):(\d+):(\d+)\)?/.exec(stack);
    return {
      message: `${prefix}${message}`,
      error,
      filename: at ? at[1] : '',
      lineno: at ? Number(at[2]) : 0,
      colno: at ? Number(at[3]) : 0,
    };
  };
  const report = (error: Any): void => {
    const { text } = describe(error);
    bridge('log', 'error', `Uncaught ${text}`);
    if (reporting) return;
    reporting = true;
    try {
      const ev = new ErrorEvent('error', {
        ...errorInit(error, 'Uncaught '),
        cancelable: true,
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
  /** A CSS animation's event (CSS Animations 1, 4.2): its name, the time
   *  it had run, in seconds, and its pseudo-element. */
  class AnimationEvent extends Event {
    _animationName: string;
    _elapsedTime: number;
    _pseudoElement: string;
    _animation: Any = null;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this._animationName = str(init?.animationName ?? '');
      this._elapsedTime = Number(init?.elapsedTime ?? 0);
      this._pseudoElement = str(init?.pseudoElement ?? '');
    }
    /** The `CSSAnimation` it is of, where the document has one. */
    get animation(): Any {
      return this._animation;
    }
    get animationName(): string {
      return this._animationName;
    }
    get elapsedTime(): number {
      return this._elapsedTime;
    }
    get pseudoElement(): string {
      return this._pseudoElement;
    }
  }
  /** A CSS transition's event (CSS Transitions 1, 6.1): the longhand it
   *  is of, the time it had run, in seconds, and its pseudo-element. */
  class TransitionEvent extends Event {
    _propertyName: string;
    _elapsedTime: number;
    _pseudoElement: string;
    _animation: Any = null;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this._propertyName = str(init?.propertyName ?? '');
      this._elapsedTime = Number(init?.elapsedTime ?? 0);
      this._pseudoElement = str(init?.pseudoElement ?? '');
    }
    /** The `CSSTransition` it is of, where the document has one. */
    get animation(): Any {
      return this._animation;
    }
    get propertyName(): string {
      return this._propertyName;
    }
    get elapsedTime(): number {
      return this._elapsedTime;
    }
    get pseudoElement(): string {
      return this._pseudoElement;
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
  /** `pageshow` and `pagehide` (HTML 7.4.6.5): whether the document is
   *  kept to be shown again, which none is here. */
  class PageTransitionEvent extends Event {
    _persisted: boolean;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this._persisted = !!init?.persisted;
    }
    get persisted(): boolean {
      return this._persisted;
    }
  }
  /** `storage` (HTML 12.2.4): what another document of the origin changed
   *  in its storage. */
  class StorageEvent extends Event {
    _key: Any = null;
    _oldValue: Any = null;
    _newValue: Any = null;
    _url = '';
    _storageArea: Any = null;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this._key = init?.key ?? null;
      this._oldValue = init?.oldValue ?? null;
      this._newValue = init?.newValue ?? null;
      this._url = str(init?.url ?? '');
      this._storageArea = init?.storageArea ?? null;
    }
    get key(): Any {
      return this._key;
    }
    get oldValue(): Any {
      return this._oldValue;
    }
    get newValue(): Any {
      return this._newValue;
    }
    get url(): string {
      return this._url;
    }
    get storageArea(): Any {
      return this._storageArea;
    }
    initStorageEvent(
      type: Any,
      bubbles: Any = false,
      cancelable: Any = false,
      key: Any = null,
      oldValue: Any = null,
      newValue: Any = null,
      url: Any = '',
      storageArea: Any = null,
    ): void {
      (this as Any).initEvent(type, bubbles, cancelable);
      this._key = key === null ? null : str(key);
      this._oldValue = oldValue === null ? null : str(oldValue);
      this._newValue = newValue === null ? null : str(newValue);
      this._url = str(url);
      this._storageArea = storageArea;
    }
  }
  /** What only the user agent makes a `BeforeUnloadEvent` with: it has no
   *  constructor of a page's (HTML 7.4.2.4), but `createEvent`. */
  const UNLOADING = Symbol('beforeunload');
  /** `beforeunload` (HTML 7.4.2.4): a page that would be asked before it
   *  is left cancels it or sets `returnValue`. */
  class BeforeUnloadEvent extends Event {
    _returnValue = '';
    constructor(token?: Any, type = '', init: Any = {}) {
      if (token !== UNLOADING) throw new TypeError('Illegal constructor');
      super(type, init);
    }
    override get returnValue(): Any {
      return this._returnValue;
    }
    override set returnValue(v: Any) {
      this._returnValue = v === null || v === undefined ? '' : String(v);
    }
  }
  /** What a document is told as it is swapped out for another and as it
   *  is first shown (HTML 7.4.6.4, 8.1.7.1): how the navigation goes, where
   *  the host's session says (`firePageSwap`), and the cross-document view
   *  transition, which no navigation here sets up yet, so only a page's
   *  own `new` makes one. */
  class PageSwapEvent extends Event {
    _transition: Any;
    _activation: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this._transition = init?.viewTransition ?? null;
      this._activation = init?.activation ?? null;
    }
    get viewTransition(): Any {
      return this._transition;
    }
    get activation(): Any {
      return this._activation;
    }
  }
  class PageRevealEvent extends Event {
    _transition: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this._transition = init?.viewTransition ?? null;
    }
    get viewTransition(): Any {
      return this._transition;
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
  /** A media query list's `change` (CSSOM View 4.2): its query, and what
   *  it answers now. */
  class MediaQueryListEvent extends Event {
    readonly media: string;
    readonly matches: boolean;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.media = String(init?.media ?? '');
      this.matches = !!init?.matches;
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
    'pagereveal',
    'pageshow',
    'pageswap',
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

  /** The window each frame window's own target is for (`frameWindowOf`),
   *  which its listeners hear as what they are on, as the page's do G. */
  const targetWindows = new WeakMap<object, Any>();
  /** What a target's listeners hear it as. */
  const listenedAs = (target: Any): Any =>
    target === windowTarget ? G : (targetWindows.get(target) ?? target);

  const invoke = (target: Any, event: Any, phase: number): void => {
    // the window's listeners are kept on a target of their own, and hear
    // the window as what they are on, as `this` and `currentTarget`
    const self = listenedAs(target);
    event._currentTarget = self;
    event._phase = phase;
    if (phase !== CAPTURING_PHASE) {
      const handler = handlerOf(target, event._type);
      if (typeof handler === 'function') {
        try {
          const result = handler.call(self, event);
          // `onbeforeunload` answers a string, which asks to be confirmed
          // (HTML 8.1.8.1, "the event handler processing algorithm")
          if (
            event instanceof BeforeUnloadEvent &&
            event._type === 'beforeunload'
          ) {
            if (result !== undefined && result !== null) {
              event._canceled = true;
              if (event._returnValue === '') {
                event._returnValue = String(result);
              }
            }
          } else if (result === false) event.preventDefault();
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
    event._target = listenedAs(target);
    event._path = path.map(listenedAs);
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

  // --- CSS Typed OM: numeric values (CSS Typed OM 1, 4.3) ----------------------
  //
  // What a scroll-driven animation's times are: a `CSSUnitValue` in
  // percent, and what a page hands back, `CSS.percent(10)` or
  // `CSSNumericValue.parse("10%")`. Numbers and their arithmetic only; no
  // property's value is reified.

  /** Each unit's kind of quantity and, for one that converts, how many of
   *  the kind's canonical unit it is. */
  const UNITS: Record<string, [string, number | null]> = {
    number: ['number', 1],
    percent: ['percent', 1],
    px: ['length', 1],
    cm: ['length', 96 / 2.54],
    mm: ['length', 96 / 25.4],
    q: ['length', 96 / 101.6],
    in: ['length', 96],
    pt: ['length', 96 / 72],
    pc: ['length', 16],
    deg: ['angle', 1],
    grad: ['angle', 0.9],
    rad: ['angle', 180 / Math.PI],
    turn: ['angle', 360],
    s: ['time', 1000],
    ms: ['time', 1],
    hz: ['frequency', 1],
    khz: ['frequency', 1000],
    dppx: ['resolution', 1],
    x: ['resolution', 1],
    dpi: ['resolution', 1 / 96],
    dpcm: ['resolution', 2.54 / 96],
    fr: ['flex', 1],
  };
  for (const unit of [
    'em',
    'ex',
    'ch',
    'ic',
    'rem',
    'lh',
    'rlh',
    'cap',
    'rcap',
    'rex',
    'rch',
    'ric',
    ...['', 's', 'l', 'd', 'cq'].flatMap((p) =>
      p === 'cq'
        ? ['cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax']
        : ['vw', 'vh', 'vi', 'vb', 'vmin', 'vmax'].map((v) => p + v),
    ),
  ]) {
    UNITS[unit] = ['length', null];
  }
  /** A unit as CSS writes it after a number. */
  const unitText = (unit: string): string =>
    unit === 'number'
      ? ''
      : unit === 'percent'
        ? '%'
        : unit === 'q'
          ? 'Q'
          : unit === 'hz'
            ? 'Hz'
            : unit === 'khz'
              ? 'kHz'
              : unit;
  /** A number as CSS serializes one. */
  const numberText = (v: number): string =>
    Number.isFinite(v)
      ? String(Object.is(v, -0) ? 0 : v)
      : v > 0
        ? 'calc(infinity)'
        : v < 0
          ? 'calc(-infinity)'
          : 'calc(NaN)';
  /** A number, or a numeric value, as the arithmetic takes it. */
  const numeric = (v: Any): Any => {
    if (v instanceof CSSNumericValue) return v;
    if (typeof v === 'number') return new CSSUnitValue(v, 'number');
    throw new TypeError(
      "Failed to execute on 'CSSNumericValue': Argument is not a CSSNumericValue or number.",
    );
  };
  /** The kind of quantity a value is, where it is one. */
  const quantityOf = (v: Any): string | null => {
    if (v instanceof CSSUnitValue) return UNITS[v.unit][0];
    if (v instanceof CSSMathSum) {
      const kinds = new Set<string | null>(
        v.values._items.map(quantityOf).filter((k: Any) => k !== 'percent'),
      );
      return kinds.size === 1 ? [...kinds][0] : kinds.size ? null : 'percent';
    }
    if (v instanceof CSSMathNegate) return quantityOf(v.value);
    return null;
  };

  class CSSStyleValue {
    toString(): string {
      return '';
    }
  }
  class CSSNumericValue extends CSSStyleValue {
    add(...values: Any[]): Any {
      const all = [this, ...values.map(numeric)];
      const units = new Set(all.map((v) => v.unit));
      if (all.every((v) => v instanceof CSSUnitValue) && units.size === 1) {
        return new CSSUnitValue(
          all.reduce((sum, v) => sum + v.value, 0),
          all[0].unit,
        );
      }
      const kinds = new Set(
        all.map(quantityOf).filter((k) => k !== 'percent' && k !== null),
      );
      if (kinds.size > 1) {
        throw new TypeError(
          "Failed to execute 'add' on 'CSSNumericValue': Incompatible types",
        );
      }
      return new CSSMathSum(
        ...all.flatMap((v) => (v instanceof CSSMathSum ? v.values._items : v)),
      );
    }
    sub(...values: Any[]): Any {
      return this.add(...values.map((v) => numeric(v).negate()));
    }
    mul(...values: Any[]): Any {
      const all = [this, ...values.map(numeric)];
      if (all.every((v) => v instanceof CSSUnitValue)) {
        const units = all.filter((v) => v.unit !== 'number');
        if (units.length <= 1) {
          return new CSSUnitValue(
            all.reduce((p, v) => p * v.value, 1),
            units[0]?.unit ?? 'number',
          );
        }
      }
      return new CSSMathProduct(
        ...all.flatMap((v) =>
          v instanceof CSSMathProduct ? v.values._items : v,
        ),
      );
    }
    div(...values: Any[]): Any {
      return this.mul(...values.map((v) => numeric(v).invert()));
    }
    min(...values: Any[]): Any {
      const all = [this, ...values.map(numeric)];
      if (
        all.every((v) => v instanceof CSSUnitValue && v.unit === this._unit())
      ) {
        return new CSSUnitValue(
          Math.min(...all.map((v) => v.value)),
          all[0].unit,
        );
      }
      return new CSSMathMin(...all);
    }
    max(...values: Any[]): Any {
      const all = [this, ...values.map(numeric)];
      if (
        all.every((v) => v instanceof CSSUnitValue && v.unit === this._unit())
      ) {
        return new CSSUnitValue(
          Math.max(...all.map((v) => v.value)),
          all[0].unit,
        );
      }
      return new CSSMathMax(...all);
    }
    equals(...values: Any[]): boolean {
      return values.map(numeric).every((v) => v._same(this));
    }
    /** This value in another unit of its kind (CSS Typed OM 1, 4.3.1). */
    to(unit: Any): Any {
      const given = String(unit).toLowerCase();
      const to = given === '%' ? 'percent' : given;
      if (!UNITS[to]) {
        throw new DOMException(
          "Failed to execute 'to' on 'CSSNumericValue': Invalid unit for conversion",
          'SyntaxError',
        );
      }
      if (this instanceof CSSMathSum) {
        return (this as Any).values._items
          .map((v: Any) => v.to(to))
          .reduce((sum: Any, v: Any) => sum.add(v));
      }
      if (this instanceof CSSUnitValue) {
        if (this.unit === to) return new CSSUnitValue(this.value, to);
        const [kind, factor] = UNITS[this.unit];
        const [toKind, toFactor] = UNITS[to];
        if (
          kind === toKind &&
          factor !== null &&
          toFactor !== null &&
          kind !== 'number' &&
          kind !== 'percent'
        ) {
          return new CSSUnitValue((this.value * factor) / toFactor, to);
        }
      }
      throw new TypeError(
        "Failed to execute 'to' on 'CSSNumericValue': Cannot convert to the given unit",
      );
    }
    toSum(...units: Any[]): Any {
      const parts =
        this instanceof CSSMathSum ? (this as Any).values._items : [this];
      if (!parts.every((v: Any) => v instanceof CSSUnitValue)) {
        throw new TypeError(
          "Failed to execute 'toSum' on 'CSSNumericValue': Not a sum of values",
        );
      }
      if (!units.length) {
        return new CSSMathSum(...parts);
      }
      return new CSSMathSum(...units.map((u) => this.to(u)));
    }
    type(): Any {
      const kind = quantityOf(this);
      const out: Any = {};
      if (kind && kind !== 'number') out[kind] = 1;
      if (this instanceof CSSMathSum && quantityOf(this) !== 'percent') {
        if (
          (this as Any).values._items.some((v: Any) => v.unit === 'percent')
        ) {
          out.percentHint = kind;
        }
      }
      return out;
    }
    negate(): Any {
      return new CSSMathNegate(this);
    }
    invert(): Any {
      return new CSSMathInvert(this);
    }
    _unit(): string | null {
      return null;
    }
    _same(other: Any): boolean {
      return (
        this.constructor === other.constructor && String(this) === String(other)
      );
    }
    /**
     * A `<number>`, `<percentage>` or `<dimension>`, or a `calc()` of
     * them added, taken away, multiplied and divided, simplified as CSS
     * Values simplifies one (CSS Typed OM 1, 4.3.1, `parse`).
     */
    static parse(text: Any): Any {
      const source = String(text).trim();
      const tokens =
        source.match(
          /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:%|[a-z]+)?|calc\(|min\(|max\(|[()+\-*/,]|\s+|./gi,
        ) ?? [];
      let at = 0;
      const peek = () => {
        while (at < tokens.length && /^\s+$/.test(tokens[at])) at += 1;
        return tokens[at];
      };
      const fail = (): never => {
        throw new DOMException(
          "Failed to execute 'parse' on 'CSSNumericValue': Invalid math expression",
          'SyntaxError',
        );
      };
      const unitValue = (t: string): Any => {
        const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-z]+)?$/i.exec(
          t,
        );
        if (!m) return fail();
        const unit =
          m[2] === '%' ? 'percent' : (m[2] ?? 'number').toLowerCase();
        if (!UNITS[unit]) return fail();
        return new CSSUnitValue(Number(m[1]), unit);
      };
      const sum = (): Any => {
        let left = product();
        for (;;) {
          const t = peek();
          if (t !== '+' && t !== '-') return left;
          // `+` and `-` need white space either side inside a calc()
          at += 1;
          const right = product();
          left = t === '+' ? left.add(right) : left.sub(right);
        }
      };
      const product = (): Any => {
        let left = term();
        for (;;) {
          const t = peek();
          if (t !== '*' && t !== '/') return left;
          at += 1;
          const right = term();
          left = t === '*' ? left.mul(right) : left.div(right);
        }
      };
      const term = (): Any => {
        const t = peek();
        if (t === undefined) return fail();
        at += 1;
        if (t === '(' || /^calc\($/i.test(t)) {
          const inner = sum();
          if (peek() !== ')') return fail();
          at += 1;
          return inner;
        }
        if (/^(min|max)\($/i.test(t)) {
          const args = [sum()];
          while (peek() === ',') {
            at += 1;
            args.push(sum());
          }
          if (peek() !== ')') return fail();
          at += 1;
          return /^min/i.test(t)
            ? args[0].min(...args.slice(1))
            : args[0].max(...args.slice(1));
        }
        return unitValue(t);
      };
      const first = peek();
      if (first === undefined) return fail();
      if (!/^(calc|min|max)\($/i.test(first)) {
        at += 1;
        const value = unitValue(first);
        if (peek() !== undefined) return fail();
        return value;
      }
      const value = term();
      if (peek() !== undefined) return fail();
      return value;
    }
  }
  class CSSUnitValue extends CSSNumericValue {
    _value: number;
    _unitName: string;
    constructor(value: Any, unit: Any) {
      super();
      const v = Number(value);
      if (typeof value !== 'number' && !(value instanceof Number)) {
        if (!Number.isFinite(v)) {
          throw new TypeError(
            "Failed to construct 'CSSUnitValue': The provided double value is non-finite.",
          );
        }
      }
      const u = String(unit).toLowerCase();
      const name = u === '%' ? 'percent' : u;
      if (!UNITS[name]) {
        throw new TypeError(
          `Failed to construct 'CSSUnitValue': Invalid unit: ${String(unit)}`,
        );
      }
      this._value = v;
      this._unitName = name;
    }
    get value(): number {
      return this._value;
    }
    set value(v: Any) {
      this._value = Number(v);
    }
    get unit(): string {
      return this._unitName;
    }
    override _unit(): string {
      return this._unitName;
    }
    override negate(): Any {
      return new CSSUnitValue(-this._value, this._unitName);
    }
    override invert(): Any {
      if (this._unitName === 'number') {
        if (this._value === 0) {
          throw new RangeError(
            "Failed to execute 'div' on 'CSSNumericValue': Can't divide-by-zero",
          );
        }
        return new CSSUnitValue(1 / this._value, 'number');
      }
      return new CSSMathInvert(this);
    }
    override _same(other: Any): boolean {
      return (
        other instanceof CSSUnitValue &&
        other.unit === this.unit &&
        other.value === this.value
      );
    }
    override toString(): string {
      return `${numberText(this._value)}${unitText(this._unitName)}`;
    }
  }
  /** A list of numeric values, as a math value holds them. */
  class CSSNumericArray {
    _items: Any[];
    constructor(items: Any[]) {
      this._items = items;
      items.forEach((v, i) => {
        (this as Any)[i] = v;
      });
    }
    get length(): number {
      return this._items.length;
    }
    [Symbol.iterator](): Any {
      return this._items[Symbol.iterator]();
    }
    forEach(fn: Any, self?: Any): void {
      this._items.forEach((v, i) => fn.call(self, v, i, this));
    }
  }
  class CSSMathValue extends CSSNumericValue {
    get operator(): string {
      return '';
    }
  }
  /** A math value of a list, the operator between its members. */
  const mathOf = (name: string, join: string, minimum: number): Any =>
    class extends CSSMathValue {
      values: Any;
      constructor(...args: Any[]) {
        super();
        if (args.length < minimum) {
          throw new DOMException(
            `Failed to construct '${name}': Must specify at least one argument.`,
            'SyntaxError',
          );
        }
        this.values = new CSSNumericArray(args.map(numeric));
      }
      override get operator(): string {
        return name.slice(7).toLowerCase();
      }
      override toString(): string {
        const items = (this as Any).values._items;
        if (join === 'calc+') {
          const text = items
            .map((v: Any, i: number) =>
              i === 0
                ? inner(v)
                : v instanceof CSSMathNegate
                  ? ` - ${inner(v.value)}`
                  : ` + ${inner(v)}`,
            )
            .join('');
          return `calc(${text})`;
        }
        if (join === 'calc*') {
          const text = items
            .map((v: Any, i: number) =>
              i === 0
                ? inner(v)
                : v instanceof CSSMathInvert
                  ? ` / ${inner(v.value)}`
                  : ` * ${inner(v)}`,
            )
            .join('');
          return `calc(${text})`;
        }
        return `${join}(${items.map((v: Any) => String(v)).join(', ')})`;
      }
    };
  /** A member of a calc() as it is written inside one. */
  const inner = (v: Any): string => {
    const text = String(v);
    return v instanceof CSSMathSum || v instanceof CSSMathProduct
      ? `(${text.slice(5, -1)})`
      : text;
  };
  const CSSMathSum = mathOf('CSSMathSum', 'calc+', 1);
  const CSSMathProduct = mathOf('CSSMathProduct', 'calc*', 1);
  const CSSMathMin = mathOf('CSSMathMin', 'min', 1);
  const CSSMathMax = mathOf('CSSMathMax', 'max', 1);
  for (const [cls, name] of [
    [CSSMathSum, 'CSSMathSum'],
    [CSSMathProduct, 'CSSMathProduct'],
    [CSSMathMin, 'CSSMathMin'],
    [CSSMathMax, 'CSSMathMax'],
  ]) {
    Object.defineProperty(cls, 'name', { value: name });
  }
  class CSSMathNegate extends CSSMathValue {
    value: Any;
    constructor(value: Any) {
      super();
      this.value = numeric(value);
    }
    override get operator(): string {
      return 'negate';
    }
    override toString(): string {
      return `calc(-1 * ${inner(this.value)})`;
    }
  }
  class CSSMathInvert extends CSSMathValue {
    value: Any;
    constructor(value: Any) {
      super();
      this.value = numeric(value);
    }
    override get operator(): string {
      return 'invert';
    }
    override toString(): string {
      return `calc(1 / ${inner(this.value)})`;
    }
  }
  class CSSKeywordValue extends CSSStyleValue {
    _value: string;
    constructor(value: Any) {
      super();
      const v = String(value);
      if (!v) {
        throw new TypeError(
          "Failed to construct 'CSSKeywordValue': CSSKeywordValue does not support empty strings",
        );
      }
      this._value = v;
    }
    get value(): string {
      return this._value;
    }
    set value(v: Any) {
      this._value = String(v);
    }
    override toString(): string {
      return this._value;
    }
  }
  /** `CSS.px(10)` and its kin, a factory a unit (CSS Typed OM 1, 5.3). */
  const unitFactories: Record<string, (v: Any) => Any> = {};
  for (const unit of Object.keys(UNITS)) {
    if (unit === 'x') continue;
    const name =
      unit === 'q' ? 'Q' : unit === 'hz' ? 'Hz' : unit === 'khz' ? 'kHz' : unit;
    unitFactories[name] = (v: Any) => new CSSUnitValue(Number(v), unit);
  }
  const percentOf = (v: number): Any => new CSSUnitValue(v, 'percent');

  // --- easing functions (CSS Easing 2) ------------------------------------------

  /** An easing as a function of the input progress and the before flag. */
  type EasingFn = (p: number, before: boolean) => number;
  const LINEAR_EASING: EasingFn = (p) => p;
  /** A cubic Bézier through (0, 0) and (1, 1) with the two control points
   *  given, past the ends along the tangent there (CSS Easing 2, 3.2). */
  const bezierEasing =
    (x1: number, y1: number, x2: number, y2: number): EasingFn =>
    (p) => {
      if (p < 0) {
        const slope = x1 > 0 ? y1 / x1 : !y1 && x2 > 0 ? y2 / x2 : 0;
        return slope * p;
      }
      if (p > 1) {
        const slope =
          x2 < 1
            ? (y2 - 1) / (x2 - 1)
            : x2 === 1 && x1 < 1
              ? (y1 - 1) / (x1 - 1)
              : 0;
        return 1 + slope * (p - 1);
      }
      const cx = 3 * x1;
      const bx = 3 * (x2 - x1) - cx;
      const ax = 1 - cx - bx;
      const cy = 3 * y1;
      const by = 3 * (y2 - y1) - cy;
      const ay = 1 - cy - by;
      const x = (t: number) => ((ax * t + bx) * t + cx) * t;
      let t = p;
      for (let i = 0; i < 8; i += 1) {
        const err = x(t) - p;
        if (Math.abs(err) < 1e-7) break;
        const d = (3 * ax * t + 2 * bx) * t + cx;
        if (Math.abs(d) < 1e-6) break;
        t -= err / d;
      }
      if (!(Math.abs(x(t) - p) < 1e-7)) {
        let lo = 0;
        let hi = 1;
        t = p;
        while (lo < hi && hi - lo > 1e-9) {
          const v = x(t);
          if (Math.abs(v - p) < 1e-9) break;
          if (p > v) lo = t;
          else hi = t;
          t = (lo + hi) / 2;
        }
      }
      return ((ay * t + by) * t + cy) * t;
    };
  /** `steps()` (CSS Easing 2, 4.1). */
  const stepsEasing =
    (steps: number, position: string): EasingFn =>
    (p, before) => {
      const jumps =
        position === 'jump-both'
          ? steps + 1
          : position === 'jump-none'
            ? steps - 1
            : steps;
      let step = Math.floor(p * steps);
      if (position === 'jump-start' || position === 'jump-both') step += 1;
      if (before && Math.floor(p * steps) === p * steps) step -= 1;
      if (p >= 0 && step < 0) step = 0;
      if (p <= 1 && step > jumps) step = jumps;
      return step / jumps;
    };
  /** `linear()` of its control points, each its output and input
   *  (CSS Easing 2, 2.2), past the ends along the first and last two. */
  const pointsEasing =
    (points: [number, number][]): EasingFn =>
    (p) => {
      if (points.length === 1) return points[0][0];
      let i = 1;
      if (p >= points[0][1]) {
        while (i < points.length - 1 && points[i][1] < p) i += 1;
        if (p > points[i][1]) i = points.length - 1;
      }
      // an input that two points share takes the later one's output
      while (
        i < points.length - 1 &&
        points[i][1] === p &&
        points[i + 1][1] === p
      ) {
        i += 1;
      }
      const [o0, i0] = points[i - 1];
      const [o1, i1] = points[i];
      if (i1 === i0) return p < i0 ? o0 : o1;
      return o0 + ((o1 - o0) * (p - i0)) / (i1 - i0);
    };
  const EASING_KEYWORDS: Record<string, [number, number, number, number]> = {
    ease: [0.25, 0.1, 0.25, 1],
    'ease-in': [0.42, 0, 1, 1],
    'ease-out': [0, 0, 0.58, 1],
    'ease-in-out': [0.42, 0, 0.58, 1],
  };
  /**
   * An easing a page gives `animate()` or `updateTiming()`, its comments
   * and escapes read as CSS reads them, as it serializes and as a function
   * — or a TypeError where it is none (Web Animations 1, 6.5).
   */
  const easingOf = (given: Any): { css: string; fn: EasingFn } => {
    const fail = (): never => {
      throw new TypeError(`'${String(given)}' is not a valid value for easing`);
    };
    const text = String(given)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) =>
        String.fromCodePoint(parseInt(hex, 16)),
      )
      .replace(/\\(.)/g, '$1')
      .trim();
    const lower = text.toLowerCase();
    if (lower === 'linear') return { css: 'linear', fn: LINEAR_EASING };
    if (EASING_KEYWORDS[lower]) {
      return { css: lower, fn: bezierEasing(...EASING_KEYWORDS[lower]) };
    }
    if (lower === 'step-start') {
      return { css: 'steps(1, start)', fn: stepsEasing(1, 'jump-start') };
    }
    if (lower === 'step-end') {
      return { css: 'steps(1)', fn: stepsEasing(1, 'jump-end') };
    }
    const fn = /^([a-z-]+)\(([^()]*)\)$/.exec(lower);
    if (!fn) return fail();
    const args = fn[2].split(',').map((a) => a.trim());
    const num = (a: string): number => {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(a)) return fail();
      return Number(a);
    };
    if (fn[1] === 'cubic-bezier') {
      if (args.length !== 4) return fail();
      const [x1, y1, x2, y2] = args.map(num);
      if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return fail();
      return {
        css: `cubic-bezier(${[x1, y1, x2, y2].map(numberText).join(', ')})`,
        fn: bezierEasing(x1, y1, x2, y2),
      };
    }
    if (fn[1] === 'steps') {
      if (args.length < 1 || args.length > 2) return fail();
      if (!/^\+?\d+$/.test(args[0])) return fail();
      const n = Number(args[0]);
      const pos = args[1] ?? 'end';
      const position =
        pos === 'start' ? 'jump-start' : pos === 'end' ? 'jump-end' : pos;
      if (
        !['jump-start', 'jump-end', 'jump-none', 'jump-both'].includes(position)
      ) {
        return fail();
      }
      if (n < 1 || (position === 'jump-none' && n < 2)) return fail();
      const css =
        position === 'jump-end'
          ? `steps(${n})`
          : `steps(${n}, ${pos === 'start' ? 'start' : position})`;
      return { css, fn: stepsEasing(n, position) };
    }
    if (fn[1] === 'linear') {
      const stops: [number, number | null][] = [];
      for (const arg of args) {
        const parts = arg.split(/\s+/);
        if (!parts.length || parts.length > 3) return fail();
        const out = num(parts[0]);
        const ins = parts.slice(1).map((p) => {
          const m = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(p);
          return m ? Number(m[1]) / 100 : fail();
        });
        if (!ins.length) stops.push([out, null]);
        for (const at of ins) stops.push([out, at]);
      }
      if (stops.length < 2) return fail();
      if (stops[0][1] === null) stops[0][1] = 0;
      if (stops[stops.length - 1][1] === null) stops[stops.length - 1][1] = 1;
      // each input at least the one before it, and the ones with none
      // spread evenly between the two around them that have one
      let max = -Infinity;
      for (const stop of stops) {
        if (stop[1] !== null) stop[1] = max = Math.max(stop[1], max);
      }
      for (let i = 1; i < stops.length; i += 1) {
        if (stops[i][1] !== null) continue;
        let j = i;
        while (stops[j][1] === null) j += 1;
        const from = stops[i - 1][1]!;
        const to = stops[j][1]!;
        for (let k = i; k < j; k += 1) {
          stops[k][1] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
        }
      }
      const points = stops as [number, number][];
      return {
        css: `linear(${points.map(([o, i]) => `${numberText(o)} ${numberText(i * 100)}%`).join(', ')})`,
        fn: pointsEasing(points),
      };
    }
    return fail();
  };

  // --- animations (Web Animations 1 and 2) --------------------------------------

  /** An animation's `finish`, `cancel` and `remove`: times as its timeline
   *  gives them, a percentage for a scroll-driven one. */
  class AnimationPlaybackEvent extends Event {
    readonly currentTime: Any;
    readonly timelineTime: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this.currentTime = init.currentTime ?? null;
      this.timelineTime = init.timelineTime ?? null;
    }
  }

  const FILL_MODES = ['auto', 'none', 'forwards', 'backwards', 'both'];
  const PLAYBACK_DIRECTIONS = [
    'normal',
    'reverse',
    'alternate',
    'alternate-reverse',
  ];

  /**
   * An effect's timing, from what a page hands `animate()`, a
   * `KeyframeEffect` or `updateTiming()` laid over what it was: a number
   * alone is its duration, a member left out or `undefined` keeps its
   * value, and one out of range is a TypeError (Web Animations 1, 6.5.4,
   * "update the timing properties").
   */
  const timingOf = (given: Any, base: Any = null): Any => {
    const t = base
      ? { ...base }
      : {
          delay: 0,
          endDelay: 0,
          fill: 'auto',
          iterationStart: 0,
          iterations: 1,
          duration: 'auto',
          direction: 'normal',
          easing: 'linear',
        };
    let easing = base?._easing ?? LINEAR_EASING;
    const options =
      given === undefined || given === null
        ? {}
        : typeof given === 'object'
          ? given
          : { duration: given };
    const bad = (what: string): never => {
      throw new TypeError(`Failed to execute 'updateTiming': ${what}`);
    };
    if (options.delay !== undefined) {
      const v = Number(options.delay);
      if (!Number.isFinite(v)) bad('delay must be finite');
      t.delay = v;
    }
    if (options.endDelay !== undefined) {
      const v = Number(options.endDelay);
      if (!Number.isFinite(v)) bad('endDelay must be finite');
      t.endDelay = v;
    }
    if (options.fill !== undefined) {
      const v = String(options.fill);
      if (!FILL_MODES.includes(v)) bad(`'${v}' is not a valid fill`);
      t.fill = v;
    }
    if (options.iterationStart !== undefined) {
      const v = Number(options.iterationStart);
      if (!Number.isFinite(v) || v < 0) bad('iterationStart must be finite');
      t.iterationStart = v;
    }
    if (options.iterations !== undefined) {
      const v = Number(options.iterations);
      if (Number.isNaN(v) || v < 0) bad('iterations must be non-negative');
      t.iterations = v;
    }
    if (options.duration !== undefined) {
      const d = options.duration;
      if (typeof d === 'string' || d instanceof String) {
        if (String(d) !== 'auto') bad('duration must be a number or auto');
        t.duration = 'auto';
      } else {
        const v = Number(d);
        if (Number.isNaN(v) || v < 0) bad('duration must be non-negative');
        t.duration = v;
      }
    }
    if (options.direction !== undefined) {
      const v = String(options.direction);
      if (!PLAYBACK_DIRECTIONS.includes(v))
        bad(`'${v}' is not a valid direction`);
      t.direction = v;
    }
    if (options.easing !== undefined) {
      const e = easingOf(options.easing);
      t.easing = e.css;
      easing = e.fn;
    }
    Object.defineProperty(t, '_easing', {
      value: easing,
      enumerable: false,
      writable: true,
    });
    return t;
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
        offset: keyframeOffsetOf(frame?.offset),
      }));
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
      listOf(given.offset)
        .map(keyframeOffsetOf)
        .forEach((o, i) => {
          if (frames[i]) frames[i].offset = o;
        });
      const easings = listOf(given.easing);
      const composites = listOf(given.composite);
      frames.forEach((frame, i) => {
        if (easings.length) frame.easing = easings[i % easings.length];
        if (i < composites.length) frame.composite = composites[i];
      });
    }
    // a property's value is a string, whatever it was given as
    for (const frame of frames) {
      for (const name of Object.keys(frame)) {
        const value = frame[name];
        if (keyframeProperty(name) !== null && value !== undefined) {
          frame[name] = String(value);
        }
      }
    }
    let last = -Infinity;
    for (const { offset } of frames) {
      if (offset === null || typeof offset === 'object') continue;
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
    // a frame at a timeline offset is placed by the timeline, and the
    // others are spaced as though it were not there (Scroll-driven
    // Animations 1, 4.4)
    const spaced = frames.filter(
      (f) => f.offset === null || typeof f.offset === 'number',
    );
    const offsets: (number | null)[] = spaced.map((f) => f.offset);
    const n = spaced.length;
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
    const computed = new Map<Any, number | null>(
      spaced.map((f, i) => [f, offsets[i]]),
    );
    return frames.map((frame) => ({
      ...frame,
      offset: frame.offset,
      easing: String(frame.easing ?? 'linear'),
      composite: String(frame.composite ?? 'auto'),
      computedOffset: computed.has(frame) ? computed.get(frame) : null,
    }));
  };

  /**
   * A keyframe's `offset` as a page gives it: null, a number, a number or a
   * percentage as text, or a timeline offset — a `TimelineRangeOffset`, or
   * a range's name and a percentage as text, `"contain 25%"` — kept as
   * `{ rangeName, offset }` (Scroll-driven Animations 1, 4.4). Anything
   * else throws, as a name that is no range's and a length do.
   */
  const keyframeOffsetOf = (given: Any): Any => {
    if (given === null || given === undefined) return null;
    const bad = (): never => {
      throw new TypeError(
        "Failed to execute 'animate' on 'Element': Invalid keyframe offset.",
      );
    };
    const timelineOffset = (name: string, offset: Any): Any => {
      if (!RANGE_NAMES.includes(name)) bad();
      const value = offset === undefined ? percentOf(0) : offset;
      if (
        !(value instanceof CSSNumericValue) ||
        !value.type().percent ||
        Object.keys(value.type()).some(
          (k) => k !== 'percent' && k !== 'percentHint' && value.type()[k],
        )
      ) {
        bad();
      }
      return { rangeName: name, offset: value };
    };
    if (typeof given === 'object' && !(given instanceof String)) {
      if (given instanceof CSSNumericValue) {
        if (given instanceof CSSUnitValue && given.unit === 'number') {
          return given.value;
        }
        return given.to('percent').value / 100;
      }
      if ('rangeName' in given) {
        return timelineOffset(String(given.rangeName), given.offset);
      }
      return Number(given);
    }
    if (typeof given !== 'string' && !(given instanceof String)) {
      return Number(given);
    }
    const text = String(given).trim();
    const named = /^([a-z-]+)\s+(.+)$/i.exec(text);
    if (named) {
      let value: Any;
      try {
        value = CSSNumericValue.parse(named[2]);
      } catch {
        bad();
      }
      return timelineOffset(named[1].toLowerCase(), value);
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
      return Number(text);
    }
    let value: Any;
    try {
      value = CSSNumericValue.parse(text);
    } catch {
      bad();
    }
    try {
      return value.to('percent').value / 100;
    } catch {
      return bad();
    }
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

  /** Where an effect's timing puts it at its animation's current time
   *  (Web Animations 1, 4.8 to 4.11, with 2's timeline boundary). */
  interface EffectState {
    local: number | null;
    phase: 'before' | 'active' | 'after' | null;
    active: number | null;
    progress: number | null;
    iteration: number | null;
    /** Whether the timeline's boundary put a time on the active phase's
     *  edge in it, where it would otherwise be after or before it. */
    boundary: boolean;
  }

  /** What an animation animates: its target, its keyframes and its timing
   *  (`KeyframeEffect`). `<Html>` draws it, from what the host is told of
   *  it (`Animation._report`). */
  class AnimationEffect {
    _timing: Any = timingOf(undefined);
    _animation: Any = null;
    getTiming(): Any {
      const t = this._timing;
      return {
        delay: t.delay,
        endDelay: t.endDelay,
        fill: t.fill,
        iterationStart: t.iterationStart,
        iterations: t.iterations,
        duration: t.duration,
        direction: t.direction,
        easing: t.easing,
      };
    }
    updateTiming(timing?: Any): void {
      if (
        timing !== undefined &&
        timing !== null &&
        typeof timing !== 'object'
      ) {
        throw new TypeError(
          "Failed to execute 'updateTiming' on 'AnimationEffect': The provided value is not of type 'OptionalEffectTiming'.",
        );
      }
      const next = timingOf(timing ?? {}, this._timing);
      // a progress-based timeline is finite, and so is what runs on it
      // (Web Animations 2, 6.5.4)
      if (next.iterations === Infinity && this._animation?._finite()) {
        throw new TypeError(
          "Failed to execute 'updateTiming' on 'AnimationEffect': Effect iterations cannot be Infinity when used with a ScrollTimeline",
        );
      }
      this._timing = next;
      this._animation?._effectChanged();
    }
    /**
     * The timing as it runs: on a progress-based timeline, every time a
     * proportion of the timeline's span, an `auto` duration filling it
     * (Web Animations 2, 4.2, "normalize specified timing"); elsewhere as
     * given, an `auto` duration 0.
     */
    _norm(): Any {
      const t = this._timing;
      const base = {
        delay: t.delay,
        endDelay: t.endDelay,
        fill: t.fill,
        iterationStart: t.iterationStart,
        iterations: t.iterations,
        duration: t.duration === 'auto' ? 0 : t.duration,
        direction: t.direction,
        easing: t.easing,
        ease: t._easing,
        progressBased: false,
      };
      const span = this._animation?._span() ?? null;
      if (span === null) return base;
      base.progressBased = true;
      // an infinite duration fills the span as `auto` does
      if (t.duration === 'auto' || t.duration === Infinity) {
        base.delay = 0;
        base.endDelay = 0;
        base.duration =
          t.iterations > 0 && t.iterations !== Infinity
            ? span / t.iterations
            : 0;
        return base;
      }
      const total = Math.max(
        t.delay + repeated(t.duration, t.iterations) + t.endDelay,
        0,
      );
      if (!(total > 0) || total === Infinity) {
        base.delay = 0;
        base.endDelay = 0;
        base.duration = 0;
        return base;
      }
      const k = span / total;
      base.delay = t.delay * k;
      base.endDelay = t.endDelay * k;
      base.duration = t.duration * k;
      return base;
    }
    /** Where the effect ends, in its animation's time. */
    _end(): number {
      const n = this._norm();
      return Math.max(
        n.delay + repeated(n.duration, n.iterations) + n.endDelay,
        0,
      );
    }
    /** Where it is at its animation's current time. */
    _state(): EffectState {
      const n = this._norm();
      const animation = this._animation;
      const local: number | null = animation ? animation._cur() : null;
      const none: EffectState = {
        local,
        phase: null,
        active: null,
        progress: null,
        iteration: null,
        boundary: false,
      };
      if (local === null) return none;
      const activeDuration = repeated(n.duration, n.iterations);
      const end = Math.max(n.delay + activeDuration + n.endDelay, 0);
      const beforeActive = Math.max(Math.min(n.delay, end), 0);
      const activeAfter = Math.max(Math.min(n.delay + activeDuration, end), 0);
      const backwards = animation._rate < 0;
      const atBoundary = animation._atBoundary();
      let phase: 'before' | 'active' | 'after';
      let boundary = false;
      if (local < beforeActive || (backwards && local === beforeActive)) {
        phase = 'before';
        if (local === beforeActive && atBoundary) {
          phase = 'active';
          boundary = true;
        }
      } else if (local > activeAfter || (!backwards && local === activeAfter)) {
        phase = 'after';
        if (local === activeAfter && atBoundary) {
          phase = 'active';
          boundary = true;
        }
      } else phase = 'active';
      const fill = n.fill === 'auto' ? 'none' : n.fill;
      let active: number | null;
      if (phase === 'before') {
        active =
          fill === 'backwards' || fill === 'both'
            ? Math.max(local - n.delay, 0)
            : null;
      } else if (phase === 'active') {
        active = local - n.delay;
      } else {
        active =
          fill === 'forwards' || fill === 'both'
            ? Math.max(Math.min(local - n.delay, activeDuration), 0)
            : null;
      }
      if (active === null) return { ...none, phase, boundary };
      let overall =
        n.duration === 0
          ? phase === 'before'
            ? 0
            : n.iterations
          : active / n.duration;
      overall += n.iterationStart;
      let simple = overall === Infinity ? n.iterationStart % 1 : overall % 1;
      if (
        simple === 0 &&
        (phase === 'active' || phase === 'after') &&
        active === activeDuration &&
        n.iterations !== 0
      ) {
        simple = 1;
      }
      const iteration =
        phase === 'after' && n.iterations === Infinity
          ? Infinity
          : simple === 1
            ? Math.floor(overall) - 1
            : Math.floor(overall);
      let forwards = n.direction === 'normal';
      if (n.direction === 'alternate' || n.direction === 'alternate-reverse') {
        const d =
          n.direction === 'alternate-reverse' ? iteration + 1 : iteration;
        forwards = d === Infinity || d % 2 === 0;
      }
      const directed = forwards ? simple : 1 - simple;
      const before =
        (phase === 'before' && forwards) || (phase === 'after' && !forwards);
      return {
        local,
        phase,
        active,
        progress: n.ease(directed, before),
        iteration,
        boundary,
      };
    }
    /** Its computed timing (Web Animations 1, 6.6), its times percentages
     *  where its timeline is progress-based (Web Animations 2, 6.6). */
    getComputedTiming(): Any {
      const t = this._timing;
      const n = this._norm();
      const s = this._state();
      const time = (v: number | null): Any =>
        v === null ? null : n.progressBased ? percentOf(v) : v;
      const activeDuration = repeated(n.duration, n.iterations);
      return {
        // a top-level effect starts at its animation's 0 (Web Animations
        // 2, 6.6, `startTime`)
        startTime: time(0),
        delay: t.delay,
        endDelay: t.endDelay,
        fill: t.fill === 'auto' ? 'none' : t.fill,
        iterationStart: t.iterationStart,
        iterations: t.iterations,
        duration: time(n.duration),
        direction: t.direction,
        easing: t.easing,
        activeDuration: time(activeDuration),
        endTime: time(Math.max(n.delay + activeDuration + n.endDelay, 0)),
        localTime: time(s.local),
        progress: s.progress,
        currentIteration: s.iteration,
      };
    }
  }
  /** An iteration's duration repeated, 0 where either is 0 (Web
   *  Animations 2, 4.6.2), which `0 * Infinity` is not. */
  const repeated = (duration: number, iterations: number): number =>
    duration === 0 || iterations === 0 ? 0 : duration * iterations;

  /**
   * A view transition's pseudo-element as `<Html>` keys its style, from
   * the way a page writes it — `::view-transition-group( first`, its
   * argument trimmed and its parenthesis closed, as CSS reads it — or null
   * for none of them (CSS View Transitions 1, 3.2).
   */
  const transitionPseudoKey = (pseudo: string): string | null => {
    const m =
      /^::view-transition(?:-(group|image-pair|old|new)\(\s*([^()\s]+)\s*\)?)?$/i.exec(
        pseudo,
      );
    if (!m) return null;
    return m[1]
      ? `view-transition-${m[1].toLowerCase()}(${m[2]})`
      : 'view-transition';
  };

  /**
   * A CSS animation's effect's keyframes (CSS Animations 2, 4.3), as the
   * host reads them from its `@keyframes` — and from what its element has
   * where the rule has no frame at either end — each property by the name
   * a script reads it by.
   */
  const cssKeyframes = (effect: Any): Any[] => {
    const target = effect._target;
    if (!(target instanceof Element)) return [];
    const raw = str(
      call('cssKeyframes', target._id, effect._css.pseudo, effect._css.name),
    );
    if (!raw) return [];
    return (JSON.parse(raw) as Any[]).map((frame) => {
      const out: Any = {
        offset: frame.offset,
        computedOffset: frame.offset,
        easing: frame.easing,
        composite: frame.composite,
      };
      for (const [prop, value] of Object.entries(frame.values)) {
        const name = prop.startsWith('--')
          ? prop
          : prop === 'float'
            ? 'cssFloat'
            : prop === 'offset'
              ? 'cssOffset'
              : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        out[name] = value;
      }
      return out;
    });
  };

  class KeyframeEffect extends AnimationEffect {
    _target: Any;
    _pseudo: string | null;
    composite = 'replace';
    iterationComposite = 'replace';
    _frames: Any[];
    /** Its pseudo-element and frames as the host is told them, made
     *  again where they change; '' where `<Html>` draws none of it. */
    _framesJson: string | null = null;
    constructor(target: Any, keyframes?: Any, options?: Any) {
      super();
      if (target instanceof KeyframeEffect) {
        this._target = target.target;
        this._pseudo = target.pseudoElement;
        this._frames = target._frames.map((f: Any) => ({ ...f }));
        this._timing = timingOf({}, target._timing);
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
      this._animation?._changed();
    }
    get pseudoElement(): string | null {
      return this._pseudo;
    }
    set pseudoElement(pseudo: Any) {
      this._pseudo = pseudo === null ? null : String(pseudo);
      this._framesJson = null;
      this._animation?._changed();
    }
    /** The CSS animation it is of, where it is one's: its name and its
     *  pseudo-element's key, by which the host answers its keyframes. */
    _css: { name: string; pseudo: string } | null = null;
    getKeyframes(): Any[] {
      if (this._css) return cssKeyframes(this);
      return this._frames.map((f) =>
        f.offset !== null && typeof f.offset === 'object'
          ? {
              ...f,
              offset: {
                rangeName: f.offset.rangeName,
                offset: f.offset.offset,
              },
              computedOffset: this._timelineOffset(f.offset),
            }
          : { ...f },
      );
    }
    /**
     * Where a frame at a timeline offset is in the effect's iteration: how
     * far its place on the view timeline is through the animation's range
     * (Scroll-driven Animations 1, 4.4) — outside 0 to 1 where it is
     * outside the range — and null where the timeline cannot place it: no
     * view timeline, or one with nothing to view.
     */
    _timelineOffset(offset: Any): number | null {
      const a = this._animation;
      const tl = a?._timeline;
      if (!(tl instanceof ViewTimeline) || tl._time() === null) return null;
      const [from, to] = a._range();
      if (!(to - from > 0)) return null;
      const at = tl._rangeAt(
        { name: offset.rangeName, offset: offset.offset },
        false,
      );
      return (at - from) / (to - from);
    }
    setKeyframes(keyframes: Any): void {
      this._frames = keyframesOf(keyframes);
      this._framesJson = null;
      this._animation?._changed();
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
     * values by their CSS names, and its timing as it runs (`_norm`), a
     * percentage where its timeline is progress-based, and an infinite
     * count null. Null for a pseudo-element that is neither `::before` nor
     * `::after`, which `<Html>` draws no animation of. `fill` is the one
     * the host is to draw it with, which a timeline's boundary may make
     * `both` (`EffectState.boundary`).
     */
    _hostEffect(n: Any, fill: string): string | null {
      if (this._framesJson === null) {
        const p = this._pseudo;
        const pseudo =
          p === null
            ? ''
            : p === '::before' || p === ':before'
              ? 'before'
              : p === '::after' || p === ':after'
                ? 'after'
                : transitionPseudoKey(p);
        if (pseudo === null) this._framesJson = '';
        else {
          // in the order of their computed offsets, a frame the
          // timeline cannot place left out (Web Animations 1, 6.6.2)
          const frames = this._frames
            .map((frame) => {
              const props: [string, string][] = [];
              for (const [name, value] of Object.entries(frame)) {
                const prop = keyframeProperty(name);
                if (prop === null || value === null || value === undefined) {
                  continue;
                }
                props.push([prop, String(value)]);
              }
              const at =
                frame.offset !== null && typeof frame.offset === 'object'
                  ? this._timelineOffset(frame.offset)
                  : frame.computedOffset;
              return [at, String(frame.easing), props];
            })
            .filter((frame) => frame[0] !== null)
            .sort((x, y) => (x[0] as number) - (y[0] as number));
          this._framesJson = `${JSON.stringify(pseudo)},${JSON.stringify(frames)}`;
        }
      }
      const json = this._framesJson;
      // a frame placed by the timeline is placed again each time
      if (
        this._frames.some(
          (f) => f.offset !== null && typeof f.offset === 'object',
        )
      ) {
        this._framesJson = null;
      }
      if (!json) return null;
      const timing = [
        n.delay,
        n.endDelay,
        fill,
        n.iterationStart,
        n.iterations === Infinity ? null : n.iterations,
        n.duration,
        n.direction,
        n.easing,
      ];
      return `[${json},${JSON.stringify(timing)}]`;
    }
  }

  // --- timelines ---------------------------------------------------------------

  /** A scroll container's offsets, how far it scrolls and its scrollport,
   *  and where its content's origin is in the document, in CSS pixels; the
   *  viewport's for the root. Null for an element that scrolls nothing or
   *  has no box. */
  interface ScrollGeometry {
    x: number;
    y: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    originX: number;
    originY: number;
  }
  const scrollGeometry = (el: Any): ScrollGeometry | null => {
    if (!el || !el.isConnected) return null;
    if (el === document.scrollingElement || el === document.documentElement) {
      const v = viewport();
      const width = el.scrollWidth;
      const height = el.scrollHeight;
      return {
        x: v.scrollX,
        y: v.scrollY,
        maxX: Math.max(0, width - v.width),
        maxY: Math.max(0, height - v.height),
        width: v.width,
        height: v.height,
        originX: 0,
        originY: 0,
      };
    }
    const s = scrollStateOf(el);
    const r = s && docRect(el);
    if (!s || !r) return null;
    const [
      x,
      y,
      width,
      height,
      clientWidth,
      clientHeight,
      clientTop,
      clientLeft,
    ] = s;
    return {
      x,
      y,
      maxX: Math.max(0, width - clientWidth),
      maxY: Math.max(0, height - clientHeight),
      width: clientWidth,
      height: clientHeight,
      originX: r[0] + clientLeft - x,
      originY: r[1] + clientTop - y,
    };
  };

  const RANGE_NAMES = [
    'cover',
    'contain',
    'entry',
    'exit',
    'entry-crossing',
    'exit-crossing',
    'scroll',
  ];
  /** An attachment range's end: `normal`, or a named range — or the whole
   *  timeline where it names none — and an offset into it. */
  type RangeEdge = 'normal' | { name: string | null; offset: Any };
  /** A range's offset, which only percentages and absolute lengths can be
   *  from script (Scroll Animations 1, 5.4): a font's size or a viewport's
   *  is a TypeError. */
  const rangeOffset = (v: Any): Any => {
    if (!(v instanceof CSSNumericValue)) {
      throw new TypeError("The offset is not a 'CSSNumericValue'.");
    }
    // an absolute length is kept in pixels, as a range reads it back
    if (
      v instanceof CSSUnitValue &&
      v.unit !== 'percent' &&
      v.unit !== 'px' &&
      UNITS[v.unit][0] === 'length' &&
      UNITS[v.unit][1] !== null
    ) {
      return v.to('px');
    }
    const ok = (x: Any): boolean =>
      x instanceof CSSUnitValue
        ? x.unit === 'percent' ||
          (UNITS[x.unit][0] === 'length' && UNITS[x.unit][1] !== null)
        : x instanceof CSSMathSum
          ? x.values._items.every(ok)
          : x instanceof CSSMathNegate
            ? ok(x.value)
            : false;
    if (!ok(v)) {
      throw new TypeError(
        'A timeline range offset must be a percentage or an absolute length.',
      );
    }
    return v;
  };
  /** What a page sets `rangeStart` or `rangeEnd` to, or hands `animate()`
   *  as one: a string, a `TimelineRangeOffset` or a `CSSNumericValue`. */
  const rangeEdgeOf = (given: Any, end: boolean): RangeEdge => {
    const fallback = percentOf(end ? 100 : 0);
    if (given instanceof CSSNumericValue) {
      return { name: null, offset: rangeOffset(given) };
    }
    if (given && typeof given === 'object') {
      const name =
        given.rangeName === undefined || given.rangeName === null
          ? null
          : String(given.rangeName);
      if (name !== null && name !== 'none' && !RANGE_NAMES.includes(name)) {
        throw new TypeError(`'${name}' is not a timeline range name.`);
      }
      return {
        name: name === 'none' ? null : name,
        offset:
          given.offset === undefined ? fallback : rangeOffset(given.offset),
      };
    }
    const text = String(given).trim();
    if (text === 'normal') return 'normal';
    const m = /^([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(text);
    const name = m && RANGE_NAMES.includes(m[1].toLowerCase()) ? m[1] : null;
    const rest = name ? (m![2] ?? '').trim() : text;
    let offset = fallback;
    if (rest) {
      try {
        offset = CSSNumericValue.parse(rest);
      } catch {
        throw new TypeError(`'${text}' is not a timeline range.`);
      }
      offset = rangeOffset(offset);
    }
    return { name: name ? name.toLowerCase() : null, offset };
  };
  /** An offset in pixels, its percentages of `basis`. */
  const offsetPx = (v: Any, basis: number): number => {
    if (v instanceof CSSUnitValue) {
      return v.unit === 'percent' ? (v.value / 100) * basis : v.to('px').value;
    }
    if (v instanceof CSSMathSum) {
      return v.values._items.reduce(
        (sum: number, x: Any) => sum + offsetPx(x, basis),
        0,
      );
    }
    if (v instanceof CSSMathNegate) return -offsetPx(v.value, basis);
    return 0;
  };

  /** Which task the page is in: each call the host makes into it is one
   *  (`entry`), and the microtasks it queued run inside it. */
  let taskEpoch = 0;
  let taskTime = 0;
  let taskTimeEpoch = -1;
  /** The clock as the document's timeline reads it: once a task, as a
   *  browser updates it once a frame, so a page that reads it twice in a
   *  task reads one time — WPT's `waitForNextFrame` asks for frames until
   *  it moves. */
  const taskNow = (): number => {
    if (taskTimeEpoch !== taskEpoch) {
      taskTime = now();
      taskTimeEpoch = taskEpoch;
    }
    return taskTime;
  };

  /** A timeline (Web Animations 1, 4.1): its time, which the document's is
   *  the page's clock and a scroll timeline's a proportion of a scroll. */
  class AnimationTimeline {
    _monotonic = true;
    constructor() {
      if (new.target === AnimationTimeline) {
        throw new TypeError(
          "Failed to construct 'AnimationTimeline': Illegal constructor",
        );
      }
    }
    get currentTime(): Any {
      return this._time();
    }
    get duration(): Any {
      return null;
    }
    /** Its time as the model computes with it, null while inactive. */
    _time(): number | null {
      return taskNow();
    }
    /** Where an attachment range's end is, in its time. */
    _rangeAt(_edge: RangeEdge, end: boolean): number {
      return end ? 100 : 0;
    }
    /** Whether its time is the least or the most it can be (Web
     *  Animations 2, "at timeline boundary"): a scroll at either end. */
    _atEdge(): boolean {
      return false;
    }
  }
  class DocumentTimeline extends AnimationTimeline {
    _origin: number;
    constructor(options: Any = {}) {
      super();
      this._origin = Number(options?.originTime ?? 0);
    }
    override _time(): number | null {
      return taskNow() - this._origin;
    }
  }
  const documentTimeline = new DocumentTimeline();

  const SCROLL_AXES = ['block', 'inline', 'x', 'y'];
  /** A subject with no box's `scroll-padding` and sticky reach. */
  const NO_ADJUST = [0, 0, 0, 0, 0];
  const holdTimeline = (timeline: Any): void => {
    heldTimelines.add(
      RealWeakRef ? new RealWeakRef(timeline) : { deref: () => timeline },
    );
    // measured again at the next frame, which a timeline made before the
    // document is laid out is waiting for
    wantFrame();
  };
  /** A frame: each timeline's time as its scroll is now (Scroll-driven
   *  Animations 1, 6.1, "update the rendering"). */
  const snapTimelines = (): void => {
    for (const held of [...heldTimelines]) {
      const timeline = held.deref();
      if (timeline) timeline._snap();
      else heldTimelines.delete(held);
    }
  };
  /**
   * A scroll progress timeline (Scroll Animations 1, 2.3): its time is how
   * far its source is scrolled along its axis, a percentage, and it is
   * inactive where the source scrolls nothing that way. Read as it is
   * asked, so a page that scrolls and then asks has the new time.
   */
  class ScrollTimeline extends AnimationTimeline {
    _source: Any;
    _axis: string;
    constructor(options: Any = {}) {
      super();
      this._monotonic = false;
      const o = options ?? {};
      const axis = o.axis === undefined ? 'block' : String(o.axis);
      if (!SCROLL_AXES.includes(axis)) {
        throw new TypeError(
          `Failed to construct 'ScrollTimeline': The provided value '${axis}' is not a valid enum value of type ScrollAxis.`,
        );
      }
      this._axis = axis;
      if (o.source !== undefined && o.source !== null) {
        if (!(o.source instanceof Element)) {
          throw new TypeError(
            "Failed to construct 'ScrollTimeline': Failed to read the 'source' property from 'ScrollTimelineOptions': Failed to convert value to 'Element'.",
          );
        }
      }
      this._source =
        o.source === undefined ? document.scrollingElement : o.source;
      holdTimeline(this);
      // as its scroll is now, until the next frame; a view timeline's once
      // it has its subject
      if (!(this instanceof ViewTimeline)) this._snap();
    }
    /** What its time is worked out from — its source's scroll, or its
     *  subject's place in it — as it was at the last frame, or as it was
     *  made (Scroll-driven Animations 1, 6.1): a page that scrolls, or
     *  changes what its source holds, reads the time it had until the
     *  next frame, as the document draws it. */
    _snapped: Any = undefined;
    _snap(): void {
      this._snapped = this._measure();
    }
    _measure(): Any {
      return scrollGeometry(this.source);
    }
    _snapshot(): Any {
      if (this._snapped === undefined) this._snap();
      return this._snapped;
    }
    get source(): Any {
      return this._source;
    }
    get axis(): string {
      return this._axis;
    }
    override get currentTime(): Any {
      const t = this._time();
      return t === null ? null : percentOf(t);
    }
    override get duration(): Any {
      return percentOf(100);
    }
    /** Whether its axis is the vertical one. */
    _vertical(): boolean {
      return this._axis === 'y' || this._axis === 'block';
    }
    override _time(): number | null {
      const g: ScrollGeometry | null = this._snapshot();
      if (!g) return null;
      const max = this._vertical() ? g.maxY : g.maxX;
      if (!(max > 0)) return null;
      const at = Math.abs(this._vertical() ? g.y : g.x);
      return (at / max) * 100;
    }
    override _atEdge(): boolean {
      const g: ScrollGeometry | null = this._snapshot();
      if (!g) return false;
      const at = Math.abs(this._vertical() ? g.y : g.x);
      const max = this._vertical() ? g.maxY : g.maxX;
      return at <= 0 || at >= max;
    }
    override _rangeAt(edge: RangeEdge, end: boolean): number {
      if (edge === 'normal') return end ? 100 : 0;
      const g: ScrollGeometry | null = this._snapshot();
      const max = g ? (this._vertical() ? g.maxY : g.maxX) : 0;
      if (!(max > 0)) return end ? 100 : 0;
      return (offsetPx(edge.offset, max) / max) * 100;
    }
  }

  /**
   * A view progress timeline (Scroll Animations 1, 3.3): how far its
   * subject has crossed the scrollport of the scroll container nearest
   * it, from the scroll at which its start edge meets the scrollport's
   * end, 0%, to the one at which its end edge meets the start, 100% — the
   * `cover` range — the scrollport less its insets.
   */
  class ViewTimeline extends ScrollTimeline {
    _subject: Any;
    _inset: [Any, Any];
    constructor(options: Any) {
      if (!options || typeof options !== 'object') {
        throw new TypeError(
          "Failed to construct 'ViewTimeline': 1 argument required.",
        );
      }
      if (!(options.subject instanceof Element)) {
        throw new TypeError(
          "Failed to construct 'ViewTimeline': Failed to read the 'subject' property from 'ViewTimelineOptions': Required member is undefined.",
        );
      }
      super({ source: null, axis: options.axis });
      this._subject = options.subject;
      this._inset = insetOf(options.inset);
      this._snap();
    }
    get subject(): Any {
      return this._subject;
    }
    /** The nearest scroll container around the subject, or the viewport's
     *  scrolling element. */
    override get source(): Any {
      let el = this._subject?.parentElement ?? null;
      while (el) {
        if (el === document.documentElement) return document.scrollingElement;
        if (scrollStateOf(el)) return el;
        el = el.parentElement;
      }
      return this._subject?.isConnected ? document.scrollingElement : null;
    }
    get startOffset(): Any {
      const v = this._view();
      return unitFactories.px(v ? v.cover[0] : 0);
    }
    get endOffset(): Any {
      const v = this._view();
      return unitFactories.px(v ? v.cover[1] : 0);
    }
    /** The scroll offsets of each of its named ranges, and where the
     *  source is scrolled to, as of the last frame (`_snapshot`). */
    _view(): {
      at: number;
      max: number;
      cover: [number, number];
      ranges: (name: string) => [number, number];
    } | null {
      return this._snapshot();
    }
    override _measure(): Any {
      const source = this.source;
      const g = scrollGeometry(source);
      const r = docRect(this._subject);
      if (!g || !r) return null;
      const vertical = this._vertical();
      // the scroll container's `scroll-padding`, which an `auto` inset is,
      // and how far sticky positioning has moved the subject and can each
      // way, which the range takes in (the document's `_viewPlace`)
      const raw = call('viewAdjust', this._subject._id, vertical);
      const [padStart, padEnd, shift, up, down] =
        typeof raw === 'string' && raw ? raw.split(',').map(Number) : NO_ADJUST;
      const port = vertical ? g.height : g.width;
      const start =
        (vertical ? r[1] - g.originY : r[0] - g.originX) - shift + 0;
      const size = vertical ? r[3] : r[2];
      const inset = (v: Any, pad: number) =>
        v === 'auto' ? pad : offsetPx(v, port);
      const viewStart = inset(this._inset[0], padStart);
      const viewEnd = port - inset(this._inset[1], padEnd);
      // its edges where a sticky box holds it back as it enters, and
      // carries it on as it leaves
      const s0 = start - up;
      const s1 = start + size - up;
      const e0 = start + down;
      const e1 = start + size + down;
      const cover: [number, number] = [s0 - viewEnd, e1 - viewStart];
      const a = s1 - viewEnd;
      const b = e0 - viewStart;
      const contain: [number, number] = [Math.min(a, b), Math.max(a, b)];
      const max = vertical ? g.maxY : g.maxX;
      return {
        at: Math.abs(vertical ? g.y : g.x),
        max,
        cover,
        ranges: (name: string): [number, number] =>
          name === 'contain'
            ? contain
            : name === 'entry'
              ? [cover[0], contain[0]]
              : name === 'exit'
                ? [contain[1], cover[1]]
                : name === 'entry-crossing'
                  ? [s0 - viewEnd, s1 - viewEnd]
                  : name === 'exit-crossing'
                    ? [e0 - viewStart, e1 - viewStart]
                    : name === 'scroll'
                      ? [0, max]
                      : cover,
      };
    }
    override _time(): number | null {
      const v = this._view();
      if (!v || !(v.max > 0)) return null;
      const [from, to] = v.cover;
      if (!(to - from > 0)) return null;
      return ((v.at - from) / (to - from)) * 100;
    }
    override _rangeAt(edge: RangeEdge, end: boolean): number {
      if (edge === 'normal') return end ? 100 : 0;
      const v = this._view();
      if (!v) return end ? 100 : 0;
      const [from, to] = v.cover;
      if (!(to - from > 0)) return end ? 100 : 0;
      const [a, b] = v.ranges(edge.name ?? 'cover');
      const at = a + offsetPx(edge.offset, b - a);
      return ((at - from) / (to - from)) * 100;
    }
  }
  /** An interface's attributes as Web IDL has them (3.7.6): enumerable,
   *  and a getter and a setter that throw for what is no instance of it,
   *  its own prototype among them. */
  const idlAttributes = (Interface: Any): void => {
    const proto = Interface.prototype;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key.startsWith('_')) continue;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d?.get) continue;
      const get = d.get;
      const checked = function (this: Any): Any {
        if (!(this instanceof Interface)) {
          throw new TypeError('Illegal invocation');
        }
        return get.call(this);
      };
      Object.defineProperty(checked, 'name', { value: `get ${key}` });
      let set = d.set;
      if (set) {
        const own = set;
        set = function (this: Any, v: Any): void {
          if (!(this instanceof Interface)) {
            throw new TypeError('Illegal invocation');
          }
          own.call(this, v);
        };
        Object.defineProperty(set, 'name', { value: `set ${key}` });
      }
      Object.defineProperty(proto, key, {
        ...d,
        enumerable: true,
        get: checked,
        set,
      });
    }
  };
  idlAttributes(ScrollTimeline);
  idlAttributes(ViewTimeline);
  /** A view timeline's insets, from a string of one or two
   *  `<length-percentage>` or `auto`, or a list of one or two values
   *  (Scroll Animations 1, 3.3), `auto` where none is given. `auto` is the
   *  scroll container's `scroll-padding` on that side, which the subject's
   *  place is measured with (`_measure`). */
  const insetOf = (given: Any): [Any, Any] => {
    const one = (v: Any): Any => {
      if (v instanceof CSSKeywordValue) {
        if (v.value !== 'auto') {
          throw new TypeError(`'${v.value}' is not a valid inset.`);
        }
        return 'auto';
      }
      if (v instanceof CSSNumericValue) return rangeOffset(v);
      const text = String(v).trim();
      if (text === 'auto') return 'auto';
      try {
        return rangeOffset(CSSNumericValue.parse(text));
      } catch {
        throw new TypeError(`'${text}' is not a valid inset.`);
      }
    };
    if (given === undefined) return ['auto', 'auto'];
    let parts: Any[];
    if (typeof given === 'string') {
      parts = given.trim().split(/\s+(?![^(]*\))/);
    } else if (given && typeof given[Symbol.iterator] === 'function') {
      parts = [...given];
    } else parts = [given];
    if (!parts.length || parts.length > 2) {
      throw new TypeError('An inset is one or two values.');
    }
    const values = parts.map(one);
    return [values[0], values[1] ?? values[0]];
  };

  // --- the frame -----------------------------------------------------------------
  //
  // HTML's "update the rendering", as far as script sees it: the resize
  // steps, the scroll steps and the media queries' changes of each document
  // this realm runs, the page's and its frames' (`renderingSteps`); the
  // animations on a scroll-driven timeline brought up to date — their
  // times, their auto-aligned start times, their pending tasks, their
  // finished state — then the animation frame callbacks of each document,
  // in tree order, at one time, and after them the intersection observers'
  // steps (`updateIntersections`). A frame comes every 16 ms while a
  // callback waits or a scroll-driven animation is under way, and every 100
  // ms once none of those has moved for half a second; and where the host
  // says a viewport moved, or what an observer measures (`__rendering`).

  const frameCallbacks = new Map<number, Any>();
  let frameSeq = 0;
  let frameTimer = 0;
  let quietFrames = 0;
  /** Whether the host said a viewport moved since the last frame, which
   *  the next one comes for (`__rendering`). */
  let renderingOwed = false;
  /** Animations whose timeline is a scroll's, which a frame updates. */
  const scrollLinked = new Set<Any>();
  const wantFrame = (): void => {
    if (!frameTimer) frameTimer = setTimer(runFrame, 16, [], false);
  };
  /** What runs at the end of the next frame, after its callbacks: a view
   *  transition's "handle transition frame" (CSS View Transitions 1, 7.9),
   *  which an animation a callback made keeps going. */
  const afterFrame = new Set<() => void>();
  const afterNextFrame = (fn: () => void): void => {
    afterFrame.add(fn);
    wantFrame();
  };
  const runAfterFrame = (): void => {
    if (!afterFrame.size) return;
    const fns = [...afterFrame];
    afterFrame.clear();
    for (const fn of fns) {
      try {
        fn();
      } catch (error) {
        report(error);
      }
    }
  };
  /** A scroll happened: the next frame comes soon. */
  const nudgeFrames = (): void => {
    quietFrames = 0;
    if (scrollLinked.size || heldTimelines.size) wantFrame();
  };
  /**
   * Whether the document is yet to be revealed (HTML 8.1.7.1, "reveal"):
   * `pagereveal`, at the first frame after the scripts the parser met have
   * run, and before that frame's animation frame callbacks, as the first
   * "update the rendering" a document has tells it. `<Html>` lays a
   * document out and draws it before any of its scripts runs, so what a
   * browser draws after the event this draws before it; the frame a page
   * hears it in is still the first its callbacks run in. No transition
   * across documents is handed in yet, so its `viewTransition` is null.
   */
  let revealOwed = false;
  const reveal = (): void => {
    revealOwed = false;
    if (document._unloaded) return;
    dispatch(
      windowTarget,
      asTrusted(new PageRevealEvent('pagereveal', { viewTransition: null })),
    );
  };
  const runFrame = (): void => {
    // in the frame: a frame its steps ask for is the next one
    // (`nextFrame`), and not one more beside this
    frameTimer = -1;
    renderingOwed = false;
    // the documents shown for the first time are revealed before the
    // rest of the rendering steps (HTML's "update the rendering")
    if (revealOwed) reveal();
    const time = taskNow();
    let shown: Viewport[] = [ownViewport];
    try {
      shown = renderingSteps();
    } catch (error) {
      report(error);
    }
    // then the scroll timelines' times, which the animations on them read
    snapTimelines();
    // and the CSS animations on one a page has hold of, as a frame updates
    // every animation (Web Animations 1, 4.4.19); the cascade draws them
    for (const css of cssAnimationObjects.values()) {
      if (css._finite() && css.playState !== 'idle') css._frameScrolled();
    }
    let moved = false;
    for (const animation of [...scrollLinked]) {
      if (animation._frame()) moved = true;
    }
    quietFrames = moved ? 0 : quietFrames + 1;
    // the callbacks in a task of their own, after this one's microtasks —
    // a finished promise, a ready one — and the events it queued: "update
    // animations and send events" checkpoints before them (Web Animations
    // 1, 4.4.19), and microtasks run here only as a task ends
    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    // and each frame's after the page's, in tree order (HTML 8.1.7.3:
    // "for each doc of docs, run the animation frame callbacks")
    for (const v of shown) {
      if (v === ownViewport || !v.callbacks.size) continue;
      callbacks.push(...v.callbacks.values());
      v.callbacks.clear();
    }
    if (callbacks.length) {
      // queued from a microtask, after the finish notifications the
      // update queued, so the events they tell come first
      frameTimer = -1;
      Promise.resolve().then(() => {
        frameTimer = setTimer(
          () => {
            frameTimer = 0;
            // the frame's time, as the timeline read it
            taskTime = time;
            taskTimeEpoch = taskEpoch;
            for (const fn of callbacks) {
              try {
                fn(time);
              } catch (error) {
                report(error);
              }
            }
            updateIntersections(time);
            runAfterFrame();
            nextFrame();
          },
          0,
          [],
          false,
        );
      });
      return;
    }
    frameTimer = 0;
    updateIntersections(time);
    runAfterFrame();
    nextFrame();
  };
  /** The next frame, where something waits for one. */
  const nextFrame = (): void => {
    if (frameTimer) return;
    if (frameCallbacks.size || renderingOwed || scrollOwed || framesWaiting()) {
      wantFrame();
    } else if (scrollLinked.size) {
      frameTimer = setTimer(runFrame, quietFrames > 30 ? 100 : 16, [], false);
    }
  };
  const requestFrame = (fn: Any): number => {
    if (typeof fn !== 'function') {
      throw new TypeError(
        "Failed to execute 'requestAnimationFrame' on 'Window': The callback provided as parameter 1 is not a function.",
      );
    }
    const id = ++frameSeq;
    frameCallbacks.set(id, fn);
    wantFrame();
    return id;
  };
  const cancelFrame = (id: Any): void => {
    frameCallbacks.delete(Number(id));
  };

  /** The animations a page has made that are not idle: what
   *  `getAnimations` lists, those that are relevant (Web Animations 1,
   *  5.4.4). */
  const liveAnimations = new Set<Any>();

  /** A promise with its settling kept beside it. */
  const settleable = (): Any => {
    let settle: Any = null;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    // a rejected one is handled (Web Animations 1, 4.4.15): no page has to
    // listen for it
    promise.catch(() => {});
    return { promise, settle };
  };

  /**
   * An animation a page started (`animate`, `new Animation`), as Web
   * Animations 1 and 2 model one: a start time and a hold time, a
   * playback rate and a pending one, its pending play and pause tasks and
   * its ready and finished promises, each changed by the spec's
   * procedures, step by step. Its times are milliseconds on the document's
   * timeline and percentages on a scroll-driven one, where its start time
   * is aligned to its attachment range as the timeline moves.
   *
   * What it animates is `<Html>`'s to draw, and the host is told, as
   * primitives, whenever its effect or where its time is changes
   * (`_report`, the `animation` op): `<Html>` samples its frames on its own
   * clock from where it was told the time was, as it samples a CSS
   * animation, so what is drawn is where the timing here says it is. A
   * scroll-driven one is told held at its time, at every frame it moves.
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
    _timeline: Any = null;
    _start: number | null = null;
    _hold: number | null = null;
    _rate = 1;
    _pendingRate: number | null = null;
    _pendingPlay = false;
    _pendingPause = false;
    _ready: Any;
    _readySettle: Any = null;
    _finished: Any;
    _finishedSettle: Any = null;
    _finishedDone = false;
    _previous: number | null = null;
    _autoAlign = false;
    _rangeStart: RangeEdge = 'normal';
    _rangeEnd: RangeEdge = 'normal';
    _timer = 0;
    _notifyQueued = false;
    _notifyToken = 0;
    constructor(effect: Any = null, timeline?: Any) {
      super();
      const tl = timeline === undefined ? documentTimeline : timeline;
      if (tl !== null && !(tl instanceof AnimationTimeline)) {
        throw new TypeError(
          "Failed to construct 'Animation': parameter 2 is not of type 'AnimationTimeline'.",
        );
      }
      this._timeline = tl;
      this._ready = Promise.resolve(this);
      this._newFinished();
      this.effect = effect;
    }

    // -- the model's own values

    /** The timeline's time, null where there is none or it is inactive. */
    _tlTime(): number | null {
      return this._timeline ? this._timeline._time() : null;
    }
    /** Whether its timeline is not monotonically increasing. */
    _finite(): boolean {
      return !!this._timeline && !this._timeline._monotonic;
    }
    _effRate(): number {
      return this._pendingRate ?? this._rate;
    }
    _effectEnd(): number {
      return this._effect ? this._effect._end() : 0;
    }
    /** Its current time (Web Animations 1, 4.4.4). */
    _cur(): number | null {
      if (this._hold !== null) return this._hold;
      const t = this._tlTime();
      if (t === null || this._start === null) return null;
      return (t - this._start) * this._rate;
    }
    _applyPendingRate(): void {
      if (this._pendingRate === null) return;
      this._rate = this._pendingRate;
      this._pendingRate = null;
    }
    /** Its attachment range, in its timeline's time. */
    _range(): [number, number] {
      const tl = this._timeline;
      if (!tl || tl._monotonic) return [0, 0];
      return [
        tl._rangeAt(this._rangeStart, false),
        tl._rangeAt(this._rangeEnd, true),
      ];
    }
    /** The span its timing is normalized to on a progress-based timeline,
     *  its attachment range's; null on a monotonic one. */
    _span(): number | null {
      if (!this._finite()) return null;
      const [from, to] = this._range();
      return Math.max(to - from, 0);
    }
    /** Whether its timeline's time is at either end of the timeline (Web
     *  Animations 2, "at timeline boundary"). */
    _atBoundary(): boolean {
      if (!this._finite() || !this._timeline._atEdge()) return false;
      // and its time is the timeline's, not one held where it finished
      const t = this._tlTime();
      const cur = this._cur();
      if (t === null || cur === null || this._start === null) return false;
      return Math.abs((t - this._start) * this._rate - cur) < 1e-9;
    }
    /** A time as the page reads it: a percentage on a progress-based
     *  timeline. */
    _out(v: number | null): Any {
      return v === null ? null : this._finite() ? percentOf(v) : v;
    }
    /** A time a page sets, as the model computes with it (Web Animations
     *  2, 4.4.4, "validate a CSSNumberish time"). */
    _in(v: Any, what: string): number | null {
      if (v === null) return null;
      const fail = (why: string): never => {
        throw new TypeError(
          `Failed to set the '${what}' property on 'Animation': ${why}`,
        );
      };
      if (this._finite()) {
        if (!(v instanceof CSSNumericValue)) {
          return fail(
            'CSSNumericValue must be a percentage for progress based animations.',
          );
        }
        let pct: Any;
        try {
          pct = v.to('percent');
        } catch {
          return fail(
            'CSSNumericValue must be a percentage for progress based animations.',
          );
        }
        return pct.value;
      }
      if (v instanceof CSSNumericValue) {
        let ms: Any;
        try {
          ms = v.to('ms');
        } catch {
          return fail(
            'CSSNumericValue must be either a number or a time value for time based animations.',
          );
        }
        return ms.value;
      }
      const n = Number(v);
      if (!Number.isFinite(n))
        return fail('The provided double value is non-finite.');
      return n;
    }

    // -- attributes

    get effect(): Any {
      return this._effect;
    }
    /** Web Animations 1, 4.4.3, "set the associated effect". */
    set effect(v: Any) {
      const effect = v ?? null;
      if (effect !== null && !(effect instanceof AnimationEffect)) {
        throw new TypeError(
          "Failed to set the 'effect' property on 'Animation': The provided value is not of type 'AnimationEffect'.",
        );
      }
      if (effect === this._effect) return;
      if (effect?._animation && effect._animation !== this) {
        effect._animation.effect = null;
      }
      if (this._effect) this._effect._animation = null;
      this._effect = effect;
      if (effect) effect._animation = this;
      this._updateFinished(false, false);
      this._changed();
    }
    get timeline(): Any {
      return this._timeline;
    }
    /** Web Animations 2, 4.4.1, "set the timeline of an animation". */
    set timeline(v: Any) {
      const tl = v ?? null;
      if (tl !== null && !(tl instanceof AnimationTimeline)) {
        throw new TypeError(
          "Failed to set the 'timeline' property on 'Animation': The provided value is not of type 'AnimationTimeline'.",
        );
      }
      const old = this._timeline;
      if (tl === old) return;
      const previousState = this.playState;
      const previous = this._cur();
      const endBefore = this._effectEnd();
      const progress =
        previous === null ? null : endBefore === 0 ? 0 : previous / endBefore;
      const fromFinite = old !== null && !old._monotonic;
      const toFinite = tl !== null && !tl._monotonic;
      this._timeline = tl;
      if (toFinite) {
        this._applyPendingRate();
        this._autoAlign = true;
        this._start = null;
        this._hold = null;
        if (previousState === 'finished' || previousState === 'running') {
          if (!this._pendingPlay && !this._pendingPause) this._newReady();
          this._pendingPlay = true;
          this._schedulePending();
        }
        if (previousState === 'paused' && progress !== null) {
          this._hold = progress * this._effectEnd();
        }
      } else if (fromFinite && progress !== null) {
        this._setCurrent(progress * this._effectEnd());
      }
      if (this._start !== null) this._hold = null;
      this._updateFinished(false, false);
      this._changed();
    }
    get startTime(): Any {
      return this._out(this._start);
    }
    /** Web Animations 2, 4.4.6, "set the start time". */
    set startTime(v: Any) {
      const start = this._in(v, 'startTime');
      this._autoAlign = false;
      const t = this._tlTime();
      if (t === null && start !== null) this._hold = null;
      const previous = this._cur();
      this._applyPendingRate();
      this._start = start;
      if (start !== null) {
        if (this._rate !== 0) this._hold = null;
      } else this._hold = previous;
      if (this._pendingPlay || this._pendingPause) {
        this._pendingPlay = false;
        this._pendingPause = false;
        this._resolveReady();
      }
      this._updateFinished(true, false);
      this._changed();
    }
    get currentTime(): Any {
      return this._out(this._cur());
    }
    set currentTime(v: Any) {
      this._setCurrent(this._in(v, 'currentTime'));
      this._changed();
    }
    /** Web Animations 2, 4.4.5, "silently set the current time": whether
     *  it set one. */
    _silentlySet(seek: number | null): boolean {
      if (seek === null) {
        if (this._cur() !== null) {
          throw new TypeError(
            "Failed to set the 'currentTime' property on 'Animation': currentTime may not be changed from resolved to unresolved",
          );
        }
        return false;
      }
      this._autoAlign = false;
      const t = this._tlTime();
      if (
        this._hold !== null ||
        this._start === null ||
        t === null ||
        this._rate === 0
      ) {
        this._hold = seek;
      } else this._start = t - seek / this._rate;
      if (t === null) this._start = null;
      this._previous = null;
      return true;
    }
    /** "Set the current time". */
    _setCurrent(seek: number | null): void {
      if (!this._silentlySet(seek)) return;
      if (this._pendingPause) {
        this._hold = seek;
        this._applyPendingRate();
        this._start = null;
        this._pendingPause = false;
        this._resolveReady();
      }
      this._updateFinished(true, false);
    }
    get playbackRate(): number {
      return this._rate;
    }
    /** Web Animations 1, 4.4.15.1, "set the playback rate". */
    set playbackRate(v: Any) {
      const rate = Number(v);
      if (!Number.isFinite(rate)) {
        throw new TypeError(
          "Failed to set the 'playbackRate' property on 'Animation': The provided double value is non-finite.",
        );
      }
      this._pendingRate = null;
      const previous = this._cur();
      const previousRate = this._rate;
      this._rate = rate;
      const tl = this._timeline;
      if (tl && tl._monotonic && previous !== null) {
        this._setCurrent(previous);
      } else if (
        tl &&
        !tl._monotonic &&
        this._start !== null &&
        this._effectEnd() !== Infinity &&
        previousRate < 0 !== rate < 0
      ) {
        this._start = this._effectEnd() - this._start;
        this._updateFinished(true, false);
      } else this._updateFinished(true, false);
      this._changed();
    }
    /** "Seamlessly update the playback rate" (4.4.15.2). */
    updatePlaybackRate(v: Any): void {
      const rate = Number(v);
      if (!Number.isFinite(rate)) {
        throw new TypeError(
          "Failed to execute 'updatePlaybackRate' on 'Animation': The provided double value is non-finite.",
        );
      }
      const previousState = this.playState;
      this._pendingRate = rate;
      if (this._pendingPlay || this._pendingPause) {
        this._changed();
        return;
      }
      if (
        previousState === 'idle' ||
        previousState === 'paused' ||
        this._cur() === null
      ) {
        this._applyPendingRate();
      } else if (previousState === 'finished') {
        const t = this._tlTime();
        const unconstrained =
          t === null || this._start === null
            ? null
            : (t - this._start) * this._rate;
        if (t !== null && unconstrained !== null) {
          this._start = rate === 0 ? t : t - unconstrained / rate;
        }
        this._applyPendingRate();
        this._updateFinished(false, false);
      } else {
        this._play(false);
      }
      this._changed();
    }
    get pending(): boolean {
      return this._pendingPlay || this._pendingPause;
    }
    get ready(): Any {
      return this._ready;
    }
    get finished(): Any {
      return this._finished;
    }
    /** Web Animations 1, 4.4.17. */
    get playState(): string {
      const cur = this._cur();
      if (
        cur === null &&
        this._start === null &&
        !this._pendingPlay &&
        !this._pendingPause
      ) {
        return 'idle';
      }
      if (this._pendingPause || (this._start === null && !this._pendingPlay)) {
        return 'paused';
      }
      const rate = this._effRate();
      if (
        cur !== null &&
        ((rate > 0 && cur >= this._effectEnd()) || (rate < 0 && cur <= 0))
      ) {
        return 'finished';
      }
      return 'running';
    }
    get overallProgress(): number | null {
      const cur = this._cur();
      if (!this._effect || cur === null) return null;
      const end = this._effectEnd();
      if (end === 0) return cur < 0 ? 0 : 1;
      if (end === Infinity) return 0;
      return Math.min(Math.max(cur / end, 0), 1);
    }
    get rangeStart(): Any {
      return rangeOut(this._rangeStart);
    }
    set rangeStart(v: Any) {
      this._rangeStart = rangeEdgeOf(v, false);
      this._effectChanged();
    }
    get rangeEnd(): Any {
      return rangeOut(this._rangeEnd);
    }
    set rangeEnd(v: Any) {
      this._rangeEnd = rangeEdgeOf(v, true);
      this._effectChanged();
    }

    // -- the procedures

    play(): void {
      this._play(true);
      this._changed();
    }
    /** Web Animations 2, 4.4.7, "play an animation". */
    _play(autoRewind: boolean): void {
      const abortedPause = this._pendingPause;
      let hasPendingReady = false;
      const finite = this._finite();
      const previous = this._cur();
      const seek = autoRewind && !finite;
      const rate = this._effRate();
      const end = this._effectEnd();
      if (
        rate > 0 &&
        seek &&
        (previous === null || previous < 0 || previous >= end)
      ) {
        this._hold = 0;
      } else if (
        rate < 0 &&
        seek &&
        (previous === null || previous <= 0 || previous > end)
      ) {
        if (end === Infinity) {
          throw new DOMException(
            "Failed to execute 'play' on 'Animation': Cannot play reversed Animation with infinite target effect end.",
            'InvalidStateError',
          );
        }
        this._hold = end;
      } else if (rate === 0 && previous === null) {
        this._hold = 0;
      }
      if (finite && autoRewind) {
        this._autoAlign = true;
        this._hold = previous;
      }
      if (this._hold !== null) this._start = null;
      if (this._pendingPlay || this._pendingPause) {
        this._pendingPlay = false;
        this._pendingPause = false;
        hasPendingReady = true;
      }
      // an animation whose start time the timeline aligns waits for that
      // as a pending play task too, where its hold time is unresolved
      if (
        this._hold === null &&
        !abortedPause &&
        this._pendingRate === null &&
        !(finite && autoRewind)
      ) {
        return;
      }
      if (!hasPendingReady) this._newReady();
      this._pendingPlay = true;
      this._schedulePending();
      this._updateFinished(false, false);
    }
    /** Web Animations 2, 4.4.8, "pause an animation". */
    pause(): void {
      if (this._pendingPause || this.playState === 'paused') return;
      const finite = this._finite();
      if (this._cur() === null && !finite) {
        if (this._rate >= 0) this._hold = 0;
        else {
          const end = this._effectEnd();
          if (end === Infinity) {
            throw new DOMException(
              "Failed to execute 'pause' on 'Animation': Cannot pause, Animation has infinite target effect end.",
              'InvalidStateError',
            );
          }
          this._hold = end;
        }
      }
      if (finite && this._cur() === null) this._autoAlign = true;
      let hasPendingReady = false;
      if (this._pendingPlay) {
        this._pendingPlay = false;
        hasPendingReady = true;
      }
      if (!hasPendingReady) this._newReady();
      this._pendingPause = true;
      this._schedulePending();
      this._updateFinished(false, false);
      this._changed();
    }
    /** Web Animations 1, 4.4.14, "reverse an animation". */
    reverse(): void {
      if (this._tlTime() === null) {
        throw new DOMException(
          "Failed to execute 'reverse' on 'Animation': Cannot reverse an animation with no active timeline.",
          'InvalidStateError',
        );
      }
      const original = this._pendingRate;
      // 0 reversed is 0, and not -0
      this._pendingRate = 0 - this._effRate();
      try {
        this._play(true);
      } catch (error) {
        this._pendingRate = original;
        throw error;
      }
      this._changed();
    }
    /** Web Animations 1, 4.4.12, "finish an animation". */
    finish(): void {
      const rate = this._effRate();
      const end = this._effectEnd();
      if (rate === 0 || (rate > 0 && end === Infinity)) {
        throw new DOMException(
          "Failed to execute 'finish' on 'Animation': Cannot finish Animation with a playbackRate of 0 or an infinite target effect end.",
          'InvalidStateError',
        );
      }
      this._applyPendingRate();
      const limit = this._rate > 0 ? end : 0;
      this._silentlySet(limit);
      const t = this._tlTime();
      if (this._start === null && t !== null) {
        this._start = t - limit / this._rate;
      }
      if (this._pendingPause && this._start !== null) {
        this._hold = null;
        this._pendingPause = false;
        this._resolveReady();
      }
      if (this._pendingPlay && this._start !== null) {
        this._pendingPlay = false;
        this._resolveReady();
      }
      this._updateFinished(true, true);
      this._changed();
    }
    /** Web Animations 1, 4.4.13, "cancel an animation". */
    cancel(): void {
      if (this.playState !== 'idle') {
        this._resetPending();
        this._finishedSettle?.reject(
          new DOMException('The user aborted a request.', 'AbortError'),
        );
        this._newFinished();
        this._tell('cancel', null);
      }
      this._hold = null;
      this._start = null;
      this._changed();
    }
    /** "Reset an animation's pending tasks". */
    _resetPending(): void {
      if (!this._pendingPlay && !this._pendingPause) return;
      this._pendingPlay = false;
      this._pendingPause = false;
      this._applyPendingRate();
      this._readySettle?.reject(
        new DOMException('The user aborted a request.', 'AbortError'),
      );
      this._readySettle = null;
      this._ready = Promise.resolve(this);
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

    // -- pending tasks and the finished state

    _newReady(): void {
      const { promise, settle } = settleable();
      this._ready = promise;
      this._readySettle = settle;
    }
    _resolveReady(): void {
      const settle = this._readySettle;
      this._readySettle = null;
      settle?.resolve(this);
    }
    _newFinished(): void {
      const { promise, settle } = settleable();
      this._finished = promise;
      this._finishedSettle = settle;
      this._finishedDone = false;
    }
    /** Run its pending task as soon as it is ready: at once for one on the
     *  document's timeline, which is, and for a scroll-driven one once its
     *  timeline is active and its start time aligned — never synchronously
     *  (Web Animations 1, 4.4.7). */
    _schedulePending(): void {
      Promise.resolve().then(() => this._tryPending());
    }
    /** The pending task, where it is ready; whether it ran. */
    _tryPending(): boolean {
      if (!this._pendingPlay && !this._pendingPause) return false;
      this._autoAlignStart();
      const t = this._tlTime();
      if (t === null || (this._start === null && this._hold === null)) {
        this._watch();
        return false;
      }
      if (this._pendingPlay) {
        if (this._hold !== null) {
          this._applyPendingRate();
          this._start = this._rate === 0 ? t : t - this._hold / this._rate;
          if (this._rate !== 0) this._hold = null;
        } else if (this._start !== null && this._pendingRate !== null) {
          const match = (t - this._start) * this._rate;
          this._applyPendingRate();
          if (this._rate === 0) this._hold = match;
          this._start = this._rate === 0 ? t : t - match / this._rate;
        }
        this._pendingPlay = false;
      } else {
        if (this._start !== null && this._hold === null) {
          this._hold = (t - this._start) * this._rate;
        }
        this._applyPendingRate();
        this._start = null;
        this._pendingPause = false;
      }
      this._resolveReady();
      this._updateFinished(false, false);
      this._changed();
      return true;
    }
    /** Scroll Animations 1, 8, "calculating an auto-aligned start time". */
    _autoAlignStart(): void {
      if (!this._autoAlign || this._tlTime() === null) return;
      const state = this.playState;
      if (state === 'idle') return;
      if (state === 'paused' && this._hold !== null) return;
      const [from, to] = this._range();
      this._start = this._effRate() >= 0 ? from : to;
      this._applyPendingRate();
      this._hold = null;
    }
    /** Web Animations 1, 4.4.11, "update an animation's finished state". */
    _updateFinished(didSeek: boolean, sync: boolean): void {
      const t = this._tlTime();
      const unconstrained = didSeek
        ? this._cur()
        : t === null || this._start === null
          ? null
          : (t - this._start) * this._rate;
      if (
        unconstrained !== null &&
        this._start !== null &&
        !this._pendingPlay &&
        !this._pendingPause
      ) {
        const end = this._effectEnd();
        if (this._rate > 0 && unconstrained >= end) {
          this._hold = didSeek
            ? unconstrained
            : this._previous === null
              ? end
              : Math.max(this._previous, end);
        } else if (this._rate < 0 && unconstrained <= 0) {
          this._hold = didSeek
            ? unconstrained
            : this._previous === null
              ? 0
              : Math.min(this._previous, 0);
        } else if (this._rate !== 0 && t !== null) {
          if (didSeek && this._hold !== null) {
            this._start = t - this._hold / this._rate;
          }
          this._hold = null;
        }
      }
      this._previous = this._cur();
      const finished = this.playState === 'finished';
      if (finished && !this._finishedDone) {
        if (sync) {
          this._notifyToken += 1;
          this._notifyQueued = false;
          this._notifyFinished();
        } else if (!this._notifyQueued) {
          this._notifyQueued = true;
          const token = this._notifyToken;
          Promise.resolve().then(() => {
            if (token !== this._notifyToken) return;
            this._notifyQueued = false;
            this._notifyFinished();
          });
        }
      }
      if (!finished && this._finishedDone) this._newFinished();
    }
    /** "Finish notification steps". */
    _notifyFinished(): void {
      if (this.playState !== 'finished' || this._finishedDone) return;
      this._finishedDone = true;
      const settle = this._finishedSettle;
      settle?.resolve(this);
      this._tell('finish', this._out(this._cur()));
      this._replaceOlder();
    }

    // -- what it tells the host, and when it looks again

    /** Something about it changed: the host told, and its timer or its
     *  frames set for what comes next. */
    _changed(): void {
      // an idle one is nobody's, and a finished one that fills nothing
      // has no effect until the page changes it
      const state = this.playState;
      if (
        state === 'idle' ||
        this.replaceState === 'removed' ||
        (state === 'finished' && this._effect?._state().active === null)
      ) {
        liveAnimations.delete(this);
      } else liveAnimations.add(this);
      this._reschedule();
      this._report();
      this._watch();
    }
    /** Its effect's timing changed (`updateTiming`, a range). */
    _effectChanged(): void {
      this._updateFinished(false, false);
      this._changed();
    }
    /** On the document's timeline, a timer at the moment it reaches its
     *  end — or its start, played backwards — to update its finished
     *  state there. */
    _reschedule(): void {
      clearTimer(this._timer);
      this._timer = 0;
      if (this._finite() || !this._timeline) return;
      if (this._start === null || this._hold !== null || this._rate === 0) {
        return;
      }
      if (this._pendingPlay || this._pendingPause) return;
      const cur = this._cur();
      if (cur === null) return;
      const end = this._effectEnd();
      const left =
        this._rate > 0 ? (end - cur) / this._rate : cur / -this._rate;
      if (!Number.isFinite(left) || left < 0) return;
      this._timer = setTimer(
        () => {
          this._timer = 0;
          this._updateFinished(false, false);
          this._changed();
        },
        left,
        [],
        false,
      );
    }
    /** A scroll-driven animation that is not idle is brought up to date at
     *  every frame, as is one whose pending task waits for its timeline. */
    _watch(): void {
      const watched =
        (this._finite() && this.playState !== 'idle') ||
        ((this._pendingPlay || this._pendingPause) && this._tlTime() === null);
      if (watched) {
        scrollLinked.add(this);
        wantFrame();
      } else scrollLinked.delete(this);
    }
    /** A frame: its timeline's time taken up — its start time aligned, its
     *  pending task run where it is ready now, its finished state — and
     *  the host told. Whether it told the host anything new. */
    _frame(): boolean {
      this._autoAlignStart();
      if (!this._tryPending()) {
        this._updateFinished(false, false);
      }
      const told = this._told;
      this._report();
      this._watch();
      return this._told !== told;
    }
    /**
     * Tell the host what it animates and where its time is: its effect
     * (`KeyframeEffect._hostEffect`), and `1,<time>,<rate>` where it runs
     * from that time on the document's clock, `0,<time>,<rate>` where it
     * is held there — paused, finished, pending, or scroll-driven, whose
     * time a frame tells again as it moves; or, where it has no effect —
     * idle, cancelled, replaced, of no element — that the element it was
     * told of has it no longer.
     */
    _report(): void {
      const effect = this._effect;
      const target = effect?.target ?? null;
      const time = this._cur();
      let described: string | null = null;
      if (
        target instanceof Element &&
        time !== null &&
        this.replaceState !== 'removed'
      ) {
        const n = effect._norm();
        const fill = effect._state().boundary ? 'both' : n.fill;
        described = effect._hostEffect(n, fill);
      }
      if (this._toldTo && (this._toldTo !== target || described === null)) {
        call('animation', this._toldTo._id, this._hostId, null, null);
        this._toldTo = null;
        this._told = '';
      }
      if (described === null) return;
      const running =
        !this._finite() &&
        this._start !== null &&
        this._hold === null &&
        !this._pendingPause;
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
        a._tell('remove', a._out(a._cur()));
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
    _tell(type: string, currentTime: Any): void {
      const timelineTime = this._timeline ? this._timeline.currentTime : null;
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
  /** An attachment range's end as `rangeStart` and `rangeEnd` read it:
   *  `normal`, or a `TimelineRangeOffset`, its name left out where it has
   *  none. */
  const rangeOut = (edge: RangeEdge): Any =>
    edge === 'normal'
      ? 'normal'
      : edge.name === null
        ? { offset: edge.offset }
        : { rangeName: edge.name, offset: edge.offset };
  /**
   * A CSS animation as a page sees it (CSS Animations 2, 4.1): an
   * `Animation` whose state is the document's — what its cascade runs —
   * read again each time `getAnimations()` lists it, by its run's key, so a
   * page holds one object for as long as the run lasts. Its effect's
   * timing is the animation's longhands', and its timeline the clock's, a
   * scroll's or a view's. What a page does to it changes it here, and not
   * what is drawn, which is the cascade's.
   */
  class CSSAnimation extends Animation {
    _name = '';
    /** Its run's key, which the cascade knows it by. */
    _key = 0;
    get animationName(): string {
      return this._name;
    }
    /** What a page did to it — a seek, `pause()`, `play()`, `finish()` —
     *  is the cascade's run's as well, so what is drawn, what is read back
     *  and the events it tells follow it. It is in no list of a script's
     *  animations: `getAnimations()` finds it through the cascade. */
    override _changed(): void {
      this._reschedule();
      // one the page has held, running or paused, keeps a view transition
      // whose pseudo-element it animates going (`scriptedTransition`)
      if (this.playState === 'idle') heldCssAnimations.delete(this);
      else heldCssAnimations.add(this);
      if (this._finite()) {
        this._tellScrolled();
        return;
      }
      const time = this.currentTime;
      if (typeof time === 'number') {
        call('seekAnimation', this._key, time, this.playState === 'paused');
      } else if (this.playState === 'idle') {
        call('cancelCss', 'animation', this._key);
      }
    }
    /**
     * On a scroll's timeline, what its state comes to, told the cascade's
     * run: held where it is paused, or pause-pending, at its time — at
     * where its timeline will have it, where it has none yet — aligned to
     * its range where its start time is the timeline's to align, as
     * `play()` makes it, and otherwise running from the start time a seek,
     * `startTime` or `finish()` gave it.
     */
    _tellScrolled(): void {
      const state = this.playState;
      if (state === 'idle') {
        call('cancelCss', 'animation', this._key);
        return;
      }
      const rate = this._effRate();
      if (state === 'paused') {
        call('seekScrolled', this._key, 'hold', this._cur(), rate);
      } else if (this._autoAlign) {
        call('seekScrolled', this._key, 'align', null, rate);
      } else {
        const t = this._tlTime();
        const start =
          this._start ??
          (this._hold !== null && t !== null && this._rate !== 0
            ? t - this._hold / this._rate
            : null);
        if (start === null) {
          call('seekScrolled', this._key, 'hold', this._cur(), rate);
        } else call('seekScrolled', this._key, 'start', start, this._rate);
      }
    }
    /** A frame, on a scroll's timeline: its start time aligned, its
     *  pending task run where it is ready, and its finished state, from
     *  the timeline's time now — what the page reads of it. */
    _frameScrolled(): void {
      this._autoAlignStart();
      if (!this._tryPending()) this._updateFinished(false, false);
    }
    // drawn by the document's cascade, and brought up to date by it; its
    // `finished` settles at its end, by the timer every animation keeps
    override _report(): void {}
    override _watch(): void {}
  }
  /** Each CSS animation's object, by its run's key. */
  const cssAnimationObjects = new Map<number, Any>();
  /** The CSS animations a page's script did something to, which are none
   *  of `liveAnimations`, the list of a script's own. */
  const heldCssAnimations = new Set<Any>();
  /** The timeline objects a CSS animation runs on, by what they are, so a
   *  page reads one object for one timeline. */
  const cssTimelines = new Map<string, Any>();
  const cssTimelineOf = (t: Any): Any => {
    if (t.kind === 'document') return documentTimeline;
    if (t.kind === 'none') return null;
    const key =
      t.kind === 'scroll'
        ? `s${t.source}:${t.axis}`
        : `v${t.subject}:${t.axis}:${t.inset.join(' ')}`;
    let tl = cssTimelines.get(key);
    if (!tl) {
      tl =
        t.kind === 'scroll'
          ? new ScrollTimeline({
              source: t.source ? wrap(t.source) : document.scrollingElement,
              axis: t.axis,
            })
          : new ViewTimeline({
              subject: wrap(t.subject),
              axis: t.axis,
              inset: t.inset.join(' '),
            });
      cssTimelines.set(key, tl);
    }
    return tl;
  };
  /** The CSS animations under way on `target`, or on what it holds, or in
   *  the document for null, in tree order and then their order in
   *  `animation-name` (CSS Animations 2, 4.1, "the composite order"). */
  const cssAnimationsOf = (target: Any, subtree: boolean): Any[] => {
    const raw = call(
      'cssAnimations',
      target && target !== document ? target._id : 0,
      subtree,
    );
    const list: Any[] = typeof raw === 'string' && raw ? JSON.parse(raw) : [];
    const out: Any[] = [];
    for (const info of list) {
      // one the page cancelled is idle, and listed by no one, but keeps
      // its object for as long as its run lasts, which `play()` takes up
      if (info.cancelled) continue;
      let a = cssAnimationObjects.get(info.key);
      const el = wrap(info.element);
      if (!a) {
        const effect = new KeyframeEffect(el, null, {
          duration: info.duration,
          delay: info.delay,
          iterations: info.iterations,
          direction: info.direction,
          fill: info.fill,
          easing: info.easing,
          pseudoElement: info.pseudo || null,
        });
        effect._css = {
          name: info.name,
          pseudo: String(info.pseudo || '').replace(/^:+/, ''),
        };
        a = new CSSAnimation(effect, cssTimelineOf(info.timeline));
        a._name = info.name;
        a._key = info.key;
        cssAnimationObjects.set(info.key, a);
      } else {
        a._timeline = cssTimelineOf(info.timeline);
      }
      a._effect._timing = timingOf(
        {
          duration: info.duration,
          delay: info.delay,
          iterations: info.iterations,
          direction: info.direction,
          fill: info.fill,
          easing: info.easing,
        },
        null,
      );
      a._rangeStart = rangeEdgeOf(info.rangeStart, false);
      a._rangeEnd = rangeEdgeOf(info.rangeEnd, true);
      // a task the page left pending is the cascade's now, and done
      const pending = a._pendingPlay || a._pendingPause;
      a._pendingPlay = false;
      a._pendingPause = false;
      if (pending) a._resolveReady();
      if (!a._timeline) {
        a._start = null;
        a._hold = null;
      } else if (a._finite()) {
        // on a scroll's timeline: held where the cascade holds it, from the
        // start time a page gave it, or where its range starts — or ends,
        // played backwards — and at the rate the page gave it
        const scroll = info.scroll ?? { at: null, start: null, rate: 1 };
        a._rate = scroll.rate;
        a._pendingRate = null;
        a._autoAlign = scroll.start === null;
        const [from, to] = a._range();
        a._start = scroll.start ?? (scroll.rate < 0 ? to : from);
        a._hold = null;
        if (info.paused) {
          a._hold = scroll.at ?? a._cur();
          a._start = null;
        }
      } else if (info.paused) {
        a._start = null;
        a._hold = info.currentTime;
      } else {
        a._hold = null;
        a._start = a._timeline._time() - info.currentTime;
      }
      a._reschedule();
      out.push(a);
    }
    // what the cascade no longer runs is no one's
    const keys = new Set(list.map((info: Any) => info.key));
    if (!target || target === document) {
      for (const key of [...cssAnimationObjects.keys()]) {
        if (!keys.has(key)) cssAnimationObjects.delete(key);
      }
    }
    return out;
  };

  /**
   * A CSS transition as a page sees it (CSS Transitions 2, 6.1): an
   * `Animation` on the document's timeline whose state is the cascade's,
   * read again each time `getAnimations()` lists it, by its run's key. Its
   * effect's delay and duration are the transition's, filling backwards,
   * and its timing function is the keyframes' (6.2), so its own easing is
   * linear. Its `finished` settles at its end, by the timer every animation
   * keeps (`_reschedule`): a page that waits on it is answered.
   */
  class CSSTransition extends Animation {
    _property = '';
    /** Its run's key, which the cascade knows it by. */
    _key = 0;
    get transitionProperty(): string {
      return this._property;
    }
    override _report(): void {}
    override _watch(): void {}
    /** What a page did to it — a seek, `finish()` — is the cascade's
     *  transition's as well, so what is drawn, what `getComputedStyle()`
     *  reads and the events it tells are at the time the page set (Web
     *  Animations 1, 4.4.4). It is in no list of a script's animations. */
    override _changed(): void {
      this._reschedule();
      const time = this.currentTime;
      if (typeof time === 'number') call('seekTransition', this._key, time);
      else if (this.playState === 'idle') {
        call('cancelCss', 'transition', this._key);
      }
    }
  }
  /** Each CSS transition's object, by its run's key. */
  const cssTransitionObjects = new Map<number, Any>();
  /** The CSS transitions under way on `target`, or on what it holds, or in
   *  the document, in their composite order. */
  const cssTransitionsOf = (target: Any, subtree: boolean): Any[] => {
    const raw = call(
      'cssTransitions',
      target && target !== document ? target._id : 0,
      subtree,
    );
    const list: Any[] = typeof raw === 'string' && raw ? JSON.parse(raw) : [];
    const out: Any[] = [];
    for (const info of list) {
      let t = cssTransitionObjects.get(info.key);
      if (!t) {
        const effect = new KeyframeEffect(wrap(info.element), null, {
          duration: info.duration,
          delay: info.delay,
          fill: 'backwards',
          pseudoElement: info.pseudo || null,
        });
        t = new CSSTransition(effect, documentTimeline);
        t._property = info.property;
        t._key = info.key;
        cssTransitionObjects.set(info.key, t);
      }
      t._pendingPlay = false;
      t._pendingPause = false;
      t._hold = null;
      t._start = t._timeline._time() - info.currentTime;
      t._reschedule();
      out.push(t);
    }
    // what the cascade no longer runs is no one's
    if (!target || target === document) {
      const keys = new Set(list.map((info: Any) => info.key));
      for (const key of [...cssTransitionObjects.keys()]) {
        if (!keys.has(key)) cssTransitionObjects.delete(key);
      }
    }
    return out;
  };

  /** The animations running on `target`, or on what it holds as well, in
   *  their composite order: the CSS transitions first, then the CSS
   *  animations, then a script's (CSS Transitions 2, 4.1). */
  const animationsOf = (target: Any, subtree: boolean): Any[] => [
    ...cssTransitionsOf(target, subtree),
    ...cssAnimationsOf(target, subtree),
    ...[...liveAnimations]
      .filter((a) => {
        const on = a.effect?.target;
        if (!on || a.replaceState === 'removed') return false;
        if (a.playState === 'finished' && a._effect._state().active === null) {
          return false;
        }
        return (
          target === document ||
          on === target ||
          (subtree && target.contains?.(on))
        );
      })
      .sort((a, b) => a._hostId - b._hostId),
  ];

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
              : htmlKind(name)))
          : ns === HTML_NS
            ? (ELEMENT_CLASSES[name] ?? htmlKind(name))
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
      node._pageShowing = false;
      node._hidden = false;
      node._unloadCounter = 0;
      node._leaveChecked = false;
      node._unloaded = false;
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

  /** A node a page's `new` makes (DOM 4.7, 4.11, 4.14): one of the page's
   *  document, as `new Range()` is, and of the class `new` was called on,
   *  so a page's subclass of `Text` makes one of its own. */
  const constructed = (Kind: Any, type: string, data: string): Any => {
    const made = wrap(Number(call('create', type, data, document._id)));
    if (Object.getPrototypeOf(made) !== Kind.prototype) {
      Object.setPrototypeOf(made, Kind.prototype);
    }
    return made;
  };
  /** Whether `new` was called on `Kind` or a class under it. */
  const isOrUnder = (target: Any, Kind: Any): boolean =>
    target === Kind || target.prototype instanceof Kind;

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
      if (this.nodeType === 9 || !registriesMatterNow()) {
        return wrap(call('clone', this._id, !!deep));
      }
      return copyOf('clone', this, !!deep, null, this.ownerDocument);
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
      call('replaceChildren', this._id, items.length ? nodesFrom(items) : 0);
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
    /** `new Text(data)` (DOM 4.11). A `CDATASection` is no page's to make:
     *  `super()` is `Node`'s, which refuses it. */
    constructor(data: Any = '') {
      if (isOrUnder(new.target, CDATASection)) super();
      return constructed(new.target, 'text', str(data));
    }
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
  class Comment extends CharacterData {
    /** `new Comment(data)` (DOM 4.14). Nothing under it is refused, and a
     *  class is never called without `new`: the `super()` is the
     *  compiler's, and never runs. */
    constructor(data: Any = '') {
      if (!new.target) super();
      return constructed(new.target, 'comment', str(data));
    }
  }
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
    /** `new DocumentFragment()` (DOM 4.7). A `ShadowRoot` is made by
     *  `attachShadow` alone: `super()` is `Node`'s, which refuses it. */
    constructor() {
      if (isOrUnder(new.target, ShadowRoot)) super();
      return constructed(new.target, 'fragment', '');
    }
    getElementById(id: Any): Any {
      return wrap(
        Number(call('query', this._id, `#${cssEscape(str(id))}`, false)),
      );
    }
  }
  Object.defineProperty(DocumentFragment.prototype, 'nodeType', nodeTypeOf(11));
  /** `getHTML()` (HTML 8.5.2): what a node holds, with its shadow trees
   *  written as the declarative templates that make them — the
   *  serializable ones where `serializableShadowRoots`, and those
   *  `shadowRoots` lists. */
  const getHTML = (node: Any, options: Any): string => {
    if (
      options !== undefined &&
      options !== null &&
      typeof options !== 'object'
    ) {
      throw new TypeError(
        "Failed to execute 'getHTML': The provided value is not of type 'GetHTMLOptions'.",
      );
    }
    const roots: Any[] = options?.shadowRoots ?? [];
    // the shadow roots in it written with `shadowrootcustomelementregistry`
    // (HTML 8.5.2), closed ones too: all but those whose registry and
    // whose document's are both none, or both global
    const own: number[] = [];
    const visit = (at: Any): void => {
      const elements = [
        ...(at instanceof Element ? [at] : []),
        ...Array.from(at.querySelectorAll('*') as ArrayLike<Any>),
      ];
      for (const el of elements) {
        const id = Number(call('shadowRoot', el._id, true));
        const root = id ? wrap(id) : null;
        if (!root) continue;
        const registry = root.customElementRegistry;
        const ofDocument = documentRegistryOf(el.ownerDocument);
        if (
          !(registry === null && ofDocument === null) &&
          !(isGlobalRegistry(registry) && isGlobalRegistry(ofDocument))
        ) {
          own.push(id);
        }
        visit(root);
      }
    };
    visit(node);
    return String(
      call(
        'getHTML',
        node._id,
        !!options?.serializableShadowRoots,
        Array.from(roots as ArrayLike<Any>)
          .map((root) => root?._id)
          .filter(Boolean)
          .join(','),
        own.join(','),
      ),
    );
  };
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
    get clonable(): boolean {
      return str(call('shadowFlags', this._id))[0] === '1';
    }
    get serializable(): boolean {
      return str(call('shadowFlags', this._id))[1] === '1';
    }
    get customElementRegistry(): Any {
      return adoptedRegistry(shadowRegistryOf(this), this.host.ownerDocument);
    }
    get slotAssignment(): string {
      return 'named';
    }
    get innerHTML(): string {
      return String(call('html', this._id, false));
    }
    set innerHTML(v: Any) {
      call('setHtml', this._id, v === null ? '' : str(v));
      upgradeParsed(this);
    }
    getHTML(options?: Any): string {
      return getHTML(this, options);
    }
    setHTMLUnsafe(html: Any): void {
      call('setHtml', this._id, str(html), true);
      upgradeParsed(this);
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

  /** A `DOMTokenList` over an attribute: `classList`, `relList`, and the
   *  tokens it supports where it has any (`supports`). */
  class DOMTokenList {
    _el: Any;
    _attr: string;
    _supported: readonly string[] | null;
    constructor(
      el: Any,
      attr: string,
      supported: readonly string[] | null = null,
    ) {
      this._el = el;
      this._attr = attr;
      this._supported = supported;
    }
    /** Whether a token is one the attribute does something with (DOM
     *  7.1, "validation steps"), ASCII case-insensitively; a list with
     *  no supported tokens, `classList`, throws. */
    supports(token: Any): boolean {
      if (!this._supported) {
        throw new TypeError(
          `The '${this._attr}' attribute has no supported tokens.`,
        );
      }
      return this._supported.includes(str(token).toLowerCase());
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
  const camel = (name: string): string => {
    let out = camelNames.get(name);
    if (out === undefined) {
      out = name
        .replace(/^-(webkit|moz|ms)-/, '$1-')
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      camelNames.set(name, out);
    }
    return out;
  };
  /** What `camel` made of each name: a computed style is read by every
   *  name it has, and a page may have put its own hand in the `String`
   *  methods that make them. */
  const camelNames = new Map<string, string>();
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

  /** What `el.dataset` is an instance of (HTML 3.2.6.6), which a page may
   *  test a dataset against: Facebook's asks `e.dataset instanceof
   *  window.DOMStringMap`, and threw where there was none. */
  class DOMStringMap {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
  }

  /** `el.dataset`: the `data-*` attributes, by their names in camel case,
   *  over its prototype's members, which a name of an attribute's hides
   *  (`[LegacyOverrideBuiltIns]`). */
  const datasetOf = (el: Any): Any =>
    new Proxy(Object.create(DOMStringMap.prototype), {
      get(t, key) {
        if (typeof key === 'string') {
          const value = el.getAttribute(`data-${kebab(key)}`);
          if (value !== null) return value;
        }
        return Reflect.get(t, key);
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
      has(t, key) {
        return (
          (typeof key === 'string' && el.hasAttribute(`data-${kebab(key)}`)) ||
          Reflect.has(t, key)
        );
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

  /** The geometry interfaces (`geometry.ts`): a point, a rectangle, a
   *  quad and a matrix. A rectangle is what `getBoundingClientRect` hands
   *  over, in the viewport's coordinates, which are the document's less
   *  the scroll. */
  const GEOMETRY = geometry({ DOMException });
  const DOMRect: Any = GEOMETRY.classes.DOMRect;
  const DOMRectReadOnly: Any = GEOMETRY.classes.DOMRectReadOnly;

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
  /** An element's padding box where it is no scroll container — width,
   *  height, and its top and left borders (CSSOM View 6) — or null where
   *  its box is none or inline. */
  const clientBoxOf = (el: Any): number[] | null => {
    const r = call('clientBox', el._id);
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
  /** The names a map answers as properties of its own (DOM 4.9.1, its
   *  supported property names): its attributes' qualified names, less any
   *  with an upper-case letter on an HTML element in an HTML document. */
  const namedItems = (target: Any): string[] => {
    const el = target._el;
    const names: string[] = el.getAttributeNames();
    return el.namespaceURI === HTML_NS && !el.ownerDocument?._type
      ? names.filter((name) => !/[A-Z]/.test(name))
      : names;
  };
  /** Whether `key` is an attribute's name that the map answers, where no
   *  property of its own or of its prototypes has the name (WebIDL 3.10,
   *  the named property visibility algorithm). */
  const namedItem = (target: Any, key: Any): boolean =>
    typeof key === 'string' &&
    !Reflect.has(target, key) &&
    namedItems(target).includes(key);
  const namedNodeMapOf = (el: Any): Any => {
    let map = attributeMaps.get(el);
    if (map) return map;
    map = new Proxy(new NamedNodeMap(el), {
      get(target: Any, key: Any): Any {
        if (typeof key === 'string' && INDEX.test(key)) {
          return target.item(Number(key)) ?? undefined;
        }
        // `attributes.onclick`, which jQuery 1.12 reads as it loads
        if (namedItem(target, key)) return attrOf(target._el, key);
        return Reflect.get(target, key, target);
      },
      has(target: Any, key: Any): boolean {
        if (typeof key === 'string' && INDEX.test(key)) {
          return Number(key) < target.length;
        }
        return Reflect.has(target, key) || namedItem(target, key);
      },
      ownKeys(target: Any): Any[] {
        return [
          ...target._el
            .getAttributeNames()
            .map((_: Any, i: number) => String(i)),
          ...namedItems(target).filter((name) => !Reflect.has(target, name)),
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
        // [LegacyUnenumerableNamedProperties]: a name is not enumerated
        if (namedItem(target, key)) {
          return {
            value: attrOf(target._el, key),
            enumerable: false,
            configurable: true,
            writable: false,
          };
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
      // a media element's `src` set or changed loads it (HTML 4.8.11.2)
      if (n === 'src' && this instanceof HTMLMediaElement && mediaLoads()) {
        mediaLoad(this);
      }
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
      upgradeParsed(this);
    }
    getHTML(options?: Any): string {
      return getHTML(this, options);
    }
    setHTMLUnsafe(html: Any): void {
      call('setHtml', this._id, str(html), true);
      upgradeParsed(this);
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
      return Math.round(clientBoxOf(this)?.[0] ?? 0);
    }
    get clientHeight(): number {
      const s = scrollStateOf(this);
      if (s) return Math.round(s[5]);
      if (this._viewport()) return viewport().height;
      return Math.round(clientBoxOf(this)?.[1] ?? 0);
    }
    get clientTop(): number {
      const s = scrollStateOf(this);
      return Math.round(s ? s[6] : (clientBoxOf(this)?.[2] ?? 0));
    }
    get clientLeft(): number {
      const s = scrollStateOf(this);
      return Math.round(s ? s[7] : (clientBoxOf(this)?.[3] ?? 0));
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
      if (this._viewport()) return viewport(true).scrollY;
      return scrollStateOf(this)?.[1] ?? 0;
    }
    set scrollTop(v: Any) {
      this._scrollTo(undefined, Number(v));
    }
    get scrollLeft(): number {
      if (this._viewport()) return viewport(true).scrollX;
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
    _scrollTo(
      x: number | undefined,
      y: number | undefined,
      relative = false,
    ): void {
      const ok = (v: number | undefined) =>
        v !== undefined && Number.isFinite(v);
      // what a scroll-driven animation draws follows at the next frame
      nudgeFrames();
      if (this._viewport()) {
        const v = viewport();
        call(
          'scrollTo',
          ok(x) ? x : v.scrollX,
          ok(y) ? y : v.scrollY,
          undefined,
          relative,
        );
        return;
      }
      call(
        'scrollElement',
        this._id,
        ok(x) ? x : undefined,
        ok(y) ? y : undefined,
        relative,
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
        true,
      );
    }
    /** Brought into view through every scroll container around it whose
     *  scroll moves it, the innermost first, and then the viewport (CSSOM
     *  View 7.1): its top at the top of each, or its middle, its end or
     *  as little as shows it, as `block` asks, and its left edge as
     *  `inline` asks, as little as shows it unless it says. A container
     *  moves no box positioned against something outside it, nor what
     *  that box holds, so it is not scrolled for one: a box absolute in a
     *  `position: relative` wrapper around a scrolling list scrolled the
     *  list as far as the box was below its top. One fixed to the
     *  viewport, or in a box that is, is moved by no scroll but that of a
     *  scroll container inside that box, so the viewport is not scrolled
     *  either, as Chrome has it: measured where the scroll draws it, a bar
     *  fixed `top: 30px` on a page scrolled 500px scrolled the page 30px
     *  on. Each scroll is told the element, which a snap container lines
     *  up as its `scroll-snap-align` says where it is one of its areas
     *  (CSS Scroll Snap 1, "choosing snap positions"), and a container
     *  that does not snap too. */
    scrollIntoView(arg?: Any): void {
      const block =
        arg && typeof arg === 'object'
          ? str(arg.block ?? 'start')
          : arg === false
            ? 'end'
            : 'start';
      const inline =
        arg && typeof arg === 'object'
          ? str(arg.inline ?? 'nearest')
          : 'nearest';
      this._intoView(block, inline, false);
    }
    /** `scrollIntoView` as the focusing steps run it, and as it is
     *  asked: where `quiet`, a container the element shows in already is
     *  not scrolled at all, nor snapped again, so that a focus moved
     *  within a snapped carousel leaves the slide it is on. */
    _intoView(block: string, inline: string, quiet: boolean): void {
      const place = (
        how: string,
        top: number,
        height: number,
        port: number,
      ) => {
        if (how === 'center') return top - (port - height) / 2;
        if (how === 'end') return top - (port - height);
        if (how === 'nearest') {
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
        const byX = place(inline, me[0] - (port[0] + s[7]), me[2], s[4]);
        const byY = place(block, me[1] - (port[1] + s[6]), me[3], s[5]);
        if (quiet && !byX && !byY) continue;
        call(
          'scrollElement',
          at._id,
          byX ? s[0] + byX : undefined,
          byY ? s[1] + byY : undefined,
          this._id,
        );
      }
      if (call('atViewport', this._id) === true) return;
      const r = docRect(this);
      if (!r) return;
      const v = viewport();
      const byX = place(inline, r[0] - v.scrollX, r[2], v.width);
      const byY = place(block, r[1] - v.scrollY, r[3], v.height);
      if (quiet && !byX && !byY) return;
      call('scrollTo', v.scrollX + byX, v.scrollY + byY, this._id);
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
      // the document's registry, whatever the host's, but where one is
      // named (HTML 4.13.4, scoped registries)
      const own = documentRegistryOf(this.ownerDocument);
      const given = registryGiven(init, own, 'attachShadow');
      // a declarative root the call takes back keeps its registry (DOM
      // 4.9, "attach a shadow root", step 4)
      const had = Number(call('shadowRoot', this._id, true)) !== 0;
      const root = wrap(
        Number(
          call(
            'attachShadow',
            this._id,
            mode,
            !!init?.delegatesFocus,
            `${init?.clonable ? 1 : 0},${init?.serializable ? 1 : 0}`,
          ),
        ),
      );
      if (!had) setShadowRegistry(root, given === undefined ? own : given);
      return root;
    }
    get shadowRoot(): Any {
      return wrap(Number(call('shadowRoot', this._id)));
    }
    /** The registry the element was made with (HTML 4.13.4). */
    get customElementRegistry(): Any {
      return registryOf(this);
    }
    animate(keyframes: Any, options?: Any): Any {
      const effect = new KeyframeEffect(this, keyframes, options);
      const given = options && typeof options === 'object' ? options : null;
      const animation = new Animation(
        effect,
        given && given.timeline !== undefined
          ? given.timeline
          : documentTimeline,
      );
      if (given?.id) animation.id = String(given.id);
      if (given?.rangeStart !== undefined) {
        animation.rangeStart = given.rangeStart;
      }
      if (given?.rangeEnd !== undefined) animation.rangeEnd = given.rangeEnd;
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
     *  as `Node`'s is. */
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
    focus(options?: Any): void {
      call('focus', this._id);
      // the focusing steps bring it into view, through the scroll
      // containers around it, where something else had it before (HTML
      // 6.6.3, unless `preventScroll`): as little as shows it, and where a
      // container snaps, at a snap position
      if (!options?.preventScroll && document.activeElement === this) {
        this._intoView('nearest', 'nearest', true);
      }
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
  /** A `[SameObject, PutForwards=value]` `DOMTokenList` over an
   *  attribute, with the tokens it supports: `relList` and `blocking`. */
  const tokenList = (attr: string, supported: readonly string[]): Any => ({
    get(this: Any): Any {
      const lists = (this._tokenLists ??= new Map<string, Any>());
      let list = lists.get(attr);
      if (!list) {
        list = new DOMTokenList(this, attr, supported);
        lists.set(attr, list);
      }
      return list;
    },
    set(this: Any, v: Any): void {
      this.setAttribute(attr, v);
    },
    enumerable: true,
    configurable: true,
  });
  // what Chromium's link types are (HTML 4.6.7)
  const LINK_TYPES = [
    'alternate',
    'dns-prefetch',
    'expect',
    'icon',
    'manifest',
    'modulepreload',
    'next',
    'preconnect',
    'prefetch',
    'preload',
    'search',
    'stylesheet',
  ];
  Object.defineProperty(
    HTMLLinkElement.prototype,
    'relList',
    tokenList('rel', LINK_TYPES),
  );
  // what a hyperlink's `rel` does something with (HTML 4.6.6), on an
  // `<a>` and on an `<area>`, which is one here
  Object.defineProperty(
    HTMLAnchorElement.prototype,
    'relList',
    tokenList('rel', ['noopener', 'noreferrer', 'opener']),
  );
  // the one blocking token there is (HTML 2.5.8)
  for (const Interface of [HTMLLinkElement, HTMLScriptElement]) {
    Object.defineProperty(
      Interface.prototype,
      'blocking',
      tokenList('blocking', ['render']),
    );
  }

  class HTMLTemplateElement extends HTMLElement {
    get content(): Any {
      return wrap(Number(call('content', this._id)));
    }
    /** `shadowrootmode`, as an enumerated attribute reads (HTML 4.12.3):
     *  `open` or `closed`, and nothing for anything else. */
    get shadowRootMode(): string {
      const mode = (this.getAttribute('shadowrootmode') ?? '').toLowerCase();
      return mode === 'open' || mode === 'closed' ? mode : '';
    }
    set shadowRootMode(v: Any) {
      this.setAttribute('shadowrootmode', str(v));
    }
  }
  Object.defineProperty(
    HTMLTemplateElement.prototype,
    'shadowRootDelegatesFocus',
    flag('shadowrootdelegatesfocus'),
  );
  Object.defineProperty(
    HTMLTemplateElement.prototype,
    'shadowRootClonable',
    flag('shadowrootclonable'),
  );
  Object.defineProperty(
    HTMLTemplateElement.prototype,
    'shadowRootSerializable',
    flag('shadowrootserializable'),
  );
  Object.defineProperty(
    HTMLTemplateElement.prototype,
    'shadowRootCustomElementRegistry',
    reflect('shadowrootcustomelementregistry'),
  );

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
    /** When it was opened, counted with the popovers shown (`opened`):
     *  Escape is a close request at the last of either. */
    openedAt: number;
  }
  const dialogStates = new WeakMap<Any, DialogState>();
  const dialogState = (el: Any): DialogState => {
    let state = dialogStates.get(el);
    if (!state) {
      state = {
        returnValue: '',
        previous: null,
        toggleFrom: null,
        openedAt: 0,
      };
      dialogStates.set(el, state);
    }
    return state;
  };
  /** How many dialogs have been opened and popovers shown: the order of
   *  their close watchers (HTML 7.7.1). */
  let opened = 0;
  /** The modal dialogs, in the order they were opened: the last one the
   *  host still says is modal is the top layer's top. */
  const modalDialogs: Any[] = [];
  /** Every dialog open, modal or not, in the order opened (HTML 4.11.4,
   *  the document's open dialogs list). */
  const openDialogs: Any[] = [];
  /** `closedby`'s state (HTML 4.11.4): `any`, `closerequest` or `none`
   *  as the attribute says, and where it says none of them, `closerequest`
   *  for a modal dialog and `none` for another. */
  const closedByOf = (el: Any): string => {
    const v = (el.getAttribute('closedby') ?? '').toLowerCase();
    if (v === 'any' || v === 'closerequest' || v === 'none') return v;
    return isModalDialog(el) ? 'closerequest' : 'none';
  };
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
    const open = openDialogs.indexOf(el);
    if (open >= 0) openDialogs.splice(open, 1);
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
  /** A close request (HTML 7.7.2) — Escape, not cancelled — at the last
   *  of the open dialogs and the showing auto and hint popovers to have
   *  opened: a popover hidden, or a dialog's `cancel`, which a page may
   *  cancel, and then the dialog closed, where its `closedby` lets a close
   *  request close it. A browser groups the dialogs opened with no press
   *  between them, and one Escape closes them all; this closes one at a
   *  time. */
  const closeRequest = (): void => {
    syncOpenDialogs();
    const dialog: Any = openDialogs[openDialogs.length - 1] ?? null;
    const popover = topPopover();
    if (
      popover &&
      (!dialog || popoverState(popover).openedAt > dialogState(dialog).openedAt)
    ) {
      hidePopoverOf(popover, true, true, false);
      return;
    }
    // one `closedby` says nothing closes takes the request all the same,
    // and closes no dialog under it
    if (dialog && closedByOf(dialog) !== 'none') requestClose(dialog, null);
  };
  /** The open dialogs list as the `open` attributes have it: a dialog
   *  open by its attribute — parsed open, or set by `setAttribute` — that
   *  `show()` did not open is in it too (HTML 4.11.4, the dialog's
   *  attribute change steps), ahead of those opened since, in tree order;
   *  and one that is closed, or out of the document, is in it no more. */
  const syncOpenDialogs = (): void => {
    for (let i = openDialogs.length - 1; i >= 0; i -= 1) {
      const d = openDialogs[i];
      if (!d.hasAttribute('open') || !d.isConnected) openDialogs.splice(i, 1);
    }
    const missing = Array.from(
      document.querySelectorAll('dialog[open]'),
    ).filter((d: Any) => !openDialogs.includes(d));
    if (missing.length) openDialogs.unshift(...missing);
  };
  /** A dialog opened: last of the open dialogs, and of the close watchers. */
  const dialogOpened = (el: Any): void => {
    const was = openDialogs.indexOf(el);
    if (was >= 0) openDialogs.splice(was, 1);
    openDialogs.push(el);
    dialogState(el).openedAt = opened += 1;
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
      dialogOpened(this);
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
      // a dialog showing as a popover is in the top layer as one already
      if (popoverShowing(this)) {
        throw new DOMException(
          "Failed to execute 'showModal' on 'HTMLDialogElement': The dialog is already open as a Popover, and therefore cannot be opened as a modal dialog.",
          'InvalidStateError',
        );
      }
      if (!beforeToggle(this, 'closed', 'open')) return;
      if (this.hasAttribute('open') || !this.isConnected) return;
      if (popoverShowing(this)) return;
      queueToggle(this, 'closed');
      this.setAttribute('open', '');
      call('modal', this._id, true);
      // last, where one taken out of the document and put back was before
      const was = modalDialogs.indexOf(this);
      if (was >= 0) modalDialogs.splice(was, 1);
      modalDialogs.push(this);
      dialogOpened(this);
      dialogState(this).previous = document.activeElement;
      // the popovers it is not in close, as it goes over them (HTML
      // 4.11.4.2, "hide all popovers until" its topmost popover ancestor)
      hidePopoversUntil(topmostPopoverAncestor(this, null), false, true);
      focusDialog(this);
    }
    close(result?: Any): void {
      closeDialog(this, result === undefined ? null : String(result));
    }
    requestClose(result?: Any): void {
      requestClose(this, result === undefined ? null : String(result));
    }
  }
  // `open` set is a dialog opened or closed as the attribute's change
  // steps have it: last of the open dialogs, or out of them
  Object.defineProperty(HTMLDialogElement.prototype, 'open', {
    get(this: Any): boolean {
      return this.hasAttribute('open');
    },
    set(this: Any, v: Any) {
      const was = this.hasAttribute('open');
      this.toggleAttribute('open', !!v);
      if (!was && v) dialogOpened(this);
      else if (was && !v) {
        const i = openDialogs.indexOf(this);
        if (i >= 0) openDialogs.splice(i, 1);
      }
    },
    configurable: true,
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'closedBy', {
    get(this: Any): string {
      return closedByOf(this);
    },
    set(this: Any, v: Any) {
      this.setAttribute('closedby', str(v));
    },
    configurable: true,
  });

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

  /**
   * A text field's selection as a script reads and sets it (HTML
   * 4.10.5.2.10). The host's (`selection`, `setSelection`): the widget's,
   * where core's field says — the caret the user left, the text they
   * selected — and shown by it, and else what a script last set, kept to
   * the value; the value's end where nothing was. A change a script makes
   * is told as `select` a task later, and one the user makes is told by
   * the host.
   */
  type FieldSelection = { start: number; end: number; dir: string };
  const fieldSelectionOf = (el: Any): FieldSelection => {
    const answer = str(call('selection', el._id) ?? '');
    if (!answer) {
      const length = el.value.length;
      return { start: length, end: length, dir: 'none' };
    }
    const [start, end, dir] = answer.split(' ');
    return { start: Number(start), end: Number(end), dir };
  };
  /** HTML's "set the selection range": the offsets as WebIDL's `unsigned
   *  long` takes them, clamped to the value and the start to the end, and
   *  `select` where the start, the end or the direction moved from `was`. */
  const selectField = (
    el: Any,
    start: Any,
    end: Any,
    dir: Any,
    was: FieldSelection = fieldSelectionOf(el),
  ): void => {
    const length = el.value.length;
    const to = Math.min(Number(end) >>> 0, length);
    let from = Math.min(Number(start) >>> 0, length);
    if (from > to) from = to;
    const direction = dir === 'forward' || dir === 'backward' ? dir : 'none';
    call('setSelection', el._id, from, to, direction);
    if (was.start === from && was.end === to && was.dir === direction) return;
    setTimer(
      () => dispatch(el, new Event('select', { bubbles: true })),
      0,
      [],
      false,
    );
  };
  /** A value set that changed it puts the caret at its end (HTML
   *  4.10.5.4), and selects nothing. */
  const valueSet = (el: Any, was: string): void => {
    const length = el.value.length;
    if (el.value !== was) call('setSelection', el._id, length, length, 'none');
  };
  /**
   * HTML's `setRangeText()` (4.10.5.2.10): `replacement` in place of
   * `[start, end)` — of the selection, where neither is given — and the
   * selection after it as `selectionMode` says, `preserve` keeping it
   * where it was around the edit. No `input`: the edit is the script's.
   */
  const setRangeText = (el: Any, args: Any[], kind: string): void => {
    const fail = (why: string): string =>
      `Failed to execute 'setRangeText' on '${kind}': ${why}`;
    if (args.length === 0 || args.length === 2) {
      throw new TypeError(
        fail(
          `${args.length === 0 ? 1 : 3} arguments required, but only ${args.length} present.`,
        ),
      );
    }
    const replacement = str(args[0]);
    const value = el.value;
    const now = fieldSelectionOf(el);
    let start = now.start;
    let end = now.end;
    let mode = 'preserve';
    if (args.length > 2) {
      start = Number(args[1]) >>> 0;
      end = Number(args[2]) >>> 0;
      if (args[3] !== undefined) mode = str(args[3]);
      if (!/^(select|start|end|preserve)$/.test(mode)) {
        throw new TypeError(
          fail(
            `The provided value '${mode}' is not a valid enum value of type SelectionMode.`,
          ),
        );
      }
      if (start > end) {
        throw new DOMException(
          fail(
            `The provided start index (${start}) is larger than the provided end index (${end}).`,
          ),
          'IndexSizeError',
        );
      }
    }
    start = Math.min(start, value.length);
    end = Math.min(end, value.length);
    call(
      'setValue',
      el._id,
      value.slice(0, start) + replacement + value.slice(end),
    );
    const after = start + replacement.length;
    let from = now.start;
    let to = now.end;
    if (mode === 'select') {
      from = start;
      to = after;
    } else if (mode === 'start') {
      from = to = start;
    } else if (mode === 'end') {
      from = to = after;
    } else {
      const delta = replacement.length - (end - start);
      if (from > end) from += delta;
      else if (from > start) from = start;
      if (to > end) to += delta;
      else if (to > start) to = after;
    }
    selectField(el, from, to, 'none', now);
  };
  /** The input types a selection is part of (HTML 4.10.5.1, the table of
   *  the APIs each type has). */
  const selects = (el: Any): boolean =>
    /^(text|search|url|tel|password)$/.test(el.type);
  /** The ones `select()` selects in besides: their text is a field's here,
   *  though a script reads no offsets into it. */
  const selectsAll = (el: Any): boolean =>
    selects(el) || /^(email|number)$/.test(el.type);
  const notSelectable = (el: Any, name: string): Any =>
    new DOMException(
      `Failed to set the '${name}' property on 'HTMLInputElement': The input element's type ('${el.type}') does not support selection.`,
      'InvalidStateError',
    );

  /** The input types `readonly` does not apply to, which it leaves
   *  mutable (HTML 4.10.5.3.3). */
  const READONLY_IGNORED = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ]);
  /**
   * `showPicker()` (HTML 4.10.5.4, and 4.10.7 for a `<select>`): a control
   * that is not mutable is refused, so is a call no press or key of the
   * user's is behind, and a `<select>` that is not being rendered has
   * nowhere to drop a menu from. Else the activation is spent, and the
   * host shows the picker where the control has one here — a drop-down
   * `<select>`'s menu — which `:open` matches while it is down. No focus
   * moves.
   */
  const showPicker = (el: Any, iface: string): void => {
    const refused = (message: string, name: string): Any =>
      new DOMException(
        `Failed to execute 'showPicker' on '${iface}': ${message}`,
        name,
      );
    const readOnly =
      el._name === 'input' &&
      el.hasAttribute('readonly') &&
      !READONLY_IGNORED.has(el.type);
    if (isDisabled(el) || readOnly) {
      throw refused(
        `${iface}::showPicker() cannot be used on immutable controls.`,
        'InvalidStateError',
      );
    }
    if (!hasTransientActivation()) {
      throw refused(
        `${iface}::showPicker() requires a user gesture.`,
        'NotAllowedError',
      );
    }
    if (call('showPicker', el._id) === 'unrendered') {
      throw refused(
        `${iface}::showPicker() requires the select is rendered.`,
        'NotSupportedError',
      );
    }
    consumeActivation();
  };

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
        const was = this.value;
        call('setValue', this._id, v === null ? '' : str(v));
        valueSet(this, was);
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
    // Every input has a checkedness (HTML 4.10.5), which a box's and a
    // radio's widget shows and no other type's does: there it is the
    // element's alone, its attribute until a script sets it. React sets
    // `checked` on every input it mounts, and a text field's set as its
    // text showed `false`.
    get checked(): boolean {
      const type = this.type;
      if (type === 'checkbox' || type === 'radio') {
        return controlValue(this) === true;
      }
      return this._checkedness ?? this.hasAttribute('checked');
    }
    set checked(v: Any) {
      const type = this.type;
      if (type === 'checkbox' || type === 'radio') {
        call('setValue', this._id, !!v);
      } else this._checkedness = !!v;
    }
    /** A checkedness a script set on a type no widget shows it for. */
    _checkedness?: boolean;
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
    select(): void {
      if (selectsAll(this)) selectField(this, 0, this.value.length, 'none');
    }
    setSelectionRange(start: Any, end: Any, direction?: Any): void {
      if (!selects(this)) throw notSelectable(this, 'setSelectionRange');
      selectField(this, start, end, direction);
    }
    setRangeText(...args: Any[]): void {
      if (!selects(this)) throw notSelectable(this, 'setRangeText');
      setRangeText(this, args, 'HTMLInputElement');
    }
    get selectionStart(): number | null {
      return selects(this) ? fieldSelectionOf(this).start : null;
    }
    set selectionStart(v: Any) {
      if (!selects(this)) throw notSelectable(this, 'selectionStart');
      const now = fieldSelectionOf(this);
      selectField(this, v, Math.max(Number(v) >>> 0, now.end), now.dir);
    }
    get selectionEnd(): number | null {
      return selects(this) ? fieldSelectionOf(this).end : null;
    }
    set selectionEnd(v: Any) {
      if (!selects(this)) throw notSelectable(this, 'selectionEnd');
      const now = fieldSelectionOf(this);
      selectField(this, now.start, v, now.dir);
    }
    get selectionDirection(): string | null {
      return selects(this) ? fieldSelectionOf(this).dir : null;
    }
    set selectionDirection(v: Any) {
      if (!selects(this)) throw notSelectable(this, 'selectionDirection');
      const now = fieldSelectionOf(this);
      selectField(this, now.start, now.end, v);
    }
    stepUp(): void {}
    stepDown(): void {}
    showPicker(): void {
      showPicker(this, 'HTMLInputElement');
    }
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
      const was = this.value;
      call('setValue', this._id, v === null ? '' : str(v));
      valueSet(this, was);
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
    select(): void {
      selectField(this, 0, this.value.length, 'none');
    }
    setSelectionRange(start: Any, end: Any, direction?: Any): void {
      selectField(this, start, end, direction);
    }
    setRangeText(...args: Any[]): void {
      setRangeText(this, args, 'HTMLTextAreaElement');
    }
    get selectionStart(): number {
      return fieldSelectionOf(this).start;
    }
    set selectionStart(v: Any) {
      const now = fieldSelectionOf(this);
      selectField(this, v, Math.max(Number(v) >>> 0, now.end), now.dir);
    }
    get selectionEnd(): number {
      return fieldSelectionOf(this).end;
    }
    set selectionEnd(v: Any) {
      const now = fieldSelectionOf(this);
      selectField(this, now.start, v, now.dir);
    }
    get selectionDirection(): string {
      return fieldSelectionOf(this).dir;
    }
    set selectionDirection(v: Any) {
      const now = fieldSelectionOf(this);
      selectField(this, now.start, now.end, v);
    }
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
    showPicker(): void {
      showPicker(this, 'HTMLSelectElement');
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

  // --- popovers (HTML 6.12) ----------------------------------------------------------
  //
  // An element with a `popover` attribute is shown and hidden by the page:
  // `showPopover()`, `hidePopover()`, `togglePopover()`, or a button whose
  // `popovertarget` names it. Whether one is showing is the host's
  // (`popoverOpen`), which puts it in the top layer, makes it
  // `:popover-open`, and hides it as it is taken out of the document. What
  // is the page's is here: the stacks an auto and a hint popover go on,
  // `beforetoggle` and `toggle`, the focus, and the light dismiss a press
  // outside them or Escape makes.

  interface PopoverState {
    /** Being hidden, while its events run (HTML's popover hiding). */
    hiding: boolean;
    /** The mode it is showing in, `auto`, `hint` or `manual`, and null
     *  while it is hidden (HTML's opened in popover mode). */
    mode: string | null;
    /** What showed it: a button, or the `source` a script named. */
    trigger: Any;
    /** What had the focus as the first popover of a stack was shown,
     *  given back as it is hidden. */
    previous: Any;
    /** The state its pending `toggle` started from, while one is. */
    toggleFrom: string | null;
    /** When it was shown, counted with the dialogs opened (`opened`). */
    openedAt: number;
  }
  const popoverStates = new WeakMap<Any, PopoverState>();
  const popoverState = (el: Any): PopoverState => {
    let state = popoverStates.get(el);
    if (!state) {
      state = {
        hiding: false,
        mode: null,
        trigger: null,
        previous: null,
        toggleFrom: null,
        openedAt: 0,
      };
      popoverStates.set(el, state);
    }
    return state;
  };
  /** The document's showing auto and hint popovers, in the order they went
   *  into the top layer. */
  const autoPopovers: Any[] = [];
  const hintPopovers: Any[] = [];
  /** The auto popover the showing hints hang off, where they do (HTML's
   *  hint stack parent). */
  let hintStackParent: Any = null;
  /** A popover being shown, and how many are being hidden: no popover is
   *  shown meanwhile. */
  let showingPopover = false;
  let hidingPopovers = 0;
  /** `popover`'s state: `auto` for an empty or `auto` value, `hint`, and
   *  `manual` for any other; null for none. */
  const popoverType = (el: Any): string | null => {
    const v = el?.getAttribute?.('popover');
    if (v === null || v === undefined) return null;
    const lower = String(v).toLowerCase();
    if (lower === '' || lower === 'auto') return 'auto';
    return lower === 'hint' ? 'hint' : 'manual';
  };
  const popoverShowing = (el: Any): boolean =>
    call('popoverOpen', el._id) === true;
  /** A stack with what the host has hidden since — taken out of the
   *  document — left out. */
  const prune = (stack: Any[]): Any[] => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (!popoverShowing(stack[i])) stack.splice(i, 1);
    }
    if (hintStackParent && !popoverShowing(hintStackParent)) {
      hintStackParent = null;
    }
    return stack;
  };
  /** HTML's "topmost auto or hint popover": the last hint showing, or the
   *  last auto popover. */
  const topPopover = (): Any => {
    prune(autoPopovers);
    prune(hintPopovers);
    return hintPopovers.at(-1) ?? autoPopovers.at(-1) ?? null;
  };
  /** HTML's "check popover validity": whether `el` can be shown, or
   *  hidden, now — throwing for a page's call where it never could. */
  const popoverValid = (
    el: Any,
    expectShowing: boolean,
    raise: boolean,
  ): boolean => {
    if (popoverType(el) === null) {
      if (!raise) return false;
      throw new DOMException(
        "Not supported on elements that do not have a valid value for the 'popover' attribute.",
        'NotSupportedError',
      );
    }
    if (popoverShowing(el) !== expectShowing) return false;
    const fail = (message: string): boolean => {
      if (raise) throw new DOMException(message, 'InvalidStateError');
      return false;
    };
    // one being hidden may be out of the document already
    if (!expectShowing && !el.isConnected) {
      return fail('Invalid on disconnected popover elements.');
    }
    if (el instanceof HTMLDialogElement && isModalDialog(el)) {
      return fail('Invalid on popover elements that are modal dialogs.');
    }
    return true;
  };
  /** A node's parent in the flat tree: its slot, closed tree or open, or
   *  a shadow root's host. */
  const flatParentNode = (node: Any): Any =>
    (node && (node.nodeType === 1 || node.nodeType === 3)
      ? wrap(Number(call('assignedSlot', node._id, true)))
      : null) ??
    (node?.parentNode instanceof ShadowRoot
      ? node.parentNode.host
      : (node?.parentNode ?? null));
  /** Whether `node` is in `outer` in the flat tree, and not it. */
  const flatlyIn = (outer: Any, node: Any): boolean => {
    for (let at = flatParentNode(node); at; at = flatParentNode(at)) {
      if (at === outer) return true;
    }
    return false;
  };
  /** HTML's "nearest inclusive open popover": the showing auto or hint
   *  popover around a node, itself included. */
  const nearestOpenPopover = (node: Any): Any => {
    for (let at = node; at; at = flatParentNode(at)) {
      if (!(at instanceof Element)) continue;
      const mode = popoverStates.get(at)?.mode;
      if ((mode === 'auto' || mode === 'hint') && popoverShowing(at)) {
        return at;
      }
    }
    return null;
  };
  /** HTML's "nearest inclusive target popover": the showing auto or hint
   *  popover a button around a node targets. */
  const nearestTargetPopover = (node: Any): Any => {
    for (let at = node; at; at = flatParentNode(at)) {
      const target = at instanceof Element ? popoverTargetOf(at) : null;
      const type = popoverType(target);
      if ((type === 'auto' || type === 'hint') && popoverShowing(target)) {
        return target;
      }
    }
    return null;
  };
  /** HTML's "topmost popover ancestor": the last of the showing auto
   *  popovers, then hints, that `el`, or what showed it, is in. */
  const topmostPopoverAncestor = (el: Any, source: Any): Any => {
    const combined = [...prune(autoPopovers), ...prune(hintPopovers)];
    let at = -1;
    for (let i = combined.length - 1; i >= 0 && at < 0; i -= 1) {
      if (flatlyIn(combined[i], el)) at = i;
    }
    if (source) {
      for (let i = combined.length - 1; i > at; i -= 1) {
        if (flatlyIn(combined[i], source)) {
          at = i;
          break;
        }
      }
    }
    return at < 0 ? null : combined[at];
  };
  /** HTML's "hide popover stack until": the popovers of one stack above
   *  `endpoint`, or all of them for none, the last first — and any shown
   *  meanwhile, by a page's handler, after them. */
  const hideStackUntil = (
    endpoint: Any,
    kind: 'auto' | 'hint',
    focusPrevious: boolean,
    fireEvents: boolean,
  ): void => {
    const stack = (): Any[] =>
      prune(kind === 'auto' ? autoPopovers : hintPopovers);
    const before = stack();
    const at = endpoint ? before.indexOf(endpoint) : -1;
    const keep = before.slice(0, at + 1);
    for (const popover of before.slice(at + 1).reverse()) {
      hidePopoverOf(popover, focusPrevious, fireEvents, false);
    }
    for (const popover of stack().slice().reverse()) {
      if (!keep.includes(popover)) {
        hidePopoverOf(popover, focusPrevious, false, false);
      }
    }
  };
  /** HTML's "hide popovers until": the hints above `endpoint`, and the
   *  auto popovers above it — above the auto one its hint stack hangs off,
   *  where it is a hint — or every popover, for none. */
  const hidePopoversUntil = (
    endpoint: Any,
    focusPrevious: boolean,
    fireEvents: boolean,
  ): void => {
    const isHint = !!endpoint && prune(hintPopovers).includes(endpoint);
    hideStackUntil(endpoint, 'hint', focusPrevious, fireEvents);
    hideStackUntil(
      isHint ? hintStackParent : endpoint,
      'auto',
      focusPrevious,
      fireEvents,
    );
  };
  /** `toggle`, in a task of its own, one for any number of changes before
   *  it runs, from the state the first started from. */
  const queuePopoverToggle = (el: Any, from: string): void => {
    const state = popoverState(el);
    if (state.toggleFrom !== null) return;
    state.toggleFrom = from;
    setTimer(
      () => {
        const old = state.toggleFrom ?? from;
        state.toggleFrom = null;
        const now = popoverShowing(el) ? 'open' : 'closed';
        const ev = new ToggleEvent('toggle', { oldState: old, newState: now });
        ev.isTrusted = true;
        dispatch(el, ev);
      },
      0,
      [],
      false,
    );
  };
  /** HTML's "show popover": the popovers it is not nested in hidden, an
   *  auto popover in a hint made a hint, the popover put in the top layer
   *  and on its stack, and the focus given to what in it is `autofocus`. */
  const showPopoverOf = (el: Any, raise: boolean, source: Any): void => {
    if (showingPopover || hidingPopovers) {
      if (raise) {
        throw new DOMException(
          'A popover cannot be shown while another is being shown or hidden.',
          'InvalidStateError',
        );
      }
      return;
    }
    if (!popoverValid(el, false, raise)) return;
    showingPopover = true;
    try {
      if (!beforeToggle(el, 'closed', 'open')) return;
      if (!popoverValid(el, false, raise)) return;
      const original = popoverType(el);
      let effective = original;
      let ancestor: Any = null;
      if (original === 'auto' || original === 'hint') {
        ancestor = topmostPopoverAncestor(el, source);
        if (
          ancestor &&
          popoverState(ancestor).mode === 'hint' &&
          effective === 'auto'
        ) {
          effective = 'hint';
        }
        hideStackUntil(ancestor, 'hint', false, true);
        if (effective === 'auto') hideStackUntil(ancestor, 'auto', false, true);
      }
      // the events may have changed what it is, or hidden it, or shown it
      if (original !== popoverType(el)) {
        if (raise) {
          throw new DOMException(
            "The popover's type changed while it was being shown.",
            'InvalidStateError',
          );
        }
        return;
      }
      if (!popoverValid(el, false, raise)) return;
      const restore = topPopover() === null;
      const focused = document.activeElement;
      // what showed it is its implicit anchor element, from now until it
      // is hidden
      call(
        'popoverOpen',
        el._id,
        true,
        source instanceof Element ? source._id : null,
      );
      if (!popoverShowing(el)) return;
      const state = popoverState(el);
      state.mode = effective;
      if (effective === 'auto') autoPopovers.push(el);
      else if (effective === 'hint') {
        hintPopovers.push(el);
        if (ancestor && popoverState(ancestor).mode === 'auto') {
          hintStackParent = ancestor;
        }
      }
      state.trigger = source ?? null;
      state.openedAt = opened += 1;
      // HTML's "popover focusing steps": a dialog's own, or what in it is
      // `autofocus`, and nothing where nothing is
      if (el instanceof HTMLDialogElement) focusDialog(el);
      else {
        const control = el.hasAttribute('autofocus')
          ? el
          : el.querySelector('[autofocus]');
        control?.focus();
      }
      state.previous = restore ? focused : null;
      queuePopoverToggle(el, 'closed');
    } finally {
      showingPopover = false;
    }
  };
  /** HTML's "hide popover": the popovers above it hidden first, out of the
   *  top layer and off its stack, and the focus given back where it was
   *  in it. */
  const hidePopoverOf = (
    el: Any,
    focusPrevious: boolean,
    fireEvents: boolean,
    raise: boolean,
  ): void => {
    if (!popoverValid(el, true, raise)) return;
    const state = popoverState(el);
    const nested = state.hiding;
    state.hiding = true;
    if (nested) fireEvents = false;
    hidingPopovers += 1;
    try {
      const inAuto = prune(autoPopovers).includes(el);
      const inHint = prune(hintPopovers).includes(el);
      if (state.mode === 'auto' || state.mode === 'hint') {
        if (inHint) hideStackUntil(el, 'hint', focusPrevious, fireEvents);
        if (el === hintStackParent) {
          hideStackUntil(null, 'hint', focusPrevious, fireEvents);
        }
        if (inAuto) hideStackUntil(el, 'auto', focusPrevious, fireEvents);
        if (!popoverValid(el, true, raise)) return;
      }
      if (fireEvents) {
        beforeToggle(el, 'open', 'closed');
        if (!popoverValid(el, true, raise)) return;
      }
      call('popoverOpen', el._id, false);
      for (const stack of [autoPopovers, hintPopovers]) {
        const i = stack.indexOf(el);
        if (i >= 0) stack.splice(i, 1);
      }
      state.trigger = null;
      state.mode = null;
      if (el === hintStackParent || !prune(hintPopovers).length) {
        hintStackParent = null;
      }
      if (fireEvents) queuePopoverToggle(el, 'open');
      const previous = state.previous;
      if (previous) {
        state.previous = null;
        const active = document.activeElement;
        if (focusPrevious && active && el.contains(active)) previous.focus();
      }
    } finally {
      if (!nested) state.hiding = false;
      hidingPopovers -= 1;
    }
  };
  /** The element a button's `popovertarget` names: the one a script set,
   *  while it is in the button's tree, or the one with the id there. */
  const explicitPopoverTargets = new WeakMap<Any, Any>();
  const popoverTargetAttribute = (el: Any): Any => {
    const id = el.getAttribute('popovertarget');
    if (id === null) return null;
    const set = explicitPopoverTargets.get(el);
    if (set && id === '') {
      return set.getRootNode() === el.getRootNode() ? set : null;
    }
    if (!id) return null;
    const root = el.getRootNode();
    return root.getElementById
      ? root.getElementById(id)
      : (root.querySelector?.(`#${cssEscape(id)}`) ?? null);
  };
  /** HTML's "popover target element": the popover a button that is not
   *  disabled, nor a form's submit button, shows and hides. */
  const popoverTargetOf = (el: Any): Any => {
    const button =
      el instanceof HTMLButtonElement ||
      (el instanceof HTMLInputElement &&
        ['submit', 'reset', 'image', 'button'].includes(el.type));
    if (!button || isDisabled(el)) return null;
    const submits =
      el instanceof HTMLButtonElement
        ? el.type === 'submit'
        : el.type === 'submit' || el.type === 'image';
    if (submits && el.form) return null;
    const target = popoverTargetAttribute(el);
    return popoverType(target) === null ? null : target;
  };
  /** HTML's "popover target attribute activation behavior". */
  const popoverTargetActivate = (
    button: Any,
    popover: Any,
    eventTarget: Any,
  ): void => {
    if (
      popover.contains(eventTarget) &&
      button !== popover &&
      button.contains(popover)
    ) {
      return;
    }
    const action = button.popoverTargetAction;
    const showing = popoverShowing(popover);
    if (action === 'show' && showing) return;
    if (action === 'hide' && !showing) return;
    if (showing) hidePopoverOf(popover, true, true, false);
    else if (popoverValid(popover, false, false)) {
      showPopoverOf(popover, false, button);
    }
  };
  /** A click not cancelled, at a button whose `popovertarget` names a
   *  popover, or in one: the popover shown, hidden or toggled (HTML 6.12,
   *  the popover target attribute activation behavior). A form's submit
   *  button has none, and submits. */
  const popoverActivation = (target: Any): void => {
    for (let at: Any = target; at instanceof Element; at = at.parentNode) {
      if (at instanceof HTMLButtonElement || at instanceof HTMLInputElement) {
        const popover = popoverTargetOf(at);
        if (popover) popoverTargetActivate(at, popover, target);
        return;
      }
    }
  };
  /** The press a light dismiss started at (HTML 6.12, the document's
   *  popover pointerdown target and its dialog pointerdown target). */
  let pressedPopover: Any = null;
  let pressedDialog: Any = null;
  /** A popover's place in the stacks, from 1, hints after the auto
   *  popovers; 0 for none (HTML's "popover stack position"). */
  const stackPosition = (popover: Any): number => {
    if (!popover) return 0;
    const autos = prune(autoPopovers);
    const hint = prune(hintPopovers).indexOf(popover);
    if (hint >= 0) return autos.length + hint + 1;
    return autos.indexOf(popover) + 1;
  };
  /** HTML's "topmost clicked popover": the later in the stacks of the
   *  popover a node is in and the one a button around it targets. */
  const topmostClickedPopover = (node: Any): Any => {
    const inside = nearestOpenPopover(node);
    const targeted = nearestTargetPopover(node);
    return stackPosition(inside) > stackPosition(targeted) ? inside : targeted;
  };
  /** HTML's "nearest clicked dialog": the open dialog a press is in — not a
   *  modal one's backdrop, outside its box. */
  const nearestClickedDialog = (node: Any, x: number, y: number): Any => {
    if (node instanceof HTMLDialogElement && isModalDialog(node)) {
      const box = node.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) {
        return null;
      }
    }
    for (let at = node; at; at = flatParentNode(at)) {
      if (at instanceof HTMLDialogElement && at.hasAttribute('open')) {
        return at;
      }
    }
    return null;
  };
  /** HTML's light dismiss of the open popovers and dialogs, at a press and
   *  its release: a release where the press was, outside them, hides the
   *  popovers it is not in, and closes the last dialog where its
   *  `closedby` is `any`. */
  const lightDismiss = (
    type: string,
    target: Any,
    x: number,
    y: number,
  ): void => {
    if (topPopover()) {
      const ancestor = topmostClickedPopover(target);
      if (type === 'pointerdown') pressedPopover = ancestor;
      else {
        const same = ancestor === pressedPopover;
        pressedPopover = null;
        if (same) hidePopoversUntil(ancestor, false, true);
      }
    }
    syncOpenDialogs();
    if (!openDialogs.length) return;
    const clicked = nearestClickedDialog(target, x, y);
    if (type === 'pointerdown') {
      pressedDialog = clicked;
      return;
    }
    const same = clicked === pressedDialog;
    pressedDialog = null;
    const top = openDialogs[openDialogs.length - 1];
    if (!same || clicked === top || closedByOf(top) !== 'any') return;
    requestClose(top, null);
  };
  Object.defineProperties(HTMLElement.prototype, {
    popover: {
      get(this: Any): string | null {
        return popoverType(this);
      },
      set(this: Any, v: Any) {
        if (v === null) this.removeAttribute('popover');
        else this.setAttribute('popover', str(v));
      },
      configurable: true,
    },
    showPopover: {
      value(this: Any, options?: Any): void {
        const source =
          options && typeof options === 'object'
            ? (options.source ?? null)
            : null;
        showPopoverOf(this, true, source);
      },
      writable: true,
      configurable: true,
    },
    hidePopover: {
      value(this: Any): void {
        hidePopoverOf(this, true, true, true);
      },
      writable: true,
      configurable: true,
    },
    togglePopover: {
      value(this: Any, options?: Any): boolean {
        let force: Any;
        let source: Any = null;
        if (typeof options === 'boolean') force = options;
        else if (options && typeof options === 'object') {
          force = options.force;
          source = options.source ?? null;
        }
        const showing = popoverShowing(this);
        if (showing && force !== true) hidePopoverOf(this, true, true, true);
        else if (!showing && force !== false) {
          showPopoverOf(this, true, source);
        } else popoverValid(this, showing, true);
        return popoverShowing(this);
      },
      writable: true,
      configurable: true,
    },
  });
  for (const Kind of [HTMLButtonElement, HTMLInputElement]) {
    Object.defineProperty(Kind.prototype, 'popoverTargetElement', {
      get(this: Any): Any {
        return popoverTargetAttribute(this);
      },
      set(this: Any, v: Any) {
        if (v === null || v === undefined) {
          explicitPopoverTargets.delete(this);
          this.removeAttribute('popovertarget');
          return;
        }
        if (!(v instanceof Element)) {
          throw new TypeError(
            "Failed to set the 'popoverTargetElement' property: The provided value is not of type 'Element'.",
          );
        }
        explicitPopoverTargets.set(this, v);
        this.setAttribute('popovertarget', '');
      },
      configurable: true,
    });
    Object.defineProperty(Kind.prototype, 'popoverTargetAction', {
      get(this: Any): string {
        const v = (
          this.getAttribute('popovertargetaction') ?? ''
        ).toLowerCase();
        return v === 'show' || v === 'hide' ? v : 'toggle';
      },
      set(this: Any, v: Any) {
        this.setAttribute('popovertargetaction', str(v));
      },
      configurable: true,
    });
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
      submitForm(this, null, false);
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
      if (dispatch(this, ev)) submitForm(this, submitter ?? null, false);
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
    if (frameDocsAt !== opEpoch || frameDocsIn !== taskEpoch) {
      frameDocs.clear();
      frameDocsAt = opEpoch;
      frameDocsIn = taskEpoch;
    }
    let id = frameDocs.get(frame._id);
    if (id === undefined) {
      id = Number(call('frameDocument', frame._id));
      frameDocs.set(frame._id, id);
    }
    return id ? wrap(id) : null;
  };
  /** The document each frame holds, as last asked, while no op has run in
   *  this task: one is another only by an op of the page's — the frame put
   *  in, taken out, written into — or by a navigation, which the host
   *  finishes in a task of its own. Every read of a frame's window asks
   *  it (`frameProxyOf`), and an ad library scans every frame's. */
  const frameDocs = new Map<number, number>();
  let frameDocsAt = -1;
  let frameDocsIn = -1;

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
  /** The page's `CSS` namespace, which a frame's window copies with its
   *  own `highlights` (`frameWindowOf`). Made where `CSS` is defined. */
  let cssNamespace: Any = null;
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
    'navigation',
    'visualViewport',
    'scrollTo',
    'scroll',
    'scrollBy',
    'postMessage',
    'addEventListener',
    'removeEventListener',
    'dispatchEvent',
    'customElements',
    // its own `CSS.highlights`, its document's (`registryFor`)
    'CSS',
    // what is answered for its own viewport (`viewportFor`)
    'matchMedia',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]);
  const crossOrigin = (): Any =>
    new DOMException(
      `Blocked a frame with origin "${location.origin}" from accessing a cross-origin frame.`,
      'SecurityError',
    );
  /** The window each frame's document has (HTML 7.2.2), made as it is
   *  first reached. */
  const frameWindows = new WeakMap<object, Any>();
  /** Each frame document's session history: its entries are the frame's,
   *  and what leaves them is the frame's navigation (`frameNavigate`). */
  const frameSessions = new WeakMap<object, Any>();
  /** Where each frame document's window hears its events: the target its
   *  `on…` handlers and listeners are kept on, which a navigation that
   *  leaves the document tells (`documentTree`). */
  const frameTargets = new WeakMap<object, Any>();
  const frameSessionOf = (frame: Any, doc: Any, target: Any): Any => {
    let made = frameSessions.get(doc);
    if (!made) {
      const at = (): string => String(call('frameLocation', frame._id));
      // the document the session is of, which its initial `about:blank`'s
      // hands on to the frame's first (`frameWindowOf`)
      const owner = { doc };
      made = makeSession({
        owner: () => owner.doc,
        // in the document while its document is the frame's (HTML 7.3.3,
        // "fully active"): one a navigation left is unloaded
        active: () => frame.isConnected && !owner.doc._unloaded,
        url: at,
        // a frame's document's address, or for `about:blank` its creator's
        base: () => (/^about:/.test(at()) ? document.baseURI : at()),
        // a frame's document the page reaches into is the one it loaded
        loaded: () => true,
        setUrl: (url) => void call('setFrameLocation', frame._id, url),
        // the frame's document now: a window kept from its initial
        // `about:blank` keeps its session too (`frameWindowOf`)
        doc: () => frameDocumentOf(frame) ?? doc,
        target,
        away: (url) => void call('frameNavigate', frame._id, url),
        tellsFragments: false,
        reload: () => {
          if (unloadAllowed(owner.doc, target)) {
            call('frameNavigate', frame._id, at());
          }
        },
        go: () => {},
        // a frame's scroll is its own document's, which no entry keeps
        scroll: () => [0, 0],
        scrollTo: () => {},
        // its initial `about:blank` keeps no entries the API shows
        disabled: () => call('frameInitialBlank', frame._id) === true,
      });
      made.owner = owner;
      frameSessions.set(doc, made);
    }
    return made;
  };
  /** The window each frame's document was handed last, and whether that
   *  document is the frame's initial `about:blank` (`frameWindowOf`). */
  const keptFrameWindows = new WeakMap<
    object,
    { win: Any; doc: Any; initial: boolean; setDoc: (doc: Any) => void }
  >();
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
    // the first document a frame loads after its initial `about:blank`
    // keeps that one's window, and with it what the page set on it — a
    // handler on its `navigation` among them (HTML 7.4.6.2, "initialize the
    // document object")
    const last = keptFrameWindows.get(frame);
    if (last?.initial && last.doc !== doc) {
      last.setDoc(doc);
      last.initial = call('frameInitialBlank', frame._id) === true;
      const made = frameSessions.get(last.doc);
      if (made) {
        made.session.entries = [
          sessionEntry(String(call('frameLocation', frame._id))),
        ];
        made.session.index = 0;
        made.owner.doc = doc;
        frameSessions.set(doc, made);
      }
      frameTargets.set(doc, frameTargets.get(last.doc));
      // shown once it is the frame's, which it is only once it is in
      if (!last.initial) doc._pageShowing = true;
      last.doc = doc;
      frameWindows.set(doc, last.win);
      return last.win;
    }
    let current = doc;
    const proxy = frameProxyOf(frame);
    const target = new EventTarget();
    targetWindows.set(target, proxy);
    // its own viewport, the frame's content box, which its size, its media
    // queries and its rendering steps are of
    const view = viewportFor(frame, () => current, target);
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
      String(call('frameSize', current._id)).split(' ').map(Number);
    const own: Record<string, () => Any> = {
      window: () => proxy,
      self: () => proxy,
      frames: () => proxy,
      globalThis: () => proxy,
      parent: () => windowOfDocument(frame.ownerDocument) ?? proxy,
      top: () => G,
      opener: () => null,
      frameElement: () => frame,
      document: () => current,
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
      visualViewport: () => visualOf(view),
      // its own session history (`makeSession`), made as it is asked for
      history: () => frameSessionOf(frame, current, target).history,
      navigation: () => frameSessionOf(frame, current, target).navigation,
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
    // a window's own `CSS` namespace (CSS Highlight API 1, 3.2), whose
    // highlights are its document's and drawn there
    Object.defineProperty(win, 'CSS', {
      value: { ...cssNamespace, highlights: registryFor(() => current) },
      writable: true,
      configurable: true,
      enumerable: false,
    });
    // a window's own global registry (HTML 4.13.4), for the elements its
    // document makes: a frame defines its names apart from the page, and
    // they upgrade, and are made, in the document it shows
    const registry = globalRegistry(() => current);
    Object.defineProperty(win, 'customElements', {
      get: () => registry,
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
      addEventListener: (type: Any, fn: Any, options?: Any) => {
        target.addEventListener(type, fn, options);
        if (String(type) === 'resize' && fn) watchViewport(view);
      },
      removeEventListener: (type: Any, fn: Any, options?: Any) =>
        target.removeEventListener(type, fn, options),
      dispatchEvent: (event: Any) => {
        if (!(event instanceof Event)) throw new TypeError('not an Event');
        event.isTrusted = false;
        return dispatch(target, event);
      },
      postMessage: (message: Any, options?: Any, transfer?: Any) =>
        postTo(target, message, options, transfer),
      scrollTo() {},
      scroll() {},
      scrollBy() {},
      matchMedia: (query: Any) => mediaListIn(view, query),
      requestAnimationFrame: (fn: Any) => {
        if (typeof fn !== 'function') {
          throw new TypeError(
            "Failed to execute 'requestAnimationFrame' on 'Window': The callback provided as parameter 1 is not a function.",
          );
        }
        const id = ++view.seq;
        view.callbacks.set(id, fn);
        watchViewport(view);
        wantFrame();
        return id;
      },
      cancelAnimationFrame: (id: Any) => {
        view.callbacks.delete(Number(id));
      },
    };
    for (const [key, value] of Object.entries(methods)) {
      Object.defineProperty(win, key, {
        value,
        writable: true,
        configurable: true,
      });
    }
    for (const type of [
      'load',
      'error',
      'message',
      'resize',
      'beforeunload',
      'pagehide',
      'pageshow',
      'pageswap',
      'pagereveal',
      'unload',
    ]) {
      Object.defineProperty(win, `on${type}`, {
        get: () => target._handlers[type] ?? null,
        set: (fn: Any) => {
          target._handlers[type] = typeof fn === 'function' ? fn : null;
          if (type === 'resize' && typeof fn === 'function') {
            watchViewport(view);
          }
        },
        configurable: true,
      });
    }
    Object.defineProperty(win, Symbol.toStringTag, {
      value: 'Window',
      configurable: true,
    });
    frameWindows.set(doc, win);
    frameTargets.set(doc, target);
    const initial = call('frameInitialBlank', frame._id) === true;
    // a frame's document is put in once it has loaded, and is shown from
    // then on (HTML 7.4.6.5): its initial `about:blank` is never
    if (!initial) doc._pageShowing = true;
    keptFrameWindows.set(frame, {
      win,
      doc,
      initial,
      setDoc: (d: Any) => {
        current = d;
      },
    });
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
   *  `from` is 0 for a frame's parent, or this realm's frame there, and
   *  `name` what this realm calls that one (`realmAcross`). The ports it
   *  transfers are made there, each at the end of a wire whose other end
   *  takes the port's place here. */
  const deliverInto =
    (global: Any, from: number, name: number) =>
    (message: Any, options?: Any, transfer?: Any): void => {
      // the origin a message is meant for is the window's it is posted to
      // (HTML 9.4.3), which another origin's frame is not this one's
      const allowed = originAllowed(options, str(global.__origin()));
      // the ports alone: a canvas or a bitmap is no other realm's to make
      const moving = transfersOf(
        transferListOf(
          options !== null && typeof options === 'object' ? options : transfer,
        ),
      ).filter((item) => item instanceof MessagePort);
      if (!allowed) return;
      const named = moving.map(() => `${WIRE_REALM}.${++wireSeq}`);
      global.__message(message, location.origin, from, moving, named);
      const across = realmAcross(name);
      moving.forEach((port, i) => {
        const end = wireEnd(across, named[i]);
        for (const [data, ports] of movePort(port, end)) {
          end._deliver(data, ports);
        }
      });
    };
  /** Another of the page's realms, as a port can be across it: `name` 0
   *  for this realm's parent, else its frame's id here. What crosses is a
   *  string, to that realm's `__wire`, which names this one back. */
  const realmsAcross = new Map<number, Across>();
  const realmAcross = (name: number): Across => {
    let across = realmsAcross.get(name);
    if (!across) {
      across = {
        key: `r${name}`,
        send: (text) => {
          if (name === 0) parentLink?.global.__wire(parentLink.frame, text);
          else linkedFrames.get(name)?.__wire(0, text);
        },
      };
      realmsAcross.set(name, across);
    }
    return across;
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
          if (linked && key === 'postMessage') {
            return deliverInto(linked, 0, frame._id);
          }
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
    const go = (url: Any, replace = false): void => {
      const href = String(call('resolve', str(url)));
      const doc = frameDocumentOf(frame);
      const made = doc && frameSessions.get(doc);
      if (made) {
        navigateTo(
          made.session,
          href,
          pushOrReplace(made.session, href, replace),
        );
      } else {
        // a window no session was made for yet still hears it is left
        const target = doc && frameTargets.get(doc);
        if (
          target &&
          !fragmentOf(String(call('frameLocation', frame._id)), href) &&
          !unloadAllowed(doc, target)
        ) {
          return;
        }
        call('frameNavigate', frame._id, href);
      }
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
      replace: {
        value(url: Any) {
          go(url, true);
        },
      },
      reload: {
        value() {
          go(at(), true);
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
   * as the tree's changes go to `<Html>` once a task. An `OffscreenCanvas`
   * holds one too, which goes to its placeholder's box where it has one.
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
    /** The canvas's size the bitmap was made for, `w,h`: a `bitmaprenderer`
     *  context's bitmap is its image's size, which only a new size of the
     *  canvas's sets back. */
    sized: string;
  }
  const canvases = new WeakMap<object, CanvasState>();
  const dirtyCanvases = new Set<Any>();
  let canvasFlush = false;
  /** The `<canvas>`es that handed their control to an `OffscreenCanvas`
   *  (`transferControlToOffscreen`), whose bitmap they show from then on. */
  const placeholders = new WeakSet<object>();
  /** A canvas's `width` or `height` attribute (HTML 4.12.5): a valid
   *  non-negative integer, or its default. */
  const canvasSize = (canvas: Any, name: string, fallback: number): number => {
    const v = canvas.getAttribute(name);
    const m = v === null ? null : /^[\t\n\f\r ]*\+?(\d+)/.exec(v);
    return m ? Number(m[1]) : fallback;
  };
  const newCanvasState = (width: number, height: number): CanvasState => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    dirty: null,
    context: null,
    kind: null,
    sized: `${width},${height}`,
  });
  /** A canvas's bitmap, made anew — cleared — where its size changed; an
   *  `OffscreenCanvas`'s, made as it is first drawn on or read. */
  const canvasState = (canvas: Any): CanvasState => {
    if (canvas instanceof OffscreenCanvas) {
      let state = canvases.get(canvas);
      if (!state) {
        state = newCanvasState(canvas._width, canvas._height);
        canvases.set(canvas, state);
      }
      return state;
    }
    const width = canvasSize(canvas, 'width', 300);
    const height = canvasSize(canvas, 'height', 150);
    let state = canvases.get(canvas);
    if (!state) {
      state = newCanvasState(width, height);
      canvases.set(canvas, state);
    } else if (state.sized !== `${width},${height}`) {
      resetCanvas(canvas, state, width, height);
    }
    return state;
  };
  /** Whether a context is a 2d one, a canvas's or an `OffscreenCanvas`'s. */
  const is2d = (context: Any): boolean =>
    context instanceof CanvasRenderingContext2D ||
    context instanceof OffscreenCanvasRenderingContext2D;
  /** A canvas's bitmap made anew at a size, transparent, and its 2d
   *  context's state as it starts: what setting either side does, even to
   *  what it was (HTML 4.12.5.1). */
  const resetCanvas = (
    canvas: Any,
    state: CanvasState,
    width: number,
    height: number,
  ): void => {
    state.width = width;
    state.height = height;
    state.sized = `${width},${height}`;
    state.data = new Uint8ClampedArray(width * height * 4);
    if (is2d(state.context)) state.context._reset();
    markCanvas(canvas, state, 0, 0, width, height);
  };
  /** Whether what a canvas draws is shown anywhere: a `<canvas>`, until it
   *  hands its control to an `OffscreenCanvas`; and an `OffscreenCanvas`
   *  that has a placeholder, here or across a thread. */
  const canvasShown = (canvas: Any): boolean =>
    canvas instanceof OffscreenCanvas
      ? !!(canvas._placeholder || canvas._route)
      : !placeholders.has(canvas);
  const markCanvas = (
    canvas: Any,
    state: CanvasState,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void => {
    if (!canvasShown(canvas)) return;
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
   *  pixels as base64, since a string is what crosses. An
   *  `OffscreenCanvas`'s goes to its placeholder: this realm's, or across
   *  the thread it came over, as a frame (`canvasFrame`). */
  const flushCanvases = (): void => {
    canvasFlush = false;
    for (const canvas of dirtyCanvases) {
      const state = canvases.get(canvas);
      if (!state?.dirty) continue;
      const [x0, y0, x1, y1] = state.dirty;
      state.dirty = null;
      if (!canvasShown(canvas)) continue;
      const w = Math.max(0, x1 - x0);
      const h = Math.max(0, y1 - y0);
      const rows = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y += 1) {
        const from = ((y0 + y) * state.width + x0) * 4;
        rows.set(state.data.subarray(from, from + w * 4), y * w * 4);
      }
      const size = [state.width, state.height, x0, y0, w, h].join(',');
      const pixels = base64OfBytes(rows);
      const route = canvas instanceof OffscreenCanvas ? canvas._route : null;
      if (route) {
        route.across.send(
          JSON.stringify({ k: route.token, s: size, d: pixels }),
        );
        continue;
      }
      const shownIn =
        canvas instanceof OffscreenCanvas ? canvas._placeholder : canvas;
      call('canvasPut', idOf(shownIn), size, pixels);
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
      // a `DOMMatrix2DInit`, or none, where it is handed one argument
      // (HTML 4.12.5.1.8)
      const m =
        arguments.length <= 1
          ? GEOMETRY.values2D(
              arguments[0],
              "Failed to execute 'setTransform' on 'CanvasRenderingContext2D'",
            )
          : [a, b, c, d, e, f].map(Number);
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
      return GEOMETRY.matrix2D(this._matrix);
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
      // another canvas, an `OffscreenCanvas` or an `ImageBitmap`, an
      // `ImageData`'s pixels being no source: what this realm has the
      // pixels of
      const from = drawnPixels(source, this, 'drawImage');
      if (!from) return;
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
    /** A pattern of another canvas, an `OffscreenCanvas` or an
     *  `ImageBitmap`, as it is now: an image's pixels are the host's, and
     *  one is no pattern here. */
    createPattern(source: Any, repetition: Any): Any {
      const rep =
        repetition === null || repetition === '' ? 'repeat' : str(repetition);
      if (!['repeat', 'repeat-x', 'repeat-y', 'no-repeat'].includes(rep)) {
        throw new DOMException(
          `The provided type ('${rep}') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.`,
          'SyntaxError',
        );
      }
      const from = drawnPixels(source, this, 'createPattern');
      if (!from) return null;
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

  /** A key the facade makes its own platform objects with, which a page's
   *  `new` does not have. */
  const CANVAS_KEY = {};

  /**
   * Pixels a page holds to draw (HTML 8.11.2): straight RGBA in this realm,
   * as a canvas's are, and none once it is closed or transferred, which is
   * its [[Detached]]. `createImageBitmap` and `transferToImageBitmap` make
   * one; a 2d context draws it, and a `bitmaprenderer` context shows it.
   */
  class ImageBitmap {
    _width = 0;
    _height = 0;
    /** Its pixels, or null once it is detached. */
    _data: Uint8ClampedArray | null = null;
    constructor(key?: Any) {
      if (key !== CANVAS_KEY) throw new TypeError('Illegal constructor');
    }
    get width(): number {
      return this._data ? this._width : 0;
    }
    get height(): number {
      return this._data ? this._height : 0;
    }
    close(): void {
      detachBitmap(this);
    }
  }
  const makeBitmap = (
    width: number,
    height: number,
    data: Uint8ClampedArray,
  ): Any => {
    const bitmap = new ImageBitmap(CANVAS_KEY);
    bitmap._width = width;
    bitmap._height = height;
    bitmap._data = data;
    return bitmap;
  };
  const detachBitmap = (bitmap: Any): void => {
    bitmap._data = null;
    bitmap._width = 0;
    bitmap._height = 0;
  };

  /** The pixels a source a 2d context draws holds, where this realm has
   *  them: a canvas's, an `OffscreenCanvas`'s and an `ImageBitmap`'s, or
   *  null for one whose pixels are the host's — an image, a video — which
   *  is drawn as nothing. One with nothing to draw is an `InvalidStateError`
   *  (HTML 4.12.5.1.14, "check the usability of the image argument"). */
  const drawnPixels = (
    source: Any,
    context: Any,
    method: string,
  ): { data: Uint8ClampedArray; width: number; height: number } | null => {
    const where = `Failed to execute '${method}' on '${
      context instanceof OffscreenCanvasRenderingContext2D
        ? 'OffscreenCanvasRenderingContext2D'
        : 'CanvasRenderingContext2D'
    }'`;
    let from: { data: Uint8ClampedArray; width: number; height: number };
    if (source instanceof ImageBitmap) {
      if (!source._data) {
        throw new DOMException(
          `${where}: The image source is detached.`,
          'InvalidStateError',
        );
      }
      from = {
        data: source._data,
        width: source._width,
        height: source._height,
      };
    } else if (
      source instanceof HTMLCanvasElement ||
      source instanceof OffscreenCanvas
    ) {
      if (source instanceof OffscreenCanvas && source._detached) {
        throw new DOMException(
          `${where}: The image source is detached.`,
          'InvalidStateError',
        );
      }
      from = canvasState(source);
    } else {
      return null;
    }
    if (!from.width || !from.height) {
      throw new DOMException(
        `${where}: The image argument is a canvas element with a width or height of 0.`,
        'InvalidStateError',
      );
    }
    return from;
  };

  /**
   * A canvas's `bitmaprenderer` context (HTML 4.12.5.2): it shows the
   * `ImageBitmap` it was handed last, at the bitmap's own size, and takes
   * the bitmap's pixels rather than copying them, detaching it.
   */
  class ImageBitmapRenderingContext {
    _canvas: Any;
    constructor(canvas: Any, key?: Any) {
      if (key !== CANVAS_KEY) throw new TypeError('Illegal constructor');
      this._canvas = canvas;
    }
    get canvas(): Any {
      return this._canvas;
    }
    transferFromImageBitmap(bitmap: Any): void {
      const where =
        "Failed to execute 'transferFromImageBitmap' on 'ImageBitmapRenderingContext'";
      if (arguments.length < 1) {
        throw new TypeError(
          `${where}: 1 argument required, but only 0 present.`,
        );
      }
      if (bitmap !== null && !(bitmap instanceof ImageBitmap)) {
        throw new TypeError(
          `${where}: parameter 1 is not of type 'ImageBitmap'.`,
        );
      }
      if (bitmap && !bitmap._data) {
        throw new DOMException(
          `${where}: The input ImageBitmap has been detached`,
          'InvalidStateError',
        );
      }
      const state = canvasState(this._canvas);
      if (bitmap) {
        state.width = bitmap._width;
        state.height = bitmap._height;
        state.data = bitmap._data;
        detachBitmap(bitmap);
      } else {
        // none: transparent, at the canvas's size
        const [width, height] = state.sized.split(',').map(Number);
        state.width = width;
        state.height = height;
        state.data = new Uint8ClampedArray(width * height * 4);
      }
      markCanvas(this._canvas, state, 0, 0, state.width, state.height);
    }
  }

  /**
   * An `OffscreenCanvas`'s 2d context (HTML 4.12.5.3): a canvas's 2d
   * context in all but its canvas and `drawFocusIfNeeded`, which has no
   * element to focus, and an interface of its own, as a browser's is —
   * `instanceof CanvasRenderingContext2D` is false for one. Its members are
   * the 2d context's, copied onto its prototype below.
   */
  class OffscreenCanvasRenderingContext2D {
    constructor(canvas: Any, key?: Any) {
      if (key !== CANVAS_KEY) throw new TypeError('Illegal constructor');
      (this as Any)._canvas = canvas;
      (this as Any)._reset();
    }
  }
  for (const key of Reflect.ownKeys(CanvasRenderingContext2D.prototype)) {
    if (key === 'constructor' || key === 'drawFocusIfNeeded') continue;
    Object.defineProperty(
      OffscreenCanvasRenderingContext2D.prototype,
      key,
      Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, key)!,
    );
  }

  /** A canvas's context of a kind, the same each time, and none of another
   *  kind once the canvas has one (HTML 4.12.5): a 2d context, a
   *  `bitmaprenderer` one, or a WebGL one that draws nothing (`webgl.ts`). */
  const contextFor = (canvas: Any, kind: string, options: Any): Any => {
    const state = canvasState(canvas);
    if (state.context) return state.kind === kind ? state.context : null;
    state.kind = kind;
    state.context =
      kind === '2d'
        ? canvas instanceof OffscreenCanvas
          ? new OffscreenCanvasRenderingContext2D(canvas, CANVAS_KEY)
          : new CanvasRenderingContext2D(canvas)
        : kind === 'bitmaprenderer'
          ? new ImageBitmapRenderingContext(canvas, CANVAS_KEY)
          : WEBGL.context(canvas, kind as 'webgl' | 'webgl2', options);
    return state.context;
  };

  /** A bitmap as a file (HTML 4.12.5.1, "a serialization of the bitmap as
   *  a file"): a PNG, the one type every bitmap is had as, whatever type
   *  was asked for, made by the host (`encodeImage`). Null where there is
   *  none, as for a bitmap of no pixels. */
  const encodedBitmap = (
    width: number,
    height: number,
    data: Uint8ClampedArray,
  ): Uint8Array | null => {
    if (!width || !height) return null;
    const answer = call(
      'encodeImage',
      `${width},${height}`,
      base64OfBytes(new Uint8Array(data.buffer, data.byteOffset, data.length)),
    );
    return typeof answer === 'string' && answer ? bytesOfBase64(answer) : null;
  };

  /** An `OffscreenCanvas`'s side, an `[EnforceRange] unsigned long long`
   *  (Web IDL 3.2.4.6). */
  const offscreenSide = (v: Any, where: string): number => {
    const n = Number(v);
    if (n !== n || n === 1 / 0 || n === -1 / 0) {
      throw new TypeError(`${where}: Value is not a finite number.`);
    }
    const t = Math.trunc(n);
    if (t < 0 || t > Number.MAX_SAFE_INTEGER) {
      throw new TypeError(
        `${where}: Value is outside the 'unsigned long long' value range.`,
      );
    }
    return t;
  };
  const OFFSCREEN_KINDS = ['2d', 'bitmaprenderer', 'webgl', 'webgl2', 'webgpu'];

  /**
   * A canvas with no element (HTML 4.12.5.3): a bitmap of its own, drawn on
   * through the same contexts, in a window or a worker. One a `<canvas>`
   * handed its control to (`transferControlToOffscreen`) shows what it
   * draws in that canvas's box, from this realm or from a worker it was
   * transferred to (`_route`); one a transfer gave up is [[Detached]], and
   * neither drawn on nor measured again.
   */
  class OffscreenCanvas extends EventTarget {
    _width: number;
    _height: number;
    _detached = false;
    /** The `<canvas>` it shows in, where that is in this realm. */
    _placeholder: Any = null;
    /** Where it shows where its placeholder is across a thread: the side
     *  of the thread it came over, and what the realm there calls the
     *  placeholder (`canvasRoutes`). */
    _route: { across: Across; token: string } | null = null;
    constructor(width: Any, height: Any) {
      super();
      const where = "Failed to construct 'OffscreenCanvas'";
      if (arguments.length < 2) {
        throw new TypeError(
          `${where}: 2 arguments required, but only ${arguments.length} present.`,
        );
      }
      this._width = offscreenSide(width, where);
      this._height = offscreenSide(height, where);
    }
    get width(): number {
      return this._width;
    }
    set width(v: Any) {
      resizeOffscreen(
        this,
        offscreenSide(
          v,
          "Failed to set the 'width' property on 'OffscreenCanvas'",
        ),
        this._height,
      );
    }
    get height(): number {
      return this._height;
    }
    set height(v: Any) {
      resizeOffscreen(
        this,
        this._width,
        offscreenSide(
          v,
          "Failed to set the 'height' property on 'OffscreenCanvas'",
        ),
      );
    }
    getContext(type: Any, options: Any = null): Any {
      const where = "Failed to execute 'getContext' on 'OffscreenCanvas'";
      if (arguments.length < 1) {
        throw new TypeError(
          `${where}: 1 argument required, but only 0 present.`,
        );
      }
      const kind = str(type);
      if (!OFFSCREEN_KINDS.includes(kind)) {
        throw new TypeError(
          `${where}: The provided value '${kind}' is not a valid enum value of type OffscreenRenderingContextType.`,
        );
      }
      if (this._detached) {
        throw new DOMException(
          `${where}: OffscreenCanvas object is detached.`,
          'InvalidStateError',
        );
      }
      // WebGPU is not had here
      if (kind === 'webgpu') return null;
      return contextFor(this, kind, options);
    }
    /** Its bitmap as an `ImageBitmap`, and a new one, transparent, in its
     *  place: the context keeps its state. */
    transferToImageBitmap(): Any {
      const where =
        "Failed to execute 'transferToImageBitmap' on 'OffscreenCanvas'";
      if (this._detached) {
        throw new DOMException(
          `${where}: Cannot transfer an ImageBitmap from a detached OffscreenCanvas`,
          'InvalidStateError',
        );
      }
      const state = canvases.get(this);
      if (!state?.context) {
        throw new DOMException(
          `${where}: Cannot transfer an ImageBitmap from an OffscreenCanvas with no context`,
          'InvalidStateError',
        );
      }
      const bitmap = makeBitmap(state.width, state.height, state.data);
      state.data = new Uint8ClampedArray(state.width * state.height * 4);
      markCanvas(this, state, 0, 0, state.width, state.height);
      return bitmap;
    }
    /** Its bitmap as a PNG, a task later: the bitmap as it is now. */
    convertToBlob(options: Any = {}): Promise<Any> {
      const where = "Failed to execute 'convertToBlob' on 'OffscreenCanvas'";
      try {
        if (options !== null && options !== undefined) {
          if (typeof options !== 'object' && typeof options !== 'function') {
            throw new TypeError(
              `${where}: The provided value is not of type 'ImageEncodeOptions'.`,
            );
          }
        }
        if (this._detached) {
          throw new DOMException(
            `${where}: OffscreenCanvas object is detached.`,
            'InvalidStateError',
          );
        }
        const state = canvasState(this);
        if (!state.width || !state.height) {
          throw new DOMException(
            `${where}: The size of the OffscreenCanvas is zero.`,
            'IndexSizeError',
          );
        }
        const { width, height } = state;
        const data = state.data.slice();
        return new Promise((resolve, reject) => {
          setTimer(
            () => {
              const bytes = encodedBitmap(width, height, data);
              if (bytes) resolve(new Blob([bytes], { type: 'image/png' }));
              else {
                reject(
                  new DOMException(
                    `${where}: Encoding of the OffscreenCanvas failed.`,
                    'EncodingError',
                  ),
                );
              }
            },
            0,
            [],
            false,
          );
        });
      } catch (error) {
        return Promise.reject(error);
      }
    }
  }
  for (const type of ['contextlost', 'contextrestored']) {
    Object.defineProperty(OffscreenCanvas.prototype, `on${type}`, {
      get(this: Any): Any {
        return this._handlers?.[type] ?? null;
      },
      set(this: Any, fn: Any) {
        this._handlers ??= {};
        this._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
      enumerable: true,
    });
  }
  /** An `OffscreenCanvas` at a new size: its bitmap made anew, as a
   *  `<canvas>`'s is when either side is set. */
  const resizeOffscreen = (
    canvas: Any,
    width: number,
    height: number,
  ): void => {
    if (canvas._detached) {
      throw new DOMException(
        'Cannot resize a detached OffscreenCanvas.',
        'InvalidStateError',
      );
    }
    canvas._width = width;
    canvas._height = height;
    const state = canvases.get(canvas);
    if (state) resetCanvas(canvas, state, width, height);
  };
  /** An `OffscreenCanvas` given up to a transfer (HTML 4.12.5.3, its
   *  transfer steps): no size, no bitmap and nowhere it shows. */
  const detachOffscreen = (canvas: Any): void => {
    canvas._detached = true;
    canvas._width = 0;
    canvas._height = 0;
    canvas._placeholder = null;
    canvas._route = null;
    canvases.delete(canvas);
  };
  /** An `OffscreenCanvas` a transfer in this realm made, `to`, in the place
   *  of `from`: its size, its bitmap and where it shows. */
  const moveOffscreen = (from: Any, to: Any): void => {
    to._width = from._width;
    to._height = from._height;
    to._placeholder = from._placeholder;
    to._route = from._route;
    const state = canvases.get(from);
    detachOffscreen(from);
    if (state) {
      canvases.set(to, state);
      if (state.dirty) dirtyCanvases.add(to);
    }
  };

  /** What `createImageBitmap` asks the host to decode, by its number, and
   *  what to do with the answer (`__imageDecoded`). */
  const imageDecodes = new Map<number, (size: string, data: string) => void>();
  let imageDecodeSeq = 0;
  type Pixels = { data: Uint8ClampedArray; width: number; height: number };
  /**
   * A source's pixels cut to a rectangle, resized and flipped as
   * `createImageBitmap`'s options say (HTML 8.11.3, "cropped to the source
   * rectangle with formatting"): what the rectangle reaches past the source
   * is transparent, a resize to one side keeps the rectangle's ratio, and
   * one at a quality above `low` is bilinear, premultiplied, where `low`
   * and `pixelated` take the nearest pixel.
   */
  const croppedPixels = (
    from: Pixels,
    crop: number[] | null,
    options: Any,
  ): Pixels => {
    let [sx, sy, sw, sh] = crop ?? [0, 0, from.width, from.height];
    if (sw < 0) {
      sx += sw;
      sw = -sw;
    }
    if (sh < 0) {
      sy += sh;
      sh = -sh;
    }
    const rw = options.resizeWidth;
    const rh = options.resizeHeight;
    const width =
      rw !== undefined ? rw : rh !== undefined ? Math.ceil((sw * rh) / sh) : sw;
    const height =
      rh !== undefined ? rh : rw !== undefined ? Math.ceil((sh * rw) / sw) : sh;
    const data = new Uint8ClampedArray(width * height * 4);
    const flip = options.imageOrientation === 'flipY';
    const quality = options.resizeQuality ?? 'low';
    const smooth =
      (width !== sw || height !== sh) &&
      (quality === 'medium' || quality === 'high');
    const src = from.data;
    const fw = from.width;
    const fh = from.height;
    for (let oy = 0; oy < height; oy += 1) {
      const row = (flip ? height - 1 - oy : oy) * width;
      const v = sy + ((oy + 0.5) * sh) / height;
      for (let ox = 0; ox < width; ox += 1) {
        const u = sx + ((ox + 0.5) * sw) / width;
        const o = (row + ox) * 4;
        if (u < 0 || v < 0 || u >= fw || v >= fh) continue;
        if (!smooth) {
          const i = (Math.floor(v) * fw + Math.floor(u)) * 4;
          data[o] = src[i];
          data[o + 1] = src[i + 1];
          data[o + 2] = src[i + 2];
          data[o + 3] = src[i + 3];
          continue;
        }
        // the four pixels around the point, each clamped to the source,
        // weighed by their alpha so a transparent one adds no colour
        const x0 = Math.max(0, Math.floor(u - 0.5));
        const y0 = Math.max(0, Math.floor(v - 0.5));
        const x1 = Math.min(fw - 1, x0 + 1);
        const y1 = Math.min(fh - 1, y0 + 1);
        const tx = Math.min(1, Math.max(0, u - 0.5 - x0));
        const ty = Math.min(1, Math.max(0, v - 0.5 - y0));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (const [px, py, w] of [
          [x0, y0, (1 - tx) * (1 - ty)],
          [x1, y0, tx * (1 - ty)],
          [x0, y1, (1 - tx) * ty],
          [x1, y1, tx * ty],
        ]) {
          const i = (py * fw + px) * 4;
          const wa = w * src[i + 3];
          r += src[i] * wa;
          g += src[i + 1] * wa;
          b += src[i + 2] * wa;
          a += wa;
        }
        if (a > 0) {
          data[o] = r / a;
          data[o + 1] = g / a;
          data[o + 2] = b / a;
          data[o + 3] = a;
        }
      }
    }
    return { data, width, height };
  };
  const BITMAP_ENUMS: Record<string, string[]> = {
    imageOrientation: ['from-image', 'flipY', 'none'],
    premultiplyAlpha: ['none', 'premultiply', 'default'],
    colorSpaceConversion: ['none', 'default'],
    resizeQuality: ['pixelated', 'low', 'medium', 'high'],
  };
  /**
   * An `ImageBitmap` of a source (HTML 8.11.3), a task later, or a promise
   * rejected where the source has nothing to give. A canvas's, an
   * `OffscreenCanvas`'s, an `ImageBitmap`'s and an `ImageData`'s pixels
   * are this realm's and are copied as it is called; a blob's image is
   * decoded by the host, through the decoders a document's images are
   * (`imageDecode`); an image's and a video's pixels are the host's, which
   * a 2d context draws as nothing, so theirs is transparent, at their size.
   */
  function createImageBitmap(this: Any, image: Any, ...rest: Any[]): Any {
    const where = `Failed to execute 'createImageBitmap' on '${
      workerLocation ? 'WorkerGlobalScope' : 'Window'
    }'`;
    try {
      const count = arguments.length;
      if (count < 1) {
        throw new TypeError(
          `${where}: 1 argument required, but only 0 present.`,
        );
      }
      if (count === 3 || count === 4) {
        throw new TypeError(
          `${where}: Valid arities are: [1, 2, 5, 6], but ${count} arguments provided.`,
        );
      }
      // a `long` each: NaN and the infinities are 0 (Web IDL 3.2.4.8)
      const crop =
        count >= 5
          ? rest.slice(0, 4).map((v) => {
              const n = Math.trunc(Number(v));
              return n === n && n !== 1 / 0 && n !== -1 / 0 ? n | 0 : 0;
            })
          : null;
      const given = count >= 5 ? rest[4] : rest[0];
      if (
        given !== undefined &&
        given !== null &&
        typeof given !== 'object' &&
        typeof given !== 'function'
      ) {
        throw new TypeError(
          `${where}: The provided value is not of type 'ImageBitmapOptions'.`,
        );
      }
      const options: Any = {};
      for (const [name, allowed] of Object.entries(BITMAP_ENUMS)) {
        const v = given?.[name];
        if (v === undefined) continue;
        if (!allowed.includes(str(v))) {
          throw new TypeError(
            `${where}: Failed to read the '${name}' property from 'ImageBitmapOptions': The provided value '${str(v)}' is not a valid enum value of type ${name[0].toUpperCase()}${name.slice(1)}.`,
          );
        }
        options[name] = str(v);
      }
      for (const name of ['resizeWidth', 'resizeHeight']) {
        const v = given?.[name];
        if (v === undefined) continue;
        const n = Number(v);
        if (n !== n || n === 1 / 0 || n === -1 / 0 || n < 0 || n > 4294967295) {
          throw new TypeError(
            `${where}: Failed to read the '${name}' property from 'ImageBitmapOptions': Value is outside the 'unsigned long' value range.`,
          );
        }
        options[name] = Math.trunc(n);
      }
      if (crop && (!crop[2] || !crop[3])) {
        throw new RangeError(
          `${where}: The crop rect ${crop[2] ? 'height' : 'width'} is 0.`,
        );
      }
      if (options.resizeWidth === 0 || options.resizeHeight === 0) {
        throw new DOMException(
          `${where}: The resize width or height is 0.`,
          'InvalidStateError',
        );
      }
      const unusable = (why: string) =>
        new DOMException(`${where}: ${why}`, 'InvalidStateError');
      const made = (from: Pixels): Promise<Any> => {
        const cut = croppedPixels(from, crop, options);
        return new Promise((resolve) => {
          setTimer(
            () => resolve(makeBitmap(cut.width, cut.height, cut.data)),
            0,
            [],
            false,
          );
        });
      };
      if (image instanceof Blob) {
        if (!image._bytes.length) {
          throw unusable('The source image could not be decoded.');
        }
        return new Promise((resolve, reject) => {
          const id = ++imageDecodeSeq;
          imageDecodes.set(id, (size, data) => {
            const [width, height] = size.split(',').map(Number);
            if (!(width > 0 && height > 0)) {
              reject(unusable('The source image could not be decoded.'));
              return;
            }
            const bytes = bytesOfBase64(data);
            const cut = croppedPixels(
              {
                data: new Uint8ClampedArray(
                  bytes.buffer,
                  bytes.byteOffset,
                  bytes.length,
                ),
                width,
                height,
              },
              crop,
              options,
            );
            resolve(makeBitmap(cut.width, cut.height, cut.data));
          });
          call('imageDecode', id, base64OfBytes(image._bytes));
        });
      }
      if (image instanceof ImageData) {
        if (image.data.length !== image.width * image.height * 4) {
          throw unusable('The source data has been detached.');
        }
        return made(image);
      }
      if (image instanceof ImageBitmap) {
        if (!image._data) {
          throw unusable('The image source is detached.');
        }
        return made({
          data: image._data,
          width: image._width,
          height: image._height,
        });
      }
      if (
        image instanceof HTMLCanvasElement ||
        image instanceof OffscreenCanvas
      ) {
        if (image instanceof OffscreenCanvas && image._detached) {
          throw unusable('The image source is detached.');
        }
        const state = canvasState(image);
        if (!state.width || !state.height) {
          throw unusable(
            'The image argument is a canvas element with a width or height of 0.',
          );
        }
        return made(state);
      }
      if (
        image instanceof HTMLImageElement ||
        image instanceof HTMLVideoElement
      ) {
        const video = image instanceof HTMLVideoElement;
        const width = video ? image.videoWidth : image.naturalWidth;
        const height = video ? image.videoHeight : image.naturalHeight;
        if (!width || !height) {
          throw unusable(
            video
              ? 'The provided element has not retrieved data.'
              : 'The image element contains no image data.',
          );
        }
        return made({
          data: new Uint8ClampedArray(width * height * 4),
          width,
          height,
        });
      }
      throw new TypeError(
        `${where}: The provided value is not of type '(Blob or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or ImageData or OffscreenCanvas or SVGImageElement or VideoFrame)'.`,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** A canvas's `captureStream()`, once the media facade is in
   *  (`mediastream.ts`'s `captureCanvas`). */
  let canvasCapture: Any = null;

  /** A `<canvas>` whose control went to an `OffscreenCanvas` refuses what
   *  would read or change its own bitmap (HTML 4.12.5, a placeholder). */
  const notPlaceholder = (canvas: Any, what: string, why: string): void => {
    if (placeholders.has(canvas)) {
      throw new DOMException(
        `${what} on 'HTMLCanvasElement': ${why}`,
        'InvalidStateError',
      );
    }
  };
  /** A `<canvas>` at a new size, set even to what it was: its bitmap made
   *  anew where it has one (HTML 4.12.5), which `canvas.width =
   *  canvas.width` clears a canvas by. */
  const resizeCanvas = (canvas: Any, side: string, v: Any): void => {
    notPlaceholder(
      canvas,
      `Failed to set the '${side}' property`,
      'Cannot resize canvas after call to transferControlToOffscreen().',
    );
    canvas.setAttribute(side, String(Number(v) >>> 0));
    const state = canvases.get(canvas);
    if (state) resetCanvas(canvas, state, canvas.width, canvas.height);
  };

  class HTMLCanvasElement extends HTMLElement {
    get width(): number {
      return canvasSize(this, 'width', 300);
    }
    set width(v: Any) {
      resizeCanvas(this, 'width', v);
    }
    get height(): number {
      return canvasSize(this, 'height', 150);
    }
    set height(v: Any) {
      resizeCanvas(this, 'height', v);
    }
    /** A context of a kind, the same each time, and none of another kind
     *  once the canvas has one (HTML 4.12.5): a 2d context, a
     *  `bitmaprenderer` one, or a WebGL one that draws nothing
     *  (`webgl.ts`). */
    getContext(type: Any, options?: Any): Any {
      notPlaceholder(
        this,
        "Failed to execute 'getContext'",
        'Cannot get context from a canvas that has transferred its control to offscreen.',
      );
      let kind = str(type);
      if (kind === 'experimental-webgl') kind = 'webgl';
      if (
        kind !== '2d' &&
        kind !== 'webgl' &&
        kind !== 'webgl2' &&
        kind !== 'bitmaprenderer'
      ) {
        return null;
      }
      return contextFor(this, kind, options);
    }
    /** An `OffscreenCanvas` of the canvas's size whose bitmap the canvas
     *  shows from now on, wherever it is drawn on: here, or in a worker it
     *  is transferred to (HTML 4.12.5). */
    transferControlToOffscreen(): Any {
      const what = "Failed to execute 'transferControlToOffscreen'";
      notPlaceholder(
        this,
        what,
        'Cannot transfer control from a canvas for more than one time.',
      );
      if (canvases.get(this)?.context) {
        throw new DOMException(
          `${what} on 'HTMLCanvasElement': Cannot transfer control from a canvas that has a rendering context.`,
          'InvalidStateError',
        );
      }
      const offscreen = new OffscreenCanvas(this.width, this.height);
      offscreen._placeholder = this;
      placeholders.add(this);
      dirtyCanvases.delete(this);
      return offscreen;
    }
    /** A stream of what the canvas draws (Media Capture from DOM Elements,
     *  3.1): a frame each time it changes, at most `frameRequestRate` a
     *  second where it is given, and only at `requestFrame()` where it is
     *  0. Its pixels are the host's copy of the canvas's. */
    captureStream(frameRequestRate?: Any): Any {
      let rate: number | null = null;
      if (frameRequestRate !== undefined) {
        rate = +frameRequestRate;
        // a page may have replaced `isFinite`
        if (rate !== rate || rate === 1 / 0 || rate === -1 / 0) {
          throw new TypeError(
            "Failed to execute 'captureStream' on 'HTMLCanvasElement': The provided double value is non-finite.",
          );
        }
        if (rate < 0) {
          throw new DOMException(
            "Failed to execute 'captureStream' on 'HTMLCanvasElement': Given frame rate is not supported.",
            'NotSupportedError',
          );
        }
      }
      return canvasCapture(this, idOf(this), rate, this.width, this.height);
    }
    /** The bitmap as a PNG's `data:` URL, whatever type is asked for, and
     *  `data:,` for one of no pixels (HTML 4.12.5). */
    toDataURL(): string {
      notPlaceholder(
        this,
        "Failed to execute 'toDataURL'",
        'Cannot read from a canvas that has transferred its control to offscreen.',
      );
      const state = canvasState(this);
      const bytes = encodedBitmap(state.width, state.height, state.data);
      return bytes ? `data:image/png;base64,${base64OfBytes(bytes)}` : 'data:,';
    }
    /** The bitmap as a PNG blob, to `callback` a task later, or null for
     *  one of no pixels. */
    toBlob(callback: Any): void {
      const what = "Failed to execute 'toBlob'";
      notPlaceholder(
        this,
        what,
        'Cannot read from a canvas that has transferred its control to offscreen.',
      );
      if (typeof callback !== 'function') {
        throw new TypeError(
          `${what} on 'HTMLCanvasElement': The callback provided as parameter 1 is not a function.`,
        );
      }
      const state = canvasState(this);
      const { width, height } = state;
      const data = state.data.slice();
      setTimer(
        () => {
          const bytes = encodedBitmap(width, height, data);
          callback(bytes ? new Blob([bytes], { type: 'image/png' }) : null);
        },
        0,
        [],
        false,
      );
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
    defaultPlaybackRate: number;
    time: number;
    pending: { resolve: (v?: Any) => void; reject: (e: Any) => void }[];
    /** How many times a `pause()` paused it: a `play()` whose task finds
     *  another count was paused since. */
    pauses: number;
    // what loading it came to, where it loads (`mediaLoads`)
    network: number;
    ready: number;
    duration: number;
    width: number;
    height: number;
    src: string;
    error: Any;
    seeking: boolean;
    /** HTML's "is currently stalled": nothing arrived for three seconds. */
    stalled: boolean;
    ended: boolean;
    /** HTML's "can autoplay flag". */
    autoplaying: boolean;
    /** Whether a player plays its source (`mediaPlayed`): its clock and
     *  its end are the player's from then on, and the model's only fill
     *  in between what the player says. */
    player: boolean;
    /** Which run of the load algorithm this is: a fetch or a timer of an
     *  earlier one finds another and does nothing. */
    load: number;
    abort: (() => void) | null;
    /** When the clock last started, on `now()`, while it runs. */
    since: number | null;
    ticker: number | null;
    stallTimer: number | null;
    /** When `progress` was last fired, on `now()`. */
    progressed: number;
    /** What `:seeking`, `:buffering` and `:stalled` were last told. */
    flags: string;
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
        defaultPlaybackRate: 1,
        time: 0,
        pending: [],
        pauses: 0,
        network: 0,
        ready: 0,
        duration: NaN,
        width: 0,
        height: 0,
        src: '',
        error: null,
        seeking: false,
        stalled: false,
        ended: false,
        autoplaying: true,
        player: false,
        load: 0,
        abort: null,
        since: null,
        ticker: null,
        stallTimer: null,
        progressed: 0,
        flags: '',
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

  // --- loading -------------------------------------------------------------------
  //
  // Where the page's requests reach a network (`hasNetwork`), a media
  // element loads its source as HTML 4.8.11.5 has it: fetched through the
  // page's network as far as its container says how long it is and how
  // large, and a little past that, then suspended, since the player fetches
  // what it plays itself. Its network and ready states, its events, and
  // the clock `currentTime` reads are this model's — nothing comes back
  // from the player. Where there is no network it never loads, and it is
  // ready as soon as it is asked, as it was before.

  let networkAnswer: boolean | null = null;
  const mediaLoads = (): boolean =>
    (networkAnswer ??= call('hasNetwork') === true);
  /** The media elements a script has playing, in a document or out of
   *  one: what a document that stops being fully active pauses
   *  (`hideTree`), a `new Audio()` it never put in its tree among them. */
  const playingMedia = new Set<Any>();
  /** How far, in seconds of the media, the clock runs past what a player
   *  last said (`mediaPlayed`): it says four times a second while it
   *  plays, so a player silent for longer is waiting for data — after a
   *  seek, on a slow network — and the clock waits with it, where it would
   *  run ahead and come back when the player spoke again. */
  const PLAYER_AHEAD = 0.5;
  /** The clock: where it is now, while it runs (HTML's "current playback
   *  position"). */
  const mediaTime = (ask: MediaAsk): number => {
    if (ask.since === null) return ask.time;
    const ran = ((now() - ask.since) / 1000) * ask.playbackRate;
    const t =
      ask.time +
      (ask.player ? Math.min(ran, PLAYER_AHEAD * ask.playbackRate) : ran);
    return Number.isFinite(ask.duration) ? Math.min(t, ask.duration) : t;
  };
  /** Whether the clock runs: playing, with enough to go on, not seeking
   *  and not at its end. */
  const mediaRuns = (ask: MediaAsk): boolean =>
    ask.paused === false && ask.ready >= 3 && !ask.seeking && !ask.ended;
  /** The clock started or stopped as `mediaRuns` says, and the flags
   *  `:seeking`, `:buffering` and `:stalled` read told to the host. */
  const mediaSync = (el: Any): void => {
    const ask = askOf(el);
    if (ask.paused === false) playingMedia.add(el);
    else playingMedia.delete(el);
    const runs = mediaRuns(ask);
    if (!runs && ask.since !== null) {
      ask.time = mediaTime(ask);
      ask.since = null;
    }
    if (runs && ask.since === null) ask.since = now();
    if (!runs && ask.ticker !== null) {
      clearTimer(ask.ticker);
      ask.ticker = null;
    }
    if (runs && ask.ticker === null) {
      ask.ticker = setTimer(() => mediaTick(el), 250, [], true);
    }
    // HTML 4.8.11.6: playing with too little to go on, as it loads
    const buffering =
      ask.paused === false && ask.network === 2 && ask.ready <= 2;
    const flags = `${ask.seeking}${buffering}${buffering && ask.stalled}`;
    if (flags === ask.flags) return;
    ask.flags = flags;
    call('mediaState', el._id, 'seeking', ask.seeking);
    call('mediaState', el._id, 'buffering', buffering);
    call('mediaState', el._id, 'stalled', buffering && ask.stalled);
  };
  /** A quarter second of play: `timeupdate`, and the end, where it loops
   *  back to the start or stops (HTML 4.8.11.8, "reaches the end"). Where
   *  a player plays it, the player says when that is (`mediaPlayed`): the
   *  clock at the length may be ahead of what is heard, and a page that
   *  goes on to the next file at `ended` would cut the last word off. */
  const mediaTick = (el: Any): void => {
    const ask = askOf(el);
    if (!mediaRuns(ask)) return;
    fireMedia(el, 'timeupdate');
    if (!Number.isFinite(ask.duration) || mediaTime(ask) < ask.duration) {
      return;
    }
    if (ask.player) return;
    if (el.hasAttribute('loop')) {
      mediaSeek(el, 0);
      return;
    }
    mediaEnd(el);
  };
  /** HTML 4.8.11.8's steps where playback "reaches the end" of a source
   *  that does not loop: paused at its length, `timeupdate`, `pause` and
   *  `ended`. */
  const mediaEnd = (el: Any): void => {
    const ask = askOf(el);
    ask.time = Number.isFinite(ask.duration) ? ask.duration : mediaTime(ask);
    ask.since = null;
    ask.ended = true;
    ask.paused = true;
    call('mediaState', el._id, 'paused', true);
    mediaSync(el);
    fireMedia(el, 'timeupdate');
    fireMedia(el, 'pause');
    fireMedia(el, 'ended');
  };
  /**
   * What the player of its source said (`__player`), where `<Html>` has
   * one play it — an `<audio>`'s, for now (`sounds.ts`): its length, over
   * the one its head was read for; how far it has got, which the clock is
   * set to; its end; or its failure. News of another source than the one
   * it has now is a player's that is gone. Where nothing loads it the
   * player's metadata is what makes it ready, as a fetch's head would.
   */
  const mediaPlayed = (
    el: Any,
    src: string,
    kind: string,
    value: string,
  ): void => {
    const ask = askOf(el);
    if (ask.src && ask.src !== src) return;
    ask.player = true;
    if (kind === 'metadata') {
      const duration = Number(value);
      if (duration > 0 && duration !== ask.duration) {
        const known = !Number.isNaN(ask.duration);
        ask.duration = duration;
        const load = ask.load;
        if (known) {
          mediaTask(() => {
            if (ask.load === load) fireMedia(el, 'durationchange');
          });
        }
      }
      if (!mediaLoads()) mediaReady(el, 4);
    } else if (kind === 'time') {
      // a seek is the page's until it lands, and an end is where it is
      if (ask.seeking || ask.ended) return;
      const time = Number(value);
      if (!Number.isFinite(time)) return;
      ask.time = time;
      if (ask.since !== null) ask.since = now();
    } else if (kind === 'ended') {
      if (!ask.ended && !el.hasAttribute('loop')) mediaEnd(el);
    } else if (kind === 'error') {
      mediaFailed(el, ask.load);
    }
  };
  /** HTML 4.8.11.9, seeking: `seeking` at once, and in a later task, once
   *  what is there can be played, the time, `timeupdate` and `seeked`. */
  const mediaSeek = (el: Any, to: number): void => {
    const ask = askOf(el);
    const time = Math.max(
      0,
      Number.isFinite(ask.duration) ? Math.min(to, ask.duration) : to,
    );
    if (ask.since !== null) ask.time = mediaTime(ask);
    ask.since = null;
    ask.seeking = true;
    ask.ended = false;
    ask.time = time;
    mediaSync(el);
    const load = ask.load;
    mediaTask(() => {
      if (ask.load !== load || !ask.seeking) return;
      fireMedia(el, 'seeking');
      const done = () => {
        if (ask.load !== load || !ask.seeking || ask.time !== time) return;
        if (ask.ready < 3) {
          setTimer(done, 50, [], false);
          return;
        }
        ask.seeking = false;
        mediaSync(el);
        fireMedia(el, 'timeupdate');
        fireMedia(el, 'seeked');
      };
      mediaTask(done);
    });
  };
  /** HTML's "notify about playing": `playing`, and the promises kept. */
  const notifyPlaying = (el: Any): void => {
    const ask = askOf(el);
    fireMedia(el, 'playing');
    const pending = ask.pending;
    ask.pending = [];
    for (const p of pending) p.resolve();
  };
  /** The ready state moved on to `ready`, and the events HTML has for each
   *  step up it (4.8.11.7), with autoplay where it is eligible. */
  const mediaReady = (el: Any, ready: number): void => {
    const ask = askOf(el);
    const was = ask.ready;
    if (ready <= was) return;
    ask.ready = ready;
    mediaSync(el);
    const load = ask.load;
    mediaTask(() => {
      if (ask.load !== load) return;
      if (was < 1) {
        fireMedia(el, 'durationchange');
        if (ask.width && el instanceof HTMLVideoElement)
          fireMedia(el, 'resize');
        fireMedia(el, 'loadedmetadata');
      }
      if (was < 2 && ready >= 2) fireMedia(el, 'loadeddata');
      if (was < 3 && ready >= 3) {
        fireMedia(el, 'canplay');
        if (ask.paused === false) notifyPlaying(el);
      }
      if (ready >= 4) {
        if (
          ask.autoplaying &&
          ask.paused !== false &&
          el.hasAttribute('autoplay')
        ) {
          ask.paused = false;
          ask.autoplaying = false;
          call('mediaState', el._id, 'paused', false);
          mediaSync(el);
          fireMedia(el, 'play');
          notifyPlaying(el);
        }
        if (was < 4) fireMedia(el, 'canplaythrough');
      }
    });
  };
  /** HTML's "dedicated media source failure steps", and those of a
   *  `<source>` that was the last: an error, `error`, and the promises
   *  turned down. */
  const mediaFailed = (el: Any, load: number): void => {
    const ask = askOf(el);
    if (ask.load !== load) return;
    ask.abort?.();
    ask.abort = null;
    ask.error = new MediaError(4);
    ask.network = 3;
    mediaSync(el);
    mediaTask(() => {
      if (ask.load !== load) return;
      fireMedia(el, 'error');
      const pending = ask.pending;
      ask.pending = [];
      for (const p of pending) {
        p.reject(
          new DOMException(
            'Failed to load because no supported source was found.',
            'NotSupportedError',
          ),
        );
      }
    });
  };
  /** Three seconds from now, `stalled`, where nothing comes before
   *  (HTML 4.8.11.5, "is currently stalled"). */
  const mediaWatch = (el: Any): void => {
    const ask = askOf(el);
    mediaUnwatch(ask);
    const load = ask.load;
    ask.stallTimer = setTimer(
      () => {
        ask.stallTimer = null;
        if (ask.load !== load || ask.network !== 2) return;
        ask.stalled = true;
        mediaSync(el);
        fireMedia(el, 'stalled');
      },
      3000,
      [],
      false,
    );
  };
  const mediaUnwatch = (ask: MediaAsk): void => {
    if (ask.stallTimer !== null) clearTimer(ask.stallTimer);
    ask.stallTimer = null;
  };
  /** The resource fetch algorithm (HTML 4.8.11.5), as far as the host
   *  reads the source for it (`mediaFetch`), which never hands the page
   *  its bytes: another origin's are not the page's to read. */
  const mediaFetch = (el: Any, url: string): void => {
    const ask = askOf(el);
    ask.progressed = 0;
    ask.abort = () => call('mediaAbort', el._id);
    mediaWatch(el);
    call('mediaFetch', el._id, ask.load, url);
  };
  /** What the host's read of a source came to (`__media`): bytes in, so
   *  `progress` and nothing stalled; its head read, its data past it, or
   *  enough of it, each a step up the ready state; or a failure. */
  const mediaHeard = (
    el: Any,
    load: number,
    kind: string,
    a: string,
    b: string,
    c: string,
  ): void => {
    const ask = askOf(el);
    if (ask.load !== load || ask.network !== 2) return;
    if (kind === 'progress') {
      mediaWatch(el);
      if (ask.stalled) {
        ask.stalled = false;
        mediaSync(el);
      }
      const at = now();
      if (at - ask.progressed >= 350) {
        ask.progressed = at;
        mediaTask(() => {
          if (ask.load === load) fireMedia(el, 'progress');
        });
      }
    } else if (kind === 'info') {
      ask.duration = Number(a);
      ask.width = Number(b);
      ask.height = Number(c);
      mediaReady(el, 1);
    } else if (kind === 'data') {
      mediaReady(el, 2);
    } else if (kind === 'enough') {
      // as much as it wants: what is not read is let go, `suspend`
      mediaUnwatch(ask);
      mediaReady(el, 4);
      ask.abort = null;
      ask.network = 1;
      ask.stalled = false;
      mediaSync(el);
      mediaTask(() => {
        if (ask.load === load) fireMedia(el, 'suspend');
      });
    } else if (kind === 'failed') {
      mediaUnwatch(ask);
      mediaFailed(el, load);
    }
  };
  /** The resource selection algorithm (HTML 4.8.11.5): its `src`, or else
   *  the first `<source>` whose type can play, fetched; neither, and it is
   *  empty again. */
  const mediaSelect = (el: Any): void => {
    const ask = askOf(el);
    ask.network = 3;
    mediaSync(el);
    const load = ask.load;
    mediaTask(() => {
      if (ask.load !== load) return;
      let url: string | null = null;
      if (el.hasAttribute('src')) {
        const raw = el.getAttribute('src');
        url = raw ? String(call('resolve', raw)) : '';
      } else {
        for (const source of Array.from(el.children as ArrayLike<Any>)) {
          if (source.localName !== 'source' || !source.hasAttribute('src')) {
            continue;
          }
          const type = source.getAttribute('type');
          if (type && !el.canPlayType(type) && !READ_TYPES.test(type)) {
            continue;
          }
          url = String(call('resolve', source.getAttribute('src')));
          break;
        }
        if (url === null) {
          ask.network = 0;
          mediaSync(el);
          return;
        }
      }
      if (!url) {
        mediaFailed(el, load);
        return;
      }
      ask.src = url;
      ask.network = 2;
      mediaSync(el);
      fireMedia(el, 'loadstart');
      mediaFetch(el, url);
    });
  };
  /** The types a source is read here for whatever the player says. */
  const READ_TYPES =
    /^\s*(?:video|audio)\/(?:mp4|webm|mpeg|mp3|ogg|wav|x-wav|wave|x-m4a)\b/i;
  /** HTML 4.8.11.5, the media element load algorithm: what it was doing
   *  ends — its fetch, its clock, a seek — it is paused, its pending
   *  `play()`s turned down, and it selects a source again. */
  const mediaLoad = (el: Any): void => {
    const ask = askOf(el);
    const network = ask.network;
    ask.load += 1;
    ask.abort?.();
    ask.abort = null;
    mediaUnwatch(ask);
    const load = ask.load;
    if (network === 2 || network === 1) {
      mediaTask(() => {
        if (ask.load === load) fireMedia(el, 'abort');
      });
    }
    if (network !== 0) {
      mediaTask(() => {
        if (ask.load === load) fireMedia(el, 'emptied');
      });
      ask.network = 0;
      ask.ready = 0;
      if (ask.paused === false) {
        ask.paused = true;
        call('mediaState', el._id, 'paused', true);
        const pending = ask.pending;
        ask.pending = [];
        for (const p of pending) {
          p.reject(
            new DOMException(
              'The play() request was interrupted by a new load request.',
              'AbortError',
            ),
          );
        }
      }
      ask.seeking = false;
      const time = mediaTime(ask);
      ask.since = null;
      ask.time = 0;
      if (time !== 0) {
        mediaTask(() => {
          if (ask.load === load) fireMedia(el, 'timeupdate');
        });
      }
      ask.duration = NaN;
    }
    ask.playbackRate = ask.defaultPlaybackRate;
    ask.error = null;
    ask.ended = false;
    ask.stalled = false;
    ask.autoplaying = true;
    ask.player = false;
    mediaSelect(el);
  };
  class MediaError {
    static readonly MEDIA_ERR_ABORTED = 1;
    static readonly MEDIA_ERR_NETWORK = 2;
    static readonly MEDIA_ERR_DECODE = 3;
    static readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
    _code: number;
    constructor(code: number) {
      this._code = code;
    }
    get code(): number {
      return this._code;
    }
    get message(): string {
      return this._code === 4 ? 'MEDIA_ELEMENT_ERROR: Format error' : '';
    }
  }

  class HTMLMediaElement extends HTMLElement {
    static readonly NETWORK_EMPTY = 0;
    static readonly NETWORK_IDLE = 1;
    static readonly NETWORK_LOADING = 2;
    static readonly NETWORK_NO_SOURCE = 3;
    static readonly HAVE_NOTHING = 0;
    static readonly HAVE_METADATA = 1;
    static readonly HAVE_CURRENT_DATA = 2;
    static readonly HAVE_FUTURE_DATA = 3;
    static readonly HAVE_ENOUGH_DATA = 4;
    // what it is told to do is the player's as well: `<Html>` mounts core's
    // `<video>` over a video it can show, and hands it what the page asked
    // here (`mediaState`)
    /** Paused until the page plays it, or until it loads with `autoplay`.
     *  Where nothing loads it, one with `autoplay` is playing from the
     *  start, as the player plays it. */
    get paused(): boolean {
      const ask = askOf(this);
      if (ask.paused !== null) return ask.paused;
      return mediaLoads() || !this.hasAttribute('autoplay');
    }
    get ended(): boolean {
      return askOf(this).ended;
    }
    get seeking(): boolean {
      return askOf(this).seeking;
    }
    get readyState(): number {
      return askOf(this).ready;
    }
    get networkState(): number {
      return askOf(this).network;
    }
    get duration(): number {
      return askOf(this).duration;
    }
    /** Where the clock is: where the page last sought to where nothing
     *  loads it, since nothing reports where the player has come to. */
    get currentTime(): number {
      return mediaTime(askOf(this));
    }
    /** HTML 4.8.11.9, seeking: `seeking`, then `timeupdate` and `seeked`
     *  once it is there; before its metadata, only where it starts. */
    set currentTime(v: Any) {
      const time = Math.max(0, mediaNumber(v, 'currentTime'));
      const ask = askOf(this);
      call('mediaState', this._id, 'currentTime', time);
      if (mediaLoads()) {
        if (ask.ready === 0) ask.time = time;
        else mediaSeek(this, time);
        return;
      }
      ask.time = time;
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
      if (ask.since !== null) {
        ask.time = mediaTime(ask);
        ask.since = now();
      }
      ask.playbackRate = rate;
      call('mediaState', this._id, 'playbackRate', rate);
      mediaTask(() => fireMedia(this, 'ratechange'));
    }
    /** The rate a load starts it at (HTML 4.8.11.8). */
    get defaultPlaybackRate(): number {
      return askOf(this).defaultPlaybackRate;
    }
    set defaultPlaybackRate(v: Any) {
      const rate = mediaNumber(v, 'defaultPlaybackRate');
      const ask = askOf(this);
      if (ask.defaultPlaybackRate === rate) return;
      ask.defaultPlaybackRate = rate;
      mediaTask(() => fireMedia(this, 'ratechange'));
    }
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
      return askOf(this).src;
    }
    get error(): Any {
      return askOf(this).error;
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
     * HTML 4.8.11.8, the play steps: a source selected where it has none
     * yet, playing at once, and in a task `play` where it was paused, then
     * `waiting` where too little is in, or `playing` and the promise kept —
     * unless a `pause()` came between, which turns the promise down. Where
     * nothing loads it, it is ready as soon as it is asked.
     */
    play(): Promise<void> {
      const ask = askOf(this);
      const loads = mediaLoads();
      if (loads && ask.error?.code === 4) {
        return Promise.reject(
          new DOMException(
            'The element has no supported sources.',
            'NotSupportedError',
          ),
        );
      }
      if (loads && ask.network === 0) mediaSelect(this);
      if (loads && ask.ended) mediaSeek(this, 0);
      const was = this.paused;
      const pauses = ask.pauses;
      ask.paused = false;
      ask.autoplaying = false;
      call('mediaState', this._id, 'paused', false);
      mediaSync(this);
      const promise = new Promise<void>((resolve, reject) => {
        ask.pending.push({ resolve, reject });
      });
      const load = ask.load;
      mediaTask(() => {
        if (was) fireMedia(this, 'play');
        if (ask.pauses !== pauses || ask.load !== load) return;
        if (loads && ask.ready < 3) {
          fireMedia(this, 'waiting');
          return;
        }
        if (was) notifyPlaying(this);
        else {
          const pending = ask.pending;
          ask.pending = [];
          for (const p of pending) p.resolve();
        }
      });
      return promise;
    }
    /** The internal pause steps: paused at once, and in a task
     *  `timeupdate`, `pause` and the promises `play()` handed out before it
     *  turned down, as Chrome turns them down. */
    pause(): void {
      const ask = askOf(this);
      if (mediaLoads() && ask.network === 0) mediaSelect(this);
      const was = this.paused;
      ask.paused = true;
      ask.autoplaying = false;
      call('mediaState', this._id, 'paused', true);
      mediaSync(this);
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
    /** HTML 4.8.11.5, the media element load algorithm: whatever it was
     *  doing ends, it is paused, and it loads its source again. */
    load(): void {
      if (mediaLoads()) {
        mediaLoad(this);
        return;
      }
      if (this.paused) return;
      askOf(this).paused = true;
      call('mediaState', this._id, 'paused', true);
      mediaTask(() => fireMedia(this, 'pause'));
    }
    /** HTML 4.8.11.3: whether what plays the page's media can play the
     *  type — the host's to say, and `''` where it says nothing. A page
     *  asks before it picks how to load a stream: an HLS player that finds
     *  no `MediaSource` sets the playlist as the `src` where the answer for
     *  `application/vnd.apple.mpegurl` is not `''`, as on Safari. */
    canPlayType(type: Any): string {
      return String(call('canPlayType', str(type)));
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
    /** Its source's size, as its container says it, once that is read. */
    get videoWidth(): number {
      return askOf(this).ready > 0 ? askOf(this).width : 0;
    }
    get videoHeight(): number {
      return askOf(this).ready > 0 ? askOf(this).height : 0;
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
    /** What the slot is assigned (DOM 4.2.2.3), or with `flatten`, its
     *  fallback where it is assigned nothing and the slots in what it has,
     *  theirs. */
    assignedNodes(options?: Any): Any[] {
      const ids = str(call('assignedNodes', this._id, !!options?.flatten));
      return ids ? ids.split(',').map((id) => wrap(Number(id))) : [];
    }
    assignedElements(options?: Any): Any[] {
      return this.assignedNodes(options).filter((n) => n.nodeType === 1);
    }
  }
  // an element's or a text's slot (DOM 4.2.9, `Slottable`), where it is in
  // an open tree
  for (const proto of [Element.prototype, Text.prototype]) {
    Object.defineProperty(proto, 'assignedSlot', {
      get(this: Any) {
        return wrap(Number(call('assignedSlot', this._id, false)));
      },
      enumerable: true,
      configurable: true,
    });
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

  /** Where a rule's block opens: its first `{` that no backslash
   *  escapes, outside a string and a bracket, or -1 for a statement. */
  const blockStart = (text: string): number => {
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (c === '\\') i += 1;
      else if (c === '"' || c === "'") {
        const end = text.indexOf(c, i + 1);
        if (end < 0) return -1;
        i = end;
      } else if (c === '(' || c === '[') depth += 1;
      else if (c === ')' || c === ']') depth -= 1;
      else if (c === '{' && depth <= 0) return i;
    }
    return -1;
  };
  /** What a rule's text says before its block, or all of a statement. */
  const preludeOf = (text: string): string => {
    const open = blockStart(text);
    return (open < 0 ? text.replace(/;\s*$/, '') : text.slice(0, open)).trim();
  };
  /** What is inside a rule's block. */
  const blockOf = (text: string): string => {
    const open = blockStart(text);
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
  /** What a `@position-try` rule takes (CSS Anchor Positioning 1, 4.4,
   *  the accepted `@position-try` properties), in the order its
   *  descriptors' interface lists them (8.1): the margins, the insets,
   *  the sizes, the self-alignment, `position-anchor` and
   *  `position-area`. */
  const POSITION_TRY_PROPERTIES = [
    'margin',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'margin-block',
    'margin-block-start',
    'margin-block-end',
    'margin-inline',
    'margin-inline-start',
    'margin-inline-end',
    'inset',
    'inset-block',
    'inset-block-start',
    'inset-block-end',
    'inset-inline',
    'inset-inline-start',
    'inset-inline-end',
    'top',
    'left',
    'right',
    'bottom',
    'width',
    'min-width',
    'max-width',
    'height',
    'min-height',
    'max-height',
    'block-size',
    'min-block-size',
    'max-block-size',
    'inline-size',
    'min-inline-size',
    'max-inline-size',
    'place-self',
    'align-self',
    'justify-self',
    'position-anchor',
    'position-area',
  ];
  const POSITION_TRY_TAKES = new Set(POSITION_TRY_PROPERTIES);
  /** A `@position-try` rule's declarations of what it takes, in order, a
   *  name declared again standing where it was declared last. */
  const tryDeclarations = (
    block: string,
  ): { name: string; value: string; important: boolean }[] => {
    const out: { name: string; value: string; important: boolean }[] = [];
    for (const part of block.split(/;(?![^(]*\))/)) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const name = part.slice(0, colon).trim().toLowerCase();
      if (!POSITION_TRY_TAKES.has(name)) continue;
      let value = part.slice(colon + 1).trim();
      const important = /!\s*important$/i.test(value);
      if (important) value = value.replace(/\s*!\s*important$/i, '');
      if (!value) continue;
      const at = out.findIndex((d) => d.name === name);
      if (at >= 0) out.splice(at, 1);
      out.push({ name, value, important });
    }
    return out;
  };
  /**
   * A `@position-try` rule's declarations (CSS Anchor Positioning 1, 8.1):
   * a declaration block of what the rule takes, read from the rule's text,
   * and written back to it as it changes, which edits the rule in its sheet
   * (`replaceRule`). Each property it takes is an attribute, by its name
   * and in camel case; any other is none.
   */
  class CSSPositionTryDescriptors {
    _rule: Any;
    constructor(rule: Any) {
      this._rule = rule;
    }
    _decls(): { name: string; value: string; important: boolean }[] {
      return tryDeclarations(blockOf(this._rule._text));
    }
    _write(decls: { name: string; value: string; important: boolean }[]) {
      replaceRule(this._rule, positionTryText(this._rule.name, decls));
    }
    get parentRule(): Any {
      return this._rule;
    }
    get length(): number {
      return this._decls().length;
    }
    item(i: Any): string {
      return this._decls()[Number(i) >>> 0]?.name ?? '';
    }
    getPropertyValue(name: Any): string {
      const n = str(name).toLowerCase();
      return this._decls().find((d) => d.name === n)?.value ?? '';
    }
    getPropertyPriority(name: Any): string {
      const n = str(name).toLowerCase();
      return this._decls().find((d) => d.name === n)?.important
        ? 'important'
        : '';
    }
    setProperty(name: Any, value: Any, priority: Any = ''): void {
      const n = str(name).toLowerCase();
      if (!POSITION_TRY_TAKES.has(n)) return;
      const v = value === null || value === undefined ? '' : str(value).trim();
      const decls = this._decls();
      const at = decls.findIndex((d) => d.name === n);
      if (!v) {
        if (at < 0) return;
        decls.splice(at, 1);
      } else {
        const decl = {
          name: n,
          value: v,
          important: str(priority).toLowerCase() === 'important',
        };
        if (at >= 0) decls[at] = decl;
        else decls.push(decl);
      }
      this._write(decls);
    }
    removeProperty(name: Any): string {
      const was = this.getPropertyValue(name);
      if (was) this.setProperty(name, '');
      return was;
    }
    get cssText(): string {
      return declarationsText(this._decls());
    }
    set cssText(v: Any) {
      this._write(tryDeclarations(str(v)));
    }
  }
  for (const name of POSITION_TRY_PROPERTIES) {
    const descriptor = {
      get(this: Any): string {
        return this.getPropertyValue(name);
      },
      set(this: Any, v: Any): void {
        this.setProperty(name, v);
      },
      configurable: true,
      enumerable: true,
    };
    Object.defineProperty(
      CSSPositionTryDescriptors.prototype,
      name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
      descriptor,
    );
    if (name.includes('-')) {
      Object.defineProperty(CSSPositionTryDescriptors.prototype, name, {
        ...descriptor,
      });
    }
  }
  /** Declarations as CSSOM serializes a block: each ended. */
  const declarationsText = (
    decls: readonly { name: string; value: string; important: boolean }[],
  ): string =>
    decls
      .map((d) => `${d.name}: ${d.value}${d.important ? ' !important' : ''};`)
      .join(' ');
  /** A `@position-try` rule as CSSOM serializes it. */
  const positionTryText = (
    name: string,
    decls: readonly { name: string; value: string; important: boolean }[],
  ): string => {
    const body = declarationsText(decls);
    return `@position-try ${name} { ${body ? `${body} ` : ''}}`;
  };
  /**
   * Put a rule's new text in its place: where it is one of a sheet's own
   * rules, deleted from the sheet and its new text inserted where it was,
   * as a page's own `deleteRule` and `insertRule` would — which the host
   * writes back to the sheet, for the document to be styled by — with the
   * rule's object standing for it in the sheet's rules still.
   */
  const replaceRule = (rule: Any, text: string): void => {
    rule._text = text;
    const sheet = rule.parentStyleSheet;
    if (!sheet || rule.parentRule) return;
    const at = Array.prototype.indexOf.call(sheet.cssRules, rule);
    if (at < 0) return;
    sheet.deleteRule(at);
    sheet.insertRule(text, at);
    const list = sheet.cssRules;
    if (list && list[at] !== rule) list[at] = rule;
  };
  /** A `@position-try` rule (CSS Anchor Positioning 1, 8.1): its name, and
   *  its declarations, which a page may set. */
  class CSSPositionTryRule extends CSSRule {
    _style: Any = null;
    get name(): string {
      return conditionOf(this._text).trim();
    }
    get style(): Any {
      return (this._style ??= new CSSPositionTryDescriptors(this));
    }
    set style(v: Any) {
      this.style.cssText = v;
    }
    override get cssText(): string {
      return positionTryText(this.name, tryDeclarations(blockOf(this._text)));
    }
    override set cssText(_v: Any) {}
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
  /** An `@view-transition` rule's descriptors as they parse (CSS View
   *  Transitions 2, 2.1): `navigation`, `auto` or `none`, and `types`,
   *  `none` or a list of idents, each `null` where the block has none
   *  that parses. A later declaration that parses wins. */
  const viewTransitionDescriptors = (
    block: string,
  ): { navigation: string | null; types: string[] | null } => {
    let navigation: string | null = null;
    let types: string[] | null = null;
    for (const part of block.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const name = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).trim();
      if (name === 'navigation') {
        if (/^(?:auto|none)$/i.test(value)) navigation = value.toLowerCase();
      } else if (name === 'types') {
        const list = transitionTypesOf(value);
        if (list) types = list;
      }
    }
    return { navigation, types };
  };
  /** The idents a `types` descriptor lists, unescaped, or null where it
   *  is no list of them: `none` alone is the empty list, and none of them
   *  may be `none`, `default`, a CSS-wide keyword or the user agent's
   *  `-ua-`, which Chromium reads case-sensitively. */
  const transitionTypesOf = (value: string): string[] | null => {
    const out: string[] = [];
    let i = 0;
    const hex = /[0-9a-f]/i;
    while (i < value.length) {
      if (/\s/.test(value[i])) {
        i += 1;
        continue;
      }
      let ident = '';
      const start = i;
      while (i < value.length && !/\s/.test(value[i])) {
        const c = value[i];
        if (c === '\\') {
          if (i + 1 >= value.length || value[i + 1] === '\n') return null;
          let digits = '';
          let j = i + 1;
          while (digits.length < 6 && j < value.length && hex.test(value[j])) {
            digits += value[j];
            j += 1;
          }
          if (digits) {
            if (j < value.length && /\s/.test(value[j])) j += 1;
            const code = parseInt(digits, 16);
            ident +=
              code === 0 ||
              code > 0x10ffff ||
              (code >= 0xd800 && code <= 0xdfff)
                ? '\uFFFD'
                : String.fromCodePoint(code);
            i = j;
          } else {
            ident += value[i + 1];
            i += 2;
          }
        } else if (/[-\w\u0080-\uffff]/.test(c)) {
          ident += c;
          i += 1;
        } else {
          return null;
        }
      }
      // an ident starts with a letter, an underscore, a non-ASCII letter,
      // an escape, or a hyphen before any of those or another hyphen
      const raw = value.slice(start, i);
      if (!/^(?:-?(?:[a-z_\u0080-\uffff]|\\)|--)/i.test(raw)) return null;
      out.push(ident);
    }
    if (out.length === 1 && /^none$/i.test(out[0])) return [];
    for (const ident of out) {
      if (
        /^(?:none|default|initial|inherit|unset|revert|revert-layer)$/i.test(
          ident,
        ) ||
        ident.startsWith('-ua-')
      ) {
        return null;
      }
    }
    return out.length ? out : null;
  };
  /** An `@view-transition` rule (CSS View Transitions 2, 2.1), its
   *  descriptors read only and its text as they parse. */
  class CSSViewTransitionRule extends CSSRule {
    get navigation(): string {
      return viewTransitionDescriptors(blockOf(this._text)).navigation ?? '';
    }
    get types(): readonly string[] {
      return Object.freeze([
        ...(viewTransitionDescriptors(blockOf(this._text)).types ?? []),
      ]);
    }
    override get cssText(): string {
      const { navigation, types } = viewTransitionDescriptors(
        blockOf(this._text),
      );
      let out = '@view-transition { ';
      if (navigation) out += `navigation: ${navigation}; `;
      if (types) {
        out += `types: ${types.length ? types.map(cssEscape).join(' ') : 'none'}; `;
      }
      return `${out}}`;
    }
    override set cssText(_v: Any) {}
  }
  /** Whether CSS drops a rule as it parses it: an `@view-transition` with
   *  a prelude (CSS View Transitions 2, 2.1). */
  const droppedRule = (text: string): boolean =>
    /^@view-transition(?![\w-])/i.test(text) &&
    preludeOf(text).slice('@view-transition'.length).trim() !== '';
  const RULE_CLASSES: Record<string, Any> = {
    'view-transition': CSSViewTransitionRule,
    media: CSSMediaRule,
    supports: CSSSupportsRule,
    container: CSSContainerRule,
    import: CSSImportRule,
    'font-face': CSSFontFaceRule,
    keyframes: CSSKeyframesRule,
    'position-try': CSSPositionTryRule,
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
    for (const text of texts) {
      if (!droppedRule(text)) list.push(ruleOf(text, sheet, parent));
    }
    return list;
  };
  /** The one rule a text is, for `insertRule`. */
  const oneRule = (text: string): string => {
    const rules = JSON.parse(String(call('cssRules', text))) as string[];
    if (rules.length !== 1 || droppedRule(rules[0])) {
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
      // a rule the host would keep and CSS drops (`droppedRule`)
      if (/^\s*@view-transition/i.test(text)) oneRule(text);
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

  /** `CSS.registerProperty()`'s registrations (CSS Properties and Values
   *  1, 4.1), each as the `@property` rule it amounts to, which the host
   *  applies after every sheet, since a registration wins over a sheet's
   *  `@property`, and at once, since a page reads it straight after. */
  const registeredProperties = new Map<string, string>();
  const registerProperty = (definition: Any): void => {
    const fail = (message: string, name: string): never => {
      throw new DOMException(
        `Failed to execute 'registerProperty' on 'CSS': ${message}`,
        name,
      );
    };
    const required = (member: string): never => {
      throw new TypeError(
        `Failed to execute 'registerProperty' on 'CSS': Failed to read the '${member}' property from 'PropertyDefinition': Required member is undefined.`,
      );
    };
    if (definition === null || typeof definition !== 'object') {
      throw new TypeError(
        "Failed to execute 'registerProperty' on 'CSS': parameter 1 is not of type 'PropertyDefinition'.",
      );
    }
    // read as IDL reads a dictionary: its members in order, once each
    const inherits = definition.inherits;
    const initialValue = definition.initialValue;
    const nameValue = definition.name;
    const syntaxValue = definition.syntax;
    if (inherits === undefined) required('inherits');
    if (nameValue === undefined) required('name');
    const name = str(nameValue);
    const syntax = syntaxValue === undefined ? '*' : str(syntaxValue);
    const initial = initialValue === undefined ? null : str(initialValue);
    if (!/^--/.test(name)) {
      fail(
        `The name provided is not a valid custom property name.`,
        'SyntaxError',
      );
    }
    const answer = str(
      call('propertyRegistration', syntax, initial ?? '', initial !== null),
    );
    if (answer) fail(answer, 'SyntaxError');
    if (registeredProperties.has(name)) {
      fail(
        'The name provided has already been registered.',
        'InvalidModificationError',
      );
    }
    registeredProperties.set(
      name,
      `@property ${cssEscape(name)} { syntax: ${JSON.stringify(syntax)}; ` +
        `inherits: ${inherits ? 'true' : 'false'};` +
        (initial === null ? '' : ` initial-value: ${initial};`) +
        ' }',
    );
    call('registeredProperties', [...registeredProperties.values()].join('\n'));
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
  Object.defineProperty(
    HTMLStyleElement.prototype,
    'blocking',
    tokenList('blocking', ['render']),
  );
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
  /** The HTML elements whose interface is `HTMLElement` itself (HTML 3.2.2,
   *  "element definitions"), which no class here names. */
  const PLAIN_HTML = new Set([
    'abbr',
    'acronym',
    'address',
    'article',
    'aside',
    'b',
    'basefont',
    'bdi',
    'bdo',
    'big',
    'center',
    'cite',
    'code',
    'dd',
    'dfn',
    'dt',
    'em',
    'figcaption',
    'figure',
    'footer',
    'header',
    'hgroup',
    'i',
    'kbd',
    'main',
    'mark',
    'nav',
    'nobr',
    'noembed',
    'noframes',
    'noscript',
    'plaintext',
    'rb',
    'rp',
    'rt',
    'rtc',
    'ruby',
    's',
    'samp',
    'search',
    'section',
    'small',
    'strike',
    'strong',
    'sub',
    'summary',
    'sup',
    'tt',
    'u',
    'var',
    'wbr',
  ]);
  /** The class of an HTML element no class here names: `HTMLElement` for
   *  one whose interface it is and for a custom element's name, and
   *  `HTMLUnknownElement` for any other (HTML 3.2.2). */
  const htmlKind = (name: string): Any =>
    PLAIN_HTML.has(name) || name.includes('-')
      ? HTMLElement
      : HTMLUnknownElement;

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
    popoverActivation(target);
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
          if (dispatch(form, ev)) submitForm(form, target, false);
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
      if (
        (at instanceof HTMLAnchorElement || at instanceof HTMLAreaElement) &&
        !followLink(at, false)
      ) {
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

  // --- the document's fonts -------------------------------------------------------
  //
  // `document.fonts` (CSS Font Loading 3): the faces the document's
  // `@font-face` rules declare, which `<Html>` loads — where a style wants
  // one, or where `load()` asks — and tells the page of through
  // `__fontsLoaded` and `__fontsSettled`. A face a script makes with `new
  // FontFace` is not among them: nothing hands its data to the document's
  // fonts yet, so there is no `FontFace` to construct, and `add()` takes
  // none.

  let fontSeq = 0;
  /** The `load()`s waiting on `<Html>`, by id. */
  const fontLoads = new Map<number, (loaded: boolean[]) => void>();
  /** What waits for the document's faces to settle, by id. */
  const fontSettles = new Map<number, () => void>();
  const NETWORK_ERROR = () =>
    new DOMException('A network error occurred.', 'NetworkError');

  /**
   * A face of the document's, as `document.fonts` hands it over (CSS Font
   * Loading 3, 2.1): its rule's descriptors, and its status, which is
   * `<Html>`'s. One object a face, for as long as the document declares it
   * as it does (`FontFaceSet._face`). A descriptor a page sets reads back,
   * and changes nothing of the document's face.
   */
  class FontFace {
    _set: Any;
    _key: string;
    _desc: Record<string, string>;
    /** Its `loaded`, made as it is first asked for. */
    _loaded: Any = null;
    _settle: [Any, Any] | null = null;
    constructor(set: Any, key: string, desc: Record<string, string>) {
      this._set = set;
      this._key = key;
      this._desc = {
        display: 'auto',
        featureSettings: 'normal',
        variationSettings: 'normal',
        ascentOverride: 'normal',
        descentOverride: 'normal',
        lineGapOverride: 'normal',
        ...desc,
      };
    }
    get family(): string {
      return this._desc.family;
    }
    set family(v: Any) {
      this._desc.family = str(v);
    }
    get style(): string {
      return this._desc.style;
    }
    set style(v: Any) {
      this._desc.style = str(v);
    }
    get weight(): string {
      return this._desc.weight;
    }
    set weight(v: Any) {
      this._desc.weight = str(v);
    }
    get stretch(): string {
      return this._desc.stretch;
    }
    set stretch(v: Any) {
      this._desc.stretch = str(v);
    }
    get unicodeRange(): string {
      return this._desc.unicodeRange;
    }
    set unicodeRange(v: Any) {
      this._desc.unicodeRange = str(v);
    }
    get display(): string {
      return this._desc.display;
    }
    set display(v: Any) {
      this._desc.display = str(v);
    }
    get featureSettings(): string {
      return this._desc.featureSettings;
    }
    set featureSettings(v: Any) {
      this._desc.featureSettings = str(v);
    }
    get variationSettings(): string {
      return this._desc.variationSettings;
    }
    set variationSettings(v: Any) {
      this._desc.variationSettings = str(v);
    }
    get ascentOverride(): string {
      return this._desc.ascentOverride;
    }
    set ascentOverride(v: Any) {
      this._desc.ascentOverride = str(v);
    }
    get descentOverride(): string {
      return this._desc.descentOverride;
    }
    set descentOverride(v: Any) {
      this._desc.descentOverride = str(v);
    }
    get lineGapOverride(): string {
      return this._desc.lineGapOverride;
    }
    set lineGapOverride(v: Any) {
      this._desc.lineGapOverride = str(v);
    }
    get status(): string {
      return this._set._statuses().get(this._key) ?? 'error';
    }
    /** Settles once the face has loaded, or could not: pending while
     *  nothing has asked for it. */
    get loaded(): Any {
      if (!this._loaded) {
        const status = this.status;
        if (status === 'loaded') this._loaded = Promise.resolve(this);
        else if (status === 'error')
          this._loaded = Promise.reject(NETWORK_ERROR());
        else {
          this._loaded = new Promise((resolve, reject) => {
            this._settle = [resolve, reject];
          });
          if (status === 'loading') this._set._watch(this);
        }
      }
      return this._loaded;
    }
    load(): Any {
      const loaded = this.loaded;
      if (this._settle) this._set._loadFaces([this]).catch(() => {});
      return loaded;
    }
    /** What came of loading it, which `loaded` settles with. */
    _done(ok: boolean): void {
      const settle = this._settle;
      if (!settle) return;
      this._settle = null;
      if (ok) settle[0](this);
      else settle[1](NETWORK_ERROR());
    }
  }

  /** `document.fonts` (CSS Font Loading 3, 2.5): the document's faces. */
  class FontFaceSet extends EventTarget {
    _doc: Any;
    _faces = new Map<string, Any>();
    /** The `load()`s on their way to `<Html>` and back. */
    _loading = 0;
    /** What waits for the next of them to come back. */
    _afterLoad: (() => void)[] = [];
    _ready: Any = null;
    _readyDone = false;
    constructor(doc: Any) {
      super();
      this._doc = doc;
    }
    /** Each face's status, by key, as `<Html>` has it now. */
    _statuses(): Map<string, string> {
      const out = new Map<string, string>();
      for (const face of this._list()) out.set(face.key, face.status);
      return out;
    }
    _list(): Any[] {
      return JSON.parse(str(call('fontFaces', this._doc._id)) || '[]');
    }
    /** The faces as objects, one a face. */
    _all(): Any[] {
      return this._list().map((d: Any) => this._face(d));
    }
    _face(desc: Any): Any {
      let face = this._faces.get(desc.key);
      if (!face) {
        const { key, status: _status, ...rest } = desc;
        this._faces.set(key, (face = new FontFace(this, key, rest)));
      }
      return face;
    }
    /** The keys of the faces a `font` matches, or null for a `font` that
     *  is none. */
    _match(font: Any, text: Any): string[] | null {
      const raw = str(call('fontMatch', this._doc._id, str(font), str(text)));
      return raw ? JSON.parse(raw).keys : null;
    }
    /** Load faces, settling each one's `loaded`; rejects where one could
     *  not. */
    _loadFaces(faces: Any[]): Any {
      if (!faces.length) return Promise.resolve([]);
      const id = ++fontSeq;
      this._loading += 1;
      return new Promise((resolve, reject) => {
        fontLoads.set(id, (loaded) => {
          this._loading -= 1;
          faces.forEach((face, i) => face._done(loaded[i] === true));
          for (const fn of this._afterLoad.splice(0)) fn();
          if (loaded.every((ok) => ok === true)) resolve(faces);
          else reject(NETWORK_ERROR());
        });
        call(
          'fontLoad',
          this._doc._id,
          id,
          JSON.stringify(faces.map((f) => f._key)),
        );
      });
    }
    /** Call `fn` once none of the document's faces is on its way. */
    _whenSettled(fn: () => void): void {
      const id = ++fontSeq;
      fontSettles.set(id, fn);
      call('fontsSettled', this._doc._id, id);
    }
    /** Settle a face's `loaded` once it has left `loading`, which a style
     *  asked for and no `load()` waits on. */
    _watch(face: Any): void {
      this._whenSettled(() => {
        const status = face.status;
        if (status === 'loading') this._watch(face);
        else if (status !== 'unloaded') face._done(status === 'loaded');
      });
    }
    get status(): string {
      if (this._loading) return 'loading';
      for (const status of this._statuses().values()) {
        if (status === 'loading') return 'loading';
      }
      return 'loaded';
    }
    /** Settles once the document's faces have: the same promise until
     *  another face starts loading. */
    get ready(): Any {
      const loading = this.status === 'loading';
      if (!this._ready || (loading && this._readyDone)) {
        this._readyDone = !loading;
        this._ready = loading
          ? new Promise((resolve) => this._readyOnce(resolve))
          : Promise.resolve(this);
      }
      return this._ready;
    }
    _readyOnce(resolve: Any): void {
      if (this._loading) {
        this._afterLoad.push(() => this._readyOnce(resolve));
        return;
      }
      this._whenSettled(() => {
        if (this.status === 'loading') this._readyOnce(resolve);
        else {
          this._readyDone = true;
          resolve(this);
        }
      });
    }
    /** The faces `font` matches with a character of `text` in their
     *  ranges, once they have loaded (2.5.2). */
    load(font: Any, text: Any = ' '): Any {
      return new Promise((resolve, reject) => {
        queueMicrotask(() => {
          try {
            const keys = this._match(font, text);
            if (!keys) {
              reject(
                new DOMException(
                  `Could not resolve '${str(font)}' as a font.`,
                  'SyntaxError',
                ),
              );
              return;
            }
            const all = new Map(this._all().map((f: Any) => [f._key, f]));
            const faces = keys.map((k) => all.get(k)).filter(Boolean);
            this._loadFaces(faces).then(resolve, reject);
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    /** Whether the faces `font` matches have all loaded (2.5.3). */
    check(font: Any, text: Any = ' '): boolean {
      const keys = this._match(font, text);
      if (!keys) {
        throw new DOMException(
          `Could not resolve '${str(font)}' as a font.`,
          'SyntaxError',
        );
      }
      const statuses = this._statuses();
      return keys.every((k) => statuses.get(k) === 'loaded');
    }
    get size(): number {
      return this._list().length;
    }
    has(face: Any): boolean {
      return this._all().includes(face);
    }
    forEach(fn: Any, thisArg?: Any): void {
      for (const face of this._all()) fn.call(thisArg, face, face, this);
    }
    values(): Any {
      return this._all()[Symbol.iterator]();
    }
    keys(): Any {
      return this.values();
    }
    entries(): Any {
      return this._all()
        .map((f: Any) => [f, f])
        [Symbol.iterator]();
    }
    [Symbol.iterator](): Any {
      return this.values();
    }
    /** Every face here is its rule's, which a script cannot add again;
     *  and one it makes is none of this document's yet (above). */
    add(face: Any): Any {
      if (face instanceof FontFace) {
        throw new DOMException(
          "Failed to execute 'add' on 'FontFaceSet': Cannot add a CSS-connected FontFace.",
          'InvalidModificationError',
        );
      }
      throw new TypeError(
        "Failed to execute 'add' on 'FontFaceSet': parameter 1 is not of type 'FontFace'.",
      );
    }
    /** A rule's face is not taken out by a script (2.5.1). */
    delete(_face: Any): boolean {
      return false;
    }
    clear(): void {}
  }

  // --- the document --------------------------------------------------------------

  class Document extends ParentNode {
    _ready = 'loading';
    _current: Any = null;
    /** An XML document's content type; null for an HTML one. */
    _type: string | null = null;
    /** What `document.write` has written since `open`, where a page
     *  opened a document of its own: parsed at `close`. */
    _written: string | null = null;
    /** Where the document is in its life as a navigation leaves it (HTML
     *  7.4.2.4, "unload a document"): its `pageshow` told and no
     *  `pagehide` since ("page showing"), its visibility, how many of the
     *  steps that unload it are running ("unload counter"), whether a
     *  check that it may be left went on, and whether it is gone. */
    _pageShowing = false;
    _hidden = false;
    _unloadCounter = 0;
    _leaveChecked = false;
    _unloaded = false;
    get documentElement(): Any {
      return wrap(Number(call('root', this._id)));
    }
    get head(): Any {
      return this.querySelector('head');
    }
    get body(): Any {
      // the `<html>`'s first `<body>` or `<frameset>` child, or none (HTML
      // 3.1.3, "the body element"): a script in the head, which runs before
      // the parser has got to the body, finds none
      if (this._ready === 'loading' && !this._type) {
        const root = this.documentElement;
        if (root?.localName === 'html') {
          for (let kid = root.firstElementChild; kid;) {
            if (kid.localName === 'body' || kid.localName === 'frameset') {
              return kid;
            }
            kid = kid.nextElementSibling;
          }
          return null;
        }
      }
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
    // the host's jar, where it has one, for this document's address: a
    // document that is not on the web, or one a page made of its own, is
    // cookie-averse (HTML 3.1.3) and reads ''
    get cookie(): string {
      if (!windowOfDocument(this)) return '';
      const v = call('cookie', 'get', str(this.URL));
      return typeof v === 'string' ? v : '';
    }
    set cookie(v: Any) {
      if (windowOfDocument(this)) call('cookie', 'set', str(this.URL), str(v));
    }
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
      return this._hidden ? 'hidden' : 'visible';
    }
    get hidden(): boolean {
      return this._hidden;
    }
    get timeline(): Any {
      return documentTimeline;
    }
    get fragmentDirective(): Any {
      let found = fragmentDirectives.get(this);
      if (!found) {
        found = new FragmentDirective(FRAGMENT_DIRECTIVE);
        fragmentDirectives.set(this, found);
      }
      return found;
    }
    getAnimations(): Any[] {
      return animationsOf(this, true);
    }
    startViewTransition(options?: Any): Any {
      return startViewTransition(options, this);
    }
    get activeViewTransition(): Any {
      return activeOf(this);
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
      return (this._fontSet ??= new FontFaceSet(this));
    }
    _fontSet: Any;
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
      const own = documentRegistryOf(this);
      const given = registryGiven(options, own, 'createElement');
      const registry = given === undefined ? own : given;
      const is = isOption(options);
      if (is !== null && registry && stateOf(registry).scoped) {
        throw new DOMException(
          "Failed to execute 'createElement' on 'Document': A scoped registry has no customized built-in elements.",
          'NotSupportedError',
        );
      }
      if (ns === '' && constructsWith(registry) && customElementsDefined) {
        const made = createCustom(name, is, registry, this);
        if (made) return made;
      }
      const el = wrap(Number(call('create', 'element', name, this._id, ns)));
      pinRegistry(el, registry);
      return el;
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
      const own = documentRegistryOf(this);
      const given = registryGiven(options, own, 'createElementNS');
      const registry = given === undefined ? own : given;
      if (
        ns === HTML_NS &&
        prefix === null &&
        constructsWith(registry) &&
        customElementsDefined
      ) {
        const made = createCustom(local, isOption(options), registry, this);
        if (made) return made;
      }
      const el = wrap(
        Number(call('create', 'element', qualified, this._id, ns ?? '~')),
      );
      pinRegistry(el, registry);
      return el;
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
      if (k === 'beforeunloadevent') return new BeforeUnloadEvent(UNLOADING);
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
    /** A copy of a node in this document (DOM 4.5): `deep`, or options
     *  with a registry for the copy's elements and `selfOnly`. */
    importNode(node: Any, options: Any = false): Any {
      const dict = options !== null && typeof options === 'object';
      const deep = dict ? !options.selfOnly : !!options;
      const own = documentRegistryOf(this);
      const given = dict
        ? registryGiven(options, own, 'importNode')
        : undefined;
      // ImportNodeOptions' registry is no nullable member (DOM 4.5)
      if (given === null) {
        throw new TypeError(
          "Failed to execute 'importNode' on 'Document': Failed to read the 'customElementRegistry' property from 'ImportNodeOptions': Failed to convert value to 'CustomElementRegistry'.",
        );
      }
      // a copy keeps its original's registry, and takes this one where
      // that is none (DOM 4.5, "clone a node")
      if (given === undefined && !registriesMatterNow()) {
        return wrap(Number(call('import', idOf(node), deep, this._id)));
      }
      return copyOf('import', node, deep, given ?? own, this);
    }
    /** The document's registry: its window's, and none for a document of
     *  no browsing context's. */
    get customElementRegistry(): Any {
      return documentRegistryOf(this);
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
      const start = this.startContainer;
      let context = start;
      while (context && !(context instanceof Element)) {
        context = context.parentNode;
      }
      const doc = start.nodeType === 9 ? start : start.ownerDocument;
      const fragment = doc.createDocumentFragment();
      const html_ = context?.namespaceURI === HTML_NS;
      // what is parsed in a template is parsed in no template's contents
      // and has no registry (HTML's scoped registries) until it is put
      // where one is looked up
      if (html_ && context.localName === 'template') {
        const holder = doc.createElement('template');
        holder.innerHTML = html;
        const content = holder.content;
        for (const top of content.children) registryUntilPut.add(top);
        while (content.firstChild) fragment.appendChild(content.firstChild);
        return fragment;
      }
      // the context's name decides how its content is parsed, and one
      // with no name of its own, a custom element's, parses as a div
      // does: made by that name, it would run its constructor
      const name =
        !context || (html_ && context.localName === 'html')
          ? 'body'
          : html_ && !context.localName.includes('-')
            ? context.localName
            : 'div';
      const holder =
        context && !html_
          ? doc.createElementNS(context.namespaceURI, context.localName)
          : doc.createElement(name);
      // and what is parsed takes the context's registry (HTML 13.4)
      const pinned = registriesMatterNow();
      if (pinned) {
        pinRegistry(
          holder,
          context ? registryOf(context) : documentRegistryOf(doc),
        );
      }
      holder.innerHTML = html;
      if (pinned) for (const el of holder.querySelectorAll('*')) registryOf(el);
      while (holder.firstChild) fragment.appendChild(holder.firstChild);
      return fragment;
    }
  }

  /** A range whose two boundary points never move (DOM 5.4). */
  class StaticRange extends AbstractRange {
    _static: [Any, number, Any, number];
    constructor(init: Any) {
      super();
      if (!init || typeof init !== 'object') {
        throw new TypeError(
          "Failed to construct 'StaticRange': 1 argument required, but only 0 present.",
        );
      }
      const { startContainer, startOffset, endContainer, endOffset } = init;
      for (const node of [startContainer, endContainer]) {
        if (!(node instanceof Node)) {
          throw new TypeError(
            "Failed to construct 'StaticRange': The provided value is not of type 'Node'.",
          );
        }
        if (node.nodeType === 10 || node.nodeType === 2) {
          throw new DOMException(
            "Failed to construct 'StaticRange': The supplied node is a DocumentType or an Attr.",
            'InvalidNodeTypeError',
          );
        }
      }
      this._static = [
        startContainer,
        Number(startOffset) >>> 0,
        endContainer,
        Number(endOffset) >>> 0,
      ];
    }
    override _points(): [Any, number, Any, number] {
      return this._static;
    }
    override get collapsed(): boolean {
      const [a, b, c, d] = this._static;
      return a === c && b === d;
    }
  }

  // --- custom highlights (CSS Highlight API 1) ----------------------------------------
  //
  // A `Highlight` is a set of ranges, and `CSS.highlights` the registry of
  // them by name, which `::highlight(name)` styles. The host is told what
  // the registry holds after each change — a live range by its id, which it
  // follows as the tree changes, a static one by its points — and draws the
  // ranges as it draws the selection (`highlights`). Both are kept in a
  // `Set` and a `Map` of their own, worked through the built-ins' methods as
  // they were before any page code ran: a page that changes
  // `Set.prototype` changes no highlight (WPT's tampered-prototype tests).

  const setAdd = Set.prototype.add;
  const setHas = Set.prototype.has;
  const setDelete = Set.prototype.delete;
  const setClear = Set.prototype.clear;
  const setValues = Set.prototype.values;
  const setEntries = Set.prototype.entries;
  const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
  const mapSet = Map.prototype.set;
  const mapGet = Map.prototype.get;
  const mapHas = Map.prototype.has;
  const mapDelete = Map.prototype.delete;
  const mapClear = Map.prototype.clear;
  const mapKeys = Map.prototype.keys;
  const mapValues = Map.prototype.values;
  const mapEntries = Map.prototype.entries;
  const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;

  const HIGHLIGHT_TYPES = ['highlight', 'spelling-error', 'grammar-error'];

  class Highlight {
    _ranges = new Set<Any>();
    _priority = 0;
    _type = 'highlight';
    constructor(...ranges: Any[]) {
      for (const range of ranges) this.add(range);
    }
    get priority(): number {
      return this._priority;
    }
    set priority(v: Any) {
      // a `long`
      this._priority = Number(v) | 0;
      highlightsChanged();
    }
    get type(): string {
      return this._type;
    }
    set type(v: Any) {
      // an enumeration's: a value it does not have is ignored
      const type = str(v);
      if (HIGHLIGHT_TYPES.includes(type)) this._type = type;
    }
    add(range: Any): Any {
      if (!(range instanceof AbstractRange)) {
        throw new TypeError(
          "Failed to execute 'add' on 'Highlight': parameter 1 is not of type 'AbstractRange'.",
        );
      }
      if (!setHas.call(this._ranges, range)) {
        setAdd.call(this._ranges, range);
        highlightsChanged();
      }
      return this;
    }
    delete(range: Any): boolean {
      const had = setDelete.call(this._ranges, range);
      if (had) highlightsChanged();
      return had;
    }
    has(range: Any): boolean {
      return setHas.call(this._ranges, range);
    }
    clear(): void {
      if (!setSize.call(this._ranges)) return;
      setClear.call(this._ranges);
      highlightsChanged();
    }
    get size(): number {
      return setSize.call(this._ranges);
    }
    forEach(fn: Any, thisArg: Any = undefined): void {
      if (typeof fn !== 'function') {
        throw new TypeError(
          "Failed to execute 'forEach' on 'Highlight': The callback provided as parameter 1 is not a function.",
        );
      }
      for (const range of setValues.call(this._ranges)) {
        fn.call(thisArg, range, range, this);
      }
    }
    values(): Any {
      return setValues.call(this._ranges);
    }
    keys(): Any {
      return setValues.call(this._ranges);
    }
    entries(): Any {
      return setEntries.call(this._ranges);
    }
    get [Symbol.toStringTag](): string {
      return 'Highlight';
    }
  }

  /** Each document's registry, by the document its window is of now: the
   *  page's is `CSS.highlights`, and a frame's window has one of its own
   *  (`frameWindowOf`), whose highlights are drawn in the frame. */
  const highlightRegistries = new Set<Any>();
  /** Made once, as `CSS.highlights`: a page constructs none. A frame's is
   *  made past the constructor (`registryFor`). */
  let registryMade = false;
  class HighlightRegistry {
    _map = new Map<string, Any>();
    /** The document its window is of now. */
    _doc: () => Any = () => document;
    /** What the host was last told of it (`sendHighlights`). */
    _sent = '';
    constructor() {
      if (registryMade) throw new TypeError('Illegal constructor');
      registryMade = true;
      setAdd.call(highlightRegistries, this);
    }
    set(name: Any, highlight: Any): Any {
      if (!(highlight instanceof Highlight)) {
        throw new TypeError(
          "Failed to execute 'set' on 'HighlightRegistry': parameter 2 is not of type 'Highlight'.",
        );
      }
      mapSet.call(this._map, str(name), highlight);
      highlightsChanged();
      return this;
    }
    get(name: Any): Any {
      return mapGet.call(this._map, str(name));
    }
    has(name: Any): boolean {
      return mapHas.call(this._map, str(name));
    }
    delete(name: Any): boolean {
      const had = mapDelete.call(this._map, str(name));
      if (had) highlightsChanged();
      return had;
    }
    clear(): void {
      if (!mapSize.call(this._map)) return;
      mapClear.call(this._map);
      highlightsChanged();
    }
    get size(): number {
      return mapSize.call(this._map);
    }
    forEach(fn: Any, thisArg: Any = undefined): void {
      if (typeof fn !== 'function') {
        throw new TypeError(
          "Failed to execute 'forEach' on 'HighlightRegistry': The callback provided as parameter 1 is not a function.",
        );
      }
      for (const [name, highlight] of mapEntries.call(this._map)) {
        fn.call(thisArg, highlight, name, this);
      }
    }
    keys(): Any {
      return mapKeys.call(this._map);
    }
    values(): Any {
      return mapValues.call(this._map);
    }
    entries(): Any {
      return mapEntries.call(this._map);
    }
    /**
     * The highlights over a point of the viewport, the highest priority
     * first and the one registered last first among equals, each with
     * those of its ranges whose client rects hold the point (CSS Highlight
     * API 1, 6): none outside the viewport, and none where what is hit
     * there is in a shadow tree whose root `options.shadowRoots` leaves
     * out, as `elementFromPoint` keeps a closed tree's nodes to itself.
     */
    highlightsFromPoint(x: Any, y: Any, options: Any = undefined): Any[] {
      if (arguments.length < 2) {
        throw new TypeError(
          `Failed to execute 'highlightsFromPoint' on 'HighlightRegistry': 2 arguments required, but only ${arguments.length} present.`,
        );
      }
      const at = (v: Any): number => {
        // a `float`: a number, and a finite one
        const n = Number(v);
        if (!Number.isFinite(n)) {
          throw new TypeError(
            "Failed to execute 'highlightsFromPoint' on 'HighlightRegistry': The provided float value is non-finite.",
          );
        }
        return Math.fround(n);
      };
      const px = at(x);
      const py = at(y);
      const roots = shadowRootsOption(options);
      const map = this._map;
      if (!mapSize.call(map) || px < 0 || py < 0) return [];
      const doc = this._doc();
      if (doc === document) {
        const root = document.documentElement;
        if (!root || px > root.clientWidth || py > root.clientHeight) {
          return [];
        }
        const top = document.elementFromPoint(px, py);
        const tree = top?.getRootNode();
        if (tree instanceof ShadowRoot && !roots.includes(tree)) return [];
      } else {
        // a frame's document, which a frame with no box shows nowhere
        const frame = wrap(Number(call('frameElement', doc._id)));
        if (!frame || !frame.getClientRects().length) return [];
        const [width, height] = String(call('frameSize', doc._id))
          .split(' ')
          .map(Number);
        if (px > width || py > height) return [];
      }
      const found: { highlight: Any; ranges: Any[]; order: number }[] = [];
      let order = 0;
      for (const [, highlight] of mapEntries.call(map)) {
        order += 1;
        const ranges: Any[] = [];
        for (const range of setValues.call(highlight._ranges)) {
          if (range instanceof StaticRange) {
            const [sc, so, ec, eo] = range._points();
            if (!staticValid(sc, so, ec, eo)) continue;
          }
          if (range.collapsed) continue;
          let rects: Any[];
          try {
            rects = Array.from(liveRangeOf(range).getClientRects());
          } catch {
            continue;
          }
          if (
            rects.some(
              (r: Any) =>
                px >= r.left && px < r.right && py >= r.top && py < r.bottom,
            )
          ) {
            ranges.push(range);
          }
        }
        if (ranges.length) found.push({ highlight, ranges, order });
      }
      return found
        .sort(
          (a, b) =>
            b.highlight._priority - a.highlight._priority || b.order - a.order,
        )
        .map(({ highlight, ranges }) => ({ highlight, ranges }));
    }
    get [Symbol.toStringTag](): string {
      return 'HighlightRegistry';
    }
  }
  /** `HighlightsFromPointOptions.shadowRoots`, as Web IDL converts it: a
   *  dictionary, or none, whose member is a sequence of shadow roots. */
  const shadowRootsOption = (options: Any): Any[] => {
    if (options === undefined || options === null) return [];
    if (typeof options !== 'object' && typeof options !== 'function') {
      throw new TypeError(
        "Failed to execute 'highlightsFromPoint' on 'HighlightRegistry': The provided value is not of type 'HighlightsFromPointOptions'.",
      );
    }
    const given = options.shadowRoots;
    if (given === undefined) return [];
    if (
      given === null ||
      (typeof given !== 'object' && typeof given !== 'function') ||
      typeof given[Symbol.iterator] !== 'function'
    ) {
      throw new TypeError(
        "Failed to execute 'highlightsFromPoint' on 'HighlightRegistry': Failed to read the 'shadowRoots' property from 'HighlightsFromPointOptions': The provided value cannot be converted to a sequence.",
      );
    }
    const roots = Array.from(given as Iterable<Any>);
    for (const root of roots) {
      if (!(root instanceof ShadowRoot)) {
        throw new TypeError(
          "Failed to execute 'highlightsFromPoint' on 'HighlightRegistry': Failed to read the 'shadowRoots' property from 'HighlightsFromPointOptions': Failed to convert value to 'ShadowRoot'.",
        );
      }
    }
    return roots;
  };
  /** A frame document's registry, made past the constructor, which is the
   *  page's alone. */
  const registryFor = (doc: () => Any): Any => {
    const registry = Object.create(HighlightRegistry.prototype);
    registry._map = new Map();
    registry._doc = doc;
    registry._sent = '';
    setAdd.call(highlightRegistries, registry);
    return registry;
  };
  // Both are setlike and maplike as Web IDL makes them (3.7.11, 3.7.12):
  // each operation enumerable, `@@iterator` the same function as `values`
  // or `entries`, and their attributes' getters for instances alone
  for (const [Interface, iterator, names] of [
    [
      Highlight,
      'values',
      ['add', 'delete', 'has', 'clear', 'forEach', 'values', 'keys', 'entries'],
    ],
    [
      HighlightRegistry,
      'entries',
      [
        'set',
        'get',
        'has',
        'delete',
        'clear',
        'forEach',
        'keys',
        'values',
        'entries',
        'highlightsFromPoint',
      ],
    ],
  ] as [Any, string, string[]][]) {
    const proto = Interface.prototype;
    for (const name of names) {
      Object.defineProperty(proto, name, { enumerable: true });
    }
    Object.defineProperty(proto, Symbol.iterator, {
      value: proto[iterator],
      writable: true,
      enumerable: false,
      configurable: true,
    });
    idlAttributes(Interface);
  }
  /** A live range over a static one's points, or the range itself. */
  const liveRangeOf = (range: Any): Any => {
    if (!(range instanceof StaticRange)) return range;
    const [sc, so, ec, eo] = range._points();
    const live = document.createRange();
    live.setStart(sc, so);
    live.setEnd(ec, eo);
    return live;
  };
  /** Whether a static range's points make a range (DOM 5.4, "valid"). */
  const staticValid = (sc: Any, so: number, ec: Any, eo: number): boolean => {
    const length = (node: Any): number =>
      node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8
        ? node.data.length
        : node.childNodes.length;
    if (so > length(sc) || eo > length(ec)) return false;
    if (sc.getRootNode() !== ec.getRootNode()) return false;
    try {
      return comparePoints(sc, so, ec, eo) <= 0;
    } catch {
      return false;
    }
  };
  // --- view transitions -------------------------------------------------
  //
  // `document.startViewTransition()` as CSS View Transitions 1, 7 runs it:
  // the old state is captured at the next frame and the update callback
  // called, and once what it returns settles the new state is captured,
  // the transition is ready and `<Html>` draws its tree of pseudo-elements;
  // once their animations are over it is finished. What it asks of the
  // page — the order of the callback and the promises, one transition
  // skipping another, a name two elements share skipping it, a callback
  // that never settles timing out — is the specification's, so a page
  // that waits on one goes on.

  /** A transition's types (CSS View Transitions 2, 3.4.2): a set of
   *  strings, worked through the built-ins as a highlight's ranges are. */
  class ViewTransitionTypeSet {
    _set = new Set<string>();
    /** The transition whose types these are, which `:active-view-transition-
     *  type()` matches by while it is active. */
    _owner: Any = null;
    add(v: Any): Any {
      setAdd.call(this._set, str(v));
      typesChanged(this);
      return this;
    }
    delete(v: Any): boolean {
      const had = setDelete.call(this._set, str(v));
      typesChanged(this);
      return had;
    }
    has(v: Any): boolean {
      return setHas.call(this._set, str(v));
    }
    clear(): void {
      setClear.call(this._set);
      typesChanged(this);
    }
    get size(): number {
      return setSize.call(this._set);
    }
    forEach(fn: Any, thisArg?: Any): void {
      for (const v of setValues.call(this._set)) fn.call(thisArg, v, v, this);
    }
    values(): Any {
      return setValues.call(this._set);
    }
    keys(): Any {
      return setValues.call(this._set);
    }
    entries(): Any {
      return setEntries.call(this._set);
    }
    [Symbol.iterator](): Any {
      return setValues.call(this._set);
    }
    get [Symbol.toStringTag](): string {
      return 'ViewTransitionTypeSet';
    }
  }

  /** The document's active view transition told to the host, with its
   *  types — or none — for `:active-view-transition` to match the root by
   *  (CSS View Transitions 1, 3.3). */
  const tellActive = (doc: Any, vt: Any): void => {
    call(
      'vtActive',
      doc._id,
      vt ? [...setValues.call(vt._types._set)].map(str).join('\u0000') : null,
    );
  };
  /** A transition's types changed: told where it is the active one. */
  const typesChanged = (set: Any): void => {
    const vt = set._owner;
    if (vt && activeOf(vt._doc) === vt) tellActive(vt._doc, vt);
  };
  /** The active transition of a document of the realm's: the page's, or
   *  a frame's the page reaches into, which the frame's view draws. */
  const frameTransitions = new WeakMap<object, Any>();
  const activeOf = (doc: Any): Any =>
    doc === document ? activeTransition : (frameTransitions.get(doc) ?? null);
  /** A transition no longer its document's active one, where it was. */
  const leaveActive = (vt: Any): void => {
    if (activeOf(vt._doc) !== vt) return;
    if (vt._doc === document) activeTransition = null;
    else frameTransitions.delete(vt._doc);
    tellActive(vt._doc, null);
    call('vtEnd', vt._doc._id);
  };
  /** A transition's step, asked of the view that draws its document. */
  const transitionOp = (vt: Any, op: string): Any => call(op, vt._doc._id);

  /** How long an update callback may take before the transition is
   *  skipped (7.4, "implementation-defined"): Chrome's four seconds. */
  const TRANSITION_TIMEOUT = 4000;
  let activeTransition: Any = null;

  class ViewTransition {
    _phase: 'pending' | 'update-callback-called' | 'animating' | 'done' =
      'pending';
    /** The document it is of. */
    _doc: Any = null;
    _callback: Any;
    _types = new ViewTransitionTypeSet();
    _done: Any;
    _ready: Any;
    _finished: Any;
    _resolveDone!: (v?: Any) => void;
    _rejectDone!: (e: Any) => void;
    _resolveReady!: (v?: Any) => void;
    _rejectReady!: (e: Any) => void;
    _resolveFinished!: (v?: Any) => void;
    _rejectFinished!: (e: Any) => void;
    constructor(callback: Any, key: Any) {
      if (key !== TRANSITION_KEY) throw new TypeError('Illegal constructor');
      this._callback = callback;
      this._types._owner = this;
      this._done = new Promise((ok, fail) => {
        this._resolveDone = ok;
        this._rejectDone = fail;
      });
      this._ready = new Promise((ok, fail) => {
        this._resolveReady = ok;
        this._rejectReady = fail;
      });
      this._finished = new Promise((ok, fail) => {
        this._resolveFinished = ok;
        this._rejectFinished = fail;
      });
      // `ready` rejected and unread is no unhandled rejection (7.1)
      this._ready.catch(() => {});
    }
    get updateCallbackDone(): Any {
      return this._done;
    }
    get ready(): Any {
      return this._ready;
    }
    get finished(): Any {
      return this._finished;
    }
    get types(): Any {
      return this._types;
    }
    set types(v: Any) {
      const set = new ViewTransitionTypeSet();
      for (const t of v ?? []) set.add(t);
      set._owner = this;
      this._types = set;
      typesChanged(set);
    }
    skipTransition(): void {
      if (this._phase !== 'done') {
        skipTransition(
          this,
          new DOMException('Transition was skipped', 'AbortError'),
        );
      }
    }
    get [Symbol.toStringTag](): string {
      return 'ViewTransition';
    }
  }
  const TRANSITION_KEY = {};

  /** Call a transition's update callback, once (7.5): what it returns
   *  settles `updateCallbackDone`, and a fulfilment activates the
   *  transition where nothing skipped it since. */
  const callUpdate = (vt: Any): void => {
    if (vt._called) return;
    vt._called = true;
    if (vt._phase !== 'done') vt._phase = 'update-callback-called';
    let promise: Any;
    try {
      promise = Promise.resolve(vt._callback ? vt._callback() : undefined);
    } catch (error) {
      promise = Promise.reject(error);
    }
    const timer = setTimer(
      () =>
        skipTransition(
          vt,
          new DOMException(
            'Transition update callback timed out',
            'TimeoutError',
          ),
        ),
      TRANSITION_TIMEOUT,
      [],
      false,
    );
    promise.then(
      () => {
        clearTimer(timer);
        vt._resolveDone();
        activateTransition(vt);
      },
      (error: Any) => {
        clearTimer(timer);
        vt._rejectDone(error);
        skipTransition(vt, error);
      },
    );
  };

  /** The new state captured (7.4, "activate"): skipped where two elements
   *  share a name, and otherwise ready, and over once the animations of
   *  its pseudo-elements are (7.9). */
  const activateTransition = (vt: Any): void => {
    if (vt._phase === 'done') return;
    const shared = str(transitionOp(vt, 'vtNew'));
    if (shared) {
      skipTransition(
        vt,
        new DOMException(
          `Unexpected duplicate view-transition-name: ${shared}`,
          'InvalidStateError',
        ),
      );
      return;
    }
    vt._phase = 'animating';
    vt._resolveReady();
    // asked at the end of a frame, after its callbacks, again when they
    // would be over and at least every quarter of a second: a page may
    // change their rules, animate its pseudo-elements itself, or take an
    // element out of the rendering, which skips the transition (7.8, 7.9)
    const settle = (): void => {
      if (vt._phase !== 'animating') return;
      let left = Number(transitionOp(vt, 'vtRemaining'));
      // and the page's own animations of them, running or paused
      if (left === 0 && scriptedTransition(vt._doc)) left = -1;
      if (left === -2) {
        skipTransition(
          vt,
          new DOMException(
            'An element of the transition is no longer rendered',
            'InvalidStateError',
          ),
        );
        return;
      }
      if (left === 0) {
        vt._phase = 'done';
        leaveActive(vt);
        vt._resolveFinished();
        return;
      }
      setTimer(
        () => afterNextFrame(settle),
        left < 0 ? 250 : Math.min(250, Math.max(0, left - 16)),
        [],
        false,
      );
    };
    afterNextFrame(settle);
  };

  /** Whether a page's script animates one of the active transition's
   *  pseudo-elements, running or paused: what keeps it going (7.9). */
  const scriptedTransition = (doc: Any): boolean => {
    for (const a of [...liveAnimations, ...heldCssAnimations]) {
      const effect = a.effect;
      if (
        effect?.target === doc.documentElement &&
        typeof effect.pseudoElement === 'string' &&
        transitionPseudoKey(effect.pseudoElement) !== null &&
        (a.playState === 'running' || a.playState === 'paused')
      ) {
        return true;
      }
    }
    return false;
  };

  /** Skip a transition (7.6): it is no longer the active one, its update
   *  is still called, `ready` is rejected, and `finished` settles as the
   *  update does. */
  const skipTransition = (vt: Any, reason: Any): void => {
    if (vt._phase === 'done') return;
    leaveActive(vt);
    const called = vt._called;
    vt._phase = 'done';
    if (!called) setTimer(() => callUpdate(vt), 0, [], false);
    vt._rejectReady(reason);
    vt._done.then(
      () => vt._resolveFinished(),
      (error: Any) => vt._rejectFinished(error),
    );
  };

  /** `document.startViewTransition()` (7.2), of the document asked. */
  const startViewTransition = (options: Any, doc: Any = document): Any => {
    const callback =
      typeof options === 'function'
        ? options
        : options && typeof options === 'object'
          ? (options.update ?? null)
          : null;
    const vt = new ViewTransition(callback, TRANSITION_KEY);
    vt._doc = doc;
    if (options && typeof options === 'object' && options.types) {
      for (const t of options.types) vt._types.add(t);
    }
    if (document.visibilityState === 'hidden') {
      skipTransition(
        vt,
        new DOMException('The document is hidden', 'InvalidStateError'),
      );
      return vt;
    }
    const active = activeOf(doc);
    if (active) {
      skipTransition(
        active,
        new DOMException('Skipped by a new transition', 'AbortError'),
      );
    }
    if (doc === document) activeTransition = vt;
    else frameTransitions.set(doc, vt);
    tellActive(doc, vt);
    // the old state is captured at the next frame, and the update called
    // straight after (7.4, "capture the old state")
    setTimer(
      () => {
        if (vt._phase === 'done') return;
        const shared = str(transitionOp(vt, 'vtOld'));
        if (shared) {
          skipTransition(
            vt,
            new DOMException(
              `Unexpected duplicate view-transition-name: ${shared}`,
              'InvalidStateError',
            ),
          );
          return;
        }
        callUpdate(vt);
      },
      16,
      [],
      false,
    );
    return vt;
  };

  const highlightRegistry = new HighlightRegistry();
  /** Whether a change to a highlight or a registry is yet to be told
   *  (`sendHighlights`). */
  let highlightsQueued = false;
  /** A highlight or a registry changed: the host is told once the task's
   *  script is done, so a page that adds a search's thousand matches one
   *  at a time sends the registry once, and not once a range. */
  const highlightsChanged = (): void => {
    if (highlightsQueued) return;
    highlightsQueued = true;
    queueMicrotask(sendHighlights);
  };
  /** What each registry holds now, to the host: the page's, and each
   *  frame document's by its id, for the `<Html>` that draws it. */
  const sendHighlights = (): void => {
    highlightsQueued = false;
    for (const registry of setValues.call(highlightRegistries)) {
      const out: Any[] = [];
      for (const [name, highlight] of mapEntries.call(registry._map)) {
        const ranges: Any[] = [];
        for (const range of setValues.call(highlight._ranges)) {
          if (range instanceof StaticRange) {
            const [sc, so, ec, eo] = range._points();
            // only a valid one is lit (DOM 5.4): its points in one tree,
            // inside their nodes, and the start not after the end
            if (!staticValid(sc, so, ec, eo)) continue;
            ranges.push([idOf(sc), so, idOf(ec), eo]);
          } else if (range._id) ranges.push(range._id);
        }
        out.push({ name, priority: highlight._priority, ranges });
      }
      const json = JSON.stringify(out);
      const doc = registry._doc();
      const id = doc === document ? 0 : idOf(doc);
      // told again only where it holds something else, or is another
      // document's: a live range is told by its id, and the host follows it
      const sent = `${id}:${json}`;
      if (sent === registry._sent) continue;
      registry._sent = sent;
      if (id) call('highlights', json, id);
      else call('highlights', json);
    }
  };
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
  /** `new Document()` (DOM 4.5): an XML document no browsing context has,
   *  of type `application/xml`. It, `Text`, `Comment` and
   *  `DocumentFragment` are a page's to make; every other node interface
   *  is an illegal constructor. */
  const DocumentConstructor = function Document(this: Any): Any {
    if (!new.target) {
      throw new TypeError(
        "Failed to construct 'Document': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      );
    }
    return wrap(Number(call('newXml', 'application/xml')));
  } as unknown as Any;
  DocumentConstructor.prototype = Document.prototype;
  Object.setPrototypeOf(DocumentConstructor, Object.getPrototypeOf(Document));
  Object.defineProperty(Document.prototype, 'constructor', {
    value: DocumentConstructor,
    writable: true,
    configurable: true,
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
    'select',
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
    'scrollend',
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
    'fullscreenchange',
    'fullscreenerror',
    'transitionrun',
    'transitionstart',
    'transitionend',
    'transitioncancel',
    'animationstart',
    'animationiteration',
    'animationend',
    'animationcancel',
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
  Object.defineProperty(Document.prototype, 'onvisibilitychange', {
    get(this: Any): Any {
      return this._handlers.visibilitychange ?? null;
    },
    set(this: Any, fn: Any) {
      this._handlers.visibilitychange = typeof fn === 'function' ? fn : null;
    },
    configurable: true,
  });

  // --- fullscreen -------------------------------------------------------------------
  //
  // Fullscreen 2, inside the window: the element is shown over all of the
  // viewport, in its document's top layer (`fullscreen`, `:fullscreen`
  // and the UA sheet's rules), and the window itself stays as it is —
  // nothing here asks the host to make it fill the screen.

  /** The document's fullscreen elements, the last the fullscreen one. */
  const fullscreenStack: Any[] = [];
  const fullscreenNow = (): Any => {
    for (let i = fullscreenStack.length - 1; i >= 0; i -= 1) {
      if (call('fullscreen', fullscreenStack[i]._id) === true) {
        return fullscreenStack[i];
      }
      fullscreenStack.splice(i, 1);
    }
    return null;
  };
  /** `fullscreenchange` or `fullscreenerror`, in a task of its own, at the
   *  element where it is still in the document, and at the document where
   *  it is not (Fullscreen 2, "run the fullscreen steps"). */
  const fullscreenEvent = (el: Any, type: string, then: () => void): void => {
    setTimer(
      () => {
        const ev = new Event(type, { bubbles: true, composed: true });
        ev.isTrusted = true;
        dispatch(el.isConnected ? el : document, ev);
        then();
      },
      0,
      [],
      false,
    );
  };
  Object.defineProperty(Element.prototype, 'requestFullscreen', {
    /** Fullscreen 2, `requestFullscreen()`: refused for an element out of
     *  the document, a showing popover or a modal dialog; else the
     *  popovers it is not in hidden, as a modal dialog hides them, and it
     *  the fullscreen element. */
    value(this: Any): Promise<void> {
      const el = this;
      return new Promise<void>((resolve, reject) => {
        const refused =
          !el.isConnected ||
          popoverShowing(el) ||
          (el instanceof HTMLDialogElement && isModalDialog(el));
        if (refused) {
          fullscreenEvent(el, 'fullscreenerror', () =>
            reject(new TypeError('Fullscreen request denied.')),
          );
          return;
        }
        hidePopoversUntil(topmostPopoverAncestor(el, null), false, true);
        call('fullscreen', el._id, true);
        const at = fullscreenStack.indexOf(el);
        if (at >= 0) fullscreenStack.splice(at, 1);
        fullscreenStack.push(el);
        fullscreenEvent(el, 'fullscreenchange', () => resolve(undefined));
      });
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperties(Document.prototype, {
    fullscreenElement: {
      get: () => fullscreenNow(),
      configurable: true,
      enumerable: true,
    },
    fullscreenEnabled: {
      get: () => true,
      configurable: true,
      enumerable: true,
    },
    fullscreen: {
      get: () => !!fullscreenNow(),
      configurable: true,
      enumerable: true,
    },
    exitFullscreen: {
      /** Fullscreen 2, `exitFullscreen()`: the fullscreen element out, the
       *  one before it fullscreen again where there is one. */
      value(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          const el = fullscreenNow();
          if (!el) {
            reject(new TypeError('Document not active'));
            return;
          }
          fullscreenStack.pop();
          call('fullscreen', el._id, false);
          fullscreenEvent(el, 'fullscreenchange', () => resolve(undefined));
        });
      },
      writable: true,
      configurable: true,
    },
  });

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
  /** The viewport's size and where it is scrolled — `scrolled` where it
   *  is the offsets a page reads, which a layout of what it changed can
   *  move, and so are read after one (CSSOM View 6.1). */
  const viewport = (
    scrolled = false,
  ): {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    dpr: number;
  } => {
    const [width, height, scrollX, scrollY, dpr] = String(
      call('viewport', scrolled),
    )
      .split(',')
      .map(Number);
    return { width, height, scrollX, scrollY, dpr };
  };

  const now = (): number => Number(bridge('now'));

  // --- viewports, as the rendering steps see them -------------------------
  //
  // Each document this realm runs has a viewport of its own (HTML 8.1.7.3,
  // "update the rendering"): the page's is the pane it is shown in, and a
  // frame's document that runs here — one with no realm of its own — has
  // its frame's content box, which the page lays out. A frame's window
  // answers `innerWidth`, `matchMedia` and `visualViewport` for it, hears
  // its own `resize`, and has animation frame callbacks of its own, which
  // run after the page's in tree order: what it shared of the page's
  // before was the page's size and the page's order.

  /** A document's viewport, as the rendering steps see it. */
  interface Viewport {
    /** The document it is the viewport of, now. */
    doc(): Any;
    /** The frame whose document's it is; null for the page's. */
    frame: Any;
    /** Its window's own target, which its `resize` is fired at. */
    target: Any;
    /** Its window's `visualViewport`, made as it is first asked for
     *  (`visualOf`). */
    visual: Any;
    /** Its width and height as the resize steps last saw them, null
     *  before they first did. */
    size: number[] | null;
    /** What its media queries were last answered from (`rendering`). */
    media: string;
    /** Its media query lists a listener hears, oldest first. */
    lists: Any[];
    /** Its animation frame callbacks, by id, and the last id given. */
    callbacks: Map<number, Any>;
    seq: number;
  }
  /** Its width and height now. */
  const sizeOf = (v: Viewport): number[] => {
    if (!v.frame) {
      const { width, height } = viewport();
      return [width, height];
    }
    return String(call('frameSize', v.doc()._id)).split(' ').map(Number);
  };
  /** Whether a media query holds in it now. */
  const holdsIn = (v: Viewport, query: string): boolean =>
    v.frame
      ? call('frameMedia', v.doc()._id, query) === true
      : !!call('media', query);
  const viewportFor = (frame: Any, doc: () => Any, target: Any): Viewport => {
    const v: Viewport = {
      doc,
      frame,
      target,
      visual: null,
      size: null,
      media: '',
      lists: [],
      callbacks: frame ? new Map() : frameCallbacks,
      seq: 0,
    };
    return v;
  };
  /** A viewport's `visualViewport`, one for it. */
  const visualOf = (v: Viewport): Any => {
    if (!v.visual) {
      v.visual = new VisualViewport();
      v.visual._of = v;
    }
    return v.visual;
  };
  const ownViewport = viewportFor(null, () => document, windowTarget);
  /** The frames' viewports something here watches: a `resize` listener on
   *  its window or its `visualViewport`, a media query list's listener, an
   *  animation frame callback. One nothing watches any more is let go at
   *  the next frame (`watched`), so a frame a page once asked a frame of
   *  is not measured at every frame after. */
  const watchedFrames = new Set<Viewport>();
  const watchViewport = (v: Viewport): void => {
    if (!v.frame) {
      if (v.size === null) v.size = sizeOf(v);
      return;
    }
    if (watchedFrames.has(v)) return;
    // what the next resize steps compare with: the size it has now, what
    // came before being no listener's
    v.size = sizeOf(v);
    v.media = '';
    watchedFrames.add(v);
    // the host is told of it at the next frame's steps (`rendering`)
    renderingOwed = true;
    wantFrame();
  };
  /** Whether something hears a type of event at a target. */
  const heard = (target: Any, type: string): boolean =>
    !!(target?._listeners[type]?.length || target?._handlers[type]);
  /** Whether something still watches a frame's viewport. */
  const watched = (v: Viewport): boolean =>
    v.callbacks.size > 0 ||
    v.lists.length > 0 ||
    heard(v.target, 'resize') ||
    heard(v.visual, 'resize');
  /** Whether a frame's viewport is still its frame's: the frame in a
   *  document, and still showing the document this realm runs. */
  const liveFrame = (v: Viewport): boolean =>
    v.frame.isConnected &&
    !linkedFrames.has(v.frame._id) &&
    !crossLinked.has(v.frame._id) &&
    frameDocumentOf(v.frame) === v.doc();
  /** A frame element and the frames around it, the outermost first. */
  const framesAround = (frame: Any): Any[] => {
    const chain = [frame];
    for (let at = frame; ;) {
      const doc = at.ownerDocument;
      if (!doc || doc === document) break;
      const outer = wrap(Number(call('frameElement', doc._id)));
      if (!outer || chain.includes(outer)) break;
      chain.push(outer);
      at = outer;
    }
    return chain.reverse();
  };
  /** Two frames' viewports in tree order (HTML's "docs" list). */
  const treeOrder = (a: Viewport, b: Viewport): number => {
    const x = framesAround(a.frame);
    const y = framesAround(b.frame);
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      if (x[i] === y[i]) continue;
      return x[i].compareDocumentPosition(y[i]) & 4 ? -1 : 1;
    }
    return x.length - y.length;
  };
  /** Whether a frame's animation frame callback waits for a frame. */
  const framesWaiting = (): boolean => {
    for (const v of watchedFrames) if (v.callbacks.size) return true;
    return false;
  };
  /** The scroll the pane made that the next frame's scroll steps tell, as
   *  a frame was coming when it was told (`__scrolled`). */
  let scrollOwed = false;
  const tellScroll = (): boolean => {
    scrollOwed = false;
    const ev = new Event('scroll', { bubbles: true });
    ev.isTrusted = true;
    return dispatch(document, ev);
  };
  /** A trusted event of a type and nothing else at a target. */
  const fireTrusted = (target: Any, type: string): void => {
    const ev = new Event(type);
    ev.isTrusted = true;
    dispatch(target, ev);
  };
  /**
   * HTML's resize steps, scroll steps and "evaluate media queries and
   * report changes", for each document this realm runs, in tree order: a
   * `resize` at a window whose viewport is another size than these steps
   * last saw, and at its `visualViewport`; the document's `scroll` the pane
   * owes; and a `change` at each media query list a listener hears whose
   * answer moved, oldest first. What they are measured from is the host's,
   * read once a frame (`rendering`). Answers the viewports, for the
   * frame's animation frame callbacks.
   */
  const renderingSteps = (): Viewport[] => {
    const shown = [ownViewport];
    if (watchedFrames.size) {
      const frames: Viewport[] = [];
      for (const v of watchedFrames) {
        if (liveFrame(v) && watched(v)) frames.push(v);
        else watchedFrames.delete(v);
      }
      shown.push(...frames.sort(treeOrder));
    }
    const lines = String(
      call('rendering', shown.map((v) => v.doc()._id).join(' ')),
    ).split('\n');
    shown.forEach((v, i) => {
      const [width, height] = (lines[i] ?? '').split(' ', 2).map(Number);
      const was = v.size;
      v.size = [width, height];
      if (was && (was[0] !== width || was[1] !== height)) {
        fireTrusted(v.target, 'resize');
        if (v.visual) fireTrusted(v.visual, 'resize');
      }
    });
    if (scrollOwed) tellScroll();
    shown.forEach((v, i) => {
      const line = lines[i] ?? '';
      if (line === v.media) return;
      v.media = line;
      for (const list of v.lists.slice()) {
        const matches = holdsIn(v, list._media);
        if (matches === list._matched) continue;
        list._matched = matches;
        const ev = new MediaQueryListEvent('change', {
          media: list._media,
          matches,
        });
        ev.isTrusted = true;
        dispatch(list, ev);
      }
    });
    return shown;
  };

  /** Made by `matchMedia` and by nothing else. */
  let makingList = false;
  /**
   * A media query list (CSSOM View 4.2): its query, answered as `matches`
   * is read, in the viewport of the document whose window made it, and a
   * `change` the rendering steps fire at it where the answer moved. One a
   * listener hears is kept by its viewport, as HTML keeps it.
   */
  class MediaQueryList extends EventTarget {
    _media = '';
    _of: Viewport = ownViewport;
    /** What it answered as its listeners last heard, or as the first was
     *  added. */
    _matched = false;
    constructor() {
      super();
      if (!makingList) throw new TypeError('Illegal constructor');
    }
    get media(): string {
      return this._media;
    }
    get matches(): boolean {
      return holdsIn(this._of, this._media);
    }
    get onchange(): Any {
      return this._handlers.change ?? null;
    }
    set onchange(fn: Any) {
      this._handlers.change = typeof fn === 'function' ? fn : null;
      this._heard();
    }
    override addEventListener(type: string, fn: Any, options?: Any): void {
      super.addEventListener(type, fn, options);
      if (String(type) === 'change') this._heard();
    }
    override removeEventListener(type: string, fn: Any, options?: Any): void {
      super.removeEventListener(type, fn, options);
      if (String(type) === 'change') this._heard();
    }
    /** The legacy aliases (CSSOM View 4.2). */
    addListener(fn: Any): void {
      if (fn) this.addEventListener('change', fn);
    }
    removeListener(fn: Any): void {
      if (fn) this.removeEventListener('change', fn);
    }
    /** Kept by its viewport, with what it answers, while a listener hears
     *  it, and let go once none does: a page that listens to a list for
     *  as long as a component is mounted makes one at every mount. */
    _heard(): void {
      const v = this._of;
      const at = v.lists.indexOf(this);
      if (!heard(this, 'change')) {
        if (at >= 0) v.lists.splice(at, 1);
        return;
      }
      if (at >= 0) return;
      this._matched = this.matches;
      v.lists.push(this);
      watchViewport(v);
    }
  }
  idlAttributes(MediaQueryList);
  /** `matchMedia` of a document's window: a new list each time. */
  const mediaListIn = (v: Viewport, query: Any): Any => {
    makingList = true;
    try {
      const list = new MediaQueryList();
      list._media = str(query);
      list._of = v;
      return list;
    } finally {
      makingList = false;
    }
  };

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
      navigateDocument(String(call('resolve', str(v))), false);
    },
    assign(url: Any): void {
      navigateDocument(String(call('resolve', str(url))), false);
    },
    replace(url: Any): void {
      navigateDocument(String(call('resolve', str(url))), true);
    },
    // another document, which unloads this one
    reload(): void {
      pageSession.session.ctx.reload();
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
          navigateDocument(this.href.split('#')[0] + hash, false);
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
    /** The URL, or null where there is none: the constructor, which does
     *  not throw (URL Standard, 6.1). */
    static parse(url: Any, base?: Any): Any {
      const json = call('url', str(url), base === undefined ? '' : str(base));
      if (typeof json !== 'string' || !json) return null;
      const parsed = Object.create(URL.prototype);
      parsed._href = JSON.parse(json).href;
      return parsed;
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
  /** A header a page may not set on a request (Fetch 2.2.2, "forbidden
   *  request-header"), which a request's headers drop, as the host does. */
  const FORBIDDEN_REQUEST_HEADER =
    /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|user-agent|via)$|^(proxy-|sec-)/;
  /** A header's name, a token (RFC 9110, 5.1). */
  const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  /** The bytes no CORS-safelisted header value may hold (Fetch 2.2.2). */
  const UNSAFE_HEADER_BYTES =
    /[\u0000-\u0008\u000a-\u001f"():<>?@[\\\]{}\u007f]/;
  /** Whether a `no-cors` request may have a header (Fetch 2.2.2,
   *  "no-CORS-safelisted request-header"). */
  const noCorsSafelisted = (name: string, value: string): boolean => {
    if (value.length > 128) return false;
    switch (name) {
      case 'accept':
        return !UNSAFE_HEADER_BYTES.test(value);
      case 'accept-language':
      case 'content-language':
        return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
      case 'content-type': {
        if (UNSAFE_HEADER_BYTES.test(value)) return false;
        const essence = value.split(';')[0].trim().toLowerCase();
        return (
          essence === 'application/x-www-form-urlencoded' ||
          essence === 'multipart/form-data' ||
          essence === 'text/plain'
        );
      }
      default:
        return false;
    }
  };

  class Headers {
    _map = new Map<string, string>();
    /** What a page may change of the list (Fetch 5.1, its guard): all of
     *  it, a request's own, a `no-cors` request's safelisted few, a
     *  response's, or none of it — a network response's. */
    _guard = 'none';
    constructor(init: Any = {}) {
      fillHeaders(this, init);
    }
    /** A name and a value as Fetch's `append` and `set` take them: the
     *  value's white space trimmed and both checked, or null where the
     *  guard drops the header without a word. */
    _admit(
      method: string,
      k: Any,
      v: Any,
      appending: boolean,
    ): [string, string] | null {
      const name = str(k);
      const value = str(v).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
      if (!HEADER_NAME.test(name)) {
        throw new TypeError(
          `Failed to execute '${method}' on 'Headers': Invalid name`,
        );
      }
      if (/[\0\r\n]/.test(value)) {
        throw new TypeError(
          `Failed to execute '${method}' on 'Headers': Invalid value`,
        );
      }
      if (this._guard === 'immutable') {
        throw new TypeError(
          `Failed to execute '${method}' on 'Headers': Headers are immutable`,
        );
      }
      const key = name.toLowerCase();
      if (this._guard === 'request' && FORBIDDEN_REQUEST_HEADER.test(key)) {
        return null;
      }
      if (this._guard === 'response' && /^set-cookie2?$/.test(key)) {
        return null;
      }
      if (this._guard === 'request-no-cors') {
        const had = appending ? this._map.get(key) : undefined;
        if (
          !noCorsSafelisted(key, had === undefined ? value : `${had}, ${value}`)
        ) {
          return null;
        }
      }
      return [key, value];
    }
    _name(method: string, k: Any): string {
      const name = str(k);
      if (!HEADER_NAME.test(name)) {
        throw new TypeError(
          `Failed to execute '${method}' on 'Headers': Invalid name`,
        );
      }
      return name.toLowerCase();
    }
    append(k: Any, v: Any): void {
      const admitted = this._admit('append', k, v, true);
      if (!admitted) return;
      const [key, value] = admitted;
      const had = this._map.get(key);
      this._map.set(key, had === undefined ? value : `${had}, ${value}`);
    }
    set(k: Any, v: Any): void {
      const admitted = this._admit('set', k, v, false);
      if (admitted) this._map.set(admitted[0], admitted[1]);
    }
    get(k: Any): string | null {
      return this._map.get(this._name('get', k)) ?? null;
    }
    getSetCookie(): string[] {
      const value = this._map.get('set-cookie');
      return value === undefined ? [] : [value];
    }
    has(k: Any): boolean {
      return this._map.has(this._name('has', k));
    }
    delete(k: Any): void {
      const key = this._name('delete', k);
      if (this._guard === 'immutable') {
        throw new TypeError(
          "Failed to execute 'delete' on 'Headers': Headers are immutable",
        );
      }
      if (this._guard === 'request' && FORBIDDEN_REQUEST_HEADER.test(key)) {
        return;
      }
      if (
        this._guard === 'request-no-cors' &&
        !/^(accept|accept-language|content-language|content-type|range)$/.test(
          key,
        )
      ) {
        return;
      }
      if (this._guard === 'response' && /^set-cookie2?$/.test(key)) return;
      this._map.delete(key);
    }
    /** The list as a page iterates it: sorted by name (Fetch 2.2, "sort
     *  and combine"). */
    _sorted(): [string, string][] {
      return [...this._map.entries()].sort((x, y) =>
        x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0,
      );
    }
    forEach(fn: Any, self?: Any): void {
      for (const [k, v] of this._sorted()) fn.call(self, v, k, this);
    }
    entries(): Any {
      return this._sorted()[Symbol.iterator]();
    }
    keys(): Any {
      return this._sorted()
        .map(([k]) => k)
        [Symbol.iterator]();
    }
    values(): Any {
      return this._sorted()
        .map(([, v]) => v)
        [Symbol.iterator]();
    }
    [Symbol.iterator](): Any {
      return this._sorted()[Symbol.iterator]();
    }
  }

  /** A headers object filled from what a page hands in (Fetch 5.2,
   *  "fill"): another, a sequence of pairs, or a record. */
  function fillHeaders(headers: Any, init: Any): void {
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      for (const [k, v] of init._map) headers.append(k, v);
      return;
    }
    if (typeof init !== 'object' && typeof init !== 'function') {
      throw new TypeError(
        "Failed to construct 'Headers': The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'.",
      );
    }
    if (typeof init[Symbol.iterator] === 'function') {
      for (const pair of init) {
        const items = Array.from(pair as Any);
        if (items.length !== 2) {
          throw new TypeError("Failed to construct 'Headers': Invalid value");
        }
        headers.append(items[0], items[1]);
      }
      return;
    }
    for (const k of Object.keys(init)) headers.append(k, init[k]);
  }

  /** A headers object with a guard, filled under it: a request's drops
   *  what a page may not set on one; a network response's is filled as
   *  it came and then let alone. */
  const guardedHeaders = (init: Any, guard: string): Any => {
    const headers = new Headers();
    if (guard === 'immutable') {
      const pairs: Any =
        init instanceof Headers
          ? init._map
          : Array.isArray(init)
            ? init
            : Object.entries(init ?? {});
      for (const [k, v] of pairs) {
        const key = str(k).toLowerCase();
        const had = headers._map.get(key);
        headers._map.set(key, had === undefined ? str(v) : `${had}, ${str(v)}`);
      }
    } else {
      headers._guard = guard;
      fillHeaders(headers, init);
    }
    headers._guard = guard;
    return headers;
  };

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

  const utf8Bytes = (text: string): Uint8Array =>
    new TextEncoder().encode(text);
  const joinBytes = (parts: Uint8Array[]): Uint8Array => {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  /** A form's entries as `multipart/form-data` (HTML 4.10.21.8): a file's
   *  part its bytes as they are, a string's its UTF-8. */
  const multipartOf = (form: Any, boundary: string): Uint8Array => {
    const quoted = (s: string) =>
      s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const parts: Uint8Array[] = [];
    for (const [name, value] of form._entries) {
      const file = value instanceof File;
      let head = `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"`;
      if (file) {
        head += `; filename="${quoted(value.name)}"\r\nContent-Type: ${value.type || 'application/octet-stream'}`;
      }
      parts.push(
        utf8Bytes(`${head}\r\n\r\n`),
        file ? value._bytes : utf8Bytes(value),
        utf8Bytes('\r\n'),
      );
    }
    parts.push(utf8Bytes(`--${boundary}--\r\n`));
    return joinBytes(parts);
  };
  /**
   * Fetch's "extract a body" (5.2): what a body init is, as its bytes or as
   * the stream it is, and the `Content-Type` it implies, or null — text's
   * and a form's are theirs, a `Blob`'s its type, a buffer's none.
   */
  const extractBody = (
    init: Any,
  ): { bytes: Uint8Array | null; stream: Any; type: string | null } => {
    if (init instanceof ReadableStream) {
      return { bytes: null, stream: init, type: null };
    }
    if (init instanceof Blob) {
      return { bytes: init._bytes, stream: null, type: init.type || null };
    }
    if (init instanceof ArrayBuffer) {
      return { bytes: new Uint8Array(init.slice(0)), stream: null, type: null };
    }
    if (ArrayBuffer.isView(init)) {
      return {
        bytes: new Uint8Array(
          init.buffer.slice(init.byteOffset, init.byteOffset + init.byteLength),
        ),
        stream: null,
        type: null,
      };
    }
    if (init instanceof FormData) {
      const boundary = `----formdata-${Math.random().toString(36).slice(2)}`;
      return {
        bytes: multipartOf(init, boundary),
        stream: null,
        type: `multipart/form-data; boundary=${boundary}`,
      };
    }
    if (init instanceof URLSearchParams) {
      return {
        bytes: utf8Bytes(init.toString()),
        stream: null,
        type: 'application/x-www-form-urlencoded;charset=UTF-8',
      };
    }
    return {
      bytes: utf8Bytes(str(init)),
      stream: null,
      type: 'text/plain;charset=UTF-8',
    };
  };
  /** A stream read to its end: the bytes of each chunk, which has to be a
   *  view of them (Fetch, "extract a body"). */
  const drainStream = async (
    stream: Any,
    onReader?: (reader: Any) => void,
  ): Promise<Uint8Array> => {
    const reader = stream.getReader();
    onReader?.(reader);
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(
          'Failed to read the stream: the chunk is not a Uint8Array.',
        );
      }
      chunks.push(value);
    }
    return joinBytes(chunks);
  };
  /** A body as `FormData` (Fetch 6.2, "package data"): the entries of a
   *  `multipart/form-data` body or an urlencoded one, by its type. */
  const formDataOf = (bytes: Uint8Array, type: string | null): Any => {
    const header = type ?? '';
    const essence = header.split(';')[0].trim().toLowerCase();
    const form = new FormData();
    if (essence === 'application/x-www-form-urlencoded') {
      const text = new TextDecoder().decode(bytes);
      for (const [k, v] of new URLSearchParams(text)) form.append(k, v);
      return form;
    }
    const fail = () =>
      new TypeError(
        "Failed to execute 'formData': Could not parse content as FormData.",
      );
    if (essence !== 'multipart/form-data') throw fail();
    const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(header);
    const boundary = m ? (m[1] ?? m[2]) : null;
    if (!boundary) throw fail();
    // found in the bytes as Latin-1, each byte a code unit, so an index
    // in the text is one in the bytes
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const delimiter = `--${boundary}`;
    let at = text.indexOf(delimiter);
    if (at < 0) throw fail();
    for (;;) {
      at += delimiter.length;
      if (text.startsWith('--', at)) break;
      if (!text.startsWith('\r\n', at)) throw fail();
      at += 2;
      const headEnd = text.indexOf('\r\n\r\n', at);
      if (headEnd < 0) throw fail();
      const next = text.indexOf(`\r\n${delimiter}`, headEnd + 4);
      if (next < 0) throw fail();
      let name: string | null = null;
      let filename: string | null = null;
      let partType = '';
      for (const line of text.slice(at, headEnd).split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (key === 'content-disposition') {
          const param = (p: string): string | null => {
            const found = new RegExp(`;\\s*${p}="([^"]*)"`, 'i').exec(value);
            return found ? found[1] : null;
          };
          name = param('name');
          filename = param('filename');
        } else if (key === 'content-type') partType = value;
      }
      if (name === null) throw fail();
      const content = bytes.subarray(headEnd + 4, next);
      if (filename !== null) {
        form.append(name, new File([content], filename, { type: partType }));
      } else form.append(name, new TextDecoder().decode(content));
      at = next + 2;
    }
    return form;
  };

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
    constructor(body: Any = null, init: Any = {}) {
      this._body = '';
      const page = init.type === undefined;
      this.type = page ? 'default' : str(init.type);
      this.status = Number(init.status ?? 200);
      this.statusText = String(init.statusText ?? '');
      if (page) {
        // what a page may make one of (Fetch 6.4, "initialize a response")
        if (!(this.status >= 200 && this.status <= 599)) {
          throw new RangeError(
            `Failed to construct 'Response': The status provided (${this.status}) is outside the range [200, 599].`,
          );
        }
        if (!/^[\t\u0020-\u007e\u0080-\u00ff]*$/.test(this.statusText)) {
          throw new TypeError(
            "Failed to construct 'Response': Invalid statusText",
          );
        }
        if (
          body !== null &&
          body !== undefined &&
          [101, 103, 204, 205, 304].includes(this.status)
        ) {
          throw new TypeError(
            "Failed to construct 'Response': Response with null body status cannot have body",
          );
        }
      }
      this.headers = guardedHeaders(
        init.headers ?? {},
        page ? 'response' : str(init.guard ?? 'immutable'),
      );
      this.url = String(init.url ?? '');
      this.redirected = !!init.redirected;
      if (body === null || body === undefined) return;
      if (page) {
        // a page's: its body extracted, and its type the header where it
        // names none (Fetch 6.4, the `Response` constructor)
        const extracted = extractBody(body);
        // a stream is read as it is asked for: three.js's loaders hand a
        // fetch's body on through one, to count its progress
        if (extracted.stream) this._stream = extracted.stream;
        else this._raw = extracted.bytes;
        if (extracted.type !== null && !this.headers.has('content-type')) {
          this.headers.set('content-type', extracted.type);
        }
        return;
      }
      // the network's, or one made of another's body: as it is
      if (body instanceof ReadableStream) this._stream = body;
      else if (body instanceof Uint8Array) this._raw = body;
      else if (body instanceof Blob) this._raw = body._bytes;
      else this._body = str(body);
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
      return drainStream(this._stream);
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
    formData(): Promise<Any> {
      return this.bytes().then((bytes) =>
        formDataOf(bytes, this.headers.get('content-type')),
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
      const init = {
        status: this.status,
        statusText: this.statusText,
        url: this.url,
        redirected: this.redirected,
        type: this.type,
        headers: this.headers,
        guard: this.headers._guard,
      };
      if (this._given()) {
        const [mine, theirs] = this._stream.tee();
        this._stream = mine;
        return new Response(theirs, init);
      }
      return new Response(this._raw ?? this._body, init);
    }
    static error(): Any {
      return new Response(null, { status: 0, type: 'error' });
    }
    static redirect(url: Any, status: Any = 302): Any {
      const to = new URL(str(url), location.href).href;
      const code = Number(status);
      if (![301, 302, 303, 307, 308].includes(code)) {
        throw new RangeError(
          `Failed to execute 'redirect' on 'Response': Invalid status code`,
        );
      }
      return new Response(null, {
        status: code,
        type: 'default',
        headers: [['location', to]],
      });
    }
    static json(data: Any, init: Any = {}): Any {
      const text = JSON.stringify(data);
      if (text === undefined) {
        throw new TypeError(
          "Failed to execute 'json' on 'Response': The data provided cannot be converted to JSON.",
        );
      }
      const headers = new Headers(init.headers ?? {});
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return new Response(text, {
        status: init.status,
        statusText: init.statusText,
        headers,
      });
    }
  }

  // `fetch`: the request is the host's, which keeps the browser's network
  // policy and CORS (`_fetchFor`)
  let fetchSeq = 0;
  const fetches = new Map<
    number,
    { resolve: Any; reject: Any; streamed?: boolean }
  >();
  /** The bodies still arriving, by request: the controller of the stream
   *  each response reads (`__fetchChunk`, `__fetchEnd`). */
  const fetchBodies = new Map<number, Any>();
  /**
   * A `Range` header's one range of bytes (Fetch, "parse a single range
   * header value", white space allowed): its start and its end, either
   * null where it is left out, or null for a value that is no such range —
   * another unit, a second range, a sign, a stray character.
   */
  const parseRange = (value: string): [number | null, number | null] | null => {
    let at = 0;
    const skip = () => {
      while (value[at] === ' ' || value[at] === '\t') at += 1;
    };
    const digits = (): number | null => {
      const from = at;
      while (at < value.length && value[at] >= '0' && value[at] <= '9') at += 1;
      return at > from ? Number(value.slice(from, at)) : null;
    };
    const unit = /^[^=\t ]*/.exec(value)![0];
    if (unit !== 'bytes') return null;
    at = unit.length;
    skip();
    if (value[at] !== '=') return null;
    at += 1;
    skip();
    const start = digits();
    skip();
    if (value[at] !== '-') return null;
    at += 1;
    skip();
    const end = digits();
    if (at < value.length) return null;
    if (start === null && end === null) return null;
    if (start !== null && end !== null && start > end) return null;
    return [start, end];
  };

  /** A blob URL's response (Fetch 4.2, its scheme fetch): the blob, or the
   *  part of it a `Range` names, as a `206`; null for a network error. */
  const blobResponse = (blob: Any, url: string, headers: Any): Any => {
    const full = blob.size;
    const type = blob.type;
    const range = headers.get('range');
    if (range === null) {
      return new Response(blob, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-length': String(full), 'content-type': type },
        url,
        type: 'basic',
      });
    }
    const parsed = parseRange(range);
    if (!parsed) return null;
    let [start, end] = parsed;
    if (start === null) {
      start = Math.max(0, full - end!);
      end = full - 1;
    } else {
      if (start >= full) return null;
      if (end === null || end >= full) end = full - 1;
    }
    const part = blob.slice(start, end + 1, type);
    return new Response(part, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'content-length': String(part.size),
        'content-range': `bytes ${start}-${end}/${full}`,
        'content-type': type,
      },
      url,
      type: 'basic',
    });
  };

  /** A data: URL's response (Fetch 4.2, its scheme fetch, over the data:
   *  URL processor): its bytes and its type, or null where its base64 is
   *  none. */
  const dataResponse = (url: string): Any => {
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    let type = url.slice(5, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
    const bytes = percentDecodedBytes(url.slice(comma + 1));
    let body: Uint8Array = bytes;
    const base64 = /;[\u0020]*base64$/i.exec(type);
    if (base64) {
      type = type.slice(0, base64.index);
      let text = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      text = text.replace(/[\t\n\f\r ]/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) {
        return null;
      }
      body = bytesOfBase64(text);
    }
    if (type.startsWith(';')) type = `text/plain${type}`;
    const essence = /^([^\s/;]+)\/([^\s;]+)/.exec(type);
    const mime = essence
      ? `${essence[1]}/${essence[2]}`.toLowerCase() +
        type
          .slice(essence[0].length)
          .split(';')
          .map((part) => part.trim())
          .filter((part) => /^[^=]+=.+$/.test(part))
          .map((part) => {
            const at = part.indexOf('=');
            return `;${part.slice(0, at).toLowerCase()}=${part.slice(at + 1)}`;
          })
          .join('')
      : 'text/plain;charset=US-ASCII';
    return new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': mime },
      url,
      type: 'basic',
    });
  };
  /** A URL's percent-encoded bytes decoded, as the URL standard's
   *  "percent-decode" has them: a `%` not before two hex digits stays. */
  const percentDecodedBytes = (text: string): Uint8Array => {
    const raw = utf8Bytes(text);
    const out: number[] = [];
    const hex = (c: number) =>
      (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === 37 && hex(raw[i + 1]) && hex(raw[i + 2])) {
        out.push(parseInt(String.fromCharCode(raw[i + 1], raw[i + 2]), 16));
        i += 2;
      } else out.push(raw[i]);
    }
    return new Uint8Array(out);
  };

  const fetch = (input: Any, init: Any = {}): Promise<Any> =>
    new Promise((resolve, reject) => {
      const id = ++fetchSeq;
      const request = input instanceof Request ? input : null;
      const url =
        typeof input === 'string' ? input : (input?.url ?? str(input));
      const mode = str(init.mode ?? request?.mode ?? 'cors');
      const headers = guardedHeaders(
        init.headers ?? input?.headers ?? {},
        mode === 'no-cors' ? 'request-no-cors' : 'request',
      );
      const duplex = init.duplex;
      const signal = init.signal ?? request?.signal;
      const aborted = () =>
        signal?.reason ??
        new DOMException('The operation was aborted.', 'AbortError');
      // a data: URL is answered here, whatever its Range (Fetch 4.2)
      if (/^data:/i.test(url)) {
        const response = dataResponse(url);
        if (response) resolve(response);
        else reject(new TypeError('Failed to fetch'));
        return;
      }
      // a blob URL is this realm's, read here
      if (url.startsWith('blob:')) {
        const blob = blobUrls.get(url);
        const response = blob ? blobResponse(blob, url, headers) : null;
        if (response) resolve(response);
        else reject(new TypeError('Failed to fetch'));
        return;
      }
      const method = str(init.method ?? request?.method ?? 'GET').toUpperCase();
      let extracted: ReturnType<typeof extractBody> | null = null;
      if (init.body !== undefined && init.body !== null) {
        extracted = extractBody(init.body);
        if (extracted.stream && duplex !== 'half') {
          reject(
            new TypeError(
              "Failed to execute 'fetch' on 'Window': The `duplex` member must be specified for a request with a streaming body.",
            ),
          );
          return;
        }
      } else if (request && (request._raw || request._stream)) {
        if (request.bodyUsed) {
          reject(new TypeError('Body has already been consumed.'));
          return;
        }
        request.bodyUsed = true;
        extracted = {
          bytes: request._raw,
          stream: request._stream,
          type: null,
        };
      }
      if (extracted && (method === 'GET' || method === 'HEAD')) {
        reject(
          new TypeError(
            "Failed to execute 'fetch' on 'Window': Request with GET/HEAD method cannot have body.",
          ),
        );
        return;
      }
      if (extracted?.type && !headers.has('content-type')) {
        headers.set('content-type', extracted.type);
      }
      if (signal?.aborted) {
        if (extracted?.stream) extracted.stream.cancel?.(aborted());
        reject(aborted());
        return;
      }
      // a stream body is read through a reader of fetch's own, which is
      // what an abort cancels it through (Fetch 4.1, "abort fetch")
      let bodyReader: Any = null;
      // a body that is a stream and nothing else has no source (Fetch
      // 2.2.5), so nothing may send it again (HTTP-network-or-cache fetch):
      // a 401 is a network error rather than a request made again with
      // credentials, and the host is told (`streamedBody`), so that a 421
      // is the page's answer rather than a request made again on a new
      // connection. A `Request` whose bytes a page read as a stream still
      // has them.
      const sourceless = !!extracted?.stream && !extracted.bytes;
      fetches.set(id, { resolve, reject, streamed: sourceless });
      signal?.addEventListener?.('abort', () => {
        // after the headers, an abort errors the body that is arriving
        const body = fetchBodies.get(id);
        if (body) {
          fetchBodies.delete(id);
          call('abortFetch', id);
          body.error(aborted());
          return;
        }
        if (!fetches.delete(id)) return;
        call('abortFetch', id);
        if (bodyReader) bodyReader.cancel(aborted()).catch(() => {});
        else if (extracted?.stream) extracted.stream.cancel?.(aborted());
        reject(aborted());
      });
      // what crosses: text where the bytes are UTF-8, which is every
      // string's and most forms', and base64 where they are not
      const textOf = (bytes: Uint8Array): string | null => {
        try {
          return new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
        } catch {
          return null;
        }
      };
      const send = (bytes: Uint8Array | null): void => {
        if (!fetches.has(id)) return;
        call(
          'fetch',
          id,
          JSON.stringify({
            url: str(url),
            method,
            headers: Array.from(headers._map.entries()),
            ...(bytes === null
              ? { body: null }
              : textOf(bytes) !== null
                ? { body: textOf(bytes) }
                : { body: '', base64: base64OfBytes(bytes) }),
            ...(sourceless && bytes !== null ? { streamedBody: true } : {}),
            // the body is taken as it arrives
            stream: true,
            // what the host checks another origin's answer against
            mode,
            credentials: str(
              init.credentials ?? request?.credentials ?? 'same-origin',
            ),
          }),
        );
      };
      // a stream is read to its end and sent whole: a request with a body
      // that is still coming is no request this network makes
      if (extracted?.stream) {
        drainStream(extracted.stream, (reader) => {
          bodyReader = reader;
        }).then(send, (error: Any) => {
          if (!fetches.delete(id)) return;
          reject(
            error instanceof TypeError
              ? error
              : new TypeError('Failed to fetch'),
          );
        });
      } else send(extracted?.bytes ?? null);
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
    readonly duplex = 'half';
    /** The body's bytes, or the stream it is, or neither for none. */
    _raw: Uint8Array | null = null;
    _stream: Any = null;
    bodyUsed = false;
    constructor(input: Any, init: Any = {}) {
      const from = input instanceof Request ? input : null;
      // every member of the dictionary is read, as WebIDL converts one —
      // `duplex` among them, whose being read a page feature-detects a
      // stream body by
      const duplex = init.duplex;
      this.url = new URL(from ? from.url : str(input), location.href).href;
      this.method = str(init.method ?? from?.method ?? 'GET').toUpperCase();
      this.signal = init.signal ?? from?.signal ?? new AbortController().signal;
      this.mode = str(init.mode ?? from?.mode ?? 'cors');
      if (this.mode === 'no-cors' && !/^(GET|HEAD|POST)$/.test(this.method)) {
        throw new TypeError(
          `Failed to construct 'Request': '${this.method}' is unsupported in no-cors mode.`,
        );
      }
      this.headers = guardedHeaders(
        init.headers ?? from?.headers ?? {},
        this.mode === 'no-cors' ? 'request-no-cors' : 'request',
      );
      this.credentials = str(
        init.credentials ?? from?.credentials ?? 'same-origin',
      );
      this.cache = str(init.cache ?? from?.cache ?? 'default');
      this.redirect = str(init.redirect ?? from?.redirect ?? 'follow');
      this.keepalive = !!(init.keepalive ?? from?.keepalive);
      const given = init.body !== undefined && init.body !== null;
      if (!given && from && from.bodyUsed) {
        throw new TypeError(
          "Failed to construct 'Request': Cannot construct a Request with a Request object that has already been used.",
        );
      }
      const extracted = given ? extractBody(init.body) : null;
      const has = given || !!(from && (from._raw || from._stream));
      if (has && (this.method === 'GET' || this.method === 'HEAD')) {
        throw new TypeError(
          "Failed to construct 'Request': Request with GET/HEAD method cannot have body.",
        );
      }
      if (extracted) {
        if (extracted.stream && duplex !== 'half') {
          throw new TypeError(
            "Failed to construct 'Request': The `duplex` member must be specified for a request with a streaming body.",
          );
        }
        this._raw = extracted.bytes;
        this._stream = extracted.stream;
        if (extracted.type !== null && !this.headers.has('content-type')) {
          this.headers.set('content-type', extracted.type);
        }
      } else if (from) {
        this._raw = from._raw;
        this._stream = from._stream;
      }
    }
    get body(): Any {
      if (this._stream) return this._stream;
      if (!this._raw) return null;
      // made once, of the bytes, as a response's is
      const bytes = this._raw;
      this._stream = new ReadableStream({
        pull(controller: Any) {
          if (bytes.length) controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
      return this._stream;
    }
    clone(): Any {
      if (this.bodyUsed) {
        throw new TypeError(
          "Failed to execute 'clone' on 'Request': Request body is already used",
        );
      }
      const copy = new Request(this);
      if (this._stream) {
        const [mine, theirs] = this._stream.tee();
        this._stream = mine;
        copy._stream = theirs;
      }
      return copy;
    }
    /** The body read once, as a response that holds it: what every method
     *  reads it through. */
    _consume(): Promise<Any> {
      if (this.bodyUsed) {
        return Promise.reject(new TypeError('Body has already been consumed.'));
      }
      if (this._stream || this._raw) this.bodyUsed = true;
      return Promise.resolve(
        new Response(this._stream ?? this._raw ?? null, {
          type: 'basic',
          headers: this.headers,
        }),
      );
    }
    text(): Promise<string> {
      return this._consume().then((r) => r.text());
    }
    json(): Promise<Any> {
      return this._consume().then((r) => r.json());
    }
    arrayBuffer(): Promise<ArrayBuffer> {
      return this._consume().then((r) => r.arrayBuffer());
    }
    bytes(): Promise<Uint8Array> {
      return this._consume().then((r) => r.bytes());
    }
    blob(): Promise<Any> {
      return this._consume().then((r) => r.blob());
    }
    formData(): Promise<Any> {
      return this._consume().then((r) => r.formData());
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
      // XMLHttpRequest's own checks, which throw its own error
      if (!HEADER_NAME.test(str(name))) {
        throw new DOMException(
          `Failed to execute 'setRequestHeader' on 'XMLHttpRequest': '${str(name)}' is not a valid HTTP header field name.`,
          'SyntaxError',
        );
      }
      if (/[\0\r\n]/.test(str(value).trim())) {
        throw new DOMException(
          `Failed to execute 'setRequestHeader' on 'XMLHttpRequest': '${str(value)}' is not a valid HTTP header field value.`,
          'SyntaxError',
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

  /** `document.fragmentDirective` (WICG Scroll To Text Fragment): an
   *  object with nothing on it, which says that a URL's `#:~:text=…` is
   *  taken — what a page that makes links to text asks before it makes
   *  one. The directive itself is the host's, never the page's. */
  const FRAGMENT_DIRECTIVE = Symbol('fragmentDirective');
  class FragmentDirective {
    constructor(token?: Any) {
      if (token !== FRAGMENT_DIRECTIVE) {
        throw new TypeError('Illegal constructor');
      }
    }
  }
  const fragmentDirectives = new WeakMap<object, FragmentDirective>();

  /** `visualViewport`: the pane's, as `innerWidth` is, at a scale of 1. */
  class VisualViewport extends EventTarget {
    /** The viewport it is of: the page's, or a frame's (`visualOf`). */
    _of: Viewport | null = null;
    get width(): number {
      return this._of?.frame ? sizeOf(this._of)[0] : viewport().width;
    }
    get height(): number {
      return this._of?.frame ? sizeOf(this._of)[1] : viewport().height;
    }
    get offsetLeft(): number {
      return 0;
    }
    get offsetTop(): number {
      return 0;
    }
    // a frame's document scrolls nothing here
    get pageLeft(): number {
      return this._of?.frame ? 0 : viewport().scrollX;
    }
    get pageTop(): number {
      return this._of?.frame ? 0 : viewport().scrollY;
    }
    override addEventListener(type: string, fn: Any, options?: Any): void {
      super.addEventListener(type, fn, options);
      if (String(type) === 'resize' && fn && this._of) watchViewport(this._of);
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
    // an `ImageBitmap` is serializable, its pixels copied (HTML 8.11.2)
    if (value instanceof ImageBitmap) {
      if (!value._data) {
        throw new DOMException(
          'An ImageBitmap is detached and could not be cloned.',
          'DataCloneError',
        );
      }
      out = makeBitmap(value._width, value._height, value._data.slice());
      seen.set(value, out);
      return out;
    }
    // a point, a rectangle, a quad or a matrix (Geometry 1, 7)
    const shape = GEOMETRY.serialize(value);
    if (shape) {
      out = GEOMETRY.deserialize(shape[0], shape[1]);
      seen.set(value, out);
      return out;
    }
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
  /**
   * What a `postMessage` transfers given up by the sender once its message
   * is copied (HTML 2.7.6, "StructuredSerializeWithTransfer"): an
   * `ArrayBuffer` in the list is detached, through the runtime's own
   * `transfer()`, so a view on it reads as empty, as a page that checks a
   * transfer took place expects. A runtime without it keeps the buffer.
   */
  const giveUp = (transfer: Any): void => {
    const list = Array.isArray(transfer) ? transfer : transfer?.transfer;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (
        item instanceof ArrayBuffer &&
        typeof (item as Any).transfer === 'function'
      ) {
        (item as Any).transfer();
      }
    }
  };

  /** What a `postMessage` transfers, from the list or from the options'
   *  `transfer`. */
  const transferListOf = (transfer: Any): Any[] => {
    const list = Array.isArray(transfer) ? transfer : transfer?.transfer;
    return Array.isArray(list) ? list : [];
  };
  /**
   * The ports, the `OffscreenCanvas`es and the `ImageBitmap`s a list
   * transfers (HTML 2.7.6, "StructuredSerializeWithTransfer"): each one
   * once, none given up already, and no canvas with a context, or a
   * `DataCloneError` — an `InvalidStateError` for the canvas — before
   * anything is posted. A buffer is `giveUp`'s.
   */
  const transfersOf = (list: Any[]): Any[] => {
    const moving: Any[] = [];
    list.forEach((item, i) => {
      const name =
        item instanceof MessagePort
          ? 'Port'
          : item instanceof OffscreenCanvas
            ? 'OffscreenCanvas'
            : item instanceof ImageBitmap
              ? 'ImageBitmap'
              : null;
      if (!name) return;
      if (
        item instanceof MessagePort
          ? item._detached
          : item instanceof OffscreenCanvas
            ? item._detached
            : !item._data
      ) {
        throw new DOMException(
          `${name} at index ${i} is already detached.`,
          'DataCloneError',
        );
      }
      if (moving.includes(item)) {
        throw new DOMException(
          `${name} at index ${i} is a duplicate of an earlier ${name === 'Port' ? 'port' : name}.`,
          'DataCloneError',
        );
      }
      if (item instanceof OffscreenCanvas && canvases.get(item)?.context) {
        throw new DOMException(
          `OffscreenCanvas at index ${i} has an associated context and thus is not transferable.`,
          'InvalidStateError',
        );
      }
      moving.push(item);
    });
    return moving;
  };
  /**
   * A port's place taken by `to` (HTML 9.4.4, the transfer steps): `to`
   * is entangled with the port's partner, the port is given up, and what
   * still arrives for it goes on to `to`. What was queued for it is
   * answered, for its new place to have.
   */
  const movePort = (from: Any, to: Any): Array<[Any, Any[]]> => {
    const other = from._other;
    to._other = other;
    if (other) other._other = to;
    from._other = null;
    from._movedTo = to;
    from._detached = true;
    return from._waiting.splice(0);
  };
  /** A copy of a message here, with what its list transfers each a new
   *  one in its place — a port, a canvas, a bitmap — which the copy holds
   *  where the message held the old: what a port's, a window's and
   *  `structuredClone` hand on. `ports` are the ports of them, which a
   *  message event lists, and `moved` all of them, which a port hands on
   *  to a wire across a thread (`_deliver`). */
  const cloneMoving = (
    message: Any,
    list: Any[],
  ): { data: Any; ports: Any[]; moved: Any[] } => {
    const moving = transfersOf(list);
    const moved = moving.map((item) =>
      item instanceof MessagePort
        ? new MessagePort()
        : item instanceof OffscreenCanvas
          ? new OffscreenCanvas(0, 0)
          : makeBitmap(item._width, item._height, item._data),
    );
    const data = structuredCopy(
      message,
      new Map(moving.map((item, i) => [item, moved[i]])),
    );
    moving.forEach((item, i) => {
      if (item instanceof MessagePort) {
        moved[i]._waiting.push(...movePort(item, moved[i]));
      } else if (item instanceof OffscreenCanvas) {
        moveOffscreen(item, moved[i]);
      } else {
        detachBitmap(item);
      }
    });
    return {
      data,
      ports: moved.filter((item) => item instanceof MessagePort),
      moved,
    };
  };

  /** A thread a port can be across: what names its channel here, and how
   *  a string reaches the other side, which is all that crosses. */
  interface Across {
    key: string;
    send: (text: string) => void;
  }
  /** The ends here of the ports across a thread, by their channel and
   *  their wire: each stands for the port over there — what is delivered
   *  to it is sent across — and its `_other` is what hears that port. */
  const wires = new Map<string, Any>();
  /** A wire's name is this realm's own, so the two sides of a channel
   *  never name two wires alike. */
  const WIRE_REALM = Math.random().toString(36).slice(2, 10);
  let wireSeq = 0;
  const wireEnd = (across: Across, wire: string): Any => {
    const end = {
      _other: null as Any,
      _closed: false,
      _deliver(data: Any, ports: Any[] = []): void {
        const later: Array<() => void> = [];
        const d = serializeClone(data, undefined, {
          across,
          moving: ports,
          later,
        });
        across.send(JSON.stringify({ q: wire, d }));
        for (const go of later) go();
      },
    };
    wires.set(`${across.key} ${wire}`, end);
    return end;
  };
  /** A message along a wire, `{ q, d }`, to what hears the port across it
   *  here. False where it is none. */
  const wireMessage = (across: Across, text: string): boolean => {
    if (!text.startsWith('{"q":')) return false;
    let wrapper: Any;
    try {
      wrapper = JSON.parse(text);
    } catch {
      return false;
    }
    const to = wires.get(`${across.key} ${str(wrapper.q)}`)?._other;
    if (!to) return true;
    let made: Any;
    try {
      made = deserializeWith(str(wrapper.d), across);
    } catch {
      return true;
    }
    to._deliver(made.data, made.ports);
    return true;
  };
  /**
   * The `OffscreenCanvas`es this realm transferred across a thread that
   * show somewhere, by the thread's side and the token each crossed with:
   * the placeholder each shows in, where that is this realm's, or the route
   * back to the realm that has it, where the canvas came here from another.
   */
  const canvasRoutes = new Map<
    string,
    { placeholder: Any; route: { across: Across; token: string } | null }
  >();
  /** A frame an `OffscreenCanvas` across a thread drew, `{ k, s, d }`: its
   *  token, its rectangle and its pixels, to the placeholder this realm has
   *  for the token, or on to the realm that has it. False where the text
   *  is none. */
  const canvasFrame = (across: Across, text: string): boolean => {
    if (!text.startsWith('{"k":')) return false;
    let frame: Any;
    try {
      frame = JSON.parse(text);
    } catch {
      return false;
    }
    const to = canvasRoutes.get(`${across.key} ${str(frame.k)}`);
    if (!to) return true;
    if (to.placeholder) {
      call('canvasPut', idOf(to.placeholder), str(frame.s), str(frame.d));
    } else if (to.route) {
      to.route.across.send(
        JSON.stringify({ k: to.route.token, s: frame.s, d: frame.d }),
      );
    }
    return true;
  };
  /** The page's side of a worker's thread, and a worker's of the page. */
  const threadsAcross = new Map<number, Across>();
  const threadAcross = (id: number): Across => {
    let across = threadsAcross.get(id);
    if (!across) {
      across = {
        key: `t${id}`,
        send: (text) => call('workerPost', id, text),
      };
      threadsAcross.set(id, across);
    }
    return across;
  };
  const UP: Across = {
    key: 'up',
    send: (text) => call('workerPostOut', text),
  };

  /** `datachannel.ts`'s internals, once the WebRTC block below has made
   *  them: what a message to a worker carries a data channel by. */
  let dataChannelsOf: Any = null;

  /**
   * The data channels a `postMessage` to a worker transfers (WebRTC 1.0,
   * 6.2, "transfer steps"): each still transferable, and none twice, or a
   * `DataCloneError` before anything is posted.
   */
  const channelsTransferred = (transfer: Any): Set<Any> => {
    const moved = new Set<Any>();
    const list = Array.isArray(transfer) ? transfer : transfer?.transfer;
    if (!Array.isArray(list) || !dataChannelsOf) return moved;
    for (const item of list) {
      if (!dataChannelsOf.isChannel(item)) continue;
      if (moved.has(item) || !dataChannelsOf.transferable(item)) {
        throw new DOMException(
          'The RTCDataChannel could not be transferred.',
          'DataCloneError',
        );
      }
      moved.add(item);
    }
    return moved;
  };

  /**
   * A value as text, for a message to a worker, which runs in a thread of
   * its own that only a string reaches: structured clone's types, kept
   * apart by a tag, and an object met twice met as the first (HTML 2.7.3,
   * "StructuredSerialize"). `deserializeClone` makes it again in this
   * realm. A data channel in `moved` crosses as the host's number for it
   * and its state. The ports `transfer` moves cross as wires across
   * `transfer.across`, listed beside the value (`{ p, v }`): once nothing
   * has thrown, each moves to its wire's end here, and what was queued for
   * it is sent by `transfer.later`, which the caller runs once it has sent
   * the message. An `OffscreenCanvas` it moves crosses as its size and a
   * token its frames come back with (`canvasRoutes`), and an `ImageBitmap`
   * as its pixels, each given up here once nothing has thrown.
   */
  const serializeClone = (
    value: Any,
    moved?: Set<Any>,
    transfer?: { across: Across; moving: Any[]; later: Array<() => void> },
  ): string => {
    const seen = new Map<Any, number>();
    const wireOf = new Map<Any, string>();
    const moving = transfer?.moving ?? [];
    for (const item of moving) {
      if (item instanceof MessagePort) {
        wireOf.set(item, `${WIRE_REALM}.${++wireSeq}`);
      }
    }
    /** The token each canvas the value holds crossed with. */
    const tokens = new Map<Any, string>();
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
      const shape = GEOMETRY.serialize(v);
      if (shape) {
        return { i: index, t: 'G', k: shape[0], v: shape[1].map(walk) };
      }
      if (moved?.has(v)) {
        const { host, state } = dataChannelsOf.transferData(v);
        return { i: index, t: 'C', h: host, a: state };
      }
      const wire = wireOf.get(v);
      if (wire !== undefined) return { i: index, t: 'Q', w: wire };
      if (v instanceof OffscreenCanvas && moving.includes(v)) {
        // a token only where it shows somewhere, which a frame needs
        let token: string | null = null;
        if (canvasShown(v)) {
          token = `${WIRE_REALM}.${++wireSeq}`;
          tokens.set(v, token);
        }
        return { i: index, t: 'K', w: v._width, h: v._height, k: token };
      }
      if (v instanceof ImageBitmap) {
        if (!v._data) {
          throw new DOMException(
            'An ImageBitmap is detached and could not be cloned.',
            'DataCloneError',
          );
        }
        return {
          i: index,
          t: 'I',
          w: v._width,
          h: v._height,
          b: bytesOf(
            new Uint8Array(v._data.buffer, v._data.byteOffset, v._data.length),
          ),
        };
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
    const body = walk(value);
    // nothing threw, so the canvases and the bitmaps are given up: a
    // canvas that shows somewhere is shown from over there, its frames
    // coming back across with its token
    for (const item of moving) {
      if (item instanceof OffscreenCanvas) {
        const token = tokens.get(item);
        if (token !== undefined) {
          canvasRoutes.set(
            `${transfer!.across.key} ${token}`,
            item._placeholder
              ? { placeholder: item._placeholder, route: null }
              : { placeholder: null, route: item._route },
          );
        }
        detachOffscreen(item);
      } else if (item instanceof ImageBitmap) {
        detachBitmap(item);
      }
    }
    if (!wireOf.size) return JSON.stringify(body);
    // nothing threw, so the ports move: each one's place here is its
    // wire's end, and what was queued for it follows the message
    for (const [port, wire] of wireOf) {
      const end = wireEnd(transfer!.across, wire);
      const queued = movePort(port, end);
      transfer!.later.push(() => {
        for (const [data, ports] of queued) end._deliver(data, ports);
      });
    }
    return JSON.stringify({ p: [...wireOf.values()], v: body });
  };
  /** A message made again here, and the ports it transferred (`p`), each
   *  a port here at the end of its wire across `across`. */
  const deserializeWith = (
    text: string,
    across?: Across,
  ): { data: Any; ports: Any[] } => {
    const parsed = JSON.parse(text);
    const byWire = new Map<string, Any>();
    if (
      across &&
      parsed !== null &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.p) &&
      'v' in parsed
    ) {
      for (const wire of parsed.p) {
        const port = new MessagePort();
        port._other = wireEnd(across, str(wire));
        port._other._other = port;
        byWire.set(str(wire), port);
      }
      return {
        data: remake(parsed.v, byWire, across),
        ports: [...byWire.values()],
      };
    }
    return { data: remake(parsed, byWire, across), ports: [] };
  };
  const deserializeClone = (text: string): Any =>
    remake(JSON.parse(text), new Map());
  const remake = (
    json: Any,
    byWire: Map<string, Any>,
    across?: Across,
  ): Any => {
    const made: Any[] = [];
    const make = (v: Any): Any => {
      if (v === null || typeof v !== 'object') return v;
      if ('u' in v) return undefined;
      if ('n' in v) return Number(v.n === '-0' ? -0 : v.n);
      if ('g' in v) return BigInt(v.g);
      if ('r' in v) return made[v.r];
      let out: Any;
      switch (v.t) {
        case 'Q':
          // a port the message transferred, made as the message arrived
          out = byWire.get(str(v.w)) ?? null;
          break;
        case 'L':
          out = new Blob([bytesOfBase64(v.b)], { type: v.y });
          break;
        case 'K':
          // a canvas the message transferred, whose frames go back across
          // to where it shows
          out = new OffscreenCanvas(Number(v.w) || 0, Number(v.h) || 0);
          if (across && typeof v.k === 'string') {
            out._route = { across, token: v.k };
          }
          break;
        case 'I': {
          const bytes = bytesOfBase64(v.b);
          out = makeBitmap(
            Number(v.w) || 0,
            Number(v.h) || 0,
            new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length),
          );
          break;
        }
        case 'G':
          out = GEOMETRY.deserialize(str(v.k), v.v.map(make));
          break;
        case 'C':
          // a data channel the page handed over: this realm's own, for the
          // host's same number
          out = dataChannelsOf ? dataChannelsOf.adopt(v.h, v.a) : null;
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
    return make(json);
  };

  /** One end of a `MessageChannel` (HTML 9.4.4): what is posted to it is a
   *  task of its own, after the one that posted it, once it is started —
   *  which setting `onmessage` does. React's scheduler is one of these.
   *  One a message transfers is given up, and a new one takes its place
   *  where the message is told (`movePort`): its partner, or a wire's end
   *  where that is across a thread. */
  class MessagePort extends EventTarget {
    /** What hears what this posts: its partner, or a wire's end. */
    _other: Any = null;
    _started = false;
    _closed = false;
    /** Whether a message transferred it, and where it went. */
    _detached = false;
    _movedTo: Any = null;
    _waiting: Array<[Any, Any[]]> = [];
    postMessage(message: Any, transfer?: Any): void {
      const list = transferListOf(transfer);
      const at = list.indexOf(this);
      if (at >= 0) {
        throw new DOMException(
          `Port at index ${at} contains the source port.`,
          'DataCloneError',
        );
      }
      const other = this._other;
      // its partner posted through itself: the message, and the channel,
      // are lost (HTML 9.4.4.1, "doomed")
      const doomed = other !== null && list.includes(other);
      const { data, moved } = cloneMoving(message, list);
      giveUp(transfer);
      if (doomed || this._closed || !other || other._closed) return;
      setTimer(() => other._deliver(data, moved), 0, [], false);
    }
    /** A message to this port, with what it transferred: the ports of
     *  that are the event's, and a wire's end serializes all of it. */
    _deliver(data: Any, moved: Any[] = []): void {
      if (this._movedTo) {
        this._movedTo._deliver(data, moved);
        return;
      }
      if (this._closed) return;
      if (!this._started) {
        this._waiting.push([data, moved]);
        return;
      }
      const ports = moved.filter((item) => item instanceof MessagePort);
      const ev = new MessageEvent('message', { data, ports });
      ev.isTrusted = true;
      dispatch(this, ev);
    }
    start(): void {
      if (this._started) return;
      this._started = true;
      for (const [data, ports] of this._waiting.splice(0)) {
        setTimer(() => this._deliver(data, ports), 0, [], false);
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

  /** `navigator.userActivation` (HTML 6.4.3): whether the page has been
   *  used, and whether a press or a key of the user's is recent enough to
   *  be behind what a script does now (`hasTransientActivation`). */
  const ACTIVATION_KEY = Symbol('userActivation');
  class UserActivation {
    constructor(key?: Any) {
      if (key !== ACTIVATION_KEY) throw new TypeError('Illegal constructor');
    }
    get hasBeenActive(): boolean {
      return stickyActivation;
    }
    get isActive(): boolean {
      return hasTransientActivation();
    }
  }

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
    // WebRTC's and Media Capture's interfaces but the data channel's
    // (`webrtc.ts`, `mediastream.ts`), which a worker can be handed
    'RTCPeerConnection',
    'RTCSessionDescription',
    'RTCIceCandidate',
    'RTCPeerConnectionIceEvent',
    'RTCPeerConnectionIceErrorEvent',
    'RTCTrackEvent',
    'RTCRtpTransceiver',
    'RTCRtpSender',
    'RTCRtpReceiver',
    'RTCIceTransport',
    'RTCDtlsTransport',
    'RTCCertificate',
    'RTCStatsReport',
    'RTCSctpTransport',
    'RTCDataChannelEvent',
    'MediaStream',
    'MediaStreamTrack',
    'MediaStreamTrackEvent',
    'MediaDevices',
    'MediaDeviceInfo',
    'InputDeviceInfo',
    'OverconstrainedError',
    'CanvasCaptureMediaStreamTrack',
    // Web Audio's (`webaudio.ts`), a window's alone
    'BaseAudioContext',
    'AudioContext',
    'AudioNode',
    'AudioParam',
    'AudioScheduledSourceNode',
    'OscillatorNode',
    'ConstantSourceNode',
    'AudioBufferSourceNode',
    'GainNode',
    'DelayNode',
    'BiquadFilterNode',
    'IIRFilterNode',
    'WaveShaperNode',
    'DynamicsCompressorNode',
    'StereoPannerNode',
    'PannerNode',
    'ChannelMergerNode',
    'ChannelSplitterNode',
    'ConvolverNode',
    'AnalyserNode',
    'ScriptProcessorNode',
    'AudioDestinationNode',
    'MediaStreamAudioDestinationNode',
    'MediaStreamAudioSourceNode',
    'MediaElementAudioSourceNode',
    'AudioBuffer',
    'PeriodicWave',
    'AudioListener',
    // the geometry interfaces' other name, a window's alone
    // (`[LegacyWindowAlias]`); `SVGPoint`, `SVGRect` and `SVGMatrix` go
    // with every other `SVG…`
    'WebKitCSSMatrix',
    'window',
    'document',
    'parent',
    'top',
    'frames',
    'opener',
    'frameElement',
    'history',
    'navigation',
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
    'SharedWorker',
    // a window's 2d context: a worker draws through an `OffscreenCanvas`'s
    'CanvasRenderingContext2D',
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
  /** A worker's script: a URL of the page's origin, which the host fetches,
   *  or a blob URL this realm made, whose script is handed over. */
  const workerScript = (
    url: Any,
    made: string,
  ): { resolved: string; source: string | null } => {
    const href = str(url);
    if (href.startsWith('blob:')) {
      const blob = blobUrls.get(href);
      if (!blob) {
        throw new DOMException(
          `Failed to construct '${made}': Script at '${href}' cannot be accessed from origin '${location.origin}'.`,
          'SecurityError',
        );
      }
      return {
        resolved: href,
        source: new TextDecoder().decode(blob._bytes),
      };
    }
    const resolved = new URL(href, location.href).href;
    if (new URL(resolved).origin !== location.origin) {
      throw new DOMException(
        `Failed to construct '${made}': Script at '${resolved}' cannot be accessed from origin '${location.origin}'.`,
        'SecurityError',
      );
    }
    return { resolved, source: null };
  };
  class Worker extends EventTarget {
    _id = 0;
    constructor(url: Any, options: Any = {}) {
      super();
      const { resolved, source } = workerScript(url, 'Worker');
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
    postMessage(message: Any, transfer?: Any): void {
      const moved = channelsTransferred(transfer);
      const later: Array<() => void> = [];
      const data = serializeClone(message, moved, {
        across: threadAcross(this._id),
        moving: transfersOf(transferListOf(transfer)),
        later,
      });
      giveUp(transfer);
      if (!this._id) return;
      // the host tells the worker of each channel before the message that
      // hands it over arrives
      for (const channel of moved) {
        dataChannelsOf.transferOut(channel, this._id);
      }
      call('workerPost', this._id, data);
      for (const go of later) go();
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

  /**
   * A shared worker (HTML 10.2.6.4): one thread for a script and a name,
   * however many `SharedWorker`s this realm makes of them, each connected
   * to it through a port of its own. A connection's messages cross the
   * thread's one channel tagged with the connection they are of, `{ c, d }`,
   * and its first is `{ c, connect }`, which the worker's global hears as a
   * `connect` event (`__workerMessage`).
   */
  const sharedThreads = new Map<string, number>();
  /** The `SharedWorker`s of each thread, which its errors are told to. */
  const sharedWorkersOf = new Map<number, Set<Any>>();
  /** Each connection's end in this realm, page or worker. */
  const sharedPorts = new Map<number, Any>();
  let connections = 0;
  /** A port whose other end is in another thread: what it posts crosses
   *  serialized, through `send`, and the ports it transfers as wires
   *  across `across`. */
  const wirePort = (send: (text: string) => void, across: Across): Any => {
    const port = new MessagePort();
    port._other = {
      _other: port,
      _closed: false,
      _deliver: (data: Any, ports: Any[] = []) => {
        const later: Array<() => void> = [];
        send(serializeClone(data, undefined, { across, moving: ports, later }));
        for (const go of later) go();
      },
    };
    return port;
  };
  class SharedWorker extends EventTarget {
    readonly port: Any;
    constructor(url: Any, options: Any = {}) {
      super();
      const named =
        typeof options === 'string' || options === undefined
          ? { name: options ?? '' }
          : (options ?? {});
      const name = str(named.name ?? '');
      const { resolved, source } = workerScript(url, 'SharedWorker');
      const key = `${resolved}\u0000${name}`;
      let id = sharedThreads.get(key);
      if (id === undefined) {
        id = Number(
          call(
            'workerStart',
            JSON.stringify({
              url: resolved,
              type: named.type === 'module' ? 'module' : 'classic',
              name,
              shared: true,
            }),
            source,
          ),
        );
        sharedThreads.set(key, id);
        sharedWorkersOf.set(id, new Set());
      }
      sharedWorkersOf.get(id)!.add(this);
      const c = ++connections;
      const thread = id;
      this.port = wirePort(
        (d) => call('workerPost', thread, JSON.stringify({ c, d })),
        threadAcross(thread),
      );
      sharedPorts.set(c, this.port);
      call('workerPost', thread, JSON.stringify({ c, connect: true }));
    }
  }
  Object.defineProperty(SharedWorker.prototype, 'onerror', {
    get(this: Any): Any {
      return this._handlers?.error ?? null;
    },
    set(this: Any, fn: Any) {
      this._handlers ??= {};
      this._handlers.error = typeof fn === 'function' ? fn : null;
    },
    configurable: true,
  });
  /** Whether this realm is a shared worker's (`__becomeWorker`). */
  let sharedRealm = false;
  /** A message on a shared worker's channel, to the port of the
   *  connection it is of, or the connection made. False where it is none. */
  const sharedMessage = (text: string, across: Across): boolean => {
    let wrapper: Any;
    try {
      wrapper = JSON.parse(text);
    } catch {
      return false;
    }
    const c = Number(wrapper?.c);
    if (!c) return false;
    if (wrapper.connect && sharedRealm) {
      const port = wirePort(
        (d) => call('workerPostOut', JSON.stringify({ c, d })),
        across,
      );
      sharedPorts.set(c, port);
      const ev = new MessageEvent('connect', {
        data: '',
        source: port,
        ports: [port],
      });
      ev.isTrusted = true;
      dispatch(windowTarget, ev);
      return true;
    }
    const port = sharedPorts.get(c);
    if (!port) return false;
    let made: Any;
    try {
      made = deserializeWith(str(wrapper.d), across);
    } catch {
      const ev = new MessageEvent('messageerror', {});
      ev.isTrusted = true;
      dispatch(port, ev);
      return true;
    }
    port._deliver(made.data, made.ports);
    return true;
  };
  // --- service workers -------------------------------------------------------------
  //
  // Service Workers 1, where the host lets a page have them (`serviceWorkers`)
  // and the page is a secure context: a registration a scope, and its worker
  // a thread of its own (`workers.ts`, `service`) whose global is a
  // `ServiceWorkerGlobalScope`. Its lifecycle is the spec's — installing
  // once its script has run, `install`, installed, `activate`, activated —
  // told back as messages of its own (`{ sw }`), and what it posts to the
  // page arrives on `navigator.serviceWorker` from it. It intercepts none
  // of the page's requests: nothing controls the page, `controller` is null.

  /** The page's registrations, by scope. */
  const swRegistrations = new Map<string, Any>();
  /** The page's service workers, by the thread each runs in. */
  const swWorkers = new Map<number, Any>();
  /** `ready`'s, kept until a registration has an active worker. */
  let swReady: { promise: Promise<Any>; resolve: (r: Any) => void } | null =
    null;
  const handlerProperty = (proto: Any, type: string): void => {
    Object.defineProperty(proto, `on${type}`, {
      get(this: Any): Any {
        return this._handlers?.[type] ?? null;
      },
      set(this: Any, fn: Any) {
        this._handlers ??= {};
        this._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
      enumerable: true,
    });
  };
  class ServiceWorker extends EventTarget {
    _id = 0;
    _url = '';
    _state = 'parsed';
    _registration: Any = null;
    /** `register()`'s promise, until the worker's script has run. */
    _settle: { resolve(r: Any): void; reject(e: Any): void } | null = null;
    get scriptURL(): string {
      return this._url;
    }
    get state(): string {
      return this._state;
    }
    postMessage(message: Any, transfer?: Any): void {
      const later: Array<() => void> = [];
      const data = serializeClone(message, undefined, {
        across: threadAcross(this._id),
        moving: transfersOf(transferListOf(transfer)),
        later,
      });
      giveUp(transfer);
      if (this._state === 'redundant') return;
      call('workerPost', this._id, data);
      for (const go of later) go();
    }
  }
  handlerProperty(ServiceWorker.prototype, 'statechange');
  handlerProperty(ServiceWorker.prototype, 'error');
  class ServiceWorkerRegistration extends EventTarget {
    _scope = '';
    _installing: Any = null;
    _waiting: Any = null;
    _active: Any = null;
    get scope(): string {
      return this._scope;
    }
    get installing(): Any {
      return this._installing;
    }
    get waiting(): Any {
      return this._waiting;
    }
    get active(): Any {
      return this._active;
    }
    get updateViaCache(): string {
      return 'imports';
    }
    get navigationPreload(): Any {
      return {
        enable: () => Promise.resolve(),
        disable: () => Promise.resolve(),
        setHeaderValue: () => Promise.resolve(),
        getState: () =>
          Promise.resolve({ enabled: false, headerValue: 'true' }),
      };
    }
    update(): Promise<Any> {
      return Promise.resolve(this);
    }
    /** Service Workers 1, "Unregister": gone from the page's, and its
     *  workers ended. */
    unregister(): Promise<boolean> {
      if (swRegistrations.get(this._scope) !== this) {
        return Promise.resolve(false);
      }
      swRegistrations.delete(this._scope);
      for (const worker of [this._installing, this._waiting, this._active]) {
        if (worker) swRedundant(worker);
      }
      return Promise.resolve(true);
    }
  }
  handlerProperty(ServiceWorkerRegistration.prototype, 'updatefound');
  /** A worker that will do nothing more: its thread ended, its state
   *  `redundant`, and it is no registration's. */
  const swRedundant = (worker: Any): void => {
    if (worker._state === 'redundant') return;
    call('workerEnd', worker._id);
    swWorkers.delete(worker._id);
    const reg = worker._registration;
    if (reg) {
      if (reg._installing === worker) reg._installing = null;
      if (reg._waiting === worker) reg._waiting = null;
      if (reg._active === worker) reg._active = null;
    }
    swState(worker, 'redundant');
  };
  const swState = (worker: Any, state: string): void => {
    worker._state = state;
    const ev = new Event('statechange');
    ev.isTrusted = true;
    dispatch(worker, ev);
  };
  /** Where a URL's path is a scope's: the longest scope it starts with. */
  const swMatch = (url: string): Any => {
    let best: Any;
    for (const [scope, reg] of swRegistrations) {
      if (
        url.startsWith(scope) &&
        (!best || scope.length > best._scope.length)
      ) {
        best = reg;
      }
    }
    return best;
  };
  class ServiceWorkerContainer extends EventTarget {
    get controller(): Any {
      return null;
    }
    get ready(): Promise<Any> {
      const active = [...swRegistrations.values()].find((r) => r._active);
      if (active) return Promise.resolve(active);
      if (!swReady) {
        let resolve!: (r: Any) => void;
        const promise = new Promise<Any>((r) => (resolve = r));
        swReady = { promise, resolve };
      }
      return swReady.promise;
    }
    /** Service Workers 1, "Start Register": the script and the scope the
     *  page's origin's, the scope under the script's directory, and a
     *  worker started for it — the promise kept once its script has run,
     *  with the registration whose `installing` it is. */
    register(url: Any, options: Any = {}): Promise<Any> {
      let script: URL;
      let scope: URL;
      try {
        script = new URL(str(url), location.href);
        scope = new URL(
          options?.scope === undefined ? './' : str(options.scope),
          options?.scope === undefined ? script.href : location.href,
        );
      } catch {
        return Promise.reject(
          new TypeError(
            "Failed to execute 'register' on 'ServiceWorkerContainer': Invalid URL",
          ),
        );
      }
      if (!/^https?:$/.test(script.protocol)) {
        return Promise.reject(
          new TypeError(
            `Failed to register a ServiceWorker: The URL protocol of the script ('${script.href}') is not supported.`,
          ),
        );
      }
      if (
        script.origin !== location.origin ||
        scope.origin !== location.origin
      ) {
        return Promise.reject(
          new DOMException(
            `Failed to register a ServiceWorker: The origin of the provided scriptURL ('${script.origin}') does not match the current origin ('${location.origin}').`,
            'SecurityError',
          ),
        );
      }
      const directory = script.pathname.replace(/[^/]*$/, '');
      if (!scope.pathname.startsWith(directory)) {
        return Promise.reject(
          new DOMException(
            `Failed to register a ServiceWorker: The path of the provided scope ('${scope.pathname}') is not under the max scope allowed ('${directory}').`,
            'SecurityError',
          ),
        );
      }
      scope.hash = '';
      const key = scope.href;
      const had = swRegistrations.get(key);
      const current = had?._active ?? had?._waiting ?? had?._installing;
      if (current && current._url === script.href) {
        return Promise.resolve(had);
      }
      const reg = had ?? new ServiceWorkerRegistration();
      reg._scope = key;
      swRegistrations.set(key, reg);
      const worker = new ServiceWorker();
      worker._url = script.href;
      worker._registration = reg;
      try {
        worker._id = Number(
          call(
            'workerStart',
            JSON.stringify({
              url: script.href,
              type: options?.type === 'module' ? 'module' : 'classic',
              name: '',
              service: { scope: key, client: location.href },
            }),
            null,
          ),
        );
      } catch (e) {
        if (!had) swRegistrations.delete(key);
        return Promise.reject(e);
      }
      swWorkers.set(worker._id, worker);
      return new Promise((resolve, reject) => {
        worker._settle = { resolve, reject };
      });
    }
    getRegistration(url: Any = ''): Promise<Any> {
      return Promise.resolve(swMatch(new URL(str(url), location.href).href));
    }
    getRegistrations(): Promise<Any[]> {
      return Promise.resolve([...swRegistrations.values()]);
    }
    startMessages(): void {}
  }
  handlerProperty(ServiceWorkerContainer.prototype, 'controllerchange');
  handlerProperty(ServiceWorkerContainer.prototype, 'message');
  handlerProperty(ServiceWorkerContainer.prototype, 'messageerror');
  const serviceWorkerContainer = new ServiceWorkerContainer();
  /**
   * What a page's service worker said: a step of its lifecycle, or a
   * message, which arrives on `navigator.serviceWorker` from it (Service
   * Workers 1, "Client.postMessage"). False where it is none of the page's.
   */
  const swHeard = (id: number, text: string): boolean => {
    const worker = swWorkers.get(id);
    if (!worker) return false;
    let wrapper: Any;
    try {
      wrapper = JSON.parse(text);
    } catch {
      return true;
    }
    const reg = worker._registration;
    if (typeof wrapper?.sw === 'string') {
      const state = wrapper.sw;
      if (state === 'failed') {
        worker._settle?.reject(
          new TypeError(
            `Failed to register a ServiceWorker for scope ('${reg._scope}') with script ('${worker._url}'): ServiceWorker script evaluation failed`,
          ),
        );
        worker._settle = null;
        if (swRegistrations.get(reg._scope) === reg && !reg._active) {
          swRegistrations.delete(reg._scope);
        }
        swRedundant(worker);
        return true;
      }
      if (state === 'installing') {
        // the one it replaces gives way
        const was = reg._installing;
        if (was && was !== worker) swRedundant(was);
        reg._installing = worker;
        worker._state = 'installing';
        const found = new Event('updatefound');
        found.isTrusted = true;
        dispatch(reg, found);
        worker._settle?.resolve(reg);
        worker._settle = null;
        return true;
      }
      if (state === 'installed') {
        if (reg._installing === worker) reg._installing = null;
        const was = reg._waiting;
        if (was && was !== worker) swRedundant(was);
        reg._waiting = worker;
      } else if (state === 'activating') {
        if (reg._waiting === worker) reg._waiting = null;
        const was = reg._active;
        if (was && was !== worker) swRedundant(was);
        reg._active = worker;
      } else if (state === 'activated' && swReady) {
        swReady.resolve(reg);
        swReady = null;
      } else if (state === 'redundant') {
        swRedundant(worker);
        return true;
      }
      swState(worker, state);
      return true;
    }
    let made: Any;
    try {
      made = deserializeWith(str(wrapper?.d), threadAcross(id));
    } catch {
      const ev = new MessageEvent('messageerror', { source: worker });
      ev.isTrusted = true;
      dispatch(serviceWorkerContainer, ev);
      return true;
    }
    const ev = new MessageEvent('message', {
      data: made.data,
      origin: location.origin,
      source: worker,
      ports: made.ports,
    });
    ev.isTrusted = true;
    dispatch(serviceWorkerContainer, ev);
    return true;
  };
  // a service worker's global (`__becomeWorker`): what it is installed and
  // messaged with, and the one client it has, the page that registered it
  /** Where this realm is a service worker's: its scope and its client's
   *  address. */
  let serviceRealm: { scope: string; client: string } | null = null;
  /** Service Workers 1, 4.4: an event a worker may keep alive with
   *  `waitUntil`, until whatever it was handed settles. */
  class ExtendableEvent extends Event {
    _waits: Promise<Any>[] = [];
    _open = true;
    waitUntil(promise: Any): void {
      if (!this.isTrusted || !this._open) {
        throw new DOMException(
          "Failed to execute 'waitUntil' on 'ExtendableEvent': The event handler is already finished.",
          'InvalidStateError',
        );
      }
      this._waits.push(Promise.resolve(promise));
    }
  }
  class ExtendableMessageEvent extends ExtendableEvent {
    _data: Any;
    _origin: string;
    _lastEventId: string;
    _source: Any;
    _ports: readonly Any[];
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this._data = init?.data ?? null;
      this._origin = str(init?.origin ?? '');
      this._lastEventId = str(init?.lastEventId ?? '');
      this._source = init?.source ?? null;
      this._ports = Object.freeze([...(init?.ports ?? [])]);
    }
    get data(): Any {
      return this._data;
    }
    get origin(): string {
      return this._origin;
    }
    get lastEventId(): string {
      return this._lastEventId;
    }
    get source(): Any {
      return this._source;
    }
    get ports(): readonly Any[] {
      return this._ports;
    }
  }
  /** Service Workers 1, 4.2: the page a worker hears from, which it posts
   *  to. */
  class Client {
    _url = '';
    _id = '';
    get url(): string {
      return this._url;
    }
    get id(): string {
      return this._id;
    }
    get type(): string {
      return 'window';
    }
    get frameType(): string {
      return 'top-level';
    }
    postMessage(message: Any, transfer?: Any): void {
      const later: Array<() => void> = [];
      const d = serializeClone(message, undefined, {
        across: UP,
        moving: transfersOf(transferListOf(transfer)),
        later,
      });
      giveUp(transfer);
      call('workerPostOut', JSON.stringify({ d }));
      for (const go of later) go();
    }
  }
  class WindowClient extends Client {
    get focused(): boolean {
      return false;
    }
    get visibilityState(): string {
      return 'visible';
    }
    focus(): Promise<Any> {
      return Promise.reject(
        new DOMException(
          'Not allowed to focus a window.',
          'InvalidAccessError',
        ),
      );
    }
    navigate(): Promise<Any> {
      return Promise.reject(
        new TypeError('Cannot navigate a client this worker does not control.'),
      );
    }
  }
  let theClient: Any = null;
  const clientOf = (): Any => {
    if (!theClient && serviceRealm) {
      theClient = new WindowClient();
      theClient._url = serviceRealm.client;
      theClient._id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
    return theClient;
  };
  /** Service Workers 1, 4.3: the worker's clients — the page, which it
   *  does not control, so only `includeUncontrolled` lists it. */
  class Clients {
    get(id: Any): Promise<Any> {
      const client = clientOf();
      return Promise.resolve(
        client && client.id === str(id) ? client : undefined,
      );
    }
    matchAll(options: Any = {}): Promise<Any[]> {
      const client = clientOf();
      return Promise.resolve(
        options?.includeUncontrolled && client ? [client] : [],
      );
    }
    openWindow(): Promise<Any> {
      return Promise.reject(
        new DOMException('Not allowed to open a window.', 'InvalidAccessError'),
      );
    }
    claim(): Promise<void> {
      return Promise.resolve();
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
  // WHATWG Streams, the standard's algorithms (`streams.ts`): readable
  // streams of chunks and of bytes, with readers that bring their own
  // buffer; writable streams that hold a writer back while their queue is
  // full; transform streams between the two. What WebTransport's send and
  // receive streams are made of, and fetch's bodies.
  const STREAMS = streams(
    () => AbortController,
    () => AbortSignal,
  );
  const streamInternals = STREAMS.internals;
  const {
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
    ReadableStreamDefaultController,
    ReadableByteStreamController,
    ReadableStreamBYOBRequest,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    TransformStream,
    TransformStreamDefaultController,
    ByteLengthQueuingStrategy,
    CountQueuingStrategy,
  } = STREAMS.classes as Record<string, Any>;

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
  //
  // Where the host keeps databases past the document (`HtmlStorage`'s
  // `indexedDB`, which `idb on` asks), the realm still holds each one it
  // opened and runs it as above, and the host is its disk: a database is
  // read from it as it is first opened, each committed transaction's
  // difference is written to it before `complete`, and one another
  // document committed to since — its stamp moved — is read again as the
  // next transaction starts, where none of this realm's is under way. So
  // two tabs see each other's commits at their next transaction, and a
  // read-modify-write across tabs is not held back as a browser holds it:
  // the later commit wins, record by record.

  /** A key's type, in the standard's order; 0 for no valid key. */
  const keyType = (key: Any, seen: Set<Any> = new Set()): number => {
    if (typeof key === 'number') return Number.isNaN(key) ? 0 : 1;
    if (key instanceof Date) return Number.isNaN(key.getTime()) ? 0 : 2;
    if (typeof key === 'string') return 3;
    if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) {
      // a buffer a transfer detached is no key (IndexedDB 3, 2.5)
      const buffer = key instanceof ArrayBuffer ? key : key.buffer;
      return (buffer as Any).detached === true ? 0 : 4;
    }
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
    /** The host's stamp for it as this realm last read or wrote it. */
    stamp?: number;
    /** Another document committed past what this realm holds. */
    stale?: boolean;
    /** Its transactions under way, which a read from the host waits for. */
    active?: number;
    /** Its schema as the host was last told it. */
    schema?: string;
  }
  const idbDatabases = new Map<string, IdbData>();

  /** Whether the host keeps databases past the document, asked once. */
  let idbKept: boolean | null = null;
  const idbPersists = (): boolean => (idbKept ??= call('idb', 'on') === true);
  /** A key as the host keeps it by: one text for one key, whatever it was
   *  given as — `-0` as `0`, a view as its bytes. */
  const keyForm = (k: Any): Any =>
    typeof k === 'number'
      ? ['n', Number.isFinite(k) ? (k === 0 ? 0 : k) : String(k)]
      : k instanceof Date
        ? ['d', k.getTime()]
        : typeof k === 'string'
          ? ['s', k]
          : Array.isArray(k)
            ? ['a', k.map(keyForm)]
            : ['b', base64OfBytes(bytesOf(k))];
  const keyOfForm = (f: Any): Any => {
    switch (f[0]) {
      case 'n':
        return typeof f[1] === 'string' ? Number(f[1]) : f[1];
      case 'd':
        return new Date(f[1]);
      case 's':
        return f[1];
      case 'a':
        return f[1].map(keyOfForm);
      default:
        return bytesOfBase64(f[1]).slice().buffer;
    }
  };
  const encodeKey = (k: Any): string => JSON.stringify(keyForm(k));
  /** A database's stores as the host keeps them, records aside. */
  const schemaOf = (data: IdbData): Any[] =>
    [...data.stores.values()].map((store) => ({
      name: store.name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      current: store.current,
      indexes: [...store.indexes.values()].map((index) => ({ ...index })),
    }));
  /** A database as the host keeps it, made this realm's, or null. */
  const idbFromHost = (name: string): IdbData | null => {
    const json = call('idb', 'load', name);
    if (typeof json !== 'string') return null;
    const snapshot = JSON.parse(json);
    const stores = new Map<string, IdbStore>();
    for (const store of snapshot.stores) {
      stores.set(store.name, {
        name: store.name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        current: store.current,
        records: [],
        indexes: new Map(store.indexes.map((i: Any) => [i.name, i])),
      });
    }
    for (const [name, key, value] of snapshot.records) {
      const store = stores.get(name);
      if (!store) continue;
      try {
        store.records.push({
          key: keyOfForm(JSON.parse(key)),
          value: deserializeClone(value),
        });
      } catch {
        // a record this realm cannot read back is left where it is
      }
    }
    for (const store of stores.values()) {
      store.records.sort((a, b) => cmpKey(a.key, b.key));
    }
    const data: IdbData = {
      name,
      version: snapshot.version,
      stores,
      connections: new Set(),
      stamp: snapshot.stamp,
      active: 0,
    };
    data.schema = JSON.stringify(schemaOf(data));
    return data;
  };
  /** A database read again from the host, where another document
   *  committed to it since this realm read it and nothing of this realm's
   *  is under way: in place, where its version is the one this realm's
   *  connections have. */
  const idbRefresh = (data: IdbData): void => {
    if (!idbPersists() || data.active) return;
    if (idbDatabases.get(data.name) !== data) return;
    try {
      if (!data.stale && call('idb', 'stamp', data.name) === data.stamp) {
        return;
      }
      const fresh = idbFromHost(data.name);
      if (!fresh) return;
      if (fresh.version === data.version) {
        data.stores = fresh.stores;
        data.stamp = fresh.stamp;
        data.schema = fresh.schema;
        data.stale = false;
      } else {
        // another document upgraded it: the connections open on this
        // one keep it, and the next to open gets the new
        idbDatabases.set(data.name, fresh);
      }
    } catch {
      // the realm's copy is what it has
    }
  };
  /** The database as `open` finds it: this realm's, read again where it
   *  is stale, or the host's where this realm has none. */
  const idbCurrent = (name: string): IdbData | undefined => {
    const data = idbDatabases.get(name);
    if (!idbPersists()) return data;
    if (data) {
      idbRefresh(data);
      return idbDatabases.get(name);
    }
    try {
      const fresh = idbFromHost(name);
      if (fresh) idbDatabases.set(name, fresh);
      return fresh ?? undefined;
    } catch {
      return undefined;
    }
  };
  /** What changed between a store's records before a transaction and
   *  after, both in key order: the records to write, and the keys gone. */
  const idbDiff = (
    store: string,
    before: { key: Any; value: Any }[],
    after: { key: Any; value: Any }[],
    put: Any[],
    gone: Any[],
  ): void => {
    let i = 0;
    let j = 0;
    const write = (record: { key: Any; value: Any }) => {
      try {
        put.push([store, encodeKey(record.key), serializeClone(record.value)]);
      } catch (error) {
        call(
          'log',
          'warn',
          `IndexedDB: a record of '${store}' is kept for this document alone: ${str((error as Any)?.message)}`,
        );
      }
    };
    while (i < before.length || j < after.length) {
      const c =
        i >= before.length
          ? 1
          : j >= after.length
            ? -1
            : cmpKey(before[i].key, after[j].key);
      if (c < 0) gone.push([store, encodeKey(before[i++].key)]);
      else if (c > 0) write(after[j++]);
      else {
        if (before[i].value !== after[j].value) write(after[j]);
        i += 1;
        j += 1;
      }
    }
  };

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
      // what another document committed since, where nothing of this
      // realm's is under way
      idbRefresh(this._data);
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
    /** The stores as they were before it, by name: what a write is undone
     *  to, and what its difference is taken against for the host. */
    _before: Map<string, IdbStore> | null = null;
    _counted = true;
    constructor(db: Any, names: string[], mode: string) {
      super();
      this._db = db;
      this._names = names;
      this.mode = mode;
      // what a write is undone to where the transaction aborts
      const data: IdbData = db._data;
      data.active = (data.active ?? 0) + 1;
      if (mode === 'versionchange') {
        const version = data.version;
        const stores = new Map(
          [...data.stores].map(([k, v]) => [k, copyStore(v)]),
        );
        this._before = stores;
        this._undo = () => {
          data.version = version;
          data.stores = new Map([...stores].map(([k, v]) => [k, copyStore(v)]));
        };
      } else if (mode === 'readwrite') {
        const kept = names.map((name) => copyStore(data.stores.get(name)!));
        this._before = new Map(kept.map((store) => [store.name, store]));
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
      this._persist();
      this._settle();
      fireAt([this], new Event('complete'));
      this._onDone?.(true);
    }
    /** No longer under way: a read of the database from the host may go
     *  ahead. */
    _settle(): void {
      if (!this._counted) return;
      this._counted = false;
      const data: IdbData = this._db._data;
      data.active = Math.max(0, (data.active ?? 1) - 1);
    }
    /** What it changed, written to the host where it keeps databases:
     *  each record written or gone, and the stores as they are now. */
    _persist(): void {
      if (this.mode === 'readonly' || !this._before || !idbPersists()) return;
      const data: IdbData = this._db._data;
      const put: Any[] = [];
      const gone: Any[] = [];
      const names =
        this.mode === 'versionchange'
          ? new Set([...this._before.keys(), ...data.stores.keys()])
          : this._names;
      for (const name of names) {
        const after = data.stores.get(name);
        // a store gone is gone with its records, as the schema says
        if (!after) continue;
        idbDiff(
          name,
          this._before.get(name)?.records ?? [],
          after.records,
          put,
          gone,
        );
      }
      const stores = schemaOf(data);
      const schema = JSON.stringify(stores);
      if (!put.length && !gone.length && schema === data.schema) return;
      try {
        const stamp = call(
          'idb',
          'commit',
          data.name,
          JSON.stringify({ version: data.version, stores, put, delete: gone }),
        );
        if (typeof stamp === 'number') {
          // another document's commit came between: read it at the next
          if (stamp !== (data.stamp ?? 0) + 1) data.stale = true;
          data.stamp = stamp;
          data.schema = schema;
        }
      } catch (error) {
        call(
          'log',
          'warn',
          `IndexedDB: '${data.name}' was not kept: ${str((error as Any)?.message)}`,
        );
      }
    }
    /** Aborted: what it wrote undone at once, and what is told of it —
     *  each request still queued failing, then the abort — a task later,
     *  as a browser queues them, so a handler set after `abort()` hears
     *  it. */
    _abort(error: Any): void {
      if (this._finished) return;
      this._finished = true;
      this._undo();
      this._settle();
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
          let data = idbCurrent(dbName);
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
              stamp: 0,
              active: 0,
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
          if (idbPersists()) {
            try {
              call('idb', 'delete', dbName);
            } catch {
              // gone from this realm, whatever the host kept
            }
          }
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
      const all = new Map<string, number>();
      if (idbPersists()) {
        try {
          for (const d of JSON.parse(str(call('idb', 'list')) || '[]')) {
            all.set(str(d.name), Number(d.version));
          }
        } catch {
          // this realm's alone
        }
      }
      for (const d of idbDatabases.values()) all.set(d.name, d.version);
      return Promise.resolve(
        [...all].map(([name, version]) => ({ name, version })),
      );
    }
    cmp(a: Any, b: Any): number {
      checkKey(a);
      checkKey(b);
      return cmpKey(a, b);
    }
  }

  /**
   * `cookieStore` (Cookie Store API): the host's jar, as `document.cookie`
   * reads it, a cookie at a time and asynchronously, in a secure context.
   * No `change` is told: nothing tells this realm of a cookie a response or
   * another tab set.
   */
  class CookieStore extends EventTarget {
    get(options?: Any): Promise<Any> {
      return this.getAll(options).then((list: Any[]) => list[0] ?? null);
    }
    getAll(options?: Any): Promise<Any> {
      return new Promise((ok, fail) => {
        let name: string | undefined;
        let url = str(document.URL);
        if (typeof options === 'string') name = options;
        else if (options !== undefined && options !== null) {
          if (options.name !== undefined) name = str(options.name);
          if (options.url !== undefined) {
            const asked = new URL(str(options.url), url).href.split('#')[0];
            if (asked !== url.split('#')[0]) {
              fail(new TypeError("The URL must be the document's own."));
              return;
            }
            url = asked;
          }
        }
        const list = call(
          'cookie',
          'list',
          url,
          name === undefined ? '' : JSON.stringify(name),
        );
        ok(JSON.parse(str(list) || '[]'));
      });
    }
    set(nameOrInit: Any, value?: Any): Promise<void> {
      return new Promise((ok, fail) => {
        const init =
          typeof nameOrInit === 'object' && nameOrInit !== null
            ? nameOrInit
            : { name: nameOrInit, value };
        const name = str(init.name ?? '');
        const v = str(init.value ?? '');
        const host = new URL(str(document.URL)).hostname;
        const domain =
          init.domain === undefined || init.domain === null
            ? null
            : str(init.domain);
        const path = init.path === undefined ? '/' : str(init.path);
        const bad = /[;\u0000-\u0008\u000a-\u001f\u007f]/;
        const why =
          bad.test(name) || bad.test(v)
            ? 'A cookie takes no control character and no semicolon.'
            : name.includes('=')
              ? "A cookie's name takes no '='."
              : !name && v.includes('=')
                ? "A cookie with no name takes no '=' in its value."
                : !name && /^__(secure|host)-/i.test(v)
                  ? 'A cookie with no name cannot look like a prefixed one.'
                  : !name && !v
                    ? 'A cookie needs a name or a value.'
                    : name.length + v.length > 4096
                      ? 'The cookie is too large.'
                      : domain !== null &&
                          (domain.startsWith('.') ||
                            (host !== domain && !host.endsWith(`.${domain}`)) ||
                            domain.length > 1024)
                        ? "The domain is not the document's."
                        : domain !== null && /^__host-/i.test(name)
                          ? 'A __Host- cookie takes no domain.'
                          : !path.startsWith('/') || path.length > 1024
                            ? "A cookie's path starts with '/'."
                            : null;
        if (why) {
          fail(new TypeError(why));
          return;
        }
        const expires =
          init.expires === undefined || init.expires === null
            ? null
            : Number(init.expires);
        const sameSite = str(init.sameSite ?? 'strict');
        if (!['strict', 'lax', 'none'].includes(sameSite)) {
          fail(new TypeError(`'${sameSite}' is not a SameSite value.`));
          return;
        }
        const stored = call(
          'cookie',
          'store',
          str(document.URL),
          JSON.stringify({ name, value: v, expires, domain, path, sameSite }),
        );
        // a deletion is done whether or not there was a cookie to delete
        if (stored === true || (expires !== null && expires <= Date.now())) {
          ok();
        } else fail(new TypeError('The cookie was not set.'));
      });
    }
    delete(options: Any): Promise<void> {
      const init =
        typeof options === 'object' && options !== null
          ? options
          : { name: options };
      return this.set({
        name: init.name,
        value: '',
        expires: 0,
        domain: init.domain ?? null,
        path: init.path ?? '/',
        sameSite: 'strict',
      });
    }
  }
  handlers(CookieStore, ['change']);

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
      // only a reason left out is the default one: `abort(null)` aborts
      // with null
      s.reason =
        reason === undefined
          ? new DOMException('signal is aborted without reason', 'AbortError')
          : reason;
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

  /** `matchMedia`: a list answered by the host from `<Html>`'s own media
   *  queries, each time `matches` is read, and told of a change by the
   *  rendering steps (`MediaQueryList`). */
  const matchMedia = (query: Any): Any => mediaListIn(ownViewport, query);

  /** `getComputedStyle`: the host's `computedStyle`, a declaration that
   *  answers by a property's name, either spelling — and a custom
   *  property's by its name alone, asked for as it is read, since a theme
   *  sets hundreds of them on the root. */
  /** The pseudo-elements `getComputedStyle` knows by a name alone,
   *  lower-cased: a `::before` and an `::after` answer their own style, a
   *  highlight's its own (`highlight(name)` too), and the rest the
   *  element's. */
  const COMPUTED_PSEUDOS = new Set([
    'before',
    'after',
    'first-line',
    'first-letter',
    'marker',
    'placeholder',
    'selection',
    'target-text',
    'spelling-error',
    'grammar-error',
    'search-text',
    'backdrop',
    'file-selector-button',
    'details-content',
    'checkmark',
    'picker-icon',
    'scroll-marker',
    'scroll-marker-group',
    'column',
    'cue',
  ]);
  /** A CSS identifier, its escapes in it. */
  const CSS_IDENT =
    /^(?:--|-?(?:[_a-zA-Z\u0080-\uffff]|\\[0-9a-fA-F]{1,6}[ \t\n]?|\\[^\n\r\f]))(?:[-_a-zA-Z0-9\u0080-\uffff]|\\[0-9a-fA-F]{1,6}[ \t\n]?|\\[^\n\r\f])*$/;
  /** An identifier's escapes made the characters they stand for. */
  const unescapeIdent = (ident: string): string =>
    ident.replace(
      /\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([^\n\r\f]))/g,
      (_m, hex: string | undefined, ch: string | undefined) => {
        if (hex === undefined) return ch!;
        const code = parseInt(hex, 16);
        return code === 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
          ? '�'
          : String.fromCodePoint(code);
      },
    );
  /** What `getComputedStyle`'s second argument names (CSSOM 9): '' for the
   *  element itself — none, or one that does not start with a colon — and
   *  the pseudo-element's name without its colons as the host takes it,
   *  a custom highlight's as `highlight(name)` with its name unescaped; or
   *  null where it parses as no pseudo-element, which answers an empty
   *  declaration. A vendor's name is the element's, as it always was. */
  const computedPseudo = (pseudo: Any): string | null => {
    if (pseudo === undefined || pseudo === null) return '';
    const s = str(pseudo);
    if (s[0] !== ':') return '';
    // CSS 2's spellings of four (CSS Pseudo 4, 8)
    const legacy = /^:(before|after|first-line|first-letter)$/i.exec(s);
    if (legacy) return legacy[1].toLowerCase();
    if (s[1] !== ':') return null;
    const rest = s.slice(2);
    if (/^view-transition/i.test(rest)) return rest;
    if (/^-?[a-zA-Z][-a-zA-Z0-9]*$/.test(rest)) {
      const name = rest.toLowerCase();
      if (COMPUTED_PSEUDOS.has(name)) return name;
      return name[0] === '-' ? name : null;
    }
    const highlight =
      /^highlight\(\s*((?:\\[0-9a-fA-F]{1,6}[ \t\n]?|\\[^\n\r\f]|[^()\s\\])+)\s*\)$/i.exec(
        rest,
      );
    if (highlight) {
      return CSS_IDENT.test(highlight[1])
        ? `highlight(${unescapeIdent(highlight[1])})`
        : null;
    }
    // the rest of the ones that take an argument are the element's, and
    // `::part()` and `::slotted()` none
    return /^(?:picker|scroll-button|cue|cue-region)\([^()]*\)$/i.test(rest)
      ? rest.toLowerCase()
      : null;
  };
  /** The empty declaration `getComputedStyle` answers where its argument
   *  names no pseudo-element: no properties, and each one the element's
   *  style has reads as '' rather than as nothing. */
  const emptyComputedStyle = (id: number): Any => {
    let known: Set<string> | null = null;
    const names = (): Set<string> => {
      if (known) return known;
      const r = call('computed', id, '');
      known = new Set();
      for (const name of Object.keys(
        typeof r === 'string' && r ? JSON.parse(r) : {},
      )) {
        known.add(name);
        known.add(camel(name));
      }
      return known;
    };
    const methods: Any = {
      getPropertyValue: () => '',
      getPropertyPriority: () => '',
      item: () => '',
      cssText: '',
      length: 0,
      [Symbol.iterator]: () => [][Symbol.iterator](),
    };
    return new Proxy(methods, {
      get(target, key) {
        if (key in target) return target[key as Any];
        return typeof key === 'string' && names().has(key) ? '' : undefined;
      },
      has(target, key) {
        return key in target || (typeof key === 'string' && names().has(key));
      },
    });
  };

  /** A computed style, which is live (CSSOM 9): read again after an op
   *  that may have changed it — a style set, a class, an element moved —
   *  or in a later task, it is asked for again (`opEpoch`, `taskEpoch`).
   *  A page that keeps one and changes the element read the old values. */
  const getComputedStyle = (el: Any, pseudo?: Any): Any => {
    const which = computedPseudo(pseudo);
    const id = idOf(el, 'element');
    let json = '';
    let values: Record<string, string> = {};
    let byName = new Map<string, string>();
    let names: string[] = [];
    let readAt = -1;
    let readIn = -1;
    // what no pseudo-element answers is an empty declaration (CSSOM 9),
    // whose every property reads as ''
    if (which === null) {
      return emptyComputedStyle(id);
    }
    const read = (): void => {
      if (readAt === opEpoch && readIn === taskEpoch) return;
      const r = call('computed', id, which);
      json = typeof r === 'string' ? r : '';
      values = json ? JSON.parse(json) : {};
      names = Object.keys(values);
      byName = new Map();
      for (const name of names) {
        byName.set(name, values[name]);
        byName.set(camel(name), values[name]);
      }
      readAt = opEpoch;
      readIn = taskEpoch;
    };
    read();
    const methods: Any = {
      getPropertyValue: (name: Any) => {
        read();
        const n = cssName(name);
        if (!n.startsWith('--')) return values[n] ?? '';
        if (!json) return '';
        return String(call('customProperty', id, which, n) ?? '');
      },
      getPropertyPriority: () => '',
      item: (i: number) => {
        read();
        return names[i] ?? '';
      },
      cssText: '',
      // its names in order, as a declaration's are
      [Symbol.iterator]: () => {
        read();
        return names.slice()[Symbol.iterator]();
      },
    };
    const own = (key: string | symbol): Any => {
      if (typeof key !== 'string') return undefined;
      if (key === 'length') return names.length;
      if (/^\d+$/.test(key)) return names[Number(key)];
      return byName.get(key);
    };
    return new Proxy(methods, {
      get(target, key) {
        if (typeof key === 'string' && !(key in target)) {
          read();
          return own(key);
        }
        return target[key as Any];
      },
      has(target, key) {
        if (key in target) return true;
        read();
        return own(key) !== undefined;
      },
      ownKeys(target) {
        read();
        return [
          ...names.map((_, i) => String(i)),
          ...byName.keys(),
          ...Reflect.ownKeys(target),
        ];
      },
      getOwnPropertyDescriptor(target, key) {
        if (key in target) return Reflect.getOwnPropertyDescriptor(target, key);
        read();
        const value = own(key);
        return value === undefined
          ? undefined
          : { value, writable: false, enumerable: true, configurable: true };
      },
    });
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

  /** Observers a page makes at its start: `IntersectionObserver`, and
   *  `ResizeObserver` each size its targets come to. `MutationObserver` is
   *  below. */
  /** What an `IntersectionObserver` hands its callback (Intersection
   *  Observer, 2.3), or a page makes of a dictionary. A page tells the
   *  native interface from none by this one: Next.js installs the W3C
   *  polyfill where it is missing, and the polyfill measures every target
   *  again at every mutation of the document, a whole layout a time —
   *  react.dev's tutorial ran it without end. */
  class IntersectionObserverEntry {
    _init: Any;
    constructor(init: Any) {
      if (!init || typeof init !== 'object') {
        throw new TypeError(
          "Failed to construct 'IntersectionObserverEntry': 1 argument required, but only 0 present.",
        );
      }
      const rect = (r: Any) =>
        r instanceof DOMRectReadOnly ? r : DOMRectReadOnly.fromRect(r);
      this._init = {
        time: Number(init.time) || 0,
        rootBounds: init.rootBounds == null ? null : rect(init.rootBounds),
        boundingClientRect: rect(init.boundingClientRect),
        intersectionRect: rect(init.intersectionRect),
        isIntersecting: !!init.isIntersecting,
        isVisible: !!init.isVisible,
        intersectionRatio: Number(init.intersectionRatio) || 0,
        target: init.target,
      };
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
    'isVisible',
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

  /** The observers observing something, in the order each began to, which
   *  each frame measures (`updateIntersections`). */
  const intersecting = new Set<Any>();
  /** The observers with entries for the task that hands them over, in the
   *  order they were queued (Intersection Observer, 3.2.5). */
  const intersectionsOwed = new Set<Any>();
  /** Whether the host was asked what the observers measure, which it asks
   *  again after each paint until a frame with none tells it to stop. */
  let intersectionsAsked = false;

  /** A root or a scroll margin (Intersection Observer, 3.2.1, "parse a
   *  margin"): one to four lengths, as `margin` takes them, each pixels or
   *  a percentage, as Chrome takes them — top, right, bottom and left, as
   *  they serialize. */
  const parseMargin = (given: Any, what: string): string[] => {
    const tokens = str(given).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) tokens.push('0px');
    const lengths = tokens.map((t) => {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|%)$/i.exec(t);
      if (!m || tokens.length > 4) {
        throw new DOMException(
          `Failed to construct 'IntersectionObserver': ${what} must be specified in pixels or percent.`,
          'SyntaxError',
        );
      }
      return `${Number(m[1]) + 0}${m[2] === '%' ? '%' : 'px'}`;
    });
    const [t, r = t, b = t, l = r] = lengths;
    return [t, r, b, l];
  };
  /** A margin's length on a side of a rectangle that long. */
  const marginOn = (length: string, of: number): number =>
    length.endsWith('%') ? (parseFloat(length) / 100) * of : parseFloat(length);

  /**
   * An observer of where its targets are in its root (Intersection Observer
   * 2.2): the viewport, a document's or an element's that holds them. Each
   * frame measures them (`updateIntersections`), and a target is reported
   * where how much of it shows crossed one of the thresholds since it was
   * last, or it came into the root or left it — first as it is observed —
   * every target of an observer in one callback, a task after the frame
   * (3.2.8). A sticky header's script asks for `rootMargin: "-1px 0px 0px
   * 0px"` and a threshold of 1 to hear that it is stuck: it reported every
   * target once, whole, and the header's glass never came.
   */
  class IntersectionObserver {
    _fn: Any;
    _root: Any;
    _rootMargin: string[];
    _scrollMargin: string[];
    _thresholds: readonly number[];
    _delay: number;
    _trackVisibility: boolean;
    /** What it observes, in the order observed, and of each the threshold
     *  it was last past and whether it was in the root — -1 and false
     *  before it is first measured (3.1, the registration's
     *  `previousThresholdIndex` and `previousIsIntersecting`). */
    _targets = new Map<Any, { index: number; intersecting: boolean }>();
    /** What it has yet to hand its callback. */
    _queued: Any[] = [];
    constructor(fn: Any, options: Any = {}) {
      if (typeof fn !== 'function') {
        throw new TypeError(
          "Failed to construct 'IntersectionObserver': parameter 1 is not of type 'Function'.",
        );
      }
      this._fn = fn;
      const o = options ?? {};
      const root = o.root ?? null;
      if (
        root !== null &&
        !(root instanceof Element || root instanceof Document)
      ) {
        throw new TypeError(
          "Failed to construct 'IntersectionObserver': Failed to read the 'root' property from 'IntersectionObserverInit': The provided value is not of type '(Document or Element)'.",
        );
      }
      this._root = root;
      this._rootMargin = parseMargin(o.rootMargin ?? '0px', 'rootMargin');
      this._scrollMargin = parseMargin(o.scrollMargin ?? '0px', 'scrollMargin');
      const given = o.threshold ?? 0;
      const list =
        typeof given === 'object' &&
        typeof given[Symbol.iterator] === 'function'
          ? [...given]
          : [given];
      const thresholds = list.map((t: Any) => {
        const v = Number(t);
        if (!Number.isFinite(v)) {
          throw new TypeError(
            "Failed to construct 'IntersectionObserver': The provided double value is non-finite.",
          );
        }
        if (v < 0 || v > 1) {
          throw new RangeError(
            "Failed to construct 'IntersectionObserver': Threshold values must be numbers between 0 and 1",
          );
        }
        return v;
      });
      thresholds.sort((a: number, b: number) => a - b);
      this._thresholds = Object.freeze(thresholds.length ? thresholds : [0]);
      this._delay = Math.max(0, Number(o.delay) || 0);
      this._trackVisibility = !!o.trackVisibility;
      if (this._trackVisibility && this._delay < 100) {
        throw new DOMException(
          "Failed to construct 'IntersectionObserver': To enable the 'trackVisibility' option, you must also use a 'delay' option with a value of at least 100.",
          'NotSupportedError',
        );
      }
    }
    get root(): Any {
      return this._root;
    }
    get rootMargin(): string {
      return this._rootMargin.join(' ');
    }
    get scrollMargin(): string {
      return this._scrollMargin.join(' ');
    }
    get thresholds(): readonly number[] {
      return this._thresholds;
    }
    get delay(): number {
      return this._delay;
    }
    get trackVisibility(): boolean {
      return this._trackVisibility;
    }
    observe(target: Any): void {
      if (!(target instanceof Element)) {
        throw new TypeError(
          "Failed to execute 'observe' on 'IntersectionObserver': parameter 1 is not of type 'Element'.",
        );
      }
      if (this._targets.has(target)) return;
      this._targets.set(target, { index: -1, intersecting: false });
      intersecting.add(this);
      wantFrame();
    }
    unobserve(target: Any): void {
      if (!(target instanceof Element)) {
        throw new TypeError(
          "Failed to execute 'unobserve' on 'IntersectionObserver': parameter 1 is not of type 'Element'.",
        );
      }
      this._targets.delete(target);
      if (!this._targets.size) intersecting.delete(this);
    }
    disconnect(): void {
      this._targets.clear();
      intersecting.delete(this);
    }
    takeRecords(): Any[] {
      const entries = this._queued;
      this._queued = [];
      return entries;
    }
    /**
     * Its targets as the host measured them (`intersections`), and each
     * one reported where it crossed a threshold or the root's edge (3.2.8,
     * "run the update intersection observations steps"). `line` is the
     * root's rectangle, '' for the viewport's, then each target's: its
     * bounding box and the part the boxes around it leave to be seen, in
     * the document's coordinates, or '' for no box in the root.
     */
    _measure(line: string, v: Any, time: number): void {
      const parts = line.split(';');
      const rootLine = parts[0] ?? '';
      // the root intersection rectangle in the viewport's coordinates,
      // grown by the margin, for the viewport or a document as its root
      let rx = 0;
      let ry = 0;
      let rw = v.width;
      let rh = v.height;
      if (this._root instanceof Element) {
        const r = rootLine ? rootLine.split(',').map(Number) : [0, 0, 0, 0];
        rx = r[0] - v.scrollX;
        ry = r[1] - v.scrollY;
        rw = r[2];
        rh = r[3];
      }
      const [mt, mr, mb, ml] = this._rootMargin;
      const top = marginOn(mt, rh);
      const left = marginOn(ml, rw);
      rx -= left;
      ry -= top;
      rw += left + marginOn(mr, rw);
      rh += top + marginOn(mb, rh);
      const rootBounds = new DOMRectReadOnly(rx, ry, rw, rh);
      let i = 1;
      for (const [target, was] of this._targets) {
        const n = (parts[i++] ?? '').split(',').filter(Boolean).map(Number);
        let box = new DOMRectReadOnly();
        let shown = new DOMRectReadOnly();
        let isIntersecting = false;
        let index = 0;
        let ratio = 0;
        if (n.length >= 4) {
          box = new DOMRectReadOnly(
            n[0] - v.scrollX,
            n[1] - v.scrollY,
            n[2],
            n[3],
          );
          if (n.length >= 8) {
            // what the boxes around it leave to be seen, in the root's
            // rectangle, an edge that only meets it counting (3.2.8)
            const x0 = Math.max(n[4] - v.scrollX, rx);
            const y0 = Math.max(n[5] - v.scrollY, ry);
            const x1 = Math.min(n[4] - v.scrollX + n[6], rx + rw);
            const y1 = Math.min(n[5] - v.scrollY + n[7], ry + rh);
            if (x0 <= x1 && y0 <= y1) {
              isIntersecting = true;
              shown = new DOMRectReadOnly(x0, y0, x1 - x0, y1 - y0);
            }
          }
          const area = n[2] * n[3];
          ratio =
            area > 0
              ? Math.min(1, (shown.width * shown.height) / area)
              : isIntersecting
                ? 1
                : 0;
          const thresholds = this._thresholds;
          index = thresholds.findIndex((t) => t > ratio);
          if (index < 0) index = thresholds.length;
        }
        if (index === was.index && isIntersecting === was.intersecting) {
          continue;
        }
        was.index = index;
        was.intersecting = isIntersecting;
        this._queued.push(
          new IntersectionObserverEntry({
            time,
            rootBounds,
            boundingClientRect: box,
            intersectionRect: shown,
            isIntersecting,
            // nothing here tells what covers a target, so one in its root
            // is taken for seen (Intersection Observer 2, 3.2.8)
            isVisible: this._trackVisibility && isIntersecting,
            intersectionRatio: ratio,
            target,
          }),
        );
        intersectionsOwed.add(this);
      }
    }
  }
  idlAttributes(IntersectionObserver);
  /**
   * The intersection observers' steps for the frame (HTML 8.1.7.3, "run the
   * update intersection observations steps"): every observer's targets
   * measured by the host at once, and the task that hands the observers
   * their entries queued where any has one (Intersection Observer, 3.2.5).
   * The host asks the same again after each paint and wakes a frame where
   * the answer moved (`DomHost.renderingMoved`).
   */
  const updateIntersections = (time: number): void => {
    if (!intersecting.size) {
      if (intersectionsAsked) {
        intersectionsAsked = false;
        call('intersections', '');
      }
      return;
    }
    const observers = [...intersecting];
    const query = JSON.stringify(
      observers.map((o) => [
        o._root instanceof Element ? o._root._id : 0,
        o.scrollMargin,
        [...o._targets.keys()].map((t: Any) => t._id),
      ]),
    );
    intersectionsAsked = true;
    const lines = String(call('intersections', query)).split('\n');
    const v = viewport();
    observers.forEach((o, i) => o._measure(lines[i] ?? '', v, time));
    if (!intersectionsOwed.size) return;
    setTimer(
      () => {
        const owed = [...intersectionsOwed];
        intersectionsOwed.clear();
        for (const observer of owed) {
          const entries = observer.takeRecords();
          if (!entries.length) continue;
          try {
            observer._fn.call(observer, entries, observer);
          } catch (e) {
            report(e);
          }
        }
      },
      0,
      [],
      false,
    );
  };
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
  // The platform the user agent names, as a browser's own two always agree:
  // a page that reads one and then the other is told of one machine.
  // Chrome's strings, and Linux's where the agent names none of them.
  const device = /\b(iPhone|iPad|iPod)\b/.exec(userAgent);
  const platform = device
    ? device[1]
    : /Android/.test(userAgent)
      ? 'Linux armv8l'
      : /Macintosh|Mac OS X/.test(userAgent)
        ? 'MacIntel'
        : /Windows/.test(userAgent)
          ? 'Win32'
          : 'Linux x86_64';
  const navigator = {
    userAgent,
    appName: 'Netscape',
    appVersion: userAgent.replace(/^Mozilla\//, ''),
    platform,
    vendor: '',
    language,
    languages: [language],
    onLine: true,
    get cookieEnabled(): boolean {
      return call('cookie', 'enabled') === true;
    },
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
    userActivation: new UserActivation(ACTIVATION_KEY),
  };
  // a page's service workers, where the host lets it have them and it is a
  // secure context; left out otherwise, as `clipboard` is
  const serviceWorkersOn =
    location.protocol === 'https:' && call('serviceWorkers') === true;
  if (serviceWorkersOn) {
    Object.defineProperty(navigator, 'serviceWorker', {
      get: () => serviceWorkerContainer,
      enumerable: true,
      configurable: true,
    });
  }

  // --- session history and the Navigation API (HTML 7.4 and 7.2.6) ------------
  //
  // Each window keeps a session history of its own — the page's, and each
  // frame's whose window is built here: the entries its same-document
  // navigations make — `pushState`, `replaceState`, a fragment, a
  // navigation a `navigate` listener intercepts — each with its states and
  // its key, and the one it is at. Traversing among them is the window's,
  // with its `popstate` and its `hashchange`; past them, and to another
  // document, is the host's, as it was. `navigation` is the API over the
  // same entries. What the host is told is what it was told before: a
  // fragment as a navigation, and the address the document is at.

  interface SessionEntry {
    url: string;
    key: string;
    id: string;
    /** `history.state`, serialized (`serializeClone`), or null. */
    state: string | null;
    /** The Navigation API's state, serialized, or undefined for none. */
    navState: string | undefined;
    /** Its `NavigationHistoryEntry`, made once it is asked for. */
    api: Any;
    /** `history.state` read back, once. */
    read?: { value: Any };
    /** Where the document was scrolled to as it left the entry (HTML
     *  7.4.1, "scroll position data"), which going back to it restores. */
    scroll?: [number, number];
    /** An entry of another document's, which the host's session holds
     *  beside this document's (`HtmlSessionHistory`): going to it is
     *  going to that document. */
    other?: boolean;
    /** Its URL's origin, worked out once. */
    origin?: string;
  }
  /** What a window's session history stands on. */
  interface SessionContext {
    url(): string;
    /** What a URL a page gives it is resolved against. */
    base(): string;
    /** Whether the document has loaded, before which a navigation
     *  replaces its entry. */
    loaded(): boolean;
    /** The document's address, changed with no navigation. */
    setUrl(url: string): void;
    doc(): Any;
    /** Where `popstate` and `hashchange` are told: the window. */
    target: Any;
    /** A navigation to another document, the host's. */
    away(url: string, replace: boolean): void;
    /** Whether the host hears of a fragment navigation too: the page's
     *  does, which a browser keeps an entry of its own for and scrolls. */
    tellsFragments: boolean;
    /** A reload, with the Navigation API state its entry is to have where
     *  `navigation.reload({ state })` gave one. */
    reload(navState?: string): void;
    go(delta: number): void;
    /** Where the session is the host's, across documents: a navigation to
     *  another document planned (`sessionPlan`), which the next document
     *  shown takes; a step to an entry of another document's, once it is
     *  planned and its document asked; and what the session holds now,
     *  written as it changes (`sessionWrite`). */
    plan?(plan: { type: string; key?: string; navState?: string }): void;
    traverseAway?(delta: number): void;
    changed?(s: Session): void;
    /** Where the document is scrolled to, and a scroll of it. */
    scroll(): [number, number];
    scrollTo(x: number, y: number): void;
    /** HTML 7.2.6.1, "has entries and events disabled": a document that is
     *  its frame's initial `about:blank`, or of an opaque origin, has no
     *  entries and tells no navigation of its. Absent, false. */
    disabled?(): boolean;
    /** The document the session is of, whose unload counter a method
     *  reads, and where it is a frame's, whether it is still fully active
     *  (HTML 7.3.3): in the document, and not left for another. */
    owner(): Any;
    active(): boolean;
  }
  /** A navigation an API method started, and the two promises it hands
   *  back (HTML 7.2.6.10, "navigation API method tracker"). */
  interface Tracker {
    committed: Any;
    finished: Any;
    aborted: boolean;
    commit(entry: Any): void;
    finish(entry: Any): void;
    fail(error: Any): void;
  }
  interface Session {
    ctx: SessionContext;
    entries: SessionEntry[];
    index: number;
    /** The navigation whose `navigate` event is running now, which the
     *  next one aborts (HTML 7.2.6.10, "ongoing navigation"). */
    ongoing: {
      controller: Any;
      tracker: Tracker | null;
      event: Any;
      /** What settles `navigation.transition`'s promises, where the
       *  navigation made one: the method's tracker, or one of its own. */
      transition: Tracker | null;
    } | null;
    transition: Any;
    activation: Any;
    navigation: Any;
    /** `history.scrollRestoration`: whether a traversal restores where the
     *  entry it goes to was scrolled to. */
    restoration: 'auto' | 'manual';
    /** Whether the entries are the host's session's, the documents' before
     *  and after this one among them (`HtmlSessionHistory`), rather than
     *  this document's alone. */
    host: boolean;
    /** How the document came to be shown, where the session is the
     *  host's: what `navigation.activation` says. */
    arrived: {
      type: string;
      fromIndex: number;
      from: SessionEntry | null;
    } | null;
  }
  const sessionEntry = (url: string, key?: string): SessionEntry => ({
    url,
    key: key ?? crypto.randomUUID(),
    id: crypto.randomUUID(),
    state: null,
    navState: undefined,
    api: null,
  });
  const currentOf = (s: Session): SessionEntry => s.entries[s.index];

  /** An entry's origin, as the entries the API shows are told apart by. */
  const entryOrigin = (entry: SessionEntry): string => {
    if (entry.origin === undefined) {
      try {
        entry.origin = new URL(entry.url).origin;
      } catch {
        entry.origin = 'null';
      }
    }
    return entry.origin;
  };
  /**
   * The entries the Navigation API shows (HTML, "getting session history
   * entries for the navigation API"): the run around the current
   * one whose documents are of its origin. A document's own are all of
   * them where the session is its own, and where it is the host's, the
   * documents before and after it of its origin, up to one that is not.
   */
  const navEntriesOf = (s: Session): SessionEntry[] => {
    if (!s.host) return s.entries;
    const origin = entryOrigin(currentOf(s));
    let lo = s.index;
    let hi = s.index;
    while (lo > 0 && entryOrigin(s.entries[lo - 1]) === origin) lo -= 1;
    while (
      hi < s.entries.length - 1 &&
      entryOrigin(s.entries[hi + 1]) === origin
    ) {
      hi += 1;
    }
    return s.entries.slice(lo, hi + 1);
  };
  /** The session changed: the host's is told what it holds now, where it
   *  is the host's. */
  const persist = (s: Session): void => {
    if (s.host) s.ctx.changed?.(s);
  };
  /** A navigation to another document, where the session is the host's:
   *  where this document was scrolled to is its entry's, and the next
   *  document shown takes the plan (`HtmlSessionHistory`). */
  const planAway = (
    s: Session,
    plan: { type: string; key?: string; navState?: string },
  ): void => {
    if (!s.host) return;
    currentOf(s).scroll = s.ctx.scroll();
    persist(s);
    s.ctx.plan?.(plan);
  };

  /** Whether a URL is a fragment of the document's (HTML 7.4.2.3.3): the
   *  same but for a fragment it has. */
  const fragmentOf = (from: string, to: string): boolean =>
    to.includes('#') && to.split('#')[0] === from.split('#')[0];
  const hashOf = (url: string): string => {
    const at = url.indexOf('#');
    return at < 0 ? '' : url.slice(at);
  };
  /** Whether the document's URL may become `to` without a navigation
   *  (HTML 7.4.4, "can have its URL rewritten"): the same origin, and for
   *  a URL with no origin the same but for its query and fragment. */
  const rewritable = (from: string, to: string): boolean => {
    let a: Any;
    let b: Any;
    try {
      a = new URL(from);
      b = new URL(to);
    } catch {
      return false;
    }
    if (a.origin !== b.origin) return false;
    if (a.origin !== 'null') return true;
    return from.split(/[?#]/)[0] === to.split(/[?#]/)[0];
  };

  /** What a navigation API method is refused with where its document is
   *  not fully active, or is being unloaded (HTML 7.2.6.4, "navigate()"
   *  and its kin): null where it may go on. */
  const unloadingRefusal = (s: Session, method: string): Any =>
    !s.ctx.active() || s.ctx.owner()._unloadCounter > 0
      ? new DOMException(
          `Failed to execute '${method}' on 'Navigation': The document is not fully active, or is being unloaded.`,
          'InvalidStateError',
        )
      : null;

  const makeTracker = (): Tracker => {
    let commit: Any;
    let failCommit: Any;
    let finish: Any;
    let failFinish: Any;
    const committed = new Promise((ok, no) => {
      commit = ok;
      failCommit = no;
    });
    const finished = new Promise((ok, no) => {
      finish = ok;
      failFinish = no;
    });
    // a page that awaits neither is told of no rejection
    committed.catch(() => {});
    finished.catch(() => {});
    let settled = false;
    const tracker: Tracker = {
      committed,
      finished,
      aborted: false,
      commit: (entry) => commit(entry),
      finish: (entry) => {
        if (settled) return;
        settled = true;
        finish(entry);
      },
      fail: (error) => {
        if (settled) return;
        settled = true;
        tracker.aborted = true;
        failCommit(error);
        failFinish(error);
      },
    };
    return tracker;
  };
  const resultOf = (tracker: Tracker): Any => ({
    committed: tracker.committed,
    finished: tracker.finished,
  });
  /** An API method's result where it fails before it starts: both
   *  promises rejected with the error. */
  const earlyError = (error: Any): Any => {
    const tracker = makeTracker();
    tracker.fail(error);
    return resultOf(tracker);
  };
  const asTrusted = <T>(event: T): T => {
    (event as Any).isTrusted = true;
    return event;
  };

  const TOKEN = Symbol('navigation');
  class NavigationHistoryEntry extends EventTarget {
    declare _entry: SessionEntry;
    declare _session: Session;
    /** One of no list: an activation's entry of a document that is not
     *  among the entries (`looseEntryOf`), whose key and id it has. */
    declare _loose: boolean;
    constructor(token?: Any, entry?: SessionEntry, session?: Session) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
      super();
      // what it stands for is no property a page enumerates: an entry a
      // page hands `JSON.stringify` — as WPT's remote contexts hand back
      // what a script ended on — is its accessors' alone, and its entry
      // holds it in turn
      for (const [name, value] of [
        ['_entry', entry],
        ['_session', session],
        ['_loose', false],
      ] as const) {
        Object.defineProperty(this, name, { value, writable: true });
      }
    }
    get url(): string | null {
      return this._entry.url;
    }
    get key(): string {
      return this.index < 0 && !this._loose ? '' : this._entry.key;
    }
    get id(): string {
      return this.index < 0 && !this._loose ? '' : this._entry.id;
    }
    get index(): number {
      return navEntriesOf(this._session).indexOf(this._entry);
    }
    get sameDocument(): boolean {
      return !this._entry.other && this.index >= 0;
    }
    getState(): Any {
      const state = this._entry.navState;
      return state === undefined ? undefined : deserializeClone(state);
    }
  }
  const apiEntryOf = (s: Session, entry: SessionEntry): Any =>
    (entry.api ??= new NavigationHistoryEntry(TOKEN, entry, s));
  /** An entry of no list, for an activation's (`_loose`): one a replace
   *  took the place of, one a navigation is about to make. */
  const looseEntryOf = (s: Session, entry: SessionEntry): Any => {
    const made = new NavigationHistoryEntry(TOKEN, entry, s);
    made._loose = true;
    return made;
  };

  class NavigationDestination {
    readonly url: string;
    readonly key: string;
    readonly id: string;
    readonly index: number;
    readonly sameDocument: boolean;
    _state: string | undefined;
    constructor(
      token: Any,
      url: string,
      index: number,
      entry: SessionEntry | null,
      sameDocument: boolean,
      state: string | undefined,
    ) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
      this.url = url;
      this.key = entry?.key ?? '';
      this.id = entry?.id ?? '';
      this.index = index;
      this.sameDocument = sameDocument;
      this._state = state;
    }
    getState(): Any {
      return this._state === undefined
        ? undefined
        : deserializeClone(this._state);
    }
  }

  class NavigateEvent extends Event {
    readonly navigationType: string;
    readonly destination: Any;
    readonly canIntercept: boolean;
    readonly userInitiated: boolean;
    readonly hashChange: boolean;
    readonly signal: Any;
    readonly formData: Any;
    readonly downloadRequest: string | null;
    readonly info: Any;
    readonly hasUAVisualTransition: boolean;
    readonly sourceElement: Any;
    _intercepts: Any[] = [];
    _precommits: Any[] = [];
    _intercepted = false;
    _dispatching = false;
    /** `intercept()`'s `scroll`: after the handlers, or the page's. */
    _scrollBehavior: 'after-transition' | 'manual' = 'after-transition';
    /** Where the navigation is (HTML 7.2.6.9, "interception state"): what
     *  `scroll()` may do, and whether the end scrolls. */
    _state: 'none' | 'committed' | 'scrolled' | 'finished' = 'none';
    /** What a scroll restores or scrolls to, once committed. */
    _scroller: (() => void) | null = null;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      if (
        !init ||
        init.destination === undefined ||
        init.signal === undefined
      ) {
        throw new TypeError(
          "Failed to construct 'NavigateEvent': required member destination or signal is undefined.",
        );
      }
      this.navigationType = str(init.navigationType ?? 'push');
      this.destination = init.destination;
      this.canIntercept = !!init.canIntercept;
      this.userInitiated = !!init.userInitiated;
      this.hashChange = !!init.hashChange;
      this.signal = init.signal;
      this.formData = init.formData ?? null;
      this.downloadRequest = init.downloadRequest ?? null;
      this.info = init.info;
      this.hasUAVisualTransition = !!init.hasUAVisualTransition;
      this.sourceElement = init.sourceElement ?? null;
    }
    /** HTML 7.2.6.9, `intercept()`: the navigation is the page's, done by
     *  its handler, in the document it is in. */
    intercept(options: Any = {}): void {
      const fail = (message: string, name: string): never => {
        throw new DOMException(
          `Failed to execute 'intercept' on 'NavigateEvent': ${message}`,
          name,
        );
      };
      if (!this.isTrusted) fail('The event is not trusted.', 'SecurityError');
      if (!this._dispatching) {
        fail('The event is not being dispatched.', 'InvalidStateError');
      }
      if (!this.canIntercept) {
        fail('The navigation cannot be intercepted.', 'SecurityError');
      }
      if (this._canceled) fail('The event was canceled.', 'InvalidStateError');
      if (options?.handler !== undefined) {
        if (typeof options.handler !== 'function') {
          throw new TypeError(
            "Failed to execute 'intercept' on 'NavigateEvent': handler is not a function.",
          );
        }
        this._intercepts.push(options.handler);
      }
      if (options?.precommitHandler !== undefined) {
        if (typeof options.precommitHandler !== 'function') {
          throw new TypeError(
            "Failed to execute 'intercept' on 'NavigateEvent': precommitHandler is not a function.",
          );
        }
        if (!this.cancelable) {
          fail(
            'A precommit handler needs a navigation that can be canceled.',
            'InvalidStateError',
          );
        }
        this._precommits.push(options.precommitHandler);
      }
      if (
        options?.scroll === 'manual' ||
        options?.scroll === 'after-transition'
      ) {
        this._scrollBehavior = options.scroll;
      }
      this._intercepted = true;
    }
    /** HTML 7.2.6.9, `scroll()`: what the end of an intercepted navigation
     *  would have scrolled, now, once it has committed and before it has
     *  scrolled. */
    scroll(): void {
      if (this._state !== 'committed' || !this._scroller) {
        throw new DOMException(
          "Failed to execute 'scroll' on 'NavigateEvent': The navigation has not committed, or was scrolled already.",
          'InvalidStateError',
        );
      }
      this._state = 'scrolled';
      this._scroller();
    }
  }

  class NavigationCurrentEntryChangeEvent extends Event {
    readonly navigationType: string | null;
    readonly from: Any;
    constructor(type: string, init: Any = {}) {
      super(type, init);
      if (!init || init.from === undefined) {
        throw new TypeError(
          "Failed to construct 'NavigationCurrentEntryChangeEvent': required member from is undefined.",
        );
      }
      this.navigationType = init.navigationType ?? null;
      this.from = init.from;
    }
  }

  class NavigationTransition {
    _type: string;
    _from: Any;
    _tracker: Tracker;
    constructor(token: Any, type: string, from: Any, tracker: Tracker) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
      this._type = type;
      this._from = from;
      this._tracker = tracker;
    }
    get navigationType(): string {
      return this._type;
    }
    get from(): Any {
      return this._from;
    }
    get committed(): Any {
      return this._tracker.committed;
    }
    get finished(): Any {
      return this._tracker.finished;
    }
  }

  class NavigationActivation {
    readonly from: Any;
    readonly entry: Any;
    readonly navigationType: string;
    constructor(token: Any, entry: Any, from: Any = null, type = 'push') {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
      this.from = from;
      this.entry = entry;
      this.navigationType = type;
    }
  }
  /**
   * How a document came to be shown (HTML, "update document for history
   * step application"): its current entry, how it got there, and
   * the entry it came from where that one is among the entries the API
   * shows — or, where a replace took its place, one of the same origin
   * standing for it. A document whose session is its own is a push from
   * nowhere.
   */
  const activationOf = (s: Session): Any => {
    const entry = apiEntryOf(s, currentOf(s));
    const arrived = s.arrived;
    if (!arrived) return new NavigationActivation(TOKEN, entry);
    let from: Any = null;
    const before = arrived.fromIndex >= 0 ? s.entries[arrived.fromIndex] : null;
    if (before && navEntriesOf(s).includes(before)) {
      from = apiEntryOf(s, before);
    } else if (
      arrived.type === 'replace' &&
      arrived.from &&
      entryOrigin(arrived.from) === entryOrigin(currentOf(s)) &&
      !/^about:blank(?:[?#]|$)/i.test(arrived.from.url)
    ) {
      from = looseEntryOf(s, arrived.from);
    }
    return new NavigationActivation(TOKEN, entry, from, arrived.type);
  };

  /** End a session's ongoing navigation as aborted: its signal,
   *  `navigateerror`, and its promises rejected. */
  const abortOngoing = (s: Session, error?: Any): void => {
    const running = s.ongoing;
    if (!running) return;
    s.ongoing = null;
    const reason =
      error ?? new DOMException('The navigation was aborted.', 'AbortError');
    running.controller.abort(reason);
    // `navigateerror` while the transition is still the navigation's, then
    // its promises, then the method's (HTML 7.2.6.10)
    // told as an uncaught error is, with where it was thrown
    dispatch(
      s.navigation,
      asTrusted(new ErrorEvent('navigateerror', errorInit(reason))),
    );
    if (running.transition && running.transition !== running.tracker) {
      running.transition.fail(reason);
    }
    if (running.transition) s.transition = null;
    running.tracker?.fail(reason);
  };

  interface NavigateParams {
    url: string;
    type: 'push' | 'replace' | 'reload' | 'traverse';
    /** The entry a traversal goes to. */
    target?: SessionEntry;
    navState?: string;
    info?: Any;
    tracker?: Tracker | null;
    sameDocument: boolean;
    /** A user's: a click's, rather than a script's. */
    userInitiated?: boolean;
    /** The link or the form that started it. */
    sourceElement?: Any;
    /** `pushState` or `replaceState`'s, which no `hashChange` is. */
    historyApi?: boolean;
    /** A POST form submission's entry list (`NavigateEvent.formData`). */
    formData?: Any;
  }

  /**
   * Fire `navigate` for a navigation and, where it goes on in the document,
   * do it (HTML 7.2.6.10, "inner navigate event firing algorithm"): an
   * intercepted one by its handlers, a same-document one by `apply`. What
   * came of it: done in the document, canceled, or to another document,
   * which the caller hands to the host.
   */
  const navigateWith = (
    s: Session,
    params: NavigateParams,
    /** Told whether a handler of the page's has it, which then scrolls
     *  where it ends, not where it commits. */
    apply: (intercepted: boolean) => void,
  ): 'same' | 'canceled' | 'other' => {
    // a document whose navigations go untold: done, with no event, and
    // nothing settled of what a method handed back
    if (s.ctx.disabled?.()) {
      if (!params.sameDocument) return 'other';
      apply(false);
      return 'same';
    }
    abortOngoing(s);
    // a `navigateerror` listener may start a navigation of its own, which
    // this one aborts in turn before it goes on; bounded, since each may
    // start another
    for (let i = 0; s.ongoing && i < 16; i += 1) abortOngoing(s);
    const from = currentOf(s);
    const fromApi = apiEntryOf(s, from);
    const controller = new AbortController();
    const destination = new NavigationDestination(
      TOKEN,
      params.url,
      params.target ? navEntriesOf(s).indexOf(params.target) : -1,
      params.target ?? null,
      params.sameDocument,
      params.navState ?? params.target?.navState,
    );
    const canIntercept =
      rewritable(from.url, params.url) &&
      (params.type !== 'traverse' || params.sameDocument);
    const event = asTrusted(
      new NavigateEvent('navigate', {
        cancelable: params.type !== 'traverse' || params.sameDocument,
        navigationType: params.type,
        destination,
        canIntercept,
        // a navigation to a fragment, not a URL the history API writes,
        // whatever of it differs (HTML 7.2.6.10)
        hashChange:
          !params.historyApi &&
          params.type !== 'traverse' &&
          params.sameDocument &&
          fragmentOf(from.url, params.url) &&
          hashOf(from.url) !== hashOf(params.url),
        signal: controller.signal,
        info: params.info,
        userInitiated: !!params.userInitiated,
        sourceElement: params.sourceElement ?? null,
        formData: params.formData ?? null,
      }),
    );
    const tracker = params.tracker ?? null;
    s.ongoing = { controller, tracker, event, transition: null };
    event._dispatching = true;
    const go = dispatch(s.navigation, event);
    event._dispatching = false;
    if (s.ongoing?.event !== event) return 'canceled';
    if (!go) {
      abortOngoing(s);
      return 'canceled';
    }
    if (!event._intercepted && !params.sameDocument) {
      // another document: the host's, and these promises the old one's
      s.ongoing = null;
      return 'other';
    }
    const ongoing = s.ongoing!;
    if (event._intercepted) {
      ongoing.transition = tracker ?? makeTracker();
      s.transition = new NavigationTransition(
        TOKEN,
        params.type,
        fromApi,
        ongoing.transition,
      );
    }
    apply(event._intercepted);
    const entryNow = apiEntryOf(s, currentOf(s));
    if (event._intercepted) {
      event._state = 'committed';
      event._scroller = () => processScroll(s, params.type, params.url);
    }
    ongoing.transition?.commit(entryNow);
    if (tracker !== ongoing.transition) tracker?.commit(entryNow);
    // each handler, then the end of all of them (`navigatesuccess`)
    const results: Any[] = [];
    for (const handler of event._intercepts) {
      try {
        results.push(handler());
      } catch (error) {
        results.push(Promise.reject(error));
      }
    }
    waitForAll(
      results,
      () => {
        if (s.ongoing?.event !== event) return;
        s.ongoing = null;
        // what it scrolls to, unless the page scrolled it or said it would
        // (HTML 7.2.6.9, "potentially process scroll behavior")
        if (
          event._state === 'committed' &&
          event._scrollBehavior === 'after-transition'
        ) {
          event._state = 'scrolled';
          event._scroller?.();
        }
        event._state = 'finished';
        // `navigatesuccess` while the transition is still the
        // navigation's, then its promises, then the method's
        dispatch(s.navigation, asTrusted(new Event('navigatesuccess')));
        if (ongoing.transition && ongoing.transition !== tracker) {
          ongoing.transition.finish(entryNow);
        }
        if (ongoing.transition) s.transition = null;
        tracker?.finish(entryNow);
      },
      (error: Any) => {
        if (s.ongoing?.event !== event) return;
        event._state = 'finished';
        abortOngoing(s, error);
      },
    );
    return 'same';
  };

  /** HTML 7.2.6.9, "process scroll behavior": a traversal restores where
   *  the entry it went to was scrolled to, and anything else scrolls to the
   *  fragment, or to the top where it names none the document has. */
  const processScroll = (s: Session, type: string, url: string): void => {
    if (type === 'traverse') {
      const at = currentOf(s).scroll;
      if (at) s.ctx.scrollTo(at[0], at[1]);
      return;
    }
    if (!scrollToFragment(s.ctx.doc(), url)) s.ctx.scrollTo(0, 0);
  };

  /** WebIDL's "wait for all": `success` once every one of `values` has
   *  fulfilled, or `failure` with the first rejection, each reacted to
   *  directly — a microtask after the last settles, where `Promise.all`
   *  takes several, and a page's own reactions to what the navigation
   *  settles came before its `navigatesuccess`. None is a microtask. */
  const waitForAll = (
    values: Any[],
    success: () => void,
    failure: (error: Any) => void,
  ): void => {
    if (!values.length) {
      queueMicrotask(success);
      return;
    }
    let left = values.length;
    let failed = false;
    for (const value of values) {
      Promise.resolve(value).then(
        () => {
          if (--left === 0 && !failed) success();
        },
        (error: Any) => {
          if (failed) return;
          failed = true;
          failure(error);
        },
      );
    }
  };

  const entryChanged = (s: Session, type: string | null, from: Any): void => {
    dispatch(
      s.navigation,
      asTrusted(
        new NavigationCurrentEntryChangeEvent('currententrychange', {
          navigationType: type,
          from,
        }),
      ),
    );
  };

  /** The current entry made another, or put in place of it, by a
   *  same-document navigation (HTML 7.4.6.2, "URL and history update
   *  steps"), and `currententrychange` told. */
  const commitEntry = (
    s: Session,
    url: string,
    mode: 'push' | 'replace',
    state: string | null,
    navState: string | undefined,
    type: string,
  ): void => {
    const old = currentOf(s);
    const from = apiEntryOf(s, old);
    // where the document is scrolled to is the entry's it leaves
    old.scroll = s.ctx.scroll();
    const entry = sessionEntry(url, mode === 'replace' ? old.key : undefined);
    entry.state = state;
    entry.navState = navState;
    let dropped: SessionEntry[];
    if (mode === 'push') {
      dropped = s.entries.splice(s.index + 1);
      s.entries.push(entry);
      s.index = s.entries.length - 1;
    } else {
      dropped = [old];
      s.entries[s.index] = entry;
    }
    s.ctx.setUrl(url);
    persist(s);
    entryChanged(s, type, from);
    for (const gone of dropped) {
      if (gone.api) dispatch(gone.api, asTrusted(new Event('dispose')));
    }
  };

  /** Scroll to a fragment's element, or to the top for none (HTML
   *  7.4.6.4, "scroll to the fragment"). */
  const scrollToFragment = (doc: Any, url: string): boolean => {
    let name = hashOf(url).slice(1);
    try {
      name = decodeURIComponent(name);
    } catch {}
    const el =
      (name && doc.getElementById(name)) ||
      (name && doc.querySelector(`a[name="${cssEscape(name)}"]`));
    if (el) el.scrollIntoView?.();
    else if ((!name || name.toLowerCase() === 'top') && doc === document) {
      G.scrollTo?.(0, 0);
    }
    return !!el;
  };
  /** `hashchange`, queued, where the fragment changed. */
  const queueHashChange = (
    s: Session,
    oldURL: string,
    newURL: string,
  ): void => {
    if (hashOf(oldURL) === hashOf(newURL)) return;
    setTimer(
      () =>
        dispatch(
          s.ctx.target,
          asTrusted(new HashChangeEvent('hashchange', { oldURL, newURL })),
        ),
      0,
      [],
      false,
    );
  };
  /** An entry's `history.state`, read back once and the same after. */
  const historyStateOf = (entry: SessionEntry): Any => {
    if (!entry.read) {
      entry.read = {
        value: entry.state === null ? null : deserializeClone(entry.state),
      };
    }
    return entry.read.value;
  };
  /** Where a navigation goes: replaced where it is to the URL the document
   *  is at (HTML 7.4.2.2, "auto"). */
  const pushOrReplace = (
    s: Session,
    url: string,
    replace: boolean,
  ): 'push' | 'replace' =>
    replace || url === currentOf(s).url ? 'replace' : 'push';

  /** A navigation to a URL — `location`'s, `navigate()`'s: a fragment of
   *  the document is the window's, an intercepted one too, and anything else
   *  the host's once `navigate` lets it go (HTML 7.4.2.2, "navigate"). */
  const navigateTo = (
    s: Session,
    url: string,
    type: 'push' | 'replace',
    options: {
      navState?: string;
      info?: Any;
      tracker?: Tracker | null;
      userInitiated?: boolean;
      sourceElement?: Any;
      /** Where the host goes to another document itself, as it follows a
       *  link it was told to activate. */
      hostFollows?: boolean;
      /** A form's submission: another document whatever its URL, with
       *  what a POST sends. */
      form?: { formData: Any };
    } = {},
  ): 'same' | 'canceled' | 'other' => {
    // a document that is unloading, or gone, goes nowhere, and tells no
    // `navigate` of it (HTML 7.4.2.2, "navigate")
    if (s.ctx.owner()._unloadCounter > 0 || !s.ctx.active()) return 'canceled';
    const from = currentOf(s).url;
    const fragment = !options.form && fragmentOf(from, url);
    const went = navigateWith(
      s,
      {
        url,
        type,
        navState: options.navState,
        info: options.info,
        tracker: options.tracker,
        userInitiated: options.userInitiated,
        sourceElement: options.sourceElement,
        sameDocument: fragment,
        formData: options.form?.formData,
      },
      (intercepted) => {
        commitEntry(s, url, type, null, options.navState, type);
        // a page's handler has it, which scrolls where it ends, and an
        // intercepted navigation is no fragment's to tell `hashchange` of
        if (fragment && !intercepted) {
          scrollToFragment(s.ctx.doc(), url);
          queueHashChange(s, from, url);
        }
      },
    );
    // another document unloads this one, which is asked first, after its
    // `navigate` (HTML 7.4.2.2, "navigate"), and may stay where a prompt
    // says so
    if (went === 'other' && !unloadAllowed(s.ctx.owner(), s.ctx.target)) {
      return 'canceled';
    }
    // the document it goes to is the next of the host's session, where the
    // session is the host's, with the state the page gave it
    if (went === 'other') planAway(s, { type, navState: options.navState });
    // the host hears of a fragment as it did, and of another document where
    // nothing kept the navigation in this one
    if (
      (went === 'same' && fragment && s.ctx.tellsFragments) ||
      (went === 'other' && !options.hostFollows)
    ) {
      s.ctx.away(url, type === 'replace');
    }
    return went;
  };

  /**
   * The frame of this document a target names, and its session (HTML
   * 7.3.1.7, "the rules for choosing a navigable"): a frame whose window
   * has the name, where its document is this realm's — one with a realm
   * of its own navigates in that realm. Null for a keyword, or a name no
   * frame here has.
   */
  const namedFrame = (name: string): { frame: Any; session: Any } | null => {
    if (!name || name.startsWith('_')) return null;
    for (const frame of Array.from(
      document.querySelectorAll('iframe, frame'),
    ) as Any[]) {
      if (crossLinked.has(frame._id) || linkedFrames.get(frame._id)) continue;
      const doc = frameDocumentOf(frame);
      if (!doc) continue;
      const win = frameWindowOf(doc, frame);
      if (win.name !== name) continue;
      // its session, made as its window's `navigation` is asked for
      void win.navigation;
      const session = frameSessions.get(doc)?.session;
      return session ? { frame, session } : null;
    }
    return null;
  };

  /** A link's activation, a click's or a script's (HTML 4.6.4, "follow the
   *  hyperlink"): `navigate` first, and the host follows it only where it
   *  goes to another document. False where the page kept it. */
  const followLink = (anchor: Any, userInitiated: boolean): boolean => {
    if (!anchor.hasAttribute('href') || anchor.hasAttribute('download')) {
      return true;
    }
    const target = anchor.getAttribute('target') ?? '';
    if (!/^(|_self)$/i.test(target)) {
      // a frame of this document's that the target names hears it as its
      // own navigation; any other window is the host's to choose
      const framed = namedFrame(target);
      if (!framed) return true;
      const href = anchor.href;
      navigateTo(
        framed.session,
        href,
        pushOrReplace(framed.session, href, false),
        {
          userInitiated,
          sourceElement: anchor,
          hostFollows: false,
        },
      );
      return false;
    }
    const s = pageSession.session;
    const href = anchor.href;
    const went = navigateTo(s, href, pushOrReplace(s, href, false), {
      userInitiated,
      sourceElement: anchor,
      hostFollows: true,
    });
    return went === 'other';
  };

  /** A form's submission (HTML 4.10.21.3, "submit"), once its `submit`
   *  went on: planned as a task, as a browser plans one, in which the page
   *  hears `navigate` — a POST's entry list its `formData`, the submitter
   *  or the form its `sourceElement` — and the host submits it only where
   *  it goes to another document and the page let it. One aimed at another
   *  window, or a dialog's, is no navigation of this one's, and goes to
   *  the host at once. */
  const submitForm = (
    form: Any,
    submitter: Any,
    userInitiated: boolean,
  ): void => {
    const submit = () =>
      call('submit', form._id, submitter ? idOf(submitter) : 0);
    const attr = (own: string, form_: string): string | null =>
      submitter?.hasAttribute?.(own)
        ? submitter.getAttribute(own)
        : form.getAttribute(form_);
    const target = (attr('formtarget', 'target') ?? '').trim();
    const method = (attr('formmethod', 'method') ?? '').trim().toLowerCase();
    const action = attr('formaction', 'action');
    let url = action
      ? String(call('resolve', action))
      : String(call('location'));
    // a frame of this document's that the target names is navigated as
    // its own session has it, as the page's is
    const framed = /^(|_self)$/i.test(target) ? null : namedFrame(target);
    if (
      (!/^(|_self)$/i.test(target) && !framed) ||
      method === 'dialog' ||
      /^javascript:/i.test(url)
    ) {
      submit();
      return;
    }
    const formData = new FormData(form);
    if (submitter?.name && /^(submit|image)$/.test(submitter.type)) {
      formData.append(submitter.name, submitter.value ?? '');
    }
    const post = method === 'post';
    if (!post) {
      // the action's query is the entry list, empty or not (HTML
      // 4.10.21.3, "mutate action URL")
      const hash = url.indexOf('#');
      const fragment = hash < 0 ? '' : url.slice(hash);
      const base = (hash < 0 ? url : url.slice(0, hash)).replace(/\?.*$/, '');
      url = `${base}?${new URLSearchParams(formData as Any)}${fragment}`;
    }
    // replaced where it is made while the document loads, unless a user
    // made it, and for a GET of the URL it is at (HTML 7.4.2.2)
    const loading = !userInitiated && !pageSession.session.ctx.loaded();
    setTimer(
      () => {
        const s = framed ? framed.session : pageSession.session;
        const type =
          (!framed && loading) || (!post && url === currentOf(s).url)
            ? 'replace'
            : 'push';
        const went = navigateTo(s, url, type, {
          userInitiated,
          sourceElement: submitter ?? form,
          // a GET into a frame its session sends there; a POST, the host
          hostFollows: !framed || post,
          form: { formData: post ? formData : null },
        });
        if (went === 'other' && (!framed || post)) submit();
      },
      0,
      [],
      false,
    );
  };

  /** Go to another of the window's entries (HTML 7.4.6.1, "traverse the
   *  history by a delta"), as a task: `navigate`, then the entry made the
   *  current one, `popstate`, and `hashchange` where the fragment differs. */
  const traverseTo = (
    s: Session,
    index: number,
    info?: Any,
    tracker?: Tracker | null,
    userInitiated = false,
  ): void => {
    setTimer(
      () => {
        const target = s.entries[index];
        if (!target) {
          tracker?.fail(
            new DOMException('The entry is gone.', 'InvalidStateError'),
          );
          return;
        }
        if (target.other) {
          traverseAway(s, target, info, tracker);
          return;
        }
        const fromUrl = currentOf(s).url;
        navigateWith(
          s,
          {
            url: target.url,
            type: 'traverse',
            target,
            info,
            tracker,
            userInitiated,
            sameDocument: true,
          },
          (intercepted) => {
            const leaving = currentOf(s);
            const from = apiEntryOf(s, leaving);
            leaving.scroll = s.ctx.scroll();
            s.index = s.entries.indexOf(target);
            s.ctx.setUrl(target.url);
            persist(s);
            entryChanged(s, 'traverse', from);
            dispatch(
              s.ctx.target,
              asTrusted(
                new PopStateEvent('popstate', {
                  state: historyStateOf(target),
                }),
              ),
            );
            // where it was scrolled to, as it is restored (HTML 7.4.6.3,
            // "restore persisted state"), unless a handler has it
            if (!intercepted && s.restoration === 'auto' && target.scroll) {
              s.ctx.scrollTo(target.scroll[0], target.scroll[1]);
            }
            queueHashChange(s, fromUrl, target.url);
          },
        );
      },
      0,
      [],
      false,
    );
  };
  /**
   * Go to an entry of another document's, where the session is the host's
   * (HTML, "apply the traverse history step"): that document
   * unloads this one, which is asked first and then hears `navigate`,
   * where the entry is of its origin — neither cancelable nor one a
   * handler can take — and the host is asked for the step (`go`), which
   * the next document it shows is at. What a method handed back never
   * settles here: the document it is of goes.
   */
  const traverseAway = (
    s: Session,
    target: SessionEntry,
    info?: Any,
    tracker?: Tracker | null,
  ): void => {
    if (!unloadAllowed(s.ctx.owner(), s.ctx.target)) {
      tracker?.fail(
        new DOMException('The navigation was canceled.', 'AbortError'),
      );
      return;
    }
    if (entryOrigin(target) === entryOrigin(currentOf(s))) {
      const went = navigateWith(
        s,
        {
          url: target.url,
          type: 'traverse',
          target,
          info,
          tracker,
          sameDocument: false,
        },
        () => {},
      );
      if (went !== 'other') return;
    }
    const delta = s.entries.indexOf(target) - s.index;
    planAway(s, { type: 'traverse', key: target.key });
    s.ctx.traverseAway?.(delta);
  };
  /** Past the window's own entries, the host's history; where the session
   *  is the host's, every entry is in it, and past them is nowhere. */
  const traverseBy = (s: Session, delta: number): void => {
    const index = s.index + delta;
    if (index >= 0 && index < s.entries.length) traverseTo(s, index);
    else if (s.host) return;
    else if (index < 0) s.ctx.go(index);
    else s.ctx.go(index - (s.entries.length - 1));
  };

  /** HTML 7.4.3, `pushState()` and `replaceState()`: an entry of this
   *  document's, at a URL it may have, holding the state. */
  const updateHistory = (
    s: Session,
    state: Any,
    url: Any,
    mode: 'push' | 'replace',
    method: string,
  ): void => {
    const serialized = serializeClone(state);
    const from = currentOf(s);
    let to = from.url;
    if (url !== undefined && url !== null) {
      try {
        to = new URL(str(url), s.ctx.base()).href;
      } catch {
        throw new DOMException(
          `Failed to execute '${method}' on 'History': A history state object with URL '${str(url)}' cannot be created.`,
          'SecurityError',
        );
      }
      if (!rewritable(from.url, to)) {
        throw new DOMException(
          `Failed to execute '${method}' on 'History': A history state object with URL '${to}' cannot be created in a document with URL '${from.url}'.`,
          'SecurityError',
        );
      }
    }
    navigateWith(
      s,
      {
        url: to,
        type: mode,
        navState: from.navState,
        sameDocument: true,
        historyApi: true,
      },
      () => commitEntry(s, to, mode, serialized, from.navState, mode),
    );
  };

  /** `navigation` (HTML 7.2.6): the window's entries, and navigations it
   *  starts and can take over. */
  class Navigation extends EventTarget {
    _s!: Session;
    constructor(token?: Any, session?: Session) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
      super();
      this._s = session!;
    }
    entries(): Any[] {
      const s = this._s;
      if (s.ctx.disabled?.()) return [];
      return navEntriesOf(s).map((e) => apiEntryOf(s, e));
    }
    get currentEntry(): Any {
      if (this._s.ctx.disabled?.()) return null;
      return apiEntryOf(this._s, currentOf(this._s));
    }
    get transition(): Any {
      return this._s.transition;
    }
    get activation(): Any {
      const s = this._s;
      return (s.activation ??= activationOf(s));
    }
    get canGoBack(): boolean {
      const s = this._s;
      return !s.ctx.disabled?.() && navEntriesOf(s).indexOf(currentOf(s)) > 0;
    }
    get canGoForward(): boolean {
      const s = this._s;
      if (s.ctx.disabled?.()) return false;
      const list = navEntriesOf(s);
      return list.indexOf(currentOf(s)) < list.length - 1;
    }
    navigate(url: Any, options: Any = {}): Any {
      const s = this._s;
      let href: string;
      try {
        href = new URL(str(url), s.ctx.base()).href;
      } catch {
        return earlyError(
          new DOMException(
            `Failed to execute 'navigate' on 'Navigation': Invalid URL '${str(url)}'.`,
            'SyntaxError',
          ),
        );
      }
      let navState: string | undefined;
      if (options?.state !== undefined) {
        try {
          navState = serializeClone(options.state);
        } catch (error) {
          return earlyError(error);
        }
      }
      const historyMode = options?.history ?? 'auto';
      // a navigation from an `about:blank` document, or to one, can only
      // replace it (HTML 7.4.2.2, "the navigation must be a replace")
      if (
        historyMode === 'push' &&
        (/^about:blank(?:[?#]|$)/i.test(currentOf(s).url) ||
          /^about:blank(?:[?#]|$)/i.test(href))
      ) {
        return earlyError(
          new DOMException(
            "Failed to execute 'navigate' on 'Navigation': A push navigation must be a replace here.",
            'NotSupportedError',
          ),
        );
      }
      if (historyMode === 'push' && /^javascript:/i.test(href)) {
        return earlyError(
          new DOMException(
            "Failed to execute 'navigate' on 'Navigation': A javascript: URL cannot be pushed.",
            'NotSupportedError',
          ),
        );
      }
      const refused = unloadingRefusal(s, 'navigate');
      if (refused) return earlyError(refused);
      const type =
        historyMode === 'push'
          ? 'push'
          : pushOrReplace(s, href, historyMode === 'replace');
      const tracker = makeTracker();
      navigateTo(s, href, type, { navState, info: options?.info, tracker });
      return resultOf(tracker);
    }
    reload(options: Any = {}): Any {
      const s = this._s;
      let navState = currentOf(s).navState;
      if (options?.state !== undefined) {
        try {
          navState = serializeClone(options.state);
        } catch (error) {
          return earlyError(error);
        }
      }
      const refused = unloadingRefusal(s, 'reload');
      if (refused) return earlyError(refused);
      // nothing is told of a reload of a document whose navigations go
      // untold, and what it hands back never settles
      if (s.ctx.disabled?.()) return resultOf(makeTracker());
      const tracker = makeTracker();
      const url = currentOf(s).url;
      const went = navigateWith(
        s,
        {
          url,
          type: 'reload',
          navState,
          info: options?.info,
          tracker,
          sameDocument: false,
        },
        () =>
          commitEntry(
            s,
            url,
            'replace',
            currentOf(s).state,
            navState,
            'reload',
          ),
      );
      if (went === 'other') s.ctx.reload(navState);
      return resultOf(tracker);
    }
    traverseTo(key: Any, options: Any = {}): Any {
      const s = this._s;
      const k = str(key);
      // among the entries the API shows, which a key of another origin's
      // document is not
      const found = s.ctx.disabled?.()
        ? undefined
        : navEntriesOf(s).find((e) => e.key === k);
      const index = found ? s.entries.indexOf(found) : -1;
      if (index < 0) {
        return earlyError(
          new DOMException(
            "Failed to execute 'traverseTo' on 'Navigation': Invalid key.",
            'InvalidStateError',
          ),
        );
      }
      const refused = unloadingRefusal(s, 'traverseTo');
      if (refused) return earlyError(refused);
      const tracker = makeTracker();
      if (index === s.index) {
        const entry = apiEntryOf(s, currentOf(s));
        tracker.commit(entry);
        tracker.finish(entry);
      } else {
        traverseTo(s, index, options?.info, tracker);
      }
      return resultOf(tracker);
    }
    back(options: Any = {}): Any {
      if (!this.canGoBack) {
        return earlyError(
          new DOMException(
            "Failed to execute 'back' on 'Navigation': Cannot go back.",
            'InvalidStateError',
          ),
        );
      }
      const list = navEntriesOf(this._s);
      const at = list.indexOf(currentOf(this._s));
      return this.traverseTo(list[at - 1].key, options);
    }
    forward(options: Any = {}): Any {
      if (!this.canGoForward) {
        return earlyError(
          new DOMException(
            "Failed to execute 'forward' on 'Navigation': Cannot go forward.",
            'InvalidStateError',
          ),
        );
      }
      const list = navEntriesOf(this._s);
      const at = list.indexOf(currentOf(this._s));
      return this.traverseTo(list[at + 1].key, options);
    }
    /** The current entry's state, set in place (HTML 7.2.6.4). */
    updateCurrentEntry(options: Any): void {
      if (!options || !('state' in Object(options))) {
        throw new TypeError(
          "Failed to execute 'updateCurrentEntry' on 'Navigation': required member state is undefined.",
        );
      }
      const s = this._s;
      const serialized = serializeClone(options.state);
      const entry = currentOf(s);
      const from = apiEntryOf(s, entry);
      entry.navState = serialized;
      persist(s);
      entryChanged(s, null, from);
    }
  }
  for (const type of [
    'navigate',
    'navigatesuccess',
    'navigateerror',
    'currententrychange',
  ]) {
    Object.defineProperty(Navigation.prototype, `on${type}`, {
      get(this: Any): Any {
        return this._handlers[type] ?? null;
      },
      set(this: Any, fn: Any) {
        this._handlers[type] = typeof fn === 'function' ? fn : null;
      },
      configurable: true,
    });
  }
  Object.defineProperty(NavigationHistoryEntry.prototype, 'ondispose', {
    get(this: Any): Any {
      return this._handlers.dispose ?? null;
    },
    set(this: Any, fn: Any) {
      this._handlers.dispose = typeof fn === 'function' ? fn : null;
    },
    configurable: true,
  });

  /** An entry of the host's session, as its JSON has it (`SessionRecord`):
   *  this document's own, or another's. */
  const seedEntry = (r: Any, mine: boolean): SessionEntry => ({
    url: str(r.url),
    key: str(r.key),
    id: str(r.id),
    state: typeof r.state === 'string' ? r.state : null,
    navState: typeof r.navState === 'string' ? r.navState : undefined,
    api: null,
    scroll: Array.isArray(r.scroll)
      ? [Number(r.scroll[0]) || 0, Number(r.scroll[1]) || 0]
      : undefined,
    other: !mine,
  });
  const seedEntries = (seed: Any): SessionEntry[] | null => {
    if (!Array.isArray(seed.entries) || !seed.entries.length) return null;
    const entries = seed.entries.map((r: Any) => seedEntry(r, !!r.mine));
    const current = entries[Number(seed.index)];
    if (!current) return null;
    current.other = false;
    return entries;
  };
  /** An entry as the host's session keeps it (`sessionWrite`). */
  const sessionRecordOf = (e: SessionEntry): Any => ({
    url: e.url,
    key: e.key,
    id: e.id,
    state: e.state,
    navState: e.navState ?? null,
    scroll: e.scroll ?? null,
    mine: !e.other,
  });

  /** A window's session history, and its `history` and `navigation`. */
  const makeSession = (
    ctx: SessionContext,
    seed: Any = null,
  ): { session: Session; history: Any; navigation: Any } => {
    const s: Session = {
      ctx,
      entries: [sessionEntry(ctx.url())],
      index: 0,
      ongoing: null,
      restoration: 'auto',
      transition: null,
      activation: null,
      navigation: null,
      host: false,
      arrived: null,
    };
    // the host's session, where it keeps one across documents: its
    // entries, this document's own and the others', at the entry the
    // document was shown at (`HtmlSessionHistory`)
    const seeded = seed ? seedEntries(seed) : null;
    if (seeded) {
      s.entries = seeded;
      s.index = Math.max(0, Math.min(seeded.length - 1, Number(seed.index)));
      s.host = true;
      const fromIndex = Number(seed.fromIndex);
      s.arrived = {
        type: str(seed.type),
        fromIndex: fromIndex >= 0 && fromIndex < seeded.length ? fromIndex : -1,
        from: seed.from ? seedEntry(seed.from, false) : null,
      };
      // the document is where the host showed it
      const entry = currentOf(s);
      entry.url = ctx.url();
      entry.origin = undefined;
      persist(s);
    }
    s.navigation = new Navigation(TOKEN, s);
    const history = {
      get length(): number {
        return s.entries.length;
      },
      get state(): Any {
        return historyStateOf(currentOf(s));
      },
      get scrollRestoration(): string {
        return s.restoration;
      },
      set scrollRestoration(value: Any) {
        const v = str(value);
        if (v === 'auto' || v === 'manual') s.restoration = v;
      },
      back: () => traverseBy(s, -1),
      forward: () => traverseBy(s, 1),
      go: (n: Any = 0) => {
        const delta = Number(n) || 0;
        if (delta) traverseBy(s, delta);
        else ctx.reload();
      },
      pushState(state: Any, _title: Any, url?: Any) {
        updateHistory(s, state, url, 'push', 'pushState');
      },
      replaceState(state: Any, _title: Any, url?: Any) {
        updateHistory(s, state, url, 'replace', 'replaceState');
      },
    };
    return { session: s, history, navigation: s.navigation };
  };

  /** Whether the document is completely loaded (HTML 8.4, "completely
   *  finish loading"): its `load` told. */
  let completelyLoaded = false;
  /** The host's session the document was shown in, where it keeps one
   *  (`HtmlSessionHistory`), as JSON: null where it keeps none. */
  const hostSession = ((): Any => {
    const json = call('session');
    if (typeof json !== 'string') return null;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  })();
  const pageSession = makeSession(
    {
      url: () => String(call('location')),
      base: () => document.baseURI,
      // completely loaded once `load` was told, as a navigation a handler
      // of it makes is still one during load (HTML 7.4.2.2)
      loaded: () => completelyLoaded,
      setUrl: (url) => void call('setLocation', url),
      doc: () => document,
      owner: () => document,
      active: () => !document._unloaded,
      get target() {
        return windowTarget;
      },
      away: (url, replace) => void call('navigate', url, replace),
      tellsFragments: true,
      // each of them another document, which unloads this one
      reload: (navState) => {
        if (!unloadAllowed(document, windowTarget)) return;
        planAway(pageSession.session, { type: 'reload', navState });
        call('reload');
      },
      go: (delta) => {
        if (unloadAllowed(document, windowTarget)) call('go', delta);
      },
      scroll: () => [Number(G.scrollX) || 0, Number(G.scrollY) || 0],
      scrollTo: (x, y) => G.scrollTo?.(x, y),
      // the host's session, where it keeps one across documents
      plan: (plan) => void call('sessionPlan', JSON.stringify(plan)),
      traverseAway: (delta) => void call('go', delta),
      changed: (s) =>
        void call(
          'sessionWrite',
          JSON.stringify({
            entries: s.entries.map(sessionRecordOf),
            index: s.index,
          }),
        ),
    },
    hostSession,
  );
  const history = pageSession.history;
  const navigation = pageSession.navigation;
  /** `location`'s navigations: to a URL, or in place of the entry, which
   *  is where one goes while the document still loads (HTML 7.2.4,
   *  "Location-object navigate"; nothing here has transient activation). */
  const navigateDocument = (url: string, replace: boolean): void => {
    const s = pageSession.session;
    navigateTo(s, url, pushOrReplace(s, url, replace || !s.ctx.loaded()));
  };

  // --- unloading a document (HTML 7.4.2.4) ------------------------------------
  //
  // A navigation to another document asks the one it leaves first:
  // `beforeunload` at its window and at its frames', after its `navigate`,
  // which keeps it only where one asks to be confirmed, the page has been
  // used and the host's prompt says to stay (`promptToUnload`). As it goes,
  // its frames' documents and then it hear `pagehide`, `visibilitychange`
  // to hidden and `unload`, and it is fully active no longer, so a method of
  // its `navigation` is refused (`unloadingRefusal`). The page's document
  // goes with its engine (`__unload`); a frame's in this realm as the host
  // puts another in its place or the frame leaves the document
  // (`__unloadDocument`). What its handlers start after that runs nowhere:
  // the page's engine is gone, and a frame's window is another document's.

  /** Whether the page has been used: a press or a key of the user's in it
   *  (HTML 6.4.1, "sticky activation"), which its frames of the same origin
   *  share. A prompt to unload is asked for only where it has. */
  let stickyActivation = false;
  /** When the user last pressed or typed in the page (HTML 6.4.1, "last
   *  activation timestamp"): it has transient activation for
   *  `TRANSIENT_ACTIVATION_MS` after, Chrome's and Firefox's five seconds,
   *  until an API that takes it spends it (`consumeActivation`) — a
   *  `showPicker()` from a click's handler, which a second call in the
   *  same handler is refused for. */
  let lastActivation = -Infinity;
  const TRANSIENT_ACTIVATION_MS = 5000;
  const hasTransientActivation = (): boolean =>
    now() - lastActivation < TRANSIENT_ACTIVATION_MS;
  const consumeActivation = (): void => {
    lastActivation = -Infinity;
  };

  /** A document and the documents its frames hold in this realm, each with
   *  where its window hears events, a parent before its frames: a frame
   *  with a realm of its own unloads in it, a frame's initial `about:blank`
   *  is never shown, and a document whose window was never made has nobody
   *  to tell, so none of them is here. */
  const documentTree = (
    doc: Any,
    target: Any,
    out: [Any, Any][] = [],
  ): [Any, Any][] => {
    out.push([doc, target]);
    for (const frame of Array.from(
      doc.querySelectorAll('iframe, frame'),
    ) as Any[]) {
      if (crossLinked.has(frame._id) || linkedFrames.has(frame._id)) continue;
      const kept = keptFrameWindows.get(frame);
      if (!kept || kept.initial || kept.doc._unloaded) continue;
      const at = frameTargets.get(kept.doc);
      if (at) documentTree(kept.doc, at, out);
    }
    return out;
  };

  /**
   * HTML 7.4.2.4, "checking if unloading is canceled": `beforeunload` at
   * each document a navigation would unload, and where one asks to be
   * confirmed — it canceled the event, or gave it a `returnValue` — and the
   * page has been used, the host's prompt, once, whose answer is whether to
   * go on. `mayStay` false tells them and keeps none: a document going that
   * nothing asked as its navigation started. True where it goes on.
   */
  const unloadAllowed = (doc: Any, target: Any, mayStay = true): boolean => {
    // one already unloading, or gone, goes nowhere
    if (doc._unloadCounter > 0 || doc._unloaded) return false;
    const tree = documentTree(doc, target);
    let prompted = false;
    for (const [d, at] of tree) {
      if (d._unloaded) continue;
      const ev = asTrusted(
        new BeforeUnloadEvent(UNLOADING, 'beforeunload', { cancelable: true }),
      );
      d._unloadCounter += 1;
      dispatch(at, ev);
      d._unloadCounter -= 1;
      if (
        mayStay &&
        !prompted &&
        stickyActivation &&
        (ev._canceled || ev._returnValue !== '')
      ) {
        prompted = true;
        if (call('promptToUnload') === false) return false;
      }
    }
    for (const [d] of tree) d._leaveChecked = true;
    return true;
  };

  /** HTML 7.4.2.4, "unload a document": `pagehide` and the visibility
   *  hidden where it was shown, then `unload`, and it is gone. */
  const unloadOne = (doc: Any, target: Any): void => {
    if (doc._unloaded) return;
    doc._unloadCounter += 1;
    if (doc._pageShowing) {
      doc._pageShowing = false;
      dispatch(
        target,
        asTrusted(
          new PageTransitionEvent('pagehide', {
            persisted: false,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      if (!doc._hidden) {
        doc._hidden = true;
        dispatch(
          doc,
          asTrusted(new Event('visibilitychange', { bubbles: true })),
        );
      }
    }
    dispatch(target, asTrusted(new Event('unload')));
    doc._unloaded = true;
    doc._unloadCounter -= 1;
  };

  /** A document and its frames' going (HTML 7.4.2.4, "unload a document
   *  and its descendants"): asked first where nothing asked as its
   *  navigation started, then its frames' unloaded before it. */
  const unloadTree = (
    doc: Any,
    target: Any,
    /** What the document is told once its frames' documents are gone and
     *  before it goes itself: the `pageswap` of the one shown in its place
     *  (HTML, "deactivate a document for a cross-document
     *  navigation"). */
    beforeItself?: () => void,
  ): void => {
    if (doc._unloaded) return;
    if (!doc._leaveChecked) unloadAllowed(doc, target, false);
    for (const [d, at] of documentTree(doc, target).reverse()) {
      // the document shown in its place is in already, so what the page
      // starts as it hears it goes nowhere, as what it starts as it
      // unloads goes nowhere
      if (d === doc && beforeItself) {
        doc._unloadCounter += 1;
        try {
          beforeItself();
        } finally {
          doc._unloadCounter -= 1;
        }
      }
      unloadOne(d, at);
    }
  };

  /**
   * A document and its frames hidden where the host keeps them in its
   * back-forward cache (HTML 7.4.2.4, "unload a document", for a document
   * that is salvageable): asked first where nothing asked as its navigation
   * started, then `pagehide` with `persisted` true and the visibility
   * hidden, frames first — and no `unload`, since the document is not
   * unloaded, and nothing it does next runs until it is shown again. One
   * that listens for `unload` is kept all the same and never hears it, as
   * HTML has it and Chrome and Safari do; Firefox keeps such a page out.
   */
  /** The pause steps, as the facade has them before any page runs. */
  const pauseMedia = HTMLMediaElement.prototype.pause;
  const hideTree = (doc: Any, target: Any, beforeItself?: () => void): void => {
    if (doc._unloaded) return;
    if (!doc._leaveChecked) unloadAllowed(doc, target, false);
    for (const [d, at] of documentTree(doc, target).reverse()) {
      if (d._unloaded) continue;
      d._unloadCounter += 1;
      try {
        if (d === doc) beforeItself?.();
        if (d._pageShowing) {
          d._pageShowing = false;
          dispatch(
            at,
            asTrusted(
              new PageTransitionEvent('pagehide', {
                persisted: true,
                bubbles: true,
                cancelable: true,
              }),
            ),
          );
          if (!d._hidden) {
            d._hidden = true;
            dispatch(
              d,
              asTrusted(new Event('visibilitychange', { bubbles: true })),
            );
          }
        }
        // what plays in a document that is not fully active is paused
        // (HTML 4.8.11.8), its `pause` told as it is shown again — what is
        // in its tree, and what a script plays out of it
        for (const el of [
          ...(Array.from(d.querySelectorAll('video, audio')) as Any[]),
          ...Array.from(playingMedia).filter(
            (m: Any) => m.ownerDocument === d && !m.isConnected,
          ),
        ]) {
          if (!el.paused) pauseMedia.call(el);
        }
      } finally {
        d._unloadCounter -= 1;
      }
    }
  };

  /** A document and its frames shown again from the back-forward cache
   *  (HTML 7.4.6.3, "reactivate a document"): `pageshow` with `persisted`
   *  true and the visibility visible, the document before its frames. */
  const showTree = (doc: Any, target: Any): void => {
    for (const [d, at] of documentTree(doc, target)) {
      if (d._unloaded) continue;
      // a navigation from it later asks it again
      d._leaveChecked = false;
      if (d._hidden) {
        d._hidden = false;
        dispatch(
          d,
          asTrusted(new Event('visibilitychange', { bubbles: true })),
        );
      }
      if (!d._pageShowing) {
        d._pageShowing = true;
        dispatch(
          at,
          asTrusted(
            new PageTransitionEvent('pageshow', {
              persisted: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
      }
    }
  };

  /**
   * HTML 7.4.6.3, "update the navigation API entries for reactivation":
   * the session as the host has it now that the document is shown again
   * from the back-forward cache, which the documents shown meanwhile
   * wrote. The document's own entries that are still there keep their
   * `NavigationHistoryEntry`, and those that are not are disposed, in a
   * task of their own; it came to be shown by a traversal, from the entry
   * it was left for.
   */
  const reseedSession = (s: Session, seed: Any): void => {
    const seeded = seedEntries(seed);
    if (!seeded || !s.host) return;
    const own = new Map<string, SessionEntry>();
    for (const e of s.entries) if (!e.other) own.set(`${e.key} ${e.id}`, e);
    const entries = seeded.map((e) => {
      if (e.other) return e;
      const kept = own.get(`${e.key} ${e.id}`);
      if (!kept) return e;
      own.delete(`${e.key} ${e.id}`);
      kept.url = e.url;
      kept.origin = undefined;
      return kept;
    });
    s.entries = entries;
    s.index = Math.max(0, Math.min(entries.length - 1, Number(seed.index)));
    const fromIndex = Number(seed.fromIndex);
    s.arrived = {
      type: str(seed.type),
      fromIndex: fromIndex >= 0 && fromIndex < entries.length ? fromIndex : -1,
      from: seed.from ? seedEntry(seed.from, false) : null,
    };
    s.activation = null;
    const disposed = [...own.values()].filter((e) => e.api);
    if (disposed.length) {
      setTimer(
        () => {
          for (const gone of disposed) {
            dispatch(gone.api, asTrusted(new Event('dispose')));
          }
        },
        0,
        [],
        false,
      );
    }
  };

  /**
   * HTML, "fire the pageswap event": the document is about to be
   * swapped for the one the host shows in its place. Where that one is of
   * this document's origin and the session is the host's, it is told how:
   * the entry it is at now, the one it goes to — the current one for a
   * reload, the one among the entries for a traversal, and for a push or a
   * replace one of no list yet — and the navigation's type. No transition
   * is set up across documents yet.
   */
  const firePageSwap = (swap: Any): void => {
    const s = pageSession.session;
    let activation: Any = null;
    if (s.host && swap.key && !s.ctx.disabled?.()) {
      const to = seedEntry(swap, false);
      if (entryOrigin(to) === entryOrigin(currentOf(s))) {
        const type = str(swap.type);
        let destination: Any = null;
        if (type === 'reload') destination = apiEntryOf(s, currentOf(s));
        else if (type === 'traverse') {
          const found = navEntriesOf(s).find(
            (e) => e.key === to.key && e.id === to.id,
          );
          if (found) destination = apiEntryOf(s, found);
        }
        destination ??= looseEntryOf(s, to);
        activation = new NavigationActivation(
          TOKEN,
          destination,
          apiEntryOf(s, currentOf(s)),
          type,
        );
      }
    }
    dispatch(
      windowTarget,
      asTrusted(
        new PageSwapEvent('pageswap', { activation, viewTransition: null }),
      ),
    );
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
    /** The registry it was defined in. */
    registry: Any;
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
  /** A registry's own (HTML 4.13.4): its definitions by name and by
   *  constructor, `whenDefined`'s promises until a name is defined, and
   *  whether it is defining one now. The window's `customElements` is one,
   *  and a page makes scoped ones (`new CustomElementRegistry`), which an
   *  element, a shadow root or a document has as its own. */
  interface RegistryState {
    definitions: Map<string, CustomDefinition>;
    byCtor: Map<Any, CustomDefinition>;
    waiting: Map<string, { promise: Any; resolve: Any }>;
    defining: boolean;
    scoped: boolean;
    /** The document of its window (HTML 4.13.4, "relevant global object's
     *  associated Document"): what a global one's `define()` upgrades in,
     *  and what an element its constructor makes is made in — this
     *  window's for a scoped one, whose constructors are this realm's. */
    home: () => Any;
    /** A scoped one's scoped document set (HTML 4.13.4): the documents
     *  its elements and shadow roots were connected in, or initialized
     *  in, in the order they first were, which its `define()` upgrades in
     *  turn. */
    documents: Set<Any>;
    /** Whether some node has been given it (`noteScoped`). */
    used: boolean;
  }
  const registryStates = new WeakMap<Any, RegistryState>();
  const stateOf = (registry: Any): RegistryState => {
    const state = registryStates.get(registry);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  };
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

  /** The definition for a local name and an `is` value in a registry
   *  (HTML 4.13.4, "look up a custom element definition"); none in none. */
  const lookUp = (
    registry: Any,
    local: string,
    is: string | null,
  ): CustomDefinition | null => {
    if (!registry) return null;
    const { definitions } = stateOf(registry);
    const own = definitions.get(local);
    if (own && own.localName === local) return own;
    if (is === null) return null;
    const extending = definitions.get(is);
    return extending?.localName === local ? extending : null;
  };

  /**
   * Each element's registry (HTML 4.13.4, scoped registries): the one it
   * was made with, or, for one the parser made, its shadow root's or its
   * document's — taken the first time it is asked and kept, so that moving
   * the element changes nothing, as an element's registry is set as it is
   * made. A shadow root's is the document's, the one `attachShadow` named,
   * or null for a declarative one written with
   * `shadowrootcustomelementregistry`, until a page initializes one.
   */
  const elementRegistries = new WeakMap<Any, Any>();
  /** The document an element of no registry had it in: adopted into
   *  another, it takes that one's global registry (DOM 4.5, "adopt"),
   *  where in its own it keeps none wherever it is put. */
  const noneIn = new WeakMap<Any, Any>();
  const pinRegistry = (el: Any, registry: Any): void => {
    elementRegistries.set(el, registry);
    if (registry === null) noneIn.set(el, el.ownerDocument);
    else {
      noneIn.delete(el);
      noteScoped(registry);
    }
  };
  /** The scoped registries some node has been given, in the order each
   *  first was: what a node connected is asked about (`associate`). */
  const usedScoped: Any[] = [];
  /** A registry given to a node. A scoped one is from now on associated
   *  with each document one of its nodes is connected in (DOM 4.2.3,
   *  "insert"), which the host notes from the first one given (`ceScoped`):
   *  a page that only makes one, to see whether it can, pays nothing. */
  const noteScoped = (registry: Any): void => {
    const state = registryStates.get(registry);
    if (!state?.scoped || state.used) return;
    state.used = true;
    usedScoped.push(registry);
    if (usedScoped.length === 1) {
      takesNotes = true;
      call('ceScoped');
    }
  };
  /** A shadow root's registry, set. */
  const setShadowRegistry = (root: Any, registry: Any): void => {
    shadowRegistries.set(root, registry);
    noteScoped(registry);
  };
  /** A document `doc` put in a scoped registry's scoped document set,
   *  where it is not yet (an ordered set's append). */
  const associate = (registry: Any, doc: Any): void => {
    if (doc) stateOf(registry).documents.add(doc);
  };
  /** A node connected in `doc`, and what it holds, shadow trees and all
   *  (DOM 4.2.3, "insert"): each scoped registry one of its elements or
   *  shadow roots has is associated with `doc`. Only the registries not
   *  associated with it yet are looked for, so a document a page's
   *  registries are all associated with costs a look at a set. */
  const associateConnected = (id: number, doc: Any): void => {
    if (!doc) return;
    const lacking = usedScoped.filter((r) => !stateOf(r).documents.has(doc));
    if (!lacking.length) return;
    for (const found of idList(call('ceTree', id))) {
      const at = wrap(found);
      if (!at) continue;
      const registry =
        at instanceof ShadowRoot ? shadowRegistryOf(at) : registryOf(at);
      const i = lacking.indexOf(registry);
      if (i < 0) continue;
      associate(registry, doc);
      lacking.splice(i, 1);
      if (!lacking.length) return;
    }
  };
  /** What `createContextualFragment` parsed in a template: no registry
   *  while it is nobody's child (HTML's scoped registries), and the one
   *  looked up where it is put. */
  const registryUntilPut = new WeakSet<Any>();
  const shadowRegistries = new WeakMap<Any, Any>();
  /** A document's registry, where it is not this window's: one a page
   *  initialized it with, or its own window's. */
  const documentRegistries = new WeakMap<Any, Any>();
  /** A document's registry (DOM 4.5, "look up a custom element
   *  registry"): this window's for its document, one a page initialized
   *  it with, or the window's of a frame this realm made — never another
   *  realm's, which no registry here can stand for. */
  const documentRegistryOf = (doc: Any): Any => {
    if (!doc) return null;
    if (doc === document) return customElements;
    if (documentRegistries.has(doc)) return documentRegistries.get(doc);
    const registry = doc.defaultView?.customElements;
    return registry && registryStates.has(registry) ? registry : null;
  };
  /** Whether `createElement` runs a definition of a registry: any of this
   *  realm's, a frame's window's among them, whose constructors make an
   *  element in that window's document (`home`). */
  const constructsWith = (registry: Any): boolean =>
    !!registry && registryStates.has(registry);
  /** A shadow root's registry: none where its template said
   *  `shadowrootcustomelementregistry`, its host document's otherwise. */
  const shadowRegistryOf = (root: Any): Any => {
    if (shadowRegistries.has(root)) return shadowRegistries.get(root);
    const registry =
      call('shadowRegistryNull', root._id) === true
        ? null
        : documentRegistryOf(root.host.ownerDocument);
    shadowRegistries.set(root, registry);
    return registry;
  };
  /** Whether a page has made registries other than the window's matter
   *  — a scoped one made, a registry named where an element or a root is,
   *  `customelementregistry` parsed, a frame's window's — after which a
   *  copy keeps its original's registry (`pinCopies`). Before, every
   *  element's is its document's, and a copy's would be the same. */
  let registriesMatter = false;
  /** `registriesMatter`, asked of the parser as well: an element or a root
   *  it made with no registry keeps none wherever it is moved, which only
   *  a copy whose registries are pinned keeps too. */
  const registriesMatterNow = (): boolean =>
    registriesMatter ||
    (registriesMatter = call('registriesParsedNull') === true);
  const isGlobalRegistry = (registry: Any): boolean =>
    !!registry && !registryStates.get(registry)?.scoped;
  /** What a copy is made with (DOM 4.5, "clone a node"): each element
   *  its original's registry, or `fallback` where that is none, a global
   *  one being `doc`'s; each shadow root its original's, the elements in
   *  it with no fallback. */
  const pinCopies = (
    from: Any,
    to: Any,
    deep: boolean,
    fallback: Any,
    doc: Any,
  ): void => {
    const globalOfDoc = (): Any => {
      const registry = documentRegistryOf(doc);
      return isGlobalRegistry(registry) ? registry : null;
    };
    const pin = (a: Any, b: Any, fallback: Any): void => {
      if (a instanceof Element && b instanceof Element) {
        let registry = registryOf(a) ?? fallback;
        if (isGlobalRegistry(registry)) registry = globalOfDoc();
        pinRegistry(b, registry);
        const rootA = wrap(Number(call('shadowRoot', a._id, true)));
        const rootB = wrap(Number(call('shadowRoot', b._id, true)));
        if (rootA && rootB) {
          let shadow = rootA.customElementRegistry;
          if (isGlobalRegistry(shadow)) shadow = globalOfDoc();
          setShadowRegistry(rootB, shadow);
          walk(rootA, rootB, null);
        }
      }
      if (deep) walk(a, b, fallback);
    };
    const walk = (a: Any, b: Any, fallback: Any): void => {
      for (
        let x = a.firstChild, y = b.firstChild;
        x && y;
        x = x.nextSibling, y = y.nextSibling
      ) {
        pin(x, y, fallback);
      }
    };
    pin(from, to, fallback);
  };
  /** A copy made by `clone` or `import` with its registries pinned
   *  (`pinCopies`) before the upgrades its elements are due. */
  const copyOf = (
    op: 'clone' | 'import',
    node: Any,
    deep: boolean,
    fallback: Any,
    doc: Any,
  ): Any => {
    copying = true;
    let copy: Any;
    try {
      copy = wrap(
        Number(
          op === 'clone'
            ? call('clone', node._id, deep)
            : call('import', idOf(node), deep, doc._id),
        ),
      );
    } finally {
      copying = false;
    }
    pinCopies(node, copy, deep, fallback, doc);
    if (takesNotes) takeReactions();
    return copy;
  };
  /** A registry as adoption leaves it (DOM 4.5, "adopt"): a global one
   *  made in another document is the global one of the document it is in
   *  now, or none where that document's is scoped; a scoped one stays. */
  const adoptedRegistry = (registry: Any, doc: Any): Any => {
    if (!registry || registryStates.get(registry)?.scoped) return registry;
    const now = documentRegistryOf(doc);
    if (now === registry) return registry;
    return now && !registryStates.get(now)?.scoped ? now : null;
  };
  const registryOf = (el: Any): Any => {
    const pinned = pinnedRegistryOf(el);
    if (pinned !== null) return adoptedRegistry(pinned, el.ownerDocument);
    const was = noneIn.get(el);
    if (!was || was === el.ownerDocument) return null;
    const now = documentRegistryOf(el.ownerDocument);
    const registry = isGlobalRegistry(now) ? now : null;
    pinRegistry(el, registry);
    return registry;
  };
  /** The registry an element was made with. What the parser made has
   *  its intended parent's (HTML 13.2.6.1, "create an element for a
   *  token"), its parent's here, and none where it wrote
   *  `customelementregistry` (`elementRegistryNull`); one in a template's
   *  contents has none either, and is not kept, since one taken into the
   *  document is adopted and takes the document's (DOM 4.5, "adopt"). */
  const pinnedRegistryOf = (el: Any): Any => {
    if (elementRegistries.has(el)) return elementRegistries.get(el);
    const chain: Any[] = [];
    let registry: Any = null;
    let keep = true;
    for (let at = el; ;) {
      if (elementRegistries.has(at)) {
        registry = elementRegistries.get(at);
        break;
      }
      chain.push(at);
      const none = call('elementRegistryNull', at._id);
      if (none) {
        keep = none === true;
        if (keep) registriesMatter = true;
        break;
      }
      const parent = at.parentNode;
      if (parent instanceof Element) {
        at = parent;
        continue;
      }
      if (
        registryUntilPut.has(at) &&
        !(parent instanceof ShadowRoot) &&
        parent?.nodeType !== 9
      ) {
        keep = false;
        break;
      }
      registry =
        parent instanceof ShadowRoot
          ? shadowRegistryOf(parent)
          : documentRegistryOf(
              parent?.nodeType === 9 ? parent : at.ownerDocument,
            );
      break;
    }
    if (keep) for (const at of chain) pinRegistry(at, registry);
    return registry;
  };
  /** A registry an element, a shadow root or an import is given (DOM 4.5,
   *  4.9): a scoped one, or the document's own, or null; undefined where
   *  `options` names none. */
  const registryGiven = (options: Any, own: Any, method: string): Any => {
    if (!options || typeof options !== 'object') return undefined;
    const given = options.customElementRegistry;
    if (given === undefined) return undefined;
    registriesMatter = true;
    if (given !== null && !registryStates.has(given)) {
      throw new TypeError(
        `Failed to execute '${method}': The provided value is not of type 'CustomElementRegistry'.`,
      );
    }
    if (given && !stateOf(given).scoped && given !== own) {
      throw new DOMException(
        `Failed to execute '${method}': The registry is another document's global one.`,
        'NotSupportedError',
      );
    }
    return given;
  };

  /** The definition an element would be upgraded with: its own name's, or
   *  its `is`'s, in its registry, where it is an HTML element (HTML
   *  4.13.4, "look up a custom element definition"). In whatever document:
   *  one of no browsing context's has no registry, and another realm's
   *  none of this one's. */
  const definitionFor = (el: Any): CustomDefinition | null => {
    if (el.namespaceURI !== HTML_NS) return null;
    return lookUp(registryOf(el), el.localName, el.getAttribute('is'));
  };

  /** Each constructor an upgrade or a `createElement` is running, with the
   *  registry whose definition it runs: what `super()` looks its definition
   *  up in (HTML 3.2.3, the active custom element constructor map), and the
   *  window's where none is. */
  const activeConstructors = new Map<Any, Any[]>();
  const runConstructor = (def: CustomDefinition): Any => {
    let stack = activeConstructors.get(def.ctor);
    if (!stack) activeConstructors.set(def.ctor, (stack = []));
    stack.push(def.registry);
    try {
      return new def.ctor();
    } finally {
      stack.pop();
      if (!stack.length) activeConstructors.delete(def.ctor);
    }
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
        if (kind === 's') {
          associateConnected(id, wrap(a));
          continue;
        }
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

  /** The elements a fragment's parse made in `root`, upgraded where a
   *  scoped registry is theirs (HTML 13.2.6.1, "create an element for the
   *  token", which looks a definition up in the context's registry): an
   *  element `innerHTML` makes in a tree of its own is a custom element at
   *  once. One whose registry is the window's is upgraded as it is
   *  connected, as Chrome has it, where the fragment's document has no
   *  browsing context to look one up in. */
  const upgradeParsed = (root: Any): void => {
    if (!customElementsDefined) return;
    withReactions(() => {
      for (const el of root.querySelectorAll('*')) {
        const custom = customOf.get(el);
        if (custom && custom.state !== 'undefined') continue;
        const registry = registryOf(el);
        if (!registry || (!stateOf(registry).scoped && !el.isConnected)) {
          continue;
        }
        const def = definitionFor(el);
        if (def) enqueueUpgrade(el, def);
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
      const made = runConstructor(def);
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
    if (!target) return null;
    const active = activeConstructors.get(target);
    const registry = active ? active[active.length - 1] : customElements;
    const def = registry ? stateOf(registry).byCtor.get(target) : undefined;
    if (!def) return null;
    const stack = def.stack;
    if (!stack.length) {
      // in the document of the window whose constructor it is (HTML 3.2.3,
      // the current global object's): a frame's, for a definition of its
      // window's registry, where a frame here runs in this realm
      const home = stateOf(registry).home() ?? document;
      const el = wrap(
        Number(call('create', 'element', def.localName, home._id, '')),
      );
      Object.setPrototypeOf(el, target.prototype);
      pinRegistry(el, registry);
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
  const createCustom = (
    local: string,
    is: string | null,
    registry: Any,
    doc: Any,
  ): Any => {
    const def = lookUp(registry, local, is);
    if (!def) return null;
    if (def.localName === def.name) {
      try {
        const made = runConstructor(def);
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
              : made.ownerDocument !== doc
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
        const el = wrap(Number(call('create', 'element', local, doc._id, '')));
        Object.setPrototypeOf(el, HTMLUnknownElement.prototype);
        pinRegistry(el, registry);
        customFor(el).state = 'failed';
        return el;
      }
    }
    const el = wrap(Number(call('create', 'element', local, doc._id, '')));
    pinRegistry(el, registry);
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
    /** A scoped registry (HTML 4.13.4): its definitions are its own, for
     *  the elements and the shadow roots made with it. */
    constructor() {
      registryStates.set(this, {
        definitions: new Map(),
        byCtor: new Map(),
        waiting: new Map(),
        defining: false,
        scoped: true,
        home: () => document,
        documents: new Set(),
        used: false,
      });
      registriesMatter = true;
    }
    /** HTML 4.13.4, `define()`. */
    define(name: Any, ctor: Any, options?: Any): void {
      const state = stateOf(this);
      const { definitions } = state;
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
      if (state.byCtor.has(ctor)) {
        fail(
          'this constructor has already been used with this registry',
          'NotSupportedError',
        );
      }
      let local = n;
      const extending = options?.extends;
      if (extending !== undefined && extending !== null) {
        // a scoped registry defines no customized built-in
        if (state.scoped) {
          fail(
            'a scoped registry cannot define a customized built-in element',
            'NotSupportedError',
          );
        }
        local = str(extending);
        if (customName(local) || !/^[a-z][a-z0-9]*$/.test(local)) {
          fail(
            `"${local}" is not an HTML element to extend`,
            'NotSupportedError',
          );
        }
      }
      if (state.defining) {
        fail(
          'this registry is already defining an element',
          'NotSupportedError',
        );
      }
      state.defining = true;
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
          registry: this,
        };
      } finally {
        state.defining = false;
      }
      definitions.set(n, def);
      state.byCtor.set(ctor, def);
      customElementsDefined = true;
      takesNotes = true;
      withReactions(() => {
        // the elements of the name whose registry this is, connected in its
        // window's document, or, for a scoped one, in each document of its
        // scoped document set in the order they joined it, each in tree
        // order (HTML 4.13.4, `define()`)
        call('ceDefine', n, local);
        const docs = state.scoped ? [...state.documents] : [state.home()];
        for (const doc of docs) {
          if (!doc) continue;
          for (const id of idList(call('ceDefine', n, local, doc._id))) {
            const el = wrap(id);
            if (registryOf(el) === this) enqueueUpgrade(el, def);
          }
        }
        const waiting = state.waiting.get(n);
        if (waiting) {
          state.waiting.delete(n);
          waiting.resolve(ctor);
        }
      });
    }
    get(name: Any): Any {
      return stateOf(this).definitions.get(str(name))?.ctor;
    }
    getName(ctor: Any): string | null {
      return stateOf(this).byCtor.get(ctor)?.name ?? null;
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
      const state = stateOf(this);
      const def = state.definitions.get(n);
      if (def) return Promise.resolve(def.ctor);
      let waiting = state.waiting.get(n);
      if (!waiting) {
        let resolve: Any;
        const promise = new Promise((ok) => (resolve = ok));
        state.waiting.set(n, (waiting = { promise, resolve }));
      }
      return waiting.promise;
    }
    /**
     * Make this the registry of a document or a shadow root that has none,
     * and of every element in it that has none, and upgrade those it has a
     * definition for (HTML 4.13.4, `initialize()`).
     */
    initialize(root: Any): void {
      if (!root || typeof root.nodeType !== 'number') {
        throw new TypeError(
          "Failed to execute 'initialize' on 'CustomElementRegistry': parameter 1 is not of type 'Node'.",
        );
      }
      const fail = (message: string): never => {
        throw new DOMException(
          `Failed to execute 'initialize' on 'CustomElementRegistry': ${message}`,
          'NotSupportedError',
        );
      };
      // the window's own registry is its document's alone, and is never a
      // document's by initializing (HTML 4.13.4)
      const isDocument = root.nodeType === 9;
      const scoped = stateOf(this).scoped;
      if (!scoped && isDocument) fail('The registry is not scoped.');
      const owner = isDocument ? root : root.ownerDocument;
      if (!scoped && owner !== document) {
        fail("The root is not this registry's document's.");
      }
      // what has no registry takes this one, and what has one keeps it:
      // the root, where it is a document or a shadow root, and every
      // element in its tree, itself among them
      if (isDocument) {
        if (documentRegistryOf(root) === null) {
          documentRegistries.set(root, this);
          noteScoped(this);
        }
      } else if (root instanceof ShadowRoot) {
        if (shadowRegistryOf(root) === null) setShadowRegistry(root, this);
      }
      const elements = Array.from(root.querySelectorAll?.('*') ?? []) as Any[];
      if (root.nodeType === 1) elements.unshift(root);
      withReactions(() => {
        for (const el of elements) {
          // one with no registry takes this one, and its document joins a
          // scoped one's scoped document set; one this one already is is
          // tried too; one of another registry is that one's
          const was = registryOf(el);
          if (was === null) {
            pinRegistry(el, this);
            if (scoped) associate(this, el.ownerDocument);
          } else if (was !== this) continue;
          const custom = customOf.get(el);
          if (custom && custom.state !== 'undefined') continue;
          // "try to upgrade" (HTML 4.13.6): the definition this registry
          // has for it, wherever the element is, connected or not
          if (el.namespaceURI !== HTML_NS) continue;
          const def = lookUp(this, el.localName, el.getAttribute('is'));
          if (def) enqueueUpgrade(el, def);
        }
      });
    }
    /** Every element in `root` that has a definition and was not upgraded,
     *  upgraded, in shadow-including tree order. */
    upgrade(root: Any): void {
      const id = idOf(root);
      if (!customElementsDefined) return;
      withReactions(() => {
        for (const found of idList(call('ceCandidates', id))) {
          const el = wrap(found);
          // an element of another registry is that registry's to upgrade
          if (registryOf(el) !== this) continue;
          const custom = customOf.get(el);
          if (custom && custom.state !== 'undefined') continue;
          const def = definitionFor(el);
          if (def) enqueueUpgrade(el, def);
        }
      });
    }
  }
  // the window's own, which every element of its document has but where a
  // scoped one is named
  /** A window's registry, global rather than scoped (HTML 4.13.4), whose
   *  window's document is `home`'s. */
  const globalRegistry = (home: () => Any = () => document): Any => {
    const registry = new CustomElementRegistry();
    const state = stateOf(registry);
    state.scoped = false;
    state.home = home;
    return registry;
  };
  const customElements = globalRegistry();
  // the window's own is no registry a page made
  registriesMatter = false;

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
    // the element's own, closed or open (HTML 4.13.7.4)
    get shadowRoot(): Any {
      return wrap(Number(call('shadowRoot', this._el._id, true)));
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
    /** The range, as this realm last had it; `_range` reads it current. */
    _kept: Any = null;
    _backward = false;
    _told = false;
    /** The range, with the reader's selection taken in first where they
     *  selected something since this realm last heard of it or set it: a
     *  press and a drag in the document select, and the page's selection
     *  is that one (Selection API 2). */
    get _range(): Any {
      const told = call('documentSelection');
      // none is no news: core lets its highlight go at a press or a key,
      // where the page's selection, a caret an edit is made at, stands
      if (!told) return this._kept;
      const [sc, so, ec, eo] = JSON.parse(str(told));
      const range = document.createRange();
      try {
        range.setStart(wrap(sc), so);
        range.setEnd(wrap(ec), eo);
      } catch {
        return this._kept;
      }
      this._kept = range;
      this._backward = false;
      this._changed();
      return range;
    }
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
      this._kept = range;
      this._backward = backward;
      this._changed();
      // and drawn as the reader's is, where it is the document's; a caret
      // draws nothing, and leaves the reader's selection none
      const drawn =
        range &&
        !range.collapsed &&
        range.startContainer.getRootNode() === document;
      call(
        'setDocumentSelection',
        drawn
          ? JSON.stringify([
              range.startContainer._id,
              range.startOffset,
              range.endContainer._id,
              range.endOffset,
            ])
          : '',
      );
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
    /** A move of the focus by a letter or a word through the text the
     *  document draws, from one text node on into the next; a coarser one
     *  moves nothing here. */
    modify(alter: Any, direction: Any, granularity: Any): void {
      const node = this.focusNode;
      const unit = String(granularity).toLowerCase();
      if (!node || (unit !== 'character' && unit !== 'word')) return;
      const back = direction === 'backward' || direction === 'left';
      const extend = String(alter).toLowerCase() === 'extend';
      const moved = call('movePoint', idOf(node), this.focusOffset, unit, back);
      if (moved) {
        const [id, offset] = JSON.parse(str(moved));
        const to = wrap(id);
        if (extend) this.extend(to, offset);
        else this.collapse(to, offset);
        return;
      }
      // a document drawn nowhere: a letter within the focus's text
      if (node.nodeType !== 3 || unit !== 'character') return;
      const to = Math.max(
        0,
        Math.min(node.data.length, this.focusOffset + (back ? -1 : 1)),
      );
      if (extend) this.extend(node, to);
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
    TransitionEvent,
    AnimationEvent,
    MouseEvent,
    PointerEvent,
    KeyboardEvent,
    InputEvent,
    SubmitEvent,
    CustomEvent,
    ErrorEvent,
    HashChangeEvent,
    PageTransitionEvent,
    StorageEvent,
    CookieStore,
    BeforeUnloadEvent,
    PageSwapEvent,
    PageRevealEvent,
    PopStateEvent,
    Navigation,
    NavigationHistoryEntry,
    NavigationDestination,
    NavigateEvent,
    NavigationCurrentEntryChangeEvent,
    NavigationTransition,
    NavigationActivation,
    ToggleEvent,
    AnimationPlaybackEvent,
    AnimationEffect,
    KeyframeEffect,
    AnimationTimeline,
    DocumentTimeline,
    ScrollTimeline,
    ViewTimeline,
    Animation,
    CSSAnimation,
    CSSTransition,
    CSSStyleValue,
    CSSNumericValue,
    CSSUnitValue,
    CSSKeywordValue,
    CSSMathValue,
    CSSMathSum,
    CSSMathProduct,
    CSSMathNegate,
    CSSMathInvert,
    CSSMathMin,
    CSSMathMax,
    CSSNumericArray,
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
    Document: DocumentConstructor,
    HTMLDocument: Document,
    XMLDocument,
    AbstractRange,
    Range,
    StaticRange,
    Highlight,
    HighlightRegistry,
    ViewTransition,
    ViewTransitionTypeSet,
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
    MediaError,
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
    DOMStringMap,
    ...GEOMETRY.classes,
    NodeList,
    HTMLCollection,
    URL,
    URLSearchParams,
    Headers,
    WheelEvent,
    Worker,
    SharedWorker,
    ImageData,
    CanvasRenderingContext2D,
    OffscreenCanvas,
    OffscreenCanvasRenderingContext2D,
    ImageBitmap,
    ImageBitmapRenderingContext,
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
    FragmentDirective,
    MediaQueryList,
    MediaQueryListEvent,
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
    UserActivation,
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
    ReadableStreamBYOBReader,
    ReadableStreamDefaultController,
    ReadableByteStreamController,
    ReadableStreamBYOBRequest,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    TransformStream,
    TransformStreamDefaultController,
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
    CSSViewTransitionRule,
    CSSPositionTryRule,
    CSSPositionTryDescriptors,
  };
  // and their interfaces with it, which a page tells a service worker by
  if (serviceWorkersOn) {
    Object.assign(classes, {
      ServiceWorker,
      ServiceWorkerRegistration,
      ServiceWorkerContainer,
    });
  }
  for (const [name, value] of Object.entries(classes)) {
    // an interface's prototype says its name to `Object.prototype.toString`
    // (Web IDL 3.7.3), so a `<div>` is `[object HTMLDivElement]`
    const proto = typeof value === 'function' ? value.prototype : null;
    if (
      proto &&
      value.name === name &&
      !Object.prototype.hasOwnProperty.call(proto, Symbol.toStringTag)
    ) {
      Object.defineProperty(proto, Symbol.toStringTag, {
        value: name,
        configurable: true,
      });
    }
    define(name, value);
  }

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
  define('navigation', navigation);
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
  // a secure context's alone (Cookie Store API, `[SecureContext]`)
  {
    let here: Any = null;
    try {
      here = new URL(str(call('location')));
    } catch {
      // a realm with no address of its own is no secure context
    }
    if (
      here &&
      (here.protocol === 'https:' ||
        /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(here.hostname) ||
        here.hostname.endsWith('.localhost'))
    ) {
      define('cookieStore', new CookieStore());
    }
  }
  const localArea = storage('local');
  const sessionArea = storage('session');
  define('localStorage', localArea);
  define('sessionStorage', sessionArea);
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
  cssNamespace = {
    ...unitFactories,
    escape: (v: Any) => cssEscape(str(v)),
    highlights: highlightRegistry,
    registerProperty,
    // what `<Html>` answers an `@supports` with: false only where it knows
    // a property it does not draw, and true for the rest, as the modern
    // engine a page tests for. vercel.com sent an engine that answered
    // false to `var()` to its old-browser page.
    supports: (...args: Any[]): boolean =>
      call(
        'supports',
        args.length >= 2 ? `(${str(args[0])}: ${str(args[1])})` : str(args[0]),
      ) === true,
  };
  define('CSS', cssNamespace);
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
  getter('scrollX', () => viewport(true).scrollX);
  getter('scrollY', () => viewport(true).scrollY);
  getter('pageXOffset', () => viewport(true).scrollX);
  getter('pageYOffset', () => viewport(true).scrollY);
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
  define('visualViewport', visualOf(ownViewport));
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
    // a relative scroll, which a snapping root snaps the way it went
    call(
      'scrollTo',
      v.scrollX + (Number(by.left) || 0),
      v.scrollY + (Number(by.top) || 0),
      undefined,
      true,
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
  define('requestAnimationFrame', requestFrame);
  define('cancelAnimationFrame', cancelFrame);
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
  // what the options transfer is given up once it is copied, as a
  // `postMessage`'s is
  define('createImageBitmap', createImageBitmap);
  define('structuredClone', (value: Any, options: Any = undefined) => {
    const { data } = cloneMoving(value, transferListOf(options));
    giveUp(options);
    return data;
  });
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
    // a frame of this document's that the name names: navigated as its own
    // session has it, and its window handed back (HTML 7.2.2.1)
    const framed = namedFrame(name);
    if (framed) {
      if (url) {
        const href = String(call('resolve', str(url)));
        navigateTo(
          framed.session,
          href,
          pushOrReplace(framed.session, href, false),
          {
            userInitiated: false,
            sourceElement: null,
            hostFollows: false,
          },
        );
      }
      return frameProxyOf(framed.frame);
    }
    // this window: a navigation of its own, which the page hears first
    if (/^_self$/i.test(name) && url) {
      const s = pageSession.session;
      const href = String(call('resolve', str(url)));
      const went = navigateTo(s, href, pushOrReplace(s, href, false), {
        userInitiated: false,
        sourceElement: null,
        hostFollows: true,
      });
      if (went === 'other') call('open', href, name);
      return G;
    }
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
  const postTo = (
    to: Any,
    message: Any,
    options?: Any,
    transfer?: Any,
  ): void => {
    // the target origin checked first, which may throw, and matched only
    // once the message is copied and its transfer given up (HTML 9.4.3)
    const allowed = originAllowed(options);
    const list = transferListOf(
      options !== null && typeof options === 'object' ? options : transfer,
    );
    const { data, ports } = cloneMoving(message, list);
    giveUp(
      options !== null && typeof options === 'object' ? options : transfer,
    );
    if (!allowed) return;
    setTimer(
      () => {
        const ev = new MessageEvent('message', {
          data,
          origin: location.origin,
          source: G,
          ports,
        });
        ev.isTrusted = true;
        dispatch(to, ev);
      },
      0,
      [],
      false,
    );
  };
  define('postMessage', (message: Any, options?: Any, transfer?: Any) =>
    postTo(windowTarget, message, options, transfer),
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
    'scrollend',
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
    'pageswap',
    'pagereveal',
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

  /** WebTransport's entries, registered once `entry` is there. */
  const transportEntries: [string, () => Primitive][] = [];

  // --- WebTransport -------------------------------------------------------------------
  //
  // W3C WebTransport (`webtransport.ts`), over this realm's streams, its
  // sessions the host's (`transports.ts`, the `wt…` ops and `__wt…`
  // entries). In a secure context only, as Web IDL's `[SecureContext]` has
  // it: a page served over plain `http:` from anywhere but this machine has
  // no `WebTransport` to feature-detect.
  {
    const interfaces = transport({
      call: call as Any,
      // its entries are registered with the rest, below
      entry: (name: string, fn: () => Primitive) => {
        transportEntries.push([name, fn]);
      },
      input: () => input(),
      DOMException,
      Headers,
      immutableHeaders: (pairs: [string, string][]) =>
        guardedHeaders(pairs, 'immutable'),
      URL,
      setTimer: (fn: () => void, ms: number) => setTimer(fn, ms, [], false),
      streams: streamInternals,
      ReadableStream,
      WritableStream,
      WritableStreamDefaultWriter,
      bytesOfBase64,
      base64OfBytes,
    });
    const protocol = str(location.protocol);
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/i.test(
      str(location.hostname),
    );
    if (protocol !== 'http:' || loopback) {
      for (const name of Object.getOwnPropertyNames(interfaces)) {
        define(name, interfaces[name]);
      }
    }
  }

  // --- WebSocket ---------------------------------------------------------------------
  //
  // The WHATWG WebSockets standard (`websocket.ts`), its connections the
  // host's (`sockets.ts`, the `ws…` ops and `__ws…` entries). A window's and
  // a worker's alike, and in any context, secure or not.
  {
    const trusted = (target: Any, event: Any): void => {
      event.isTrusted = true;
      dispatch(target, event);
    };
    const interfaces = socket({
      call: call as Any,
      entry: (name: string, fn: () => Primitive) => {
        transportEntries.push([name, fn]);
      },
      input: () => input(),
      DOMException,
      EventTarget,
      Event,
      MessageEvent,
      Blob,
      URL,
      base: () =>
        workerLocation ? str(workerLocation.href) : str(document.baseURI),
      fire: trusted,
      base64OfBytes,
      bytesOfBase64,
    });
    for (const name of Object.getOwnPropertyNames(interfaces)) {
      define(name, interfaces[name]);
    }
  }

  // --- WebRTC and media capture -------------------------------------------------
  //
  // WebRTC 1.0 (`webrtc.ts`, `datachannel.ts`) and Media Capture and Streams
  // (`mediastream.ts`), their connections and sources the host's (`peers.ts`
  // and `media-sources.ts`: the `rtc…` and `md…` ops and their entries). A
  // window's: a worker's global loses them (`WINDOW_ONLY`). Only a secure
  // context has `navigator.mediaDevices`, as `[SecureContext]` has it.
  {
    const trusted = (target: Any, event: Any): void => {
      event.isTrusted = true;
      dispatch(target, event);
    };
    const later = (name: string, fn: () => Primitive) => {
      transportEntries.push([name, fn]);
    };
    const secure =
      str(location.protocol) === 'https:' ||
      /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/i.test(
        str(location.hostname),
      );
    const media = mediaStreams({
      call: call as Any,
      entry: later,
      input: () => input(),
      DOMException,
      EventTarget,
      Event,
      fire: trusted,
      secure,
    });
    canvasCapture = media.internals.captureCanvas;
    const audio = webaudio({
      call: call as Any,
      DOMException,
      EventTarget,
      Event,
      fire: trusted,
      setTimer: (fn: () => void, ms: number) => setTimer(fn, ms, [], false),
      now,
      MediaStream: media.interfaces.MediaStream,
      track: media.internals.track,
      isStream: media.internals.isStream,
      isTrack: media.internals.isTrack,
    });
    for (const name of Object.getOwnPropertyNames(audio)) {
      define(name, audio[name]);
    }
    let rtc: Any = null;
    const channels = dataChannels({
      call: call as Any,
      entry: later,
      input: () => input(),
      DOMException,
      EventTarget,
      Event,
      MessageEvent,
      Blob,
      fire: trusted,
      bytesOfBase64,
      base64OfBytes,
      errorEvent: (detail: Any, message: string) =>
        new rtc.RTCErrorEvent('error', {
          error: new rtc.RTCError(detail, message),
        }),
      later: (fn: () => void) => setTimer(fn, 0, [], false),
    });
    dataChannelsOf = channels;
    rtc = webrtc({
      call: call as Any,
      entry: later,
      input: () => input(),
      DOMException,
      EventTarget,
      Event,
      fire: trusted,
      setTimer: (fn: () => void, ms: number) => setTimer(fn, ms, [], false),
      URL,
      bytesOfBase64,
      media: media.internals,
      channels,
      transports: rtcTransports,
    });
    for (const name of Object.getOwnPropertyNames(media.interfaces)) {
      define(name, media.interfaces[name]);
    }
    for (const name of Object.getOwnPropertyNames(rtc)) define(name, rtc[name]);
    if (media.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        get: () => media.mediaDevices,
        enumerable: true,
        configurable: true,
      });
    }
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
        taskEpoch += 1;
        try {
          // what the host changed on its own since the page last did
          if (takesNotes) takeReactions();
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
  for (const [name, fn] of transportEntries) entry(name, fn);

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
  // the parser put nodes in the document since a script ran — the host
  // has noted them for the page's observers (`parserInserted`), and the
  // entry has run what its custom elements owe
  entry('__mutated', () => {
    mutated();
    return true;
  });

  // an event `<Html>` was told of, dispatched as the browser would, and
  // whether its default goes on
  /** The element the pointer is over, as its moves were told: what it
   *  leaves when it moves onto another (UI Events 4.3.3). */
  let hovered: Any = null;
  entry('__event', () => {
    const e = input();
    // a user's press or key has used the page (HTML 6.4.1, "activation
    // triggering input event")
    if (
      e.type === 'mousedown' ||
      (e.type === 'keydown' && e.key !== 'Escape')
    ) {
      stickyActivation = true;
      lastActivation = now();
    }
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
        const go = dispatch(
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
        // the rest of a click's default is the host's, and a popover's
        // invoker this one's, and a link's `navigate` the page's first
        if (go && e.type === 'click' && (e.button ?? 0) === 0) {
          popoverActivation(target);
          const anchor = target.closest?.('a[href], area[href]');
          if (anchor && !followLink(anchor, true)) return false;
        }
        return go;
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
        // a press and its release outside the open popovers and dialogs
        // dismiss them (HTML 6.12, 4.11.4)
        if (type === 'pointerdown' || type === 'pointerup') {
          lightDismiss(type, to, at.clientX, at.clientY);
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
        // Escape the page let be is a close request, at the last popover or
        // dialog to have opened (HTML 7.7.2)
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
      // text the user selected in a field (HTML 4.10.5.2.10)
      case 'select':
        return dispatch(
          target,
          trusted(new Event('select', { bubbles: true })),
        );
      case 'submit': {
        const submitter = e.submitter ? wrap(e.submitter) : null;
        const go = dispatch(
          target,
          trusted(
            new SubmitEvent('submit', {
              bubbles: true,
              cancelable: true,
              submitter,
            }),
          ),
        );
        // the submission is this realm's to make, once the page's
        // `navigate` lets it go, and the host's own is stopped
        if (go) submitForm(target, submitter, true);
        return false;
      }
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
    // the side of the thread it came from, and a message along a wire on
    // it, to the port across it here
    const across = id === 0 ? UP : threadAcross(Number(id));
    if (canvasFrame(across, str(text))) return true;
    if (wireMessage(across, str(text))) return true;
    // a shared worker's, to the port of its connection
    if ((id === 0 && sharedRealm) || sharedWorkersOf.has(id)) {
      return sharedMessage(str(text), across);
    }
    // a service worker's, its lifecycle or to the page's container
    if (swWorkers.has(id)) return swHeard(id, str(text));
    // and in a service worker, from its client (Service Workers 1, 4.2.7)
    if (id === 0 && serviceRealm) {
      let made: Any;
      try {
        made = deserializeWith(str(text), across);
      } catch {
        const ev = new ExtendableMessageEvent('messageerror', {
          source: clientOf(),
        });
        ev.isTrusted = true;
        dispatch(windowTarget, ev);
        return true;
      }
      const ev = new ExtendableMessageEvent('message', {
        data: made.data,
        origin: new URL(serviceRealm.client).origin,
        source: clientOf(),
        ports: made.ports,
      });
      ev.isTrusted = true;
      dispatch(windowTarget, ev);
      ev._open = false;
      return true;
    }
    const target = id === 0 ? windowTarget : workers.get(id);
    if (!target) return false;
    let made: Any;
    try {
      made = deserializeWith(str(text), across);
    } catch {
      const ev = new MessageEvent('messageerror', {});
      ev.isTrusted = true;
      dispatch(target, ev);
      return true;
    }
    const ev = new MessageEvent('message', {
      data: made.data,
      origin: '',
      ports: made.ports,
    });
    ev.isTrusted = true;
    dispatch(target, ev);
    return true;
  });

  // a service worker's script has run, or failed to (Service Workers 1,
  // "Install"): the page told it is installing, `install`, and once what
  // it waited on settles, installed, activating, `activate` and activated
  entry('__serviceInstall', () => {
    const [ran] = input();
    if (!serviceRealm) return false;
    const tell = (sw: string): void => {
      call('workerPostOut', JSON.stringify({ sw }));
    };
    if (!ran) {
      tell('failed');
      return true;
    }
    tell('installing');
    const lifetime = (type: string): Promise<boolean> => {
      const ev = new ExtendableEvent(type);
      ev.isTrusted = true;
      dispatch(windowTarget, ev);
      return Promise.all(ev._waits).then(
        () => {
          ev._open = false;
          return true;
        },
        () => {
          ev._open = false;
          return false;
        },
      );
    };
    void lifetime('install').then((installed) => {
      if (!installed) {
        tell('redundant');
        return undefined;
      }
      tell('installed');
      tell('activating');
      return lifetime('activate').then(() => tell('activated'));
    });
    return true;
  });

  // what a worker's script threw that nothing there caught, to its `Worker`
  entry('__workerError', () => {
    const [id, message, filename, lineno, colno] = input();
    const targets = sharedWorkersOf.get(id) ?? [
      workers.get(id) ?? swWorkers.get(id),
    ];
    let told = false;
    for (const target of targets) {
      if (!target) continue;
      const ev = new ErrorEvent('error', {
        message: str(message),
        filename: str(filename),
        lineno: Number(lineno) || 0,
        colno: Number(colno) || 0,
        cancelable: true,
      });
      ev.isTrusted = true;
      dispatch(target, ev);
      told = true;
    }
    return told;
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
    const { url, name, shared, service } = input();
    // a worker's navigator has no container of the page's
    delete (navigator as Any).serviceWorker;
    GEOMETRY.worker();
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
    define('name', str(name));
    if (shared) {
      // a shared worker's global hears connections, and posts on their
      // ports alone (HTML 10.2.1.3)
      sharedRealm = true;
      try {
        delete (G as Any).postMessage;
      } catch {}
      define('SharedWorkerGlobalScope', scope('SharedWorkerGlobalScope'));
      Object.defineProperty(G, 'onconnect', {
        get: () => windowTarget._handlers?.connect ?? null,
        set: (fn: Any) => {
          windowTarget._handlers ??= {};
          windowTarget._handlers.connect = typeof fn === 'function' ? fn : null;
        },
        configurable: true,
      });
    } else if (service) {
      // a service worker's global is installed and activated, hears its
      // client, and posts to it alone (Service Workers 1, 4.1)
      serviceRealm = { scope: str(service.scope), client: str(service.client) };
      try {
        delete (G as Any).postMessage;
      } catch {}
      define('ServiceWorkerGlobalScope', scope('ServiceWorkerGlobalScope'));
      define('ExtendableEvent', ExtendableEvent);
      define('ExtendableMessageEvent', ExtendableMessageEvent);
      define('Client', Client);
      define('WindowClient', WindowClient);
      define('Clients', Clients);
      define('clients', new Clients());
      define('skipWaiting', () => Promise.resolve());
      const own = serviceRealm.scope;
      define('registration', {
        scope: own,
        installing: null,
        waiting: null,
        active: null,
        updateViaCache: 'imports',
        update: () => Promise.resolve(),
        unregister: () => Promise.resolve(true),
        addEventListener() {},
        removeEventListener() {},
      });
      for (const type of [
        'install',
        'activate',
        'message',
        'messageerror',
        'fetch',
      ]) {
        Object.defineProperty(G, `on${type}`, {
          get: () => windowTarget._handlers?.[type] ?? null,
          set: (fn: Any) => {
            windowTarget._handlers ??= {};
            windowTarget._handlers[type] = typeof fn === 'function' ? fn : null;
          },
          configurable: true,
        });
      }
    } else {
      define('DedicatedWorkerGlobalScope', scope('DedicatedWorkerGlobalScope'));
      // a dedicated worker's animation frames (HTML 8.10), which a worker
      // drawing on an `OffscreenCanvas` paces itself by: one every
      // sixtieth of a second while a callback waits, on the worker's own
      // clock, its frames reaching the page as each task ends
      const frameCallbacks = new Map<number, Any>();
      let frameSeq = 0;
      let frameTimer = 0;
      const FRAME_MS = 1000 / 60;
      const runFrame = (): void => {
        frameTimer = 0;
        const due = [...frameCallbacks];
        frameCallbacks.clear();
        const t = now();
        for (const [, fn] of due) {
          try {
            fn(t);
          } catch (error) {
            report(error);
          }
        }
      };
      define(
        'requestAnimationFrame',
        function requestAnimationFrame(fn: Any): number {
          if (typeof fn !== 'function') {
            throw new TypeError(
              "Failed to execute 'requestAnimationFrame' on 'DedicatedWorkerGlobalScope': The callback provided as parameter 1 is not a function.",
            );
          }
          const id = ++frameSeq;
          frameCallbacks.set(id, fn);
          if (!frameTimer) {
            frameTimer = setTimer(
              runFrame,
              FRAME_MS - (now() % FRAME_MS),
              [],
              false,
            );
          }
          return id;
        },
      );
      define(
        'cancelAnimationFrame',
        function cancelAnimationFrame(id: Any): void {
          frameCallbacks.delete(Number(id));
        },
      );
      define(
        'postMessage',
        function postMessage(message: Any, transfer?: Any): void {
          const later: Array<() => void> = [];
          const text = serializeClone(message, undefined, {
            across: UP,
            moving: transfersOf(transferListOf(transfer)),
            later,
          });
          giveUp(transfer);
          call('workerPostOut', text);
          for (const go of later) go();
        },
      );
    }
    define('close', function close(): void {
      call('workerClose');
    });
    // each script fetched and run in turn, before this returns (HTML
    // 10.3.4): the host waits for it, the thread it is in being the
    // worker's own
    define('importScripts', function importScripts(...urls: Any[]): void {
      for (const u of urls) {
        const href = new URL(str(u), workerLocation!.href).href;
        // run by the host as a script of its own; what it threw is left at
        // `__thrown`, and thrown on to the caller here
        const ran = call('importScript', href);
        if (ran === 'threw') {
          const error = G.__thrown;
          G.__thrown = undefined;
          throw error;
        }
        if (ran !== 'ran') {
          throw new DOMException(
            `Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '${href}' failed to load.`,
            'NetworkError',
          );
        }
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

  // a blob `createImageBitmap` was handed, decoded by the host: its size
  // and its pixels, or '' where it is no image
  entry('__imageDecoded', () => {
    const [id, size, data] = input();
    const done = imageDecodes.get(id);
    if (!done) return false;
    imageDecodes.delete(id);
    done(str(size), str(data));
    return true;
  });

  // what came of a `document.fonts` load, and the faces settled
  entry('__fontsLoaded', () => {
    const [id, loaded] = input();
    const done = fontLoads.get(id);
    if (!done) return false;
    fontLoads.delete(id);
    done(Array.isArray(loaded) ? loaded : []);
    return true;
  });
  entry('__fontsSettled', () => {
    const [id] = input();
    const done = fontSettles.get(id);
    if (!done) return false;
    fontSettles.delete(id);
    done();
    return true;
  });

  // what came of a `fetch`
  entry('__fetched', () => {
    const [id, answer] = input();
    const pending = fetches.get(id);
    if (!pending) return false;
    fetches.delete(id);
    if (typeof answer === 'string') pending.reject(new TypeError(answer));
    else if (pending.streamed && answer.status === 401) {
      // and a body on its way is let go
      if (answer.streaming) call('abortFetch', id);
      pending.reject(new TypeError('Failed to fetch'));
    } else {
      // a body that is still arriving is a stream the host feeds; the
      // network's bytes otherwise, which cross as base64: a string is all
      // that crosses, and one of raw bytes is mostly escapes once it is JSON
      const body = answer.streaming
        ? new ReadableStream({
            start(controller: Any) {
              fetchBodies.set(id, controller);
            },
            cancel() {
              if (fetchBodies.delete(id)) call('abortFetch', id);
            },
          })
        : typeof answer.base64 === 'string'
          ? ''
          : answer.body;
      const response = new Response(body, {
        status: answer.status,
        statusText: answer.statusText,
        headers: answer.headers,
        url: answer.url,
        redirected: answer.redirected,
        type: answer.type ?? 'basic',
      });
      if (typeof answer.base64 === 'string') {
        response._raw = bytesOfBase64(answer.base64);
      }
      pending.resolve(response);
    }
    return true;
  });

  // a body's chunk, and its end, as they arrive
  entry('__fetchChunk', () => {
    const [id, base64] = input();
    const body = fetchBodies.get(id);
    if (!body) return false;
    body.enqueue(bytesOfBase64(base64));
    return true;
  });
  entry('__fetchEnd', () => {
    const [id, failed] = input();
    const body = fetchBodies.get(id);
    if (!body) return false;
    fetchBodies.delete(id);
    if (failed) body.error(new TypeError(failed));
    else body.close();
    return true;
  });

  // a viewport this realm watches moved — the pane, a frame's box — or
  // answers a media query from something else (`DomHost.renderingMoved`):
  // a frame, whose steps tell the page
  entry('__rendering', () => {
    renderingOwed = true;
    wantFrame();
    return true;
  });

  // another document of the origin changed its storage (HTML 12.2.4): a
  // task at the window, which the document that changed it does not hear
  entry('__storage', () => {
    const [kind, key, oldValue, newValue, url] = input();
    dispatch(
      windowTarget,
      new StorageEvent('storage', {
        key,
        oldValue,
        newValue,
        url,
        storageArea: kind === 'session' ? sessionArea : localArea,
      }),
    );
    return true;
  });

  // what the host's read of a media element's source came to
  entry('__media', () => {
    const [id, load, kind, a, b, c] = input();
    const el = wrap(id);
    if (el) mediaHeard(el, Number(load), String(kind), a, b, c);
    return true;
  });

  // what the player of a media element's source said
  entry('__player', () => {
    const [id, src, kind, value] = input();
    const el = wrap(id);
    if (el) mediaPlayed(el, String(src), String(kind), String(value));
    return true;
  });

  // where the document has got to: `DOMContentLoaded`, then `load`
  entry('__ready', () => {
    const [state] = input();
    document._ready = state;
    // the size the first resize steps compare with, where no frame took it
    if (state === 'interactive') watchViewport(ownViewport);
    // the media the markup made select a source, as each would have as
    // the parser put it in (HTML 4.8.11.5), but one that loads nothing
    // until it is played
    if (state === 'interactive' && mediaLoads()) {
      for (const el of document.querySelectorAll('video, audio')) {
        if (
          askOf(el).network === 0 &&
          el.getAttribute('preload')?.toLowerCase() !== 'none' &&
          (el.hasAttribute('src') || el.querySelector('source'))
        ) {
          mediaSelect(el);
        }
      }
    }
    const change = new Event('readystatechange');
    change.isTrusted = true;
    dispatch(document, change);
    if (state === 'interactive') {
      const ev = new Event('DOMContentLoaded', { bubbles: true });
      ev.isTrusted = true;
      dispatch(document, ev);
      // revealed at its first frame, now that the scripts the parser met
      // have run and are listening (`revealOwed`)
      revealOwed = true;
      wantFrame();
    } else if (state === 'complete') {
      const ev = new Event('load');
      ev.isTrusted = true;
      dispatch(windowTarget, ev);
      completelyLoaded = true;
      // and shown, after its `load` (HTML 8.4, "the end")
      if (!document._pageShowing && !document._unloaded) {
        document._pageShowing = true;
        dispatch(
          windowTarget,
          asTrusted(
            new PageTransitionEvent('pageshow', {
              persisted: false,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
      }
    }
    return true;
  });

  // the host is about to leave the document: whether it may
  // (`ScriptRunner.beforeUnload`)
  entry('__beforeUnload', () =>
    unloadAllowed(document, windowTarget) ? 'leave' : 'stay',
  );
  // the document is going, its engine with it (`ScriptRunner.dispose`)
  entry('__unload', () => {
    // the document shown in its place, where there is one: what its
    // `pageswap` is told
    const [swap] = input() ?? [];
    unloadTree(
      document,
      windowTarget,
      swap && typeof swap === 'object' ? () => firePageSwap(swap) : undefined,
    );
    return true;
  });
  // the document goes into the host's back-forward cache, its engine
  // frozen after this (`ScriptRunner.freeze`): told where it goes, as one
  // that unloads is, and hidden. The navigation it left by is the next
  // document's now, and goes nowhere here: one that went on would be
  // aborted as the next navigation from it starts, which it never made.
  entry('__freeze', () => {
    const [swap] = input() ?? [];
    const s = pageSession.session;
    s.ongoing = null;
    s.transition = null;
    hideTree(
      document,
      windowTarget,
      swap && typeof swap === 'object' ? () => firePageSwap(swap) : undefined,
    );
    return true;
  });
  // the document is shown again from the host's back-forward cache, its
  // engine thawed (`ScriptRunner.reactivate`): the session as it is now,
  // `pageshow`, and `pagereveal` at its next frame
  entry('__reactivate', () => {
    const [seed] = input() ?? [];
    if (seed && typeof seed === 'object') {
      reseedSession(pageSession.session, seed);
    }
    showTree(document, windowTarget);
    revealOwed = true;
    wantFrame();
    return true;
  });
  // the host goes to one of the document's own entries, as its Back and
  // Forward do (`HtmlSessionHistory.go`): as `history.go` would, by a
  // user's hand
  entry('__traverseKey', () => {
    const [key] = input();
    const s = pageSession.session;
    const at = s.entries.findIndex((e) => e.key === str(key) && !e.other);
    if (at < 0 || at === s.index) return false;
    traverseTo(s, at, undefined, null, true);
    return true;
  });
  // a frame's document in this realm is going: the host puts another in
  // its place, or its frame left the document
  entry('__unloadDocument', () => {
    const [id] = input();
    const doc = wrap(id);
    if (!doc) return false;
    const target = frameTargets.get(doc);
    if (target) unloadTree(doc, target);
    else doc._unloaded = true;
    return true;
  });

  // a script of a frame's document, the page's own origin's: run here, in
  // the page's realm, with the frame's window and document for the names a
  // script reaches them by — a frame has no realm of its own here, so what
  // it declares is its function's and not a window's (`_frameScripts`) —
  // and the window's own methods a script calls by name, which answer for
  // the frame's viewport and not the page's
  entry('__frameScript', () => {
    const [id, code, url] = input();
    const doc = wrap(id);
    if (!doc) return false;
    const win = windowOfDocument(doc);
    if (!win) return false;
    const own = [
      'matchMedia',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'addEventListener',
      'removeEventListener',
      'dispatchEvent',
    ];
    try {
      new Function(
        'window',
        'self',
        'document',
        'parent',
        'top',
        'frames',
        ...own,
        `${code}\n//# sourceURL=${String(url).replace(/\s/g, '%20')}`,
      ).call(
        win,
        win,
        win,
        doc,
        win.parent,
        win.top,
        win,
        ...own.map((name) => win[name]),
      );
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
    nudgeFrames();
    // in the frame that is coming, where one is, between its resize steps
    // and its media queries (HTML 8.1.7.3), and else as a frame of its own
    if (frameTimer > 0) {
      scrollOwed = true;
      return true;
    }
    const told = tellScroll();
    // and where the scroll moved what the intersection observers observe,
    // at the frame after it
    if (intersecting.size) wantFrame();
    return told;
  });
  // and its scroll over: `scrollend` at the document, which bubbles to the
  // window (CSSOM View 13.1)
  entry('__scrollended', () => {
    if (scrollOwed) tellScroll();
    const ev = new Event('scrollend', { bubbles: true });
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
        postMessage: deliverInto(global, frame, 0),
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
          if (key === 'postMessage') return deliverInto(global, frame, 0);
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
  // The ports it transfers (`moving`, the other realm's) are made here,
  // each at the end of the wire `named` names, back to that realm.
  Object.defineProperty(G, '__message', {
    value: (
      message: Any,
      origin: Any,
      from: Any,
      moving?: Any,
      named?: Any,
    ) => {
      const across = realmAcross(Number(from));
      const seen = new Map<Any, Any>();
      const ports: Any[] = [];
      if (Array.isArray(moving) && Array.isArray(named)) {
        moving.forEach((foreign: Any, i: number) => {
          const port = new MessagePort();
          port._other = wireEnd(across, str(named[i]));
          port._other._other = port;
          seen.set(foreign, port);
          ports.push(port);
        });
      }
      const data = structuredCopy(message, seen);
      const source =
        from === 0 ? (parentLink?.window ?? null) : frameProxyOf(wrap(from));
      setTimer(
        () => {
          const ev = new MessageEvent('message', {
            data,
            origin: str(origin),
            source,
            ports,
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
  // a message along a wire from another realm of this page, to the port
  // across it here: a task of its own, as the message that made the port
  // is (`__message`)
  Object.defineProperty(G, '__wire', {
    value: (from: Any, text: Any) => {
      const across = realmAcross(Number(from));
      const said = str(text);
      setTimer(() => wireMessage(across, said), 0, [], false);
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
    // a scroll container scrolled: the timelines on it move at the next
    // frame
    if (type === 'scroll') nudgeFrames();
    const ev = new Event(String(type));
    ev.isTrusted = true;
    return dispatch(target, ev);
  });

  // the document's CSS transition events, in the order they came about,
  // each at its element, bubbling (CSS Transitions 2, 6.1)
  entry('__cssEvents', () => {
    const [raw] = input();
    const list: Any[] = typeof raw === 'string' && raw ? JSON.parse(raw) : [];
    for (const e of list) {
      const target = wrap(e.element);
      if (!target) continue;
      const ev = String(e.type).startsWith('animation')
        ? new AnimationEvent(e.type, {
            bubbles: true,
            animationName: e.name,
            elapsedTime: e.elapsedTime,
            pseudoElement: e.pseudo,
          })
        : new TransitionEvent(e.type, {
            bubbles: true,
            propertyName: e.name,
            elapsedTime: e.elapsedTime,
            pseudoElement: e.pseudo,
          });
      // the object `getAnimations()` hands out for it, made as it is asked
      // for where the page has not yet
      const objects =
        ev instanceof AnimationEvent
          ? cssAnimationObjects
          : cssTransitionObjects;
      if (!objects.has(e.key)) {
        if (ev instanceof AnimationEvent) cssAnimationsOf(target, false);
        else cssTransitionsOf(target, false);
      }
      ev._animation = objects.get(e.key) ?? null;
      ev.isTrusted = true;
      dispatch(target, ev);
    }
    return true;
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

  // --- native-code `toString` ------------------------------------------------
  //
  // A built-in function reports `function name() { [native code] }` from
  // `Function.prototype.toString` (Web IDL 3.6, and every engine). The DOM
  // here is JavaScript in this realm, so a page that stringified one of its
  // functions — `document.querySelector.toString()` — read that source, and
  // a library that tests a function for nativeness this way (core-js's
  // probes, zone.js) was misled by it. Every function the facade reaches
  // from the global, an interface, a prototype or an API namespace is
  // marked, and a patched `toString` answers a marked function with native
  // source and every page-authored one with its own.
  //
  // Two things keep it safe. The walk reads property descriptors, so it runs
  // no getter and never follows instance data — only prototypes, where the
  // methods are, so the parsed document's tree under `document` is not
  // walked. And the patched function closes over this realm's objects alone
  // (`nativeFns`, the realm's own `toString`), so it hands the page nothing
  // of the host's; the original `toString` is dropped from the prototype
  // with it, as a browser gives no way back to a native function's source.
  {
    const nativeFns = new WeakSet<Any>();
    const seen = new WeakSet<Any>();
    // a function — and, through it, its statics and its prototype
    const markFn = (fn: Any, depth: number): void => {
      if (typeof fn !== 'function' || nativeFns.has(fn)) return;
      nativeFns.add(fn);
      walk(fn, depth);
    };
    // an object's own function members — methods and accessors — without
    // following its data, so an instance's own methods are marked and the
    // parsed tree under `document` is not
    const markMethods = (obj: Any, depth: number): void => {
      if (
        depth < 0 ||
        obj === null ||
        (typeof obj !== 'object' && typeof obj !== 'function')
      ) {
        return;
      }
      let names: (string | symbol)[];
      try {
        names = [
          ...Object.getOwnPropertyNames(obj),
          ...Object.getOwnPropertySymbols(obj),
        ];
      } catch {
        return;
      }
      for (const name of names) {
        // reading any of these off a function throws in strict mode
        if (name === 'caller' || name === 'arguments' || name === 'callee') {
          continue;
        }
        let desc: PropertyDescriptor | undefined;
        try {
          desc = Object.getOwnPropertyDescriptor(obj, name);
        } catch {
          continue;
        }
        if (!desc) continue;
        markFn(desc.get, depth - 1);
        markFn(desc.set, depth - 1);
        markFn(desc.value, depth - 1);
      }
    };
    // an object's methods: its own, and every prototype's up to (not
    // including) Object.prototype — an instance (navigator, document,
    // location) without its data
    const markChain = (obj: Any, depth: number): void => {
      let o: Any = obj;
      let d = depth;
      while (o && o !== Object.prototype && d > 0) {
        markMethods(o, d);
        o = Object.getPrototypeOf(o);
        d -= 1;
      }
    };
    // a function or the global: its function members marked, a function
    // member followed for its own statics and prototype, an object member
    // followed through its prototype chain
    function walk(node: Any, depth: number): void {
      if (
        depth < 0 ||
        node === null ||
        (typeof node !== 'object' && typeof node !== 'function') ||
        seen.has(node)
      ) {
        return;
      }
      seen.add(node);
      let names: (string | symbol)[];
      try {
        names = [
          ...Object.getOwnPropertyNames(node),
          ...Object.getOwnPropertySymbols(node),
        ];
      } catch {
        return;
      }
      for (const name of names) {
        if (name === 'caller' || name === 'arguments' || name === 'callee') {
          continue;
        }
        let desc: PropertyDescriptor | undefined;
        try {
          desc = Object.getOwnPropertyDescriptor(node, name);
        } catch {
          continue;
        }
        if (!desc) continue;
        markFn(desc.get, depth - 1);
        markFn(desc.set, depth - 1);
        const value = desc.value;
        if (typeof value === 'function') markFn(value, depth - 1);
        else if (value && typeof value === 'object')
          markChain(value, depth - 1);
      }
    }
    walk(G, 8);
    // `location` is reached through a getter, which the walk does not
    // invoke; its methods (assign, replace, reload) are marked from the
    // object itself
    try {
      if (location && typeof location === 'object') markChain(location, 8);
    } catch {
      /* no location in this realm */
    }
    // and the interfaces no global names, reached through a getter alone:
    // `document.fonts`'s, and the faces it hands over
    markFn(FontFaceSet, 8);
    markFn(FontFace, 8);

    const realToString = Function.prototype.toString;
    const toString = function (this: Any): string {
      if (typeof this === 'function' && nativeFns.has(this)) {
        return `function ${this.name || ''}() { [native code] }`;
      }
      // a page function, or a non-function `this` the real one rejects
      return realToString.call(this);
    };
    nativeFns.add(toString);
    Object.defineProperty(Function.prototype, 'toString', {
      value: toString,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
