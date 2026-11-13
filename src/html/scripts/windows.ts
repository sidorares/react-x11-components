// The page's other top-level windows, as its scripts reach them: `window.open`,
// `opener`, `close()`, `closed`, `focus()` and the WindowProxy each of those
// hands out (HTML 7.2).
//
// **This function is source text**, as `installDom` is (`dom.ts`).
//
// A window here is a number, its slot's in the host (`./popups.ts`), which
// outlives every document the window shows. What a realm holds for another
// window is a proxy over that number: the window's global where it is of this
// realm's origin, what crosses origins where it is not, and what is left of a
// window where it has gone. So what a page keeps goes on working as the window
// moves from one origin to another and back, which is the whole of a popup
// login: the opener holds the same object through the provider's pages and
// reads `location.href` again once the popup is back on its own origin.
//
// Windows of one group and one origin hold each other's globals, as a frame
// and its page do (`ScriptEngine.link`). Of two origins they hold a number and
// nothing else, and what crosses goes through the host. That is the whole of
// what keeps them apart: this runs in the page's realm, where a page can
// replace what it calls, so a global `links` held would be a global it has,
// however it was checked on the way out. The host decides which it is
// (`WindowSlot.adopt`), and tells a realm which window it may reach.

/** What `installDom` hands this. */
export interface WindowDeps {
  G: any;
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): any;
  /** What the host left in the global's handed slot. */
  handed(): any;
  str(value: unknown): string;
  DOMException: any;
  /** The realm's activation (HTML 6.4.1). */
  hasTransientActivation(): boolean;
  consumeActivation(): void;
  /** A message to another realm's global, from `from` as that one calls
   *  this one, to `name` as this one calls it. */
  deliverInto(
    global: any,
    from: number,
    name: number,
  ): (message: any, options?: any, transfer?: any) => void;
  /** A message to a realm of another origin, by its name here. */
  postAcross(
    name: number,
  ): (message: any, options?: any, transfer?: any) => void;
  /** A WindowProxy over what `spec` says (`frameProxyOf`'s). */
  windowProxy(spec: {
    current(): any;
    across(): any;
    post(): any;
    closed(): boolean;
    /** What a same-origin read comes to in this realm. */
    seen(key: PropertyKey, value: any, win: any): any;
    /** Whether a read of what is not there is `undefined`, and no
     *  `SecurityError`. */
    quiet(): boolean;
  }): any;
  /** The window a name's frame is, sent to `href` where there is one: this
   *  document's, or null. */
  openInFrame(name: string, href: string | null, noopener: boolean): any;
  /** This window sent to `href`. */
  openHere(href: string, name: string): void;
  /** The page's document was asked of what it has left to run: true while
   *  it unloads, when `window.open` answers null (HTML 7.2.2.1). */
  unloading(): boolean;
  windowTarget: any;
  /** The window's name, as `window.name` reads it. */
  windowName(): string;
  setWindowName(name: string): void;
  /** A timer of the facade's own. */
  setTimer(
    fn: () => void,
    ms: number,
    args: unknown[],
    repeat: boolean,
  ): unknown;
}

/** What `installDom` has of this. */
export interface WindowInternals {
  open(url: unknown, target: unknown, features: unknown): unknown;
  close(): void;
  focus(): void;
  /** Whether this window has closed, or is closing. */
  closed(): boolean;
  /** The proxy of a window of this one's group, or null. */
  proxyOf(id: number): unknown;
  /** The port's way to another window (`realmAcross`). */
  send(id: number, text: string): void;
  /** A window's name was set from the page. */
  named(name: string): void;
  /** Whether this realm's document is the `about:blank` a window opened
   *  with, which a page writes into as it writes into one of its own. */
  blank(): boolean;
  /** `document.write`, into that document. */
  write(document: unknown, text: string): void;
  /** `document.close`, of that document. */
  wrote(document: unknown): void;
  /** A link goes to a target that is no frame: whether that was seen to. */
  follow(
    href: string,
    target: string,
    rel: string,
    userInitiated: boolean,
  ): boolean;
  /** Where this window's features put it, across or down. */
  screen(across: boolean): number;
  /** A frame's window's bars, which it has as long as it is in a document. */
  bars(win: unknown, shown: () => boolean): void;
}

