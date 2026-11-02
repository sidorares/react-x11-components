// What a page's notifications reach: the seam `<Html scripts>` shows them
// through.
//
// A page does not reach the desktop by itself. With no `scripts.notifications`
// a page finds `Notification`, as it does in a browser whose user said no:
// `permission` is `denied`, and one it makes fires `error`. A component that
// shows a page puts nothing on its reader's desktop.
//
// `useHtmlNotifications()` is one, over core's `useNotifier()`: the system's
// notification centre where the process is an app, the desktop's daemon over
// D-Bus, and a shell command where neither is there. A host that hands one and
// no `scripts.permissions` has decided, and `Notification.permission` is
// `granted`; one with a user to ask hands both.
//
// **The origin goes with the notification.** A page writes its title and its
// body, so what says who wrote them has to be the host's: a banner reading
// "Your bank" with nothing beside it is the page's word for it.
import { useMemo, useRef } from 'react';
import { useNotifier } from 'react-x11';

declare const URL: new (url: string) => { host: string };

/** What a page asked to show. */
export interface HtmlNotification {
  title: string;
  body: string;
  /** The document's origin, which a host shows with it. */
  origin: string;
  /** Replaces the page's last notification of this tag, or '' for none. */
  tag: string;
  /** Absolute URLs, or ''. Nothing is fetched for them: a host that shows
   *  one asks for it as it would for anything else of the page's. */
  icon: string;
  image: string;
  badge: string;
  lang: string;
  dir: 'auto' | 'ltr' | 'rtl';
  /** Whether to make no sound, or null for the desktop's habit. */
  silent: boolean | null;
  /** Whether it stays until the user dismisses it. */
  requireInteraction: boolean;
  /** Whether a replacement alerts the user again. */
  renotify: boolean;
  /** Milliseconds since the epoch: when what it says happened. */
  timestamp: number;
}

/** What a host tells a page of what became of a notification. */
export interface HtmlNotificationEvents {
  /** The user clicked it. */
  click(): void;
  /** It went, by the user's hand or the desktop's. */
  close(): void;
}

/** A notification that is showing. */
export interface HtmlShownNotification {
  /** Take it down: the page closed it, or the page is gone. */
  close(): void | Promise<unknown>;
}

/** How a page's notifications reach the user. */
export interface HtmlNotifications {
  /** Show one. Rejecting is an `error` at the page's notification. */
  show(
    notification: HtmlNotification,
    events: HtmlNotificationEvents,
  ): Promise<HtmlShownNotification>;
  /** The user clicked a notification and the page did not `preventDefault`
   *  it: bring the page to them. */
  focus?(): void;
}

/** What a daemon takes for markup, which a page's text is not. */
const escapeMarkup = (text: string): string =>
  text.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;',
  );

/** An origin as a person reads it. */
const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
};

/**
 * The desktop's notifications, as `scripts.notifications` takes them. What
 * comes back depends on where they land: the desktop's daemon reports a click
 * and a close, and a shell command reports neither, so a page there hears
 * `show` and nothing after it.
 */
export function useHtmlNotifications(): HtmlNotifications {
  const notifier = useNotifier();
  const backend = useRef(notifier.backend);
  backend.current = notifier.backend;
  return useMemo(
    () => ({
      show: async (notification, events) => {
        const where = hostOf(notification.origin);
        // the daemons read a body as markup, and a page's `<img>` in one
        // would be a request nobody made; a rung that does not read markup
        // shows the text as it is
        const rung = backend.current;
        const marked = rung !== 'cocoa' && rung !== 'osascript';
        const banner = await notifier.notify({
          summary: notification.title,
          body: marked ? escapeMarkup(notification.body) : notification.body,
          subtitle: where,
          appName: where,
          silent: notification.silent === true,
          ...(notification.requireInteraction && { timeout: 0 }),
          onAction: (key: string) => {
            if (key === 'default') events.click();
          },
          onClose: () => events.close(),
        });
        return { close: () => banner.close() };
      },
    }),
    [notifier.notify],
  );
}

/** Notifications that reach nothing: what a test hands a page, and how it
 *  clicks and dismisses them. */
export function memoryNotifications(): HtmlNotifications & {
  shown: (HtmlNotification & HtmlNotificationEvents)[];
  focused: number;
} {
  const held: {
    shown: (HtmlNotification & HtmlNotificationEvents)[];
    focused: number;
  } & HtmlNotifications = {
    shown: [],
    focused: 0,
    show(notification, events) {
      const entry = { ...notification, ...events };
      held.shown.push(entry);
      return Promise.resolve({
        close() {
          const at = held.shown.indexOf(entry);
          if (at >= 0) held.shown.splice(at, 1);
        },
      });
    },
    focus() {
      held.focused += 1;
    },
  };
  return held;
}
