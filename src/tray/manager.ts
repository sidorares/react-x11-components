// Being the tray: the selection, the window that holds it, and the messages
// that arrive on it.
//
// Everything X-shaped about `<TrayHost>` is here, and none of it is React —
// which is the point. The manager selection has to be owned by a window that
// outlives any particular render (a tray that stops being the tray because a
// node unmounted is the failure users report as "my tray went empty"), so the
// window is created here, directly, and dropped only when the component
// unmounts.
//
// **Why this reads raw events.** The tray's opcodes arrive as ClientMessages
// addressed to the manager window, and react-x11 has no `<window
// onClientMessage>` — so this listens on `X.on('event')` and filters, which is
// what core's own `src/xsettings.js` does internally for the same reason. A
// per-element seam in core would pay for itself across every EWMH-adjacent
// protocol; until there is one, this is the escape hatch `useApp().X` exists
// to be.
import {
  BalloonMessages,
  CARDINAL,
  CLIENT_MESSAGE,
  MANAGER,
  ORIENTATION_VALUE,
  PROPERTY_CHANGE_MASK,
  PROPERTY_NOTIFY,
  PROP_APPEND,
  PROP_REPLACE,
  SELECTION_CLEAR,
  STRUCTURE_NOTIFY_MASK,
  SYSTEM_TRAY_BEGIN_MESSAGE,
  SYSTEM_TRAY_CANCEL_MESSAGE,
  SYSTEM_TRAY_REQUEST_DOCK,
  TRAY_MESSAGE_DATA,
  TRAY_OPCODE,
  TRAY_ORIENTATION,
  TRAY_VISUAL,
  VISUALID,
  traySelectionName,
} from './protocol.js';
import type { TrayMessage, TrayOrientation } from './protocol.js';

/**
 * An X event as node-x11 unpacks one. Written out structurally rather than
 * imported for the reason `../desktop-calendar/ical.ts` gives at length:
 * `useApp()` is declared `unknown` in react-x11's types, and neither ntk nor
 * node-x11 is a dependency of this package.
 */
export interface TrayXEvent {
  type: number;
  /** The window the event is *about* — for a ClientMessage, its `window`
   *  field rather than the window it was delivered to. */
  wid: number;
  /** ClientMessage. */
  message_type?: number;
  format?: number;
  data?: number[];
  /** SelectionClear. */
  selection?: number;
  owner?: number;
  /** SelectionClear, PropertyNotify. */
  time?: number;
  /** PropertyNotify. */
  atom?: number;
}

/** The slice of node-x11's connection this file uses. */
export interface TrayX {
  display: { screen: { root: number }[] };
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
    windowClass: number,
    visual: number,
    values: Record<string, number>,
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
  DeleteProperty(wid: number, name: number): void;
  GetSelectionOwner(
    atom: number,
    cb: (err: Error | null, owner: number) => void,
  ): void;
  SetSelectionOwner(owner: number, atom: number, time: number): void;
  SendClientMessage(
    destination: number,
    wid: number,
    messageType: number,
    format: number,
    data: readonly number[],
    eventMask: number,
  ): void;
  GetWindowAttributes(
    wid: number,
    cb: (err: Error | null, attributes: { visual: number }) => void,
  ): void;
  GetInputFocus(cb: (err: Error | null) => void): void;
  on(event: 'event', fn: (ev: TrayXEvent) => void): void;
  removeListener(event: 'event', fn: (ev: TrayXEvent) => void): void;
}

/** The slice of the ntk app object this file uses. */
export interface TrayApp {
  X: TrayX;
  /** `{ visual, depth: 32 }`, or null where the display has no ARGB visual. */
  findArgbVisual?(screen?: number): { visual: number; depth: number } | null;
}

/**
 * `useApp()`, if the connection behind it can actually be a tray.
 *
 * Null for react-x11's headless mock, which models a renderer rather than a
 * server and has no selections in it. A tray that cannot run is an ordinary
 * state — the same call `<Terminal>` makes about a machine with no emulator —
 * so this answers null rather than throwing.
 */
export function asTrayApp(app: unknown): TrayApp | null {
  const candidate = app as TrayApp | null;
  const X = candidate?.X as Partial<TrayX> | undefined;
  const usable =
    typeof X?.SetSelectionOwner === 'function' &&
    typeof X.GetSelectionOwner === 'function' &&
    typeof X.CreateWindow === 'function' &&
    typeof X.ChangeProperty === 'function' &&
    typeof X.SendClientMessage === 'function' &&
    typeof X.on === 'function';
  return usable ? (candidate as TrayApp) : null;
}

