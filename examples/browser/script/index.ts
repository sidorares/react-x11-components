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
// Each waits first for the style sheets a browser would have held it for
// (`scriptsUnblocked`): those before it, so that one after a head's
// `<link>` reads the document as the sheet styles it.
// A script a page puts in later runs when its source is here, as a browser
// runs one a script inserts; one `innerHTML` put in never runs, as in a
// browser. A module script runs in the same order, its imports fetched and
// linked first, and a `nomodule` script does not run. Every runtime the
// engine is made on has modules: the flag that makes Node keep a page's
// `import()` in its context is the one that makes `vm.SourceTextModule`
// (`SCRIPTS_CONTAINED`), and where it is not given, nothing runs.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Element } from 'domhandler';

import type {
  Document,
  HtmlDomEvent,
  HtmlHandle,
  ScriptRequest,
} from '../../../src/html/index.js';
import { SCRIPTS_CONTAINED, ScriptEngine } from './engine.js';
import { DomHost } from './host.js';
import type { FramePost, HostSeams } from './host.js';

/** How long a script, a listener or a timer may run before it is stopped:
 *  long enough for any page that is working, short enough that one that is
 *  not leaves the tab answering. */
export const SCRIPT_TIMEOUT_MS = 2000;

/** What the page around a document gives its scripts. */
export interface ScriptsOptions extends Omit<HostSeams, 'handle' | 'adopt'> {
  /** A script's source, by its URL — through the browser's network — or
   *  null where there is none. */
  load(url: string): Promise<string | null>;
  /** A script ran past `SCRIPT_TIMEOUT_MS` and was stopped. */
  onTimeout(): void;
  /** Whether a key the page is told of is the browser's own chord, which
   *  the page cannot keep from the browser. */
  reserved?(event: HtmlDomEvent): boolean;
}

/** What a runner is made with: the options, the handle, and where the
 *  sheets the page adopts go. */
