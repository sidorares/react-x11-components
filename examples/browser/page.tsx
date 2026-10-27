// One tab's page: its documents, loaded and drawn. The browser runs one of
// these in a process of its own for each tab, through core's `<Frame>`
// (browser.tsx), so a page that throws, wedges its event loop or grows
// without bound costs its own tab and nothing else — the tab shows what
// happened and offers to reload, and the strip, the toolbar and every other
// tab carry on. On a backend with no way to show a pane the same component
// runs in the browser's own process instead.
//
// Everything a page needs lives here and nothing the tab strip does: the
// document and its resources come through this process's own network layer,
// `<Html>` draws them, and the status bubble — a hovered link, a notice, a
// count of resources still in flight — is drawn here, because it sits over
// the page and a host can draw nothing over a pane.
//
// A page's scripts run here too where the browser's switch says so for its
// site (`scripts`): `<Html scripts>` is the engine, one `node:vm` context a
// document over `<Html>`'s DOM, and this hands it the browser's seams — its
// network, its history, its title and its chords. The process is what
// bounds it: a page that runs away is stopped by a timeout and says so in
// the bubble, and one that grows without bound costs this tab.
//
// The tab's history is here too: one `HtmlSessionHistory` a tab, handed to
// every document the tab shows, so a page's `pushState` and its own Back are
// entries of the same history the toolbar's Back and Forward step through.
// A document whose scripts run takes its place in it as they start, and
// writes its own entries; one shown with JavaScript off is shown to it here
// (`show`), and its fragments are kept here (`fragment`). Which document
// is shown follows from it: a step to another document's entry shows the
// document again as it was left where the session kept it (its
// back-forward cache), else the document's source the tab still has, or
// asks the browser to load it again. Each document is an `<Html>` of its
// own, and those the session keeps stay mounted, hidden, their requests
// held until they are shown again.
//
// Its cookies and its storage are the profile's (`profile.ts`): this
// process opens the database every tab's shares, sends and stores its
// requests' cookies through a jar over it, and hands a page's scripts the
// same jar for `document.cookie` and the database for `localStorage`,
// IndexedDB and — kept by the tab's key — `sessionStorage`.
//
// What crosses the boundary is small on purpose. In: what to load and how
// it comes into the history, a step to take in it, the zoom, whether
// scripts run — numbers, strings and a flag, so a browser re-render that
// changed none of them sends nothing. Out, through callbacks that arrive as
// one-way messages: the history as it stands, which the browser draws its
// toolbar from, a document's title and icon, a link followed or a form
// submitted — which is a link with, for a POST, a body — and a document to
// load again. The documents are this process's, kept by the id the browser
// gave the navigation that loaded each one.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import * as DomUtils from 'domutils';
import {
  ContextMenu,
  isFramed,
  matchesShortcut,
  useAccelerator,
  useClipboard,
  useSupports,
} from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent as X11KeyboardEvent,
  MenuItem,
  MouseEvent as X11MouseEvent,
  ScrollableNode,
  WheelEvent as X11WheelEvent,
} from 'react-x11';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_SPACE,
  XK_UP,
} from 'react-x11/keysyms';

import {
  CookieJar,
  Html,
  HtmlNetwork,
  HtmlSessionHistory,
  NetworkError,
  canPlayMedia,
  decodeText as decode,
  linkTarget,
  navigableFor,
  preloadHtmlScripts,
  publicSuffixList,
  resourceResult,
  schemeOf,
  sniffCharset,
  threadTransport,
  useHtmlHandle,
  videoSource,
} from '../../src/html/index.js';
import type {
  Document,
  DocumentResponse,
  Element,
  FormSubmission,
  HtmlScripts,
  HtmlSessionEntry,
  PostData,
  ResourceKind,
  ResourceRequest,
  ResourceResult,
  ViewportOverflow,
} from '../../src/html/index.js';
import { decodeIcon, iconCandidates } from './favicon.js';
import { openProfile } from './profile.js';
import { shortcuts } from './keys.js';
import type { Command } from './keys.js';
import type { TabIcon } from './favicon.js';
import {
  BLANK,
  HOME,
  blankPage,
  errorPage,
  fileName,
  homePage,
  imagePage,
  textPage,
  unsupportedPage,
} from './pages.js';

/** The keys a scroll pane moves its offset down or up with (core's
 *  `Scrollable.defaultKeyDown`). */
const VERTICAL_SCROLL_KEYS = new Set<number>([
  XK_UP,
  XK_DOWN,
  XK_PAGE_UP,
  XK_PAGE_DOWN,
  XK_HOME,
  XK_END,
  XK_SPACE,
]);

/** The schemes a link may take this browser to. */
const OPENS = /^(?:https?|file|data|about|view-source):/i;

/**
 * What this browser says it is, to servers and to a page's scripts: the
 * machine it runs on, as Chrome names it in its reduced user agent — macOS
 * as 10.15.7 and Windows as NT 10.0, whatever the version. A page offers
 * what runs where the reader is: a Mac's reader of diabrowser.com was asked
 * to join a waitlist for Linux. `navigator.platform` is the one this names
 * (`<Html scripts>`).
 */
const DEFAULT_USER_AGENT = `Mozilla/5.0 (${
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
}) react-x11-components/0.9 (example browser; +https://github.com/sidorares/react-x11-components)`;

/** The profile this process keeps its cookies and storage in, where the
 *  browser has one and the runtime has SQLite. */
const profile = await openProfile();

/** The cookies every tab shares, through the profile; the Public Suffix
 *  List where the optional `tldts` is installed. */
const cookies = new CookieJar({ store: profile?.cookies });
void publicSuffixList().then((list) => {
  if (list) cookies.publicSuffix = list;
});

/** One process's network: a tab's own cache, where each tab is a process,
 *  and the profile's cookies. `BROWSER_DEBUG=1` logs every request and
 *  what came of it. */
const network = new HtmlNetwork({
  // the default; the component sets it from `props.userAgent` (the toolbar's
  // menu) before each load, so a switch takes on the next navigation
  userAgent: DEFAULT_USER_AGENT,
  cookies,
  // on a thread of its own: a page that keeps this one busy laying itself
  // out and running its scripts holds back no download — the 2.3 MB
  // script a playground's frame on joshwcomeau.com waits for came in
  // 2.5 s here and 0.27 s there
  fetch: threadTransport(),
  log: process.env.BROWSER_DEBUG
    ? (...parts) => console.error('[browser]', ...parts)
    : undefined,
});

/** Where a followed link goes: this tab, a new one, or one behind this. */
export type LinkTarget = 'here' | 'tab' | 'background';

/**
 * How a navigation's document comes into the tab's history:
 *
 *  - `push`: a new entry, the browser's own — an address typed, a tab
 *    opened.
 *  - `page`: as the page planned it, the navigation its scripts started —
 *    a push or a replace — and a push where none ran: a link, a form,
 *    `location`.
 *  - `reload`: the current entry again, from the toolbar; `pageReload` the
 *    same from the page's own `location.reload()`, which planned it.
 *  - `traverse`: the entry `key`, a step back or forward to a document the
 *    page no longer has.
 */
