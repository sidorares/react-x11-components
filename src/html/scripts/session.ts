// A navigable's session history across the documents one `<Html>` shows
// (HTML 7.4.1, "session history"): what a host keeps for a tab and hands
// each of the tab's documents as `scripts.session`, so that the documents
// are one history, as a browser's tab holds them.
//
// The engine does the bookkeeping. A document's own navigations —
// `pushState`, a fragment, an intercepted `navigate` — are written here as
// they happen, with their keys, ids and states; a navigation the page
// starts to another document is planned here before the host is asked to
// go there (`navigate`, `reload`, `go`); and the next document the host
// shows with the session takes the plan, or is a push where there is none —
// an address the host went to itself. So a host that loads what it is asked
// to load into the same history has said everything: that the new document
// replaces the old one, and in which history.
//
// A document shown with no scripts running in it has no engine to do that,
// so the host says it was shown (`show`) and keeps its fragments itself
// (`fragment`); and whatever made a change, the host hears of it
// (`onChange`), which is how an address bar and a Back button follow the
// history the documents write.
//
// Light on purpose: a host makes one without the engine (`./hook.ts`), and
// nothing here imports anything heavy. What the engine reads and writes is
// kept out of the class, in `STATES`, so the class's declaration is the
// host's API alone.
import { withoutFragmentDirective } from '../text-fragments.js';
import type { UrlClass } from './platform.js';

declare const crypto: { randomUUID?(): string } | undefined;
declare const URL: UrlClass;
declare const queueMicrotask: (fn: () => void) => void;

/** How a document came to be shown (the Navigation API's
 *  `NavigationType`). */
export type HtmlNavigationType = 'push' | 'replace' | 'reload' | 'traverse';

/** One entry of a session's history, as a host sees it. */
export interface HtmlSessionEntry {
  /** Where it is. */
  readonly url: string;
  /** Its navigation API key (`NavigationHistoryEntry.key`): the entry's
   *  place in the list, which a replace keeps. */
  readonly key: string;
  /** Its navigation API id, which no other entry has. */
  readonly id: string;
  /** The document it is an entry of: the entries one document's own
   *  navigations made share a number, and no two documents do. A reload,
   *  or a traversal to an entry whose document has gone, makes the
   *  document again under the same number. */
  readonly document: number;
}

/** How a session keeps the documents it shows. */
export interface HtmlSessionOptions {
  /**
   * How many documents a step back or forward may show again as they were
   * left — a back-forward cache (HTML 7.4.1, "bfcache"): their scripts'
   * state, their DOM, what was typed into them. Default 0: none, and each
   * document left unloads. A document goes into it where its scripts run,
   * it has loaded, nothing in it listens for `unload` and it holds no
   * connection open; there it is hidden (`pagehide` with `persisted` true)
   * and nothing of its runs until a step shows it again (`pageshow` with
   * `persisted` true). A host that keeps any keeps the `<Html>` of each
   * document in `kept` mounted, hidden, and shows the one the current entry
   * is of (`current.document`).
   */
  backForwardCache?: number;
}

/** What a session is made from where a host restores one: a tab whose
 *  history the host kept while what showed its documents started again. */
export interface HtmlSessionRestore {
  /** The entries, oldest first: each its URL and, where the host kept
   *  them, its key, its id and its document. Entries with the same
   *  `document` are one document's, numbered anew. */
  entries: readonly (Partial<HtmlSessionEntry> & { url: string })[];
  /** Which of them is current: the last where it is left out. */
  index?: number;
}

/** What the engine keeps of an entry: its address, its place, its
 *  document, and what a page stored in it, serialized. */
export interface SessionRecord {
  url: string;
  key: string;
  id: string;
  doc: number;
  /** `history.state`, serialized, or null. */
  state: string | null;
  /** The Navigation API's state, serialized, or null for none. */
  navState: string | null;
  /** Where its document was scrolled to as it left the entry. */
  scroll: [number, number] | null;
}

