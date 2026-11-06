// A page's service workers, as a host keeps them (Service Workers 1):
// `HtmlServiceWorkers` is what outlives a document — the registrations, by
// scope, and the workers' threads — and one is handed to every document a
// process shows and to the network that loads them, so that a navigation can
// be answered by a worker with no document there to ask.
//
// **Nothing is stored by construction**, so a registration lives in memory
// (`memoryServiceWorkers`) unless a host hands in a store: `HtmlProfile`'s
// keeps them, and the scripts each worker ran, past a restart.
//
// Light on purpose. `<Html>` and `HtmlNetwork` reach this whether or not a
// document runs scripts, and a navigation asks `controls` before anything
// else, which reads a list of scopes: the threads, and all that runs them,
// are `scripts/sw-registry.ts`, in the engine's chunk, loaded the first time
// a request has a worker to go to.
import type { AbortSignalLike } from './scripts/platform.js';
import type { FetchRequest, FetchResponse } from './scripts/host.js';
import type { HtmlCacheStore } from './cache-storage.js';

/** The engine, as `./scripts/runtime.ts` exports it. */
type ScriptRuntime = typeof import('./scripts/runtime.js');

/** How a registration asks a worker's scripts to go through the HTTP cache
 *  (`ServiceWorkerUpdateViaCache`). */
export type HtmlServiceWorkerUpdateViaCache = 'imports' | 'all' | 'none';

/** One script of a worker, as it was fetched: its main script and each it
 *  imported, which it is run from again without asking the network, so a
 *  worker comes up with the network off. */
export interface HtmlServiceWorkerScript {
  url: string;
  /** Its `Content-Type`. */
  type: string;
  body: Uint8Array;
}

/** A worker, as a store keeps it. */
export interface HtmlServiceWorkerVersion {
  id: string;
  url: string;
  type: 'classic' | 'module';
  /** Whether its script listens for `fetch`: one that does not is not
   *  started to hear a request it would not answer. */
  handlesFetch: boolean;
  scripts: HtmlServiceWorkerScript[];
  /** The policy its requests' referrers are made under, as its main
   *  script's response said it (`Referrer-Policy`). Absent, none. */
  referrerPolicy?: string;
}

/** A registration, as a store keeps it. Only a worker that finished
 *  installing is kept: a page that is left in the middle of an `install` has
 *  to start it again. */
export interface HtmlServiceWorkerRecord {
  scope: string;
  origin: string;
  updateViaCache: HtmlServiceWorkerUpdateViaCache;
  /** `registration.navigationPreload`. */
  preload: { enabled: boolean; header: string };
  /** When its script was last asked about, in milliseconds. */
  lastCheck: number;
  active: HtmlServiceWorkerVersion | null;
  waiting: HtmlServiceWorkerVersion | null;
}

/**
 * Where registrations are kept. Every method answers at once, since a
 * navigation asks before it asks the network. `scopes` is what every request
 * of a controlled origin costs, so a store keeps it cheap; `load` is what
 * starting a worker costs, with its scripts.
 */
export interface HtmlServiceWorkerStore {
  /** The scopes an origin has a worker for, each with the id of its active
   *  worker: how a process finds another changed one. */
  scopes(origin: string): { scope: string; active: string | null }[];
  load(scope: string): HtmlServiceWorkerRecord | null;
  save(record: HtmlServiceWorkerRecord): void;
  delete(scope: string): void;
  /** What a worker's `caches` keep, which it reaches with no document there
   *  to ask: a navigation that starts a process is answered from here.
   *  Absent, the store of the document it last had. */
  readonly caches?: HtmlCacheStore;
}

/** Registrations in memory, for as long as the process. */
export function memoryServiceWorkers(): HtmlServiceWorkerStore {
  const held = new Map<string, HtmlServiceWorkerRecord>();
  return {
    scopes(origin) {
      const scopes: { scope: string; active: string | null }[] = [];
      for (const record of held.values()) {
        if (record.origin === origin) {
          scopes.push({
            scope: record.scope,
            active: record.active?.id ?? null,
          });
        }
      }
      return scopes;
    },
    load: (scope) => held.get(scope) ?? null,
    save(record) {
      held.set(record.scope, record);
    },
    delete(scope) {
      held.delete(scope);
    },
  };
}

/** What `HtmlServiceWorkers` is made with. */
export interface HtmlServiceWorkersOptions {
  /** Where registrations are kept. Default memory: gone with the process. */
  store?: HtmlServiceWorkerStore;
  /** How long a worker with nothing to do keeps its thread, in milliseconds.
   *  It starts again for the next thing it hears. Default 30000. */
  idleMs?: number;
}