export type LoadHow = 'push' | 'page' | 'reload' | 'pageReload' | 'traverse';

/** One entry of a tab's history as the page tells the browser of it
 *  (`onHistory`). */
export interface HistoryEntry {
  /** The session's id for it, which no other entry has. */
  id: string;
  /** Its key, which a replace keeps. */
  key: string;
  url: string;
  /** The document it is an entry of, by the id of the navigation that
   *  loaded it, or 0 for one nothing has loaded yet. */
  doc: number;
}

/** A tab's history: its entries, and which is shown. */
export interface History {
  entries: HistoryEntry[];
  index: number;
}

/** What the browser tells a tab's page, and hears back. */
export interface PageProps {
  /** The navigation to load, until its document has all arrived — its id
   *  becomes the document's — or 0. */
  loadSeq: number;
  loadUrl: string;
  /** How it comes into the history, and for a traversal the entry's key. */
  loadHow: LoadHow;
  loadKey: string;
  /** Past the cache: a reload with Shift. */
  loadFresh: boolean;
  /** The form data to POST, where the navigation is a form's POST — or a
   *  reload of the page one answered. */
  loadPost: PostData | null;
  /** A step to take in the history, once for each `stepSeq`: `stepDelta`
   *  entries back or forward, or with `stepUrl`, to that fragment of the
   *  document shown. */
  stepSeq: number;
  stepDelta: number;
  stepUrl: string;
  /** The tab's history as the browser last heard it (`History`, as JSON):
   *  what a page process new to the tab — its last one having ended —
   *  starts from. Read once. */
  history: string;
  zoom: number;
  /** Whether the page's scripts run: the browser's switch, for the site
   *  the page is from. Read as a document is made; the browser reloads the
   *  page when it changes. */
  scripts: boolean;
  /** The User-Agent to send and to name as `navigator.userAgent`, from the
   *  toolbar's menu, or `null`/absent for the default. The network takes it
   *  for its next request and `navigator` as the next document's scripts
   *  start, so the browser reloads the page when it changes. */
  userAgent?: string | null;
  /** A navigation's document started to arrive. `posted` when it is the
   *  answer to a POST — not to the GET a redirect after one turned it into
   *  — so a reload sends the POST again. */
  onCommit(
    seq: number,
    url: string,
    title: string | null,
    posted: boolean,
  ): void;
  /** …and all of it has. */
  onFinish(seq: number): void;
  /** The history changed (`History`, as JSON): a document shown, a page's
   *  `pushState`, a step back. The address bar and Back and Forward
   *  follow it. */
  onHistory(history: string): void;
  /** A document's title or icon, as the page learns them; `undefined` is
   *  "no news". */
  onMeta(
    doc: number,
    title: string | null | undefined,
    icon: TabIcon | null | undefined,
  ): void;
  /** A link followed, or a form submitted: with `post`, a POST of it. */
  onLink(url: string, target: LinkTarget, post: PostData | null): void;
  /** An entry wants its document loaded, which this process does not have:
   *  a step to one it let go, the page's own reload, or the entry shown
   *  after a crash. `doc` is the document it was, whose POST to send. */
  onLoad(url: string, how: LoadHow, key: string, doc: number): void;
  /** One of the browser's own chords, pressed while this page had the key
   *  (`keys.ts`). */
  onCommand(command: Command): void;
}

/** What `<Html>` is given for one document. */
interface Doc {
  source: string;
  /** More source may still arrive — the document is streaming. */
  partial: boolean;
  charset?: string;
  /** What its relative URLs resolve against; null for the browser's own
   *  pages, which name only absolute ones. */
  baseUrl: string | null;
  /** Where it was loaded from, where a redirect ended. */
  url: string;
}

/** How many documents a tab keeps to show again as they were left, its
 *  session's back-forward cache (`backForwardCache`): as many as Chrome
 *  keeps on the desktop. */
const BFCACHE = 6;

/** A document the tab shows, or keeps to show again as it was left: each
 *  an `<Html>` of its own. */
interface View {
  /** Counts the documents shown, each an `<Html>` of its own. */
  n: number;
  /** Which, by the navigation that loaded it. */
  seq: number;
  /** The address it is shown at: where it was loaded, or the entry a step
   *  went to. */
  url: string;
  /** Whether its scripts run, which is whether its engine keeps its
   *  entries or this process does. */
  scripted: boolean;
  zoom: number;
  /** Its number in the tab's session (`HtmlSessionEntry.document`), once
   *  it has come into it: as its scripts start, or as it is shown to the
   *  session where none run (`show`). */
  number?: number;
  /** What it asks of the pane that scrolls it, once it has been laid out. */
  overflow?: ViewportOverflow;
}

/** The documents the tab has an `<Html>` for, and which of them is shown. */
interface Views {
  views: readonly View[];
  shown: number;
}

/**
 * What the tab shows once its session changed — the WPT runner's `follow`
 * (`scripts/conformance/testharness.tsx`): the document shown came into
 * the session under a number of its own once its `<Html>` is in; a step
 * to a document the session keeps shows that one again; and a document
 * neither shown, current nor kept goes. One on its way in stays shown,
 * and the one it will take the place of stays mounted until it is in, so
 * that it is told where it goes — and kept, where it may be — as it goes.
 */
function follow(
  state: Views,
  session: HtmlSessionHistory,
  mounted: ReadonlySet<number>,
): Views {
  const entry = session.current;
  if (!entry) return state;
  let views = state.views;
  const arriving = (v: View) => !mounted.has(v.n) || v.number === undefined;
  // the current entry's document, where no view has its number, is the
  // one in last that has none
  if (!views.some((v) => v.number === entry.document)) {
    const fresh = [...views]
      .reverse()
      .find((v) => v.number === undefined && mounted.has(v.n));
    if (fresh) {
      views = views.map((v) =>
        v === fresh ? { ...v, number: entry.document } : v,
      );
    }
  }
  const newest = (number: number | undefined) =>
    [...views].reverse().find((v) => v.number === number && mounted.has(v.n))
      ?.n;
  const shownView = views.find((v) => v.n === state.shown);
  const shown =
    shownView && arriving(shownView)
      ? state.shown
      : (newest(entry.document) ?? state.shown);
  const kept = new Set(session.kept);
  views = views.filter(
    (v) =>
      v.n === shown ||
      arriving(v) ||
      ((v.number === entry.document || kept.has(v.number!)) &&
        v.n === newest(v.number)),
  );
  const same =
    views.length === state.views.length &&
    views.every((v, i) => v === state.views[i]);
  return same && shown === state.shown
    ? state
    : { views: same ? state.views : views, shown };
}

/**
 * One document's requests. They go out while it is shown, and while the
 * tab keeps it hidden in the back-forward cache nothing new does: what
 * `<Html>` asks for waits to be shown again, and so does what the page's
 * scripts ask for — its workers', since nothing of the page's own runs
 * while it is kept. What `<Html>` had waiting for the network's pacing as
 * it was kept is stopped, and asked for again once it is shown; what was
 * on the wire already finishes into the network's cache, which every
 * document shares, so it is not cut, and is handed over once the document
 * is shown. The page's own requests from before it was kept, its
 * `pagehide` beacon among them, finish too: what a page was promised
 * cannot be asked for again on its behalf, and the answer waits for it in
 * its frozen engine. `drop()` lets whatever waits go, as the document
 * does.
 */
