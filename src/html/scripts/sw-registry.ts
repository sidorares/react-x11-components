// A process's service workers (Service Workers 1, 3): registrations by scope,
// the jobs that change them one at a time, the workers' threads, and what a
// `fetch` event comes to. One for each `HtmlServiceWorkers`, and so for every
// document the process shows: a worker outlives the document that registered
// it, and the next document in its scope hears from it before it has a realm.
//
// This is the spec's half that a browser keeps outside any page. A realm
// holds objects that stand for what is here (`serviceworkers.ts`), asks by
// the `sw` op and is told by `__sw`, as JSON; a worker's realm the same, over
// its thread.
//
// **A process has its own worker.** Each tab of the example browser is a
// process, so a site open in two tabs runs its worker twice, over one store:
// the registration, the scripts, `caches` and IndexedDB are the profile's, and
// a worker is a thread that can be stopped at any moment, which is what the
// standard asks a site to expect of one. `clients.matchAll()` lists the
// clients of the process. Another process's change to a registration is read
// as the next request asks about the scope (`_sync`).
import type {
  AbortSignalLike,
  AbortControllerClass,
  UrlClass,
} from './platform.js';
import { PageWorkers } from './workers.js';
import type { PageWorkersSeams } from './workers.js';
import type { FetchRequest, FetchResponse } from './host.js';
import { inScope, keepRegistry, registryKept } from '../service-workers.js';
import type {
  HtmlServiceWorkerRecord,
  HtmlServiceWorkerRegistry,
  HtmlServiceWorkerRequest,
  HtmlServiceWorkerScript,
  HtmlServiceWorkerUpdateViaCache,
  HtmlServiceWorkerVersion,
  HtmlServiceWorkers,
} from '../service-workers.js';
import { contentType, resourceResult } from '../network.js';
import type { ResourceKind } from '../network.js';
import type { ResourceResult } from '../resources.js';
import { wholeBytes } from './host.js';
import { askCaches, memoryCaches } from '../cache-storage.js';
import type {
  HtmlCacheAnswer,
  HtmlCacheAsk,
  HtmlCacheStore,
} from '../cache-storage.js';
import { defaultStorage } from '../storage.js';

declare const URL: UrlClass;
declare const AbortController: AbortControllerClass;
declare const Buffer: {
  from(
    data: string | Uint8Array,
    encoding?: string,
  ): Uint8Array & {
    toString(encoding: string): string;
  };
};
declare const setTimeout: (fn: () => void, ms?: number) => { unref?(): void };
declare const clearTimeout: (id: unknown) => void;
declare const crypto: { randomUUID(): string };

/** How many workers a process may have running at once. */
const MAX_THREADS = 64;
/** How long a worker's script may take to come up before it is given up on,
 *  and what was waiting on it goes to the network. */
const START_MS = 30_000;
/** How long after a navigation its worker's script is asked about (Service
 *  Workers 1, "Soft Update"): the page first. */
const SOFT_UPDATE_MS = 1000;
/** How long a `WindowClient.navigate()` waits to hear of the document it
 *  went to. */
const NAVIGATE_MS = 10_000;

/** What a `fetch` event says a subresource is for. */
const DESTINATIONS: Record<ResourceKind, string> = {
  image: 'image',
  stylesheet: 'style',
  font: 'font',
  script: 'script',
};

const JS_MIME =
  /^(?:application\/(?:javascript|x-javascript|ecmascript|x-ecmascript)|text\/(?:javascript|ecmascript|jscript|livescript|x-javascript|x-ecmascript|javascript1\.[0-5]))$/;

/** A registry's side of a document or a worker that is one of its clients. */
export interface ServiceClientSeams {
  url(): string;
  /** The address it was created at, which a worker's scope is held to. */
  type: 'window' | 'worker' | 'sharedworker';
  frameType(): 'top-level' | 'nested' | 'auxiliary' | 'none';
  focused(): boolean;
  visibility(): string;
  /** Whether it is in the back-forward cache: no client a worker can reach. */
  frozen(): boolean;
  /** Told, a task from now, as `__sw`. */
  tell(text: string): void;
  fetch(request: FetchRequest, signal: AbortSignalLike): Promise<FetchResponse>;
  navigate(url: string, how: 'here' | 'tab'): void;
  /** What a worker started while it is the latest is given of the page. */
  workerSeams(): Partial<PageWorkersSeams> & { keySecrets?: Uint8Array[] };
  caches(origin: string, ask: HtmlCacheAsk): HtmlCacheAnswer;
}

interface Version {
  id: string;
  url: string;
  type: 'classic' | 'module';
  state:
    | 'parsed'
    | 'installing'
    | 'installed'
    | 'activating'
    | 'activated'
    | 'redundant';
  registration: Registration;
  scripts: Map<string, HtmlServiceWorkerScript>;
  /** Null until its script has run once. */
  handlesFetch: boolean | null;
  skipWaiting: boolean;
  thread: number | null;
  starting: Promise<boolean> | null;
  started: ((ran: boolean) => void) | null;
  /** What is under way in it: its thread stays while any is. */
  busy: number;
  idle: unknown;
  /** Fetches waiting for it to be activated. */
  activated: (() => void)[];
}

interface Registration {
  id: string;
  scope: string;
  origin: string;
  updateViaCache: HtmlServiceWorkerUpdateViaCache;
  preload: { enabled: boolean; header: string };
  lastCheck: number;
  installing: Version | null;
  waiting: Version | null;
  active: Version | null;
  uninstalling: boolean;
  softUpdate: unknown;
  /** Whether the store has it. */
  stored: boolean;
}

/** One step of a scope's queue (Service Workers 1, 8, "Job"). */
interface Job {
  kind: 'register' | 'update' | 'unregister';
  scope: string;
  script: string;
  type: 'classic' | 'module';
  updateViaCache: HtmlServiceWorkerUpdateViaCache;
  /** Those waiting on it: an equivalent job joins the one queued. */
  answers: {
    resolve(registration: Registration | boolean): void;
    reject(error: JobError): void;
  }[];
}

/** What a job failed with, as a realm rejects with it. */
class JobError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

/** A worker as a realm's objects read it. */
interface WorkerView {
  i: string;
  u: string;
  s: string;
}

