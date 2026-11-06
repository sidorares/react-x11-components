// A page's windows, on the host's side: each a slot that outlives the
// documents it shows, and what opens one (docs/prd-popups.md).
//
// **One group, one process.** A window with an opener runs in its opener's
// process, as a realm of its own, whatever its origin, as frames do: a
// same-origin page reads `popup.document` in the call that opened it, and
// whether a window stays same-origin is not known until it has gone
// somewhere. So every window of a browsing context group is a `ScriptRunner`
// here, and a window with no opener, `noopener`, is the host's to put anywhere.
//
// **Another origin is a number.** `WindowSlot.adopt` hands a realm the global
// of a window of its own origin, which the host decides, and of no other: what
// a realm is handed its page has, since a page can replace all the facade
// calls. What crosses origins goes through the ops here, by the window's number.
//
// **A window is born with a realm.** `window.open` answers at once, and what
// it answers has a document, so its initial `about:blank` is made here, inside
// the op, before any `<Html>` exists for it. The `<Html>` the host mounts for
// it binds to that runner as a frame's view does (`bindFrame`), and lends it
// its seams. The documents after it are ordinary top-level `<Html scripts>`:
// each comes into the window as its runner is made (`WindowSlot.adopt`).
//
// **A slot outlives its documents, in both directions.** An opener that
// navigates keeps its popups, which then reach its next document: a slot is
// found again by what a window's documents share (`windowKey`) — the host's
// session, or the element of a frame.
//
// **A window leaves its group by being a new one.** A document whose
// `Cross-Origin-Opener-Policy` says so (`./coop.ts`) goes on in a slot of a
// group of its own, over a tree of its own (`WindowSlot.arrives`), and the slot
// it leaves behind is discarded to every window that had it. That keeps a group
// and its tree one to one, which `adopt`, `slotById`, `find` and `follow` stand
// on, and it asks nothing of a tree: a window leaves as a document comes in,
// which has no node of the old one and has yet to be handed anything.
import type { Document, Element } from 'domhandler';

import type {
  HtmlNavigationSource,
  HtmlPopup,
  HtmlPopupFeatures,
  HtmlPopups,
} from '../popups.js';
import type { HtmlServiceWorkers } from '../service-workers.js';
import type { ServiceClient } from './sw-registry.js';
import { makeHtmlHandle } from '../index.js';
import {
  leavesGroup,
  openerPolicyOf,
  refusedAt,
  type DocumentHop,
  type OpenerPolicy,
  type PolicyOf,
} from './coop.js';
import { DomShared, blankDocument, trustworthy } from './host.js';
import type { FramePost } from './host.js';
import type { RunnerSeams, ScriptRunner } from './runner.js';
import { SB_ORIGIN, sandboxOfPolicy } from './sandbox.js';
import type { SetTimeout, UrlClass } from './platform.js';

declare const setTimeout: SetTimeout;
declare const URL: UrlClass;

/** What the host's ops ask of a page's windows (`DomHost.windows`). */
export interface WindowOps {
  /** A new window with an opener, and its number, or 0 where the host
   *  showed none. */
  open(ask: PopupAsk): number;
  /** A new window with no opener, for a document with flags to hand on, which
   *  no tab could carry (`openApart`). */
  apart(ask: PopupAsk): void;
  /** The window of the group a name finds, or 0. */
  find(name: string): number;
  /** Close a window, or this one for 0. */
  close(id: number): void;
  focus(id: number): void;
  navigate(id: number, url: string, replace: boolean): void;
  /** What the page set `window.name` to. */
  named(name: string): void;
  /** This window's opener is none from now on (`opener = null`). */
  disown(): void;
  /** A page wrote into this document, which ends its being the `about:blank`
   *  the window opened with (HTML, "is initial about:blank"). */
  wrote(): void;
  /** This document sends a window somewhere by a path the host sees none of,
   *  a same-origin window's `location`, or the top of its own frames for 0:
   *  what a local document there takes from it (`WindowSlot.initiator`). */
  initiates(id: number): void;
  /** A script of this document reached a window's document. */
  reached(id: number): void;
  /** A message to another realm, by what this one calls it: `name` is 0 for
   *  a frame's parent, a frame's id here, or a window's number made negative.
   *  Who it is from is the host's to say, and it goes only where the origin
   *  it is meant for is that realm's. */
  post(name: number, text: string, targetOrigin: string): void;
  /** A port's message to another realm. */
  wire(name: number, text: string): void;
  /** A window's opener's number. */
  openerOf(id: number): number;
  /** How many frames a window has. */
  lengthOf(id: number): number;
}