class DocumentRequests {
  /** What `<Html>` asked for and has not had yet, waiting or on its way:
   *  the status bubble's count, while the document is the one shown. */
  pending = 0;
  private held = false;
  private gone = false;
  private controller = new AbortController();
  private waiting: (() => void)[] = [];
  /** Told each time `pending` moves. */
  private readonly counted: () => void;

  constructor(counted: () => void) {
    this.counted = counted;
  }

  /** Whether the tab keeps the document hidden. */
  hold(held: boolean): void {
    if (this.gone || held === this.held) return;
    this.held = held;
    if (held) this.controller.abort();
    else {
      this.controller = new AbortController();
      this._wake();
    }
  }

  /** The document goes: what waits is declined, and what is on its way
   *  for `<Html>` is stopped. */
  drop(): void {
    if (this.gone) return;
    this.gone = true;
    this.controller.abort();
    this._wake();
  }

  /** A resource `<Html>` asked for, loaded with `load`. */
  async resource<T>(
    load: (signal: AbortSignal) => Promise<T | null>,
  ): Promise<T | null> {
    this._count(1);
    try {
      for (;;) {
        if (!(await this._shown())) return null;
        const signal = this.controller.signal;
        let got: T | null = null;
        try {
          got = await load(signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
        // stopped as the document was kept: asked for again once shown
        if (!signal.aborted || this.gone) return got;
      }
    } finally {
      this._count(-1);
    }
  }

  /** A request of the page's scripts', sent with `send` once the document
   *  is shown. */
  async page<T>(send: () => Promise<T>): Promise<T> {
    if (!(await this._shown())) throw new Error('The document is gone.');
    return send();
  }

  /** Once the document is shown, or gone: whether it is shown. */
  private async _shown(): Promise<boolean> {
    while (this.held && !this.gone) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    return !this.gone;
  }

  private _wake(): void {
    for (const wake of this.waiting.splice(0)) wake();
  }

  private _count(by: number): void {
    this.pending += by;
    this.counted();
  }
}

/** Where to scroll the document shown once it is drawn: where an entry was
 *  left, its fragment, or the top. */
interface ScrollTarget {
  n: number;
  entry: string | null;
  fragment: boolean;
}

/** Whether this process can run a page's scripts, once it is known: the
 *  engine is loaded the first time a document would run them. */
let engine: boolean | null = null;
let engineAsked: Promise<boolean> | null = null;
function askEngine(): Promise<boolean> {
  engineAsked ??= preloadHtmlScripts().then((runs) => (engine = runs));
  return engineAsked;
}

/** A history the browser kept, as a session again, with the documents its
 *  entries were of by this process's number for each. */
function restored(json: string): {
  session: HtmlSessionHistory;
  seqOf: Map<number, number>;
} {
  let kept: History | null = null;
  try {
    kept = json ? (JSON.parse(json) as History) : null;
  } catch {
    kept = null;
  }
  const entries = kept?.entries ?? [];
  const session = new HtmlSessionHistory(
    {
      entries: entries.map((e) => ({
        url: e.url,
        key: e.key,
        id: e.id,
        document: e.doc || undefined,
      })),
      index: kept?.index,
    },
    { backForwardCache: BFCACHE },
  );
  const seqOf = new Map<number, number>();
  session.entries.forEach((e, i) => {
    if (entries[i].doc) seqOf.set(e.document, entries[i].doc);
  });
  return { session, seqOf };
}

/**
 * The pane watches its own resident memory. `--max-old-space-size` bounds
 * V8's heap and `--wasm-max-mem-pages` a page's wasm memory, but neither
 * counts ArrayBuffers, which a script can hold without end (`new
 * Uint8Array(128 << 20)` in a loop). Past the cap the pane ends itself and
 * the tab shows the crash-and-reload a page whose process died shows.
 * `BROWSER_PANE_RSS_MB` sets it. Only in a real pane: under `BROWSER_INLINE`
 * the page shares the browser's process, where exiting would take the whole
 * browser, so `isFramed()` gates it.
 */
if (isFramed()) {
  const limit = (Number(process.env.BROWSER_PANE_RSS_MB) || 2048) * 1024 * 1024;
  const watch = setInterval(() => {
    if (process.memoryUsage().rss > limit) {
      process.stderr.write(
        `browser pane: resident memory over ${Math.round(limit / 1048576)} MB; ending the tab.\n`,
      );
      process.exit(1);
    }
  }, 1000);
  (watch as { unref?: () => void }).unref?.();
}

export default function Page(props: PageProps): ReactElement {
  const { loadSeq, zoom } = props;
  const cocoa = useSupports('nativeControls');
  // whether a page's `<video>` is handed to the platform's player
  const plays = useSupports('mediaPlayback');
  const [docs, setDocs] = useState<ReadonlyMap<number, Doc>>(new Map());
  const docsNow = useRef(docs);
  docsNow.current = docs;
  // The tab's history, and which navigation's document each of its
  // documents is: from what the browser kept, where this process is new to
  // a tab whose last one ended.
  const [{ session, seqOf }] = useState(() => restored(props.history));
  // The documents the tab has an `<Html>` for: the one shown, those the
  // session keeps to show again, and one on its way in with the one it
  // takes the place of. One state, changed only by updaters: the session
  // tells of a change a microtask on, which may be before React has drawn
  // a document just added.
  const [{ views, shown: shownN }, setViews] = useState<Views>({
    views: [],
    shown: 0,
  });
  const shown = views.find((v) => v.n === shownN) ?? null;
  const shownNow = useRef(shown);
  shownNow.current = shown;
  // the documents whose `<Html>` is in: one that is may have come into the
  // session, as its scripts start
  const mounted = useRef(new Set<number>());
  const doc = shown?.seq ?? 0;
  const url = shown?.url ?? '';
  const page = docs.get(doc) ?? null;
  const handle = useHtmlHandle();
  const scroller = useRef<ScrollableNode | null>(null);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // the link a secondary press was on, which the context menu is about
  const [menuLink, setMenuLink] = useState<string | null>(null);
  const clipboard = useClipboard();
  // what the document shown has asked for and not had
  const [pending, setPending] = useState(0);
  /** Each document's requests, by its view, held while it is kept. */
  const requests = useRef(new Map<number, DocumentRequests>());
  const requestsOf = (n: number): DocumentRequests => {
    let made = requests.current.get(n);
    if (!made) {
      const own = new DocumentRequests(() => {
        if (shownNow.current?.n === n) setPending(own.pending);
      });
      made = own;
      requests.current.set(n, made);
    }
    return made;
  };
  /** What the browser was told of each document's title and icon. */
  const told = useRef(
    new Map<number, { title: string | null; icon: boolean }>(),
  );
  /** Where each entry of the history was scrolled to, by its id, for Back
   *  and Forward. */
  const scrolls = useRef(new Map<string, number>());
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget | null>(null);
  const shows = useRef(0);
  // What the document asks of the pane that scrolls it, once laid out —
  // only down: the document is as wide as the pane, which never scrolls
  // across.
  const hidden = shown?.overflow?.y === 'hidden';
  // The latest callbacks, for the effects that outlive a render: across a
  // process they are stubs that may be new ones with every update.
  const live = useRef(props);
  live.current = props;

  // A pane that is a window of its own is sent the keys typed while the
  // pointer is over it, past the browser's handlers: the browser's chords
  // go back to it from here. Elsewhere the browser saw them first.
  const relay = useSupports('embedding') && isFramed();
  const chords = useMemo(() => shortcuts(cocoa ? 'Super' : 'Control'), [cocoa]);
  useAccelerator(
    chords.flatMap(([, shortcut]) => shortcut),
    (ev) => {
      const hit = chords.find(([, shortcut]) => matchesShortcut(ev, shortcut));
      if (hit) live.current.onCommand(hit[0]);
    },
    { enabled: relay },
  );

  const store = useCallback((id: number, next: Doc | null) => {
    setDocs((all) => {
      const out = new Map(all);
      if (next) out.set(id, next);
      else out.delete(id);
      return out;
    });
  }, []);

  /** The entry shown, where it is the document shown's: not while a
   *  document whose scripts run is on its way in, which its engine takes
   *  its place in the history for as they start. */
  const shownEntry = (): HtmlSessionEntry | null => {
    const current = session.current;
    const now = shownNow.current;
    return current && now?.number === current.document ? current : null;
  };

  /** What was on its way in and has not come into the session goes, as a
   *  navigation another one overtook does — and so does the document
   *  `again`, where a reload makes it again, which the session never keeps.
   *  Left mounted, the first would come into the session after the one
   *  that overtook it. */
  const overtaken = (views: readonly View[], again?: number) =>
    views.filter((v) => v.number !== undefined && v.number !== again);

  /** Show a document the tab has, in an `<Html>` of its own, at `at`:
   *  scrolled to where the entry `entry` was left, or its fragment, or the
   *  top. The one shown before stays mounted, hidden, until this one has
   *  come into the session, which may keep it (`follow`). */
  const showDoc = (
    seq: number,
    doc: Doc,
    at: string,
    entry: string | null,
    again?: number,
  ) => {
    const n = ++shows.current;
    // the browser's own pages run nothing, and a document whose scripts
    // turn out not to run here is shown to the history as one with none
    const runs = live.current.scripts && doc.baseUrl !== null;
    if (runs) void askEngine();
    const view: View = {
      n,
      seq,
      url: at,
      scripted: runs && engine !== false,
      zoom: live.current.zoom,
    };
    setViews(({ views }) => ({
      views: [...overtaken(views, again), view],
      shown: n,
    }));
    setScrollTarget({ n, entry, fragment: at.includes('#') });
  };

  /**
   * What the history makes of the document a navigation loaded, before it
   * is shown: a new entry, the page's own plan, the current entry again, or
   * the entry a step went to. Answers the entry it is shown at where that is
   * known — whose place it is scrolled to — and notes which document it is;
   * and for a reload, the number of the document it makes again.
   */
  const plan = (
    how: LoadHow,
    key: string,
    seq: number,
  ): { entry: string | null; again?: number } => {
    const at =
      how === 'traverse'
        ? session.entries.findIndex((e) => e.key === key)
        : session.index;
    if (how === 'push' || (how === 'traverse' && at < 0)) {
      session.push();
      return { entry: null };
    }
    if (how === 'page') return { entry: null };
    if (how === 'traverse' && at !== session.index) {
      const to = session.go(at - session.index);
      if (to) seqOf.set(to.document, seq);
      return { entry: to?.id ?? null };
    }
    // the current entry again: the page's own reload planned itself
    if (how !== 'pageReload') session.reload();
    const current = session.current;
    if (current) seqOf.set(current.document, seq);
    return { entry: current?.id ?? null, again: current?.document };
  };

  // The User-Agent the toolbar's menu chose, onto this process's network —
  // before the load effect below, so a navigation it starts in the same
  // commit (the reload the browser dispatches when the agent changes) goes
  // out with the new agent. `navigator.userAgent` follows through
  // `scriptsOf`, so the wire and the script agree.
  useEffect(() => {
    network.userAgent = props.userAgent ?? DEFAULT_USER_AGENT;
  }, [props.userAgent]);

  // The navigation in progress, loaded; a new one, or none, aborts it. A
  // document cut off mid-stream stays as far as it got — the stop button's
  // meaning — rather than waiting for the rest forever.
  useEffect(() => {
    if (!loadSeq) return;
    const seq = loadSeq;
    const { loadHow: how, loadKey: key } = props;
    const controller = new AbortController();
    void loadDocument(
      {
        seq,
        url: props.loadUrl,
        fresh: props.loadFresh,
        post: props.loadPost,
        // a link or a script's navigation is the document's, whose site
        // decides which cookies go with it; the browser's own are
        // same-site with anything
        initiator: how === 'page' ? (session.current?.url ?? null) : null,
      },
      cocoa,
      controller.signal,
      {
        commit: (committed, first, title, posted) => {
          store(seq, first);
          const { entry, again } = plan(how, key, seq);
          showDoc(seq, first, committed, entry, again);
          live.current.onCommit(seq, committed, title, posted);
        },
        progress: (next) => store(seq, next),
        finish: () => live.current.onFinish(seq),
      },
    );
    return () => {
      controller.abort();
      setDocs((all) => {
        const cut = all.get(seq);
        if (!cut?.partial) return all;
        return new Map(all).set(seq, { ...cut, partial: false });
      });
    };
  }, [loadSeq]);

  // A document shown with no scripts running in it is shown to the
  // history here, as its engine would as they start.
  useLayoutEffect(() => {
    if (!shown || shown.scripted || shown.number !== undefined) return;
    const { n, seq } = shown;
    const number = session.show(shown.url).document;
    seqOf.set(number, seq);
    setViews((state) => ({
      ...state,
      views: state.views.map((v) => (v.n === n ? { ...v, number } : v)),
    }));
  }, [shown?.n, shown?.scripted]);

  // A new zoom is a new `<Html>`, and where the document's scripts run, a
  // new document at the entry shown — which its own navigations may have
  // moved on from where it was shown: a reload, as the history has it. The
  // documents kept to show again go: a node's scale is its life's, so one
  // kept would come back at the zoom it was left at, and a step back loads
  // it again at this one.
  useLayoutEffect(() => {
    if (!shown || shown.zoom === zoom) return;
    if (shown.scripted) session.reload();
    const at = shownEntry()?.url ?? shown.url;
    setViews((state) => ({
      ...state,
      views: state.views
        .filter((v) => v.n === state.shown)
        .map((v) => ({ ...v, zoom, url: at })),
    }));
  }, [zoom]);

  // A document shown to run its scripts, in a process that turned out to
  // run none: shown to the history here instead.
  const [, engineKnown] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (props.scripts && engine === null) void askEngine().then(engineKnown);
  }, [props.scripts]);
  useEffect(() => {
    if (engine === false && shown?.scripted) {
      setViews((state) => ({
        ...state,
        views: state.views.map((v) =>
          v.n === state.shown ? { ...v, scripted: false } : v,
        ),
      }));
    }
  });