export function installWindows(deps: WindowDeps): WindowInternals {
  'use strict';
  type Any = any;
  const { G, call, entry, input, handed, str, DOMException } = deps;
  /** The properties that read as a window. */
  const SELF_NAMED = ['opener', 'parent', 'top', 'window', 'self', 'frames'];

  /** This window's number, once it has one (`__windowSelf`). A window that
   *  never opened one and was opened by none is in no group, and has none. */
  let selfId = 0;
  let openerId = 0;
  /** Whether this window was asked for as a popup (HTML, "is popup"), which
   *  its bars say. */
  let isPopup = false;
  /** Whether the document is the `about:blank` this window opened with. */
  let isBlank = false;
  /** Where its features put it on the screen. */
  let screenLeft = 0;
  let screenTop = 0;
  /** Each other window's global, while it has a document of this realm's
   *  origin, and only then (`WindowSlot.adopt`). */
  const links = new Map<number, Any>();
  /** The windows whose document this realm's scripts have reached. */
  const touched = new Set<number>();
  const proxies = new Map<number, Any>();
  /** Each proxy's number, for a window read through another realm: the one
   *  object a page compares (`seen`). */
  const proxied = new WeakMap<object, number>();
  /** The windows closing or closed, whose `closed` is true from the moment
   *  `close()` is called, and those discarded. */
  const closing = new Set<number>();
  const gone = new Set<number>();

  const blocked = (): Any =>
    new DOMException(
      `Blocked a frame with origin "${G.__origin()}" from accessing a cross-origin frame.`,
      'SecurityError',
    );

  /** What a window is called in this realm: `G` for itself. */
  const windowOf = (id: number): Any =>
    !id ? null : id === selfId ? G : proxyOf(id);

  /** A window's `location` from another origin: to send it elsewhere, and
   *  nothing to read (HTML 7.2.3.1). */
  const locations = new Map<number, Any>();
  const locationOf = (id: number): Any => {
    let location = locations.get(id);
    if (location) return location;
    const go = (url: Any, replace: boolean): void => {
      call('windowNavigate', id, str(url), replace);
    };
    location = new Proxy(
      {},
      {
        get(_t, key) {
          if (key === 'replace') return (url: Any) => go(url, true);
          if (key === 'then' || typeof key === 'symbol') return undefined;
          throw blocked();
        },
        set(_t, key, value) {
          if (key !== 'href') throw blocked();
          go(value, false);
          return true;
        },
      },
    );
    locations.set(id, location);
    return location;
  };

  /** What may be reached of a window of another origin (HTML 7.2.3.1,
   *  CrossOriginProperties), which is what is left of one that has gone. */
  const crossWindow = (id: number, proxy: () => Any): Any => ({
    get window() {
      return proxy();
    },
    get self() {
      return proxy();
    },
    get frames() {
      return proxy();
    },
    get location() {
      return locationOf(id);
    },
    set location(v: Any) {
      locationOf(id).href = v;
    },
    get parent() {
      return gone.has(id) ? null : proxy();
    },
    get top() {
      return gone.has(id) ? null : proxy();
    },
    get opener() {
      return gone.has(id) ? null : windowOf(Number(call('windowOpener', id)));
    },
    get closed() {
      return closing.has(id);
    },
    get length() {
      return gone.has(id) ? 0 : Number(call('windowLength', id));
    },
    close() {
      call('windowClose', id);
    },
    focus() {
      call('windowFocus', id);
    },
    blur() {},
    // nothing to hear it, as a window that has gone has nothing
    postMessage() {},
  });

  const proxyOf = (id: number): Any => {
    let proxy = proxies.get(id);
    if (proxy) return proxy;
    const held = (): Any => links.get(id) ?? null;
    let cross: Any = null;
    proxy = deps.windowProxy({
      current() {
        const global = held();
        if (!global) return null;
        if (!touched.has(id)) {
          touched.add(id);
          call('windowReached', id);
        }
        return global;
      },
      across: () => (cross ??= crossWindow(id, () => proxy)),
      post() {
        const global = held();
        return global
          ? deps.deliverInto(global, -selfId, -id)
          : deps.postAcross(-id);
      },
      closed: () => closing.has(id),
      // a window reads as this realm's name for it: one object for a window,
      // which `popup.opener === window` compares, and never another realm's
      seen(key, value, win) {
        if (
          typeof key !== 'string' ||
          !SELF_NAMED.includes(key) ||
          typeof value !== 'object' ||
          value === null
        ) {
          return value;
        }
        if (value === win) return proxy;
        const number = Number(win.__windowId(value));
        return number ? windowOf(number) : value;
      },
      quiet: () => gone.has(id),
    });
    proxies.set(id, proxy);
    proxied.set(proxy, id);
    return proxy;
  };

  /** This window's opener, as the getter reads it. */
  const openerNow = (): Any => (openerId ? windowOf(openerId) : null);

  // `opener` is an accessor a page may replace, and whose setter with null
  // disowns the window (HTML 7.2.2.2). What it reads goes by what it was
  // called on: Web IDL's getter on another window is that window's.
  Object.defineProperty(G, 'opener', {
    get(this: Any) {
      const id = this && this !== G ? proxied.get(this) : 0;
      const global = id ? links.get(id) : null;
      if (!global) return openerNow();
      const number = Number(global.__openerId());
      return number ? windowOf(number) : null;
    },
    set(value: Any) {
      if (value === null) {
        openerId = 0;
        call('windowDisown');
        return;
      }
      Object.defineProperty(G, 'opener', {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
    configurable: true,
    enumerable: true,
  });

  // the numbers of the windows a realm holds, which another realm reads a
  // window of this one by (`seen`)
  const hidden = (name: string, value: Any): void => {
    Object.defineProperty(G, name, {
      value,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  };
  hidden('__windowId', (value: Any): number =>
    value === G ? selfId : (proxied.get(value) ?? 0),
  );
  hidden('__openerId', (): number => openerId);
  hidden('__global', G);

  /** Send a window up this one's frames somewhere. A page's script does that
   *  through its `location`, which the host cannot see from here, and a local
   *  document there takes its policy from this one (`WindowSlot.initiator`). */
  const sendUp = (win: Any, href: string): void => {
    if (win === G.top) call('windowInitiates', 0);
    win.location.href = href;
  };

  /**
   * The navigable a target names (HTML 7.3.1.7): this window, its parent or
   * its top; a frame of its document; a window of its group; or none, which
   * is a new one. `noopener` does not keep a name from finding what it names:
   * it only keeps the window from being handed back.
   */
  const named = (
    target: string,
    href: string | null,
    noopener: boolean,
  ): Any => {
    const keyword = target.toLowerCase();
    if (keyword === '_self' || (target && target === deps.windowName())) {
      if (href) deps.openHere(href, '_self');
      return G;
    }
    if (keyword === '_parent' || keyword === '_top') {
      const win = keyword === '_top' ? G.top : G.parent;
      if (win === G) {
        if (href) deps.openHere(href, '_self');
      } else if (href) sendUp(win, href);
      return win;
    }
    const framed = deps.openInFrame(target, href, noopener);
    if (framed) return framed;
    const id = Number(call('windowFind', target));
    if (!id) return null;
    const win = windowOf(id);
    if (href) {
      call('windowInitiates', id);
      win.location.href = href;
    }
    return win;
  };

  const open = (url: Any, target: Any, features: Any): Any => {
    if (deps.unloading()) return null;
    const written = url === undefined || url === null ? '' : str(url);
    let href: string | null = null;
    if (written !== '') {
      const base = str(call('windowBase'));
      try {
        href = new G.URL(written, base).href;
      } catch {
        throw new DOMException(
          `Unable to open a window with invalid URL '${written}'.`,
          'SyntaxError',
        );
      }
    }
    const given = target === undefined || target === null ? '' : str(target);
    const name = given === '' ? '_blank' : given;
    const read = JSON.parse(
      str(call('windowFeatures', features === undefined ? '' : str(features))),
    );
    if (name.toLowerCase() !== '_blank') {
      const found = named(name, href, read.noopener);
      // `noopener` hides what a name found, and not what a keyword did,
      // which the page has anyway
      if (found) return read.noopener && !name.startsWith('_') ? null : found;
    }
    const to = href ?? 'about:blank';
    if (read.noopener) {
      call('windowTab', to, read.noreferrer, name);
      return null;
    }
    const seam = str(call('windowPopups'));
    if (seam === 'sandboxed') return null;
    if (seam === 'none') {
      // no host to say where a window goes: a tab, and no window to hand
      // back, as with no seam it always was
      if (href) call('open', href, name);
      return null;
    }
    if (seam === 'gesture' && !deps.hasTransientActivation()) {
      call('windowBlocked', to);
      return null;
    }
    deps.consumeActivation();
    return windowOf(
      Number(
        call(
          'windowOpen',
          JSON.stringify({
            url: to,
            name: name.toLowerCase() === '_blank' ? '' : name,
            features: read,
          }),
        ),
      ),
    );
  };

  // the bars a window has, which a popup has none of (HTML 7.2.2.2)
  const BAR_SHOWN = new WeakMap<object, () => boolean>();
  class BarProp {
    get visible(): boolean {
      return !!BAR_SHOWN.get(this)?.();
    }
  }
  Object.defineProperty(G, 'BarProp', {
    value: BarProp,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  const barsOn = (win: Any, shown: () => boolean): void => {
    for (const name of [
      'locationbar',
      'menubar',
      'personalbar',
      'scrollbars',
      'statusbar',
      'toolbar',
    ]) {
      const bar = new BarProp();
      BAR_SHOWN.set(bar, shown);
      // `[Replaceable]`: an accessor whose setter puts what it is set to in
      // its place (Web IDL 3.7.6)
      Object.defineProperty(win, name, {
        get: () => bar,
        set(value: Any) {
          Object.defineProperty(win, name, {
            value,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        },
        configurable: true,
        enumerable: true,
      });
    }
  };
  barsOn(G, () => !isPopup && !gone.has(selfId));

  /** What this realm's global held before any page code ran: what a page
   *  put on it after that is what a window reused keeps. */
  let baseline: Set<string> | null = null;

  entry('__windowSelf', () => {
    const [id, opener, name, popup, blank, left, top] = input();
    selfId = Number(id);
    openerId = Number(opener);
    isPopup = !!popup;
    screenLeft = Number(left) || 0;
    screenTop = Number(top) || 0;
    if (typeof name === 'string') deps.setWindowName(name);
    isBlank = !!blank;
    if (blank) baseline = new Set(Object.getOwnPropertyNames(G));
    return deps.windowName();
  });
  entry('__linkWindow', () => {
    const [id] = input();
    links.set(Number(id), handed());
    touched.delete(Number(id));
    return true;
  });
  // its document went, and the next is yet to come, or it was discarded
  entry('__unlinkWindow', () => {
    const [id, discarded] = input();
    links.delete(Number(id));
    if (discarded) {
      closing.add(Number(id));
      gone.add(Number(id));
    }
    if (discarded && Number(id) === openerId) openerId = 0;
    return true;
  });
  entry('__windowClosing', () => {
    const [id] = input();
    closing.add(Number(id));
    return true;
  });
  // the name its frame gives a frame's window, as its document starts
  entry('__windowNamed', () => {
    const [name] = input();
    deps.setWindowName(str(name));
    return true;
  });
  // a press or a key is behind what a link did, and it is spent
  entry('__windowActivation', () => {
    const had = deps.hasTransientActivation();
    deps.consumeActivation();
    return had;
  });
  // the window this realm's document took the place of was its initial
  // `about:blank`, of this origin: this one is that window (HTML 7.4.6.2,
  // "initialize the document object"), and has what a page put on it
  entry('__reuseWindow', () => {
    const kept = handed().__windowKept();
    for (const name of kept.names as string[]) {
      Object.defineProperty(
        G,
        name,
        Object.getOwnPropertyDescriptor(
          kept.global,
          name,
        ) as PropertyDescriptor,
      );
    }
    const target = deps.windowTarget;
    Object.assign(target._listeners, kept.listeners);
    Object.assign(target._handlers, kept.handlers);
    return true;
  });
  hidden('__windowKept', (): Any => ({
    global: G,
    names: Object.getOwnPropertyNames(G).filter((n) => !baseline?.has(n)),
    listeners: deps.windowTarget._listeners,
    handlers: deps.windowTarget._handlers,
  }));

  return {
    open,
    close() {
      if (!closing.has(selfId)) call('windowClose', 0);
    },
    focus() {
      call('windowFocus', 0);
    },
    closed: () => closing.has(selfId),
    proxyOf: windowOf,
    send(id, text) {
      const global = links.get(id);
      if (global) global.__wire(-selfId, text);
      else call('realmWire', -id, text);
    },
    named(name) {
      call('windowName', name);
    },
    blank: () => isBlank,
    follow(href, target, rel, userInitiated) {
      const keyword = target.toLowerCase();
      if (keyword === '_parent' || keyword === '_top') {
        const win = keyword === '_top' ? G.top : G.parent;
        if (win === G) return false;
        sendUp(win, href);
        return true;
      }
      if (call('windowFollow', href, target, rel) === true) return true;
      // a link a script clicked has no point for the host to find it by, so
      // a new tab is asked for here
      if (userInitiated) return false;
      call('windowTab', href, false, target);
      return true;
    },
    screen: (across) => (across ? screenLeft : screenTop),
    bars: barsOn,
    // HTML's parser has what was written as it is written, so a page reads
    // it straight back; a script in it runs once the page has done writing,
    // at `close()` or the end of its task, and once
    write(document: Any, text) {
      const open = document._written != null;
      document._written = (document._written ?? '') + text;
      call('writeWindow', document._written, false);
      if (!open) {
        deps.setTimer(() => this.wrote(document), 0, [], false);
      }
    },
    wrote(document: Any) {
      if (document._written == null) return;
      const markup = document._written;
      document._written = null;
      call('writeWindow', markup, true);
    },
  };
}
