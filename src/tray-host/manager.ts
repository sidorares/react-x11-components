// The manager selection, and everything that arrives because of it.
//
// A tray host is three things on the wire: it owns `_NET_SYSTEM_TRAY_S<n>`,
// it publishes two properties saying how it wants to be drawn into, and it
// answers `_NET_SYSTEM_TRAY_OPCODE` messages addressed to the window that
// owns that selection. None of it is React-shaped, so none of it is in the
// component — `./index.ts` owns the icon list as state and this owns the
// protocol that changes it.
//
// ### Two things core does not quite give this, and neither blocks it
//
// **There is no `<window onClientMessage>`.** The opcodes arrive as
// ClientMessages addressed to the manager window, so this listens on
// `X.on('event')` and filters by `ev.wid` — which is what core's own
// `src/xsettings.js` does internally for the same reason. A global listener
// doing a per-window job; it works, and every EWMH-adjacent protocol wants
// the same seam.
//
// **`src/inputtime.js` is not exported.** Core already tracks the server
// timestamp of the last input event, precisely because a selection must not
// be taken with `CurrentTime` (ICCCM 2.1). Outside core it has to be
// re-derived, which is what `#serverTime()` below does.
import { startTimeout, stopTimeout } from './timers.js';
import {
  BalloonAssembler,
  MANAGER_ATOM,
  MESSAGE_DATA_ATOM,
  OPCODE_ATOM,
  ORIENTATION_ATOM,
  SYSTEM_TRAY_BEGIN_MESSAGE,
  SYSTEM_TRAY_CANCEL_MESSAGE,
  SYSTEM_TRAY_REQUEST_DOCK,
  VISUAL_ATOM,
  argbVisualOf,
  orientationValue,
  selectionNameFor,
} from './protocol.js';
import type { TrayIcon, TrayMessage, TrayOrientation } from './protocol.js';

// Core event codes and masks, written out for the same reason
// `src/xsettings.js` writes them out: they are protocol constants, and
// naming them here is cheaper than reaching into node-x11 for a number that
// has not changed since 1987.
const PROPERTY_NOTIFY = 28;
const SELECTION_CLEAR = 29;
const CLIENT_MESSAGE = 33;
const PROPERTY_CHANGE_MASK = 4194304; // x11.eventMask.PropertyChange
const STRUCTURE_NOTIFY_MASK = 131072; // x11.eventMask.StructureNotify
const INPUT_ONLY = 2;
/** Predefined atoms — no InternAtom round trip for these. */
const XA_CARDINAL = 6;
const XA_STRING = 31;
const XA_VISUALID = 32;

/** How long `#serverTime()` waits for its PropertyNotify before giving up
 *  and letting the server stamp the request itself. */
const TIMESTAMP_TIMEOUT = 2000;

/**
 * Where a tray host is in its life.
 *
 * `'conflict'` and `'unavailable'` are both ordinary states of a healthy
 * machine rather than failures — a second panel on one display is a
 * configuration mistake, and a connection with no raw protocol access (a
 * headless mock) simply has no tray to be. Same call `<Terminal>` makes
 * about a machine with no emulator installed.
 */
export type TrayStatus =
  'starting' | 'owned' | 'conflict' | 'released' | 'unavailable';

/** Somebody else is the tray. */
export interface TrayConflict {
  /** The X window that owns `_NET_SYSTEM_TRAY_S<screen>`. */
  owner: number;
  screen: number;
}

/** What the component wires up. Every one is optional; the manager runs
 *  whether or not anybody is listening. */
export interface TrayManagerHandlers {
  /** The whole list, whenever it changes — what the component renders. */
  onIcons?(icons: readonly TrayIcon[]): void;
  onDock?(icon: TrayIcon): void;
  onUndock?(icon: TrayIcon): void;
  onStatus?(status: TrayStatus, conflict: TrayConflict | null): void;
  onMessage?(message: TrayMessage): void;
  onCancelMessage?(info: { windowId: number; id: number }): void;
  onError?(err: Error): void;
}

/** The slice of the X connection this needs. `useApp()` is declared
 *  `unknown` in core — it is the escape hatch, so the shape is written out
 *  rather than imported. */
interface XEvent {
  type: number;
  wid?: number;
  atom?: number;
  time?: number;
  owner?: number;
  selection?: number;
  format?: number;
  message_type?: number;
  data?: number[];
}