  // The documents follow the history as it changes: the one shown comes
  // into it, one the session keeps stays, hidden, and is shown again as a
  // step reaches it, and the rest go (`follow`).
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(
    () =>
      session.onChange(() => {
        setViews((state) => follow(state, session, mounted.current));
        redraw();
      }),
    [],
  );

  // A document shown again from the back-forward cache is scrolled to where
  // its entry was left: the pane is the tab's, and was scrolled through the
  // documents shown since. A document new to the tab was scrolled as it was
  // shown (`showDoc`). Before `mounted` moves on, which tells the two apart.
  const lastShown = useRef(0);
  useLayoutEffect(() => {
    if (shownN === lastShown.current) return;
    lastShown.current = shownN;
    if (shownN) setPending(requestsOf(shownN).pending);
    const current = session.current;
    if (!mounted.current.has(shownN) || !current) return;
    setScrollTarget({
      n: ++shows.current,
      entry: current.id,
      fragment: current.url.includes('#'),
    });
  }, [shownN]);

  // What the views came to: which are mounted, which are kept and so hold
  // their requests, and which went. The browser hears of the history —
  // its address bar and its Back and Forward follow it — and the documents
  // no entry or view is of any more are let go.
  const toldHistory = useRef('');
  useLayoutEffect(() => {
    mounted.current = new Set(views.map((v) => v.n));
    const kept = new Set(session.kept);
    for (const v of views) {
      if (v.number !== undefined) seqOf.set(v.number, v.seq);
      requestsOf(v.n).hold(
        v.n !== shownN && v.number !== undefined && kept.has(v.number),
      );
    }
    for (const [n, made] of requests.current) {
      if (mounted.current.has(n)) continue;
      made.drop();
      requests.current.delete(n);
    }
    const history: History = {
      entries: session.entries.map((e) => ({
        id: e.id,
        key: e.key,
        url: e.url,
        doc: seqOf.get(e.document) ?? 0,
      })),
      index: session.index,
    };
    const json = JSON.stringify(history);
    if (json !== toldHistory.current) {
      toldHistory.current = json;
      live.current.onHistory(json);
    }
    const held = new Set(history.entries.map((e) => e.doc));
    for (const v of views) held.add(v.seq);
    held.add(live.current.loadSeq);
    setDocs((all) => {
      let out: Map<number, Doc> | null = null;
      for (const id of all.keys()) {
        if (held.has(id)) continue;
        out ??= new Map(all);
        out.delete(id);
      }
      return out ?? all;
    });
    for (const id of told.current.keys()) {
      if (!held.has(id)) told.current.delete(id);
    }
  });

