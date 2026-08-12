// <TrayHost> — the system tray, pointed the other way.
//
// `<Terminal>` and `<MediaPlayer>` made this package an XEmbed *host* for
// programs it starts itself. A tray is the same protocol with the initiative
// reversed: the host publishes a selection saying "there is a tray here", and
// any application on the display may then ask to put its icon in one. The hard
// half — the reparent, the save set, `_XEMBED_INFO`, the focus messages, and
// handing a client back rather than destroying it — is core's `<foreign>` and
// is already done.
//
// What is left, and what this directory is:
//
//  - `./manager.ts` — the `_NET_SYSTEM_TRAY_S<screen>` selection, the window
//    that holds it, the `MANAGER` broadcast, the opcode routing, and the two
//    properties a host advertises.
//  - `./protocol.ts` — the constants, and the balloon-message assembler.
//  - `./notify.ts` — where a balloon message goes by default.
//  - here — the React half: one `<foreign>` per docked icon, and the state
//    that says which.
//
// Registers no element: `<foreign>` is a built-in, and like `<Calendar>` this
// module has **no side effect at import time at all**.
//
// ### What is deliberately not here
//
// **StatusNotifierItem.** Modern applications publish a tray icon over D-Bus
// rather than XEmbed, and a complete panel supports both — but SNI shares
// nothing with this except intent. It pairs with core's `dbusmenu.js` rather
// than with `<foreign>`, so it belongs beside this component rather than
// inside it.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { useApp, useWindowId } from 'react-x11';
import type { DrawnNode, ForeignProps } from 'react-x11';
import type { Style } from 'react-x11/style';

import { hx } from './hx.js';
import { TrayManager, asTrayApp, hostVisual } from './manager.js';
import { notifyBalloon } from './notify.js';

export { BalloonMessages, traySelectionName } from './protocol.js';
export type { TrayMessage, TrayOrientation } from './protocol.js';
export { TrayManager, asTrayApp, hostVisual } from './manager.js';
export type {
  TrayApp,
  TrayManagerOptions,
  TrayManagerResult,
  TrayX,
  TrayXEvent,
} from './manager.js';
export { notifyBalloon, sendNotification } from './notify.js';

import type { TrayMessage, TrayOrientation } from './protocol.js';

const h = React.createElement;

/** `<foreign>`'s props as `hx` takes them — `theme` is dropped because `hx`
 *  re-declares it (see `./hx.ts`). */
type ForeignElementProps = Omit<ForeignProps, 'theme'>;

/**
 * Where the tray is in its one interesting lifecycle.
 *
 * | | |
 * | --- | --- |
 * | `'starting'` | the selection is being taken — also the first render |
 * | `'hosting'` | this is the tray; icons may dock |
 * | `'conflict'` | another tray owns the selection, and this one embedded nothing |
 * | `'replaced'` | this tray had the selection and lost it; every icon was handed back |
 * | `'unavailable'` | the connection cannot host a tray at all (a mock, a closed display) |
 */
export type TrayHostStatus =
  'starting' | 'hosting' | 'conflict' | 'replaced' | 'unavailable';

/** An icon arriving or leaving. */
export interface TrayIconEvent {
  /** The client's own top-level window — what `<foreign windowId>` embeds. */
  windowId: number;
}

/** What a `ref` on `<TrayHost>` gets. */
export interface TrayHostHandle {
  readonly status: TrayHostStatus;
  /** The manager selection window, or null while there is not one. */
  readonly windowId: number | null;
  /** Docked icons, in the order they are drawn. */
  readonly icons: readonly number[];
}

export interface TrayHostProps {
  /** Which way the strip runs. Published as `_NET_SYSTEM_TRAY_ORIENTATION`
   *  so an icon can draw itself to match. Default `'horizontal'`. */
  orientation?: TrayOrientation;
  /** The square each icon is laid out in. Default 22. */
  iconSize?: number;
  /** Between icons. Default 2. */
  spacing?: number;
  /** X screen number, for the `_NET_SYSTEM_TRAY_S<screen>` selection.
   *  Default 0. */
  screen?: number;
  /**
   * Reorder the strip — pinned icons first, sorted by dock time, whatever the
   * panel wants. The default is dock order.
   *
   * Anything returned that is not docked is dropped and anything docked that
   * is left out is appended, so a mistake here cannot embed a window that
   * never asked to be embedded. Reordering never re-embeds: node identity is
   * keyed on the window id, which is what keeps a moved icon out of the race
   * react-x11's `docs/embedding.md` describes.
   */
  order?: (icons: readonly number[]) => readonly number[];
  /** An application docked an icon. */
  onDock?: (icon: TrayIconEvent) => void;
  /** An icon's client went away — the ordinary end of a tray icon's life,
   *  not an error. */
  onUndock?: (icon: TrayIconEvent) => void;
  /**
   * A balloon message from an icon.
   *
   * **Providing this replaces the default**, which is to forward the message
   * to the desktop's notification service. Take it to draw the balloon in the
   * panel itself.
   */
  onMessage?: (message: TrayMessage) => void;
  /** The icon withdrew a message — take down the balloon showing it. */
  onMessageCancel?: (info: { windowId: number; id: number }) => void;
  /** The name notifications are attributed to, when they are forwarded.
   *  Default `'System Tray'`. */
  appName?: string;
  /** Another tray already owns the selection. A second panel on one display
   *  is a configuration mistake rather than an exception, so it is reported
   *  here instead of thrown. */
  onConflict?: (info: { owner: number }) => void;
  /** This tray lost the selection to another one. Every icon has already been
   *  handed back to the root window, untouched. */
  onReplaced?: () => void;
  /** A failed embed, a handler that threw, a connection that went away. */
  onError?: (err: Error) => void;
  /** Rendered instead of the strip when this is not the tray —
   *  `'conflict'`, `'replaced'` or `'unavailable'`. */
  fallback?: ReactNode;
  onStatusChange?: (status: TrayHostStatus) => void;
  style?: Style | Style[];
  ref?: Ref<TrayHostHandle>;
  'data-testname'?: string;
}

