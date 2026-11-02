// What a page's `caches` keep (Service Workers 1, 5, the Cache API): the seam
// `<Html scripts>` asks (`HtmlStorage.caches`), shaped so that memory and a
// profile several processes share (`./profile.ts`) answer it alike, and the
// matching every store is read through.
//
// **Nothing is stored by construction**, so the default is memory
// (`memoryCaches()`): an origin's caches for as long as the process. A host
// that keeps a profile hands one in.
//
// A store is asked for a URL and answers what it holds under it: a head that
// says what `matches` needs, with no body. A body is read for the entries a
// query came to, so a cache of a thousand responses costs a page that
// matches one of them one response, and `keys()` costs none.
//
// Light on purpose, as `./storage.ts` is: `<Html>` reaches it whether or not
// a document runs scripts.

/** A request as a cache keeps it. */
export interface HtmlCacheRequest {
  url: string;
  method: string;
  headers: [string, string][];
  mode?: string;
  credentials?: string;
  cache?: string;
  redirect?: string;
  referrer?: string;
  referrerPolicy?: string;
  integrity?: string;
  destination?: string;
}

/** A response as a cache keeps it, but for its body. */
export interface HtmlCacheResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  /** `basic`, `cors`, `default` or `opaque`: what the page may read of it. */
  type: string;
  url: string;
  redirected: boolean;
}

/** One request and its response, as a store lists them. */
export interface HtmlCacheEntry {
  /** What the store knows the entry by. */
  id: number;
  request: HtmlCacheRequest;
  response: HtmlCacheResponse;
}

/** What a commit adds. */
export interface HtmlCacheAddition {
  request: HtmlCacheRequest;
  response: HtmlCacheResponse;
  bytes: Uint8Array;
}

/**
 * Where an origin's caches are kept. Every method answers at once: a store is
 * reached from one process, whichever thread asked. `urlKey` is what a store
 * files an entry by, so a query finds its entries by an index rather than a
 * walk of the cache.
 */
export interface HtmlCacheStore {
  /** The origin's caches, in the order they were made. */
  names(origin: string): string[];
  has(origin: string, name: string): boolean;
  create(origin: string, name: string): void;
  /** Whether there was one to remove. */
  remove(origin: string, name: string): boolean;
  /** A cache's entries, in the order they went in: all of them, or those a
   *  `urlKey` names. */
  entries(origin: string, name: string, key?: string): HtmlCacheEntry[];
  /** An entry's body, or null where it is gone. */
  body(origin: string, name: string, id: number): Uint8Array | null;
  /** Entries taken out and put in, all or none. False where what goes in
   *  would take the origin past what it may keep. */
  commit(
    origin: string,
    name: string,
    remove: readonly number[],
    add: readonly HtmlCacheAddition[],
  ): boolean;
}

/** What `match` and its kin take (`CacheQueryOptions`). */
export interface HtmlCacheQuery {
  ignoreSearch?: boolean;
  ignoreMethod?: boolean;
  ignoreVary?: boolean;
}

/** What a page's `caches` asks, as it crosses a realm's bridge and a thread:
 *  plain data, and bytes as bytes. */
export type HtmlCacheAsk =
  | { op: 'open' | 'has' | 'delete'; name: string }
  | { op: 'names' }
  | {
      op: 'match';
      /** One cache, or every one of the origin's in order. */
      name: string | null;
      request: HtmlCacheRequest;
      options: HtmlCacheQuery;
    }
  | {
      op: 'matchAll' | 'keys';
      name: string;
      /** Null for all of them. */
      request: HtmlCacheRequest | null;
      options: HtmlCacheQuery;
    }
  | { op: 'batch'; name: string; operations: HtmlCacheOperation[] };

/** One step of a page's `put`, `add`, `addAll` or `delete` (Service Workers
 *  1, "Batch Cache Operations"). */
export type HtmlCacheOperation =
  | {
      type: 'put';
      request: HtmlCacheRequest;
      response: HtmlCacheResponse;
      bytes: Uint8Array;
    }
  | { type: 'delete'; request: HtmlCacheRequest; options: HtmlCacheQuery };