interface XConnection {
  AllocID(): number;
  InternAtom(
    onlyIfExists: boolean,
    name: string,
    cb: (err: Error | null, atom: number) => void,
  ): void;
  CreateWindow(
    id: number,
    parent: number,
    x: number,
    y: number,
    width: number,
    height: number,
    borderWidth: number,
    depth: number,
    klass: number,
    visual: number,
    values: Record<string, unknown>,
  ): void;
  DestroyWindow(id: number): void;
  ChangeProperty(
    mode: number,
    wid: number,
    name: number,
    type: number,
    format: number,
    data: readonly number[],
  ): void;
  GetSelectionOwner(
    atom: number,
    cb: (err: Error | null, owner: number) => void,
  ): void;
  SetSelectionOwner(owner: number, atom: number, time: number): void;
  GetWindowAttributes(
    wid: number,
    cb: (err: Error | null, attrs: { visual: number }) => void,
  ): void;
  SendEvent(
    destination: number,
    propagate: number,
    eventMask: number,
    event: Record<string, unknown>,
  ): void;
  on(name: 'event', fn: (ev: XEvent) => void): void;
  removeListener?(name: 'event', fn: (ev: XEvent) => void): void;
}

/** What ntk's app exposes that a tray needs. */
export interface TrayApp {
  X?: XConnection;
  display?: {
    screen?: {
      root: number;
      depths?: Record<number, Record<string, { class?: number }>>;
    }[];
  };
}

export interface TrayManagerStartOptions {
  orientation: TrayOrientation;
  /**
   * The top-level window the icons will be embedded into, so the visual it
   * actually has can be advertised — or not. `null` skips the question and
   * publishes no `_NET_SYSTEM_TRAY_VISUAL`.
   */
  hostWindowId: number | null;
}

/**
 * The tray host's half of the system tray protocol.
 *
 * ```ts
 * const manager = new TrayManager(app, 0);
 * manager.handlers = { onIcons: setIcons };
 * await manager.start({ orientation: 'horizontal', hostWindowId: id });
 * // …
 * manager.stop();
 * ```
 *
 * Public because a panel that draws its own tray — one that does not want
 * `<TrayHost>`'s layout — should not have to reimplement selection
 * ownership, and because it is what the tests drive. Same reason
 * `ProcessHost` is exported from `../embed/`.
 */
export class TrayManager {
  #app: TrayApp;
  #screen: number;
  #X: XConnection | null;
  #root: number;

  #selectionAtom = 0;
  #opcodeAtom = 0;
  #orientationAtom = 0;
  #visualAtom = 0;
  #messageDataAtom = 0;
  #managerAtom = 0;
  #timestampAtom = 0;

  /** The window that owns the selection, and the address the opcodes are
   *  sent to. Created here rather than rendered, because a selection held on
   *  a node that can unmount is a tray that silently stops being one. */
  #window = 0;
  /** The timestamp the selection was taken with; ICCCM 2.3 wants it back
   *  when the selection is given up. */
  #ownedAt = 0;

  #icons: TrayIcon[] = [];
  #balloons = new BalloonAssembler();
  #status: TrayStatus = 'starting';
  #conflict: TrayConflict | null = null;
  #orientation: TrayOrientation = 'horizontal';
  #visual = 0;
  /**
   * The current run, or `null` between `stop()` and the next `start()`.
   *
   * A token rather than a pair of booleans for the reason `ForeignNode._start`
   * uses one: taking the selection is a chain of round trips, and a run that
   * was stopped part-way through must not have its stale continuation report
   * success or leave a window behind. It is also what makes the manager
   * genuinely restartable — React remounts an effect on the same instance in
   * development, and a one-shot manager would come back dead.
   */
  #run: object | null = null;
  #listener: ((ev: XEvent) => void) | null = null;

  /** Assign, do not construct with: the component replaces these every
   *  render so an inline handler is not a reason to restart anything. */
  handlers: TrayManagerHandlers = {};

  constructor(app: TrayApp, screen = 0) {
    this.#app = app;
    this.#screen = screen;
    this.#X = app?.X ?? null;
    this.#root = app?.display?.screen?.[screen]?.root ?? 0;
  }

  get status(): TrayStatus {
    return this.#status;
  }

  get conflict(): TrayConflict | null {
    return this.#conflict;
  }

  /** The manager selection window, once there is one. */
  get windowId(): number {
    return this.#window || 0;
  }

  get icons(): readonly TrayIcon[] {
    return this.#icons;
  }

