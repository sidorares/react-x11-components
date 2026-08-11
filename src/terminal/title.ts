// `onTitleChange`, which is a property on somebody else's window.
//
// A terminal announces what is running in it by writing `_NET_WM_NAME` (and
// the older latin-1 `WM_NAME`) on its own top-level window — the OSC 0/2
// escape a shell prompt sends ends up there. So a tab strip that says
// `npm test` rather than `xterm` is a property read, not a pipe.
//
// **Why this is not polling.** `<foreign>`'s socket already selects
// `PropertyChange` on the client, because that is how `_XEMBED_INFO` is
// watched — so the client window ntk holds is already emitting `'property'`
// events and there is nothing to select, nothing to restore, and no interval
// to run. All this file does is listen to a window that is already listening.
//
// **Why the window is asked for rather than reached for.** `app.createWindow({
// id })` returns the *cached* `Window` for an id ntk already knows (window.js
// keeps one per connection), so this is the same object the socket holds
// rather than a second wrapper with its own event registration. The
// alternative — walking `node.socket.client` off the `onEmbedded` node — would
// be reaching into react-x11's internals for something its public app object
// already answers.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from 'react-x11';

/**
 * The slice of ntk this file uses.
 *
 * Written out structurally rather than imported, for the reason
 * `../desktop-calendar/ical.ts` gives at length: `useApp()` is declared
 * `unknown` in react-x11's types, and ntk is not a dependency of this package.
 */
interface PropertyEvent {
  atom: number;
}

interface NtkWindowLike {
  id: number;
  atom(name: string): Promise<number>;
  getProperty(
    name: string,
    options?: { as?: 'string' | 'buffer' | 'numbers' },
  ): Promise<unknown>;
  on(event: 'property', listener: (ev: PropertyEvent) => void): void;
  removeListener(
    event: 'property',
    listener: (ev: PropertyEvent) => void,
  ): void;
}

interface NtkAppLike {
  createWindow(args: { id: number }): NtkWindowLike;
}

function asApp(app: unknown): NtkAppLike | null {
  const candidate = app as NtkAppLike | null;
  return typeof candidate?.createWindow === 'function' ? candidate : null;
}

/**
 * `_NET_WM_NAME`, falling back to `WM_NAME`.
 *
 * The order is EWMH's: `_NET_WM_NAME` is UTF-8 and is what every terminal
 * written this century sets, `WM_NAME` is latin-1 and is what one written
 * before it sets. A client that sets both sets them to the same thing.
 */
async function readTitle(window: NtkWindowLike): Promise<string | null> {
  for (const name of ['_NET_WM_NAME', 'WM_NAME']) {
    const value = await window.getProperty(name, { as: 'string' });
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export interface ForeignTitleHandlers {
  onEmbedded: (info: { id: number }) => void;
  onClientGone: () => void;
}

/**
 * Watch the embedded client's title.
 *
 * Returns the two `<foreign>` handlers to spread, which is why this is a hook
 * and not an effect the component writes itself: the client id exists only
 * between `onEmbedded` and `onClientGone`, and both of those are props the
 * component also wants to forward to its own caller.
 *
 * ```js
 * const title = useForeignTitle(props.onTitleChange);
 * <foreign onEmbedded={title.onEmbedded} onClientGone={title.onClientGone} />
 * ```
 *
 * With no `onTitleChange` nothing is read at all — no atoms interned, no round
 * trip — because most terminals in most apps are not labelled.
 */
export function useForeignTitle(
  onTitleChange?: (title: string) => void,
): ForeignTitleHandlers {
  const app = useApp();
  const enabled = Boolean(onTitleChange);

  // Read when the property changes rather than when the prop does, so a
  // caller passing an inline arrow function does not re-subscribe.
  const notify = useRef(onTitleChange);
  notify.current = onTitleChange;

  // 0 is X None, which is how "nothing embedded" is spelled everywhere else
  // in this stack. The setter is guarded so that an `onEmbedded` for the
  // client that is already current does not re-run the effect.
  const [clientId, setClientId] = useState(0);

  const onEmbedded = useCallback((info: { id: number }) => {
    setClientId(info.id);
  }, []);
  const onClientGone = useCallback(() => setClientId(0), []);

  useEffect(() => {
    const ntk = asApp(app);
    if (!enabled || !ntk || !clientId) return undefined;

    let live = true;
    let window: NtkWindowLike;
    try {
      window = ntk.createWindow({ id: clientId });
    } catch {
      // the client went away between the event and this effect
      return undefined;
    }

    let last: string | null = null;
    let onProperty: ((ev: PropertyEvent) => void) | null = null;

    const refresh = (): void => {
      void readTitle(window).then(
        (title) => {
          if (!live || title === null || title === last) return;
          last = title;
          notify.current?.(title);
        },
        () => {
          // the window is gone; `onClientGone` is the event that says so
        },
      );
    };

    void (async () => {
      let watched: Set<number>;
      try {
        const [netName, wmName] = await Promise.all([
          window.atom('_NET_WM_NAME'),
          window.atom('WM_NAME'),
        ]);
        watched = new Set([netName, wmName]);
      } catch {
        return;
      }
      if (!live) return;
      onProperty = (ev: PropertyEvent): void => {
        if (watched.has(ev.atom)) refresh();
      };
      window.on('property', onProperty);
      // A terminal has usually set its title before it has a window worth
      // embedding, so the first value is a read rather than an event.
      refresh();
    })();

    return () => {
      live = false;
      if (onProperty) window.removeListener('property', onProperty);
    };
  }, [app, enabled, clientId]);

  return { onEmbedded, onClientGone };
}
