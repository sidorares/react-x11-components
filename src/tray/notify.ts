// Where a balloon message goes when the panel does not draw its own.
//
// `SYSTEM_TRAY_BEGIN_MESSAGE` is the pre-notification-daemon way an icon says
// something, and applications old enough to still send it are exactly the ones
// with no other channel — so a host that drops them leaves them silently
// unable to speak. Forwarding to `org.freedesktop.Notifications` is the
// smallest thing that is not dropping them, and `<TrayHost onMessage>` is the
// seam for a panel that would rather draw the balloon itself.
//
// Two rules from `../desktop-calendar/`, and both apply unchanged: **never
// open your own bus** — `sessionBus()` hands over react-x11's shared
// connection, and a second one would make the app two names on the bus — and
// the call takes its bus as an argument, which is what lets a test drive it
// from a fake one.
import { sessionBus } from 'react-x11';
import type { MessageBus } from 'react-x11';

import type { TrayMessage } from './protocol.js';

const NOTIFICATIONS = 'org.freedesktop.Notifications';
const NOTIFICATIONS_PATH = '/org/freedesktop/Notifications';

/** `org.freedesktop.Notifications.Notify`, as much of it as is used here. */
interface NotificationsIface {
  Notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    actions: readonly string[],
    hints: readonly unknown[],
    expireTimeout: number,
  ): Promise<number>;
}

/**
 * A tray message has one string and a notification has two fields, so the
 * first line becomes the summary and the rest the body. That is the shape
 * these messages are written in — a short first line and detail under it —
 * and it degrades to a one-line notification when there is no rest.
 */
function split(text: string): { summary: string; body: string } {
  const at = text.indexOf('\n');
  if (at < 0) return { summary: text, body: '' };
  return { summary: text.slice(0, at), body: text.slice(at + 1).trim() };
}

/**
 * Show `message` through the desktop's notification service.
 *
 * Takes the bus rather than opening one. Resolves with the notification id,
 * or 0 where the service answered nothing useful; rejects only if the call
 * itself failed, which the caller is expected to treat as "this desktop has
 * no notification daemon" rather than as an error.
 */
export async function sendNotification(
  bus: MessageBus,
  message: TrayMessage,
  appName = 'System Tray',
): Promise<number> {
  const service = (await bus
    .getService(NOTIFICATIONS)
    .getInterface(
      NOTIFICATIONS_PATH,
      NOTIFICATIONS,
    )) as unknown as NotificationsIface;
  const { summary, body } = split(message.text);
  const id = await service.Notify(
    appName,
    0,
    '',
    summary,
    body,
    [],
    [],
    // Both protocols measure in milliseconds and both spell "do not expire"
    // as 0, so the timeout passes straight through.
    message.timeout,
  );
  return typeof id === 'number' ? id : 0;
}

/**
 * The default `onMessage`: forward to the notification service if there is
 * one, and do nothing at all if there is not.
 *
 * Never throws. No session bus and no notification daemon are both ordinary
 * states of a perfectly healthy machine — the same call
 * `useDesktopCalendarEvents` makes about a desktop with no Evolution Data
 * Server — so neither is reported as an error.
 */
export async function notifyBalloon(
  message: TrayMessage,
  options: { appName?: string } = {},
): Promise<void> {
  let ref;
  try {
    ref = await sessionBus();
  } catch {
    return;
  }
  if (!ref) return;
  try {
    await sendNotification(ref.bus, message, options.appName);
  } catch {
    // no daemon on this bus, or it refused: the message is not shown, which
    // is what would have happened without this path at all
  } finally {
    await ref.release();
  }
}
