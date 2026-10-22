// The props that run a document's scripts, for `<Html>` — the half of the
// engine a document with scripts off still loads, so it holds nothing heavy.
//
// The engine itself — the `node:vm` context, the DOM facade, the workers —
// is `./runtime.ts`, reached through a dynamic `import()` the first time a
// document's scripts are turned on (`loadScriptRuntime`), so an application
// that never turns them on bundles none of it (`test/treeshake.test.ts`).
// That import takes a few milliseconds, and a document is parsed in the
// render that mounts it: what `<Html>` reports before the engine is here —
// the document, the scripts it met, the end of its parse, its `load` — is
// kept, and handed to the runner in that order once it is made.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Image as NtkImage } from 'react-x11/ntk';
import type { Element } from 'domhandler';

import type {
  Document,
  HtmlDomEvent,
  HtmlHandle,
  ScriptRequest,
} from '../index.js';
import type { FramePost } from './host.js';
import type { FrameLink, RunnerSeams, ScriptRunner } from './runner.js';
import type { ScriptsOptions } from './runner.js';

/** The engine, as `./runtime.ts` exports it. */
export type ScriptRuntime = typeof import('./runtime.js');

let runtime: ScriptRuntime | null = null;
let loading: Promise<ScriptRuntime> | null = null;

/** The engine, loaded once a process. */
export function loadScriptRuntime(): Promise<ScriptRuntime> {
  loading ??= import('./runtime.js').then((loaded) => (runtime = loaded));
  return loading;
}

/** The engine, where it has been loaded. */
export function loadedScriptRuntime(): ScriptRuntime | null {
  return runtime;
}

/**
 * Load the script engine ahead of the first document that runs scripts, and
 * answer whether this runtime can run them: Bun, and Node 20, or 24 and
 * later, started with `--experimental-vm-modules` — where a page's
 * `import()` is kept in its context (`SCRIPTS_CONTAINED`). Where it answers
 * false, `<Html scripts>` draws the document as a browser with JavaScript
 * off draws it. Awaiting it before the first render also spares a document
 * its first rendering with `scripting` on in a runtime that turns out to run
 * nothing.
 */
export async function preloadHtmlScripts(): Promise<boolean> {
  return (await loadScriptRuntime()).SCRIPTS_CONTAINED;
}

/** What `<Html>` reported before the engine was here (see the top). */
interface Early {
  document: Document | null;
  scripts: ScriptRequest[];
  parsed: boolean;
  loaded: boolean;
}

/** What `useScripts` hands back: `<Html>`'s props, and a few that are the
 *  page's own and not props. */
export interface ScriptProps {
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
  /** The pane the page is shown in scrolled, which the page hears as
   *  `scroll`. `<Html>`'s `onViewportScroll`. */
  scrolled?: () => void;
  /** `<Html>`'s `onElementScroll`: a scroll container's `scroll`. */
  onElementScroll?: (element: Element) => void;
  /** `<Html>`'s `canvasImage`: what a page's script drew on a canvas. */
  canvasImage?: (element: Element) => unknown | null;
  /** The document's runner, where its scripts run: what a frame in it is
   *  run as a frame of (`FrameLink`). Not a prop. */
  runner?: () => ScriptRunner | null;
  /** The engine, once it is loaded. Not a prop. */
  runtime?: ScriptRuntime | null;
}

/** No sheet adopted: one array, so that a page that adopts none renders
 *  nothing again (`runner.ts` has the same one). */
const NO_SHEETS: string[] = [];

/** Said once a process: this runtime keeps no page's `import()` in. */
let warned = false;

/**
 * The props that run a document's scripts, for `<Html>`: `scripting`, and
 * the seams. Off, nothing but `scripting: false` is handed back, and
 * `<Html>` runs nothing, as it never does. `navigateFrame` and `scrolled`
 * are the page's own, not props — what a link or a form whose target names
 * a frame calls (`navigableFor`), and what the pane calls as it scrolls.
 */