  /** Show the document of another document's entry: the one the tab still
   *  has, where the entry is at its address, or else loaded again. */
  const showEntry = (to: HtmlSessionEntry) => {
    const seq = seqOf.get(to.document) ?? 0;
    const held = docsNow.current.get(seq);
    // a document's scripts may have moved its entry to another address with
    // `pushState`, which a step back to it loads, as a browser that kept no
    // document would
    if (held && withoutHash(held.url) === withoutHash(to.url)) {
      showDoc(seq, held, to.url, to.id);
    } else {
      // what was on its way in would come into the session at the entry
      // the step went to
      setViews((state) => ({ ...state, views: overtaken(state.views) }));
      live.current.onLoad(to.url, 'traverse', to.key, seq);
    }
  };

  /** Go `delta` entries back or forward. Among the document's own entries
   *  it goes there itself — its engine as a task, and here, at once, where
   *  it runs none; to a document the session keeps, that one is shown again
   *  as it was left, once the session tells of it; to another document's,
   *  that document is shown. */
  const goBy = (delta: number) => {
    const from = session.index;
    const target = session.entries[from + delta];
    const kept = !!target && session.kept.includes(target.document);
    const to = session.go(delta);
    if (to) return showEntry(to);
    if (kept) {
      // what was on its way in instead goes, as a step overtakes it
      setViews((state) => ({ ...state, views: overtaken(state.views) }));
      return;
    }
    const current = shownEntry();
    if (!current || shownNow.current?.scripted || session.index === from) {
      return;
    }
    setScrollTarget({
      n: ++shows.current,
      entry: current.id,
      fragment: current.url.includes('#'),
    });
  };

  /** A fragment of the document shown, as an entry of its own, scrolled
   *  to. Where its scripts run their engine keeps its fragments, and one
   *  the browser asks for (a typed one) loads the document again. */
  const toFragment = (to: string, typed: boolean): boolean => {
    const current = shownEntry();
    if (
      current &&
      to.includes('#') &&
      withoutHash(to) === withoutHash(current.url) &&
      session.fragment(to)
    ) {
      setScrollTarget({ n: ++shows.current, entry: null, fragment: true });
      return true;
    }
    if (typed) live.current.onLoad(to, 'push', '', 0);
    return false;
  };

  // A step the browser asks for — Back, Forward, a fragment typed — taken
  // once: a process new to the tab has taken none of the ones before it.
  const stepped = useRef(props.stepSeq);
  useEffect(() => {
    if (props.stepSeq === stepped.current) return;
    stepped.current = props.stepSeq;
    if (props.stepUrl) toFragment(props.stepUrl, true);
    else goBy(props.stepDelta);
  }, [props.stepSeq]);

  // The entry shown has no document here: this process is newer than the
  // history, which the one before it kept, and is gone. Asked for once.
  const lost = useRef(false);
  useEffect(() => {
    const current = session.current;
    if (views.length || loadSeq || lost.current || !current) return;
    lost.current = true;
    live.current.onLoad(
      current.url,
      'reload',
      current.key,
      seqOf.get(current.document) ?? 0,
    );
  }, [views.length, loadSeq]);

  /** What a document asks for, through its requests (`DocumentRequests`):
   *  fetched while it is shown, and held while it is kept. */
  const onResourceOf =
    (view: View) =>
    (request: ResourceRequest): Promise<ResourceResult | null> | null => {
      const pageUrl = withoutHash(view.url);
      // a video, or an audio, is the player's to open, and nothing is
      // fetched here
      if (request.kind === 'video' || request.kind === 'audio') {
        const src = plays && videoSource(request.url, request.type, pageUrl);
        if (!src) return null;
        return Promise.resolve(
          request.kind === 'audio'
            ? { kind: 'audio' as const, src }
            : { kind: 'video' as const, src },
        );
      }
      const kind = request.kind;
      return requestsOf(view.n).resource((signal) =>
        resource(request.url, kind, pageUrl, signal),
      );
    };

