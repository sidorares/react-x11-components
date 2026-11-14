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
// kept, and handed to the runner in that order once it is made — the script
// the parse waits at among them, so the parse waits for the engine too.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Image as NtkImage } from 'react-x11/ntk';
import type { Element } from 'domhandler';

import type {
  Document,
  HtmlDomEvent,
  HtmlHandle,
  ScriptRequest,
} from '../index.js';
import type { MediaEventHandler } from '../media.js';
import type { DomHost, FramePost } from './host.js';
import type {
  PageSwap,
  RunnerSeams,
  ScriptRunner,
  ViewLink,
} from './runner.js';
import type { ScriptsOptions } from './runner.js';
import type { Popup, PopupAsk } from './popups.js';
import { arriveAt } from './session.js';
import { fireDomEvent } from '../dom-events.js';
import { HtmlServiceWorkers } from '../service-workers.js';
import { readyFor } from '../encoding.js';
import { decodeText } from '../network.js';
import type { ResourceKind } from '../network.js';
import type { ResourceRequest, ResourceResult } from '../resources.js';
import type { CorsMode } from '../url.js';

declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

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
  /** The script the parse waits at (`onParserBlocked`). */
  blocked: Element | null;
  parsed: boolean;
  loaded: boolean;
  /** Whether the document owed CSS events before the engine was here. */
  css: boolean;
  /** What the document's images came to before the engine was here, which
   *  an `onload` in their markup is still to hear. */
  images: [Element, 'load' | 'error'][];
}

/** What `useScripts` hands back: `<Html>`'s props, and a few that are the
 *  page's own and not props. */
export interface ScriptProps {
  scripting: boolean;
  /** A document with flags to hand on and no runner of its own opens a window
   *  that keeps them, the engine loaded for it where nothing else has. Not a
   *  prop. */
  openApart: (ask: PopupAsk, flags: number) => void;
  onDocument?: (document: Document) => void;
  onScript?: (request: ScriptRequest) => void;
  onParsed?: () => void;
  onLoaded?: () => void;
  /** The parse waits at a script that blocks it, which the runner runs
   *  (`ScriptRunner.blocked`): an internal prop of `<Html>`'s, whose
   *  presence makes the parse yield to the page's scripts. */
  _onParserBlocked?: (script: Element) => void;
  onDomEvent?: (event: HtmlDomEvent) => boolean | void;
  /** Whether a page listens for what a pointer's moves make. */
  movesHeard?: () => boolean;
  stylesheet?: string[];
  /** A frame of the page's sent somewhere by a link or a form whose target
   *  names it, where scripts run: absent where nothing loads a frame. */
  navigateFrame?: (
    frame: Element,
    url: string,
    post: FramePost | null,
    /** The link's referrer policy, or its document's (`navigateFrame`). */
    referrerPolicy?: string,
  ) => void;
  /** The pane the page is shown in scrolled, which the page hears as
   *  `scroll`. `<Html>`'s `onViewportScroll`. */
  scrolled?: () => void;
  /** The element painted, which may have moved the sizes the page's
   *  windows answer — its own viewport's, a frame's box. `<Html>`'s
   *  `onPaint`. */
  painted?: () => void;
  /** `<Html>`'s `onElementScroll`: a scroll container's `scroll`. */
  onElementScroll?: (element: Element) => void;
  /** The document owes CSS events, which the page takes at its next
   *  rendering update. `<Html>`'s `onCssEventsOwed`. */
  cssEventsOwed?: () => void;
  /** What an `<img>` came to, which the page hears at the element.
   *  `<Html>`'s `onImage`. */
  imageSettled?: (element: Element, outcome: 'load' | 'error') => void;
  /** What a player with no picture said, which the page's media element
   *  hears (`HtmlViewProps.onMediaEvent`). */
  mediaEvent?: MediaEventHandler;
  /** `<Html>`'s `canvasImage`: what a page's script drew on a canvas. */
  canvasImage?: (element: Element) => unknown | null;
  /** Whether that picture lets nothing behind it show. */
  canvasOpaque?: (element: Element) => boolean;
  /** Whether an `<object>` or an `<embed>` shows its document as it stands,
   *  over its box (`DomHost.framed`). */
  framed?: (element: Element) => boolean;
  /** The document's runner, where its scripts run: what a frame in it is
   *  run as a frame of (`FrameLink`). Not a prop. */
  runner?: () => ScriptRunner | null;
  /** The engine, once it is loaded. Not a prop. */
  runtime?: ScriptRuntime | null;
  /** What a subresource comes to where a service worker controls the
   *  document: undefined where the network is to answer. Not a prop. */
  workerResource?: (
    url: string,
    kind: ResourceKind,
    cors: CorsMode | null,
  ) => Promise<ResourceResult | null | undefined>;
}

