// <TrayHost> — the system tray, on `<foreign>`.
//
// The third XEmbed consumer in this package and the one pointed the other
// way: `<Terminal>` and `<MediaPlayer>` spawn a program *into* a container,
// while a tray is handed windows by applications that were already running.
// Everything hard about taking one — the reparent, the save set,
// `_XEMBED_INFO`, the focus messages, the synthetic ICCCM ConfigureNotify,
// and handing the client back **without destroying it** on unmount — is
// core's `<foreign>` and is done (react-x11#277).
//
// What is left, and what is here:
//
//  - **`./manager.ts`** — the `_NET_SYSTEM_TRAY_S<screen>` selection, the
//    `MANAGER` broadcast, the two advertised properties, opcode routing and
//    `SelectionClear`.
//  - **`./protocol.ts`** — the spec as data: atoms, opcodes, the balloon
//    reassembler, and whether a visual may honestly be advertised.
//  - **this file** — the icon list as React state, one `<foreign>` per icon.
//
// Registers no element: `<foreign>` and `<box>` are both built in. Like
// `<Terminal>`, this module has **no side effect at import time at all**.
//
// ### What is deliberately not here
//
// **StatusNotifierItem.** Modern applications publish a tray icon over D-Bus
// rather than XEmbed, and a complete panel supports both — but SNI shares
// nothing with this except intent, and it pairs with core's `dbusmenu.js`
// rather than with `<foreign>`. It is a sibling component, not a mode of
// this one.
//
// **The plug side.** Being embedded *as* a tray icon is a root option that
// changes how a connection's first window is created, which is renderer
// internals by definition. Same protocol, opposite side of the seam, and
// core's.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { useApp, useWindowId } from 'react-x11';
import type { BoxProps, DrawnNode, ForeignProps } from 'react-x11';
import type { Style } from 'react-x11/style';

import { hx } from './hx.js';
import { TrayManager } from './manager.js';
import type { TrayApp, TrayConflict, TrayStatus } from './manager.js';
import { BalloonNotifier } from './notify.js';
import type { TrayIcon, TrayMessage, TrayOrientation } from './protocol.js';

export {
  BalloonAssembler,
  MANAGER_ATOM,
  MESSAGE_DATA_ATOM,
  OPCODE_ATOM,
  ORIENTATION_ATOM,
  ORIENTATION_HORIZONTAL,
  ORIENTATION_VERTICAL,
  SYSTEM_TRAY_BEGIN_MESSAGE,
  SYSTEM_TRAY_CANCEL_MESSAGE,
  SYSTEM_TRAY_REQUEST_DOCK,
  VISUAL_ATOM,
  argbVisualOf,
  decodeUtf8,
  orientationValue,
  selectionNameFor,
} from './protocol.js';
export type { TrayIcon, TrayMessage, TrayOrientation } from './protocol.js';
export { TrayManager } from './manager.js';
export type {
  TrayApp,
  TrayConflict,
  TrayManagerHandlers,
  TrayManagerStartOptions,
  TrayStatus,
} from './manager.js';
export { BalloonNotifier } from './notify.js';

const h = React.createElement;

/** `<foreign>`'s and `<box>`'s props as `hx` takes them — `theme` is dropped
 *  because `hx` re-declares it (see `./hx.ts`). */
type ForeignElementProps = Omit<ForeignProps, 'theme'>;
type BoxElementProps = Omit<BoxProps, 'theme'>;

const NO_ICONS: readonly TrayIcon[] = [];

/** What a `ref` on `<TrayHost>` gets. */
export interface TrayHostHandle {
  readonly status: TrayStatus;
  /** Who owns the selection, when this host does not. */
  readonly conflict: TrayConflict | null;
  /** The docked icons, in the order they are rendered. */
  readonly icons: readonly TrayIcon[];
  /** The manager selection window — the address clients send opcodes to. */
  readonly windowId: number | null;
}