/** A body a worker hands on a piece at a time. */
class BodyQueue implements AsyncIterable<Uint8Array> {
  private _chunks: Uint8Array[] = [];
  private _waiting: ((r: IteratorResult<Uint8Array>) => void) | null = null;
  private _failing: ((e: Error) => void) | null = null;
  private _ended = false;
  private _error: Error | null = null;
  constructor(private readonly _cancelled: () => void) {}
  push(bytes: Uint8Array): void {
    if (this._waiting) {
      const resolve = this._waiting;
      this._waiting = this._failing = null;
      resolve({ done: false, value: bytes });
    } else this._chunks.push(bytes);
  }
  end(error: string | null): void {
    this._ended = true;
    if (error) this._error = new TypeError(error);
    const resolve = this._waiting;
    const reject = this._failing;
    this._waiting = this._failing = null;
    if (this._error) reject?.(this._error);
    else resolve?.({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const chunk = this._chunks.shift();
        if (chunk) return Promise.resolve({ done: false, value: chunk });
        if (this._error) return Promise.reject(this._error);
        if (this._ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
          this._waiting = resolve;
          this._failing = reject;
        });
      },
      return: () => {
        this._cancelled();
        this.end(null);
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
};

const uuid = (): string => crypto.randomUUID();

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

const utf8 = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const textOf = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('utf8');
const base64Of = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64');
const bytesOf = (base64: string): Uint8Array => Buffer.from(base64, 'base64');

const headerIn = (headers: [string, string][], name: string): string | null => {
  for (const [k, v] of headers) if (k.toLowerCase() === name) return v;
  return null;
};

/** The bytes of a response a network answered whole. */
function responseBytes(response: FetchResponse): Uint8Array {
  return response.bytes ?? utf8(response.body ?? '');
}

/** A document, or a worker of a page's, that a service worker can have in its
 *  `clients`, and that asks the registry for what its realm is asked. */
export class ServiceClient {
  controller: Version | null = null;
  /** Answers `navigator.serviceWorker.ready`, once something does. */
  readyAsked: number | null = null;
  constructor(
    private readonly _registry: ServiceWorkerRegistry,
    readonly id: string,
    readonly seams: ServiceClientSeams,
  ) {}
  get url(): string {
    return this.seams.url();
  }
  get origin(): string {
    return originOf(this.seams.url());
  }
  /** Whether a worker answers what this asks for. */
  get controlled(): boolean {
    return this.controller !== null;
  }
  /** What the realm asked: said at once where the realm needs it at once. */
  heard(text: string): string | null {
    return this._registry.fromClient(this, text);
  }
  /** A subresource: what the controller answered, or null for the network. */
  fetch(
    request: HtmlServiceWorkerRequest,
    signal: AbortSignalLike,
  ): Promise<FetchResponse | null> {
    return this._registry.subresource(this, request, signal);
  }
  /** A subresource `<Html>` asked for, as it takes one back: undefined where
   *  the network is to answer, and null for nothing there. */
  async resource(
    url: string,
    kind: ResourceKind,
    cors: boolean,
  ): Promise<ResourceResult | null | undefined> {
    const controller = new AbortController();
    let response: FetchResponse | null;
    try {
      response = await this.fetch(
        {
          url,
          method: 'GET',
          headers: [],
          body: null,
          mode: cors || kind === 'font' ? 'cors' : 'no-cors',
          credentials: cors || kind === 'font' ? 'same-origin' : 'include',
          destination: DESTINATIONS[kind],
          referrer: this.url,
        },
        controller.signal,
      );
    } catch {
      return null;
    }
    if (!response) return undefined;
    // an opaque response has no status to read, and is drawn as it is
    const opaque = response.type === 'opaque';
    if (!opaque && (response.status < 200 || response.status > 299)) {
      void response.chunks?.[Symbol.asyncIterator]().return?.();
      return null;
    }
    const { type, charset } = contentType(
      headerIn(response.headers, 'content-type'),
    );
    return resourceResult(
      {
        url: response.url || url,
        status: response.status,
        type,
        charset,
        bytes: await wholeBytes(response),
      },
      kind,
    );
  }
  /** The document is gone. */
  detach(): void {
    this._registry.detach(this);
  }
}

/** The registry a keeper of service workers has, made the first time one is
 *  asked for. */
export function registryOf(workers: HtmlServiceWorkers): ServiceWorkerRegistry {
  let registry = registryKept(workers) as ServiceWorkerRegistry | undefined;
  if (!registry) {
    registry = new ServiceWorkerRegistry(workers);
    keepRegistry(workers, registry);
  }
  return registry;
}

export class ServiceWorkerRegistry implements HtmlServiceWorkerRegistry {
  private _registrations = new Map<string, Registration>();
  private _versions = new Map<string, Version>();
  private _byThread = new Map<number, Version>();
  private _clients = new Map<string, ServiceClient>();
  private _queues = new Map<string, Job[]>();
  private _threads: PageWorkers | null = null;
  /** Whose seams a worker is started with: the client last attached. */
  private _latest: ServiceClient | null = null;
  /** The ids navigations reserved, by the address the document arrives at. */
  private _reserved = new Map<string, string>();
  /** Fetches and extendable events a worker has yet to answer, by number. */
  private _fetches = new Map<number, PendingFetch>();
  private _events = new Map<number, PendingEvent>();
  private _serial = 0;
  /** Those who navigated somewhere and wait to hear of the document. */
  private _navigating = new Map<string, (client: ServiceClient) => void>();
  /** The memory `caches` where no client's host hands a store. */
  private _ownCaches: HtmlCacheStore | null = null;

  constructor(private readonly _keeper: HtmlServiceWorkers) {}

  // --- clients ---------------------------------------------------------------

  /**
   * A document in a secure context, or a worker of one, as its realm starts.
   * What controls it is what controlled the navigation that made it: the
   * active worker whose scope holds its address, unless a hard reload asked
   * past it. A local document (`about:blank`, a `blob:`, an `about:srcdoc`) is
   * its parent's, as its origin is.
   */
  attach(
    seams: ServiceClientSeams,
    parent: ServiceClient | null,
  ): ServiceClient {
    const url = seams.url();
    const key = url.split('#')[0];
    const reserved = this._reserved.get(key);
    if (reserved) this._reserved.delete(key);
    const client = new ServiceClient(this, reserved ?? uuid(), seams);
    this._clients.set(client.id, client);
    this._latest = client;
    if (!/^https?:/i.test(url)) client.controller = parent?.controller ?? null;
    else if (!this._keeper.bypassing.delete(key)) {
      client.controller = this._match(url)?.active ?? null;
    }
    for (const [address, told] of this._navigating) {
      if (address === key) {
        this._navigating.delete(address);
        told(client);
      }
    }
    return client;
  }

  /** Service Workers 1, "Handle Service Worker Client Unload". */
  detach(client: ServiceClient): void {
    if (!this._clients.delete(client.id)) return;
    if (this._latest === client) {
      this._latest = [...this._clients.values()].at(-1) ?? null;
    }
    const registration = client.controller?.registration;
    client.controller = null;
    if (!registration) return;
    if (registration.uninstalling) this._tryClear(registration);
    else void this._tryActivate(registration);
  }

  private _inUse(registration: Registration): boolean {
    for (const client of this._clients.values()) {
      if (client.controller?.registration === registration) return true;
    }
    return false;
  }

  // --- the store -------------------------------------------------------------

  /** What the store holds of an origin that this process does not know, or
   *  knows an older worker of. A registration another process took away goes
   *  as its clients do. */
  private _sync(origin: string): void {
    const kept = new Set<string>();
    for (const { scope, active } of this._keeper.store.scopes(origin)) {
      kept.add(scope);
      const known = this._registrations.get(scope);
      if (known && (!active || known.active?.id === active)) continue;
      if (known && (known.installing || known.waiting)) continue;
      const record = this._keeper.store.load(scope);
      if (record) this._restore(record, known);
    }
    for (const registration of [...this._registrations.values()]) {
      if (
        registration.origin === origin &&
        registration.stored &&
        !kept.has(registration.scope)
      ) {
        this._registrations.delete(registration.scope);
        registration.uninstalling = true;
        this._tryClear(registration);
      }
    }
  }

  /** A registration from the store, its worker's thread not started. */
  private _restore(
    record: HtmlServiceWorkerRecord,
    known: Registration | undefined,
  ): void {
    const registration: Registration = known ?? {
      id: uuid(),
      scope: record.scope,
      origin: record.origin,
      updateViaCache: record.updateViaCache,
      preload: record.preload,
      lastCheck: record.lastCheck,
      installing: null,
      waiting: null,
      active: null,
      uninstalling: false,
      softUpdate: null,
      stored: true,
    };
    registration.preload = record.preload;
    registration.lastCheck = record.lastCheck;
    if (record.active) {
      const was = registration.active;
      registration.active = this._version(record.active, registration);
      registration.active.state = 'activated';
      if (was) this._redundant(was);
    }
    if (record.waiting) {
      registration.waiting = this._version(record.waiting, registration);
      registration.waiting.state = 'installed';
    }
    this._registrations.set(record.scope, registration);
    if (registration.waiting) void this._tryActivate(registration);
  }

  private _version(
    record: HtmlServiceWorkerVersion,
    registration: Registration,
  ): Version {
    const version = this._makeVersion(
      record.url,
      record.type,
      registration,
      record.id,
    );
    version.handlesFetch = record.handlesFetch;
    for (const script of record.scripts) {
      version.scripts.set(script.url, script);
    }
    return version;
  }

  private _makeVersion(
    url: string,
    type: 'classic' | 'module',
    registration: Registration,
    id: string = uuid(),
  ): Version {
    const version: Version = {
      id,
      url,
      type,
      state: 'parsed',
      registration,
      scripts: new Map(),
      handlesFetch: null,
      skipWaiting: false,
      thread: null,
      starting: null,
      started: null,
      busy: 0,
      idle: null,
      activated: [],
    };
    this._versions.set(id, version);
    return version;
  }

  /** A registration kept past the process, where it has a worker that
   *  finished installing. */
  private _persist(registration: Registration): void {
    const { scope, origin, active, waiting } = registration;
    if (registration.uninstalling) return;
    if (!active && !waiting) {
      this._keeper.store.delete(scope);
      registration.stored = false;
      return;
    }
    const record = (v: Version | null): HtmlServiceWorkerVersion | null =>
      v && {
        id: v.id,
        url: v.url,
        type: v.type,
        handlesFetch: v.handlesFetch ?? true,
        scripts: [...v.scripts.values()],
      };
    this._keeper.store.save({
      scope,
      origin,
      updateViaCache: registration.updateViaCache,
      preload: registration.preload,
      lastCheck: registration.lastCheck,
      active: record(active),
      waiting: record(waiting),
    });
    registration.stored = true;
  }

  /** Service Workers 1, "Match Service Worker Registration": the longest
   *  scope that holds the URL. */
  private _match(url: string): Registration | null {
    this._sync(originOf(url));
    let best: Registration | null = null;
    for (const registration of this._registrations.values()) {
      if (
        !registration.uninstalling &&
        inScope(url, registration.scope) &&
        (!best || registration.scope.length > best.scope.length)
      ) {
        best = registration;
      }
    }
    return best;
  }

  // --- what clients and workers are told ------------------------------------

  private _workerView(version: Version | null): WorkerView | null {
    return version && { i: version.id, u: version.url, s: version.state };
  }

  private _view(registration: Registration): unknown {
    return {
      i: registration.id,
      scope: registration.scope,
      uvc: registration.updateViaCache,
      installing: this._workerView(registration.installing),
      waiting: this._workerView(registration.waiting),
      active: this._workerView(registration.active),
    };
  }

  /** Told to every realm of an origin that may hold an object for it. */
  private _tellOrigin(origin: string, message: unknown): void {
    const text = JSON.stringify(message);
    for (const client of this._clients.values()) {
      if (client.origin === origin) client.seams.tell(text);
    }
    for (const version of this._byThread.values()) {
      if (version.registration.origin === origin) this._post(version, text);
    }
  }

  private _setRegistration(
    registration: Registration,
    which: 'installing' | 'waiting' | 'active',
    version: Version | null,
  ): void {
    registration[which] = version;
    this._tellOrigin(registration.origin, {
      reg: this._view(registration),
    });
  }

  private _setState(version: Version, state: Version['state']): void {
    version.state = state;
    this._tellOrigin(version.registration.origin, {
      worker: version.id,
      state,
    });
    if (state === 'activated') {
      for (const go of version.activated.splice(0)) go();
    }
  }

  // --- threads ---------------------------------------------------------------

  private _threadsOf(): PageWorkers {
    if (this._threads) return this._threads;
    const registry = this;
    const latest = (): ReturnType<ServiceClientSeams['workerSeams']> =>
      registry._latest?.seams.workerSeams() ?? {};
    const seams: PageWorkersSeams = {
      fetch: (request, signal, thread) => {
        const version =
          thread === undefined ? null : this._byThread.get(thread);
        return this._network(
          version?.registration.scope ?? '',
          request,
          signal,
        );
      },
      get webTransport() {
        return latest().webTransport;
      },
      get webSocket() {
        return latest().webSocket;
      },
      get notifications() {
        return latest().notifications;
      },
      permissions: () => latest().permissions?.() ?? {},
      log: (level, text) => latest().log?.(level, text),
      get userAgent() {
        return latest().userAgent ?? registry._keeper.network?.userAgent ?? '';
      },
      get language() {
        return latest().language ?? 'en-US';
      },
      letGo() {},
      message() {},
      error: (id, message, filename, line, column) => {
        latest().log?.(
          'error',
          `A service worker threw: ${message} (${filename}:${line}:${column})`,
        );
        // a script that failed to come up says so here where nothing else
        // will: a thread that died before it ran anything
        const version = this._byThread.get(id);
        if (version?.started) {
          const started = version.started;
          version.started = null;
          started(false);
        }
      },
      // what a page's worker says never takes the process with it
      service: (id, text, bytes) => {
        try {
          this._fromWorker(id, text, bytes);
        } catch (error) {
          latest().log?.(
            'error',
            `A service worker's message failed: ${String(error)}`,
          );
        }
      },
      script: (id, url) => this._importScript(id, url),
      exited: (id) => this._threadGone(id),
      caches: (origin, ask) => Promise.resolve(this.caches(origin, ask)),
    };
    this._threads = new PageWorkers(seams, MAX_THREADS, true);
    return this._threads;
  }

  /** `caches`, for a worker with a page to go by or none. */
  caches(origin: string, ask: HtmlCacheAsk): HtmlCacheAnswer {
    const kept = this._keeper.store.caches;
    if (kept) return askCaches(kept, origin, ask);
    const client = this._latest;
    if (client) return client.seams.caches(origin, ask);
    this._ownCaches ??= defaultStorage().caches ?? memoryCaches();
    return askCaches(this._ownCaches, origin, ask);
  }

  private _network(
    scope: string,
    request: FetchRequest,
    signal: AbortSignalLike,
  ): Promise<FetchResponse> {
    const network = this._keeper.network;
    if (network) return network.fetch(scope, request, signal);
    const client = this._latest;
    if (client) return client.seams.fetch(request, signal);
    return Promise.reject(new TypeError('Failed to fetch'));
  }

  /**
   * Service Workers 1, "Run Service Worker": its thread, its script run from
   * what the store has of it, and whether that went. Asked by whatever needs
   * it to hear something, and answered at once where it is running.
   */
  private _start(version: Version): Promise<boolean> {
    if (version.thread !== null && !version.started) {
      this._touch(version);
      return Promise.resolve(true);
    }
    if (version.starting) return version.starting;
    const main = version.scripts.get(version.url);
    if (!main || version.state === 'redundant') return Promise.resolve(false);
    const started = new Promise<boolean>((resolve) => {
      const threads = this._threadsOf();
      const { registration } = version;
      const id = threads.start({
        url: version.url,
        type: version.type,
        name: '',
        source: textOf(main.body),
        origin: registration.origin,
        secure: true,
        keySecrets: this._latest?.seams.workerSeams().keySecrets ?? [],
        service: {
          scope: registration.scope,
          worker: this._workerView(version),
          registration: this._view(registration),
        },
      });
      version.thread = id;
      this._byThread.set(id, version);
      // what asked to start it is waiting on it
      threads.hold(id, true);
      const timer = setTimeout(() => {
        if (!version.started) return;
        version.started = null;
        resolve(false);
      }, START_MS);
      timer.unref?.();
      version.started = (ran) => {
        clearTimeout(timer);
        if (version.busy === 0) threads.hold(id, false);
        resolve(ran);
      };
    });
    version.starting = started.then((ran) => {
      version.starting = null;
      version.started = null;
      if (!ran) this._stop(version);
      else this._touch(version);
      return ran;
    });
    return version.starting;
  }

  /** A worker with nothing to do gives its thread up after a while. */
  private _touch(version: Version): void {
    if (version.idle !== null) clearTimeout(version.idle);
    version.idle = null;
    if (version.busy > 0 || version.thread === null) return;
    const timer = setTimeout(() => {
      version.idle = null;
      if (version.busy === 0) this._stop(version);
    }, this._keeper.idleMs);
    timer.unref?.();
    version.idle = timer;
  }

  private _stop(version: Version): void {
    const { thread } = version;
    if (thread === null) return;
    version.thread = null;
    this._byThread.delete(thread);
    this._threads?.end(thread);
    this._finishAll(version);
  }

  private _threadGone(thread: number): void {
    const version = this._byThread.get(thread);
    if (!version) return;
    version.thread = null;
    this._byThread.delete(thread);
    if (version.started) {
      const started = version.started;
      version.started = null;
      started(false);
    }
    this._finishAll(version);
  }

  /** What was waiting on a thread that went hears it went: a fetch goes to
   *  the network, as one to a worker that cannot run does. */
  private _finishAll(version: Version): void {
    for (const [n, pending] of this._events) {
      if (pending.version !== version) continue;
      this._events.delete(n);
      pending.done(false);
    }
    for (const [f, pending] of this._fetches) {
      if (pending.version !== version) continue;
      this._fetches.delete(f);
      if (pending.body) pending.body.end('The worker stopped.');
      else pending.resolve(null);
    }
    version.busy = 0;
  }

  private _post(version: Version, text: string): void {
    if (version.thread !== null) this._threads?.service(version.thread, text);
  }

  /** Something is under way in a worker. */
  private _begin(version: Version): void {
    version.busy += 1;
    if (version.idle !== null) clearTimeout(version.idle);
    version.idle = null;
    if (version.thread !== null) this._threads?.hold(version.thread, true);
  }

  private _end(version: Version): void {
    version.busy = Math.max(0, version.busy - 1);
    if (version.busy > 0) return;
    if (version.thread !== null) this._threads?.hold(version.thread, false);
    this._touch(version);
    const { registration } = version;
    if (registration.uninstalling) this._tryClear(registration);
    else if (registration.active === version) {
      void this._tryActivate(registration);
    }
  }

  /** An event a worker can keep alive (`ExtendableEvent`), and whether what
   *  it waited on came to anything. */
  private async _extendable(
    version: Version,
    type: string,
    fields: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!(await this._start(version))) return false;
    const n = ++this._serial;
    this._begin(version);
    return new Promise<boolean>((resolve) => {
      this._events.set(n, {
        version,
        done: (ok) => {
          this._end(version);
          resolve(ok);
        },
      });
      this._post(version, JSON.stringify({ event: type, n, ...fields }));
    });
  }

  /** Each script a worker imports: the one the store has, or, while it
   *  installs, the network's, kept for the next time it runs (Service Workers
   *  1, "importScripts"). Past that, one it did not import is no script. */
  private async _importScript(
    thread: number,
    url: string,
  ): Promise<string | null> {
    const version = this._byThread.get(thread);
    if (!version) return null;
    const kept = version.scripts.get(url);
    if (kept) return textOf(kept.body);
    if (version.state !== 'parsed' && version.state !== 'installing') {
      return null;
    }
    try {
      const script = await this._fetchScript(url, version.registration, false);
      version.scripts.set(url, script);
      return textOf(script.body);
    } catch {
      return null;
    }
  }

  // --- jobs ------------------------------------------------------------------

  private _enqueue(job: Job): void {
    const queue = this._queues.get(job.scope) ?? [];
    this._queues.set(job.scope, queue);
    const last = queue.at(-1);
    // a job the same as the one queued last shares its result, unless that
    // one has begun (Service Workers 1, "Schedule Job")
    if (
      last &&
      queue.length > 1 &&
      last.kind === job.kind &&
      last.script === job.script &&
      last.type === job.type &&
      last.updateViaCache === job.updateViaCache
    ) {
      last.answers.push(...job.answers);
      return;
    }
    queue.push(job);
    // begun in a task of its own: what it tells is never told inside the op
    // that asked
    if (queue.length === 1) setTimeout(() => void this._next(job.scope), 0);
  }

  private async _next(scope: string): Promise<void> {
    const queue = this._queues.get(scope);
    const job = queue?.[0];
    if (!job) {
      this._queues.delete(scope);
      return;
    }
    try {
      if (job.kind === 'unregister') this._unregister(job);
      else if (job.kind === 'register') await this._register(job);
      else await this._update(job, this._registrations.get(scope) ?? null);
    } catch (error) {
      for (const answer of job.answers.splice(0)) {
        answer.reject(
          error instanceof JobError
            ? error
            : new JobError('TypeError', String(error)),
        );
      }
    }
    queue!.shift();
    if (queue!.length) void this._next(scope);
    else this._queues.delete(scope);
  }

  private _resolve(job: Job, value: Registration | boolean): void {
    for (const answer of job.answers.splice(0)) answer.resolve(value);
  }

  /** Service Workers 1, "Register". */
  private async _register(job: Job): Promise<void> {
    this._sync(originOf(job.scope));
    let registration = this._registrations.get(job.scope);
    if (registration) {
      const newest =
        registration.installing ?? registration.waiting ?? registration.active;
      if (
        newest &&
        newest.url === job.script &&
        newest.type === job.type &&
        registration.updateViaCache === job.updateViaCache
      ) {
        this._resolve(job, registration);
        return;
      }
      registration.updateViaCache = job.updateViaCache;
    } else {
      registration = {
        id: uuid(),
        scope: job.scope,
        origin: originOf(job.scope),
        updateViaCache: job.updateViaCache,
        preload: { enabled: false, header: 'true' },
        lastCheck: 0,
        installing: null,
        waiting: null,
        active: null,
        uninstalling: false,
        softUpdate: null,
        stored: false,
      };
      this._registrations.set(job.scope, registration);
    }
    await this._update(job, registration);
  }

  /** Whether a registration goes with the job that failed to give it a
   *  worker (Service Workers 1, "Clear Registration"). */
  private _dropEmpty(registration: Registration): void {
    if (
      registration.installing ||
      registration.waiting ||
      registration.active
    ) {
      return;
    }
    if (this._registrations.get(registration.scope) === registration) {
      this._registrations.delete(registration.scope);
    }
    this._keeper.store.delete(registration.scope);
  }

  /** Service Workers 1, "Update": its script asked for, compared with what
   *  it has, and a new worker made of what is new. */
  private async _update(
    job: Job,
    registration: Registration | null,
  ): Promise<void> {
    if (!registration || registration.uninstalling) {
      throw new JobError(
        'TypeError',
        'Failed to update a ServiceWorker: the registration is gone.',
      );
    }
    const newest =
      registration.installing ?? registration.waiting ?? registration.active;
    if (job.kind === 'update' && newest && newest.url !== job.script) {
      throw new JobError(
        'TypeError',
        'Failed to update a ServiceWorker: its script changed.',
      );
    }
    const type = job.kind === 'update' && newest ? newest.type : job.type;
    let main: HtmlServiceWorkerScript;
    try {
      main = await this._fetchScript(job.script, registration, true);
    } catch (error) {
      if (job.kind === 'register') this._dropEmpty(registration);
      throw error;
    }
    registration.lastCheck = Date.now();
    if (
      newest &&
      newest.url === job.script &&
      newest.type === type &&
      (await this._sameAs(newest, main))
    ) {
      this._persist(registration);
      this._resolve(job, registration);
      return;
    }
    const version = this._makeVersion(job.script, type, registration);
    version.scripts.set(job.script, main);
    const ran = await this._start(version);
    if (!ran) {
      this._forget(version);
      this._dropEmpty(registration);
      throw new JobError(
        'TypeError',
        `Failed to register a ServiceWorker for scope ('${registration.scope}') with script ('${job.script}'): ServiceWorker script evaluation failed`,
      );
    }
    await this._install(job, registration, version);
  }

  /** Whether a worker's scripts are what the network has now: its main
   *  script, and each it imported (Service Workers 1, "hasUpdatedResources"). */
  private async _sameAs(
    version: Version,
    main: HtmlServiceWorkerScript,
  ): Promise<boolean> {
    const held = version.scripts.get(version.url);
    if (!held || !sameBytes(held.body, main.body)) return false;
    for (const script of version.scripts.values()) {
      if (script.url === version.url) continue;
      try {
        const now = await this._fetchScript(
          script.url,
          version.registration,
          false,
        );
        if (!sameBytes(now.body, script.body)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** A script, from the network, held to what a worker's script is held to
   *  (Service Workers 1, "Update", its fetch's steps). */
  private async _fetchScript(
    url: string,
    registration: Registration,
    main: boolean,
  ): Promise<HtmlServiceWorkerScript> {
    let response: FetchResponse;
    try {
      response = await this._network(
        registration.scope,
        {
          url,
          method: 'GET',
          headers: [['service-worker', 'script']],
          body: null,
          credentials: 'same-origin',
        },
        new AbortController().signal,
      );
    } catch {
      throw new JobError(
        'TypeError',
        `Failed to register a ServiceWorker for scope ('${registration.scope}') with script ('${url}'): An unknown error occurred when fetching the script.`,
      );
    }
    if (response.status < 200 || response.status > 299) {
      throw new JobError(
        'TypeError',
        `Failed to register a ServiceWorker for scope ('${registration.scope}') with script ('${url}'): A bad HTTP response code (${response.status}) was received when fetching the script.`,
      );
    }
    if (response.redirected) {
      throw new JobError(
        'TypeError',
        `Failed to register a ServiceWorker for scope ('${registration.scope}') with script ('${url}'): The script resource is behind a redirect, which is disallowed.`,
      );
    }
    const type = headerIn(response.headers, 'content-type') ?? '';
    if (!JS_MIME.test(type.split(';')[0].trim().toLowerCase())) {
      throw new JobError(
        'SecurityError',
        `Failed to register a ServiceWorker for scope ('${registration.scope}') with script ('${url}'): The script has an unsupported MIME type ('${type}').`,
      );
    }
    if (main) {
      const allowed = headerIn(response.headers, 'service-worker-allowed');
      const script = new URL(url);
      const max =
        allowed === null
          ? script.pathname.replace(/[^/]*$/, '')
          : new URL(allowed, script).pathname;
      const path = new URL(registration.scope).pathname;
      if (!path.startsWith(max)) {
        throw new JobError(
          'SecurityError',
          `Failed to register a ServiceWorker for scope ('${registration.scope}') with script ('${url}'): The path of the provided scope ('${path}') is not under the max scope allowed ('${max}'). Adjust the scope, move the Service Worker script, or use the Service-Worker-Allowed HTTP header to allow the scope.`,
        );
      }
    }
    return { url, type, body: responseBytes(response) };
  }

  /** A worker that came to nothing. */
  private _forget(version: Version): void {
    this._stop(version);
    version.state = 'redundant';
    this._versions.delete(version.id);
  }

  /** Service Workers 1, "Install". The job's promise is kept as it starts,
   *  and the job is over once it has finished. */
  private async _install(
    job: Job,
    registration: Registration,
    version: Version,
  ): Promise<void> {
    this._setRegistration(registration, 'installing', version);
    this._setState(version, 'installing');
    this._resolve(job, registration);
    this._tellOrigin(registration.origin, { found: registration.id });
    const installed = await this._extendable(version, 'install');
    if (!installed || registration.installing !== version) {
      if (registration.installing === version) {
        this._setRegistration(registration, 'installing', null);
      }
      this._redundant(version);
      this._dropEmpty(registration);
      return;
    }
    const was = registration.waiting;
    if (was) this._redundant(was);
    registration.installing = null;
    this._setRegistration(registration, 'waiting', version);
    this._setState(version, 'installed');
    this._persist(registration);
    // the job's over: what comes after it waits on the clients, and a page
    // that does not leave would hold every later job of the scope
    setTimeout(() => void this._tryActivate(registration), 0);
  }

  /** A worker that will do nothing more. */
  private _redundant(version: Version): void {
    if (version.state === 'redundant') return;
    this._stop(version);
    const { registration } = version;
    for (const which of ['installing', 'waiting', 'active'] as const) {
      if (registration[which] === version) {
        this._setRegistration(registration, which, null);
      }
    }
    this._setState(version, 'redundant');
    for (const go of version.activated.splice(0)) go();
    this._versions.delete(version.id);
  }

  /** Service Workers 1, "Try Activate". */
  private async _tryActivate(registration: Registration): Promise<void> {
    const { waiting, active } = registration;
    if (!waiting) return;
    if (active?.state === 'activating') return;
    if (
      !active ||
      (active.busy === 0 && (!this._inUse(registration) || waiting.skipWaiting))
    ) {
      await this._activate(registration);
    }
  }

  /** Service Workers 1, "Activate". */
  private async _activate(registration: Registration): Promise<void> {
    const next = registration.waiting;
    if (!next) return;
    const was = registration.active;
    registration.waiting = null;
    if (was) this._redundant(was);
    registration.active = next;
    this._tellOrigin(registration.origin, {
      reg: this._view(registration),
    });
    this._setState(next, 'activating');
    this._persist(registration);
    for (const client of this._clients.values()) {
      if (client.controller?.registration === registration) {
        this._control(client, next);
      }
      if (client.readyAsked !== null) this._ready(client);
    }
    await this._extendable(next, 'activate');
    if (next.state === 'activating') this._setState(next, 'activated');
    if (registration.uninstalling) this._tryClear(registration);
  }

  private _control(client: ServiceClient, version: Version): void {
    client.controller = version;
    client.seams.tell(
      JSON.stringify({ controller: this._workerView(version) }),
    );
  }

  /** `navigator.serviceWorker.ready`, where the scope that holds its client
   *  has an active worker. */
  private _ready(client: ServiceClient): void {
    if (client.readyAsked === null) return;
    const registration = this._match(client.url);
    if (!registration?.active) return;
    const n = client.readyAsked;
    client.readyAsked = null;
    client.seams.tell(
      JSON.stringify({ a: n, registration: this._view(registration) }),
    );
  }

  /** Service Workers 1, "Unregister". */
  private _unregister(job: Job): void {
    const registration = this._registrations.get(job.scope);
    if (!registration) {
      this._resolve(job, false);
      return;
    }
    this._registrations.delete(job.scope);
    registration.uninstalling = true;
    this._keeper.store.delete(job.scope);
    this._resolve(job, true);
    this._tryClear(registration);
  }

  /** Service Workers 1, "Try Clear Registration": nothing uses it, and its
   *  workers are finished. */
  private _tryClear(registration: Registration): void {
    if (!registration.uninstalling || this._inUse(registration)) return;
    for (const which of ['installing', 'waiting', 'active'] as const) {
      const version = registration[which];
      if (version?.busy) return;
    }
    for (const which of ['installing', 'waiting', 'active'] as const) {
      const version = registration[which];
      if (version) this._redundant(version);
    }
  }

  /** Service Workers 1, "Soft Update": a navigation asks about its worker's
   *  script, a moment after the page has what it asked for. */
  private _softUpdate(registration: Registration): void {
    if (registration.softUpdate !== null) return;
    const timer = setTimeout(() => {
      registration.softUpdate = null;
      const newest =
        registration.installing ?? registration.waiting ?? registration.active;
      if (!newest || registration.uninstalling) return;
      this._enqueue({
        kind: 'update',
        scope: registration.scope,
        script: newest.url,
        type: newest.type,
        updateViaCache: registration.updateViaCache,
        answers: [{ resolve() {}, reject() {} }],
      });
    }, SOFT_UPDATE_MS);
    timer.unref?.();
    registration.softUpdate = timer;
  }

  // --- fetch -----------------------------------------------------------------

  /** A navigation (`HtmlServiceWorkers.navigation`). */
  async navigation(
    request: HtmlServiceWorkerRequest,
    signal: AbortSignalLike,
  ): Promise<FetchResponse | null> {
    const registration = this._match(request.url);
    const version = registration?.active;
    if (!registration || !version) return null;
    const resulting = uuid();
    this._reserved.set(request.url.split('#')[0], resulting);
    const answered = await this._dispatch(
      version,
      request,
      signal,
      resulting,
      registration.preload.enabled,
    );
    this._softUpdate(registration);
    return answered;
  }

  /** A subresource of a controlled client. */
  subresource(
    client: ServiceClient,
    request: HtmlServiceWorkerRequest,
    signal: AbortSignalLike,
  ): Promise<FetchResponse | null> {
    const version = client.controller;
    if (!version) return Promise.resolve(null);
    return this._dispatch(
      version,
      { ...request, clientId: client.id },
      signal,
      '',
      false,
    );
  }

  /**
   * Service Workers 1, "Handle Fetch": what a worker's `fetch` event comes to.
   * Null where the network is to answer: no handler, no `respondWith`, or a
   * worker that could not be run. A rejection is a network error, which is
   * what a `respondWith` that came to nothing is.
   */
  private async _dispatch(
    version: Version,
    request: HtmlServiceWorkerRequest,
    signal: AbortSignalLike,
    resultingClientId: string,
    preload: boolean,
  ): Promise<FetchResponse | null> {
    if (version.handlesFetch === false) return null;
    if (version.state === 'activating') {
      await new Promise<void>((go) => version.activated.push(go));
    }
    if (version.state !== 'activated') return null;
    if (!(await this._start(version))) return null;
    if (!version.handlesFetch) return null;
    if (signal.aborted) throw new TypeError('The fetch was aborted.');
    const f = ++this._serial;
    this._begin(version);
    const wire = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      base64: request.bytes
        ? base64Of(request.bytes)
        : request.body
          ? base64Of(utf8(request.body))
          : null,
      mode: request.mode,
      credentials: request.credentials ?? 'same-origin',
      cache: request.cache ?? 'default',
      redirect: request.redirect ?? 'follow',
      referrer: request.referrer ?? '',
      referrerPolicy: request.referrerPolicy ?? '',
      integrity: request.integrity ?? '',
      destination: request.destination,
      reload: !!request.reload,
    };
    return new Promise<FetchResponse | null>((resolve, reject) => {
      this._fetches.set(f, {
        version,
        resolve: (answer) => {
          this._end(version);
          resolve(answer);
        },
        reject: (error) => {
          this._end(version);
          reject(error);
        },
        body: null,
      });
      signal.addEventListener(
        'abort',
        () => {
          this._post(version, JSON.stringify({ abort: f }));
          const pending = this._fetches.get(f);
          if (pending?.body) {
            this._fetches.delete(f);
            pending.body.end('The fetch was aborted.');
            this._end(version);
          } else if (pending) {
            this._fetches.delete(f);
            pending.reject(new TypeError('The fetch was aborted.'));
          }
        },
        { once: true },
      );
      this._post(
        version,
        JSON.stringify({
          event: 'fetch',
          f,
          request: wire,
          clientId: request.clientId ?? '',
          resultingClientId,
          preload,
        }),
      );
      if (preload) this._preload(version, f, request);
    });
  }

  /** `navigationPreload`: the navigation's request made as the worker starts
   *  on it, so a worker that wants it does not wait for itself. */
  private _preload(
    version: Version,
    f: number,
    request: HtmlServiceWorkerRequest,
  ): void {
    const { registration } = version;
    const said = (message: Record<string, unknown>): void =>
      this._post(version, JSON.stringify({ preloaded: f, ...message }));
    this._network(
      registration.scope,
      {
        url: request.url,
        method: request.method,
        headers: [
          ...request.headers,
          ['service-worker-navigation-preload', registration.preload.header],
        ],
        body: request.body,
        ...(request.bytes ? { bytes: request.bytes } : {}),
        credentials: 'include',
      },
      new AbortController().signal,
    ).then(
      (response) =>
        said({
          head: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            url: response.url,
            redirected: response.redirected,
            type: 'basic',
          },
          base64: base64Of(responseBytes(response)),
        }),
      () => said({ failed: true }),
    );
  }

  // --- what a realm asks ------------------------------------------------------

  /** What a client's realm asked, by the `sw` op. */
  fromClient(client: ServiceClient, text: string): string | null {
    const m = JSON.parse(text) as ClientAsk;
    const answer = (fields: Record<string, unknown>): void =>
      client.seams.tell(JSON.stringify({ a: m.n, ...fields }));
    switch (m.op) {
      case 'hello':
        return JSON.stringify({
          controller: this._workerView(client.controller),
        });
      case 'register':
        this._enqueue({
          kind: 'register',
          scope: m.scope,
          script: m.script,
          type: m.type === 'module' ? 'module' : 'classic',
          updateViaCache: m.updateViaCache ?? 'imports',
          answers: [this._answers(answer)],
        });
        return null;
      case 'ready':
        client.readyAsked = m.n;
        this._ready(client);
        return null;
      case 'getRegistration': {
        const registration = this._match(m.url);
        answer({
          registration: registration ? this._view(registration) : null,
        });
        return null;
      }
      case 'getRegistrations': {
        this._sync(client.origin);
        const all: unknown[] = [];
        for (const registration of this._registrations.values()) {
          if (registration.origin === client.origin) {
            all.push(this._view(registration));
          }
        }
        answer({ registrations: all });
        return null;
      }
      case 'post':
        this._postTo(m.to, m.text, this._clientView(client));
        return null;
      default:
        return this._common(m, answer);
    }
  }

  /** What a worker's own realm asked, over its thread. */
  private _fromWorker(
    thread: number,
    text: string,
    bytes: Uint8Array | undefined,
  ): void {
    const version = this._byThread.get(thread);
    if (!version) return;
    const m = JSON.parse(text) as WorkerSaid;
    const answer = (fields: Record<string, unknown>): void =>
      this._post(
        version,
        JSON.stringify({ a: (m as { n?: number }).n, ...fields }),
      );
    switch (m.op) {
      case 'started':
        version.handlesFetch = m.fetch;
        version.started?.(m.ran);
        return;
      case 'done': {
        const pending = this._events.get(m.e);
        if (pending) {
          this._events.delete(m.e);
          pending.done(m.ok);
        }
        return;
      }
      case 'skipWaiting':
        version.skipWaiting = true;
        answer({});
        void this._tryActivate(version.registration);
        return;
      case 'clients':
        this._clientsAsk(version, m, answer);
        return;
      case 'postClient': {
        const client = this._clients.get(m.client);
        client?.seams.tell(
          JSON.stringify({
            message: true,
            from: this._workerView(version),
            text: m.text,
          }),
        );
        return;
      }
      case 'post':
        this._postTo(m.to, m.text, this._workerView(version));
        return;
      case 'respond':
      case 'fallback':
      case 'refused':
      case 'chunk':
      case 'end':
        this._fetchSaid(version, m, bytes);
        return;
      default:
        void this._common(m, answer);
    }
  }

  /** What a page and a worker can both ask of a registration. */
  private _common(
    m: CommonAsk,
    answer: (fields: Record<string, unknown>) => void,
  ): null {
    switch (m.op) {
      case 'update': {
        const registration = this._byId(m.registration);
        const newest =
          registration &&
          (registration.installing ??
            registration.waiting ??
            registration.active);
        if (!registration || !newest) {
          answer({
            error: {
              name: 'InvalidStateError',
              message:
                'Failed to update a ServiceWorker: the registration has no worker.',
            },
          });
          return null;
        }
        this._enqueue({
          kind: 'update',
          scope: registration.scope,
          script: newest.url,
          type: newest.type,
          updateViaCache: registration.updateViaCache,
          answers: [this._answers(answer)],
        });
        return null;
      }
      case 'unregister': {
        const registration = this._byId(m.registration);
        if (!registration || registration.uninstalling) {
          answer({ value: false });
          return null;
        }
        this._enqueue({
          kind: 'unregister',
          scope: registration.scope,
          script: '',
          type: 'classic',
          updateViaCache: 'imports',
          answers: [this._answers(answer)],
        });
        return null;
      }
      case 'preload': {
        const registration = this._byId(m.registration);
        if (!registration || (m.what !== 'get' && !registration.active)) {
          answer({
            error: {
              name: 'InvalidStateError',
              message: 'The registration does not have an active worker.',
            },
          });
          return null;
        }
        if (m.what === 'enable') registration.preload.enabled = true;
        else if (m.what === 'disable') registration.preload.enabled = false;
        else if (m.what === 'header') registration.preload.header = m.value!;
        if (m.what !== 'get') this._persist(registration);
        answer({ state: registration.preload });
        return null;
      }
    }
    return null;
  }

  private _byId(id: string): Registration | null {
    for (const registration of this._registrations.values()) {
      if (registration.id === id) return registration;
    }
    return null;
  }

  private _answers(
    answer: (fields: Record<string, unknown>) => void,
  ): Job['answers'][number] {
    return {
      resolve: (value) =>
        answer(
          typeof value === 'boolean'
            ? { value }
            : { registration: this._view(value) },
        ),
      reject: (error) =>
        answer({ error: { name: error.kind, message: error.message } }),
    };
  }

  private _clientView(client: ServiceClient): unknown {
    return {
      id: client.id,
      url: client.url,
      type: client.seams.type,
      frameType: client.seams.frameType(),
      focused: client.seams.focused(),
      visibility: client.seams.visibility(),
      client: true,
    };
  }

  /** A message to a worker, which is started to hear it. */
  private _postTo(to: string, text: string, from: unknown): void {
    const version = this._versions.get(to);
    if (!version) return;
    void this._extendable(version, 'message', { text, from });
  }

  /** `clients` (Service Workers 1, 4.3). */
  private _clientsAsk(
    version: Version,
    m: ClientsAsk,
    answer: (fields: Record<string, unknown>) => void,
  ): void {
    const { registration } = version;
    const reachable = (): ServiceClient[] =>
      [...this._clients.values()].filter(
        (client) =>
          client.origin === registration.origin && !client.seams.frozen(),
      );
    switch (m.what) {
      case 'get': {
        const client = reachable().find((c) => c.id === m.id);
        answer({ client: client ? this._clientView(client) : null });
        return;
      }
      case 'matchAll': {
        const type = m.type ?? 'window';
        const list = reachable().filter(
          (client) =>
            (type === 'all' || client.seams.type === type) &&
            (m.includeUncontrolled ||
              client.controller?.registration === registration),
        );
        answer({ clients: list.map((c) => this._clientView(c)) });
        return;
      }
      case 'claim': {
        if (registration.active !== version) {
          answer({
            error: {
              name: 'InvalidStateError',
              message: 'Only the active worker can claim clients.',
            },
          });
          return;
        }
        for (const client of reachable()) {
          if (
            client.controller !== version &&
            this._match(client.url) === registration
          ) {
            const was = client.controller?.registration;
            this._control(client, version);
            // the registration it leaves may have been waiting for it
            if (was?.uninstalling) this._tryClear(was);
            else if (was && was !== registration) void this._tryActivate(was);
          }
        }
        answer({});
        return;
      }
      case 'navigate': {
        const client = this._clients.get(m.id!);
        if (client?.controller?.registration !== registration) {
          answer({
            error: {
              name: 'TypeError',
              message: 'This worker does not control that client.',
            },
          });
          return;
        }
        let to: string;
        try {
          to = new URL(m.url!, client.url).href;
        } catch {
          answer({
            error: {
              name: 'TypeError',
              message: 'The URL provided is invalid.',
            },
          });
          return;
        }
        const key = to.split('#')[0];
        const timer = setTimeout(() => {
          if (this._navigating.delete(key)) answer({ client: null });
        }, NAVIGATE_MS);
        timer.unref?.();
        this._navigating.set(key, (arrived) => {
          clearTimeout(timer);
          answer({ client: this._clientView(arrived) });
        });
        client.seams.navigate(to, 'here');
        return;
      }
      case 'openWindow': {
        const client = reachable().at(-1) ?? this._latest;
        if (!client) {
          answer({ client: null });
          return;
        }
        client.seams.navigate(m.url!, 'tab');
        answer({ client: null });
      }
    }
  }

  /** What a worker said of a `fetch` event it heard. */
  private _fetchSaid(
    version: Version,
    m: FetchSaid,
    bytes: Uint8Array | undefined,
  ): void {
    const pending = this._fetches.get(m.f);
    if (!pending) return;
    switch (m.op) {
      case 'fallback':
        this._fetches.delete(m.f);
        pending.resolve(null);
        return;
      case 'refused':
        this._fetches.delete(m.f);
        pending.reject(new TypeError('Failed to fetch'));
        return;
      case 'respond': {
        const { head } = m;
        if (head.type === 'error') {
          this._fetches.delete(m.f);
          pending.reject(new TypeError('Failed to fetch'));
          return;
        }
        const response: FetchResponse = {
          url: head.url,
          status: head.status,
          statusText: head.statusText,
          redirected: head.redirected,
          headers: head.headers,
          body: '',
          type: head.type as FetchResponse['type'],
        };
        if (m.streaming) {
          const body = new BodyQueue(() => {
            this._post(version, JSON.stringify({ cancel: m.f }));
            if (this._fetches.delete(m.f)) this._end(version);
          });
          pending.body = body;
          // the event is answered: what keeps the worker is the body
          this._begin(version);
          pending.resolve({ ...response, chunks: body });
          return;
        }
        this._fetches.delete(m.f);
        pending.resolve({
          ...response,
          bytes: bytes ?? (m.base64 ? bytesOf(m.base64) : new Uint8Array(0)),
        });
        return;
      }
      case 'chunk':
        pending.body?.push(bytesOf(m.base64));
        return;
      case 'end':
        this._fetches.delete(m.f);
        pending.body?.end(m.error ?? null);
        this._end(version);
    }
  }

  /** How many threads run, which a test asks. */
  get running(): number {
    return this._byThread.size;
  }

  /** Every thread let go, as the keeper's host goes. */
  dispose(): void {
    this._threads?.dispose();
    this._threads = null;
    this._byThread.clear();
  }
}

interface PendingFetch {
  version: Version;
  resolve(answer: FetchResponse | null): void;
  reject(error: Error): void;
  body: BodyQueue | null;
}

interface PendingEvent {
  version: Version;
  done(ok: boolean): void;
}

type CommonAsk =
  | { op: 'update'; n: number; registration: string }
  | { op: 'unregister'; n: number; registration: string }
  | {
      op: 'preload';
      n: number;
      registration: string;
      what: 'get' | 'enable' | 'disable' | 'header';
      value?: string;
    };

type ClientAsk =
  | CommonAsk
  | { op: 'hello'; n: number }
  | {
      op: 'register';
      n: number;
      scope: string;
      script: string;
      type: string;
      updateViaCache?: HtmlServiceWorkerUpdateViaCache;
    }
  | { op: 'ready'; n: number }
  | { op: 'getRegistration'; n: number; url: string }
  | { op: 'getRegistrations'; n: number }
  | { op: 'post'; n?: number; to: string; text: string };

interface ClientsAsk {
  op: 'clients';
  n: number;
  what: 'get' | 'matchAll' | 'claim' | 'navigate' | 'openWindow';
  id?: string;
  url?: string;
  type?: string;
  includeUncontrolled?: boolean;
}

type FetchSaid =
  | { op: 'fallback'; f: number }
  | { op: 'refused'; f: number }
  | {
      op: 'respond';
      f: number;
      head: {
        url: string;
        status: number;
        statusText: string;
        redirected: boolean;
        headers: [string, string][];
        type: string;
      };
      base64?: string;
      streaming?: boolean;
    }
  | { op: 'chunk'; f: number; base64: string }
  | { op: 'end'; f: number; error?: string };

type WorkerSaid =
  | CommonAsk
  | ClientsAsk
  | FetchSaid
  | { op: 'started'; ran: boolean; fetch: boolean; n?: number }
  | { op: 'done'; e: number; ok: boolean; n?: number }
  | { op: 'skipWaiting'; n: number }
  | { op: 'postClient'; client: string; text: string; n?: number }
  | { op: 'post'; to: string; text: string; n?: number };
