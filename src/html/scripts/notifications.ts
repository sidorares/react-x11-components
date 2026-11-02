// The Notifications API as a page's scripts see it: `Notification`, in a
// window and a worker alike (Notifications API, 2).
//
// **This function is source text**, as `installDom` is (`dom.ts`).
//
// What a page asks goes to the host's `scripts.notifications` through the
// `notification` op and is told back through `__notification`, under the
// number the page's object goes by. What crosses is a JSON string of text and
// numbers: `data` stays in the realm, since nothing outside it reads what a
// page keeps on its own object. What a page holds is made here.
//
// `Notification` is there whether or not the host has anything to show one
// with, as it is in a browser whose user said no: `permission` says `denied`,
// and one that is made fires `error`. A page asks for it by its constructor,
// and `in` would tell it nothing about what it may do.
//
// A request for the permission reads the realm's activation: with no press or
// key behind it, nothing is asked and a page hears what it had, as Firefox and
// Safari have it. Chrome asks and leaves the prompt small. A page that can ask
// on load asks every reader before they have done anything.

/** What `installDom` hands this. */
export interface NotificationDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  EventTarget: unknown;
  Event: unknown;
  /** Make a page's accessors its interface's own, as Web IDL has them. */
  idlAttributes(target: unknown): void;
  /** Make `on<type>` a handler of an interface's. */
  handlerProperty(proto: unknown, type: string): void;
  /** Queue a task. */
  task(fn: () => void): void;
  /** Hand an exception of a callback's to the page's `error`. */
  report(error: unknown): void;
  /** A URL against the document's base, or null where it is none. */
  resolve(url: string): string | null;
  /** A page's value, copied as `postMessage` would. */
  clone(value: unknown): unknown;
  /** Whether a press or a key of the user's is behind this. */
  hasTransientActivation(): boolean;
  /** Whether this realm is a service worker's, which makes none itself. */
  inServiceWorker(): boolean;
  /** Where the page's `notifications` permission stands. */
  permission(): string;
  /** Whether a registration has no worker to answer for what it shows. */
  noWorker(registration: unknown): boolean;
  /** Tell this realm's service worker of a registration's notification,
   *  and say whether it was there to hear. */
  workerEvent(type: string, notification: unknown, action: string): boolean;
}

/** What `installDom` has of this. */
export interface NotificationInternals {
  Notification: unknown;
  /** `showNotification()`, on a registration. */
  showFor(registration: unknown, title: unknown, options: unknown): unknown;
  /** `getNotifications()`, on a registration. */
  listFor(registration: unknown, filter: unknown): unknown;
  /** A registration has gone, and what it showed with it. */
  forget(registration: unknown): void;
}