/**
 * What `<Html>` asks for, where a service worker may control the document: its
 * worker's answer, or, where that leaves it to the network, the host's. What a
 * page draws is the worker's to answer in a frame as in a window.
 */
export async function throughWorker(
  scripts: ScriptProps,
  request: ResourceRequest,
  host: ((request: ResourceRequest) => unknown) | undefined,
  /** The host whose policies hold the request, where the document has no
   *  realm of its own and has another's: a frame's `about:blank` or
   *  `srcdoc`, which has the policies of the document it is in. */
  policed?: DomHost | null,
): Promise<unknown> {
  // held to the document's policies before it is asked for, and by where it
  // landed after (CSP 3, 4.1.2 and 4.1.3); a script's are the runner's
  const doc = policed ?? scripts.runner?.()?.host;
  const destination = destinationOf(request);
  if (doc && destination) {
    doc.cspScan(request.element);
    const csp = {
      url: request.url,
      destination,
      nonce: request.element ? doc.nonceOf(request.element) : '',
    };
    // what a request is refused is told at the document, which the
    // violation is of, and not at the element that asked (CSP 3, 4.1.2,
    // "create a violation object for request": it has no element)
    if (!doc.csp.request(csp, null)) return null;
    // and at each hop a redirect makes, before it is asked for
    const asked = doc.csp.policies.length
      ? {
          ...request,
          nextHop: (to: string) =>
            doc.csp.request(csp, null, [to]) ? to : null,
        }
      : request;
    const result = (await answer(scripts, asked, host)) as {
      url?: string;
      redirects?: string[];
    } | null;
    if (result && typeof result === 'object') {
      const final = result.url ?? request.url;
      const through = result.redirects?.length
        ? [...result.redirects.slice(1), final]
        : final === request.url
          ? []
          : [final];
      if (through.length && !doc.csp.request(csp, null, through)) {
        return null;
      }
    }
    return result;
  }
  return answer(scripts, request, host);
}

/** The destination a resource is fetched as (Fetch 2.2.5), by its kind and
 *  its element: what a policy holds it to. A script's is none here. */
function destinationOf(request: ResourceRequest): string | null {
  switch (request.kind) {
    case 'image': {
      const tag = request.element?.name;
      return tag === 'object' || tag === 'embed' ? tag : 'image';
    }
    case 'stylesheet':
      return 'style';
    case 'font':
      return 'font';
    case 'video':
    case 'audio':
      return request.kind;
    default:
      return null;
  }
}

