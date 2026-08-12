// The freedesktop system tray protocol, as data and pure functions.
//
// Everything in this file can be asserted without an X server, which is the
// point: the [system tray spec][spec] is short and unambiguous, and the half
// of it that is *decisions* — which atom, which opcode, how the bytes of a
// balloon message reassemble, whether a visual may honestly be advertised —
// should not need a display to test.
//
// The other half, the half that talks to the server, is `./manager.ts`.
//
// [spec]: http://specifications.freedesktop.org/systemtray/latest/

/** `_NET_SYSTEM_TRAY_OPCODE` `data[1]`, from the spec's own names. */
export const SYSTEM_TRAY_REQUEST_DOCK = 0;
export const SYSTEM_TRAY_BEGIN_MESSAGE = 1;
export const SYSTEM_TRAY_CANCEL_MESSAGE = 2;

/** Property and message atom names. */
export const OPCODE_ATOM = '_NET_SYSTEM_TRAY_OPCODE';
export const ORIENTATION_ATOM = '_NET_SYSTEM_TRAY_ORIENTATION';
export const VISUAL_ATOM = '_NET_SYSTEM_TRAY_VISUAL';
export const MESSAGE_DATA_ATOM = '_NET_SYSTEM_TRAY_MESSAGE_DATA';
/** ICCCM 2.8: what a manager broadcasts to the root once it owns its
 *  selection, and what a client waiting for a tray is listening for. */
export const MANAGER_ATOM = 'MANAGER';

/** Which way the panel runs, so icons can draw themselves to match. */
export type TrayOrientation = 'horizontal' | 'vertical';

/** `_NET_SYSTEM_TRAY_ORIENTATION`'s two values. */
export const ORIENTATION_HORIZONTAL = 0;
export const ORIENTATION_VERTICAL = 1;

export function orientationValue(orientation: TrayOrientation): number {
  return orientation === 'vertical'
    ? ORIENTATION_VERTICAL
    : ORIENTATION_HORIZONTAL;
}

/** One selection per screen: `_NET_SYSTEM_TRAY_S0` on the first. */
export function selectionNameFor(screen: number): string {
  return `_NET_SYSTEM_TRAY_S${screen}`;
}

/** A docked tray icon: the client's top-level window, and nothing else this
 *  package invented. The object identity is stable for as long as the icon
 *  is docked, so it is safe to hold onto. */
export interface TrayIcon {
  /** The client's X window id — what `<foreign windowId>` embeds. */
  readonly id: number;
}

/** A balloon message: what an icon says when it has no notification daemon
 *  to say it through. */
export interface TrayMessage {
  /** The icon that is talking. */
  readonly windowId: number;
  /** The client's own id for the message — what a cancel names. */
  readonly id: number;
  /** Milliseconds the client asked for it to stay up. `0` means "until the
   *  user dismisses it", which is also what the notification spec means by
   *  a zero expiry, so it passes straight through. */
  readonly timeout: number;
  readonly text: string;
}

/**
 * The visual id to publish as `_NET_SYSTEM_TRAY_VISUAL`, or `0` for none.
 *
 * `visual` is the visual of the window the icons will be embedded into —
 * ntk creates a `<foreign>`'s container as an ordinary child, so it inherits
 * the top-level window's visual, and that is the one an icon reparented into
 * it will live on.
 *
 * **Advertising a visual we do not have is worse than advertising none.** A
 * client that believes this creates its icon with an alpha channel; drawn on
 * a display with no compositor, or into a 24-bit parent, the transparent
 * parts come out black. So the answer is yes only when the window genuinely
 * carries a 32-bit TrueColor visual, and the fallback — an icon guessing our
 * background — is the one that has always worked.
 */
export function argbVisualOf(
  screen:
    | { depths?: Record<number, Record<string, { class?: number }>> }
    | null
    | undefined,
  visual: number,
): number {
  if (!visual) return 0;
  const deep = screen?.depths?.[32];
  if (!deep) return 0;
  const found = deep[String(visual)];
  // TrueColor. The depth-32 list is where an ARGB visual lives, but the
  // class is what says the channels are direct rather than looked up.
  return found?.class === 4 ? visual : 0;
}