  /**
   * Take the selection, if nobody else has it.
   *
   * The order is the spec's: publish the properties, *then* take the
   * selection, *then* broadcast `MANAGER`. A client that starts docking on
   * the broadcast reads the properties immediately afterwards, so they have
   * to be there before the announcement rather than after it.
   */
  async start(options: TrayManagerStartOptions): Promise<void> {
    if (this.#run) return;
    const run = {};
    this.#run = run;
    /** Still the run that started this line? */
    const live = (): boolean => this.#run === run;
    this.#orientation = options.orientation;
    this.#setStatus('starting', null);

    const X = this.#X;
    // No raw protocol on this connection — a headless mock. Not an error to
    // report: there is simply no display to be the tray of.
    if (!X || typeof X.SetSelectionOwner !== 'function' || !this.#root) {
      this.#setStatus('unavailable', null);
      return;
    }

    try {
      await this.#internAtoms(X);
      if (!live()) return;

      const existing = await this.#selectionOwner(X);
      if (!live()) return;
      if (existing) {
        // A second panel on one display is a configuration mistake, not an
        // exception. It says so and embeds nothing.
        this.#setStatus('conflict', { owner: existing, screen: this.#screen });
        return;
      }

      this.#window = X.AllocID();
      // InputOnly, never mapped, 1x1 off-screen: this window exists to be an
      // address and to hold two properties, which InputOnly windows do.
      // PropertyChange is selected for `#serverTime()` alone.
      X.CreateWindow(
        this.#window,
        this.#root,
        -1,
        -1,
        1,
        1,
        0,
        0,
        INPUT_ONLY,
        0,
        { eventMask: PROPERTY_CHANGE_MASK },
      );

      this.#visual = await this.#resolveVisual(X, options.hostWindowId);
      // Stopped mid-flight: the window above is ours and nothing else will
      // drop it, because `stop()` ran before there was one to drop.
      if (!live()) {
        this.#destroyWindow();
        return;
      }
      this.#writeOrientation();
      this.#writeVisual();

      const time = await this.#serverTime(X);
      if (!live()) {
        this.#destroyWindow();
        return;
      }
      X.SetSelectionOwner(this.#window, this.#selectionAtom, time);
      this.#ownedAt = time;

      // Ask rather than assume. Two panels starting together both saw an
      // unowned selection above, and only one of them has it now.
      const owner = await this.#selectionOwner(X);
      if (!live()) {
        X.SetSelectionOwner(0, this.#selectionAtom, time);
        this.#destroyWindow();
        return;
      }
      if (owner !== this.#window) {
        this.#setStatus('conflict', { owner, screen: this.#screen });
        this.#destroyWindow();
        return;
      }

      this.#listen(X);
      this.#broadcastManager(X, time);
      this.#setStatus('owned', null);
    } catch (err) {
      this.#fail(err);
    }
  }

  /**
   * Give the selection back and drop the manager window.
   *
   * The icons are *not* reparented here: each one is a `<foreign>`, and
   * handing a client back untouched on unmount is that element's promise.
   * All this does is stop being the tray.
   */
  stop(): void {
    if (!this.#run) return;
    this.#run = null;
    const X = this.#X;
    this.#unlisten();
    this.#balloons.clear();
    this.#replaceIcons([]);
    if (X && this.#window) {
      try {
        // ICCCM 2.3: relinquish with the timestamp it was acquired at.
        X.SetSelectionOwner(0, this.#selectionAtom, this.#ownedAt);
      } catch {
        // the connection is going away, which releases it anyway
      }
    }
    this.#destroyWindow();
    this.#setStatus('released', null);
  }

  /** Republish `_NET_SYSTEM_TRAY_ORIENTATION`. Cheap and idempotent. */
  setOrientation(orientation: TrayOrientation): void {
    if (orientation === this.#orientation) return;
    this.#orientation = orientation;
    this.#writeOrientation();
  }

  /**
   * The icon's client went away — `<foreign onClientGone>`, which is the
   * ordinary case here rather than an error: tray icons come and go with the
   * applications that own them.
   */
  undock(id: number): void {
    const icon = this.#icons.find((entry) => entry.id === id);
    if (!icon) return;
    // A new array, never a splice: the component holds this as state, and
    // React compares identities — mutating in place removes the icon from
    // the list and leaves it on screen.
    this.#icons = this.#icons.filter((entry) => entry !== icon);
    this.#balloons.forget(id);
    this.#emitIcons();
    this.#safely(() => this.handlers.onUndock?.(icon));
  }

  // --- the wire ------------------------------------------------------

  #listen(X: XConnection): void {
    const listener = (ev: XEvent): void => {
      if (!this.#run) return;
      try {
        this.#onEvent(ev);
      } catch (err) {
        this.#fail(err);
      }
    };
    this.#listener = listener;
    X.on('event', listener);
  }

  #unlisten(): void {
    const listener = this.#listener;
    this.#listener = null;
    if (listener) this.#X?.removeListener?.('event', listener);
  }

  #onEvent(ev: XEvent): void {
    if (ev.type === SELECTION_CLEAR) {
      // Another tray took over. Letting the icons go is the whole job here:
      // a panel that keeps drawing dead icons after losing the selection is
      // the failure users report as "my tray is empty".
      if (ev.selection !== this.#selectionAtom) return;
      if (this.#window && ev.owner !== this.#window) return;
      this.#unlisten();
      this.#balloons.clear();
      this.#replaceIcons([]);
      this.#destroyWindow();
      this.#setStatus('released', null);
      return;
    }

    if (ev.type !== CLIENT_MESSAGE) return;

    if (ev.message_type === this.#opcodeAtom) {
      // A dock request names the manager window; a balloon message names the
      // icon it is about, and both are *sent to* the manager window. So the
      // event's window field is only ever one of those two.
      const from = ev.wid ?? 0;
      if (from !== this.#window && !this.#hasIcon(from)) return;
      this.#onOpcode(from, ev.data ?? []);
      return;
    }

    if (ev.message_type === this.#messageDataAtom && ev.format === 8) {
      const from = ev.wid ?? 0;
      if (!this.#hasIcon(from)) return;
      const message = this.#balloons.data(from, ev.data ?? []);
      if (message) this.#safely(() => this.handlers.onMessage?.(message));
    }
  }

  #onOpcode(from: number, data: readonly number[]): void {
    const opcode = data[1];
    if (opcode === SYSTEM_TRAY_REQUEST_DOCK) {
      this.#dock(data[2] ?? 0);
      return;
    }
    if (opcode === SYSTEM_TRAY_BEGIN_MESSAGE) {
      if (!this.#hasIcon(from)) return;
      const message = this.#balloons.begin(from, {
        timeout: data[2] ?? 0,
        length: data[3] ?? 0,
        id: data[4] ?? 0,
      });
      if (message) this.#safely(() => this.handlers.onMessage?.(message));
      return;
    }
    if (opcode === SYSTEM_TRAY_CANCEL_MESSAGE) {
      if (!this.#hasIcon(from)) return;
      const id = data[2] ?? 0;
      if (this.#balloons.cancel(from, id)) {
        this.#safely(() =>
          this.handlers.onCancelMessage?.({ windowId: from, id }),
        );
      }
    }
  }

  #dock(id: number): void {
    if (!id || this.#status !== 'owned' || this.#hasIcon(id)) return;
    const icon: TrayIcon = { id };
    this.#icons = [...this.#icons, icon];
    this.#emitIcons();
    this.#safely(() => this.handlers.onDock?.(icon));
  }

  #hasIcon(id: number): boolean {
    return this.#icons.some((icon) => icon.id === id);
  }

  #replaceIcons(next: TrayIcon[]): void {
    if (this.#icons.length === 0 && next.length === 0) return;
    const gone = this.#icons;
    this.#icons = next;
    this.#emitIcons();
    for (const icon of gone) {
      if (!next.includes(icon))
        this.#safely(() => this.handlers.onUndock?.(icon));
    }
  }

  #emitIcons(): void {
    const icons = this.#icons;
    this.#safely(() => this.handlers.onIcons?.(icons));
  }

  /**
   * ICCCM 2.8's `MANAGER` broadcast: clients that were waiting for a tray
   * start docking on this, which is the only reason an application launched
   * before the panel ever gets an icon.
   */
  #broadcastManager(X: XConnection, time: number): void {
    X.SendEvent(this.#root, 0, STRUCTURE_NOTIFY_MASK, {
      name: 'ClientMessage',
      format: 32,
      wid: this.#root,
      message_type: this.#managerAtom,
      data: [time, this.#selectionAtom, this.#window, 0, 0],
    });
  }

  #writeOrientation(): void {
    const X = this.#X;
    if (!X || !this.#window) return;
    X.ChangeProperty(0, this.#window, this.#orientationAtom, XA_CARDINAL, 32, [
      orientationValue(this.#orientation),
    ]);
  }

  #writeVisual(): void {
    const X = this.#X;
    // Absent rather than zero when there is nothing honest to say: a client
    // reads "is the property there" and a 0 visual id is not a visual.
    if (!X || !this.#window || !this.#visual) return;
    X.ChangeProperty(0, this.#window, this.#visualAtom, XA_VISUALID, 32, [
      this.#visual,
    ]);
  }

  async #resolveVisual(
    X: XConnection,
    hostWindowId: number | null,
  ): Promise<number> {
    if (!hostWindowId) return 0;
    try {
      const attrs = await new Promise<{ visual: number }>((resolve, reject) =>
        X.GetWindowAttributes(hostWindowId, (err, value) =>
          err ? reject(err) : resolve(value),
        ),
      );
      const screen = this.#app.display?.screen?.[this.#screen];
      return argbVisualOf(screen, attrs?.visual ?? 0);
    } catch {
      // The window went away, or the server would not say. No property, and
      // the icons fall back to guessing a background — which always worked.
      return 0;
    }
  }

  /**
   * A real server timestamp.
   *
   * ICCCM 2.1: a selection is taken with the timestamp of the event that
   * caused it and never with `CurrentTime`, because X arbitrates between
   * clients by comparing timestamps and `CurrentTime` compares with nothing.
   * Core tracks exactly this (`src/inputtime.js`) and does not export it, so
   * it is re-derived here the way GTK's `gdk_x11_get_server_time` does: a
   * zero-length *append* to a property on a window we own changes nothing
   * and still produces a PropertyNotify, and that event is stamped.
   *
   * The timeout is the honest fallback rather than a hang. Passing 0 lets
   * the server substitute its own clock — worse than a real timestamp,
   * better than a tray that never starts.
   */
  #serverTime(X: XConnection): Promise<number> {
    return new Promise<number>((resolve) => {
      let settled = false;
      const finish = (time: number): void => {
        if (settled) return;
        settled = true;
        stopTimeout(timer);
        X.removeListener?.('event', onEvent);
        resolve(time >>> 0);
      };
      const onEvent = (ev: XEvent): void => {
        if (
          ev.type === PROPERTY_NOTIFY &&
          ev.wid === this.#window &&
          ev.atom === this.#timestampAtom
        ) {
          finish(ev.time ?? 0);
        }
      };
      const timer = startTimeout(() => finish(0), TIMESTAMP_TIMEOUT);
      X.on('event', onEvent);
      // mode 2 is append, and an empty array is zero elements of it
      X.ChangeProperty(2, this.#window, this.#timestampAtom, XA_STRING, 8, []);
    });
  }

  #selectionOwner(X: XConnection): Promise<number> {
    return new Promise<number>((resolve, reject) =>
      X.GetSelectionOwner(this.#selectionAtom, (err, owner) =>
        err ? reject(err) : resolve(owner >>> 0),
      ),
    );
  }