/** A navigation the page started to another document, which the next
 *  document shown with the session takes. */
export interface SessionPlan {
  type: HtmlNavigationType;
  /** The entry a traversal goes to. */
  key?: string;
  /** The Navigation API state the new entry is given, where the page gave
   *  one (`navigate(url, { state })`, `reload({ state })`). */
  navState?: string | null;
}

/** What a document shown with a session came to: the entry it is at, how
 *  it got there, the entry it left, and which number its document is. */
export interface SessionArrival {
  session: HtmlSessionHistory;
  type: HtmlNavigationType;
  entry: SessionRecord;
  from: SessionRecord | null;
  doc: number;
}

/** The entries of a session as the page's realm reads them: each with
 *  whether it is the document's own. */
export interface SessionView {
  entries: (SessionRecord & { mine: boolean })[];
  index: number;
  type: HtmlNavigationType;
  /** Where in `entries` the entry the document came from is, or -1, and
   *  the entry itself where it is not there any more (a replace). */
  fromIndex: number;
  from: SessionRecord | null;
}

/** Where a document that goes is told what is shown in its place
 *  (`pageswap`): the entry, and how it was gone to. */
export interface SessionSwap {
  type: HtmlNavigationType;
  url?: string;
  key?: string;
  id?: string;
  navState?: string | null;
}

/** What a document whose scripts run is told by its session
 *  (`liveSession`). */
export interface LiveHandlers {
  /** A traversal the host starts among its own entries. */
  traverse(key: string): void;
  /** Another document is shown in its place: where it goes, and whether
   *  the session would keep it to show again. Answers whether it was kept
   *  — frozen, where it may be — or went. */
  swap(to: SessionSwap, keep: boolean): boolean | void;
  /** Shown again from the cache: the session as it is now
   *  (`sessionView`), as JSON. */
  reactivate?(view: string): void;
  /** Let go from the cache, as it is. */
  destroy?(): void;
}

/** The document shown now, where its scripts run, or one the session keeps
 *  to show again: how a traversal the host starts among its own entries
 *  reaches it, and how it hears it is replaced, shown again or let go. */
interface Live extends LiveHandlers {
  arrival: SessionArrival;
}

interface SessionState {
  entries: SessionRecord[];
  index: number;
  plan: SessionPlan | null;
  docs: number;
  /** The document shown last (`arriveAt`): the only one whose writes and
   *  plans are taken. */
  shown: SessionArrival | null;
  live: Live | null;
  /** The document shown last where the host showed it with no scripts
   *  (`show`), whose entries are the host's to keep. */
  hosted: SessionArrival | null;
  /** Who hears of a change (`onChange`), and whether one is owed them. */
  listeners: Set<() => void>;
  owed: boolean;
  /** How many documents it keeps to show again (`backForwardCache`). */
  cache: number;
  /** Those it keeps, by number, the one left longest ago first. */
  kept: Map<number, Live>;
}

const STATES = new WeakMap<HtmlSessionHistory, SessionState>();

function stateOf(session: HtmlSessionHistory): SessionState {
  let state = STATES.get(session);
  if (!state) {
    state = {
      entries: [],
      index: -1,
      plan: null,
      docs: 0,
      shown: null,
      live: null,
      hosted: null,
      listeners: new Set(),
      owed: false,
      cache: 0,
      kept: new Map(),
    };
    STATES.set(session, state);
  }
  return state;
}

/** The entries or the current one changed: those listening hear of it a
 *  microtask later, once for every change made in between. Never at once,
 *  since a change is made inside a page's script, or as `<Html>` reads a
 *  new document. A document kept to show again that no entry is of any
 *  more, or one past what the cache holds, is let go first. */
function changed(state: SessionState): void {
  for (const [doc, live] of [...state.kept]) {
    if (
      state.kept.size > state.cache ||
      !state.entries.some((e) => e.doc === doc)
    ) {
      state.kept.delete(doc);
      live.destroy?.();
    }
  }
  if (state.owed || !state.listeners.size) return;
  state.owed = true;
  queueMicrotask(() => {
    state.owed = false;
    for (const listener of [...state.listeners]) listener();
  });
}