/**
 * UTF-8, decoded from the raw bytes a ClientMessage carries.
 *
 * Hand-rolled rather than reached through `TextDecoder` on `globalThis`
 * because it is twenty lines, it is pure, and it makes the balloon tests
 * independent of whichever runtime the suite happens to run on. Malformed
 * input degrades to U+FFFD rather than throwing: a tray that refuses a
 * message because a client sent it latin-1 is a tray that loses the message.
 */
export function decodeUtf8(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i]! & 0xff;
    let code = 0xfffd;
    let size = 1;
    if (b0 < 0x80) {
      code = b0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      size = 2;
      code = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      size = 3;
      code = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      size = 4;
      code = b0 & 0x07;
    }
    if (size > 1) {
      if (i + size > bytes.length) return out + '�';
      for (let k = 1; k < size; k++) {
        const cont = bytes[i + k]! & 0xff;
        if ((cont & 0xc0) !== 0x80) {
          code = 0xfffd;
          size = 1;
          break;
        }
        code = (code << 6) | (cont & 0x3f);
      }
    }
    if (code > 0x10ffff) code = 0xfffd;
    out += String.fromCodePoint(code);
    i += size;
  }
  return out;
}

interface Pending {
  id: number;
  timeout: number;
  /** Bytes the client said it would send. */
  length: number;
  bytes: number[];
}

/**
 * Balloon messages, reassembled.
 *
 * A client announces one with `SYSTEM_TRAY_BEGIN_MESSAGE` and then sends the
 * text in 20-byte `_NET_SYSTEM_TRAY_MESSAGE_DATA` chunks, the last of which
 * is padded. **The data messages carry no message id** — only the icon's
 * window — so one message per icon can be in flight at a time, which is the
 * protocol's own limit and the reason this is keyed on the window.
 *
 * Pure, and driven entirely by what arrived: `../manager.ts` decides nothing
 * about a message beyond which icon it came from.
 */
export class BalloonAssembler {
  #pending = new Map<number, Pending>();

  /** How many messages are half-arrived. Tests read it; nothing else needs it. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * `SYSTEM_TRAY_BEGIN_MESSAGE`. Returns the message when it needs no data at
   * all — a zero-length one is complete the moment it is announced, and a
   * host that waited for a chunk that never comes would leak it.
   */
  begin(
    windowId: number,
    info: { id: number; timeout: number; length: number },
  ): TrayMessage | null {
    const length = Math.max(0, info.length | 0);
    const pending: Pending = {
      id: info.id >>> 0,
      timeout: Math.max(0, info.timeout | 0),
      length,
      bytes: [],
    };
    if (length === 0) {
      this.#pending.delete(windowId);
      return { windowId, id: pending.id, timeout: pending.timeout, text: '' };
    }
    // A second BEGIN before the first finished replaces it: the client moved
    // on, and holding half of an abandoned message forever is the leak.
    this.#pending.set(windowId, pending);
    return null;
  }

  /** One `_NET_SYSTEM_TRAY_MESSAGE_DATA` chunk. Returns the message once the
   *  announced number of bytes has arrived. */
  data(windowId: number, chunk: readonly number[]): TrayMessage | null {
    const pending = this.#pending.get(windowId);
    // Data for a message nobody announced. Dropped rather than guessed at:
    // without a BEGIN there is no id, no timeout and no length to stop at.
    if (!pending) return null;
    for (const byte of chunk) {
      if (pending.bytes.length >= pending.length) break;
      pending.bytes.push(byte & 0xff);
    }
    if (pending.bytes.length < pending.length) return null;
    this.#pending.delete(windowId);
    return {
      windowId,
      id: pending.id,
      timeout: pending.timeout,
      text: decodeUtf8(pending.bytes),
    };
  }

  /** `SYSTEM_TRAY_CANCEL_MESSAGE`. True when there was one to cancel. */
  cancel(windowId: number, id: number): boolean {
    const pending = this.#pending.get(windowId);
    if (!pending || pending.id !== id >>> 0) return false;
    this.#pending.delete(windowId);
    return true;
  }

  /** The icon went away mid-message. */
  forget(windowId: number): void {
    this.#pending.delete(windowId);
  }

  clear(): void {
    this.#pending.clear();
  }
}
