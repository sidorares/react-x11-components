// A page's scripts, run: what `page.tsx` hands `<Html>` when the browser's
// switch is on — `scripting`, and the `onScript`, `onParsed`, `onLoaded` and
// `onDomEvent` that queue the document's scripts, run them, and dispatch
// what happens to the document to the page's listeners.
//
// One engine a document (`ScriptEngine`), over one host (`DomHost`), made
// when `<Html>` hands over a document it has not seen and dropped with it.
// The order is phase 1's (docs/prd-html-scripts.md): every classic script
// the parser met runs once the parse has ended, in document order, as if it
// were `defer` — `async` ones in the same pass — then `DOMContentLoaded`,
// then `load` once `<Html>` says everything the document asked for is in.
// A script a page puts in later runs when its source is here, as a browser
// runs one a script inserts; one `innerHTML` put in never runs, as in a
// browser. A module is not run, and says so.
import { useCallback, useEffect, useRef } from 'react';

import type {
  Document,
  HtmlDomEvent,
  HtmlHandle,
  ScriptRequest,
} from '../../../src/html/index.js';
import { SCRIPTS_CONTAINED, ScriptEngine } from './engine.js';
import { DomHost } from './host.js';
import type { HostSeams } from './host.js';

/** How long a script, a listener or a timer may run before it is stopped:
 *  long enough for any page that is working, short enough that one that is
 *  not leaves the tab answering. */
export const SCRIPT_TIMEOUT_MS = 2000;

/** What the page around a document gives its scripts. */
export interface ScriptsOptions extends Omit<HostSeams, 'handle'> {
  /** A script's source, by its URL — through the browser's network — or
   *  null where there is none. */
  load(url: string): Promise<string | null>;
  /** A script ran past `SCRIPT_TIMEOUT_MS` and was stopped. */
  onTimeout(): void;
  /** Whether a key the page is told of is the browser's own chord, which
   *  the page cannot keep from the browser. */
  reserved?(event: HtmlDomEvent): boolean;
}

/** The MIME types a classic script is (HTML 4.12.1.1, "JavaScript MIME
 *  type essence match"), and no type at all. */
const CLASSIC = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

interface Queued {
  request: ScriptRequest;
  source: Promise<string | null>;
}

/** One document's scripts: its engine, its host, and where it has got to. */
export class ScriptRunner {
  readonly host: DomHost;
  readonly engine: ScriptEngine;
  private _queue: Queued[] = [];
  private _parsed = false;
  private _loaded = false;
  private _ready: 'loading' | 'interactive' | 'complete' = 'loading';
  private _disposed = false;
  private _toldModules = false;

  constructor(
    document: Document,
    url: string,
    private readonly _options: ScriptsOptions & { handle: HtmlHandle },
  ) {
    this.host = new DomHost(document, _options, url);
    this.engine = new ScriptEngine(this.host.bridge, {
      timeout: SCRIPT_TIMEOUT_MS,
      onTimeout: _options.onTimeout,
      log: _options.log,
      settled: () => this.host.flush(),
    });
    this.host.entries = this.engine;
  }

  /** `<Html>` met a `<script>`. Queued, never run here: this is called while
   *  the element reads its props. */
  add(request: ScriptRequest): void {
    if (this._disposed || this.host.inert.has(request.element)) return;
    const type = request.type.split(';')[0].trim();
    if (!CLASSIC.has(type)) {
      if (type === 'module' && !this._toldModules) {
        this._toldModules = true;
        this._options.log(
          'warn',
          'Module scripts are not run by this browser; a page that offers a nomodule fallback gets that.',
        );
      }
      return;
    }
    const source = request.src
      ? this._options.load(request.src).catch(() => null)
      : Promise.resolve(request.text);
    const queued = { request, source };
    if (!this._parsed) this._queue.push(queued);
    else void source.then((code) => this._run(queued, code));
  }

  /** The parse ended: the scripts it met, in order, then `DOMContentLoaded`. */
  async parsed(): Promise<void> {
    if (this._parsed || this._disposed) return;
    this._parsed = true;
    for (const queued of this._queue) {
      const code = await queued.source;
      if (this._disposed) return;
      this._run(queued, code);
    }
    this._queue = [];
    this._advance('interactive');
    if (this._loaded) this._advance('complete');
  }

