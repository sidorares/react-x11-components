// A page's scripts, run: what `page.tsx` hands `<Html>` when the browser's
// switch is on — `scripting`, and the `onScript`, `onParsed`, `onLoaded` and
// `onDomEvent` that queue the document's scripts, run them, and dispatch
// what happens to the document to the page's listeners.
//
// One engine a document (`ScriptEngine`), over one host (`DomHost`), made
// when `<Html>` hands over a document it has not seen and dropped with it.
// A script that blocks the parser — a classic one, inline or with a `src`
// that is neither `async` nor `defer` — runs where the parser met it: the
// parse waits after its end tag (`blocked`, `onParserBlocked`), so that it
// sees the document as far as it goes and nothing after, and what it
// writes with `document.write` goes into the input stream after it. An
// `async` one runs as soon as its source is here (`_soon`), and the rest —
// deferred ones and modules — once the parse has ended, in document order,
// then `DOMContentLoaded`, then `load` once `<Html>` says everything the
// document asked for is in. A document parsed whole before its scripts
// ran, a frame's, runs all of them in that pass, as if every one were
// `defer` (phase 1's order, docs/prd-html-scripts.md), `async` ones after
// one that blocks the parser among them. Each waits first for the style
// sheets a browser would have held it for (`scriptsUnblocked`): those
// before it, so that one after a head's `<link>` reads the document as the
// sheet styles it.
// A script a page puts in later runs when its source is here, as a browser
// runs one a script inserts; one `innerHTML` put in never runs, as in a
// browser. A module script runs in the same order, its imports fetched and
// linked first, and a `nomodule` script does not run. Every runtime the
// engine is made on has modules: the flag that makes Node keep a page's
// `import()` in its context is the one that makes `vm.SourceTextModule`
// (`SCRIPTS_CONTAINED`), and where it is not given, nothing runs.
import type {
  ConsoleProperty,
  ConsoleResult,
  ConsoleValue,
} from './scripted.js';
import type { Element } from 'domhandler';

import type {
  Document,
  HtmlDomEvent,
  HtmlHandle,
  ScriptRequest,
} from '../index.js';
import { blocksParser, isClassicScriptType } from '../dom.js';
import { holdAnimationClock, releaseAnimationClock } from '../node.js';
import type { CssEventInfo } from '../node.js';
import type { MediaEventKind } from '../media.js';
import type { ResourceAsker, ResourceCors } from '../resources.js';
import { ScriptEngine } from './engine.js';
import { DomHost, trustworthy, wholeBytes } from './host.js';
import { corsSetting, judgeScript } from './script-origin.js';
import type { LoadedScript, ModuleType } from './script-origin.js';
import { SB_ORIGIN, sandboxOfPolicy } from './sandbox.js';
import { referrerPolicyOf, referrerPolicyOfHeaders } from '../referrer.js';
import { PageWorkers } from './workers.js';
import { registryOf } from './sw-registry.js';
import type { ServiceClient } from './sw-registry.js';
import type { HtmlServiceWorkers } from '../service-workers.js';
import type {
  FetchRequest,
  FetchResponse,
  FramePost,
  HostSeams,
  WorkerInit,
} from './host.js';
import type { Popup, PopupAsk } from './popups.js';
import { arriveAt, forgetKept, liveSession } from './session.js';
import { openApart, slotFor, windowOps } from './popups.js';
import type { WindowSlot } from './popups.js';
import { openerPolicyOf, type DocumentHop, type OpenerPolicy } from './coop.js';
import type { HtmlSessionHistory, SessionArrival } from './session.js';
import type {
  AbortSignalLike,
  ClearTimeout,
  SetTimeout,
  UrlClass,
} from './platform.js';

declare const setTimeout: SetTimeout;
declare const clearTimeout: ClearTimeout;
declare const queueMicrotask: (fn: () => void) => void;
declare const URL: UrlClass;
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

/** A frame of the page's clock, which `scroll` is told at most once in. */
const FRAME_MS = 16;

/** How long a script's own code may run in a task — a script, a listener,
 *  a timer — before it is stopped: long enough for any page that is
 *  working, short enough that one that is not leaves the tab answering. The
 *  host's time in what it asks of the document is not counted, and the task
 *  is stopped outright at five times it (`ScriptEngine._bridge`). */
export const SCRIPT_TIMEOUT_MS = 2000;
/** How long the content has to hold still before what is under a pointer
 *  that did not move is asked, as `<Html>` holds a hover (`HOVER_REST_MS`). */
const UNDER_REST_MS = 100;

/** What the page around a document gives its scripts. */
declare const Buffer: { from(text: string, encoding: 'base64'): Uint8Array };

export interface ScriptsOptions extends Omit<
  HostSeams,
  'handle' | 'adopt' | 'serviceWorkers'
> {
  /** What keeps the page's service workers; `true` for one of its own. */
  serviceWorkers?: boolean | HtmlServiceWorkers | null;
  /** A script's source, by its URL — through the host's network — or null
   *  where there is none: a `<script src>`'s, with its element, or a
   *  module's an import names, with none, and `type` where it is imported
   *  as a JSON or a text module (`HtmlScripts.load`). */
  load(
    url: string,
    element: Element | null,
    cors?: ResourceCors,
    type?: 'json' | 'text',
    asker?: ResourceAsker,
  ): Promise<LoadedScript | null>;
  /** The headers of the response the document came in
   *  (`HtmlScripts.headers`). */
  headers?: [string, string][];
  /** The responses that redirected it here (`HtmlScripts.redirects`). */
  redirects?: DocumentHop[];
  /** A script ran past the timeout and was stopped. */
  onTimeout(): void;
  /** How long a script's own code may run in a task before it is
   *  stopped. Default `SCRIPT_TIMEOUT_MS`. */
  timeout?: number;
  /** Whether the page may start dedicated workers, each a thread of its
   *  own. Default true. */
  workers?: boolean;
  /** Whether a key the page is told of is the host's own chord, which the
   *  page cannot keep from the host. */
  reserved?(event: HtmlDomEvent): boolean;
  /** A frame's view that draws nothing of it: the holder for a frame the
   *  page lays out no box for, whose seams its document is run with only
   *  where no view draws it (`FrameSeat`). */
  undrawn?: boolean;
  /** The host's session history across the documents it shows here
   *  (`HtmlScripts`' `session`): a page's tab, or a frame's own across
   *  the documents that frame shows. */
  session?: HtmlSessionHistory | null;
}