  async #internAtoms(X: XConnection): Promise<void> {
    const intern = (name: string): Promise<number> =>
      new Promise<number>((resolve, reject) =>
        X.InternAtom(false, name, (err, atom) =>
          err ? reject(err) : resolve(atom),
        ),
      );
    const [
      selection,
      opcode,
      orientation,
      visual,
      messageData,
      manager,
      timestamp,
    ] = await Promise.all([
      intern(selectionNameFor(this.#screen)),
      intern(OPCODE_ATOM),
      intern(ORIENTATION_ATOM),
      intern(VISUAL_ATOM),
      intern(MESSAGE_DATA_ATOM),
      intern(MANAGER_ATOM),
      intern('_REACT_X11_TRAY_TIMESTAMP'),
    ]);
    this.#selectionAtom = selection ?? 0;
    this.#opcodeAtom = opcode ?? 0;
    this.#orientationAtom = orientation ?? 0;
    this.#visualAtom = visual ?? 0;
    this.#messageDataAtom = messageData ?? 0;
    this.#managerAtom = manager ?? 0;
    this.#timestampAtom = timestamp ?? 0;
  }

  #destroyWindow(): void {
    const id = this.#window;
    this.#window = 0;
    if (!id) return;
    try {
      this.#X?.DestroyWindow(id);
    } catch {
      // the connection is closing; the server drops it with us
    }
  }

  #setStatus(status: TrayStatus, conflict: TrayConflict | null): void {
    if (this.#status === status && this.#conflict === conflict) return;
    this.#status = status;
    this.#conflict = conflict;
    this.#safely(() => this.handlers.onStatus?.(status, conflict));
  }

  #fail(err: unknown): void {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    this.#safely(() => this.handlers.onError?.(wrapped));
  }

  /** One handler throwing must not take the X event loop with it — the same
   *  rule `xsettings.js` applies to its subscribers. */
  #safely(fn: () => void): void {
    try {
      fn();
    } catch {
      /* a listener's problem, not the tray's */
    }
  }
}
