// Following a link in a document.
//
// The only part of the old gesture hook that survived react-x11#291: core
// selects, copies and takes PRIMARY on its own now, but it left hover and
// `cursorAt` out deliberately, so which run is a link and what a click on
// one means are still this package's to answer.
//
// It lived in `../markdown/` until `<TerminalOutput>` needed it for OSC 8
// hyperlinks, and it moved here rather than being copied: there is no
// markdown in it at all. It is about `TextRun.href` and `hrefAtPoint`, both
// of which are this module's — the same "extract when the second consumer
// arrives" move `../codeblock/` was.
//
// The third consumer, `<Html>`, is what made the node test structural: it
// answers `hrefAtPoint` from a document it laid out itself and is not a
// `RichTextNode`. Asking for the method rather than the class is also what
// keeps this module from importing `node.ts`, so a surface that wants link
// clicks and nothing else does not pull the element in behind them.
//
// The whole problem is that a press on a link is also the start of a drag,
// and the two are told apart only at the release: a pointer that has barely
// moved and left nothing selected was a click, and anything else was a
// selection that happened to begin on a link. These handlers never call
// `preventDefault`, so core's own selection still runs after them.
import { useRef } from 'react';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';

/** Any node that can name the link under a point — `<richtext>` and
 *  `<htmlview>` both do, and neither has to say so to this module. */
interface HrefSource {
  hrefAtPoint?(x: number, y: number): string | null;
}

/** How far the pointer may travel and still count as a click, in pixels. */
const CLICK_SLOP = 3;

export interface LinkHandlers {
  onMouseDown: (ev: X11MouseEvent<DrawnNode>) => void;
  onMouseUp: (ev: X11MouseEvent<DrawnNode>) => void;
}

/**
 * Mouse handlers for a document root that follows links. Returns handlers
 * that do nothing when `onLink` is absent — the component never navigates by
 * itself, and a document with no handler simply has inert link text.
 */
export function useLinkClicks(
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void,
): LinkHandlers {
  const press = useRef<{ x: number; y: number; href: string } | null>(null);
  return {
    onMouseDown: (ev) => {
      press.current = null;
      if (!onLink || ev.button !== 1) return;
      const target = ev.target as HrefSource | null;
      const href =
        typeof target?.hrefAtPoint === 'function'
          ? target.hrefAtPoint(ev.x, ev.y)
          : null;
      if (href != null) press.current = { x: ev.x, y: ev.y, href };
    },
    onMouseUp: (ev) => {
      const start = press.current;
      press.current = null;
      if (!onLink || !start || ev.button !== 1) return;
      if (
        Math.abs(ev.x - start.x) > CLICK_SLOP ||
        Math.abs(ev.y - start.y) > CLICK_SLOP
      ) {
        return;
      }
      // a drag that ended where it began still selected something; that was
      // a selection gesture, not a click
      if (!(ev.currentTarget?.textSelection?.isCollapsed ?? true)) return;
      onLink(start.href, ev);
    },
  };
}