/** The document shown in a document's place, as it hears it go
 *  (`pageswap`): where it is and, where the host keeps a session, the
 *  entry it is at and how it got there. */
export interface PageSwap {
  url?: string;
  type?: string;
  key?: string;
  id?: string;
  navState?: string | null;
}

/** What a runner is made with: the options, the handle, and where the
 *  sheets the page adopts go. */
export type RunnerSeams = Omit<ScriptsOptions, 'serviceWorkers'> &
  Pick<HostSeams, 'handle' | 'adopt' | 'serviceWorkers'>;

interface Queued {
  request: ScriptRequest;
  source: Promise<string | null>;
  module: boolean;
  /** Whether what it throws is no business of the page's
   *  (`judgeScript`), known once its source is here. */
  muted: boolean;
}

/** A script in the in-order list, and its source once it is here. */
interface InOrder {
  queued: Queued;
  code: string | null;
  ready: boolean;
}

/**
 * Where a frame's document runs, for the runner of a frame of a page's: the
 * runner of the document the frame is in, and the frame's element there.
 */
export interface FrameLink {
  parent: ScriptRunner;
  frame: Element;
}

/** What a view of a document it did not make binds to: a frame's page, or
 *  the window whose first document it draws (`Popup`). */
export interface ViewLink {
  parent: Pick<ScriptRunner, 'bindFrame' | 'releaseFrame' | 'serviceKeeper'>;
  frame: Element | null;
}

/**
 * A frame's document's runner, and the views that draw it. A frame keeps its
 * document running whether anything draws it or not — its view goes where
 * the page stops laying the frame out, a `display: none` for a while — so
 * the runner is the frame's, kept by the runner of the document the frame is
 * in, and a view only lends it what it draws with: the seams of the latest
 * view that draws the frame, else of any, else of the last, whose handle
 * answers nothing once its `<Html>` is gone, as a frame with no box has no
 * layout. It goes when the frame shows another document or leaves its own.
 */
interface FrameSeat {
  runner: ScriptRunner;
  views: RunnerSeams[];
  last: RunnerSeams;
  /** The sheets the document adopted, which a view that comes later is
   *  handed as it binds. */
  sheets: string[];
}

/** One document's scripts: its engine, its host, and where it has got to. */
/** `openApart` with what makes a runner, for a document that may have none:
 *  a top-level document's sandbox with no `allow-scripts` has no chunk of this
 *  to reach but through `loadScriptRuntime`. */
export function openWindowApart(
  ask: PopupAsk,
  url: string,
  flags: number,
  seams: RunnerSeams,
  runner: ScriptRunner | null = null,
): void {
  openApart(
    ask,
    { url, flags, seams, runner },
    (blank, address, windowSeams) =>
      new ScriptRunner(blank, address, windowSeams),
  );
}

export class ScriptRunner {
  readonly host: DomHost;
  readonly engine: ScriptEngine;
  private readonly _workers: PageWorkers | null;
  private _queue: Queued[] = [];
  private _parsed = false;
  private _loaded = false;
  private _ready: 'loading' | 'interactive' | 'complete' = 'loading';
  private _disposed = false;
  /** A `scroll` owed the page, told once a frame however often the pane
   *  moved in it, as a browser runs the scroll steps once a frame. */
  private _scrollOwed: ReturnType<typeof setTimeout> | null = null;
  /** The scroll containers in the document that scrolled since their
   *  `scroll` was last told, told once a frame as the pane's is. */
  private _scrolledElements = new Set<Element>();
  private _elementScrollOwed: ReturnType<typeof setTimeout> | null = null;
  /** The runners of the frames' documents in this one (`FrameSeat`). */
  private _seats = new Map<Document, FrameSeat>();
  /** The window this document is shown in, where it has one of a group
   *  (`./popups.ts`). */
  slot: WindowSlot | null = null;
  /** What this document asks of the windows around it (`./coop.ts`): a
   *  top-level document's, and nothing in a frame. */
  openerPolicy: OpenerPolicy = 'unsafe-none';
  private _seatsWatched: (() => void) | null = null;
  private _viewListeners = new Set<() => void>();
  private _viewsTold = false;
  /** Stops the host's traversals among the document's own entries
   *  reaching it (`liveSession`). */
  private _unlive: (() => void) | null = null;