  // the title as each document states it, and its icon once its head is in
  const onDocumentOf = (view: View, page: Doc) => (document: Document) => {
    const { seq: doc, url } = view;
    const title = titleOf(document);
    const headDone =
      !page.partial ||
      !!DomUtils.findOne((el) => el.name === 'body', document.children);
    queueMicrotask(() => {
      let was = told.current.get(doc);
      if (!was) told.current.set(doc, (was = { title: null, icon: false }));
      if (title !== was.title) {
        was.title = title;
        live.current.onMeta(doc, title, undefined);
      }
      if (headDone && !was.icon && schemeOf(url) !== 'about') {
        was.icon = true;
        void loadIcon(iconCandidates(document, url), url).then((icon) => {
          if (icon) live.current.onMeta(doc, undefined, icon);
        });
      }
    });
  };

  // Scroll: to where the entry was left, or to its fragment, or the top —
  // as a document is shown, and as one with no scripts goes among its own
  // entries. One whose scripts run scrolls itself among its own (HTML's
  // scroll restoration), and is left to.
  const finished = !!page && !page.partial;
  const savedFor = (target: ScrollTarget | null) =>
    target?.entry ? scrolls.current.get(target.entry) : undefined;
  useLayoutEffect(() => {
    if (!page || !scrollTarget) return;
    const saved = savedFor(scrollTarget);
    if (saved === undefined && scrollTarget.fragment) return;
    scroller.current?.scrollTo({ x: 0, y: saved ?? 0 });
  }, [scrollTarget?.n, !!page]);
  useEffect(() => {
    if (!scrollTarget?.fragment || !finished) return;
    if (savedFor(scrollTarget) !== undefined) return;
    // Where the element is is a question for the layout, which runs after
    // this commit rather than in it: asked a macrotask later, a page just
    // built has been laid out at the width it is shown at.
    const timer = setTimeout(() => {
      // what the fragment points at: the text a `#:~:text=` names, to the
      // middle of the pane, or the element an id names, to its top
      const part = handle.indicatedPart();
      const pane = scroller.current;
      if (!part || !pane) return;
      const { rect } = part;
      const shown = pane.getClientRects()[0]?.height ?? 0;
      const y =
        part.block === 'center'
          ? (rect.y + rect.height / 2) * zoom - shown / 2
          : rect.y * zoom;
      pane.scrollTo({ y: Math.max(0, y) });
    }, 0);
    return () => clearTimeout(timer);
  }, [scrollTarget?.n, finished]);

  const onLink = (href: string, ev: X11MouseEvent<DrawnNode>) => {
    if (/^javascript:/i.test(href)) {
      setNotice(
        props.scripts
          ? 'javascript: links are not run by this browser.'
          : 'Scripts do not run on this site; the toolbar’s JS switch turns them on.',
      );
      return;
    }
    if (!OPENS.test(href)) {
      setNotice(
        `${schemeOf(href) || 'That'}: links are not something this browser opens.`,
      );
      return;
    }
    // ⌘ or Ctrl opens it in a tab behind this one, and with Shift in a tab
    // in front, as a browser has it. On X11 ⌘ is Super, which reaches here
    // as `metaKey` — XQuartz, a Mac keyboard on Linux — so either is taken
    // there; on macOS Ctrl+click is the secondary click, never this.
    const modifier = cocoa ? ev.metaKey : ev.ctrlKey || ev.metaKey;
    let link = handle.elementAt(ev.x, ev.y);
    while (link && link.name !== 'a' && link.name !== 'area') {
      link = link.parent?.type === 'tag' ? (link.parent as Element) : null;
    }
    if (modifier) {
      live.current.onLink(href, ev.shiftKey ? 'tab' : 'background', null);
      return;
    }
    // one whose target names a frame of the page's is loaded there by
    // `<Html scripts>` before it gets here, and goes nowhere without them
    const to = navigableFor(handle.document, linkTarget(link, handle.document));
    if (typeof to !== 'string') return;
    // a fragment of the document shown loads nothing: an entry of its own
    // (one whose scripts run took the link before it got here)
    if (to === 'here' && toFragment(href, false)) return;
    live.current.onLink(href, to, null);
  };

  // A form is a link it writes itself: a GET is one to `submission.url`,
  // which has the entries in its query, and a POST one with a body. Where
  // it goes is decided as a link's is (`navigableFor`): `_blank` a new tab,
  // and a name one of the page's frames has that frame, which `<Html
  // scripts>` loads before this is called, and nothing does without them.
  // The tab stays where it is either way, as Chrome's does when Facebook's
  // pixel posts into its hidden frame.
  const onSubmit = (submission: FormSubmission) => {
    const { url: action, method, body, contentType, target } = submission;
    if (!/^(?:https?|file|data):/i.test(action)) {
      setNotice(
        `${schemeOf(action) || 'That'}: forms are not something this browser sends.`,
      );
      return;
    }
    const post: PostData | null =
      method === 'post' && /^https?:/i.test(action)
        ? { body: body ?? '', contentType: contentType ?? '', from: url }
        : null;
    const to = navigableFor(handle.document, target);
    if (typeof to === 'string') live.current.onLink(action, to, post);
  };

  // A document's scripts, where they run: the browser's seams, the latest
  // of each, and the tab's history. Where the page is shown — the pane, its
  // scroll and the zoom — is `<Html>`'s to read, from the scroller around it
  // and the `scale` between; a script's source comes through `onResource`
  // like any other resource. A document the session keeps runs nothing,
  // and what its workers ask of the network waits for it to be shown again.
  const scriptsOf = (view: View): HtmlScripts | false =>
    view.scripted && {
      userAgent: props.userAgent ?? DEFAULT_USER_AGENT,
      language: (process.env.LANG ?? 'en-US').split('.')[0].replace('_', '-'),
      // what the platform's player opens, where there is one: a stream's
      // playlist among it, which a page with no `MediaSource` hands it
      canPlayType: (type) => (plays ? canPlayMedia(type) : ''),
      session,
      navigate: (to, how) => {
        if (how === 'tab') return live.current.onLink(to, 'tab', null);
        // a fragment the document went to itself, which its engine has
        // written to the history already
        if (to.includes('#') && session.current?.url === to) return;
        live.current.onLink(to, 'here', null);
      },
      reload: () => {
        const current = session.current;
        if (!current) return;
        live.current.onLoad(
          current.url,
          'pageReload',
          current.key,
          seqOf.get(current.document) ?? 0,
        );
      },
      // `history.go` past the document's own entries, and `back()` to another
      // document's: the history planned the step, which is taken here
      go: (delta) => goBy(delta),
      log: (level, text) => {
        if (process.env.BROWSER_DEBUG) console.error(`[page ${level}]`, text);
      },
      title: (title) => live.current.onMeta(view.seq, title, undefined),
      fetch: (request, signal) =>
        requestsOf(view.n).page(() =>
          network.fetcher(withoutHash(view.url))(request, signal),
        ),
      // `document.cookie` is the jar the network sends with, and the storage
      // the profile's, where there is one, shared with every tab
      cookies,
      storage: profile?.storage,
      // a page's WebTransport sessions, over quico where it is installed
      webTransport: network.webTransport,
      // and its peer connections, over werift where it is installed
      webRTC: network.webRTC,
      onTimeout: () =>
        setNotice('A script on this page ran too long, and was stopped.'),
      // the browser's own chords stay the browser's, whatever a page's
      // listener says: a page cancels a key, never the shortcut to close it
      reserved: (event) =>
        (event.type === 'keydown' || event.type === 'keyup') &&
        ((cocoa ? event.metaKey : event.ctrlKey) ||
          (event.altKey && /^Arrow(Left|Right)$/.test(event.key ?? '')) ||
          /^F[56]$/.test(event.key ?? '')),
    };