  /** Everything the document asked for is in: `load`, once the scripts the
   *  parse met have all run. */
  loaded(): void {
    this._loaded = true;
    if (this._ready === 'interactive') this._advance('complete');
  }

  /** What `<Html>` told of, dispatched in the page: whether its default
   *  goes on. */
  dispatch(event: HtmlDomEvent): boolean {
    if (this._disposed) return true;
    const go = this.host.dispatch(event);
    // the browser's own chords are the browser's, whatever the page says
    if (!go && this._options.reserved?.(event)) return true;
    return go;
  }

  dispose(): void {
    this._disposed = true;
    this.host.dispose();
    this.engine.dispose();
  }

  private _run(queued: Queued, code: string | null): void {
    if (this._disposed) return;
    const { request } = queued;
    const element = this.host.idOf(request.element);
    if (code === null) {
      this._options.log('error', `Failed to load the script ${request.src}.`);
      this.engine.call('__fire', [element, 'error']);
      return;
    }
    const url = request.src ?? `${this.host.url} (inline)`;
    this.engine.exec(code, url, element);
    // a loader waits for a script it put in on its `load`
    if (request.src) this.engine.call('__fire', [element, 'load']);
  }

  private _advance(state: 'interactive' | 'complete'): void {
    if (this._disposed) return;
    this._ready = state;
    this.engine.call('__ready', [state]);
  }
}

/**
 * The props that run a document's scripts, for `<Html>`: `scripting`, and
 * the seams. Off, nothing but `onDocument` is handed back, and `<Html>` runs
 * nothing, as it never does.
 */
export function useScripts(
  enabled: boolean,
  handle: HtmlHandle,
  url: string,
  options: ScriptsOptions,
): {
  scripting: boolean;
  onDocument?: (document: Document) => void;
  onScript?: (request: ScriptRequest) => void;
  onParsed?: () => void;
  onLoaded?: () => void;
  onDomEvent?: (event: HtmlDomEvent) => boolean | void;
} {
  const runner = useRef<ScriptRunner | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const address = useRef(url);
  address.current = url;

  // the seams the host is made with read the latest options, so a render
  // that made new callbacks reaches a document already running
  const seams = useRef<ScriptsOptions & { handle: HtmlHandle }>({
    handle,
    get userAgent() {
      return latest.current.userAgent;
    },
    get language() {
      return latest.current.language;
    },
    viewport: () => latest.current.viewport(),
    scrollTo: (x, y) => latest.current.scrollTo(x, y),
    navigate: (to, how) => latest.current.navigate(to, how),
    reload: () => latest.current.reload(),
    go: (delta) => latest.current.go(delta),
    log: (level, text) => latest.current.log(level, text),
    title: (title) => latest.current.title(title),
    fetch: (request, signal) => latest.current.fetch(request, signal),
    load: (src) => latest.current.load(src),
    onTimeout: () => latest.current.onTimeout(),
    reserved: (event) => latest.current.reserved?.(event) ?? false,
  });

  const onDocument = useCallback((document: Document) => {
    if (runner.current?.host.document === document) return;
    runner.current?.dispose();
    runner.current = new ScriptRunner(document, address.current, seams.current);
  }, []);
  const onScript = useCallback(
    (request: ScriptRequest) => runner.current?.add(request),
    [],
  );
  const onParsed = useCallback(() => void runner.current?.parsed(), []);
  const onLoaded = useCallback(() => runner.current?.loaded(), []);
  const onDomEvent = useCallback((event: HtmlDomEvent) => {
    const go = runner.current?.dispatch(event) ?? true;
    return go ? undefined : false;
  }, []);

  // the document's scripts stop when the page goes
  useEffect(() => () => runner.current?.dispose(), []);

  // where a page's `import()` would reach the host, nothing of the page's
  // runs, and the page is one with scripts off (`SCRIPTS_CONTAINED`)
  const refused = enabled && !SCRIPTS_CONTAINED;
  useEffect(() => {
    if (refused) {
      latest.current.log(
        'warn',
        "This page's scripts are not run: in this process its import() would reach the browser. Node runs them with --experimental-vm-modules.",
      );
    }
  }, [refused]);

  if (!enabled || refused) return { scripting: false };
  return {
    scripting: true,
    onDocument,
    onScript,
    onParsed,
    onLoaded,
    onDomEvent,
  };
}