/**
 * The system tray, as an element.
 *
 * ```jsx
 * <TrayHost
 *   orientation="horizontal"
 *   iconSize={22}
 *   onDock={({ windowId }) => log(`docked ${windowId}`)}
 *   fallback={<text>Another tray is running.</text>}
 * />
 * ```
 *
 * Mounting takes the `_NET_SYSTEM_TRAY_S<screen>` selection and broadcasts
 * `MANAGER`, which is what makes applications that were waiting for a tray
 * dock into this one. Unmounting gives the selection up and hands every icon
 * back to the root window — a tray icon is somebody else's window, and
 * `<foreign>` never destroys one.
 *
 * **One tray per display.** Finding the selection already owned is reported
 * through `onConflict` and `status`, and nothing is embedded; losing it later
 * (`onReplaced`) releases every icon, because a panel that keeps drawing dead
 * icons is what "my tray is empty" looks like from the user's side. Neither
 * state retries by itself — a panel that wants to try again remounts this
 * component, which is a new `key`.
 *
 * **Icons stack above everything drawn in this window**, the same rule
 * `<glarea>` and `<Terminal>` have: nothing 2D can overlap them.
 */
export function TrayHost(props: TrayHostProps): ReactElement {
  const {
    orientation = 'horizontal',
    iconSize = 22,
    spacing = 2,
    screen = 0,
  } = props;
  const app = useApp();

  const strip = useRef<DrawnNode>(null);
  const windowIdOfStrip = useWindowId(strip);

  // Read through a ref so a caller passing inline arrow functions — which is
  // every caller — does not restart the tray on every paint.
  const latest = useRef(props);
  latest.current = props;

  const [icons, setIcons] = useState<readonly number[]>([]);
  // The same list, readable synchronously: two dock requests in one turn are
  // one X event each, and the second must see the first.
  const iconsRef = useRef<readonly number[]>([]);
  const [status, setStatus] = useState<TrayHostStatus>('starting');
  // …and the same for the status, so `onStatusChange` fires from the caller's
  // turn rather than from inside a state updater, which React is free to run
  // more than once.
  const statusRef = useRef<TrayHostStatus>('starting');
  // null until the ARGB question has been answered, then the visual to
  // advertise or 0 for "this window cannot composite icons". It settles once:
  // a window's visual is fixed when the window is created.
  const [visual, setVisual] = useState<number | null>(null);
  const manager = useRef<TrayManager | null>(null);

  const setIconList = useCallback((next: readonly number[]) => {
    iconsRef.current = next;
    setIcons(next);
  }, []);

  const changeStatus = useCallback((next: TrayHostStatus) => {
    if (statusRef.current === next) return;
    statusRef.current = next;
    setStatus(next);
    latest.current.onStatusChange?.(next);
  }, []);

  // --- what this host can offer icons --------------------------------------

  useEffect(() => {
    const ntk = asTrayApp(app);
    if (!ntk) {
      setVisual(0);
      return undefined;
    }
    let live = true;
    void hostVisual(ntk, screen, windowIdOfStrip()).then(
      (found) => {
        if (live) setVisual(found);
      },
      () => {
        if (live) setVisual(0);
      },
    );
    return () => {
      live = false;
    };
  }, [app, screen, windowIdOfStrip]);

  // --- being the tray ------------------------------------------------------

  useEffect(() => {
    // Waiting for the visual before taking the selection costs one round trip
    // and buys the ordering the spec asks for: an icon that docks the instant
    // it sees MANAGER must find both properties already published.
    if (visual === null) return undefined;

    const ntk = asTrayApp(app);
    if (!ntk) {
      changeStatus('unavailable');
      return undefined;
    }

    let live = true;
    const tray = new TrayManager(ntk, {
      screen,
      orientation: latest.current.orientation ?? 'horizontal',
      visual,
      onDock: (windowId) => {
        if (!live || iconsRef.current.includes(windowId)) return;
        setIconList([...iconsRef.current, windowId]);
        latest.current.onDock?.({ windowId });
      },
      onMessage: (message) => {
        if (!live) return;
        const handler = latest.current.onMessage;
        if (handler) {
          handler(message);
          return;
        }
        void notifyBalloon(message, { appName: latest.current.appName });
      },
      onMessageCancel: (info) => {
        if (live) latest.current.onMessageCancel?.(info);
      },
      onLost: () => {
        if (!live) return;
        // Unmounting the icons is what hands each client back to the root
        // window; none of them is destroyed.
        setIconList([]);
        changeStatus('replaced');
        latest.current.onReplaced?.();
      },
      onError: (err) => {
        if (live) latest.current.onError?.(err);
      },
    });
    manager.current = tray;

    void tray.start().then(
      (result) => {
        if (!live) return;
        if (result.owned) {
          changeStatus('hosting');
          return;
        }
        changeStatus('conflict');
        latest.current.onConflict?.({ owner: result.owner });
      },
      (err: unknown) => {
        if (!live) return;
        changeStatus('unavailable');
        latest.current.onError?.(err as Error);
      },
    );

    return () => {
      live = false;
      manager.current = null;
      tray.stop();
      setIconList([]);
      changeStatus('starting');
    };
  }, [app, screen, visual, changeStatus, setIconList]);

  // Orientation and the visual are republished rather than restarting the
  // tray: taking the selection again would send every icon on the display
  // round the reparenting loop for a layout change. `status` is in the
  // dependencies as the signal that there is a manager to publish through —
  // before that the value is stored and written when the window exists.
  useEffect(() => {
    manager.current?.setOrientation(orientation);
  }, [orientation, status]);

  useEffect(() => {
    if (visual !== null) manager.current?.setVisual(visual);
  }, [visual, status]);

  // --- icons ---------------------------------------------------------------

  const remove = useCallback(
    (windowId: number) => {
      if (!iconsRef.current.includes(windowId)) return;
      setIconList(iconsRef.current.filter((id) => id !== windowId));
      manager.current?.iconGone(windowId);
      latest.current.onUndock?.({ windowId });
    },
    [setIconList],
  );

  const { order } = props;
  const ordered = useMemo(() => {
    const custom = order?.(icons);
    if (!custom) return icons;
    const remaining = new Set(icons);
    // `delete` answers whether it was there, so this both filters out
    // anything that is not docked and drops a repeated id.
    const chosen = custom.filter((id) => remaining.delete(id));
    return remaining.size ? [...chosen, ...remaining] : chosen;
  }, [order, icons]);

  React.useImperativeHandle(
    props.ref,
    () => ({
      get status() {
        return status;
      },
      get windowId() {
        return manager.current?.window || null;
      },
      get icons() {
        return ordered;
      },
    }),
    [status, ordered],
  );

  const style: Style = {
    flexDirection: orientation === 'vertical' ? 'column' : 'row',
    alignItems: 'center',
    gap: spacing,
  };
  const styles: Style[] = [style];
  if (props.style) {
    for (const extra of Array.isArray(props.style)
      ? props.style
      : [props.style]) {
      styles.push(extra);
    }
  }

  // Not being the tray is an ordinary state — one display holds one — so it
  // renders whatever the app wants there rather than an error.
  if (status !== 'starting' && status !== 'hosting') {
    if (props.fallback !== undefined) {
      return h(React.Fragment, null, props.fallback);
    }
  }

  const iconStyle: Style = {
    width: iconSize,
    height: iconSize,
    // A strip that has run out of room clips; it does not squash icons into
    // something the application drew at a fixed size.
    flexGrow: 0,
    flexShrink: 0,
  };

  return hx(
    'box',
    {
      ref: strip,
      'aria-label': 'System tray',
      style: styles,
      // `data-testname` is a runtime convention — react-x11's queries read it
      // off `props` — that its element declarations do not carry.
      ...({ 'data-testname': props['data-testname'] } as object),
    },
    ordered.map((windowId) => {
      const icon: ForeignElementProps = {
        windowId,
        // A tray icon is a click target, not a tab stop. Eleven invisible
        // panes in the Tab order is the worst version of this.
        focusable: false,
        'aria-label': 'Tray icon',
        style: iconStyle,
        onClientGone: () => remove(windowId),
        onError: (err: Error) => latest.current.onError?.(err),
      };
      // The key is the window id and the `windowId` prop moves with it, so a
      // reorder moves one node rather than unmounting a node and mounting
      // another for the same client — the race react-x11's `docs/embedding.md`
      // describes, where the client is parked at the root long enough for the
      // window manager to frame it.
      return hx('foreign', { key: String(windowId), ...icon });
    }),
  );
}
