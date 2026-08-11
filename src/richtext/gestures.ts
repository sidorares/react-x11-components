// The mouse-and-keyboard half of selection, as a hook: press-drag-release
// with pointer capture, double/triple-click granularity, Ctrl+A / Ctrl+C,
// Escape, PRIMARY on release, click-vs-drag link discrimination, and the
// react-x11#256 edit menu when core grows it. `<Markdown>` and `<Code>`
// spread the returned handlers onto their focusable root `<box>`; the
// selection state itself lives in `TextSelection`, outside React, so none
// of this re-renders anything during a drag.
import { useRef } from 'react';
import * as reactX11 from 'react-x11';
import { useClipboard } from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent as X11KeyboardEvent,
  MouseEvent as X11MouseEvent,
} from 'react-x11';
import { XK_ESCAPE } from 'react-x11/keysyms';

import { ctrlChordLetter } from './internal.js';
import { RichTextNode } from './node.js';
import type { TextSelection } from './selection.js';

// `openEditMenu` is react-x11#256 — the shared edit/context menu. Not on
// core master yet, so it is reached for by name and skipped when absent;
// when core ships it, right-click grows the standard menu with no change
// here. (Verbs only: these surfaces are read-only, so copy and select-all.)
interface EditMenuActions {
  hasSelection: boolean;
  copy?(): void;
  selectAll?(): void;
}
const openEditMenu = (
  reactX11 as unknown as {
    openEditMenu?: (
      node: unknown,
      at: { x: number; y: number },
      actions: EditMenuActions,
    ) => void;
  }
).openEditMenu;

export interface SelectionGestureOptions {
  /** False renders the handlers inert — the props stay spreadable. */
  selectable?: boolean;
  /** A link under an un-dragged click was activated. */
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
}

export interface SelectionGestureHandlers {
  onMouseDown: (ev: X11MouseEvent<DrawnNode>) => void;
  onMouseMove: (ev: X11MouseEvent<DrawnNode>) => void;
  onMouseUp: (ev: X11MouseEvent<DrawnNode>) => void;
  onKeyDown: (ev: X11KeyboardEvent<DrawnNode>) => void;
  onContextMenu: (ev: X11MouseEvent<DrawnNode>) => void;
}

/**
 * Wire a `TextSelection` to the root element of a selectable surface.
 * Returns stable-shaped handlers to spread onto a focusable `<box>`.
 */
export function useSelectionGestures(
  selection: TextSelection,
  options: SelectionGestureOptions = {},
): SelectionGestureHandlers {
  const { selectable = true, onLink } = options;
  const clipboard = useClipboard();
  const draggingRef = useRef(false);
  const pressRef = useRef<{ x: number; y: number; href: string | null } | null>(
    null,
  );

  const takePrimary = (): void => {
    if (!selection.hasSelection()) return;
    clipboard.write(selection.text(), { selection: 'PRIMARY' }).catch(() => {});
  };

  const copy = (): void => {
    if (!selection.hasSelection()) return;
    clipboard.write(selection.text()).catch(() => {});
  };

  return {
    onMouseDown: (ev) => {
      if (ev.button !== 1) return;
      const target = ev.target as unknown;
      pressRef.current = {
        x: ev.x,
        y: ev.y,
        href:
          target instanceof RichTextNode
            ? target.hrefAtPoint(ev.x, ev.y)
            : null,
      };
      if (!selectable) return;
      draggingRef.current = true;
      ev.capturePointer();
      selection.begin(ev.x, ev.y, ev.detail);
    },

    onMouseMove: (ev) => {
      if (!draggingRef.current) return;
      selection.extend(ev.x, ev.y);
    },

    onMouseUp: (ev) => {
      if (ev.button !== 1) return;
      const press = pressRef.current;
      pressRef.current = null;
      if (draggingRef.current) {
        draggingRef.current = false;
        if (selection.end()) takePrimary();
      }
      // an un-dragged click on a link follows it; a drag is a selection
      if (
        press?.href &&
        onLink &&
        Math.abs(ev.x - press.x) <= 3 &&
        Math.abs(ev.y - press.y) <= 3 &&
        !selection.hasSelection()
      ) {
        onLink(press.href, ev);
      }
    },

    onKeyDown: (ev) => {
      if (!selectable) return;
      if (ev.ctrlKey) {
        const letter = ctrlChordLetter(ev);
        if (letter === 0x61 /* a */) {
          selection.selectAll();
          takePrimary();
        } else if (letter === 0x63 /* c */) {
          copy();
        }
        return;
      }
      if (ev.keysym === XK_ESCAPE) selection.clear();
    },

    onContextMenu: (ev) => {
      if (!selectable || !openEditMenu) return;
      openEditMenu(
        ev.currentTarget,
        { x: ev.x, y: ev.y },
        {
          hasSelection: selection.hasSelection(),
          copy,
          selectAll: () => {
            selection.selectAll();
            takePrimary();
          },
        },
      );
    },
  };
}