export interface TrayManagerOptions {
  screen?: number;
  orientation?: TrayOrientation;
  /** The visual to advertise, or 0 for "do not". See `hostVisual`. */
  visual?: number;
  /** `SYSTEM_TRAY_REQUEST_DOCK` for this window. */
  onDock(windowId: number): void;
  /** A balloon message, reassembled. */
  onMessage(message: TrayMessage): void;
  onMessageCancel(info: { windowId: number; id: number }): void;
  /** The selection went to another tray: let every icon go. */
  onLost(): void;
  onError(err: Error): void;
}

/** What `start()` answers: the selection, or who has it instead. */
export type TrayManagerResult =
  { owned: true; window: number } | { owned: false; owner: number };

export class TrayManager {
  #app: TrayApp;
  #options: TrayManagerOptions;
  #screen: number;
  #atoms = {
    selection: 0,
    manager: 0,
    opcode: 0,
    messageData: 0,
    orientation: 0,
    visual: 0,
  };
  #window = 0;
  /** The server timestamp the selection was acquired with. */
  #time = 0;
  #owned = false;
  #stopped = false;
  #listening = false;
  #orientation: TrayOrientation;
  #visual: number;
  #balloons = new BalloonMessages();
  #onEvent = (ev: TrayXEvent): void => this.#handle(ev);

  constructor(app: TrayApp, options: TrayManagerOptions) {
    this.#app = app;
    this.#options = options;
    this.#screen = options.screen ?? 0;
    this.#orientation = options.orientation ?? 'horizontal';
    this.#visual = options.visual ?? 0;
  }

  /** The manager selection window, or 0 before there is one. */
  get window(): number {
    return this.#window;
  }

  /**
   * Become the tray, or report who already is.
   *
   * Never rejects for "somebody else has it" — a second panel on one display
   * is a configuration mistake, not an exception — but does reject if the
   * connection fails underneath, which is a real error with nowhere else to
   * go.
   */
  async start(): Promise<TrayManagerResult> {
    const X = this.#app.X;
    await this.#internAtoms();
    if (this.#stopped) return { owned: false, owner: 0 };

    // Ask before taking. The alternative — take it and see — would send a
    // SelectionClear to a working tray and leave every icon on the display
    // reparenting between two panels.
    const existing = await this.#selectionOwner();
    if (existing || this.#stopped) return { owned: false, owner: existing };

    this.#window = this.#createManagerWindow();
    // Listening before the acquisition, so a SelectionClear from a tray that
    // starts in the same millisecond is not missed.
    X.on('event', this.#onEvent);
    this.#listening = true;

    const time = await this.#timestamp();
    if (this.#stopped) {
      this.#release();
      return { owned: false, owner: 0 };
    }

    // Properties before the selection: a client that has been waiting for
    // MANAGER can dock the instant it sees one, and an icon that reads no
    // orientation lays itself out for the wrong strip.
    this.#writeOrientation();
    this.#writeVisual();

    this.#time = time;
    X.SetSelectionOwner(this.#window, this.#atoms.selection, time);
    const owner = await this.#selectionOwner();
    if (this.#stopped) {
      this.#release();
      return { owned: false, owner: 0 };
    }
    if (owner !== this.#window) {
      // Lost the race with a tray that started at the same moment. Same
      // outcome as finding the selection owned, and the same reason to say so
      // through a prop rather than a throw.
      this.#release();
      return { owned: false, owner };
    }
    this.#owned = true;

    // ICCCM 2.8: the broadcast is what makes clients that started before this
    // panel did stop waiting and dock.
    const root = this.#root();
    X.SendClientMessage(
      root,
      root,
      this.#atoms.manager,
      32,
      [time, this.#atoms.selection, this.#window, 0, 0],
      STRUCTURE_NOTIFY_MASK,
    );
    return { owned: true, window: this.#window };
  }

  /** Republish `_NET_SYSTEM_TRAY_ORIENTATION`. */
  setOrientation(orientation: TrayOrientation): void {
    if (orientation === this.#orientation) return;
    this.#orientation = orientation;
    this.#writeOrientation();
  }

  /** Republish `_NET_SYSTEM_TRAY_VISUAL`, or drop it with 0. */
  setVisual(visual: number): void {
    if (visual === this.#visual) return;
    this.#visual = visual;
    this.#writeVisual();
  }

  /** An icon left. Anything it was part-way through saying goes with it. */
  iconGone(windowId: number): void {
    this.#balloons.forget(windowId);
  }

  /**
   * Stop being the tray.
   *
   * The order is the whole content of this method: stop listening, *then*
   * give the selection up. Releasing it makes the server send us the
   * SelectionClear for our own release, and a listener still attached would
   * report that to the component as "another tray took over" while it is
   * unmounting.
   */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#release();
  }

  // --- the X calls, wrapped ------------------------------------------------

  #root(): number {
    return this.#app.X.display.screen[this.#screen]?.root ?? 0;
  }

  async #internAtoms(): Promise<void> {
    const names = [
      traySelectionName(this.#screen),
      MANAGER,
      TRAY_OPCODE,
      TRAY_MESSAGE_DATA,
      TRAY_ORIENTATION,
      TRAY_VISUAL,
    ];
    const [selection, manager, opcode, messageData, orientation, visual] =
      await Promise.all(names.map((name) => this.#atom(name)));
    this.#atoms = {
      selection: selection ?? 0,
      manager: manager ?? 0,
      opcode: opcode ?? 0,
      messageData: messageData ?? 0,
      orientation: orientation ?? 0,
      visual: visual ?? 0,
    };
  }

  #atom(name: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#app.X.InternAtom(false, name, (err, atom) =>
        err ? reject(err) : resolve(atom),
      );
    });
  }

  #selectionOwner(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#app.X.GetSelectionOwner(this.#atoms.selection, (err, owner) =>
        err ? reject(err) : resolve(owner),
      );
    });
  }

  /**
   * A 1×1 window that is never mapped, off-screen, override-redirect.
   *
   * It exists to be an address: the thing the selection is held by, the thing
   * the two properties hang off, and the window clients send their opcodes to.
   * Its own visual does not matter — `_NET_SYSTEM_TRAY_VISUAL` describes the
   * window icons are *embedded* in, which is the app's toplevel.
   */
  #createManagerWindow(): number {
    const X = this.#app.X;
    const id = X.AllocID();
    X.CreateWindow(id, this.#root(), -1, -1, 1, 1, 0, 0, 1, 0, {
      // PropertyChange because the timestamp below is a property write that
      // comes back as an event.
      eventMask: PROPERTY_CHANGE_MASK,
      overrideRedirect: 1,
    });
    return id;
  }

  /**
   * A real server timestamp, which is what ICCCM 2.1 requires of a selection
   * acquisition and what `CurrentTime` is not: two clients acquiring with
   * `CurrentTime` cannot be ordered, so the server cannot arbitrate and the
   * loser never finds out it lost.
   *
   * The trick is ICCCM's own: a zero-length append to a property on a window
   * with PropertyChange selected changes nothing and produces a PropertyNotify
   * carrying the server's clock. Core already tracks this value
   * (`src/inputtime.js`) but does not export it, so out here it is re-derived.
   *
   * The `GetInputFocus` is the barrier that ends the wait: a reply cannot
   * overtake an event queued ahead of it, so once it lands the PropertyNotify
   * either arrived or is not coming.
   */
  #timestamp(): Promise<number> {
    const X = this.#app.X;
    const window = this.#window;
    const atom = this.#atoms.selection;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (time: number): void => {
        if (settled) return;
        settled = true;
        X.removeListener('event', listener);
        resolve(time >>> 0);
      };
      const listener = (ev: TrayXEvent): void => {
        if (ev.type !== PROPERTY_NOTIFY) return;
        if (ev.wid !== window || ev.atom !== atom) return;
        finish(ev.time ?? 0);
      };
      X.on('event', listener);
      X.ChangeProperty(PROP_APPEND, window, atom, CARDINAL, 8, []);
      // 0 is CurrentTime, which is the value ICCCM forbids — reached only if
      // a server answered a round trip without sending the event the protocol
      // says it must. Being a slightly non-conformant tray beats being none.
      X.GetInputFocus(() => finish(0));
    });
  }

  #writeOrientation(): void {
    if (!this.#window) return;
    this.#app.X.ChangeProperty(
      PROP_REPLACE,
      this.#window,
      this.#atoms.orientation,
      CARDINAL,
      32,
      [ORIENTATION_VALUE[this.#orientation]],
    );
  }

  /**
   * `_NET_SYSTEM_TRAY_VISUAL`, or nothing.
   *
   * Absence is meaningful here: an icon that finds no visual draws itself
   * opaque, which is right for a host that cannot blend it. Advertising one
   * the host does not really have is what produces a black box behind every
   * icon that believed it.
   */
  #writeVisual(): void {
    if (!this.#window) return;
    const X = this.#app.X;
    if (this.#visual) {
      X.ChangeProperty(
        PROP_REPLACE,
        this.#window,
        this.#atoms.visual,
        VISUALID,
        32,
        [this.#visual],
      );
    } else {
      X.DeleteProperty(this.#window, this.#atoms.visual);
    }
  }

  #release(): void {
    const X = this.#app.X;
    if (this.#listening) {
      X.removeListener('event', this.#onEvent);
      this.#listening = false;
    }
    // Only when this really is the owner. `SetSelectionOwner(None)` is not
    // conditional on who is asking, so a host that lost the race and cleaned
    // up with one would clear the *winner's* ownership on its way out.
    // Destroying the window below is the conditional version, and covers the
    // case where the acquisition was still in flight.
    if (this.#owned) {
      this.#owned = false;
      try {
        // The acquisition timestamp rather than CurrentTime: ICCCM 2.3.1 asks
        // for the time this client took the selection, and it is by definition
        // not earlier than the server's last-change time for it.
        X.SetSelectionOwner(0, this.#atoms.selection, this.#time);
      } catch {
        // the connection is going away, which releases it anyway
      }
    }
    if (this.#window) {
      const window = this.#window;
      this.#window = 0;
      try {
        X.DestroyWindow(window);
      } catch {
        // as above: a closing connection takes its windows with it
      }
    }
  }

  // --- what arrives on the connection --------------------------------------

  #handle(ev: TrayXEvent): void {
    if (this.#stopped) return;

    if (ev.type === SELECTION_CLEAR) {
      if (!this.#owned) return;
      if (ev.selection !== this.#atoms.selection) return;
      if (ev.owner !== this.#window) return;
      // Another tray took over. This one must let every icon go and stop
      // claiming to be a tray: a panel that keeps drawing dead icons is what
      // "my tray is empty" actually looks like from the other side.
      this.#owned = false;
      this.#report(() => this.#options.onLost());
      return;
    }

    if (ev.type !== CLIENT_MESSAGE) return;

    // Filtered on the message type rather than on the destination window,
    // because the two opcodes do not agree on what `window` means: a dock
    // request names the manager window, a balloon message names the icon
    // that is speaking. The atoms are this connection's own, and nothing
    // else on it sends them.
    if (ev.message_type === this.#atoms.opcode && ev.format === 32) {
      this.#opcode(ev);
    } else if (
      ev.message_type === this.#atoms.messageData &&
      ev.format === 8 &&
      ev.data
    ) {
      const done = this.#balloons.data(ev.wid, ev.data);
      if (done) this.#report(() => this.#options.onMessage(done));
    }
  }

  #opcode(ev: TrayXEvent): void {
    const data = ev.data ?? [];
    switch (data[1]) {
      case SYSTEM_TRAY_REQUEST_DOCK: {
        const windowId = data[2] ?? 0;
        // A dock request for None is a client that got its own window id
        // wrong; embedding it would be embedding whatever 0 resolves to.
        if (windowId) this.#report(() => this.#options.onDock(windowId));
        break;
      }
      case SYSTEM_TRAY_BEGIN_MESSAGE: {
        const done = this.#balloons.begin(
          ev.wid,
          data[4] ?? 0,
          data[2] ?? 0,
          data[3] ?? 0,
        );
        if (done) this.#report(() => this.#options.onMessage(done));
        break;
      }
      case SYSTEM_TRAY_CANCEL_MESSAGE: {
        const id = data[2] ?? 0;
        this.#balloons.cancel(ev.wid, id);
        this.#report(() =>
          this.#options.onMessageCancel({ windowId: ev.wid, id }),
        );
        break;
      }
      default:
        // A future opcode, or a client with a bug. Neither is ours to report
        // and neither stops the tray.
        break;
    }
  }

  /** A handler that throws must not take the X event loop with it — the same
   *  rule core's `xsettings.js` applies to its subscribers. */
  #report(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      try {
        this.#options.onError(err as Error);
      } catch {
        // nowhere left to report it
      }
    }
  }
}

/**
 * The visual to advertise to icons, or 0.
 *
 * Icons are embedded into `<foreign>` containers, and a container is a child
 * of the app's toplevel on the toplevel's own visual — so the honest question
 * is not "does this display have an ARGB visual" but "is the window these
 * icons will actually live in drawn on it", which is what `<window
 * transparent>` decides and what the server is asked here.
 */
export async function hostVisual(
  app: TrayApp,
  screen: number,
  windowId: number | null,
): Promise<number> {
  const argb = app.findArgbVisual?.(screen);
  if (!argb || !windowId) return 0;
  const attributes = await new Promise<{ visual: number } | null>((resolve) => {
    app.X.GetWindowAttributes(windowId, (err, value) =>
      resolve(err ? null : value),
    );
  });
  return attributes?.visual === argb.visual ? argb.visual : 0;
}