type RunnerSeams = ScriptsOptions & Pick<HostSeams, 'handle' | 'adopt'>;

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
  module: boolean;
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

  constructor(
    document: Document,
    url: string,
    private readonly _options: RunnerSeams,
  ) {
    this.host = new DomHost(document, _options, url);
    this.engine = new ScriptEngine(this.host.bridge, {
      timeout: SCRIPT_TIMEOUT_MS,
      onTimeout: _options.onTimeout,
      log: _options.log,
      settled: () => this.host.flush(),
      load: (url) => _options.load(url).catch(() => null),
      base: () => this.host.url,
    });
    this.host.entries = this.engine;
  }

  /** `<Html>` met a `<script>`. Queued, never run here: this is called while
   *  the element reads its props. */
  add(request: ScriptRequest): void {
    if (this._disposed || this.host.inert.has(request.element)) return;
    const type = request.type.split(';')[0].trim().toLowerCase();
    // the specifiers the page's modules import by name, from here on: as
    // the parser meets it, and inline only, as HTML has it
    if (type === 'importmap') {
      if (!request.src) {
        this.engine.importMap(
          request.text,
          this._options.handle.base ?? this.host.url,
        );
      }
      return;
    }
    const module = type === 'module';
    if (!module && !CLASSIC.has(type)) return;
    // a browser with modules runs no `nomodule` script (HTML 4.12.1)
    if (!module && request.element.attribs.nomodule !== undefined) return;
    const source = request.src
      ? this._options.load(request.src).catch(() => null)
      : Promise.resolve(request.text);
    const queued = { request, source, module };
    if (!this._parsed) this._queue.push(queued);
    else void source.then((code) => this._run(queued, code));
  }

  /** The parse ended: the scripts it met, in order, each once the sheets
   *  that hold it back are in, then `DOMContentLoaded`. */
  async parsed(): Promise<void> {
    if (this._parsed || this._disposed) return;
    this._parsed = true;
    for (const queued of this._queue) {
      const code = await queued.source;
      if (this._disposed) return;
      await this._unblocked(queued);
      if (this._disposed) return;
      await this._run(queued, code, true);
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

  /**
   * Settled once the style sheets that hold back a script the parser met
   * are in (HTML, "has a style sheet that is blocking scripts"), so what it
   * reads of the document's style and layout is theirs: the sheets before
   * it, for a classic script, which a browser runs as the parser meets it;
   * all of them for a deferred one or a module, which a browser runs once
   * the parse has ended; none for an `async` one.
   */
  private _unblocked({ request, module }: Queued): Promise<void> {
    const { attribs } = request.element;
    // `async` is a module's, and a classic script's only where it has a
    // `src`, as `defer` is
    const sourced = request.src !== null;
    if ((module || sourced) && attribs.async !== undefined) {
      return Promise.resolve();
    }
    const deferred = module || (sourced && attribs.defer !== undefined);
    return this._options.handle.scriptsUnblocked(
      deferred ? null : request.element,
    );
  }

  /** A script run: `parser` where the parse met it, which is a script
   *  whose `document.write` goes in after it. */
  private async _run(
    queued: Queued,
    code: string | null,
    parser = false,
  ): Promise<void> {
    if (this._disposed) return;
    const { request } = queued;
    const element = this.host.idOf(request.element);
    if (code === null) {
      this._options.log('error', `Failed to load the script ${request.src}.`);
      this.engine.call('__fire', [element, 'error']);
      return;
    }
    if (queued.module) {
      // linked before it runs, its imports fetched; an inline one is at the
      // document's address, which `import.meta.url` and its imports read
      const ran = await this.engine.module(
        code,
        request.src ?? this.host.url,
        !!request.src,
      );
      if (this._disposed) return;
      if (request.src) {
        this.engine.call('__fire', [element, ran ? 'load' : 'error']);
      }
      return;
    }
    const url = request.src ?? `${this.host.url} (inline)`;
    // where what it writes goes: after it, as the parser would have read it
    // there, for a script the parser met and that is not `async` or `defer`
    const { attribs } = request.element;
    const writes =
      parser &&
      !(
        request.src &&
        (attribs.async !== undefined || attribs.defer !== undefined)
      );
    this.host.writing = writes ? request.element : null;
    try {
      this.engine.exec(code, url, element);
    } finally {
      this.host.writing = null;
    }
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
 * nothing, as it never does. `navigateFrame` is the page's own, not a prop:
 * what a link or a form whose target names a frame calls (`navigableFor`),
 * which `<Html>` leaves alone where it is spread with the rest.
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
  stylesheet?: string[];
  /** A frame of the page's sent somewhere by a link or a form whose target
   *  names it, where scripts run: absent where nothing loads a frame. */
  navigateFrame?: (frame: Element, url: string, post: FramePost | null) => void;
} {
  const runner = useRef<ScriptRunner | null>(null);
  // the sheets the page adopted, applied after the document's own
  const [adopted, setAdopted] = useState<string[]>(NO_SHEETS);
  const latest = useRef(options);
  latest.current = options;
  const address = useRef(url);
  address.current = url;

  // the seams the host is made with read the latest options, so a render
  // that made new callbacks reaches a document already running
  const seams = useRef<RunnerSeams>({
    handle,
    adopt: (sheets) => setAdopted(sheets.length ? sheets : NO_SHEETS),
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
    setAdopted(NO_SHEETS);
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
  const navigateFrame = useCallback(
    (frame: Element, to: string, post: FramePost | null) =>
      runner.current?.host.navigateFrame(frame, to, post),
    [],
  );

  // the document's scripts stop when the page goes
  useEffect(() => () => runner.current?.dispose(), []);

  // where a page's `import()` would reach the host, nothing of the page's
  // runs, and the page is one with scripts off (`SCRIPTS_CONTAINED`)
  const refused = enabled && !SCRIPTS_CONTAINED;
  useEffect(() => {
    if (refused) {
      latest.current.log(
        'warn',
        "This page's scripts are not run: in this process its import() would reach the browser. Node 20, or 24 or later, runs them with --experimental-vm-modules, and Bun runs them as it is.",
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
    navigateFrame,
    ...(adopted.length ? { stylesheet: adopted } : {}),
  };
}

/** No sheet adopted: one array, so that a page that adopts none renders
 *  nothing again. */
const NO_SHEETS: string[] = [];