  /**
   * A frame's document runs in a realm of its own, over the nodes the page's
   * realm shares with it (`DomShared`), and the two realms are linked: the
   * frame's window in the page is this realm's global, and this realm's
   * `parent` the page's (`ScriptEngine.link`).
   */
  constructor(
    document: Document,
    url: string,
    private readonly _options: RunnerSeams,
    private readonly _link: FrameLink | null = null,
    /** Where the document is in the host's session, where it keeps one:
     *  what its realm reads as it starts (`./session.ts`). */
    arrival: SessionArrival | null = null,
  ) {
    // the window a document of a group comes into, which is its tab's or
    // its popup's: a host's `session` is what a tab's documents share, and
    // a frame's its element (`windowKey`)
    const popup = _options.popup as Popup | null | undefined;
    const headers = _options.headers ?? [];
    const found = popup?.slot ?? slotFor(this.windowKey);
    // it may take the window out of its group, and this is where that is
    // decided, on the host: a frame's document never does (HTML, "obtain a
    // browsing context to use for a navigation response")
    const slot =
      found && !_link
        ? found.arrives(url, headers, _options.redirects ?? [], this.windowKey)
        : found;
    if (slot !== found && _options.session) forgetKept(_options.session);
    if (!_link) {
      this.openerPolicy =
        slot?.active?.value ?? openerPolicyOf(headers, trustworthy(url));
    }
    this.host = new DomHost(
      document,
      _options,
      url,
      _link?.parent.host.shared ?? slot?.group.shared,
      _link?.parent.host.top,
    );
    this.host.arrival = arrival;
    // what the session reads of the document as it is left: its entries'
    // URLs are none of the next document's where this says no path
    if (arrival) {
      arrival.referrerPolicy = () => this.host.documentReferrerPolicy();
    }
    // before its realm is made, which asks what context it is as it starts
    if (popup && slot?.auxiliary && url === 'about:blank') {
      this.host.creator = popup.creator;
      this.host.creatorOrigin = popup.creatorOrigin;
    }
    // a window's flags are every document's it shows, and a host says what a
    // document's own response said of itself
    const sandbox = (slot?.sandbox ?? 0) | sandboxOfPolicy(headers);
    if (sandbox) this.host.shared.sandboxes.set(document, sandbox);
    // and the policy its requests' referrers are made under, which a
    // document with no response of its own has from the one around it
    // (HTML 7.4.2.3, a local scheme's policy container is its creator's)
    this.host.referrerPolicy =
      /^about:(blank|srcdoc)\b/.test(url) && _link
        ? _link.parent.host.documentReferrerPolicy()
        : referrerPolicyOfHeaders(headers);
    if (_link?.frame) this.host.frameParent = _link.parent.host;
    // the host's to know, and never the facade's: it decides what a realm is
    // handed, and what is refused it
    const foreign =
      !!_link &&
      (this.host.origin === 'null'
        ? url !== 'about:blank' || !!(this.host.sandbox & SB_ORIGIN)
        : url !== 'about:blank' &&
          (originOf(url) === 'null' ||
            originOf(url) !== _link.parent.host.origin));
    this.host.foreignParent = foreign;
    this.engine = new ScriptEngine(this.host.bridge, {
      timeout: _options.timeout ?? SCRIPT_TIMEOUT_MS,
      onTimeout: _options.onTimeout,
      log: _options.log,
      settled: () => this.host.settled(),
      // what a module imports is another origin's only by its leave
      // an `import()` a classic script makes as it runs is made under its
      // element's referrer policy (HTML 8.1.5.1, its fetch options)
      load: (url, type) =>
        this._scriptFrom(url, null, true, type, this._executing).then(
          (s) => s && s.text,
        ),
      base: () => this.host.url,
      entered: holdAnimationClock,
      left: releaseAnimationClock,
      // kept frozen with too much waiting
      overflow: () => this._letGo(),
    });
    this.host.entries = this.engine;
    this.host.scriptConnected = (request) => this.add(request);
    if (arrival) {
      // told once the page's code is done, where it is running: the host
      // may ask from one of the seams the page's code reached
      this._unlive = liveSession(arrival, {
        traverse: (key) => {
          const go = () => {
            if (!this._disposed) this.engine.call('__traverseKey', [key]);
          };
          if (this.engine.running) queueMicrotask(go);
          else go();
        },
        // the next document of the session is shown, here or in another
        // `<Html>`: this one hears where it goes, and goes — or, where the
        // session keeps it to show again and it may be kept, is frozen
        swap: (swap, keep) => {
          if (keep && this.freeze(swap)) return true;
          this.dispose(swap);
          return false;
        },
        reactivate: (view) => this.reactivate(view),
        destroy: () => this.dispose(),
      });
    }
    // the page's workers, each in a thread of its own, their network the
    // page's — where the page may have them at all
    this._workers =
      _options.workers === false
        ? null
        : new PageWorkers({
            fetch: (request, signal, id) =>
              this._workerFetch(request, signal, id),
            caches: (origin, ask) =>
              Promise.resolve(this.host.askCaches(origin, ask)),
            started: (id, init) => this._workerClient(id, init),
            exited: (id) => {
              this._workerClients.get(id)?.detach();
              this._workerClients.delete(id);
            },
            get webTransport() {
              return _options.webTransport;
            },
            get webSocket() {
              return _options.webSocket;
            },
            get notifications() {
              return _options.notifications;
            },
            permissions: () => this.host.permissionStates(),
            log: (level, text) => this._options.log(level, text),
            get userAgent() {
              return _options.userAgent;
            },
            get language() {
              return _options.language;
            },
            letGo: () => this._letGo(),
            message: (id, data) =>
              this.engine.call('__workerMessage', [id, data]),
            rtc: (id, message) => this.host.rtcFromWorker(id, message),
            error: (id, message, filename, line, column) =>
              this.engine.call('__workerError', [
                id,
                message,
                filename,
                line,
                column,
              ]),
          });
    this.host.workers = this._workers;
    this._windows = windowOps(
      this,
      (blank, address, seams) => new ScriptRunner(blank, address, seams),
    );
    this.host.windows = this._windows;
    slot?.adopt(this);
    // a window goes by the name it was opened under, and a frame's by its
    // element's, whichever document it shows
    const name = _link
      ? _link.frame.attribs.name
      : !slot && _options.windowName;
    if (name) {
      this.engine.call('__windowNamed', [name]);
      this._windows.named(name);
    }
    this._attachService();
    if (_link) {
      _link.parent.engine.link(this.engine, this._frameId(), foreign);
    }
  }

  private readonly _windows: ReturnType<typeof windowOps>;

  /** What the documents of this one's window share, which its slot is found
   *  again by: a frame's element, the host's session, or what `<Html>` lent
   *  it, the same for every document one `<Html>` shows. */
  get windowKey(): object {
    return this._link?.frame ?? this._options.session ?? this._options;
  }

  /** What this document was made with. */
  get seams(): RunnerSeams {
    return this._options;
  }

  /** The document at the top of this one's frames, which is itself for a
   *  top-level document. */
  get topmost(): ScriptRunner {
    let top: ScriptRunner = this;
    while (top._link) top = top._link.parent;
    return top;
  }

  /** The frame's element, where this document is a frame's. */
  get frame(): Element | null {
    return this._link?.frame ?? null;
  }

  /** The realm this document's frame is in, and its frame's id there. */
  get parentRealm(): { runner: ScriptRunner; from: number } | null {
    return this._link
      ? { runner: this._link.parent, from: this._frameId() }
      : null;
  }

  /** The realm of a frame of this document, by its id here. */
  frameRealm(id: number): ScriptRunner | null {
    const document = this.host.frameDocumentAt(id);
    return (document && this._seats.get(document)?.runner) ?? null;
  }