  // A link's menu, where the press was on one, and nothing where it was
  // not: `<ContextMenu>` opens no menu for no items, and the document's own
  // Copy and Select all are what a press on its text gets.
  const linkMenu = useMemo<MenuItem[]>(
    () =>
      menuLink
        ? [
            {
              key: 'open-tab',
              label: 'Open Link in New Tab',
              enabled: OPENS.test(menuLink),
              onSelect: () => live.current.onLink(menuLink, 'background', null),
            },
            {
              key: 'copy-link',
              label: 'Copy Link Address',
              onSelect: () => {
                clipboard.write(menuLink).catch(() => {});
              },
            },
          ]
        : [],
    [menuLink, clipboard],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  // the link under the pointer was the last document's
  useEffect(() => setHoverLink(null), [shownN]);

  const busy = !!loadSeq || !!page?.partial;
  const status =
    hoverLink ??
    notice ??
    (busy
      ? 'Loading…'
      : pending > 0
        ? `Loading ${pending} resource${pending === 1 ? '' : 's'}…`
        : null);

  return (
    <box
      style={{
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        position: 'relative',
        backgroundColor: '$background',
      }}
    >
      <ContextMenu
        items={linkMenu}
        // the menu's wrapper takes the focus while a menu is open, for its
        // keys, and is no stop of the Tab order between toolbar and page
        tabIndex={-1}
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
        onContextMenuCapture={(ev: X11MouseEvent<DrawnNode>) => {
          const href = handle.hrefAt(ev.x, ev.y);
          setMenuLink(href);
          // and on a link, the link's menu stands in for the document's
          // edit menu, which a cancelled press does not open
          if (href) ev.preventDefault();
        }}
      >
        <box
          ref={scroller}
          style={{
            overflow: 'scroll',
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 0,
          }}
          // A document whose root or body is `overflow: hidden` gave that to
          // the viewport, and the reader is not to scroll it: no bar, no wheel,
          // no keys — though a link to a fragment, and Back and Forward, still
          // scroll there, which is why the pane still scrolls.
          scrollbar={!hidden}
          onWheel={(ev: X11WheelEvent<DrawnNode>) => {
            if (!hidden || !ev.deltaY) return;
            // what scrolls inside the document, a text area's widget, scrolls
            for (let n = ev.target as DrawnNode | null; n; n = n.parent) {
              if (n === scroller.current) break;
              const inner = n as {
                canScroll?: (x: number, y: number) => boolean;
              };
              if (inner.canScroll?.(ev.deltaX, ev.deltaY)) return;
            }
            ev.preventDefault();
          }}
          onKeyDown={(ev: X11KeyboardEvent<DrawnNode>) => {
            // the pane's own keys, where it has the focus; with a modifier
            // they are the browser's chords
            if (
              hidden &&
              ev.target === scroller.current &&
              ev.keysym !== undefined &&
              VERTICAL_SCROLL_KEYS.has(ev.keysym) &&
              !ev.ctrlKey &&
              !ev.metaKey &&
              !ev.altKey
            ) {
              ev.preventDefault();
            }
          }}
          onScroll={(ev) => {
            const entry = shownEntry();
            if (entry) scrolls.current.set(entry.id, ev.scrollY);
          }}
          onMouseMove={(ev: X11MouseEvent<DrawnNode>) => {
            const href = handle.hrefAt(ev.x, ev.y);
            if (href !== hoverLink) setHoverLink(href);
          }}
          onMouseLeave={() => setHoverLink(null)}
          onMouseDown={(ev: X11MouseEvent<DrawnNode>) => {
            // a middle click opens the link in a tab behind this one
            if (ev.button !== 2) return;
            const href = handle.hrefAt(ev.x, ev.y);
            if (href) live.current.onLink(href, 'background', null);
          }}
        >
          {views.map((view) => {
            const source = docs.get(view.seq);
            if (!source) return null;
            // one the session keeps is laid out, drawn and handed nothing
            // while it is hidden, and the handle is the document shown's
            const visible = view.n === shownN;
            return (
              // Zoom is core's `scale`, CSS `zoom` for a subtree. A node's
              // scale is constant for its life by core's contract, and
              // `<Html>` keeps its device-pixel work on that promise, so a
              // new zoom is a new page — built from the source it already
              // has and resources the network layer kept.
              //
              // Both grow: a page shorter than the window is still as tall
              // as it, as a browser's canvas is, so its background reaches
              // the bottom at any size rather than stopping where the text
              // does.
              <box
                key={`${view.n}@${view.zoom}`}
                scale={view.zoom}
                style={
                  visible
                    ? { flexDirection: 'column', flexGrow: 1 }
                    : { display: 'none' }
                }
              >
                <Html
                  ref={visible ? handle.ref : undefined}
                  // the web's `medium`: every page's `rem` is sixteen pixels
                  // in a browser, and a design system spaces a page in them,
                  // where the theme's own text size set it all an eighth too
                  // tight
                  fontSize={16}
                  // and a page that does not say which colour scheme it is
                  // drawn in is light, on white, as every browser draws it —
                  // the reader's own preference is still what its
                  // `prefers-color-scheme` rules are asked
                  defaultColorScheme="light"
                  source={source.source}
                  partial={source.partial}
                  charset={source.charset}
                  // where it is shown, and where it runs no scripts, at the
                  // fragment of the entry shown, which is `:target`
                  baseUrl={
                    source.baseUrl &&
                    addressOf(view, visible ? shownEntry() : null)
                  }
                  onResource={onResourceOf(view)}
                  onLink={onLink}
                  onSubmit={onSubmit}
                  scripts={scriptsOf(view)}
                  onDocument={onDocumentOf(view, source)}
                  onViewportOverflow={(overflow) =>
                    setViews((state) => ({
                      ...state,
                      views: state.views.map((v) =>
                        v.n === view.n ? { ...v, overflow } : v,
                      ),
                    }))
                  }
                  style={{ flexGrow: 1 }}
                />
              </box>
            );
          })}
        </box>
      </ContextMenu>
      {status ? (
        <box
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            maxWidth: '70%',
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 3,
            paddingBottom: 3,
            borderTopWidth: 1,
            borderRightWidth: 1,
            borderColor: '$border',
            backgroundColor: '$surface',
          }}
        >
          <text
            style={{
              fontSize: 11,
              color: '$textMuted',
              maxLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {status}
          </text>
        </box>
      ) : null}
    </box>
  );
}

const withoutHash = (url: string): string => url.split('#')[0];

/** The address a document is shown at: where it was shown, and where it
 *  runs no scripts, at the fragment of its entry shown now — one whose
 *  scripts run keeps its own fragments. */
function addressOf(view: View, entry: HtmlSessionEntry | null): string {
  if (view.scripted || !entry) return view.url;
  const at = entry.url.indexOf('#');
  return withoutHash(view.url) + (at < 0 ? '' : entry.url.slice(at));
}

// --- loading a document ------------------------------------------------------

/**
 * How soon a streaming document is first handed to `<Html>`, and how that
 * grows. Each hand-over parses what arrived and lays out the whole document
 * so far, which on a long page costs more than the network does: at a
 * steady 120 ms Wikipedia's 540 KB article took 18 seconds to arrive, the
 * layouts starving the stream. Doubling after each one keeps the first
 * screen early and a long page to a handful of layouts.
 */
const STREAM_FIRST = 120;
const STREAM_MOST = 2000;

interface Navigation {
  seq: number;
  url: string;
  fresh: boolean;
  post: PostData | null;
  /** The document that started it, or null for the browser. */
  initiator: string | null;
}

interface LoadCallbacks {
  /** The document started to arrive, from `url` — where a redirect ended —
   *  and whether it answers a POST. */
  commit(url: string, first: Doc, title: string | null, posted: boolean): void;
  progress(next: Doc): void;
  finish(): void;
}

/**
 * Load a navigation's document: the browser's own pages at once, anything
 * else through the network, an HTML response streamed into the page as it
 * arrives and a response of another kind turned into a page of its own.
 */
async function loadDocument(
  nav: Navigation,
  cocoa: boolean,
  signal: AbortSignal,
  on: LoadCallbacks,
): Promise<void> {
  const own = (
    source: string,
    title: string | null,
    url = nav.url,
    posted = false,
  ) => {
    on.commit(
      url,
      { source, partial: false, baseUrl: null, url },
      title,
      posted,
    );
    on.finish();
  };
  if (nav.url === HOME) return own(homePage(cocoa), 'New Tab');
  if (nav.url === BLANK) return own(blankPage(), 'about:blank');
  if (schemeOf(nav.url) === 'about') {
    return own(
      errorPage(nav.url, 'There is no such page.', 'ERR_INVALID_URL'),
      nav.url,
    );
  }
  const viewSource = nav.url.startsWith('view-source:');
  const target = viewSource ? nav.url.slice('view-source:'.length) : nav.url;
  if (nav.fresh) network.clear();

  let response: DocumentResponse;
  try {
    response = await network.document(target, signal, nav.post, {
      initiator: nav.initiator,
    });
  } catch (error) {
    if (signal.aborted) return;
    const { message, code } =
      error instanceof NetworkError
        ? error
        : {
            message: String((error as Error)?.message ?? error),
            code: 'ERR_FAILED',
          };
    return own(errorPage(target, message, code), null);
  }
  if (signal.aborted) return;

  const posted = !!nav.post && !response.redirected;
  const kind = viewSource ? 'text' : kindOf(response.type, response.url);
  if (kind !== 'html') {
    const bytes = await readAll(response.body, signal);
    if (signal.aborted) return;
    const url = viewSource ? `view-source:${response.url}` : response.url;
    if (kind === 'image') {
      network.seed({ ...response, bytes });
      return own(imagePage(response.url), fileName(response.url), url, posted);
    }
    if (kind === 'text') {
      const text = decode(bytes, response.charset ?? sniffCharset(bytes));
      return own(
        textPage(url, text),
        viewSource ? url : fileName(url),
        url,
        posted,
      );
    }
    return own(unsupportedPage(response.url, response.type), null, url, posted);
  }

  // HTML: stream it. The encoding is the response's, or the one a `<meta>`
  // in the first kilobyte names, or UTF-8 — found before a byte is decoded.
  let head: Uint8Array = new Uint8Array(0);
  const iterator = response.body[Symbol.asyncIterator]();
  let ended = false;
  while (head.length < 1024) {
    const { done, value } = await iterator.next();
    if (signal.aborted) return;
    if (done) {
      ended = true;
      break;
    }
    head = concat(head, value);
  }
  const charset = response.charset ?? sniffCharset(head) ?? 'utf-8';
  const at = landedAt(response.url, target);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  let source = decoder.decode(head, { stream: true });
  const first: Doc = {
    source,
    partial: !ended,
    charset,
    baseUrl: at,
    url: at,
  };
  on.commit(at, first, null, posted);
  let last = Date.now();
  let interval = STREAM_FIRST;
  while (!ended) {
    const { done, value } = await iterator.next();
    if (signal.aborted) {
      void iterator.return?.();
      return;
    }
    if (done) break;
    source += decoder.decode(value, { stream: true });
    if (Date.now() - last >= interval) {
      last = Date.now();
      interval = Math.min(interval * 2, STREAM_MOST);
      on.progress({ ...first, source });
    }
  }
  source += decoder.decode();
  on.progress({ ...first, source, partial: false });
  on.finish();
}

/** Where a navigation's document is: where its response came from, at the
 *  fragment the navigation asked for where that names none — a fetch's
 *  response never does, and a redirect keeps the one it was asked for (HTML
 *  7.4.5, "process a navigate fetch"). Dropped, a link to another page's
 *  `#section`, or its `#:~:text=`, landed at the top. */
function landedAt(response: string, asked: string): string {
  const at = asked.indexOf('#');
  return response.includes('#') || at < 0
    ? response
    : response + asked.slice(at);
}

function kindOf(
  type: string,
  url: string,
): 'html' | 'text' | 'image' | 'other' {
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.startsWith('image/')) return 'image';
  if (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/javascript' ||
    type.endsWith('+xml') ||
    type === 'application/xml'
  ) {
    return 'text';
  }
  // no type at all: what the address says, and HTML where it says nothing
  if (!type) return /\.(txt|md|json|css|js)$/i.test(url) ? 'text' : 'html';
  return 'other';
}

