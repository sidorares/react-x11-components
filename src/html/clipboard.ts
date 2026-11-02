// What a page's scripts may do with the machine's clipboard: the seam
// `<Html scripts>` reaches it through.
//
// **The user's own copy and paste are not what this is about.** Ctrl+C on a
// selection and Ctrl+V in a field are core's, and work with no seam at all,
// since nothing of the page is asked. What the seam adds is the page's part:
// the text a `copy` listener puts on the clipboard, what a `paste` listener
// reads off it, and `navigator.clipboard`. Without one a page's `copy` and
// `paste` are told with nothing in them, and `navigator.clipboard` is not
// there. A component that shows a page does not hand the page the clipboard
// by itself, any more than it fetches for it (`network.ts`).
//
// `useHtmlClipboard()` is one, over core's `useClipboard()`, which holds on
// every backend and in a `<Frame>` pane: NSPasteboard asks nothing of the
// process's NSApplication. `memoryClipboard()` is one that reaches no machine,
// for a test.
import { useMemo } from 'react';
import { useClipboard } from 'react-x11';

declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

/** What is on a clipboard, by MIME type: text as a string, anything else as
 *  bytes. */
export type HtmlClipboardData = Record<string, string | Uint8Array>;

/**
 * The clipboard a page's `copy`, `cut`, `paste` and `navigator.clipboard` go
 * to. Both methods are the host's to refuse by rejecting, which a page hears
 * as a `NotAllowedError`.
 */
export interface HtmlClipboard {
  /** All that is on the clipboard. Asked for once a paste or a
   *  `navigator.clipboard.read()`: nothing is read until a page has to be
   *  handed it. */
  read(): Promise<HtmlClipboardData>;
  /** Replace what is on the clipboard. */
  write(data: HtmlClipboardData): Promise<void>;
}

/** The types `useHtmlClipboard` reads, besides text: what a page can use,
 *  and no more than a page was offered in the first place (Clipboard API
 *  and events, "mandatory data types"). */
const READS = ['text/html', 'image/png', 'image/svg+xml'];

/** Whether a type is text, which crosses as a string. */
const isText = (type: string): boolean =>
  type.startsWith('text/') || type === 'image/svg+xml';

/**
 * The machine's clipboard, as `scripts.clipboard` takes it: what the example
 * browser hands its pages.
 *
 * A page that reads it with `navigator.clipboard` is still asked about by
 * `scripts.permissions`; only what the user pasted reaches a page without.
 */
export function useHtmlClipboard(): HtmlClipboard {
  const clipboard = useClipboard();
  return useMemo(
    () => ({
      async read() {
        const data: HtmlClipboardData = {};
        // nothing on it is a question with an empty answer, not a failure
        const offered: string[] = await clipboard.targets().catch(() => []);
        if (!offered.length) return data;
        const text = await clipboard.read('text').catch(() => null);
        if (typeof text === 'string') data['text/plain'] = text;
        for (const type of READS) {
          if (!offered.includes(type)) continue;
          const value = await clipboard.read(type).catch(() => null);
          if (value !== null) data[type] = value as string | Uint8Array;
        }
        return data;
      },
      write: async (data) => {
        const types = Object.keys(data);
        const text = data['text/plain'];
        if (types.length === 1 && typeof text === 'string') {
          await clipboard.writeText(text);
          return;
        }
        // text offered beside anything else keeps the names an X client
        // asks for it by, which a map of types does not add for itself
        await clipboard.write(
          typeof text === 'string'
            ? { ...data, UTF8_STRING: text, STRING: text }
            : data,
        );
      },
    }),
    [clipboard],
  );
}

/** A clipboard that reaches nothing outside itself: what a test hands a
 *  page, and what it reads back what the page wrote from. */
export function memoryClipboard(
  initial: HtmlClipboardData = {},
): HtmlClipboard & { data: HtmlClipboardData } {
  const clipboard = {
    data: { ...initial },
    read: () => Promise.resolve({ ...clipboard.data }),
    write: (data: HtmlClipboardData) => {
      clipboard.data = { ...data };
      return Promise.resolve();
    },
  };
  return clipboard;
}

/** One type of what is on the clipboard as it crosses to a page: text as
 *  it is, and bytes as base64. */
export interface ClipboardEntryWire {
  t: string;
  s?: string;
  b?: string;
}

/** What a page wrote, as the host's clipboard takes it. */
export function clipboardOfWire(
  wire: ClipboardEntryWire[],
  bytes: (base64: string) => Uint8Array,
): HtmlClipboardData {
  const data: HtmlClipboardData = {};
  for (const entry of wire) {
    data[entry.t] = entry.b === undefined ? (entry.s ?? '') : bytes(entry.b);
  }
  return data;
}

/** What is on a clipboard as a page is told it. */
export function clipboardWire(
  data: HtmlClipboardData,
  base64: (bytes: Uint8Array) => string,
): ClipboardEntryWire[] {
  return Object.entries(data).map(([type, value]) =>
    typeof value === 'string'
      ? { t: type, s: value }
      : isText(type)
        ? { t: type, s: new TextDecoder().decode(value) }
        : { t: type, b: base64(value) },
  );
}