/** A key or an id: a random UUID, as a browser's are. */
function uuid(): string {
  const random =
    typeof crypto === 'undefined' ? undefined : crypto?.randomUUID?.();
  if (random) return random;
  const hex = (n: number) =>
    Array.from({ length: n }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/** An entry as a host is handed it. */
function publicOf(record: SessionRecord): HtmlSessionEntry {
  return {
    url: record.url,
    key: record.key,
    id: record.id,
    document: record.doc,
  };
}

/**
 * A tab's session history, across the documents shown in it (HTML 7.4.1).
 * Make one for each place a host shows pages — a tab, a pane — and hand it
 * to every document shown there as `scripts.session`; each document the
 * host shows with it is the next of its history. A page's `history.length`,
 * `navigation.entries()`, `back()`, `forward()` and `traverseTo()` then
 * reach the entries of the documents before it and after it, a document
 * shown hears how it came to be shown (`navigation.activation`), and the
 * one it replaces where it goes (`pageswap`).
 *
 * What a host does with it is what it already did: load what `navigate`,
 * `reload` and `go` ask for into the same `<Html>`, or into a new one with
 * the same session. The next document is a push, unless the page planned
 * otherwise or the host says so here first: `go()` for its own Back and
 * Forward, `reload()`, `replace()` and `push()`. A document the host shows
 * with no scripts running in it is one the engine never sees, so the host
 * says it was shown (`show()`), and what the host draws from the history
 * follows it through `onChange()`.
 */
export class HtmlSessionHistory {
  /** A new history, empty; or one a host kept, restored (`restore`). */
  constructor(restore?: HtmlSessionRestore, options?: HtmlSessionOptions) {
    const state = stateOf(this);
    state.cache = Math.max(0, Math.trunc(options?.backForwardCache ?? 0) || 0);
    if (!restore?.entries.length) return;
    // the host's numbers for its documents, each made one of this session's
    const docs = new Map<number, number>();
    state.entries = restore.entries.map((e) => {
      let doc = e.document === undefined ? undefined : docs.get(e.document);
      if (doc === undefined) {
        doc = ++state.docs;
        if (e.document !== undefined) docs.set(e.document, doc);
      }
      return {
        url: withoutFragmentDirective(String(e.url)),
        key: e.key ?? uuid(),
        id: e.id ?? uuid(),
        doc,
        state: null,
        navState: null,
        scroll: null,
      };
    });
    const last = state.entries.length - 1;
    state.index = Math.max(0, Math.min(last, restore.index ?? last));
  }

  /**
   * Hear each change of the history: a document shown with it, and what
   * the documents' own navigations write — a push, a replace, a traversal
   * among their entries, a state set. Told a microtask after the change,
   * once for the changes made in between; `entries`, `index` and `current`
   * are what it came to. What a host draws from the history, an address
   * bar or a Back button, follows it from here. Answers the way to stop.
   */
  onChange(listener: () => void): () => void {
    const { listeners } = stateOf(this);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  /** The entries, oldest first. */
  get entries(): readonly HtmlSessionEntry[] {
    return stateOf(this).entries.map(publicOf);
  }

  /** Where the current entry is in `entries`: -1 before any document. */
  get index(): number {
    return stateOf(this).index;
  }

  /** The entry shown now, or null before any document. */
  get current(): HtmlSessionEntry | null {
    const state = stateOf(this);
    const record = state.entries[state.index];
    return record ? publicOf(record) : null;
  }

  /** The documents the session keeps to show again (`backForwardCache`),
   *  by number (`HtmlSessionEntry.document`): those whose `<Html>` a host
   *  keeps mounted, hidden. One that is let go leaves the list, and the
   *  host hears of it (`onChange`). */
  get kept(): readonly number[] {
    return [...stateOf(this).kept.keys()];
  }

  /**
   * Go `delta` entries back or forward, as a browser's Back and Forward do:
   * the entry to show, whose `url` the host loads with this session — the
   * next document shown is at that entry — or null where there is no entry
   * there, or where it is one of the document shown now, which goes there
   * itself, as `history.go` would, and nothing is loaded: its engine
   * traverses as a task, and one the host showed (`show()`) is at the
   * entry when this returns, for the host to scroll. Null too where the
   * entry is of a document the session keeps (`kept`), which is shown
   * again as it was left, once the code that asked is done: the current
   * entry is its, and the host shows its `<Html>` as it hears of the
   * change. A page's own `history.back()` planned its step before it asked
   * the host's `go`, so a `go` seam that asks this for the entry is
   * answered the same entry.
   */
  go(delta: number): HtmlSessionEntry | null {
    const state = stateOf(this);
    const target = state.entries[state.index + Math.trunc(delta)];
    if (!target || !delta) return null;
    if (state.live && target.doc === state.live.arrival.doc) {
      state.live.traverse(target.key);
      return null;
    }
    if (state.kept.has(target.doc)) {
      state.plan = null;
      queueMicrotask(() => reactivate(this, target.key));
      return null;
    }
    state.plan = { type: 'traverse', key: target.key };
    return publicOf(target);
  }

  /** The next document shown with this session is the current entry's
   *  again, as a reload's: its key and its states are kept. */
  reload(): void {
    stateOf(this).plan = { type: 'reload' };
  }

  /** The next document shown with this session takes the current entry's
   *  place, as `location.replace` would put it. */
  replace(): void {
    stateOf(this).plan = { type: 'replace' };
  }

  /** The next document shown with this session is a new entry after the
   *  current one, whatever the page planned and did not go through with:
   *  an address the host goes to itself, typed or chosen. */
  push(): void {
    stateOf(this).plan = null;
  }

  /**
   * A document the host shows with this session and no scripts running in
   * it — JavaScript off for its site, say — which no engine tells the
   * session of: it takes its place in the history as a document whose
   * scripts run does as they start, by the navigation planned for it, or
   * as a push where none was, and the document shown before it goes.
   * Answers its entry. The host keeps its entries from then on: `go()` to
   * one of them moves there and answers null, and `fragment()` adds one.
   */
  show(url: string): HtmlSessionEntry {
    const arrival = arriveAt(this, url);
    const state = stateOf(this);
    state.hosted = arrival;
    state.live = {
      arrival,
      traverse: (key) => {
        const at = state.entries.findIndex((e) => e.key === key);
        if (at < 0 || state.shown !== arrival) return;
        state.index = at;
        changed(state);
      },
      swap: () => false,
    };
    return publicOf(arrival.entry);
  }

  /**
   * The document the host showed (`show()`) went to a fragment of its own,
   * with no scripts to write it — a link to one followed, or one typed: an
   * entry of the same document after the current one, the entries ahead
   * dropped, as a fragment navigation makes one. Answers it, or null where
   * the document shown is not one the host showed itself, whose engine
   * writes its own.
   */
  fragment(url: string): HtmlSessionEntry | null {
    const state = stateOf(this);
    const from = state.entries[state.index];
    if (!state.hosted || state.shown !== state.hosted || !from) return null;
    const record: SessionRecord = {
      url: withoutFragmentDirective(url),
      key: uuid(),
      id: uuid(),
      doc: state.hosted.doc,
      state: null,
      // a fragment's entry keeps the Navigation API's state (HTML 7.4.2.3.3)
      navState: from.navState,
      scroll: null,
    };
    state.entries.splice(state.index + 1);
    state.entries.push(record);
    state.index = state.entries.length - 1;
    changed(state);
    return publicOf(record);
  }
}

/**
 * A document is shown with the session at `url`: it takes the navigation
 * planned for it, or is a push where none was, and its entry is the
 * current one. The document shown before it, where its scripts still run,
 * is told and goes (`pageswap`, then its unload), whichever `<Html>` it
 * was in; the new one reads where it is (`sessionView`).
 */
export function arriveAt(
  session: HtmlSessionHistory,
  url: string,
): SessionArrival {
  const state = stateOf(session);
  const plan = state.plan;
  state.plan = null;
  const address = withoutFragmentDirective(url);
  const from = state.entries[state.index] ?? null;
  let type: HtmlNavigationType = plan?.type ?? 'push';
  let entry: SessionRecord | null = null;
  if (type === 'traverse') {
    const at = state.entries.findIndex((e) => e.key === plan?.key);
    if (at >= 0) {
      state.index = at;
      entry = state.entries[at];
      entry.url = address;
    } else type = 'push';
  }
  if (type === 'reload') {
    if (from) {
      entry = from;
      entry.url = address;
      if (plan?.navState !== undefined) entry.navState = plan.navState;
    } else type = 'push';
  }
  if (type === 'replace' && !from) type = 'push';
  if (!entry) {
    const record: SessionRecord = {
      url: address,
      key: type === 'replace' ? from!.key : uuid(),
      id: uuid(),
      doc: ++state.docs,
      state: null,
      navState: plan?.navState ?? null,
      scroll: null,
    };
    if (type === 'replace') state.entries[state.index] = record;
    else {
      state.entries.splice(state.index + 1);
      state.entries.push(record);
      state.index = state.entries.length - 1;
    }
    entry = record;
  }
  const arrival: SessionArrival = {
    session,
    type,
    entry,
    from,
    doc: entry.doc,
  };
  state.shown = arrival;
  // a document kept under the number this one takes — a host that loaded
  // an entry's document again rather than show the one kept — goes
  const stale = state.kept.get(entry.doc);
  if (stale) {
    state.kept.delete(entry.doc);
    stale.destroy?.();
  }
  const leaving = state.live;
  state.live = null;
  swapOut(state, leaving, entry, type);
  changed(state);
  return arrival;
}

/**
 * The document shown before tells where it goes, and goes — or, where the
 * session would keep it and it may be kept, is frozen and kept: one an
 * entry is still of, and not one a reload makes again under its number.
 */
function swapOut(
  state: SessionState,
  leaving: Live | null,
  entry: SessionRecord,
  type: HtmlNavigationType,
): void {
  if (!leaving) return;
  // what the document that goes is told of the one shown in its place: the
  // entry, where it is of its origin, and else only that it goes
  const near = originOf(leaving.arrival.entry.url) === originOf(entry.url);
  const doc = leaving.arrival.doc;
  const keep =
    state.cache > 0 &&
    doc !== entry.doc &&
    state.entries.some((e) => e.doc === doc);
  const kept = leaving.swap(
    near
      ? {
          url: entry.url,
          type,
          key: entry.key,
          id: entry.id,
          navState: entry.navState,
        }
      : { type },
    keep,
  );
  if (keep && kept === true) {
    state.kept.delete(doc);
    state.kept.set(doc, leaving);
  }
}

/**
 * A step went to an entry of a document the session keeps (`go`): it is
 * the document shown again, at that entry, by a traversal from the entry
 * shown before (HTML 7.4.6.3, "reactivate a document"). The document shown
 * before goes, or is kept in its turn; then the kept one hears the session
 * as it is now. Nothing where it was let go meanwhile.
 */
function reactivate(session: HtmlSessionHistory, key: string): void {
  const state = stateOf(session);
  const at = state.entries.findIndex((e) => e.key === key);
  const entry = state.entries[at];
  const live = entry && state.kept.get(entry.doc);
  if (!live) return;
  state.kept.delete(entry.doc);
  const from = state.entries[state.index] ?? null;
  state.index = at;
  state.plan = null;
  // the arrival its realm writes through, as it was shown now
  const arrival = live.arrival;
  arrival.type = 'traverse';
  arrival.entry = entry;
  arrival.from = from;
  state.shown = arrival;
  const leaving = state.live;
  state.live = live;
  swapOut(state, leaving, entry, 'traverse');
  live.reactivate?.(JSON.stringify(sessionView(arrival)));
  changed(state);
}

/** An address's origin, as a session tells documents apart by: `'null'`
 *  for one it cannot read. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

/** An entry of another origin's document, as a document's realm is handed
 *  it: where it is and its key, and nothing a page stored there, nor its
 *  path — which no API of the page's reads, and no page's realm holds. */
function opaqueOf(record: SessionRecord): SessionRecord {
  return {
    url: originOf(record.url),
    key: record.key,
    id: record.id,
    doc: record.doc,
    state: null,
    navState: null,
    scroll: null,
  };
}

/** The session as the arriving document's realm reads it. */
export function sessionView(arrival: SessionArrival): SessionView {
  const state = stateOf(arrival.session);
  const origin = originOf(arrival.entry.url);
  const seen = (e: SessionRecord): SessionRecord =>
    originOf(e.url) === origin ? e : opaqueOf(e);
  const fromIndex = arrival.from ? state.entries.indexOf(arrival.from) : -1;
  return {
    entries: state.entries.map((e) => ({
      ...seen(e),
      mine: e.doc === arrival.doc,
    })),
    index: state.index,
    type: arrival.type,
    fromIndex,
    from: fromIndex < 0 && arrival.from ? seen(arrival.from) : null,
  };
}

/** Whether the document an arrival made is still the one shown: what a
 *  document that is going may no longer write. */
function shown(arrival: SessionArrival): boolean {
  return stateOf(arrival.session).shown === arrival;
}

/**
 * The document's own entries changed — a push, a replace, a traversal
 * among them, a state set, where it was scrolled to — and the list is the
 * one its realm holds now: its own entries as it has them, and the others'
 * as they were.
 */
export function writeSession(
  arrival: SessionArrival,
  entries: (SessionRecord & { mine: boolean })[],
  index: number,
): void {
  if (!shown(arrival)) return;
  const state = stateOf(arrival.session);
  const others = new Map(
    state.entries.filter((e) => e.doc !== arrival.doc).map((e) => [e.id, e]),
  );
  // a document's own entries are of its origin, whatever its realm says
  const origin = originOf(arrival.entry.url);
  const next: SessionRecord[] = [];
  for (const e of entries) {
    if (!e.mine) {
      const kept = others.get(String(e.id));
      if (kept) next.push(kept);
      continue;
    }
    const url = String(e.url);
    if (originOf(url) !== origin) continue;
    const scroll = Array.isArray(e.scroll)
      ? ([Number(e.scroll[0]) || 0, Number(e.scroll[1]) || 0] as [
          number,
          number,
        ])
      : null;
    next.push({
      url,
      key: String(e.key),
      id: String(e.id),
      doc: arrival.doc,
      state: typeof e.state === 'string' ? e.state : null,
      navState: typeof e.navState === 'string' ? e.navState : null,
      scroll,
    });
  }
  if (!next.length) return;
  state.entries = next;
  state.index = Math.max(0, Math.min(next.length - 1, index));
  changed(state);
}

/** The page planned a navigation to another document, which the next one
 *  shown with the session takes. */
export function planSession(arrival: SessionArrival, plan: SessionPlan): void {
  if (!shown(arrival)) return;
  stateOf(arrival.session).plan = plan;
}

/** The document shown hears the host's traversals among its own entries
 *  (`HtmlSessionHistory.go`), the document shown in its place, and, where
 *  the session keeps it, that it is shown again or let go; the way to stop,
 *  which a document that goes calls, kept or not. */
export function liveSession(
  arrival: SessionArrival,
  handlers: LiveHandlers,
): () => void {
  const state = stateOf(arrival.session);
  if (state.shown !== arrival) return () => {};
  const live: Live = { arrival, ...handlers };
  state.live = live;
  return () => {
    if (state.live === live) state.live = null;
    if (state.kept.get(arrival.doc) === live) {
      state.kept.delete(arrival.doc);
      changed(state);
    }
  };
}
