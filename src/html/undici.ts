// HTTP/2 for `HtmlNetwork`, over `undici`: the package Node's own `fetch`
// is built on, newer, with a dispatcher that offers `h2` as a connection
// is made (ALPN) and speaks it where the server takes it.
//
// Why not the runtime's. Node's `fetch` is undici too, and before Node 26
// speaks HTTP/1.1 unless it is handed a dispatcher with `allowH2`; the only one it can be
// handed that it will take is its own, reached through undici's global
// dispatcher symbol, which is reaching into the runtime. The package's
// `Agent` handed to the runtime's `fetch` fails as it is used (`invalid
// onRequestStart method`: the two undicis' handler APIs differ by a major),
// so the package's `Agent` goes with the package's `fetch`. Bun's `fetch`
// speaks HTTP/1.1 alone, and Bun answers `undici` with a module of its
// own, so on Bun nothing here is loaded.
//
// It is an optional peer, as `quico` is: never installed for anyone, and an
// application that wants HTTP/2 installs it. It is reached by a dynamic
// `import()` whose specifier the compiler cannot see, and its types are
// written out here, structurally, so an application without it
// type-checks. Absent, `load` answers null and the network goes on with
// the runtime's `fetch`, over HTTP/1.1, as before.

/** undici's `fetch`, the slice the network hands it. */
type UndiciFetch = (url: string, init: object) => Promise<unknown>;

interface UndiciModule {
  fetch: UndiciFetch;
  Agent: new (options: { allowH2: boolean }) => object;
}

/** A `fetch` that offers HTTP/2. */
export type Http2Fetch = (url: string, init: object) => Promise<unknown>;

/** The optional peer's name. */
export const UNDICI_MODULE = 'undici';

/**
 * Whether an undici's `fetch` over HTTP/2 ends a request whose body it
 * knows is empty: from 8.3.0 (nodejs/undici#5169), and no 7.x. Before it
 * the request is left open, and the server waits for the rest of it for
 * good, so an older undici, which the peer range warns of and does not
 * stop, is not used at all.
 */
export function fixedVersion(version: unknown): boolean {
  const m = /^(\d+)\.(\d+)\./.exec(typeof version === 'string' ? version : '');
  if (!m) return false;
  const major = Number(m[1]);
  return major > 8 || (major === 8 && Number(m[2]) >= 3);
}

/** The global `fetch` as this module found it. undici stands in for the
 *  runtime's own alone: a `fetch` put on the global after — an
 *  application's instrumentation, a test's answers — is asked as it always
 *  was, over whatever it speaks. */
const RUNTIME_FETCH = (globalThis as { fetch?: unknown }).fetch;

/** Whether the global `fetch` is still the one this module found. */
export function fetchIsRuntimes(): boolean {
  return (globalThis as { fetch?: unknown }).fetch === RUNTIME_FETCH;
}

let loading: Promise<Http2Fetch | null> | null = null;

/**
 * undici's `fetch` over one `Agent` that offers HTTP/2, where undici is
 * installed and the runtime is Node, or null. One agent for the process:
 * its connections are a pool by origin, as a browser's are, and a request
 * carries what it carries in its own headers. The specifier is a variable
 * on purpose (`src/terminal/vt/pty.ts`'s shape): a literal would put the
 * package in the type graph, where it is not installed, and ask a bundler
 * to resolve it.
 */
export function loadHttp2Fetch(): Promise<Http2Fetch | null> {
  if (!loading) {
    if ('Bun' in globalThis) loading = Promise.resolve(null);
    else {
      const specifier = UNDICI_MODULE;
      const manifest = `${UNDICI_MODULE}/package.json`;
      loading = Promise.all([
        import(/* @vite-ignore */ specifier) as Promise<UndiciModule>,
        import(/* @vite-ignore */ manifest, { with: { type: 'json' } }).then(
          (m: { default?: { version?: unknown } }) => m.default?.version,
        ),
      ])
        .then(([m, version]) => {
          if (!fixedVersion(version)) return null;
          if (typeof m?.fetch !== 'function') return null;
          if (typeof m.Agent !== 'function') return null;
          const dispatcher = new m.Agent({ allowH2: true });
          const fetch = m.fetch;
          return (url: string, init: object) =>
            fetch(url, { ...init, dispatcher });
        })
        .catch(() => null);
    }
  }
  return loading;
}