  /**
   * A link or a form asks for a target no frame has: a window of the group
   * that goes by it, or a new one with this one its opener. False where it is
   * none of the group's: a tab, the host's to open.
   */
  followTarget(
    url: string,
    target: string,
    noopener: boolean,
    noreferrer: boolean,
    post: FramePost | null,
  ): boolean {
    if (this._disposed) return false;
    return this._windows.follow(url, target, noopener, noreferrer, post);
  }

  /** A document with flags to hand on and no runner of its own opens a window
   *  that keeps them (`openApart`): a frame of this one, which `flags` and
   *  `url` are of, a sandbox with no `allow-scripts`. */
  openFor(url: string, flags: number, ask: PopupAsk): void {
    openWindowApart(ask, url, flags, this._options, this);
  }

  /** A page closed the window it is in, which is the host's: one created by
   *  a script, or with nothing to go back to, may be (HTML 7.2.2.3). Answers
   *  whether it is closing. */
  closeTab(): boolean {
    if (this._link) return false;
    const alone = (this._options.session?.entries.length ?? 1) <= 1;
    return this._options.close?.(alone) === true;
  }

  /** What keeps this page's service workers, where it has any. */
  get serviceKeeper(): HtmlServiceWorkers | null {
    return this._options.serviceWorkers ?? null;
  }

  /** What a service worker tells this document, told a task later and in
   *  order: it may be told from inside one of the page's ops. */
  private _told: string[] = [];

  /**
   * This document as a service worker's client (Service Workers 1, 2.2): a
   * secure context's alone, and a local document's where its parent is one.
   */
  private _attachService(): void {
    const keeper = this.serviceKeeper;
    if (!keeper || !this.host.secure || this.host.sandbox & SB_ORIGIN) return;
    const popup = this._options.popup as Popup | null | undefined;
    // a window's `about:blank` is its opener's client, as a frame's is its
    // parent's: the document of no address that the opener made
    const parent =
      this._link?.parent.host.serviceClient ?? popup?.creatorClient ?? null;
    if (!/^https?:/i.test(this.host.url) && !parent) return;
    const options = this._options;
    this.host.serviceClient = registryOf(keeper).attach(
      {
        url: () => this.host.url,
        origin: () => this.host.origin,
        type: 'window',
        frameType: () =>
          this._link
            ? 'nested'
            : this.slot?.auxiliary
              ? 'auxiliary'
              : 'top-level',
        // a window has the focus here, and a frame where the page gave it
        focused: () =>
          this._link
            ? this._link.parent.host.focusedFrame === this._link.frame
            : !this.engine.frozen && !this._disposed,
        visibility: () => (this.engine.frozen ? 'hidden' : 'visible'),
        frozen: () => this.engine.frozen,
        tell: (text) => {
          this._told.push(text);
          if (this._told.length === 1) this._tellNext();
        },
        fetch: (request, signal) => options.fetch(request, signal),
        navigate: (url, how) => options.navigate(url, how),
        workerSeams: () => ({
          webTransport: options.webTransport,
          webSocket: options.webSocket,
          notifications: options.notifications,
          permissions: () => this.host.permissionStates(),
          log: (level, text) => options.log(level, text),
          userAgent: options.userAgent,
          language: options.language,
          keySecrets: this.host.keySecretsOf(),
        }),
        caches: (origin, ask) => this.host.askCaches(origin, ask),
      },
      parent,
    );
  }

  /** The classic script running now, whose `import()`s are its own. */
  private _executing: Element | null = null;

  /** This document's workers, as a service worker's clients. */
  private _workerClients = new Map<number, ServiceClient>();

  /** A worker of this document is a client of a service worker too: one its
   *  `clients` lists, whose requests it hears. It has no `navigator` to tell
   *  anything of it, and hears nothing. */
  private _workerClient(id: number, init: WorkerInit): void {
    const page = this.host.serviceClient;
    if (!page || init.service) return;
    const seams = page.seams;
    this._workerClients.set(
      id,
      registryOf(this.serviceKeeper!).attach(
        {
          ...seams,
          url: () => init.url,
          type: init.shared ? 'sharedworker' : 'worker',
          frameType: () => 'none',
          tell() {},
        },
        page,
      ),
    );
  }

  /** A task for each thing told, as a browser queues them: a page's
   *  reaction to one runs before the next, and sets up what hears it. */
  private _tellNext(): void {
    setTimeout(() => {
      const said = this._told[0];
      if (said !== undefined && !this._disposed) {
        this.engine.call('__sw', [said]);
      }
      this._told.shift();
      if (this._told.length) this._tellNext();
    }, 0);
  }

  /** What a worker of this document asks for: its controller's first, as the
   *  document's own requests are. */
  private async _workerFetch(
    request: FetchRequest,
    signal: AbortSignalLike,
    id: number | undefined,
  ): Promise<FetchResponse> {
    const client =
      (id === undefined ? null : this._workerClients.get(id)) ??
      this.host.serviceClient;
    if (client?.controlled && /^https?:/i.test(request.url)) {
      const answered = await client.fetch(
        {
          ...request,
          mode: 'cors',
          destination: '',
          referrer: request.referrer ?? '',
        },
        signal,
      );
      if (answered) {
        // whole, with its text: what a worker's script is read from
        const bytes = await wholeBytes(answered);
        return {
          ...answered,
          url: answered.url || request.url,
          chunks: undefined,
          bytes,
          body: new TextDecoder().decode(bytes),
        };
      }
    }
    return this._options.fetch(request, signal);
  }

