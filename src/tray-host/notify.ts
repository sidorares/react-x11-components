// Balloon messages, forwarded to the desktop's notification service.
//
// `SYSTEM_TRAY_BEGIN_MESSAGE` is the pre-notification-daemon way an icon says
// something, and older applications still emit it. A host that ignores it
// leaves them silently unable to speak — so the default is to hand the text
// to whatever the desktop already uses for notifications, and `onMessage` is
// the seam for a panel that would rather draw its own bubble.
//
// **Nothing here opens a bus.** `sessionBus()` hands over react-x11's shared
// connection, so the tray, the app's exported service and its menu are one
// name on the bus rather than three. No bus, or no notification service, is
// an ordinary state of a healthy machine: the message is dropped, and the
// error says so for a caller that wants to know.
import { sessionBus } from 'react-x11';
import type { BusRef } from 'react-x11';

import type { TrayMessage } from './protocol.js';

const SERVICE = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';

/** The one method this needs, named structurally — `dbus-native` resolves
 *  the interface by introspection and has no types of its own here. */
interface NotificationsIface {
  Notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    actions: string[],
    hints: unknown[],
    expireTimeout: number,
  ): Promise<number>;
}

/**
 * A lazily-acquired claim on the session bus, and the `Notify` call over it.
 *
 * Lazy on purpose: a panel that never receives a balloon message never dials
 * the bus, and `sessionBus()` is shared, so the claim costs a reference
 * rather than a connection.
 */
export class BalloonNotifier {
  #ref: BusRef | null = null;
  #acquiring: Promise<BusRef | null> | null = null;
  #disposed = false;

  async #bus(): Promise<BusRef | null> {
    if (this.#ref) return this.#ref;
    // Not cached as a failure: `sessionBus()` never caches one either, so a
    // bus that appears later is found.
    this.#acquiring ??= sessionBus().finally(() => {
      this.#acquiring = null;
    });
    const ref = await this.#acquiring;
    if (this.#disposed) {
      void ref?.release();
      return null;
    }
    this.#ref = ref;
    return ref;
  }

  /**
   * Show `message`. Resolves false when there was nothing to show it with.
   *
   * The balloon's timeout passes straight through: both protocols measure it
   * in milliseconds and both read 0 as "until the user dismisses it".
   */
  async send(message: TrayMessage, appName = 'System Tray'): Promise<boolean> {
    const ref = await this.#bus();
    if (!ref || this.#disposed) return false;
    const iface = (await ref.bus
      .getService(SERVICE)
      .getInterface(PATH, SERVICE)) as NotificationsIface;
    // A balloon is one string. The first line reads as a title everywhere a
    // notification is drawn, so it is used as one rather than padding the
    // summary with the application's name.
    const [summary = '', ...rest] = message.text.split('\n');
    await iface.Notify(
      appName,
      0,
      '',
      summary,
      rest.join('\n'),
      [],
      [],
      message.timeout,
    );
    return true;
  }

  /** Drop the claim. Never closes the connection — that is the app's call,
   *  and every other consumer is on the same socket. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const ref = this.#ref;
    this.#ref = null;
    if (ref) await ref.release();
  }
}