/** What a page asked for (`windowOpen`). */
export interface PopupAsk {
  url: string;
  name: string;
  features: HtmlPopupFeatures & { noreferrer?: boolean };
  post?: FramePost | null;
}

/** A runner made for a document the host asked for. */
export type MakeRunner = (
  document: Document,
  url: string,
  seams: RunnerSeams,
) => ScriptRunner;

/** What a window's documents share, and is found again by. */
const SLOTS = new WeakMap<object, WindowSlot>();

/** The next window's number: of the process and not of a group, since a host
 *  mounts its windows by it, and a window that left its group is still one of
 *  the host's. No realm can reach anything by it outside its own group. */
let nextWindow = 1;

/** A browsing context group: the windows that can reach each other, over
 *  one tree of nodes. */
export class WindowGroup {
  readonly slots = new Set<WindowSlot>();

  constructor(readonly shared: DomShared) {
    shared.windows = this;
  }

  /** The next window's number. */
  number(): number {
    return nextWindow++;
  }
}

/** A top-level window, or a frame that opened one: its number in the group,
 *  and the document it shows now. */
export class WindowSlot {
  readonly id: number;
  name = '';
  opener: WindowSlot | null;
  /** The document it shows, while it has one. */
  runner: ScriptRunner | null = null;
  /** `close()` was called: `closed` reads true from then on, and no name
   *  finds it. */
  closing = false;
  /** The next document to come in is the one it opened at. */
  blank = false;
  /** A page opened it, and it has stayed in that group: `about:blank` here is
   *  of what made it, and a service worker's clients say `auxiliary`. */
  readonly auxiliary: boolean;
  /** It shows the `about:blank` it opened with, as a page left it (HTML, "is
   *  initial about:blank"). */
  initial = false;
  /** What the document it shows asks of the windows around it, and its
   *  origin: kept here, since a host may let one document go before it shows
   *  the next. None until its first document is in. */
  active: PolicyOf | null = null;
  /** Who is sending it somewhere, where that is not the document it shows:
   *  what a local document there has its policy from. */
  initiator: PolicyOf | null = null;
  /** The window left its group through this slot, and goes on in another:
   *  what the document it showed asks of the group reaches nothing. */
  severed = false;
  /** A document of this window has been shown. */
  private _shown = false;

  constructor(
    readonly group: WindowGroup,
    opener: WindowSlot | null,
    readonly popup: Popup | null,
    id = group.number(),
  ) {
    this.id = id;
    this.opener = opener;
    this.auxiliary = !!opener;
    group.slots.add(this);
  }

  /** The sandboxing flags of each document this window shows (HTML, "popup
   *  sandboxing flag set"). */
  sandbox = 0;