/** What it comes to. */
export interface HtmlCacheAnswer {
  /** `open`, `has`, `delete` and a batch of a `delete`. */
  value?: boolean;
  names?: string[];
  requests?: HtmlCacheRequest[];
  responses?: (HtmlCacheResponse & { bytes: Uint8Array })[];
  /** The name of the `DOMException` to reject with, or `TypeError`. */
  error?: string;
}

/** What a URL is filed under: it with no query and no fragment, so a query
 *  that ignores its search finds what the query that does not would. */
export function cacheUrlKey(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}

function withoutFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

function headerIn(headers: [string, string][], name: string): string | null {
  const found: string[] = [];
  for (const [k, v] of headers) {
    if (k.toLowerCase() === name) found.push(v);
  }
  return found.length ? found.join(', ') : null;
}

/** The header names a `Vary` lists. */
export function varyNames(headers: [string, string][]): string[] {
  const value = headerIn(headers, 'vary');
  if (value === null) return [];
  return value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Service Workers 1, "Request Matches Cached Item": the same URL, its fragment
 * aside, a `GET`, and what the response says it varies on the same.
 */
export function cacheMatches(
  query: HtmlCacheRequest,
  entry: { request: HtmlCacheRequest; response: HtmlCacheResponse | null },
  options: HtmlCacheQuery = {},
): boolean {
  const { request, response } = entry;
  if (!options.ignoreMethod && request.method !== 'GET') return false;
  const asked = options.ignoreSearch
    ? cacheUrlKey(query.url)
    : withoutFragment(query.url);
  const held = options.ignoreSearch
    ? cacheUrlKey(request.url)
    : withoutFragment(request.url);
  if (asked !== held) return false;
  if (!response || options.ignoreVary) return true;
  for (const name of varyNames(response.headers)) {
    if (name === '*') return false;
    if (headerIn(query.headers, name) !== headerIn(request.headers, name)) {
      return false;
    }
  }
  return true;
}

/** Whether a store has an entry the query finds. */
function queried(
  store: HtmlCacheStore,
  origin: string,
  name: string,
  request: HtmlCacheRequest | null,
  options: HtmlCacheQuery,
): HtmlCacheEntry[] {
  if (!request) return store.entries(origin, name);
  return store
    .entries(origin, name, cacheUrlKey(request.url))
    .filter((entry) => cacheMatches(request, entry, options));
}

function withBody(
  store: HtmlCacheStore,
  origin: string,
  name: string,
  entry: HtmlCacheEntry,
): (HtmlCacheResponse & { bytes: Uint8Array }) | null {
  const bytes = store.body(origin, name, entry.id);
  return bytes ? { ...entry.response, bytes } : null;
}

/** A page's batch (Service Workers 1, "Batch Cache Operations"), all of it or
 *  none: what a `put` replaces goes with it, and two puts of one request are
 *  an `InvalidStateError`. */
function batch(
  store: HtmlCacheStore,
  origin: string,
  name: string,
  operations: HtmlCacheOperation[],
): HtmlCacheAnswer {
  const remove = new Set<number>();
  const add: HtmlCacheAddition[] = [];
  let removed = false;
  for (const operation of operations) {
    const held = queried(
      store,
      origin,
      name,
      operation.request,
      operation.type === 'delete' ? operation.options : {},
    );
    if (operation.type === 'delete') {
      for (const entry of held) {
        if (!remove.has(entry.id)) removed = true;
        remove.add(entry.id);
      }
      for (let i = add.length - 1; i >= 0; i -= 1) {
        if (cacheMatches(operation.request, add[i], operation.options)) {
          add.splice(i, 1);
          removed = true;
        }
      }
      continue;
    }
    if (add.some((item) => cacheMatches(operation.request, item, {}))) {
      return { error: 'InvalidStateError' };
    }
    for (const entry of held) remove.add(entry.id);
    add.push({
      request: operation.request,
      response: operation.response,
      bytes: operation.bytes,
    });
  }
  if (!store.has(origin, name)) return { value: false };
  if (!store.commit(origin, name, [...remove], add)) {
    return { error: 'QuotaExceededError' };
  }
  return { value: removed };
}

/** What a page's ask comes to, in a store: the one place the Cache API's
 *  semantics are, whichever realm and thread it came from. */
export function askCaches(
  store: HtmlCacheStore,
  origin: string,
  ask: HtmlCacheAsk,
): HtmlCacheAnswer {
  switch (ask.op) {
    case 'open':
      store.create(origin, ask.name);
      return { value: true };
    case 'has':
      return { value: store.has(origin, ask.name) };
    case 'delete':
      return { value: store.remove(origin, ask.name) };
    case 'names':
      return { names: store.names(origin) };
    case 'match': {
      const names =
        ask.name === null
          ? store.names(origin)
          : store.has(origin, ask.name)
            ? [ask.name]
            : [];
      for (const name of names) {
        for (const entry of queried(
          store,
          origin,
          name,
          ask.request,
          ask.options,
        )) {
          const found = withBody(store, origin, name, entry);
          if (found) return { responses: [found] };
        }
      }
      return { responses: [] };
    }
    case 'matchAll': {
      if (!store.has(origin, ask.name)) return { responses: [] };
      const responses: (HtmlCacheResponse & { bytes: Uint8Array })[] = [];
      for (const entry of queried(
        store,
        origin,
        ask.name,
        ask.request,
        ask.options,
      )) {
        const found = withBody(store, origin, ask.name, entry);
        if (found) responses.push(found);
      }
      return { responses };
    }
    case 'keys':
      if (!store.has(origin, ask.name)) return { requests: [] };
      return {
        requests: queried(
          store,
          origin,
          ask.name,
          ask.request,
          ask.options,
        ).map((entry) => entry.request),
      };
    case 'batch':
      return batch(store, origin, ask.name, ask.operations);
  }
}

/** How much a process keeps in memory for an origin: a page that caches
 *  without end is refused rather than taking the machine's memory. */
export const MEMORY_CACHE_QUOTA = 256 * 1024 * 1024;

interface HeldEntry extends HtmlCacheEntry {
  key: string;
  bytes: Uint8Array;
}

/** Caches in memory, for as long as the process, by origin. */
export function memoryCaches(quota = MEMORY_CACHE_QUOTA): HtmlCacheStore {
  const origins = new Map<string, Map<string, HeldEntry[]>>();
  let nextId = 1;
  const of = (origin: string): Map<string, HeldEntry[]> => {
    let caches = origins.get(origin);
    if (!caches) origins.set(origin, (caches = new Map()));
    return caches;
  };
  const sizeOf = (origin: string): number => {
    let size = 0;
    for (const entries of of(origin).values()) {
      for (const entry of entries) size += entry.bytes.length;
    }
    return size;
  };
  return {
    names: (origin) => [...of(origin).keys()],
    has: (origin, name) => of(origin).has(name),
    create(origin, name) {
      const caches = of(origin);
      if (!caches.has(name)) caches.set(name, []);
    },
    remove: (origin, name) => of(origin).delete(name),
    entries(origin, name, key) {
      const all = of(origin).get(name) ?? [];
      return key === undefined ? [...all] : all.filter((e) => e.key === key);
    },
    body(origin, name, id) {
      const found = of(origin)
        .get(name)
        ?.find((e) => e.id === id);
      return found ? found.bytes : null;
    },
    commit(origin, name, remove, add) {
      const all = of(origin).get(name);
      if (!all) return false;
      const going = new Set(remove);
      const kept = all.filter((e) => !going.has(e.id));
      const before = sizeOf(origin);
      let after = before;
      for (const entry of all) {
        if (going.has(entry.id)) after -= entry.bytes.length;
      }
      for (const item of add) after += item.bytes.length;
      if (after > quota && after > before) return false;
      for (const item of add) {
        kept.push({
          id: nextId,
          key: cacheUrlKey(item.request.url),
          request: item.request,
          response: item.response,
          bytes: item.bytes,
        });
        nextId += 1;
      }
      of(origin).set(name, kept);
      return true;
    },
  };
}