export interface TrayHostProps {
  /**
   * Which way the icons run, and what `_NET_SYSTEM_TRAY_ORIENTATION` says so
   * an icon can draw itself to match. Default `'horizontal'`.
   */
  orientation?: TrayOrientation;
  /** The square each icon is laid out in, in pixels. Default 22. */
  iconSize?: number;
  /** Between icons. Default 2. */
  spacing?: number;
  /** Which screen's selection to own. Default 0. */
  screen?: number;
  /**
   * Render order. Icons are otherwise in the order they docked.
   *
   * A comparator rather than a sorted list because **node identity has to
   * stay with the icon**: each `<foreign>` is keyed on the window id and its
   * `windowId` never changes, so reordering moves the node instead of
   * releasing a client from one node and re-embedding it in another. That
   * hand-off is a documented race — the client is parked at the root long
   * enough for a window manager to frame it, and the second node then
   * reports `onClientGone` for a live window.
   */
  sort?: (a: TrayIcon, b: TrayIcon) => number;
  /** An application asked to be in the tray, and now is. */
  onDock?: (icon: TrayIcon) => void;
  /** Its window went away — the ordinary end of a tray icon's life, not an
   *  error. Also fires for every icon when the selection is lost. */
  onUndock?: (icon: TrayIcon) => void;
  /**
   * Another tray already owns this screen's selection, so this one embeds
   * nothing. A second panel on one display is a configuration mistake rather
   * than an exception, which is why it arrives here instead of throwing.
   */
  onConflict?: (info: TrayConflict) => void;
  onStatusChange?: (status: TrayStatus) => void;
  /**
   * A balloon message. **Providing this turns off the default**, which is to
   * forward the text to the desktop's notification service — a panel that
   * draws its own bubble should not also raise a notification.
   */
  onMessage?: (message: TrayMessage) => void;
  /** A message was withdrawn before it finished arriving. */
  onCancelMessage?: (info: { windowId: number; id: number }) => void;
  /** Failures on the wire, and a notification that could not be delivered.
   *  Without a handler none of it is reported anywhere. */
  onError?: (err: Error) => void;
  /** False stops balloon messages being forwarded to the notification
   *  service. Ignored when `onMessage` is given, which already replaces it. */
  notify?: boolean;
  /** Who a forwarded balloon message is attributed to. Default
   *  `'System Tray'`. */
  appName?: string;
  /** Rendered instead of the tray when another host owns the selection. */
  fallback?: ReactNode;
  style?: Style | Style[];
  ref?: Ref<TrayHostHandle>;
  'data-testname'?: string;
}

/**
 * The system tray: applications dock their icons into it, and it lays them
 * out like any other row of elements.
 *
 * ```jsx
 * <TrayHost
 *   orientation="horizontal"
 *   iconSize={22}
 *   onDock={(icon) => log(`docked ${icon.id}`)}
 *   onUndock={(icon) => log(`gone ${icon.id}`)}
 * />
 * ```
 *
 * **One per display.** Mounting takes `_NET_SYSTEM_TRAY_S<screen>` and
 * announces it to the root, which is what makes applications that were
 * waiting start docking; unmounting gives the selection back and hands every
 * client back to the root untouched.
 *
 * **An icon that never maps is normal.** Clients set `XEMBED_MAPPED` when
 * they are ready, and some take a while about it. The square is laid out
 * either way, because a tray that only reserved space for icons it could see
 * would reflow every time one woke up.
 *
 * **Icons are not tab stops.** A tray icon is a click target, and Tab
 * walking through eleven of them — several of which are invisible — is the
 * worst version of this, so every `<foreign>` here is `focusable={false}`.
 */