export function useScripts(
  enabled: boolean,
  handle: HtmlHandle,
  url: string,
  options: ScriptsOptions,
  link: FrameLink | null = null,
): ScriptProps {
  const runner = useRef<ScriptRunner | null>(null);
  // the sheets the page adopted, applied after the document's own
  const [adopted, setAdopted] = useState<string[]>(NO_SHEETS);
  const latest = useRef(options);
  latest.current = options;
  const address = useRef(url);
  address.current = url;
  const [engine, setEngine] = useState<ScriptRuntime | null>(runtime);
  const early = useRef<Early>({
    document: null,
    scripts: [],
    parsed: false,
    loaded: false,
  });

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
    canPlayType: (type) => latest.current.canPlayType?.(type) ?? '',
    viewport: () => latest.current.viewport(),
    scrollTo: (x, y) => latest.current.scrollTo(x, y),
    navigate: (to, how) => latest.current.navigate(to, how),
    reload: () => latest.current.reload(),
    go: (delta) => latest.current.go(delta),
    log: (level, text) => latest.current.log(level, text),
    title: (title) => latest.current.title(title),
    fetch: (request, signal) => latest.current.fetch(request, signal),
    load: (src, element) => latest.current.load(src, element),
    onTimeout: () => latest.current.onTimeout(),
    reserved: (event) => latest.current.reserved?.(event) ?? false,
    get timeout() {
      return latest.current.timeout;
    },
    get workers() {
      return latest.current.workers;
    },
    get drawsFrames() {
      return latest.current.drawsFrames;
    },
    get undrawn() {
      return latest.current.undrawn;
    },
  });
  const linked = useRef(link);
  linked.current = link;
  // the runner of a frame's document is the frame's, which this view is
  // bound to and hands back (`FrameSeat`); a page's is this view's own
  const bound = useRef<ScriptRunner | null>(null);
  // a render once there is a runner, for what is drawn from it: the frames
  const [, ran] = useReducer((n: number) => n + 1, 0);

  // a canvas's pixels as an image `<Html>` draws, one a change of them,
  // and the document told to draw it again as they change
  const pictures = useRef(
    new WeakMap<Element, { version: number; image: unknown }>(),
  );
  const canvasImage = useCallback((element: Element) => {
    const pixels = runner.current?.host.canvas(element);
    if (!pixels || !pixels.width || !pixels.height) return null;
    const kept = pictures.current.get(element);
    if (kept?.version === pixels.version) return kept.image;
    const image = new NtkImage({
      width: pixels.width,
      height: pixels.height,
      data: pixels.data,
    });
    pictures.current.set(element, { version: pixels.version, image });
    return image;
  }, []);
  const unwatch = useRef<(() => void) | null>(null);

  const release = useCallback(() => {
    unwatch.current?.();
    unwatch.current = null;
    const was = runner.current;
    runner.current = null;
    if (!was) return;
    if (bound.current) {
      bound.current.releaseFrame(was.host.document, seams.current);
    } else was.dispose();
    bound.current = null;
  }, []);

  /** The runner of a document, made with the engine that is here. */
  const start = useCallback((loaded: ScriptRuntime, document: Document) => {
    release();
    setAdopted(NO_SHEETS);
    const link = linked.current;
    if (link) {
      runner.current = link.parent.bindFrame(
        document,
        address.current,
        link.frame,
        seams.current,
      );
      bound.current = runner.current && link.parent;
    } else {
      runner.current = new loaded.ScriptRunner(
        document,
        address.current,
        seams.current,
      );
    }
    unwatch.current =
      runner.current?.host.onCanvas((canvas) =>
        seams.current.handle.canvasChanged(canvas),
      ) ?? null;
    ran();
  }, []);

  const onDocument = useCallback((document: Document) => {
    if (runner.current?.host.document === document) return;
    if (runtime?.SCRIPTS_CONTAINED) {
      start(runtime, document);
      return;
    }
    // kept until the engine is here, and a new document's parse starts
    // over what was kept of the last one's
    if (early.current.document !== document) {
      early.current = {
        document,
        scripts: [],
        parsed: false,
        loaded: false,
      };
    }
  }, []);
  const onScript = useCallback((request: ScriptRequest) => {
    if (runner.current) runner.current.add(request);
    else if (early.current.document) early.current.scripts.push(request);
  }, []);
  const onParsed = useCallback(() => {
    if (runner.current) void runner.current.parsed();
    else early.current.parsed = true;
  }, []);
  const onLoaded = useCallback(() => {
    if (runner.current) runner.current.loaded();
    else early.current.loaded = true;
  }, []);
  const onDomEvent = useCallback((event: HtmlDomEvent) => {
    const go = runner.current?.dispatch(event) ?? true;
    return go ? undefined : false;
  }, []);
  const navigateFrame = useCallback(
    (frame: Element, to: string, post: FramePost | null) =>
      runner.current?.host.navigateFrame(frame, to, post),
    [],
  );
  const scrolled = useCallback(() => runner.current?.scrolled(), []);
  const onElementScroll = useCallback(
    (element: Element) => runner.current?.elementScrolled(element),
    [],
  );
  const getRunner = useCallback(() => runner.current, []);

  // the engine, fetched the first time scripts are on; what the document
  // reported meanwhile handed to the runner in the order it came
  useEffect(() => {
    if (!enabled || engine) return undefined;
    let live = true;
    void loadScriptRuntime().then(
      (loaded) => {
        if (!live) return;
        setEngine(loaded);
        const kept = early.current;
        early.current = {
          document: null,
          scripts: [],
          parsed: false,
          loaded: false,
        };
        if (!loaded.SCRIPTS_CONTAINED || !kept.document) return;
        start(loaded, kept.document);
        for (const request of kept.scripts) runner.current?.add(request);
        if (kept.parsed) void runner.current?.parsed();
        if (kept.loaded) runner.current?.loaded();
      },
      (error: unknown) => {
        latest.current.log(
          'error',
          `The script engine did not load: ${String((error as Error)?.message ?? error)}`,
        );
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, engine]);

  // the document's scripts stop when the page goes, and a frame's view
  // hands its document's back
  useEffect(() => release, []);

  // where a page's `import()` would reach the host, nothing of the page's
  // runs, and the page is one with scripts off (`SCRIPTS_CONTAINED`)
  const refused = enabled && !!engine && !engine.SCRIPTS_CONTAINED;
  useEffect(() => {
    if (!refused || warned) return;
    warned = true;
    const message =
      "<Html scripts>: this page's scripts are not run, since this runtime would let a page's import() reach the application. Node 20, or 24 or later, runs them with --experimental-vm-modules, and Bun runs them as it is.";
    latest.current.log('warn', message);
    (globalThis as { console?: { warn(text: string): void } }).console?.warn(
      message,
    );
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
    scrolled,
    onElementScroll,
    canvasImage,
    runner: getRunner,
    runtime: engine,
    ...(adopted.length ? { stylesheet: adopted } : {}),
  };
}