async function readAll(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let out: Uint8Array = new Uint8Array(0);
  for await (const chunk of body) {
    if (signal.aborted) break;
    out = concat(out, chunk);
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The subresource a page asked for, as `<Html>` takes it back. */
async function resource(
  url: string,
  kind: ResourceKind,
  page: string,
  signal: AbortSignal,
): Promise<ResourceResult | null> {
  const fetched = await network.resource(url, kind, page, signal);
  return fetched ? resourceResult(fetched, kind) : null;
}

/** Decoded icons by URL, for every document this process shows: a site's
 *  icon is fetched and decoded once. */
const icons = new Map<string, Promise<TabIcon | null>>();

async function loadIcon(
  candidates: string[],
  page: string,
): Promise<TabIcon | null> {
  for (const url of candidates) {
    let pending = icons.get(url);
    if (!pending) {
      pending = network
        .resource(url, 'image', page)
        .then((f) => (f ? decodeIcon(f.bytes, url) : null));
      icons.set(url, pending);
    }
    const icon = await pending;
    if (icon) return icon;
  }
  return null;
}

/** The document's `<title>`, its white space collapsed as a tab shows it. */
function titleOf(doc: Document): string | null {
  const title = DomUtils.findOne((el) => el.name === 'title', doc.children);
  const text = title
    ? DomUtils.textContent(title).replace(/\s+/g, ' ').trim()
    : '';
  return text || null;
}