  /**
   * The runner of a frame's document in this one, for a view that draws it:
   * the one the frame's document has, where a view drew it before, or one
   * made for it (`FrameSeat`). The view hands it back with `releaseFrame`.
   */
  bindFrame(
    document: Document,
    url: string,
    frame: Element,
    view: RunnerSeams,
  ): ScriptRunner | null {
    if (this._disposed) return null;
    let seat = this._seats.get(document);
    if (!seat) {
      const made: Omit<FrameSeat, 'runner'> = {
        views: [],
        last: view,
        sheets: NO_SHEETS,
      };
      const current = (): RunnerSeams => {
        for (let i = made.views.length - 1; i >= 0; i--) {
          if (!made.views[i].undrawn) return made.views[i];
        }
        return made.views.at(-1) ?? made.last;
      };
      const handle = new Proxy({} as HtmlHandle, {
        get: (_, key) => Reflect.get(current().handle, key),
      });
      const adopt = (sheets: string[]): void => {
        made.sheets = sheets;
        for (const v of made.views) v.adopt?.(sheets);
      };
      const seams = new Proxy({} as RunnerSeams, {
        get: (_, key) =>
          key === 'handle'
            ? handle
            : key === 'adopt'
              ? adopt
              : Reflect.get(current(), key),
      });
      // a frame's session across the documents it shows, where the view
      // keeps one: each document is the next of that history, as a tab's
      // documents are of the host's (`HtmlSessionHistory`)
      const session = view.session ?? null;
      const arrival = session ? arriveAt(session, url) : null;
      seat = Object.assign(made, {
        runner: new ScriptRunner(
          document,
          url,
          seams,
          { parent: this, frame },
          arrival,
        ),
      });
      this._seats.set(document, seat);
      this._seatsWatched ??= this.host.onFrames(() => this._dropFrames());
    }
    seat.views.push(view);
    seat.last = view;
    if (seat.sheets.length) view.adopt?.(seat.sheets);
    this._tellViews();
    return seat.runner;
  }

  /** A view of a frame's document is gone (`bindFrame`). */
  releaseFrame(document: Document, view: RunnerSeams): void {
    const seat = this._seats.get(document);
    if (!seat) return;
    const at = seat.views.indexOf(view);
    if (at >= 0) seat.views.splice(at, 1);
    this._dropFrames();
    this._tellViews();
  }

  /** Whether a view draws a frame's document: what the browser's holder of
   *  the frames the page lays out no box for asks. */
  frameDrawn(document: Document): boolean {
    return !!this._seats.get(document)?.views.some((v) => !v.undrawn);
  }

  /** Be told when a frame's document gains or loses a view; answers the
   *  way to stop. */
  onFrameViews(listener: () => void): () => void {
    this._viewListeners.add(listener);
    return () => this._viewListeners.delete(listener);
  }

  /** Told after the view that bound or let go is in: a view binds as its
   *  `<Html>` reads its props, where no listener's state may be set. */
  private _tellViews(): void {
    if (this._viewsTold) return;
    this._viewsTold = true;
    queueMicrotask(() => {
      this._viewsTold = false;
      if (this._disposed) return;
      for (const listener of [...this._viewListeners]) listener();
    });
  }

  /** The runners of the documents no frame in this one shows any more,
   *  each of which unloads as it goes: once this one's code is done, where
   *  it is running, so that what a frame's `unload` reaches of this one is
   *  never in the middle of one of its ops. */
  private _dropFrames(): void {
    if (!this._seats.size) return;
    const shown = new Set(this.host.frames().map((f) => f.document));
    for (const [document, seat] of this._seats) {
      if (shown.has(document)) continue;
      this._seats.delete(document);
      if (this.engine.running) queueMicrotask(() => seat.runner.dispose());
      else seat.runner.dispose();
    }
  }

  /** This document's frame's id in the realm it is in. */
  private _frameId(): number {
    return this._link!.parent.host.idOf(this._link!.frame);
  }

  /** `<Html>` met a `<script>`, or the host met one a page's script put in
   *  (`DomHost.scriptConnected`). Queued, never run here: this is called
   *  while the element reads its props, and from inside an op. */
  add(request: ScriptRequest): void {
    if (this._disposed || this.host.inert.has(request.element)) return;
    // a script runs once (HTML's "already started"): a second view of a
    // frame's document meets the scripts the first one did
    this.host.inert.add(request.element);
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
    if (!module && !isClassicScriptType(type)) return;
    // a browser with modules runs no `nomodule` script (HTML 4.12.1)
    if (!module && request.element.attribs.nomodule !== undefined) return;
    const queued: Queued = {
      request,
      source: Promise.resolve(request.text),
      module,
      muted: false,
    };
    if (request.src) {
      queued.source = request.src.startsWith('blob:')
        ? Promise.resolve(this._blobSource(request.src))
        : this._scriptFrom(request.src, request.element, module).then(
            (judged) => {
              queued.muted = judged?.muted ?? false;
              return judged && judged.text;
            },
          );
    }
    const { source } = queued;
    // one a page's script put in and set `async` false on runs in the order
    // it went in, each once all before it have (`DomHost.inOrder`), and
    // waits for no parse
    if (
      (request.src !== null || module) &&
      this.host.inOrder(request.element)
    ) {
      const step: InOrder = { queued, code: null, ready: false };
      this._inOrder.push(step);
      void source.then((code) => {
        step.code = code;
        step.ready = true;
        void this._runInOrder();
      });
      return;
    }
    if (!this._parsed && !this._soon(queued)) this._queue.push(queued);
    else void source.then((code) => this._run(queued, code));
  }

  /** The scripts that run in the order they went in (HTML 4.12.1.1, "the
   *  list of scripts that will execute in order as soon as possible"),
   *  each with its source once it is here. */
  private _inOrder: InOrder[] = [];
  private _ordering = false;

  /** Run the scripts at the head of the in-order list whose sources are
   *  here, one after another: one that came before those ahead of it
   *  waits for them. */
  private async _runInOrder(): Promise<void> {
    if (this._ordering) return;
    this._ordering = true;
    try {
      while (!this._disposed && this._inOrder[0]?.ready) {
        const { queued, code } = this._inOrder.shift()!;
        await this._run(queued, code);
      }
    } finally {
      this._ordering = false;
    }
  }

  /**
   * Whether an `async` script met before the parse has ended runs as soon
   * as its source is here, as HTML runs one (4.12.1.1, "the set of scripts
   * that will execute as soon as possible"), rather than in the pass after
   * the parse: where no script queued before it blocks the parser. In a
   * parse that yields, those have run by the time the parser meets it; in
   * a document parsed whole before its scripts ran — a frame's — they run
   * in that pass, and it runs after them, in order, as it always did.
   */
  private _soon({ request, module }: Queued): boolean {
    if (request.element.attribs.async === undefined) return false;
    if (!module && request.src === null) return false;
    return !this._queue.some((q) => blocksParser(q.request.element, true));
  }