  /** A document of this window's: it is the one shown from now on, and
   *  every other window of the group reaches it. */
  adopt(runner: ScriptRunner): void {
    const was = this.runner;
    this.runner = runner;
    runner.slot = this;
    this.name =
      String(
        runner.engine.call('__windowSelf', [
          this.id,
          this.opener?.id ?? 0,
          // a document with a name of its own, and none yet in the window,
          // keeps it: a window comes to have a slot as it is named
          this.name || null,
          this.popup?.features.popup ?? false,
          this.blank && !was,
          this.popup?.features.left ?? 0,
          this.popup?.features.top ?? 0,
        ]) ?? this.name,
      ) || this.name;
    if (this.popup && this._shown) {
      runner.host.referrer = this.popup.takeReferrer();
    }
    this._shown = true;
    this.active = { value: runner.openerPolicy, origin: runner.host.origin };
    // a global is handed across only where the host knows the two are of
    // one origin. What a realm is handed its page has, however the facade
    // means to keep it, so another origin's window is a number there
    for (const other of this.group.slots) {
      const there = other.runner;
      if (other === this || !there) continue;
      if (sameOrigin(runner, there)) {
        runner.engine.linkWindow(other.id, there.engine);
        there.engine.linkWindow(this.id, runner.engine);
      } else {
        runner.engine.unlinkWindow(other.id, false);
        there.engine.unlinkWindow(this.id, false);
      }
    }
    if (this.blank && was && was !== runner) {
      this.blank = false;
      if (this.popup) this.popup.initial = null;
      // HTML's "initialize the document object": the document that takes
      // the place of the one it was opened at, where it was opened at an
      // address, is that window. One opened at `about:blank` has finished
      // opening, and whatever it goes to next is another window.
      if (this.popup?.openedAt !== 'about:blank' && sameOrigin(was, runner)) {
        runner.engine.reuseWindow(was.engine);
      }
      was.dispose(null, true);
    }
  }

  /** A document of this window's has gone. */
  left(runner: ScriptRunner): void {
    if (this.runner !== runner) return;
    this.runner = null;
    for (const other of this.group.slots) {
      if (other !== this) other.runner?.engine.unlinkWindow(this.id, false);
    }
  }

  /** The realm the window's `closed` is read in, and every other, is told
   *  at once; it goes in a task of its own (HTML 7.2.2.3, "close a
   *  browsing context"). */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    for (const slot of this.group.slots) {
      slot.runner?.engine.call('__windowClosing', [this.id]);
    }
    setTimeout(() => this.discard(), 0);
  }

  /** It goes: its document unloads, and nothing reaches it from then on. */
  discard(): void {
    this.closing = true;
    const runner = this.runner;
    this.runner = null;
    runner?.dispose();
    this.group.slots.delete(this);
    for (const slot of this.group.slots) {
      if (slot.opener === this) slot.opener = null;
      slot.runner?.engine.unlinkWindow(this.id, true);
    }
    this.popup?.discarded();
  }

  /** What a navigation's responses say of themselves, in the order they
   *  came. A local document has no response to say anything: it goes by who
   *  sent the window there, as WPT and every browser have it, where HTML's
   *  text gives one no policy and enforces none. */
  responses(
    url: string,
    headers: [string, string][],
    redirects: readonly DocumentHop[],
  ): PolicyOf[] {
    if (LOCAL.test(url)) {
      const from = this.initiator ?? this.active;
      return from
        ? [{ value: from.value, origin: originOfUrl(url, from.origin) }]
        : [];
    }
    return [...redirects, { url, headers }].map((hop) => ({
      value: openerPolicyOf(hop.headers, trustworthy(hop.url)),
      origin:
        (this.sandbox | sandboxOfPolicy(hop.headers)) & SB_ORIGIN
          ? 'null'
          : originOfUrl(hop.url),
    }));
  }

  /**
   * A top-level document comes to this window, and this is the slot it comes
   * into: this one, or one of a group of its own, where its responses take
   * the window out of this one (HTML, "obtain a browsing context to use for a
   * navigation response"). `key` is what a tab's slot is found by.
   */
  arrives(
    url: string,
    headers: [string, string][],
    redirects: readonly DocumentHop[],
    key: object,
  ): WindowSlot {
    const active = this.active;
    // its first document, which `open` says the policy of, or a window on its
    // way out, which a new slot would bring back
    if (!active || this.closing) return this;
    const responses = this.responses(url, headers, redirects);
    const refused = refusedAt(this.sandbox, responses);
    const read = refused === null ? responses : responses.slice(0, refused + 1);
    const leaves = leavesGroup(this.initial, active, read);
    const last = read.at(-1) ?? active;
    this.initial = false;
    this.initiator = null;
    const slot = leaves ? this._sever(key) : this;
    slot.active = last;
    return slot;
  }

  /** The window goes on in a slot of a new group, over a tree of its own, with
   *  no opener and no name (`arrives`). To everything of this group this slot
   *  is a window that was discarded, and what it had is nobody's. */
  private _sever(key: object): WindowSlot {
    const next = new WindowSlot(
      new WindowGroup(new DomShared()),
      null,
      this.popup,
    );
    next.sandbox = this.sandbox;
    next._shown = this._shown;
    if (this.popup) this.popup.slot = next;
    else SLOTS.set(key, next);
    this.severed = true;
    this.closing = true;
    const was = this.runner;
    this.runner = null;
    this.group.slots.delete(this);
    for (const slot of this.group.slots) {
      if (slot.opener === this) slot.opener = null;
      slot.runner?.engine.unlinkWindow(this.id, true);
      was?.engine.unlinkWindow(slot.id, true);
    }
    // nothing else lets the document it opened with go: a view only binds it
    if (this.blank) {
      if (this.popup) this.popup.initial = null;
      was?.dispose(null, true);
    }
    return next;
  }

  /** It goes somewhere: its document's own navigation, which that document
   *  hears of first. */
  navigate(
    url: string,
    how: 'here' | 'replace',
    post: FramePost | null,
    source?: HtmlNavigationSource,
  ): void {
    const seams = this.runner?.seams;
    if (!seams) return;
    seams.navigate(url, how, post, undefined, source);
  }
}

