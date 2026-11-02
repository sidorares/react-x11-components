// The Cache API as a page's scripts see it: `caches`, `CacheStorage` and
// `Cache` (Service Workers 1, 5), in a window and a worker alike, a secure
// context's alone.
//
// **This function is source text**, as `installDom` is (`dom.ts`).
//
// What a page asks goes to the host through the `cache` op and is told back
// through `__cache`, as JSON with bytes as base64: what a store holds and how
// a query reads it are the host's (`../cache-storage.ts`), which a worker
// reaches across its thread, so a page and its worker read one store. What a
// page holds — the promises, the requests, the responses, every rejection —
// is made here, of the page's own classes.
//
// An opaque response's body is no business of the realm's: a `no-cors`
// response another origin answered crosses as a number (`_held`), and what it
// holds stays with the host, which is what lets `put` keep it and a worker
// hand it to the `<img>` that asked, with no script reading a byte of it.

/** What `installDom` hands this. */
export interface CachesDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  Request: unknown;
  Response: unknown;
  fetch: unknown;
  bytesOfBase64(text: string): Uint8Array;
  base64OfBytes(bytes: Uint8Array): string;
  /** A request as it crosses (`wireOf`'s). */
  requestOf(input: unknown): unknown;
  /** The body of a response read to its end: what `put` keeps. */
  drain(response: unknown): Promise<Uint8Array>;
  /** Whether a body has been read, or is being. */
  disturbed(response: unknown): boolean;
  /** A response made of what a cache holds, whose headers nothing changes. */
  responseFrom(head: unknown, bytes: Uint8Array | null): unknown;
}

/** What `installDom` has of this. */
export interface CachesInternals {
  CacheStorage: unknown;
  Cache: unknown;
  caches: unknown;
}