  /**
   * The parse waits at a script it met that blocks it (`onParserBlocked`):
   * run as HTML runs a parser-blocking script — once its source is here
   * and the sheets before it are in, with what it writes going in after it
   * — and then the parse goes on (`parserResume`). What the parser made
   * since a script last ran is told to the page first, and what it makes
   * going on after it, as the DOM tells an insertion (`parserInserted`).
   * One the runner does not run — one a view met before, of a type it
   * runs none of — lets the parse go on all the same, which would
   * otherwise wait for it for good.
   */
  async blocked(element: Element): Promise<void> {
    if (this._disposed) return;
    this._parserInserted();
    const at = this._queue.findIndex((q) => q.request.element === element);
    if (at >= 0) {
      const [queued] = this._queue.splice(at, 1);
      const code = await queued.source;
      if (this._disposed) return;
      await this._unblocked(queued);
      if (this._disposed) return;
      await this._run(queued, code, true);
      if (this._disposed) return;
    }
    this._options.handle.parserResume?.(element);
    this._parserInserted();
  }

  /** What the parser put in the document since it was last asked, told to
   *  the page: its mutation observers and its custom elements. */
  private _parserInserted(): void {
    const made = this.host.parserInserted();
    if (made) this.engine.call('__mutated', made.body);
  }

  /** The parse ended: the scripts it met, in order, each once the sheets
   *  that hold it back are in, then `DOMContentLoaded`. */
  async parsed(): Promise<void> {
    if (this._parsed || this._disposed) return;
    this._parsed = true;
    this._parserInserted();
    for (const queued of this._queue) {
      const code = await queued.source;
      if (this._disposed) return;
      await this._unblocked(queued);
      if (this._disposed) return;
      await this._run(queued, code, true);
    }
    this._queue = [];
    // the frames the markup has load once the scripts the parser met have
    // run, so a script after a frame hears its `load`, as it does where the
    // frame's document comes over a network slower than the parser
    if (this._options.drawsFrames) this.host.loadFrames();
    this._advance('interactive');
    // and the CSS events the document owed meanwhile, which a page's
    // listeners hear at the next rendering update after its scripts ran
    if (this._heldCss.length) {
      const held = this._heldCss;
      this._heldCss = [];
      setTimeout(() => {
        if (!this._disposed) this.host.cssEvents(held);
      }, 0);
    }
    if (this._loaded) this._complete();
  }

  /** The CSS events the document owed before the scripts its parser met
   *  had run (`cssEvents`). */
  private _heldCss: CssEventInfo[] = [];

  /** The document's CSS animations and transitions owe these events:
   *  told now, or once the parse's scripts have run, which a browser runs
   *  before its first rendering update. */
  cssEvents(events: CssEventInfo[]): void {
    if (this._disposed) return;
    if (this._ready === 'loading') this._heldCss.push(...events);
    else this.host.cssEvents(events);
  }

  /** What a player with no picture said (`HtmlViewProps.onMediaEvent`),
   *  for the page's media element, whose clock follows it. */
  mediaEvent(
    element: Element,
    src: string,
    kind: MediaEventKind,
    value: string,
  ): void {
    if (this._disposed) return;
    this.host.mediaEvent(element, src, kind, value);
  }

  /** Everything the document asked for is in: `load`, once the scripts the
   *  parse met have all run. */
  loaded(): void {
    this._loaded = true;
    if (this._ready === 'interactive') this._complete();
  }