async function answer(
  scripts: ScriptProps,
  request: ResourceRequest,
  host: ((request: ResourceRequest) => unknown) | undefined,
): Promise<unknown> {
  const { kind } = request;
  if (kind === 'image' || kind === 'stylesheet' || kind === 'font') {
    // the mode an image asks in is the store's, and a sheet's its element's
    const raw = request.element?.attribs?.crossorigin;
    const answered = await scripts.workerResource?.(
      request.url,
      kind,
      request.cors?.mode ??
        (raw === undefined
          ? null
          : raw.toLowerCase() === 'use-credentials'
            ? 'use-credentials'
            : 'anonymous'),
    );
    if (answered !== undefined) return answered;
  }
  return host?.(request) ?? null;
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
  link: ViewLink | null = null,
): ScriptProps {
  const runner = useRef<ScriptRunner | null>(null);
  // the sheets the page adopted, applied after the document's own
  const [adopted, setAdopted] = useState<string[]>(NO_SHEETS);
  const latest = useRef(options);
  latest.current = options;
  // what keeps the page's service workers: the host's, or, where it only said
  // yes, one of this `<Html>`'s own, which a frame's shares
  const ownWorkers = useRef<HtmlServiceWorkers | null>(null);
  const keeper = useCallback((): HtmlServiceWorkers | null => {
    const given = latest.current.serviceWorkers;
    if (!given) return null;
    if (given !== true) return given;
    const popup = latest.current.popup as Popup | null | undefined;
    return (ownWorkers.current ??=
      link?.parent.serviceKeeper ??
      popup?.serviceKeeper ??
      new HtmlServiceWorkers());
  }, []);
  /** Those waiting for the document to have a client: a request a controlled
   *  document makes before its realm is up. */
  const waitingForRunner = useRef<(() => void)[]>([]);
  const address = useRef(url);
  address.current = url;
  const [engine, setEngine] = useState<ScriptRuntime | null>(runtime);
  const early = useRef<Early>({
    document: null,
    scripts: [],
    blocked: null,
    parsed: false,
    loaded: false,
    css: false,
    images: [],
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
    get syncNetwork() {
      return latest.current.syncNetwork;
    },
    get charset() {
      return latest.current.charset;
    },
    canPlayType: (type) => latest.current.canPlayType?.(type) ?? '',
    viewport: () => latest.current.viewport(),
    scrollTo: (x, y) => latest.current.scrollTo(x, y),
    navigate: (to, how, post, name, source) =>
      latest.current.navigate(to, how, post, name, source),
    reload: () => latest.current.reload(),
    go: (delta) => latest.current.go(delta),
    promptToUnload: () => latest.current.promptToUnload?.() ?? true,
    log: (level, text) => latest.current.log(level, text),
    title: (title) => latest.current.title(title),
    fetch: (request, signal) => latest.current.fetch(request, signal),
    get network() {
      return latest.current.network;
    },
    load: async (src, element, cors, type, asker) => {
      // by CORS where it is asked by CORS: a module, or a script whose
      // element says so
      const answered = await workerResource(src, 'script', cors?.mode ?? null);
      if (answered === undefined) {
        return latest.current.load(src, element, cors, type, asker);
      }
      if (answered?.kind !== 'script') return null;
      if ('text' in answered) {
        return {
          text: answered.text,
          url: answered.url,
          headers: answered.headers,
        };
      }
      // a JSON or a text module is UTF-8, whatever the response names
      if (!type) await readyFor(answered.charset);
      return {
        text: type
          ? new TextDecoder().decode(answered.bytes)
          : decodeText(answered.bytes, answered.charset ?? null),
        url: answered.url,
        headers: answered.headers,
      };
    },
    onTimeout: () => latest.current.onTimeout(),
    reserved: (event) => latest.current.reserved?.(event) ?? false,
    get timeout() {
      return latest.current.timeout;
    },
    get headers() {
      return latest.current.headers;
    },
    get redirects() {
      return latest.current.redirects;
    },
    get workers() {
      return latest.current.workers;
    },
    get serviceWorkers() {
      return keeper();
    },
    get popups() {
      return latest.current.popups;
    },
    get popup() {
      return latest.current.popup;
    },
    close: (alone) => latest.current.close?.(alone),
    get windowName() {
      return latest.current.windowName;
    },
    get session() {
      return latest.current.session;
    },
    get webTransport() {
      return latest.current.webTransport;
    },
    get webSocket() {
      return latest.current.webSocket;
    },
    get clipboard() {
      return latest.current.clipboard;
    },
    get notifications() {
      return latest.current.notifications;
    },
    get permissions() {
      return latest.current.permissions;
    },
    get webRTC() {
      return latest.current.webRTC;
    },
    get mediaDevices() {
      return latest.current.mediaDevices;
    },
    get webgl() {
      return latest.current.webgl;
    },
    get cookies() {
      return latest.current.cookies;
    },
    get storage() {
      return latest.current.storage;
    },
    get drawsFrames() {
      return latest.current.drawsFrames;
    },
    get framesFollowed() {
      return latest.current.framesFollowed;
    },
    get undrawn() {
      return latest.current.undrawn;
    },
  });
  const linked = useRef(link);
  linked.current = link;
  // the runner of a frame's document is the frame's, which this view is
  // bound to and hands back (`FrameSeat`); a page's is this view's own
  const bound = useRef<ViewLink['parent'] | null>(null);
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
  const canvasOpaque = useCallback(
    (element: Element) => runner.current?.host.canvasOpaque(element) ?? false,
    [],
  );
  const framed = useCallback(
    (element: Element) => runner.current?.host.framed(element) ?? false,
    [],
  );
  const unwatch = useRef<(() => void) | null>(null);

  /** The document's runner goes: with `swap`, the document shown in its
   *  place, which it hears of as it goes (`pageswap`). */
  const release = useCallback((swap: PageSwap | null = null) => {
    unwatch.current?.();
    unwatch.current = null;
    const was = runner.current;
    runner.current = null;
    if (!was) return;
    if (bound.current) {
      bound.current.releaseFrame(was.host.document, seams.current);
    } else was.dispose(swap);
    bound.current = null;
  }, []);

  /** The runner of a document, made with the engine that is here. */
  const start = useCallback((loaded: ScriptRuntime, document: Document) => {
    const link = linked.current;
    // the next of the host's session, where it keeps one across the
    // documents it shows here — a page's tab — which tells the document
    // shown before it where it goes as it goes, in this `<Html>` or one
    // the host mounted in its place (`arriveAt`); a frame's session is
    // taken in `bindFrame` instead, so the seat is made with the arrival;
    // one shown with no session hears only where
    const session = link ? null : (latest.current.session ?? null);
    const arrival = session ? arriveAt(session, address.current) : null;
    release({});
    setAdopted(NO_SHEETS);
    if (link) {
      runner.current = link.parent.bindFrame(
        document,
        address.current,
        link.frame!,
        seams.current,
      );
      bound.current = runner.current && link.parent;
    } else {
      runner.current = new loaded.ScriptRunner(
        document,
        address.current,
        seams.current,
        null,
        arrival,
      );
    }
    unwatch.current =
      runner.current?.host.onCanvas((canvas) =>
        seams.current.handle.canvasChanged(canvas),
      ) ?? null;
    ran();
    for (const go of waitingForRunner.current.splice(0)) go();
  }, []);

  /** What a subresource comes to where a service worker controls the
   *  document: undefined where the network is to answer. */
  const workerResource = useCallback(
    async (
      url: string,
      kind: ResourceKind,
      cors: CorsMode | null,
    ): Promise<ResourceResult | null | undefined> => {
      const workers = keeper();
      if (!workers || !/^https?:/i.test(url)) return undefined;
      if (!runner.current) {
        if (!workers.controls(address.current)) return undefined;
        await new Promise<void>((go) => waitingForRunner.current.push(go));
      }
      const client = runner.current?.host.serviceClient;
      if (!client?.controlled) return undefined;
      return client.resource(url, kind, cors);
    },
    [],
  );

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
        blocked: null,
        parsed: false,
        loaded: false,
        css: false,
        images: [],
      };
    }
  }, []);
  const onScript = useCallback((request: ScriptRequest) => {
    if (runner.current) runner.current.add(request);
    else if (early.current.document) early.current.scripts.push(request);
  }, []);
  const onParserBlocked = useCallback((script: Element) => {
    if (runner.current) void runner.current.blocked(script);
    else if (early.current.document) early.current.blocked = script;
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
  const movesHeard = useCallback(
    () => runner.current?.host.movesHeard ?? false,
    [],
  );
  const navigateFrame = useCallback(
    (
      frame: Element,
      to: string,
      post: FramePost | null,
      referrerPolicy?: string,
    ) =>
      runner.current?.host.navigateFrameFrom(frame, to, post, referrerPolicy),
    [],
  );
  const scrolled = useCallback(() => runner.current?.scrolled(), []);
  const painted = useCallback(() => runner.current?.painted(), []);
  const onElementScroll = useCallback(
    (element: Element) => runner.current?.elementScrolled(element),
    [],
  );
  const cssEventsOwed = useCallback(() => {
    if (runner.current) runner.current.cssEventsOwed(null);
    else if (early.current.document) early.current.css = true;
  }, []);
  const imageSettled = useCallback(
    (element: Element, outcome: 'load' | 'error') => {
      if (runner.current) void fireDomEvent(onDomEvent, outcome, element);
      else if (early.current.document) {
        early.current.images.push([element, outcome]);
      }
    },
    [],
  );
  // what a sound's player says before the engine is here is nothing the
  // page could hear: it has played nothing yet
  const mediaEvent = useCallback<MediaEventHandler>(
    (element, src, kind, value) =>
      runner.current?.mediaEvent(element, src, kind, value),
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
          blocked: null,
          parsed: false,
          loaded: false,
          css: false,
          images: [],
        };
        if (!loaded.SCRIPTS_CONTAINED || !kept.document) return;
        start(loaded, kept.document);
        for (const request of kept.scripts) runner.current?.add(request);
        if (kept.css) runner.current?.cssEventsOwed(null);
        for (const [element, outcome] of kept.images) {
          imageSettled(element, outcome);
        }
        if (kept.blocked) void runner.current?.blocked(kept.blocked);
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
  useEffect(() => () => release(), []);

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

  const openApart = useCallback((ask: PopupAsk, flags: number) => {
    void loadScriptRuntime().then((loaded) =>
      loaded.openWindowApart(ask, address.current, flags, seams.current),
    );
  }, []);

  if (!enabled || refused) return { scripting: false, openApart };
  return {
    scripting: true,
    openApart,
    onDocument,
    onScript,
    onParsed,
    onLoaded,
    _onParserBlocked: onParserBlocked,
    onDomEvent,
    movesHeard,
    navigateFrame,
    scrolled,
    painted,
    onElementScroll,
    cssEventsOwed,
    imageSettled,
    mediaEvent,
    canvasImage,
    canvasOpaque,
    framed,
    runner: getRunner,
    runtime: engine,
    workerResource,
    ...(adopted.length ? { stylesheet: adopted } : {}),
  };
}