export function installCaches(deps: CachesDeps): CachesInternals {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const call: Any = D.call;
  const entry: Any = D.entry;
  const input: Any = D.input;
  const DOMException: Any = D.DOMException;
  const Request: Any = D.Request;
  const Response: Any = D.Response;
  const fetch: Any = D.fetch;
  const bytesOfBase64: Any = D.bytesOfBase64;
  const base64OfBytes: Any = D.base64OfBytes;
  const requestOf: Any = D.requestOf;
  const drain: Any = D.drain;
  const disturbed: Any = D.disturbed;
  const responseFrom: Any = D.responseFrom;

  // What is taken before any page code runs.
  const P: Any = Promise;
  const rejected: Any = P.reject.bind(P);
  const resolved: Any = P.resolve.bind(P);
  const stringify: Any = JSON.stringify;
  const parse: Any = JSON.parse;
  const KEY: Any = Symbol('Cache');

  /** Asks the host, and what it answers. */
  const pending = new Map<number, { resolve: Any; reject: Any }>();
  let nextAsk = 1;
  const ask = (message: Any): Any =>
    new P((resolve: Any, reject: Any) => {
      const n = nextAsk;
      nextAsk += 1;
      pending.set(n, { resolve, reject });
      call('cache', n, stringify(message));
    });
  entry('__cache', () => {
    const [n, text] = input() as Any[];
    const waiting = pending.get(n);
    if (!waiting) return false;
    pending.delete(n);
    const answer = parse(`${text}`);
    if (answer.error) {
      waiting.reject(
        answer.error === 'TypeError'
          ? new TypeError(answer.message ?? 'Failed to fetch')
          : new DOMException(answer.message ?? answer.error, answer.error),
      );
    } else waiting.resolve(answer);
    return true;
  });

  /** A rejection for a method called with too few arguments: Web IDL throws
   *  there, which an operation that answers a promise turns into this. */
  const short = (name: string, count: number, needs: number): Any =>
    rejected(
      new TypeError(
        `Failed to execute '${name}': ${needs} argument${needs > 1 ? 's' : ''} required, but only ${count} present.`,
      ),
    );

  /** A method's `request` argument as a `Request`, a string's made as the
   *  page's `new Request()` would. */
  const toRequest = (request: Any): Any =>
    request instanceof Request ? request : new Request(request);

  /** A query's options, as far as a cache reads them. */
  const queryOf = (options: Any): Any => ({
    ignoreSearch: !!options?.ignoreSearch,
    ignoreMethod: !!options?.ignoreMethod,
    ignoreVary: !!options?.ignoreVary,
  });

  const responsesOf = (answer: Any): Any[] =>
    answer.responses.map((r: Any) =>
      responseFrom(
        r,
        typeof r.base64 === 'string' ? bytesOfBase64(r.base64) : null,
      ),
    );

  /** A request as a page reads one back from `keys()`: `Request.url` and its
   *  kin, its headers read-only, and no body. */
  const requestsOf = (answer: Any): Any[] =>
    answer.requests.map((r: Any) => D.requestFrom(r));

  const httpScheme = (url: string): boolean => /^https?:/i.test(url);

  /** What a response has to be for a cache to take it: nothing partial and
   *  nothing that varies on everything (Service Workers 1, `put`). */
  const refusal = (response: Any, method: string): string | null => {
    if (response.status === 206) {
      return `Failed to execute '${method}' on 'Cache': Partial response (status code 206) is unsupported`;
    }
    const vary = response.headers.get('vary');
    if (
      vary !== null &&
      vary
        .split(',')
        .map((name: string) => name.trim())
        .includes('*')
    ) {
      return `Failed to execute '${method}' on 'Cache': Vary header contains *`;
    }
    return null;
  };

  /** A response's part of a batch: its head, and its bytes or the number
   *  they are held by. */
  const puttable = async (request: Any, response: Any): Promise<Any> => {
    const held = response._held ?? null;
    const bytes = held === null ? await drain(response) : null;
    return {
      type: 'put',
      request: requestOf(request),
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers._map.entries()],
        type: response.type,
        url: response.url,
        redirected: response.redirected,
      },
      ...(held === null ? { base64: base64OfBytes(bytes) } : { held }),
    };
  };

  class Cache {
    _name: string;
    constructor(key?: Any, name?: Any) {
      if (key !== KEY) throw new TypeError('Illegal constructor');
      this._name = name;
    }
    match(request: Any, options?: Any): Any {
      if (!arguments.length) return short('match', 0, 1);
      return this.matchAll(request, options).then((all: Any[]) => all[0]);
    }
    matchAll(request?: Any, options?: Any): Any {
      let query: Any = null;
      try {
        if (request !== undefined) query = toRequest(request);
      } catch (e) {
        return rejected(e);
      }
      if (query && query.method !== 'GET' && !options?.ignoreMethod) {
        return resolved([]);
      }
      return ask({
        op: 'matchAll',
        name: this._name,
        request: query && requestOf(query),
        options: queryOf(options),
      }).then(responsesOf);
    }
    add(request: Any): Any {
      if (!arguments.length) return short('add', 0, 1);
      return this.addAll([request]).then(() => undefined);
    }
    /** Service Workers 1, `addAll`: each fetched as a page's request, and all
     *  of them kept or none. */
    addAll(requests: Any): Any {
      if (!arguments.length) return short('addAll', 0, 1);
      let list: Any[];
      try {
        list = [...requests].map((r: Any) => {
          const made = toRequest(r);
          if (!httpScheme(made.url) || made.method !== 'GET') {
            throw new TypeError(
              "Failed to execute 'addAll' on 'Cache': Request scheme or method is unsupported",
            );
          }
          return made;
        });
      } catch (e) {
        return rejected(e);
      }
      const name = this._name;
      return P.all(
        list.map((made: Any) =>
          // by its own signal, which what is aborted is told through
          fetch(made).then((response: Any) => {
            if (response.type === 'error') throw new TypeError('network');
            // an opaque response has no status to read, and is taken as it
            // is: a `no-cors` request an `addAll` was handed
            if (!response.ok && response.type !== 'opaque') {
              throw new TypeError(
                `Failed to execute 'addAll' on 'Cache': Request failed with status ${response.status}`,
              );
            }
            const refused = refusal(response, 'addAll');
            if (refused) throw new TypeError(refused);
            return response;
          }),
        ),
      )
        .then((responses: Any[]) =>
          P.all(responses.map((r: Any, i: number) => puttable(list[i], r))),
        )
        .then((operations: Any[]) => ask({ op: 'batch', name, operations }))
        .then(() => undefined);
    }
    put(request: Any, response: Any): Any {
      if (arguments.length < 2) return short('put', arguments.length, 2);
      let made: Any;
      try {
        made = toRequest(request);
      } catch (e) {
        return rejected(e);
      }
      if (!httpScheme(made.url)) {
        return rejected(
          new TypeError(
            `Failed to execute 'put' on 'Cache': Request scheme '${made.url.split(':')[0]}' is unsupported`,
          ),
        );
      }
      if (made.method !== 'GET') {
        return rejected(
          new TypeError(
            `Failed to execute 'put' on 'Cache': Request method '${made.method}' is unsupported`,
          ),
        );
      }
      if (!(response instanceof Response)) {
        return rejected(
          new TypeError(
            "Failed to execute 'put' on 'Cache': parameter 2 is not of type 'Response'.",
          ),
        );
      }
      const refused = refusal(response, 'put');
      if (refused) return rejected(new TypeError(refused));
      if (disturbed(response)) {
        return rejected(
          new TypeError(
            "Failed to execute 'put' on 'Cache': Response body is already used",
          ),
        );
      }
      const name = this._name;
      return puttable(made, response)
        .then((operation: Any) =>
          ask({ op: 'batch', name, operations: [operation] }),
        )
        .then(() => undefined);
    }
    delete(request: Any, options?: Any): Any {
      if (!arguments.length) return short('delete', 0, 1);
      let made: Any;
      try {
        made = toRequest(request);
      } catch (e) {
        return rejected(e);
      }
      if (made.method !== 'GET' && !options?.ignoreMethod) {
        return resolved(false);
      }
      return ask({
        op: 'batch',
        name: this._name,
        operations: [
          {
            type: 'delete',
            request: requestOf(made),
            options: queryOf(options),
          },
        ],
      }).then((answer: Any) => answer.value === true);
    }
    keys(request?: Any, options?: Any): Any {
      let query: Any = null;
      try {
        if (request !== undefined) query = toRequest(request);
      } catch (e) {
        return rejected(e);
      }
      if (query && query.method !== 'GET' && !options?.ignoreMethod) {
        return resolved([]);
      }
      return ask({
        op: 'keys',
        name: this._name,
        request: query && requestOf(query),
        options: queryOf(options),
      }).then(requestsOf);
    }
  }

  class CacheStorage {
    constructor(key?: Any) {
      if (key !== KEY) throw new TypeError('Illegal constructor');
    }
    match(request: Any, options?: Any): Any {
      if (!arguments.length) return short('match', 0, 1);
      let query: Any;
      try {
        query = toRequest(request);
      } catch (e) {
        return rejected(e);
      }
      if (query.method !== 'GET' && !options?.ignoreMethod) {
        return resolved(undefined);
      }
      return ask({
        op: 'match',
        name: options?.cacheName === undefined ? null : `${options.cacheName}`,
        request: requestOf(query),
        options: queryOf(options),
      }).then((answer: Any) => responsesOf(answer)[0]);
    }
    has(name: Any): Any {
      if (!arguments.length) return short('has', 0, 1);
      return ask({ op: 'has', name: `${name}` }).then(
        (answer: Any) => answer.value === true,
      );
    }
    open(name: Any): Any {
      if (!arguments.length) return short('open', 0, 1);
      const named = `${name}`;
      return ask({ op: 'open', name: named }).then(() => new Cache(KEY, named));
    }
    delete(name: Any): Any {
      if (!arguments.length) return short('delete', 0, 1);
      return ask({ op: 'delete', name: `${name}` }).then(
        (answer: Any) => answer.value === true,
      );
    }
    keys(): Any {
      return ask({ op: 'names' }).then((answer: Any) => answer.names);
    }
  }
  D.idlAttributes(Cache);
  D.idlAttributes(CacheStorage);

  return { CacheStorage, Cache, caches: new CacheStorage(KEY) };
}
