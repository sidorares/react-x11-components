// The bit of react-x11 that `<Tree>` needs and react-x11 does not export.
//
// Everything else the widget stands on is public — `useTheme`,
// `useDirection`, `createStyles`, `<Icon>`, the `XK_*` keysyms, the host
// elements. Type-ahead is not: `src/components/typeahead.js` is shared
// between core's own `Select` and its menus and is not on the exports map.
// So it is vendored, the way `../calendar/internal.ts` vendors its three;
// it is small and pure, and if core ever exports it, delete this and import
// it instead.
//
// Matching core's behaviour matters more than the code being ours: a user who
// has learnt that typing "sr" in a `Select` jumps to "src" expects the same
// two keys to do the same thing in a tree, including the two rules that are
// easy to leave out — a growing query searches from where you are, and a
// repeated letter cycles rather than sticking.

import { useCallback, useRef } from 'react';
import type { KeyboardEvent } from 'react-x11';

/** How long a query stays open. Core's number, and it is a habit rather than
 *  a preference — the same pause has to end a query everywhere. */
export const TYPE_AHEAD_TIMEOUT = 700;

/**
 * Type-ahead: typing letters jumps to the entry whose label starts with them.
 * Returns the matching index, or -1.
 */
export function useTypeAhead(
  timeout: number = TYPE_AHEAD_TIMEOUT,
): <T>(
  char: string,
  items: readonly T[],
  current: number | null,
  labelOf: (item: T) => unknown,
  selectable?: (item: T) => boolean,
) => number {
  const state = useRef({ text: '', at: 0 });
  return useCallback(
    <T>(
      char: string,
      items: readonly T[],
      current: number | null,
      labelOf: (item: T) => unknown,
      selectable?: (item: T) => boolean,
    ): number => {
      if (!char || char.length !== 1) return -1;
      const now = Date.now();
      const s = state.current;
      s.text = now - s.at > timeout ? char : s.text + char;
      s.at = now;

      const query = s.text.toLowerCase();
      // "ccc" cycles the entries starting with c rather than refining a
      // prefix nothing has.
      const cycling = query.length > 1 && /^(.)\1+$/.test(query);
      const needle = cycling ? query[0] : query;
      // A growing query keeps you on the row it still matches; a fresh letter
      // starts from the one after it.
      const from =
        cycling || query.length === 1 ? (current ?? -1) + 1 : (current ?? 0);

      const n = items.length;
      for (let k = 0; k < n; k++) {
        const i = (((from + k) % n) + n) % n;
        const item = items[i];
        if (selectable && !selectable(item)) continue;
        const label = String(labelOf(item) ?? '').toLowerCase();
        if (label.startsWith(needle)) return i;
      }
      return -1;
    },
    [timeout],
  );
}

/**
 * A printable character usable for type-ahead, or null.
 *
 * Space is excluded on purpose: it activates the focused row everywhere in
 * this widget set, and a tree that jumped to an entry beginning with a space
 * instead would be the one control that disagreed.
 */
export function typeAheadChar(ev: KeyboardEvent): string | null {
  return ev.key && ev.key.length === 1 && (ev.codepoint ?? 0) > 32
    ? ev.key
    : null;
}
