// A page's windows, on the host's side: each a slot that outlives the
// documents it shows, and what opens one (docs/prd-popups.md).
//
// **One group, one process.** A window with an opener runs in its opener's
// process, as a realm of its own, whatever its origin, as frames do: a
// same-origin page reads `popup.document` in the call that opened it, and
// whether a window stays same-origin is not known until it has gone
// somewhere. So every window of a browsing context group is a `ScriptRunner`
// here, linked in pairs with the rest through `WindowSlot`, and a window with
// no opener, `noopener`, is the host's to put anywhere.
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
import type { Document, Element } from 'domhandler';

import type { HtmlPopup, HtmlPopupFeatures } from '../popups.js';
import type { HtmlServiceWorkers } from '../service-workers.js';
import { makeHtmlHandle } from '../index.js';
import type { FramePost, DomShared } from './host.js';
import type { RunnerSeams, ScriptRunner } from './runner.js';
import type { SetTimeout } from './platform.js';

declare const setTimeout: SetTimeout;

/** What the host's ops ask of a page's windows (`DomHost.windows`). */
export interface WindowOps {
  /** A new window with an opener, and its number, or 0 where the host
   *  showed none. */
  open(ask: PopupAsk): number;
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
  /** A script of this document reached a window's document. */
  reached(id: number): void;
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

/** A browsing context group: the windows that can reach each other, over
 *  one tree of nodes. */
export class WindowGroup {
  readonly slots = new Set<WindowSlot>();
  private _next = 1;

  constructor(readonly shared: DomShared) {
    shared.windows = this;
  }

  /** The next window's number. */
  number(): number {
    return this._next++;
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

  constructor(
    readonly group: WindowGroup,
    opener: WindowSlot | null,
    readonly popup: Popup | null,
    id = group.number(),
  ) {
    this.id = id;
    this.opener = opener;
    group.slots.add(this);
  }

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
    if (this.popup) {
      runner.host.creator = this.popup.creator;
      if (was) runner.host.referrer = this.popup.takeReferrer();
    }
    for (const other of this.group.slots) {
      const there = other.runner;
      if (other === this || !there) continue;
      runner.engine.linkWindow(other.id, there.engine);
      there.engine.linkWindow(this.id, runner.engine);
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

  /** It goes somewhere: its document's own navigation, which that document
   *  hears of first. */
  navigate(url: string, how: 'here' | 'replace', post: FramePost | null): void {
    const seams = this.runner?.seams;
    if (!seams) return;
    seams.navigate(url, how, post);
  }
}

/** Whether two documents are of one origin, one of `about:blank` being the
 *  origin of what made it. */
function sameOrigin(a: ScriptRunner, b: ScriptRunner): boolean {
  return a.host.origin === b.host.origin;
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
  /** What keeps the service workers of the document that opened it. */
  readonly serviceKeeper: HtmlServiceWorkers | null;
  private _url: string;
  private _closes = new Set<() => void>();
  private _focuses = new Set<() => void>();
  private _views: RunnerSeams[] = [];
  private _sheets: string[] = [];
  private _idle = idleHandle();
  private _referred = false;

  constructor(
    ask: PopupAsk,
    creator: string,
    id: number,
    opener: ScriptRunner,
  ) {
    this.id = id;
    this.serviceKeeper = opener.serviceKeeper;
    this._url = ask.url;
    this.openedAt = ask.url;
    this.name = ask.name;
    this.features = ask.features;
    this.creator = creator;
    this.referrer = ask.features.noreferrer ? null : creator;
    this.post = ask.post ?? null;
  }

  get url(): string {
    return this._url;
  }

  get closed(): boolean {
    return this.slot?.closing ?? false;
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
    const navigate: RunnerSeams['navigate'] = (to, how, post, name) => {
      if (this._views.length) current().navigate(to, how, post, name);
      else this._url = to;
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
  const slotById = (id: number): WindowSlot | null => {
    if (!id) return slotOf(runner);
    for (const slot of runner.host.shared.windows?.slots ?? []) {
      if (slot.id === id) return slot;
    }
    return null;
  };
  const find = (name: string): WindowSlot | null => {
    const group = runner.host.shared.windows;
    if (!name || !group) return null;
    for (const slot of group.slots) {
      if (!slot.closing && slot.runner && slot.name === name) return slot;
    }
    return null;
  };
  const open = (ask: PopupAsk): number => {
    const popups = runner.seams.popups;
    if (!popups) return 0;
    const from = slotOf(runner);
    const popup = new Popup(ask, runner.host.url, from.group.number(), runner);
    if (!popups.open(popup)) return 0;
    const slot = new WindowSlot(from.group, from, popup, popup.id);
    slot.name = ask.name;
    popup.slot = slot;
    slot.blank = true;
    const blank = make(
      runner.host.blankDocument(),
      'about:blank',
      popup.seams(runner.seams),
    );
    popup.initial = blank;
    // nothing to wait for: `window.open` hands it back complete
    void blank.parsed();
    blank.loaded();
    return slot.id;
  };
  return {
    open,
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
      slotById(id)?.navigate(url, replace ? 'replace' : 'here', null);
    },
    named(name) {
      // a tab's name outlives its document; a frame's is its element's
      if (!runner.frame) slotOf(runner).name = name;
    },
    disown() {
      if (runner.slot) runner.slot.opener = null;
    },
    reached(id) {
      const there = slotById(id)?.runner;
      if (there) runner.engine.reached(there.engine);
    },
    openerOf: (id) => slotById(id)?.opener?.id ?? 0,
    lengthOf: (id) => slotById(id)?.runner?.host.frames().length ?? 0,
    follow(url, target, noopener, noreferrer, post) {
      if (!runner.seams.popups) return false;
      const there = find(target);
      if (there) {
        there.navigate(url, 'here', post);
        return true;
      }
      if (noopener) return false;
      if (
        !runner.seams.popups.unblocked &&
        runner.engine.call('__windowActivation', null) !== true
      ) {
        runner.seams.popups.blocked?.(url);
        return true;
      }
      const name = target.toLowerCase() === '_blank' ? '' : target;
      return !!open({
        url,
        name,
        features: { popup: false, noreferrer },
        post,
      });
    },
  };
}
