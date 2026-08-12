// The freedesktop system tray protocol, as constants and one assembler.
//
// Nothing here touches X. That is deliberate: the protocol is short, every
// value in it is a magic number somebody has to get right, and the half that
// is genuinely fiddly — reassembling a balloon message from 20-byte
// ClientMessages — is pure and therefore testable without a server.
//
// Spec: http://specifications.freedesktop.org/systemtray/latest/
/** `_NET_SYSTEM_TRAY_S<screen>` — the selection a tray owns to be the tray. */
export function traySelectionName(screen: number): string {
  return `_NET_SYSTEM_TRAY_S${screen}`;
}

/** The ICCCM 2.8 broadcast that tells waiting clients a manager arrived. */
export const MANAGER = 'MANAGER';
/** Dock requests and balloon messages both arrive under this type. */
export const TRAY_OPCODE = '_NET_SYSTEM_TRAY_OPCODE';
/** The bytes of a balloon message, 20 at a time. */
export const TRAY_MESSAGE_DATA = '_NET_SYSTEM_TRAY_MESSAGE_DATA';
/** Which way the strip runs, so an icon can lay itself out to match. */
export const TRAY_ORIENTATION = '_NET_SYSTEM_TRAY_ORIENTATION';
/** The visual to draw icons on, when the host can composite ARGB. */
export const TRAY_VISUAL = '_NET_SYSTEM_TRAY_VISUAL';

export const SYSTEM_TRAY_REQUEST_DOCK = 0;
export const SYSTEM_TRAY_BEGIN_MESSAGE = 1;
export const SYSTEM_TRAY_CANCEL_MESSAGE = 2;

/** Which way a tray strip runs. */
export type TrayOrientation = 'horizontal' | 'vertical';

/** `_NET_SYSTEM_TRAY_ORIENTATION`'s two values. */
export const ORIENTATION_VALUE: Record<TrayOrientation, number> = {
  horizontal: 0,
  vertical: 1,
};

// X core event types (X11 protocol §11). Named here because this package
// reads raw events off the connection — react-x11 has no per-window
// ClientMessage seam yet, so the filtering is ours to do.
export const PROPERTY_NOTIFY = 28;
export const SELECTION_CLEAR = 29;
export const CLIENT_MESSAGE = 33;

// Predefined atoms (X11 protocol appendix B): no InternAtom round trip.
export const CARDINAL = 6;
export const VISUALID = 32;

// x11.eventMask, spelled out for the same reason src/xsettings.js spells its
// one out: the package has no runtime dependency on node-x11.
export const STRUCTURE_NOTIFY_MASK = 0x00020000;
export const PROPERTY_CHANGE_MASK = 0x00400000;

/** ChangeProperty modes. */
export const PROP_REPLACE = 0;
export const PROP_APPEND = 2;

/** A balloon message an icon asked the host to show. */
export interface TrayMessage {
  /** The icon that is speaking. */
  windowId: number;
  /** The icon's own id for it, which is what a cancel names. */
  id: number;
  /** Milliseconds the icon asked for. 0 means "until it is dismissed". */
  timeout: number;
  /** UTF-8, reassembled. */
  text: string;
}

/**
 * `TextDecoder` through `globalThis`, the way `../embed/timers.ts` reaches the
 * timers: `src/` compiles with `types: []`, so a runtime-provided global is
 * typed structurally rather than inherited from `@types/node`.
 */
interface TextDecoderLike {
  decode(input: Uint8Array): string;
}
interface DecoderGlobals {
  TextDecoder?: new (label?: string) => TextDecoderLike;
}

/**
 * The spec says a message is UTF-8. Where there is no `TextDecoder` the bytes
 * are read as latin-1 instead, which is wrong only for the non-ASCII part of
 * a message and is still a message.
 */
export function decodeUtf8(bytes: readonly number[]): string {
  const Decoder = (globalThis as DecoderGlobals).TextDecoder;
  const array = Uint8Array.from(bytes);
  if (Decoder) return new Decoder('utf-8').decode(array);
  return String.fromCharCode(...array);
}

interface Pending {
  id: number;
  timeout: number;
  /** Bytes promised by `SYSTEM_TRAY_BEGIN_MESSAGE`. */
  length: number;
  bytes: number[];
}

/**
 * Balloon messages, reassembled per icon.
 *
 * `SYSTEM_TRAY_BEGIN_MESSAGE` says how many bytes are coming and then
 * `_NET_SYSTEM_TRAY_MESSAGE_DATA` ClientMessages carry them 20 at a time —
 * format 8, so the last one is padded with whatever was in the tail of the
 * event and only `length` bytes of it mean anything.
 *
 * One message at a time per icon, because that is all the protocol can
 * express: the data messages carry the sending window and nothing else, so a
 * second `BEGIN` before the first finished is indistinguishable from a
 * continuation of it. A new `BEGIN` therefore replaces the message in flight,
 * which is what GTK's tray manager does with the same ambiguity.
 */
export class BalloonMessages {
  #pending = new Map<number, Pending>();

  /** Returns a message when there is nothing to wait for — a zero-length
   *  one, which is how an icon sends the empty string. */
  begin(
    windowId: number,
    id: number,
    timeout: number,
    length: number,
  ): TrayMessage | null {
    if (length <= 0) {
      this.#pending.delete(windowId);
      return { windowId, id, timeout, text: '' };
    }
    this.#pending.set(windowId, { id, timeout, length, bytes: [] });
    return null;
  }

  /** Returns the message once the last byte lands. */
  data(windowId: number, bytes: readonly number[]): TrayMessage | null {
    const pending = this.#pending.get(windowId);
    // Data for a message nobody began: a client that was mid-message when
    // this host took the selection, which is ordinary rather than an error.
    if (!pending) return null;
    for (const byte of bytes) {
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

  /**
   * `SYSTEM_TRAY_CANCEL_MESSAGE`. Drops one still being assembled; a message
   * that already completed is the host's to take down, which is why this
   * answers nothing and the cancel is reported either way.
   */
  cancel(windowId: number, id: number): void {
    if (this.#pending.get(windowId)?.id === id) this.#pending.delete(windowId);
  }

  /** The icon went away mid-message. */
  forget(windowId: number): void {
    this.#pending.delete(windowId);
  }
}