/** A request as a worker's `fetch` event reads it. */
export interface HtmlServiceWorkerRequest extends FetchRequest {
  mode: 'navigate' | 'same-origin' | 'no-cors' | 'cors';
  destination: string;
  redirect?: 'follow' | 'error' | 'manual';
  cache?: string;
  referrer?: string;
  referrerPolicy?: string;
  integrity?: string;
  /** The client that made it, by id: a navigation's has none it could be
   *  controlled by. */
  clientId?: string;
  /** Whether a reload made it. */
  reload?: boolean;
}

/** What the network a registry stands on gives a worker: its own requests
 *  and scripts, which no worker hears. */
export interface HtmlServiceWorkerNetwork {
  fetch(
    scope: string,
    request: FetchRequest,
    signal: AbortSignalLike,
  ): Promise<FetchResponse>;
  readonly userAgent: string;
}

/** Whether a URL is under a scope (Service Workers 1, "Scope to Registration
 *  Map": a string's prefix, whatever it cuts through). */
export function inScope(url: string, scope: string): boolean {
  return url.startsWith(scope);
}

/** The scheme and host a URL is of, or null where it has no such thing. */
function originOf(url: string): string | null {
  const m = /^(https?:\/\/[^/?#]*)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

/** The registry the engine's chunk makes of one of these. */
export interface HtmlServiceWorkerRegistry {
  /** A navigation or a frame's document for the worker whose scope holds its
   *  URL: what it answered, or null where the network is to. */
  navigation(
    request: HtmlServiceWorkerRequest,
    signal: AbortSignalLike,
  ): Promise<FetchResponse | null>;
}

const REGISTRIES = new WeakMap<object, unknown>();

/**
 * What keeps a page's service workers, for all the documents a process shows:
 * made once and handed to `HtmlNetwork` and to `<Html scripts>` alike.
 *
 * ```tsx
 * const workers = new HtmlServiceWorkers({ store: profile.serviceWorkers });
 * const network = new HtmlNetwork({ serviceWorkers: workers });
 * <Html scripts={{ serviceWorkers: workers, fetch: net.fetch }} … />
 * ```
 */
export class HtmlServiceWorkers {
  readonly store: HtmlServiceWorkerStore;
  readonly idleMs: number;
  /** Set by the `HtmlNetwork` it is handed to. */
  network: HtmlServiceWorkerNetwork | null = null;
  /** URLs a hard reload asked for past any worker, by what they go by:
   *  the document that arrives there is no worker's. */
  readonly bypassing = new Set<string>();

  constructor(options: HtmlServiceWorkersOptions = {}) {
    this.store = options.store ?? memoryServiceWorkers();
    this.idleMs = options.idleMs ?? 30000;
  }

  /** Whether a registration's scope holds a URL: what a navigation asks
   *  first, and all it costs a site with no worker. */
  controls(url: string): boolean {
    const origin = originOf(url);
    if (!origin) return false;
    for (const { scope } of this.store.scopes(origin)) {
      if (inScope(url, scope)) return true;
    }
    return false;
  }

  /** Every worker's thread let go, as what shows the documents goes. What
   *  the store keeps stays. */
  dispose(): void {
    (registryKept(this) as { dispose(): void } | undefined)?.dispose();
  }

  /** A navigation, for the worker that controls its URL: what it answered,
   *  or null where the network is to. */
  async navigation(
    request: HtmlServiceWorkerRequest,
    signal: AbortSignalLike,
  ): Promise<FetchResponse | null> {
    const registry = await loadRegistry(this);
    return registry.navigation(request, signal);
  }
}

let loading: Promise<ScriptRuntime> | null = null;

/** The registry of a keeper of service workers, the engine's chunk loaded
 *  the first time one is asked for. */
async function loadRegistry(
  workers: HtmlServiceWorkers,
): Promise<HtmlServiceWorkerRegistry> {
  loading ??= import('./scripts/runtime.js');
  const runtime = await loading;
  return runtime.registryOf(workers);
}

/** What a registry is kept under, for `sw-registry.ts`. */
export function registryKept(workers: HtmlServiceWorkers): unknown {
  return REGISTRIES.get(workers);
}
export function keepRegistry(
  workers: HtmlServiceWorkers,
  registry: unknown,
): void {
  REGISTRIES.set(workers, registry);
}