  /** `load`, once the frames the document is loading are in, which hold it
   *  (HTML 7.4.5, "delay the load event"): a test that waits for the
   *  page's `load` finds its iframe's document there. */
  private _complete(): void {
    if (this._ready === 'complete' || this._disposed) return;
    if (this.host.framesLoading) {
      this.host.onFramesLoaded = () => {
        this.host.onFramesLoaded = null;
        this._complete();
      };
      return;
    }
    this._advance('complete');
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

  /** The pane the document is shown in scrolled. */
  scrolled(): void {
    this._scrolledAt = Date.now();
    // a scroll again puts off the end of it
    if (this._scrollEndOwed) {
      clearTimeout(this._scrollEndOwed);
      this._scrollEndOwed = null;
    }
    if (this._disposed || this._scrollOwed) return;
    this._scrollOwed = setTimeout(() => {
      this._scrollOwed = null;
      if (this._disposed) return;
      this.host.snapEvent(null, 'changing');
      this.engine.call('__scrolled', null);
      // and `scrollend` a frame on, where no scroll came since (CSSOM View
      // 13.1, "scrollend")
      this._scrollEndOwed = setTimeout(() => {
        this._scrollEndOwed = null;
        if (this._disposed) return;
        this.host.snapEvent(null, 'change');
        this.engine.call('__scrollended', null);
      }, FRAME_MS);
    }, FRAME_MS);
  }
  private _scrollEndOwed: ReturnType<typeof setTimeout> | null = null;

  /** `<Html>` painted: what the page's windows measure may have moved, which
   *  the host looks at once the paint is over (`DomHost.renderingMoved`). */
  painted(): void {
    if (this._disposed || this._paintSeen) return;
    this._paintSeen = setTimeout(() => {
      this._paintSeen = null;
      if (this._disposed) return;
      this.host.embedsPainted();
      this.host.renderingMoved();
      this.host.askSelection();
      this._askUnder();
    }, 0);
  }
  private _paintSeen: ReturnType<typeof setTimeout> | null = null;
  /** What is under a still pointer is asked once the content has been still
   *  for `UNDER_REST_MS`: every frame of a scroll moves it, and a page whose
   *  `mouseover` does anything would be held by each. */
  private _askUnder(): void {
    if (!this.host.movesHeard || this._underSoon) return;
    const left = this._scrolledAt + UNDER_REST_MS - Date.now();
    if (left <= 0) {
      this.host.askUnder();
      return;
    }
    this._underSoon = setTimeout(() => {
      this._underSoon = null;
      if (!this._disposed) this._askUnder();
    }, left);
  }
  private _underSoon: ReturnType<typeof setTimeout> | null = null;
  private _scrolledAt = 0;
  /** Each scroll container's `scrollend`, owed a frame after its last
   *  `scroll` (`elementScrolled`). */
  private _elementScrollEnds = new Map<
    Element,
    ReturnType<typeof setTimeout>
  >();

  /** A scroll container in the document scrolled (`onElementScroll`). */
  elementScrolled(element: Element): void {
    if (this._disposed) return;
    this._scrolledAt = Date.now();
    this._scrolledElements.add(element);
    const owed = this._elementScrollEnds.get(element);
    if (owed) clearTimeout(owed);
    this._elementScrollEnds.delete(element);
    this._elementScrollOwed ??= setTimeout(() => {
      this._elementScrollOwed = null;
      const scrolled = [...this._scrolledElements];
      this._scrolledElements.clear();
      if (this._disposed) return;
      this.host.elementsScrolled(scrolled);
      for (const el of scrolled) {
        this._elementScrollEnds.set(
          el,
          setTimeout(() => {
            this._elementScrollEnds.delete(el);
            if (!this._disposed) this.host.elementsScrolledEnd([el]);
          }, FRAME_MS),
        );
      }
    }, FRAME_MS);
  }

  /**
   * Whether the document may be left, asked before the host goes to
   * another (HTML 7.4.2.4, "checking if unloading is canceled"): its
   * `beforeunload`, then its frames' in realms of their own, each of which
   * stays only where it asks to be confirmed, the page has been used, and
   * `promptToUnload` says to stay. True to leave it.
   */
  /**
   * Run what a host's console typed in the document's realm, as the page's
   * own code at its global scope (`__console`): what it came to, or threw,
   * as `console.log` writes it, so nothing of the page's crosses but the
   * string. Null where the document runs nothing any more.
   */
  evaluate(code: string): ConsoleResult | null {
    if (this._disposed) return null;
    const out = this.engine.call('__console', code);
    if (typeof out !== 'string' || !out) return null;
    if (out[0] === '!') return { text: out.slice(1), threw: true };
    const value = consoleValue(out.slice(1));
    return value
      ? { text: value.text, threw: false, value }
      : { text: out.slice(1), threw: false };
  }

  /** A level of an object the console kept (`ConsoleValue.id`): its own
   *  properties, described as its result was. Null where it is no longer
   *  kept, or the document runs nothing. */
  inspectValue(id: number): ConsoleProperty[] | null {
    if (this._disposed) return null;
    const out = this.engine.call('__consoleProps', id);
    if (typeof out !== 'string' || !out) return null;
    try {
      const props = JSON.parse(out) as { k: string; v: unknown; e: boolean }[];
      return props.map((p) => ({
        name: String(p.k),
        value: valueOf(p.v),
        enumerable: !!p.e,
      }));
    } catch {
      return null;
    }
  }

  /** Let go of every object the console kept. */
  releaseValues(): void {
    if (!this._disposed) this.engine.call('__consoleRelease', null);
  }

  beforeUnload(): boolean {
    if (this._disposed) return true;
    if (this.engine.call('__beforeUnload', null) === 'stay') return false;
    for (const seat of this._seats.values()) {
      if (!seat.runner.beforeUnload()) return false;
    }
    return true;
  }

  /**
   * Whether the document, and every frame's in a realm of its own, may go
   * into the host's back-forward cache rather than unload (HTML 7.4.2.4,
   * a document's "salvageable" state): it has loaded, and it has no
   * connection open that a peer would see held — a WebSocket or a peer
   * connection, its own or a worker's — as browsers keep such a page out of
   * theirs. A WebTransport session is no such connection: it ends as the
   * document is frozen (`_freezeAll`).
   */
  salvageable(): boolean {
    if (this._disposed || this._ready !== 'complete') return false;
    if (this.host.connected) return false;
    // a window another reaches stays where it can be reached, as Chrome
    // keeps such a page out of its cache
    if ((this.slot?.group.slots.size ?? 0) > 1) return false;
    for (const seat of this._seats.values()) {
      if (!seat.runner.salvageable()) return false;
    }
    return true;
  }

  /**
   * The document goes into the host's back-forward cache in place of
   * unloading, where it may (`salvageable`): told where it goes and hidden
   * (`pagehide`, `persisted` true), its frames' documents with it, and then
   * nothing of its runs — no task, timer or message — until it is shown
   * again (`reactivate`) or let go (`dispose`, which tells it nothing
   * more). Whether it went in.
   */
  freeze(swap: PageSwap | null = null): boolean {
    if (this._disposed || this.engine.frozen) return false;
    if (!this.salvageable()) return false;
    this.engine.call('__freeze', swap ? [swap] : null);
    this._freezeAll();
    return true;
  }

  /** This document's engine and its frames' frozen, the frames' first, and
   *  their workers with them. Its WebTransport sessions end here, after
   *  `pagehide`, where what they tell the page waits for it to be shown. */
  private _freezeAll(): void {
    for (const seat of this._seats.values()) seat.runner._freezeAll();
    this.engine.freeze();
    this.host.contextCleanup();
    this._workers?.freeze();
  }

  /** Something a frozen document cannot go on with came to it: it goes, as
   *  one the cache drops, with the page it is in, which a frame's document
   *  is kept as a part of. It is told nothing (`dispose`). */
  private _letGo(): void {
    const top = this.topmost;
    queueMicrotask(() => top.dispose());
  }

  /**
   * The document is shown again from the back-forward cache: `view` is the
   * session as it is now, which its realm takes (`sessionView`), then
   * `pageshow` with `persisted` true; and then what its timers, its network
   * and its workers asked of it while it was frozen, in order.
   */
  reactivate(view: string | null): void {
    if (this._disposed || !this.engine.frozen) return;
    for (const seat of this._seats.values()) seat.runner._thawAll();
    this._workers?.thaw();
    this.engine.thaw(() => {
      let seed: unknown = null;
      try {
        seed = view ? JSON.parse(view) : null;
      } catch {}
      this.engine.call('__reactivate', [seed]);
    });
  }

  /** A frame's engine thawed, its own frames' first. */
  private _thawAll(): void {
    for (const seat of this._seats.values()) seat.runner._thawAll();
    this._workers?.thaw();
    this.engine.thaw();
  }

  /**
   * The document is left, and its scripts stop: the frames' documents in
   * realms of their own unload first, then this one (HTML 7.4.2.4, "unload
   * a document and its descendants") — its `beforeunload` where nothing
   * asked it as its navigation started, `pagehide`, `visibilitychange` to
   * hidden and `unload` — each under the timeout every entry has, and
   * nothing they change is drawn. `swap` is the document shown in its
   * place, where there is one, which its `pageswap` is told of before it
   * unloads. One in the back-forward cache (`freeze`) has been told it is
   * hidden already, and is told nothing more: it goes as it is (HTML,
   * "destroy a document").
   */
  dispose(swap: PageSwap | null = null, quiet = false): void {
    if (this._disposed) return;
    this.slot?.left(this);
    this._unlive?.();
    if (this._elementScrollOwed) clearTimeout(this._elementScrollOwed);
    if (this._scrollEndOwed) clearTimeout(this._scrollEndOwed);
    if (this._paintSeen) clearTimeout(this._paintSeen);
    for (const owed of this._elementScrollEnds.values()) clearTimeout(owed);
    for (const seat of this._seats.values()) seat.runner.dispose();
    this._seats.clear();
    this._seatsWatched?.();
    this.host.leaving();
    if (!this.engine.frozen && !quiet) {
      this.engine.call('__unload', swap ? [swap] : null);
    }
    this._workers?.dispose();
    this._disposed = true;
    if (this._link) this._link.parent.engine.unlink(this._frameId());
    if (this._scrollOwed) clearTimeout(this._scrollOwed);
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

  /** The script a blob URL names, read from the realm that made it
   *  (`__blobText`) as the element is connected, since no network has the
   *  URL and a page may revoke it as soon as it has set it: ZoomInfo's tag
   *  fetches its next script, and runs it from a blob. Null for a URL the
   *  realm did not make, or let go. */
  /** The bytes of a blob URL this realm made, or null for one it did not,
   *  or revoked. */
  blobBytes(url: string): Uint8Array | null {
    const text = this.engine.call('__blobBytes', [url]);
    return typeof text === 'string' ? Buffer.from(text, 'base64') : null;
  }

  private _blobSource(url: string): string | null {
    const text = this.engine.call('__blobText', [url]);
    return typeof text === 'string' ? text : null;
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
      // a graph that did not all come is its element's `error`, inline or
      // not; one that ran, or whose error was reported, an external one's
      // `load`
      if (ran === 'unfetched') this.engine.call('__fire', [element, 'error']);
      else if (request.src) this.engine.call('__fire', [element, 'load']);
      return;
    }
    // an inline script's file is its document, as a browser names it in a
    // stack and an error event's `filename`
    const url = request.src ?? this.host.url;
    // where what it writes goes: after it, as the parser would have read it
    // there, for a script the parser met and that is not `async` or `defer`
    const { attribs } = request.element;
    const writes =
      parser &&
      !(
        request.src &&
        (attribs.async !== undefined || attribs.defer !== undefined)
      );
    // a script whose errors are the page's to read no more than the script
    // is may not run where a name it looks up is the page's to read either
    if (queued.muted && this.engine.namesWatched()) {
      this._options.log('error', `Failed to load the script ${request.src}.`);
      this.engine.call('__fire', [element, 'error']);
      return;
    }
    this.host.writing = writes ? request.element : null;
    const outer = this._executing;
    this._executing = request.element;
    try {
      this.engine.exec(code, url, element, queued.muted);
    } finally {
      this.host.writing = null;
      this._executing = outer;
    }
    // a loader waits for a script it put in on its `load`
    if (request.src) this.engine.call('__fire', [element, 'load']);
  }

  /** A script's source from the host, and what this document may have of
   *  it: by CORS where it is a module's, or its element says so, and as what
   *  a module was imported as. */
  private async _scriptFrom(
    url: string,
    element: Element | null,
    module: boolean,
    type: ModuleType = 'javascript',
    /** The element whose `referrerpolicy` it is asked for under, where that
     *  is not its own: the script that imports it. */
    referring: Element | null = element,
  ): Promise<{ text: string; muted: boolean } | null> {
    const origin = this.host.origin;
    const set = corsSetting(element?.attribs.crossorigin);
    const mode = module ? (set ?? 'anonymous') : set;
    const cors = mode ? { origin, mode } : undefined;
    // asked for as this document's, which a sandbox's is of no origin, and
    // a frame's is the frame's and not the page's
    const asker = {
      client: this.host.url,
      ...(this.host.sandbox & SB_ORIGIN && { opaqueOrigin: true }),
      // under its element's referrer policy, or its document's
      referrerPolicy:
        referrerPolicyOf(referring?.attribs.referrerpolicy) ||
        this.host.documentReferrerPolicy(),
    };
    const loaded = await this._options
      .load(url, element, cors, type === 'javascript' ? undefined : type, asker)
      .catch(() => null);
    return judgeScript(loaded, url, origin, mode, module, type);
  }

  private _advance(state: 'interactive' | 'complete'): void {
    if (this._disposed) return;
    this._ready = state;
    this.engine.call('__ready', [state]);
    // a frame's document loaded: the frame's `load`, in the page
    if (state === 'complete' && this._link) {
      this._link.parent.host.frameLoaded(this._link.frame);
    }
  }
}

/** An address's origin, as a realm's is held to. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

/** No sheet adopted: one array, so that a page that adopts none renders
 *  nothing again. */
export const NO_SHEETS: string[] = [];

/** A result's description, as the page's realm wrote it (`previewOf`):
 *  only a type, a line and an id are read, and nothing else of it. */
function valueOf(raw: unknown): ConsoleValue {
  const p = (raw ?? {}) as { t?: unknown; s?: unknown; id?: unknown };
  return {
    type: String(p.t ?? 'undefined'),
    text: String(p.s ?? ''),
    ...(typeof p.id === 'number' && { id: p.id }),
  };
}

function consoleValue(json: string): ConsoleValue | null {
  try {
    return valueOf(JSON.parse(json));
  } catch {
    return null;
  }
}