export function TrayHost(props: TrayHostProps): ReactElement {
  const {
    orientation = 'horizontal',
    iconSize = 22,
    spacing = 2,
    screen = 0,
  } = props;

  const app = useApp() as TrayApp;
  const [icons, setIcons] = useState<readonly TrayIcon[]>(NO_ICONS);
  // Only the status is state. The conflict itself is read off the manager by
  // the handle: nothing renders it, and mirroring it would be a second copy
  // of a fact that already has an owner.
  const [status, setStatus] = useState<TrayStatus>('starting');

  const boxRef = useRef<DrawnNode>(null);
  const hostWindowId = useWindowId(boxRef);

  // Read at the moment they fire, so an inline `onDock` is not a reason to
  // give the selection up and take it again.
  const latest = useRef(props);
  latest.current = props;

  const manager = useMemo(() => new TrayManager(app, screen), [app, screen]);

  useEffect(() => {
    const notifier = new BalloonNotifier();
    manager.handlers = {
      onIcons: setIcons,
      onDock: (icon) => latest.current.onDock?.(icon),
      onUndock: (icon) => latest.current.onUndock?.(icon),
      onStatus: (next, info) => {
        setStatus(next);
        latest.current.onStatusChange?.(next);
        if (next === 'conflict' && info) latest.current.onConflict?.(info);
      },
      onMessage: (message) => {
        const own = latest.current.onMessage;
        // The seam wins: a panel drawing its own bubble should not also
        // raise a notification for the same text.
        if (own) {
          own(message);
          return;
        }
        if (latest.current.notify === false) return;
        void notifier
          .send(message, latest.current.appName)
          .catch((err: unknown) =>
            latest.current.onError?.(
              err instanceof Error ? err : new Error(String(err)),
            ),
          );
      },
      onCancelMessage: (info) => latest.current.onCancelMessage?.(info),
      onError: (err) => latest.current.onError?.(err),
    };
    // The orientation is read here rather than being a dependency: changing
    // it republishes one property (below) and must not cost the selection.
    void manager.start({
      orientation: latest.current.orientation ?? 'horizontal',
      hostWindowId: hostWindowId(),
    });
    return () => {
      manager.stop();
      void notifier.dispose();
    };
  }, [manager, hostWindowId]);

  useEffect(() => {
    manager.setOrientation(orientation);
  }, [manager, orientation]);

  React.useImperativeHandle(
    props.ref,
    () => ({
      get status() {
        return manager.status;
      },
      get conflict() {
        return manager.conflict;
      },
      get icons() {
        return manager.icons;
      },
      get windowId() {
        return manager.windowId || null;
      },
    }),
    [manager],
  );

  const sort = props.sort;
  const ordered = useMemo(
    () => (sort ? [...icons].sort(sort) : icons),
    [icons, sort],
  );

  const styles: Style[] = [
    {
      flexDirection: orientation === 'vertical' ? 'column' : 'row',
      alignItems: 'center',
      gap: spacing,
    },
  ];
  if (props.style) {
    for (const extra of Array.isArray(props.style)
      ? props.style
      : [props.style]) {
      styles.push(extra);
    }
  }

  // Somebody else is the tray, and this host has embedded nothing. Rendering
  // an empty row would look like a tray with no icons in it, which is the
  // one thing it must not be mistaken for.
  if (status === 'conflict' && props.fallback !== undefined) {
    return h(React.Fragment, null, props.fallback);
  }

  const children = ordered.map((icon) => {
    const foreign: ForeignElementProps = {
      // Keyed **and** addressed by the same id, so a reorder is a move: the
      // node keeps its socket and the client is never handed between two.
      key: icon.id,
      windowId: icon.id,
      focusable: false,
      'aria-label': 'Tray icon',
      onClientGone: () => manager.undock(icon.id),
      style: { width: iconSize, height: iconSize, flexShrink: 0 },
    };
    return hx('foreign', {
      ...foreign,
      'data-testname': `tray-icon-${icon.id}`,
    } as ForeignElementProps);
  });

  const container: BoxElementProps = { ref: boxRef, style: styles };

  // `data-testname` is a runtime convention — react-x11's queries read it off
  // `props` — and its element declarations do not carry it. Attached past the
  // type so the rest of the object is still checked against `<box>`.
  return hx(
    'box',
    {
      ...container,
      'data-testname': props['data-testname'],
    } as BoxElementProps,
    ...children,
  );
}