export function installNotifications(
  deps: NotificationDeps,
): NotificationInternals {
  type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const {
    call,
    entry,
    input,
    idlAttributes,
    handlerProperty,
    task,
    report,
    resolve,
    clone,
    hasTransientActivation,
    inServiceWorker,
  } = deps;
  const EventTargetClass = deps.EventTarget as Any;
  const EventClass = deps.Event as Any;
  const P = Promise;
  const Canonical = Intl.getCanonicalLocales;

  /** `permission`'s word for where the `notifications` permission stands. */
  const word = (state: string): string =>
    state === 'prompt' ? 'default' : state;

  /** Whether the constructor is this file's own, which shows nothing. */
  let making = false;
  /** Each that a page made and that has not gone, by its number. */
  const live = new Map<number, Any>();
  /** The one showing under each tag. */
  const tagged = new Map<string, Any>();
  let nextId = 1;

  const DIRECTIONS = new Set(['auto', 'ltr', 'rtl']);
  /** As many actions as Chrome's notifications show. */
  const MAX_ACTIONS = 2;
  const toLong = (value: Any): number => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) ? n >>> 0 : 0;
  };
  /** A language tag that is one, or nothing: a tag no language can have is
   *  not handed on (Notifications API, "language"). */
  const languageOf = (tag: string): string => {
    if (!/^[a-z]{2,3}(-|$)/i.test(tag)) return '';
    try {
      Canonical(tag);
      return tag;
    } catch {
      return '';
    }
  };
  const urlOf = (value: Any): string => resolve(`${value}`) ?? '';
  const urlMember = (value: Any): string =>
    value === undefined ? '' : urlOf(value);

  /** `NotificationOptions`, read in the order Web IDL reads a dictionary. */
  const optionsOf = (given: Any): Any => {
    if (
      given !== undefined &&
      given !== null &&
      typeof given !== 'object' &&
      typeof given !== 'function'
    ) {
      throw new TypeError(
        "Failed to construct 'Notification': The provided value is not of type 'NotificationOptions'.",
      );
    }
    const o = given ?? {};
    const actions: Any[] = (
      o.actions === undefined ? [] : Array.from(o.actions as Iterable<Any>)
    )
      .slice(0, MAX_ACTIONS)
      .map((entry: Any) => {
        const action = `${entry.action}`;
        const title = `${entry.title}`;
        const icon = entry.icon === undefined ? '' : urlOf(entry.icon);
        return Object.freeze({ action, title, icon });
      });
    const badge = urlMember(o.badge);
    const body = o.body === undefined ? '' : `${o.body}`;
    const data = o.data === undefined ? null : o.data;
    const dir = o.dir === undefined ? 'auto' : `${o.dir}`;
    if (!DIRECTIONS.has(dir)) {
      throw new TypeError(
        `Failed to construct 'Notification': The provided value '${dir}' is not a valid enum value of type NotificationDirection.`,
      );
    }
    const icon = urlMember(o.icon);
    const image = urlMember(o.image);
    const lang = o.lang === undefined ? '' : `${o.lang}`;
    const navigate = o.navigate;
    const renotify = !!o.renotify;
    const requireInteraction = !!o.requireInteraction;
    const silent =
      o.silent === undefined || o.silent === null ? null : !!o.silent;
    const tag = o.tag === undefined ? '' : `${o.tag}`;
    const timestamp =
      o.timestamp === undefined ? Date.now() : toLong(o.timestamp);
    if (renotify && !tag) {
      throw new TypeError(
        "Failed to construct 'Notification': Notifications which set the renotify flag must specify a non-empty tag.",
      );
    }
    let navigateTo = '';
    if (navigate !== undefined) {
      const url = resolve(`${navigate}`);
      if (url === null) {
        throw new TypeError(
          `Failed to construct 'Notification': The URL '${navigate}' is invalid.`,
        );
      }
      navigateTo = url;
    }
    return {
      actions,
      badge,
      body,
      data: clone(data),
      frozenActions: Object.freeze(actions),
      dir,
      icon,
      image,
      lang: languageOf(lang),
      navigate: navigateTo,
      renotify,
      requireInteraction,
      silent,
      tag,
      timestamp,
    };
  };

  /** What is left of one that has gone: it is told `close` once. */
  const gone = (n: Any): void => {
    live.delete(n._id);
    if (n._o.tag && tagged.get(n._o.tag) === n) tagged.delete(n._o.tag);
    n._state = 'closed';
    // what waits on one replaced before it was shown has its answer
    n._shown?.done();
    const list = n._registration && listed.get(n._registration);
    if (list) {
      const at = list.indexOf(n);
      if (at >= 0) list.splice(at, 1);
    }
  };
  const fire = (n: Any, type: string, cancelable = false): boolean =>
    n.dispatchEvent(new EventClass(type, { cancelable }));
  /** A registration's are told in its worker, and its object hears nothing. */
  const heardClose = (n: Any): void => {
    if (n._registration) deps.workerEvent('notificationclose', n, '');
    else fire(n, 'close');
  };

  class Notification extends EventTargetClass {
    _o: Any = null;
    _title = '';
    _id = 0;
    /** `pending` until it is on its way to the host, then `showing`, and
     *  `closed` from when a page or the host took it down. */
    _state = 'pending';
    /** The one a copy from `getNotifications()` stands for. */
    _of: Any = null;
    /** Where it is a registration's: what it is listed under, and what its
     *  `showNotification()` is waiting on. */
    _registration: Any = null;
    _shown: Any = null;
    // one argument, which is what its `length` says (Web IDL 3.7.1)
    constructor(title: Any) {
      if (arguments.length < 1) {
        throw new TypeError(
          "Failed to construct 'Notification': 1 argument required, but only 0 present.",
        );
      }
      super();
      if (making) return;
      if (inServiceWorker()) {
        throw new TypeError(
          "Failed to construct 'Notification': Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.",
        );
      }
      const name = `${title}`;
      const o = optionsOf(arguments[1]);
      if (o.actions.length) {
        throw new TypeError(
          "Failed to construct 'Notification': Actions are only supported for persistent notifications shown using ServiceWorkerRegistration.showNotification().",
        );
      }
      this._title = name;
      this._o = o;
      this._id = nextId;
      nextId += 1;
      live.set(this._id, this);
      task(() => this._show());
    }
    _show(): void {
      if (this._state === 'closed') return;
      if (deps.permission() !== 'granted') {
        gone(this);
        fire(this, 'error');
        return;
      }
      this._send();
    }
    /** To the host. One of the tag is replaced: told it went, then this
     *  shown. */
    _send(): void {
      const o = this._o;
      const old = o.tag ? tagged.get(o.tag) : null;
      if (old) {
        old._take();
        heardClose(old);
      }
      if (o.tag) tagged.set(o.tag, this);
      this._state = 'showing';
      call(
        'notification',
        'show',
        this._id,
        JSON.stringify({
          title: this._title,
          body: o.body,
          tag: o.tag,
          icon: o.icon,
          image: o.image,
          badge: o.badge,
          lang: o.lang,
          dir: o.dir,
          silent: o.silent,
          requireInteraction: o.requireInteraction,
          renotify: o.renotify,
          timestamp: o.timestamp,
        }),
      );
    }
    /** Take it down. */
    _take(): void {
      const shown = this._state === 'showing';
      gone(this);
      if (shown) call('notification', 'close', this._id);
    }
    close(): void {
      const own = this._of ?? this;
      if (own._state === 'closed') return;
      own._take();
      task(() => heardClose(own));
    }
    static get permission(): string {
      return word(deps.permission());
    }
    static get maxActions(): number {
      return MAX_ACTIONS;
    }
    static requestPermission(): Any {
      const deprecatedCallback = arguments[0];
      if (
        deprecatedCallback !== undefined &&
        typeof deprecatedCallback !== 'function'
      ) {
        return P.reject(
          new TypeError(
            "Failed to execute 'requestPermission' on 'Notification': The callback provided as parameter 1 is not a function.",
          ),
        );
      }
      return new P((done: Any) => {
        const answer = (state: string): void => {
          const said = word(state);
          if (deprecatedCallback) {
            try {
              deprecatedCallback(said);
            } catch (error) {
              report(error);
            }
          }
          done(said);
        };
        const now = deps.permission();
        if (now !== 'prompt' || !hasTransientActivation()) {
          task(() => answer(now));
          return;
        }
        const id = nextAsk;
        nextAsk += 1;
        asked.set(id, answer);
        call('permissionAsk', id, 'notifications');
      });
    }
    get navigate(): string {
      return this._o.navigate;
    }
    get title(): string {
      return this._title;
    }
    get dir(): string {
      return this._o.dir;
    }
    get lang(): string {
      return this._o.lang;
    }
    get body(): string {
      return this._o.body;
    }
    get tag(): string {
      return this._o.tag;
    }
    get image(): string {
      return this._o.image;
    }
    get icon(): string {
      return this._o.icon;
    }
    get badge(): string {
      return this._o.badge;
    }
    get timestamp(): number {
      return this._o.timestamp;
    }
    get renotify(): boolean {
      return this._o.renotify;
    }
    get silent(): boolean | null {
      return this._o.silent;
    }
    get requireInteraction(): boolean {
      return this._o.requireInteraction;
    }
    get data(): Any {
      return this._o.data;
    }
    get actions(): Any {
      return this._o.frozenActions;
    }
  }
  idlAttributes(Notification);
  for (const type of ['click', 'show', 'error', 'close']) {
    handlerProperty(Notification.prototype, type);
  }
  Object.defineProperty(Notification.prototype, 'close', { enumerable: true });
  Object.defineProperty(Notification, 'requestPermission', {
    enumerable: true,
  });

  /** A registration's notifications that are showing. */
  const listed = new WeakMap<object, Any[]>();

  /** `ServiceWorkerRegistration.showNotification()`, or the `getNotifications()`
   *  beside it (Notifications API, 5). */
  const showFor = (registration: Any, title: Any, options: Any): Any =>
    new P((done: Any, refuse: Any) => {
      if (deps.noWorker(registration)) {
        throw new TypeError(
          "Failed to execute 'showNotification' on 'ServiceWorkerRegistration': No active registration available on the ServiceWorkerRegistration.",
        );
      }
      const o = optionsOf(options);
      if (deps.permission() !== 'granted') {
        throw new TypeError(
          "Failed to execute 'showNotification' on 'ServiceWorkerRegistration': No notification permission has been granted for this origin.",
        );
      }
      making = true;
      let n: Any;
      try {
        n = new (Notification as Any)('');
      } finally {
        making = false;
      }
      n._title = `${title}`;
      n._o = o;
      n._id = nextId;
      nextId += 1;
      n._registration = registration;
      n._shown = { done, refuse };
      live.set(n._id, n);
      const list = listed.get(registration) ?? [];
      listed.set(registration, list);
      list.push(n);
      n._send();
    });
  /** Each that a registration has showing, as a new object. */
  const listFor = (registration: Any, filter: Any): Any => {
    const tag = filter?.tag === undefined ? '' : `${filter.tag}`;
    return P.resolve(
      (listed.get(registration) ?? [])
        .filter((n: Any) => !tag || n._o.tag === tag)
        .map((n: Any) => {
          making = true;
          try {
            const copy = new (Notification as Any)('');
            copy._title = n._title;
            copy._o = n._o;
            copy._id = n._id;
            copy._of = n;
            copy._state = n._state;
            return copy;
          } finally {
            making = false;
          }
        }),
    );
  };

  const asked = new Map<number, (state: string) => void>();
  let nextAsk = 1;
  entry('__permissionAsked', () => {
    const [id, state] = input() as Any[];
    const waiting = asked.get(id);
    if (!waiting) return false;
    asked.delete(id);
    waiting(`${state}`);
    return true;
  });
  entry('__notification', () => {
    const [id, what] = input() as Any[];
    const n = live.get(id);
    if (!n) return false;
    const persistent = !!n._registration;
    if (what === 'show') {
      if (persistent) n._shown.done();
      else fire(n, 'show');
    } else if (what === 'click') {
      if (persistent) {
        if (!deps.workerEvent('notificationclick', n, '')) {
          call('notification', 'focus', id);
        }
      } else if (fire(n, 'click', true)) {
        call('notification', 'focus', id);
      }
    } else if (what === 'close') {
      gone(n);
      heardClose(n);
    } else if (what === 'error') {
      gone(n);
      if (persistent) {
        n._shown.refuse(
          new TypeError(
            "Failed to execute 'showNotification' on 'ServiceWorkerRegistration': The notification could not be shown.",
          ),
        );
      } else fire(n, 'error');
    }
    return true;
  });
  return {
    Notification,
    showFor,
    listFor,
    forget: (registration: Any) => {
      for (const n of [...(listed.get(registration) ?? [])]) n._take();
    },
  };
}