/** Whether two documents are of one origin, one of `about:blank` being the
 *  origin of what made it, and an opaque origin being no other's. */
function sameOrigin(a: ScriptRunner, b: ScriptRunner): boolean {
  if (a.host.origin !== b.host.origin) return false;
  // an opaque origin is one document's, and those that document made
  return (
    a.host.origin !== 'null' || a.host.opaqueOrigin === b.host.opaqueOrigin
  );
}

/** Whether a document may send a window to an address: a `javascript:` URL
 *  runs in the document it is sent to, so it is only that origin's to send
 *  (HTML 7.4.2.3.2, which ends the navigation there), and a host hears of
 *  none. Asked here, of the address as `URL` left it, and not of what the
 *  page's realm says it is. */
function maySend(from: ScriptRunner, to: WindowSlot, url: string): boolean {
  return (
    !/^javascript:/i.test(url) || (!!to.runner && sameOrigin(from, to.runner))
  );
}

/** The slot of a document, which is made for it the first time something
 *  asks: a window nothing opened and that opens nothing has none. */
function slotOf(runner: ScriptRunner): WindowSlot {
  if (runner.slot) return runner.slot;
  const shared = runner.host.shared;
  const group = shared.windows ?? new WindowGroup(shared);
  const slot = new WindowSlot(group, null, null);
  SLOTS.set(runner.windowKey, slot);
  slot.adopt(runner);
  return slot;
}

/** The slot a window's next document comes into, where it has one. */
export function slotFor(key: object): WindowSlot | null {
  return SLOTS.get(key) ?? null;
}

/** A document with no response of its own: `about:blank`, whatever comes
 *  after it, and what a page made and named by a URL. */
