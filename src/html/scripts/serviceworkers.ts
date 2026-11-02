// Service workers as a page's scripts see them (Service Workers 1, 3 and 4):
// `navigator.serviceWorker` and the objects it hands out, and, in a worker's
// own realm, its global's `clients`, `registration` and events.
//
// **This function is source text**, as `installDom` is (`dom.ts`).
//
// Registrations and workers are the host's (`sw-registry.ts`), which outlive
// the realm: what a realm holds stands for one of them, the same object for
// the same thing for as long as the realm lives (`registrationOf`, `workerOf`).
// It asks by the `sw` op, as JSON, and hears by the `__sw` entry, in the order
// the registry tells it, so a registration's attributes change before a
// worker's `statechange` is fired, as "Update Worker State" has it.
//
// A worker is a thread that may not be running, so nothing that crosses is a
// page's object: a message is a string `serializeClone` made, a request and a
// response JSON with their bytes as base64, and a port a wire across whatever
// names its other end (`acrossTo`).

declare const queueMicrotask: (fn: () => void) => void;

/** What `installDom` hands this. */
export interface ServiceWorkerDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  Event: unknown;
  EventTarget: unknown;
  MessageEvent: unknown;
  DOMException: unknown;
  Response: unknown;
  document: unknown;
  /** The global's own target, a worker's events' and a window's. */
  windowTarget: unknown;
  dispatch(target: unknown, event: unknown): boolean;
  report(error: unknown): void;
  handlerProperty(proto: unknown, type: string): void;
  idlAttributes(target: unknown): void;
  setHandler(target: unknown, type: string, fn: unknown): void;
  /** Whether something hears a type of event at a target. */
  heard(target: unknown, type: string): boolean;
  /** Put a global on the realm. */
  define(name: string, value: unknown): void;
  /** Whether the document is still in its frame. */
  fullyActive(): boolean;
  /** Where a URL is resolved from: the document's, or a worker's script's. */
  base(): string;
  origin(): string;
  bytesOfBase64(text: string): Uint8Array;
  base64OfBytes(bytes: Uint8Array): string;
  serializeClone(value: unknown, moved: undefined, transfer: unknown): string;
  deserializeWith(
    text: string,
    across: unknown,
  ): {
    data: unknown;
    ports: unknown[];
  };
  transfersOf(list: unknown[]): unknown[];
  transferListOf(transfer: unknown): unknown[];
  giveUp(transfer: unknown): void;
  wireMessage(across: unknown, text: string): boolean;
  /** A `Request` as a `fetch` event hands it to a worker. */
  requestFrom(wire: unknown, signal: unknown): unknown;
  /** A response made of what the registry preloaded. */
  responseFrom(head: unknown, bytes: Uint8Array | null): unknown;
  NOTE: () => {
    showFor(registration: unknown, title: unknown, options: unknown): unknown;
    listFor(registration: unknown, filter: unknown): unknown;
    forget(registration: unknown): void;
  };
}

/** What `installDom` has of this. */
export interface ServiceWorkerInternals {
  /** The interfaces a page exposes where it has them, by name. */
  interfaces: Record<string, unknown>;
  container: unknown;
  /** Whether this realm is a service worker's. */
  inWorker(): boolean;
  /** Whether a registration has no worker to answer for a notification. */
  noWorker(registration: unknown): boolean;
  /** This realm is a service worker's (`__becomeWorker`). */
  become(service: unknown): void;
  /** A worker's script has run (`__serviceStarted`). */
  started(ran: boolean): void;
  /** A notification's event, for a worker's global. */
  workerEvent(type: string, notification: unknown, action: string): boolean;
}