const LOCAL = /^(about:blank([?#]|$)|blob:)/i;

/** The origin of an address, or `fallback` for none: `about:blank` has one
 *  only by who sent the window there. */
function originOfUrl(url: string, fallback = 'null'): string {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? fallback : origin;
  } catch {
    return fallback;
  }
}

/** What a local document takes from a document that sends a window to it:
 *  the policy of the top of its frames, where it is of that origin (HTML,
 *  "creating a new browsing context"). */
function policyFrom(runner: ScriptRunner): PolicyOf {
  const top = runner.topmost;
  return {
    value: sameOrigin(runner, top) ? top.openerPolicy : 'unsafe-none',
    origin: runner.host.origin,
  };
}

/** A handle on no `<Html>`, which answers nothing: a window's until the host
 *  mounts one. */
const idleHandle = () => makeHtmlHandle({ current: null }, () => {});

/** A window a page opened, as its host is handed it, and the seat its first
 *  document runs in. */
export class Popup implements HtmlPopup {
  readonly id: number;
  readonly name: string;
  readonly features: HtmlPopupFeatures;
  readonly referrer: string | null;
  readonly post: FramePost | null;
  /** What opened it, which its `about:blank` is the origin and the base of. */
  readonly creator: string;
  slot!: WindowSlot;
  /** The document it opened with, until the first it navigates to. */
  initial: ScriptRunner | null = null;
  /** The address the page opened it at. */
  readonly openedAt: string;
  /** What keeps the service workers of the document that opened it, and that
   *  document as a client of them: its `about:blank` is under the same. */
  readonly serviceKeeper: HtmlServiceWorkers | null;
  readonly creatorClient: ServiceClient | null;
  private _url: string;
  private _width: number;
  private _height: number;
  private _closes = new Set<() => void>();
  private _focuses = new Set<() => void>();
  private _resizes = new Set<
    (size: { width: number; height: number }) => void
  >();
  private _views: RunnerSeams[] = [];
  private _sheets: string[] = [];
  private _idle = idleHandle();
  private _referred = false;
  private _source: HtmlNavigationSource | undefined;

  constructor(
    ask: PopupAsk,
    creator: string,
    id: number,
    /** What made it, where that has a runner: a document with no script of
     *  its own has no service workers to hand on. */
    opener: ScriptRunner | null,
  ) {
    this.id = id;
    this._source = opener?.host.navigationSource();
    this.serviceKeeper = opener?.serviceKeeper ?? null;
    this.creatorClient = opener?.host.serviceClient ?? null;
    this._url = ask.url;
    this.openedAt = ask.url;
    this.name = ask.name;
    this.features = ask.features;
    this._width = Math.max(0, Math.floor(ask.features.width ?? 0));
    this._height = Math.max(0, Math.floor(ask.features.height ?? 0));
    this.creator = creator;
    this.referrer = ask.features.noreferrer ? null : creator;
    this.post = ask.post ?? null;
  }

  /** The document that sent it to where it goes first. */
  get source(): HtmlNavigationSource | undefined {
    return this._source;
  }

  get url(): string {
    return this._url;
  }

  get closed(): boolean {
    return this.slot?.closing ?? false;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  resizeTo(width: number, height: number): void {
    const w = Math.max(0, Math.floor(Number(width) || 0));
    const h = Math.max(0, Math.floor(Number(height) || 0));
    if (w === this._width && h === this._height) return;
    this._width = w;
    this._height = h;
    const size = { width: w, height: h };
    for (const listener of [...this._resizes]) listener(size);
  }

  /** The opaque origin that opened it, where one did: what its first
   *  document is of, which `creator`, an address, does not say. */
  creatorOrigin: object | null = null;

  /** The sandboxing flags each document it shows has. */
  get sandbox(): number {
    return this.slot?.sandbox ?? 0;
  }

  /** Whether its flags turn a document down (`refusedAt`): a network error,
   *  so nothing of it is run or drawn. */
  refuses(
    url: string,
    headers: [string, string][],
    redirects: readonly DocumentHop[],
  ): boolean {
    if (!this.slot?.sandbox || LOCAL.test(url)) return false;
    const read = this.slot.responses(url, headers, redirects);
    return refusedAt(this.slot.sandbox, read) !== null;
  }

  /** A document it shows runs nothing, so no runner brings it in: it may
   *  take the window out of its group all the same. */
  arrivedBare(
    url: string,
    headers: [string, string][],
    redirects: readonly DocumentHop[],
  ): void {
    this.slot?.arrives(url, headers, redirects, this);
  }

  /** What the document it opened with is, for the `<Html>` that draws it:
   *  null once another has taken its place. */
  get initialDocument(): Document | null {
    return this.initial?.host.document ?? null;
  }

  /** `document.referrer` of the first document it shows, and of no other. */
  takeReferrer(): string {
    if (this._referred) return '';
    this._referred = true;
    return this.referrer ?? '';
  }

  close(): void {
    if (!this.slot.closing) this.slot.discard();
  }

  onClose(listener: () => void): () => void {
    this._closes.add(listener);
    return () => this._closes.delete(listener);
  }

  onFocus(listener: () => void): () => void {
    this._focuses.add(listener);
    return () => this._focuses.delete(listener);
  }

  onResize(
    listener: (size: { width: number; height: number }) => void,
  ): () => void {
    this._resizes.add(listener);
    return () => this._resizes.delete(listener);
  }

  focused(): void {
    for (const listener of [...this._focuses]) listener();
  }

  discarded(): void {
    for (const listener of [...this._closes]) listener();
    this._closes.clear();
  }

  /** The seams its first document runs with: the opener's until a view is
   *  mounted, and that view's after, as a frame's do (`bindFrame`). */
  seams(opener: RunnerSeams): RunnerSeams {
    const current = (): RunnerSeams => this._views.at(-1) ?? opener;
    const handle = new Proxy({} as RunnerSeams['handle'], {
      get: (_, key) =>
        Reflect.get(this._views.at(-1)?.handle ?? this._idle, key),
    });
    const adopt = (sheets: string[]): void => {
      this._sheets = sheets;
      for (const view of this._views) view.adopt?.(sheets);
    };
    // what the document asks before a view is mounted waits for the host,
    // which reads where to go from `url` as it mounts one
    const navigate: RunnerSeams['navigate'] = (to, how, post, name, source) => {
      if (this._views.length || how === 'tab') {
        current().navigate(to, how, post, name, source);
      } else {
        this._url = to;
        if (source) this._source = source;
      }
    };
    return new Proxy({} as RunnerSeams, {
      get: (_, key) => {
        if (key === 'handle') return handle;
        if (key === 'adopt') return adopt;
        if (key === 'navigate') return navigate;
        if (key === 'popup') return this;
        if (key === 'session') return null;
        return Reflect.get(current(), key);
      },
    });
  }

  /** The `<Html>` that draws its first document (`useScripts`). */
  bindFrame(
    _document: Document,
    _url: string,
    _frame: Element | null,
    view: RunnerSeams,
  ): ScriptRunner | null {
    if (!this.initial) return null;
    this._views.push(view);
    if (this._sheets.length) view.adopt?.(this._sheets);
    return this.initial;
  }

  /** That `<Html>` has gone. */
  releaseFrame(_document: Document, view: RunnerSeams): void {
    const at = this._views.indexOf(view);
    if (at >= 0) this._views.splice(at, 1);
  }
}

/** The `about:blank` a window opened in a group opens with, whose first
 *  document `arrives` holds the next to: HTML, "creating a new browsing
 *  context". */
function startWindow(
  popup: Popup,
  slot: WindowSlot,
  flags: number,
  policy: OpenerPolicy,
  document: Document,
  seams: RunnerSeams,
  make: MakeRunner,
): void {
  slot.name = popup.name;
  popup.slot = slot;
  slot.blank = true;
  // what the window's every document starts with, unless the page that
  // opened it lets it out (`allow-popups-to-escape-sandbox`)
  slot.sandbox = flags;
  slot.group.shared.documents.add(document);
  const blank = make(document, 'about:blank', popup.seams(seams));
  popup.initial = blank;
  blank.openerPolicy = policy;
  slot.active = { value: policy, origin: blank.host.origin };
  slot.initial = true;
  // nothing to wait for: `window.open` hands it back complete
  void blank.parsed();
  blank.loaded();
}

/**
 * A window with no opener, from a document with sandboxing flags to hand on. A
 * tab is the host's and carries no flags, so such a window never is one: it is
 * a window of this process, shown as any is, in a group of its own, where its
 * every document keeps them. A host that shows no windows has nothing to keep
 * them in, so nothing opens, which `document` has no way to tell from a blocked
 * popup. `from` is what the host was handed for a document that has no runner:
 * a sandbox with no `allow-scripts`.
 */
export function openApart(
  ask: PopupAsk,
  from: {
    url: string;
    flags: number;
    seams: RunnerSeams;
    runner: ScriptRunner | null;
  },
  make: MakeRunner,
): void {
  const popups = from.seams.popups;
  if (!popups) {
    from.seams.log(
      'warn',
      `A window of a sandboxed document has nowhere to keep its flags: ${ask.url} was not opened.`,
    );
    return;
  }
  const popup = new Popup(ask, from.url, nextWindow++, from.runner);
  if (!popups.open(popup)) return;
  const group = new WindowGroup(new DomShared());
  startWindow(
    popup,
    new WindowSlot(group, null, popup, popup.id),
    from.flags,
    'unsafe-none',
    blankDocument(),
    from.seams,
    make,
  );
}

/** Whether a window this document opens has no opener: one of another origin
 *  than the top of its frames, under a `same-origin` policy there (HTML, "the
 *  rules for choosing a navigable"). HTML says the document's own policy, which
 *  a frame has none of, and notes the rule as nested documents' "in the
 *  presence of an opener policy": WPT and browsers read the top's. */
function opensNoOpener(runner: ScriptRunner): boolean {
  const top = runner.topmost;
  return (
    (top.openerPolicy === 'same-origin' ||
      top.openerPolicy === 'same-origin-plus-coep') &&
    !sameOrigin(runner, top)
  );
}

/** What opens and reaches a document's windows (`DomHost.windows`). */
export function windowOps(
  runner: ScriptRunner,
  make: MakeRunner,
): WindowOps & {
  follow(
    url: string,
    target: string,
    noopener: boolean,
    noreferrer: boolean,
    post: FramePost | null,
  ): boolean;
} {
  /** The group this document can reach: none once its window has left it,
   *  whatever is left of it while the host lets it go. */
  const reachable = (): WindowGroup | null =>
    runner.slot?.severed ? null : runner.host.shared.windows;
  const slotById = (id: number): WindowSlot | null => {
    if (!id) return slotOf(runner);
    for (const slot of reachable()?.slots ?? []) {
      if (slot.id === id) return slot;
    }
    return null;
  };
  /** The realm a name is, and what that one calls this one. */
  const realmAt = (
    name: number,
  ): { runner: ScriptRunner; from: number } | null => {
    if (name < 0) {
      const there = slotById(-name)?.runner;
      return there && runner.slot
        ? { runner: there, from: -runner.slot.id }
        : null;
    }
    if (name > 0) {
      const there = runner.frameRealm(name);
      return there && { runner: there, from: 0 };
    }
    return runner.parentRealm;
  };
  const find = (name: string): WindowSlot | null => {
    const group = reachable();
    if (!name || !group) return null;
    for (const slot of group.slots) {
      if (!slot.closing && slot.runner && slot.name === name) return slot;
    }
    return null;
  };
  /** Whether a press or a key is behind what opens a window, spending it,
   *  and `blocked` told where none is. */
  const allowed = (popups: HtmlPopups, url: string): boolean => {
    if (
      popups.unblocked ||
      runner.engine.call('__windowActivation', null) === true
    ) {
      return true;
    }
    popups.blocked?.(url);
    return false;
  };
  const apart = (ask: PopupAsk): void => {
    openApart(
      ask,
      {
        url: runner.host.url,
        flags: runner.host.popupSandbox,
        seams: runner.seams,
        runner,
      },
      make,
    );
  };
  const open = (ask: PopupAsk): number => {
    const popups = runner.seams.popups;
    if (!popups) return 0;
    const alone = opensNoOpener(runner);
    // a tab is the host's, and carries no sandboxing flags, so a window that
    // has to keep them stays here, in a group of its own
    if (alone) {
      if (runner.host.popupSandbox) apart({ ...ask, name: '' });
      else runner.seams.navigate(ask.url, 'tab', ask.post ?? null, '');
      return 0;
    }
    const from = slotOf(runner);
    const popup = new Popup(ask, runner.host.url, from.group.number(), runner);
    popup.creatorOrigin = runner.host.opaqueOrigin;
    if (!popups.open(popup)) return 0;
    const slot = new WindowSlot(from.group, from, popup, popup.id);
    startWindow(
      popup,
      slot,
      runner.host.popupSandbox,
      policyFrom(runner).value,
      blankDocument(),
      runner.seams,
      make,
    );
    return slot.id;
  };
  return {
    open,
    apart(ask) {
      const popups = runner.seams.popups;
      if (!popups || allowed(popups, ask.url)) apart(ask);
    },
    find: (name) => find(name)?.id ?? 0,
    close(id) {
      const slot = slotById(id);
      if (!slot || slot.closing) return;
      if (slot.popup || slot.runner?.closeTab()) slot.close();
    },
    focus(id) {
      slotById(id)?.popup?.focused();
    },
    navigate(id, url, replace) {
      const slot = slotById(id);
      if (slot && maySend(runner, slot, url)) {
        slot.initiator = policyFrom(runner);
        slot.navigate(
          url,
          replace ? 'replace' : 'here',
          null,
          runner.host.navigationSource(),
        );
      }
    },
    named(name) {
      // a tab's name outlives its document; a frame's is its element's
      if (!runner.frame) slotOf(runner).name = name;
    },
    disown() {
      if (runner.slot) runner.slot.opener = null;
    },
    wrote() {
      if (runner.slot) runner.slot.initial = false;
    },
    initiates(id) {
      const slot = id ? slotById(id) : runner.topmost.slot;
      if (slot) slot.initiator = policyFrom(runner);
    },
    reached(id) {
      const there = slotById(id)?.runner;
      if (there && sameOrigin(runner, there)) {
        runner.engine.reached(there.engine);
      }
    },
    post(name, text, targetOrigin) {
      const to = realmAt(name);
      if (!to) return;
      const origin = to.runner.host.origin;
      // `/` is this realm's own origin, which that one is not, or this would
      // have its global; a message for another origin goes nowhere
      if (targetOrigin !== '*') {
        const meant =
          targetOrigin === '/' ? runner.host.origin : originOfUrl(targetOrigin);
        if (meant === 'null' || meant !== origin) return;
      }
      to.runner.engine.call('__messageAcross', [
        text,
        runner.host.origin,
        to.from,
      ]);
    },
    wire(name, text) {
      const to = realmAt(name);
      to?.runner.engine.call('__wireAcross', [text, to.from]);
    },
    openerOf: (id) => slotById(id)?.opener?.id ?? 0,
    lengthOf: (id) => slotById(id)?.runner?.host.frames().length ?? 0,
    follow(url, target, noopener, noreferrer, post) {
      // what comes of it may be no window at all, and is never a tab
      const flags = runner.host.popupSandbox;
      const popups = runner.seams.popups;
      if (!popups && !flags) return false;
      const there = find(target);
      if (there) {
        if (maySend(runner, there, url)) {
          there.initiator = policyFrom(runner);
          there.navigate(url, 'here', post, runner.host.navigationSource());
        }
        return true;
      }
      if (noopener && !flags) return false;
      if (popups && !allowed(popups, url)) return true;
      const name = target.toLowerCase() === '_blank' ? '' : target;
      const ask = { url, name, features: { popup: false, noreferrer }, post };
      if (noopener) {
        apart(ask);
        return true;
      }
      const opened = open(ask);
      // one with no opener has no number, and it has been seen to all the same
      return !!opened || !!flags || opensNoOpener(runner);
    },
  };
}