export function installServiceWorkers(
  deps: ServiceWorkerDeps,
): ServiceWorkerInternals {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const call: Any = D.call;
  const entry: Any = D.entry;
  const input: Any = D.input;
  const Event: Any = D.Event;
  const EventTarget: Any = D.EventTarget;
  const MessageEvent: Any = D.MessageEvent;
  const DOMException: Any = D.DOMException;
  const Response: Any = D.Response;
  const windowTarget: Any = D.windowTarget;
  const dispatch: Any = D.dispatch;
  const report: Any = D.report;
  const handlerProperty: Any = D.handlerProperty;
  const idlAttributes: Any = D.idlAttributes;
  const bytesOfBase64: Any = D.bytesOfBase64;
  const base64OfBytes: Any = D.base64OfBytes;

  // What is taken before any page code runs.
  const P: Any = Promise;
  const rejected: Any = P.reject.bind(P);
  const resolved: Any = P.resolve.bind(P);
  const stringify: Any = JSON.stringify;
  const parse: Any = JSON.parse;
  const freeze: Any = Object.freeze;
  const KEY: Any = Symbol('ServiceWorker');

  /** Where this realm is a service worker's: what its registry knows it by. */
  let self: { scope: string; worker: Any; registration: Any } | null = null;

  const pending = new Map<number, { resolve: Any; reject: Any }>();
  let nextAsk = 1;
  const send = (message: Any): Any => call('sw', stringify(message));
  /** Asks the registry, and what it answers. */
  const ask = (message: Any): Any =>
    new P((resolve: Any, reject: Any) => {
      const n = nextAsk;
      nextAsk += 1;
      pending.set(n, { resolve, reject });
      send({ ...message, n });
    });

  // --- what stands for a worker and a registration ------------------------------

  const workers = new Map<string, Any>();
  const registrations = new Map<string, Any>();

  class ServiceWorker extends EventTarget {
    _id = '';
    _url = '';
    _state = 'parsed';
    constructor(key?: Any) {
      if (key !== KEY) throw new TypeError('Illegal constructor');
      super();
    }
    get scriptURL(): string {
      return this._url;
    }
    get state(): string {
      return this._state;
    }
    postMessage(message: Any, transfer?: Any): void {
      if (this._state === 'redundant') {
        throw new DOMException(
          "Failed to execute 'postMessage' on 'ServiceWorker': ServiceWorker is in redundant state.",
          'InvalidStateError',
        );
      }
      const later: Array<() => void> = [];
      const across = acrossTo(`w${this._id}`);
      const text = D.serializeClone(message, undefined, {
        across,
        moving: D.transfersOf(D.transferListOf(transfer)),
        later,
      });
      D.giveUp(transfer);
      across.send(text);
      for (const go of later) go();
    }
  }
  handlerProperty(ServiceWorker.prototype, 'statechange');
  handlerProperty(ServiceWorker.prototype, 'error');
  idlAttributes(ServiceWorker);

  const workerOf = (view: Any): Any => {
    if (!view) return null;
    let worker = workers.get(view.i);
    if (!worker) {
      worker = new ServiceWorker(KEY);
      worker._id = view.i;
      worker._url = view.u;
      workers.set(view.i, worker);
    }
    worker._state = view.s;
    return worker;
  };

  class NavigationPreloadManager {
    _registration: Any;
    constructor(key?: Any, registration?: Any) {
      if (key !== KEY) throw new TypeError('Illegal constructor');
      this._registration = registration;
    }
    _ask(what: string, value?: string): Any {
      return ask({
        op: 'preload',
        registration: this._registration._id,
        what,
        value,
      });
    }
    enable(): Any {
      return this._ask('enable').then(() => undefined);
    }
    disable(): Any {
      return this._ask('disable').then(() => undefined);
    }
    setHeaderValue(value: Any): Any {
      const text = `${value}`;
      if (!/^[\t -~\u0080-ÿ]*$/.test(text)) {
        return rejected(
          new TypeError(
            "Failed to execute 'setHeaderValue' on 'NavigationPreloadManager': The string provided is not a valid HTTP header field value.",
          ),
        );
      }
      return this._ask('header', text).then(() => undefined);
    }
    getState(): Any {
      return this._ask('get').then((answer: Any) => ({
        enabled: !!answer.state.enabled,
        headerValue: `${answer.state.header}`,
      }));
    }
  }
  idlAttributes(NavigationPreloadManager);

  class ServiceWorkerRegistration extends EventTarget {
    _id = '';
    _scope = '';
    _uvc = 'imports';
    _installing: Any = null;
    _waiting: Any = null;
    _active: Any = null;
    _preload: Any = null;
    constructor(key?: Any) {
      if (key !== KEY) throw new TypeError('Illegal constructor');
      super();
    }
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
      return this._uvc;
    }
    get navigationPreload(): Any {
      return (this._preload ??= new NavigationPreloadManager(KEY, this));
    }
    update(): Any {
      return ask({ op: 'update', registration: this._id }).then((answer: Any) =>
        registrationOf(answer.registration),
      );
    }
    unregister(): Any {
      return ask({ op: 'unregister', registration: this._id }).then(
        (answer: Any) => {
          if (answer.value) D.NOTE().forget(this);
          return answer.value === true;
        },
      );
    }
    showNotification(title: Any, options?: Any): Any {
      return D.NOTE().showFor(this, title, options);
    }
    getNotifications(filter?: Any): Any {
      return D.NOTE().listFor(this, filter);
    }
  }
  handlerProperty(ServiceWorkerRegistration.prototype, 'updatefound');
  idlAttributes(ServiceWorkerRegistration);

  const registrationOf = (view: Any): Any => {
    if (!view) return undefined;
    let registration = registrations.get(view.i);
    if (!registration) {
      registration = new ServiceWorkerRegistration(KEY);
      registration._id = view.i;
      registration._scope = view.scope;
      registrations.set(view.i, registration);
    }
    registration._uvc = view.uvc;
    registration._installing = workerOf(view.installing);
    registration._waiting = workerOf(view.waiting);
    registration._active = workerOf(view.active);
    return registration;
  };

  // --- across: a message's way to what it is posted to ---------------------------

  const acrosses = new Map<string, Any>();
  /** How a port reaches what is at the other end of a thread, `w<id>` a worker
   *  and `c<id>` a client, the name a wire is kept under here. */
  const acrossTo = (name: string): Any => {
    let across = acrosses.get(name);
    if (!across) {
      const id = name.slice(1);
      across = {
        key: `sw ${name}`,
        send:
          name[0] === 'w'
            ? (text: string) => send({ op: 'post', to: id, text })
            : (text: string) => send({ op: 'postClient', client: id, text }),
      };
      acrosses.set(name, across);
    }
    return across;
  };

  // --- a page's container ----------------------------------------------------------

  let controller: Any;
  let readyPromise: Any = null;
  /** Messages a page is not listening for yet (Service Workers 1, the client
   *  message queue): until its document has been parsed, or it asks. */
  const held: Any[] = [];
  let messagesOn = false;
  const deliver = (m: Any): void => {
    const source = m.from.client ? clientOf(m.from) : workerOf(m.from);
    const name = `${m.from.client ? 'c' : 'w'}${m.from.client ? m.from.id : m.from.i}`;
    const across = acrossTo(name);
    if (D.wireMessage(across, m.text)) return;
    let made: Any;
    try {
      made = D.deserializeWith(m.text, across);
    } catch {
      const ev = new MessageEvent('messageerror', { source });
      ev.isTrusted = true;
      dispatch(container, ev);
      return;
    }
    const ev = new MessageEvent('message', {
      data: made.data,
      origin: D.origin(),
      source,
      ports: made.ports,
    });
    ev.isTrusted = true;
    dispatch(container, ev);
  };
  const startMessages = (): void => {
    messagesOn = true;
    for (const m of held.splice(0)) deliver(m);
  };

  class ServiceWorkerContainer extends EventTarget {
    constructor(key?: Any) {
      if (key !== KEY) throw new TypeError('Illegal constructor');
      super();
    }
    get controller(): Any {
      // a frame that left its document has no client to be controlled
      if (!D.fullyActive()) return null;
      if (controller === undefined) {
        const said = send({ op: 'hello', n: 0 });
        controller = workerOf(said ? parse(`${said}`).controller : null);
      }
      return controller;
    }
    get ready(): Any {
      if (!readyPromise) {
        readyPromise = ask({ op: 'ready' }).then((answer: Any) =>
          registrationOf(answer.registration),
        );
      }
      return readyPromise;
    }
    /** Service Workers 1, "Start Register": the two URLs held to what a
     *  script and a scope may be, before any job is made of them. */
    register(url: Any, options: Any = {}): Any {
      const base = D.base();
      let script: Any;
      let scope: Any;
      const type = options?.type === undefined ? 'classic' : `${options.type}`;
      const via =
        options?.updateViaCache === undefined
          ? 'imports'
          : `${options.updateViaCache}`;
      if (type !== 'classic' && type !== 'module') {
        return rejected(
          new TypeError(
            `Failed to execute 'register' on 'ServiceWorkerContainer': The provided value '${type}' is not a valid enum value of type WorkerType.`,
          ),
        );
      }
      if (via !== 'imports' && via !== 'all' && via !== 'none') {
        return rejected(
          new TypeError(
            `Failed to execute 'register' on 'ServiceWorkerContainer': The provided value '${via}' is not a valid enum value of type ServiceWorkerUpdateViaCache.`,
          ),
        );
      }
      try {
        script = new D.URL(`${url}`, base);
        scope =
          options?.scope === undefined || options.scope === null
            ? new D.URL('./', script.href)
            : new D.URL(`${options.scope}`, base);
      } catch {
        return rejected(
          new TypeError(
            "Failed to execute 'register' on 'ServiceWorkerContainer': Invalid URL",
          ),
        );
      }
      if (!/^https?:$/.test(script.protocol)) {
        return rejected(
          new TypeError(
            `Failed to register a ServiceWorker: The URL protocol of the script ('${script.href}') is not supported.`,
          ),
        );
      }
      if (script.origin !== D.origin()) {
        return rejected(
          new DOMException(
            `Failed to register a ServiceWorker: The origin of the provided scriptURL ('${script.origin}') does not match the current origin ('${D.origin()}').`,
            'SecurityError',
          ),
        );
      }
      if (!/^https?:$/.test(scope.protocol)) {
        return rejected(
          new TypeError(
            `Failed to register a ServiceWorker: The URL protocol of the scope ('${scope.href}') is not supported.`,
          ),
        );
      }
      if (scope.origin !== D.origin()) {
        return rejected(
          new DOMException(
            `Failed to register a ServiceWorker: The origin of the provided scope ('${scope.origin}') does not match the current origin ('${D.origin()}').`,
            'SecurityError',
          ),
        );
      }
      if (/%2f|%5c/i.test(script.pathname) || /%2f|%5c/i.test(scope.pathname)) {
        return rejected(
          new TypeError(
            "Failed to register a ServiceWorker: The provided scope or scriptURL includes an escaped '/' or '\\'.",
          ),
        );
      }
      script.hash = '';
      scope.hash = '';
      return ask({
        op: 'register',
        script: script.href,
        scope: scope.href,
        type,
        updateViaCache: via,
      }).then((answer: Any) => registrationOf(answer.registration));
    }
    getRegistration(url: Any = ''): Any {
      let target: Any;
      try {
        target = new D.URL(`${url}`, D.base());
      } catch {
        return rejected(
          new TypeError(
            "Failed to execute 'getRegistration' on 'ServiceWorkerContainer': The URL provided is invalid.",
          ),
        );
      }
      if (target.origin !== D.origin()) {
        return rejected(
          new DOMException(
            "Failed to execute 'getRegistration' on 'ServiceWorkerContainer': The origin of the provided documentURL does not match the current origin.",
            'SecurityError',
          ),
        );
      }
      target.hash = '';
      return ask({ op: 'getRegistration', url: target.href }).then(
        (answer: Any) => registrationOf(answer.registration),
      );
    }
    getRegistrations(): Any {
      return ask({ op: 'getRegistrations' }).then((answer: Any) =>
        freeze(answer.registrations.map(registrationOf)),
      );
    }
    startMessages(): void {
      startMessages();
    }
  }
  handlerProperty(ServiceWorkerContainer.prototype, 'controllerchange');
  handlerProperty(ServiceWorkerContainer.prototype, 'messageerror');
  // an `onmessage` is what a `startMessages()` is for (Service Workers 1,
  // 3.4, the handler's steps)
  handlerProperty(ServiceWorkerContainer.prototype, 'message');
  {
    const was: Any = Object.getOwnPropertyDescriptor(
      ServiceWorkerContainer.prototype,
      'onmessage',
    );
    Object.defineProperty(ServiceWorkerContainer.prototype, 'onmessage', {
      get: was.get,
      set(this: Any, fn: Any) {
        was.set.call(this, fn);
        startMessages();
      },
      enumerable: true,
      configurable: true,
    });
  }
  idlAttributes(ServiceWorkerContainer);
  const container = new ServiceWorkerContainer(KEY);

  // --- what a worker's realm has --------------------------------------------------

  /** Service Workers 1, 4.4: an event a worker may keep alive with
   *  `waitUntil`, until all it was handed has settled. */
  class ExtendableEvent extends Event {
    _pending = 0;
    _dispatching = false;
    _refused = false;
    _settled: Any = null;
    constructor(type: Any, init?: Any) {
      super(type, init);
    }
    waitUntil(promise: Any): void {
      if (!this.isTrusted) {
        throw new DOMException(
          "Failed to execute 'waitUntil' on 'ExtendableEvent': The event is not trusted.",
          'InvalidStateError',
        );
      }
      if (!this._dispatching && this._pending === 0) {
        throw new DOMException(
          "Failed to execute 'waitUntil' on 'ExtendableEvent': The event handler is already finished and no extend lifetime promises are outstanding.",
          'InvalidStateError',
        );
      }
      this._pending += 1;
      const settled = (): void => {
        // a microtask later, so a reaction can still extend it (Service
        // Workers 1, "extend lifetime promises")
        queueMicrotask(() => {
          this._pending -= 1;
          if (this._pending === 0 && !this._dispatching) this._settled?.();
        });
      };
      resolved(promise).then(settled, () => {
        this._refused = true;
        settled();
      });
    }
  }
  idlAttributes(ExtendableEvent);
  /** What is left of an event once its dispatch is over. A browser runs
   *  microtasks as each listener returns, with the event still dispatching,
   *  so `respondWith` from one is in time; here they run as the entry ends,
   *  so the dispatch is over only in the entry after (`__swDispatched`). */
  const afterDispatch: Any[] = [];
  /** An event a worker hears: dispatched, and whether it finished well once
   *  what it waited on settled. */
  const lifetime = (ev: Any, dispatched?: Any): Any =>
    new P((done: Any) => {
      ev.isTrusted = true;
      ev._dispatching = true;
      ev._settled = () => done(!ev._refused);
      dispatch(windowTarget, ev);
      afterDispatch.push(() => {
        ev._dispatching = false;
        dispatched?.();
        if (ev._pending === 0) done(!ev._refused);
      });
    });

  class ExtendableMessageEvent extends ExtendableEvent {
    _data: Any;
    _origin: string;
    _lastEventId: string;
    _source: Any;
    _ports: readonly Any[];
    constructor(type: string, init: Any = {}) {
      super(type, init);
      this._data = init?.data === undefined ? null : init.data;
      this._origin = init?.origin === undefined ? '' : `${init.origin}`;
      this._lastEventId =
        init?.lastEventId === undefined ? '' : `${init.lastEventId}`;
      const source = init?.source ?? null;
      if (
        source !== null &&
        !(source instanceof Client) &&
        !(source instanceof ServiceWorker) &&
        !(source instanceof D.MessagePort)
      ) {
        throw new TypeError(
          "Failed to construct 'ExtendableMessageEvent': The provided value is not of type '(Client or ServiceWorker or MessagePort)'.",
        );
      }
      this._source = source;
      if (init?.ports === null) {
        throw new TypeError(
          "Failed to construct 'ExtendableMessageEvent': The provided value cannot be converted to a sequence.",
        );
      }
      const ports = [...(init?.ports ?? [])];
      for (const port of ports) {
        if (!(port instanceof D.MessagePort)) {
          throw new TypeError(
            "Failed to construct 'ExtendableMessageEvent': Failed to convert value to 'MessagePort'.",
          );
        }
      }
      this._ports = freeze(ports);
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
  idlAttributes(ExtendableMessageEvent);

  class NotificationEvent extends ExtendableEvent {
    _init: Any;
    constructor(type: Any, init: Any) {
      super(type, init);
      if (typeof init?.notification !== 'object' || !init.notification) {
        throw new TypeError(
          "Failed to construct 'NotificationEvent': Required member is undefined.",
        );
      }
      this._init = init;
    }
    get notification(): Any {
      return this._init.notification;
    }
    get action(): string {
      return `${this._init.action ?? ''}`;
    }
  }
  idlAttributes(NotificationEvent);

  /** Service Workers 1, 4.5: what a worker hears of a request. */
  class FetchEvent extends ExtendableEvent {
    _request: Any;
    _clientId: string;
    _resultingClientId: string;
    _replacesClientId: string;
    _f = 0;
    _entered = false;
    _handled: Any;
    _preload: Any;
    _handledDone: Any = null;
    _handledFailed: Any = null;
    constructor(type: Any, init: Any) {
      super(type, init);
      if (!init || typeof init.request !== 'object' || !init.request) {
        throw new TypeError(
          "Failed to construct 'FetchEvent': required member request is undefined.",
        );
      }
      this._request = init.request;
      this._clientId = `${init.clientId ?? ''}`;
      this._resultingClientId = `${init.resultingClientId ?? ''}`;
      this._replacesClientId = `${init.replacesClientId ?? ''}`;
      this._preload =
        init.preloadResponse === undefined
          ? resolved(undefined)
          : resolved(init.preloadResponse);
      this._handled = new P((done: Any, failed: Any) => {
        this._handledDone = done;
        this._handledFailed = failed;
      });
      this._handled.catch(() => {});
    }
    get request(): Any {
      return this._request;
    }
    get clientId(): string {
      return this._clientId;
    }
    get resultingClientId(): string {
      return this._resultingClientId;
    }
    get replacesClientId(): string {
      return this._replacesClientId;
    }
    get handled(): Any {
      return this._handled;
    }
    get preloadResponse(): Any {
      return this._preload;
    }
    /** Service Workers 1, `respondWith`: what the page gets instead of the
     *  network's answer, from whatever the promise comes to. */
    respondWith(answer: Any): void {
      if (!this._dispatching) {
        throw new DOMException(
          "Failed to execute 'respondWith' on 'FetchEvent': The event has already been responded to.",
          'InvalidStateError',
        );
      }
      if (this._entered) {
        throw new DOMException(
          "Failed to execute 'respondWith' on 'FetchEvent': The event has already been responded to.",
          'InvalidStateError',
        );
      }
      this._entered = true;
      this.stopImmediatePropagation();
      const f = this._f;
      const refuse = (): void => {
        if (f) send({ op: 'refused', f });
        this._handledFailed(
          new DOMException('The fetch failed.', 'NetworkError'),
        );
      };
      const made = resolved(answer).then(
        (response: Any) => {
          if (
            !(response instanceof Response) ||
            response.bodyUsed ||
            response._stream?.locked
          ) {
            refuse();
            return;
          }
          if (f) sendResponse(f, response);
          this._handledDone(undefined);
        },
        () => refuse(),
      );
      this.waitUntil(made);
    }
  }
  idlAttributes(FetchEvent);

  /** A worker's response on its way to what asked. */
  const bodies = new Map<number, Any>();
  const sendResponse = (f: number, response: Any): void => {
    const head = {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers._map.entries()],
      url: response.url,
      type: response.type,
      redirected: response.redirected,
    };
    if (response._held !== null && response._held !== undefined) {
      send({ op: 'respond', f, head, held: response._held });
      return;
    }
    if (response._given()) {
      response.bodyUsed = true;
      const reader = response._stream.getReader();
      bodies.set(f, reader);
      send({ op: 'respond', f, head, streaming: true });
      const pump = (): void => {
        reader.read().then(
          (step: Any) => {
            if (!bodies.has(f)) return;
            if (step.done) {
              bodies.delete(f);
              send({ op: 'end', f });
              return;
            }
            if (!(step.value instanceof Uint8Array)) {
              bodies.delete(f);
              send({ op: 'end', f, error: 'The body held no bytes.' });
              return;
            }
            send({ op: 'chunk', f, base64: base64OfBytes(step.value) });
            pump();
          },
          () => {
            if (bodies.delete(f))
              send({ op: 'end', f, error: 'Network error' });
          },
        );
      };
      pump();
      return;
    }
    const bytes = response.bodyUsed ? new Uint8Array(0) : response._bytes();
    send({ op: 'respond', f, head, base64: base64OfBytes(bytes) });
  };

  /** Service Workers 1, 4.2: a client as a worker reads one. */
  class Client {
    _view: Any;
    constructor(key?: Any, view?: Any) {
      if (key !== KEY) throw new TypeError('Illegal constructor');
      this._view = view;
    }
    get url(): string {
      return this._view.url;
    }
    get id(): string {
      return this._view.id;
    }
    get type(): string {
      return this._view.type;
    }
    get frameType(): string {
      return this._view.frameType;
    }
    postMessage(message: Any, transfer?: Any): void {
      const later: Array<() => void> = [];
      const across = acrossTo(`c${this._view.id}`);
      const text = D.serializeClone(message, undefined, {
        across,
        moving: D.transfersOf(D.transferListOf(transfer)),
        later,
      });
      D.giveUp(transfer);
      across.send(text);
      for (const go of later) go();
    }
  }
  idlAttributes(Client);
  class WindowClient extends Client {
    get focused(): boolean {
      return !!this._view.focused;
    }
    get visibilityState(): string {
      return this._view.visibility;
    }
    get ancestorOrigins(): readonly string[] {
      return freeze([]);
    }
    focus(): Any {
      return windowAllowed > 0
        ? resolved(this)
        : rejected(
            new DOMException(
              'Not allowed to focus a window.',
              'InvalidAccessError',
            ),
          );
    }
    navigate(url: Any): Any {
      return ask({
        op: 'clients',
        what: 'navigate',
        id: this._view.id,
        url: `${url}`,
      }).then((answer: Any) => clientOf(answer.client) ?? null);
    }
  }
  idlAttributes(WindowClient);
  const clientOf = (view: Any): Any => {
    if (!view) return undefined;
    return view.type === 'window'
      ? new WindowClient(KEY, view)
      : new Client(KEY, view);
  };
  /** How many events are under way that let a worker open a window: a
   *  notification's click, the one user gesture a worker hears. */
  let windowAllowed = 0;

  /** Service Workers 1, 4.3: what a worker reaches its clients through. */
  class Clients {
    constructor(key?: Any) {
      if (key !== KEY) throw new TypeError('Illegal constructor');
    }
    get(id: Any): Any {
      return ask({ op: 'clients', what: 'get', id: `${id}` }).then(
        (answer: Any) => clientOf(answer.client),
      );
    }
    matchAll(options: Any = {}): Any {
      return ask({
        op: 'clients',
        what: 'matchAll',
        type: options?.type === undefined ? 'window' : `${options.type}`,
        includeUncontrolled: !!options?.includeUncontrolled,
      }).then((answer: Any) => freeze(answer.clients.map(clientOf)));
    }
    openWindow(url: Any): Any {
      if (windowAllowed < 1) {
        return rejected(
          new DOMException(
            'Not allowed to open a window.',
            'InvalidAccessError',
          ),
        );
      }
      let target: Any;
      try {
        target = new D.URL(`${url}`, D.base());
      } catch {
        return rejected(
          new TypeError(
            "Failed to execute 'openWindow' on 'Clients': The URL provided is invalid.",
          ),
        );
      }
      return ask({ op: 'clients', what: 'openWindow', url: target.href }).then(
        () => null,
      );
    }
    claim(): Any {
      return ask({ op: 'clients', what: 'claim' }).then(() => undefined);
    }
  }
  idlAttributes(Clients);

  const preloads = new Map<number, Any>();
  const fetchEvents = new Map<number, Any>();

  /** What a worker hears from its registry. */
  const heardEvent = (m: Any): void => {
    if (m.event === 'fetch') {
      const controller = new D.AbortController();
      const preload = m.preload
        ? new P((resolve: Any, reject: Any) => {
            preloads.set(m.f, { resolve, reject });
          })
        : undefined;
      preload?.catch(() => {});
      const ev = new FetchEvent('fetch', {
        cancelable: true,
        request: D.requestFrom(m.request, controller.signal),
        clientId: m.clientId,
        resultingClientId: m.resultingClientId,
        preloadResponse: preload,
      });
      ev._f = m.f;
      fetchEvents.set(m.f, controller);
      void lifetime(ev, () => {
        if (ev._entered) return;
        // a default prevented is a network error (Service Workers 1, "Handle
        // Fetch"), and anything else goes on to the network
        send({ op: ev.defaultPrevented ? 'refused' : 'fallback', f: m.f });
        ev._handledFailed(
          new DOMException('The event was not responded to.', 'NetworkError'),
        );
      }).then(() => fetchEvents.delete(m.f));
      return;
    }
    if (m.event === 'message') {
      const source = m.from.client ? clientOf(m.from) : workerOf(m.from);
      const name = `${m.from.client ? 'c' : 'w'}${m.from.client ? m.from.id : m.from.i}`;
      const across = acrossTo(name);
      const done = (ok: boolean): void => {
        send({ op: 'done', e: m.n, ok });
      };
      if (D.wireMessage(across, m.text)) {
        done(true);
        return;
      }
      let made: Any;
      try {
        made = D.deserializeWith(m.text, across);
      } catch {
        void lifetime(
          new ExtendableMessageEvent('messageerror', { source }),
        ).then(done);
        return;
      }
      void lifetime(
        new ExtendableMessageEvent('message', {
          data: made.data,
          origin: new D.URL(m.from.url ?? m.from.u).origin,
          source,
          ports: made.ports,
        }),
      ).then(done);
      return;
    }
    // `install` and `activate`
    void lifetime(new ExtendableEvent(m.event)).then((ok: boolean) => {
      send({ op: 'done', e: m.n, ok });
    });
  };

  // --- what the registry says ------------------------------------------------------

  const heardRegistry = (text: string): void => {
    const m = parse(text);
    if (typeof m.a === 'number') {
      const waiting = pending.get(m.a);
      if (!waiting) return;
      pending.delete(m.a);
      if (m.error) {
        waiting.reject(
          m.error.name === 'TypeError'
            ? new TypeError(m.error.message)
            : new DOMException(m.error.message, m.error.name),
        );
      } else waiting.resolve(m);
      return;
    }
    if (m.reg) {
      if (registrations.has(m.reg.i)) registrationOf(m.reg);
      return;
    }
    if (m.worker !== undefined) {
      const worker = workers.get(m.worker);
      if (!worker) return;
      worker._state = m.state;
      const ev = new Event('statechange');
      ev.isTrusted = true;
      dispatch(worker, ev);
      return;
    }
    if (m.found !== undefined) {
      const registration = registrations.get(m.found);
      if (!registration) return;
      const ev = new Event('updatefound');
      ev.isTrusted = true;
      dispatch(registration, ev);
      return;
    }
    if ('controller' in m) {
      controller = workerOf(m.controller);
      const ev = new Event('controllerchange');
      ev.isTrusted = true;
      dispatch(container, ev);
      return;
    }
    if (m.message) {
      if (messagesOn || D.document.readyState !== 'loading') deliver(m);
      else {
        held.push(m);
        D.document.addEventListener('DOMContentLoaded', startMessages, {
          once: true,
        });
      }
      return;
    }
    if (m.event) {
      heardEvent(m);
      return;
    }
    if (m.preloaded !== undefined) {
      const waiting = preloads.get(m.preloaded);
      if (!waiting) return;
      preloads.delete(m.preloaded);
      if (m.failed) waiting.reject(new TypeError('Failed to fetch'));
      else {
        waiting.resolve(D.responseFrom(m.head, bytesOfBase64(m.base64)));
      }
      return;
    }
    if (m.abort !== undefined) {
      fetchEvents.get(m.abort)?.abort();
      return;
    }
    if (m.cancel !== undefined) {
      const reader = bodies.get(m.cancel);
      bodies.delete(m.cancel);
      reader?.cancel().catch(() => {});
    }
  };
  entry('__swDispatched', () => {
    for (const go of afterDispatch.splice(0)) go();
    return true;
  });
  entry('__sw', () => {
    const [text] = input() as Any[];
    try {
      heardRegistry(`${text}`);
    } catch (error) {
      report(error);
    }
    return true;
  });

  const scope = (label: string): Any => {
    const fn: Any = function () {
      throw new TypeError('Illegal constructor');
    };
    Object.defineProperty(fn, 'name', { value: label });
    Object.defineProperty(fn, Symbol.hasInstance, {
      value: (v: Any) => v === globalThis,
    });
    return fn;
  };

  return {
    interfaces: {
      ServiceWorker,
      ServiceWorkerRegistration,
      ServiceWorkerContainer,
      NavigationPreloadManager,
    },
    container,
    inWorker: () => self !== null,
    noWorker: (registration: Any) =>
      !self && !registration._active && !registration._waiting,
    become(service: Any): void {
      self = {
        scope: `${service.scope}`,
        worker: workerOf(service.worker),
        registration: registrationOf(service.registration),
      };
      const define = D.define;
      define('ServiceWorkerGlobalScope', scope('ServiceWorkerGlobalScope'));
      define('ExtendableEvent', ExtendableEvent);
      define('ExtendableMessageEvent', ExtendableMessageEvent);
      define('FetchEvent', FetchEvent);
      define('Client', Client);
      define('WindowClient', WindowClient);
      define('Clients', Clients);
      define('clients', new Clients(KEY));
      define('NotificationEvent', NotificationEvent);
      define('registration', self.registration);
      define('serviceWorker', self.worker);
      define('skipWaiting', function skipWaiting(): Any {
        return ask({ op: 'skipWaiting' }).then(() => undefined);
      });
      for (const type of [
        'install',
        'activate',
        'message',
        'messageerror',
        'fetch',
        'notificationclick',
        'notificationclose',
      ]) {
        Object.defineProperty(globalThis, `on${type}`, {
          get: () => windowTarget._handlers?.[type] ?? null,
          set: (fn: Any) => {
            D.setHandler(
              windowTarget,
              type,
              typeof fn === 'function' ? fn : null,
            );
          },
          configurable: true,
        });
      }
    },
    started(ran: boolean): void {
      send({ op: 'started', ran, fetch: D.heard(windowTarget, 'fetch') });
    },
    workerEvent(type: string, notification: Any, action: string): boolean {
      if (!self) return false;
      windowAllowed += type === 'notificationclick' ? 1 : 0;
      const ev = new NotificationEvent(type, { notification, action });
      void lifetime(ev).then(() => {
        windowAllowed -= type === 'notificationclick' ? 1 : 0;
      });
      return true;
    },
  };
}
