// Right-click on a selectable surface.
//
// Core selects, copies and takes PRIMARY by itself (react-x11#291), and it
// opens the standard edit menu by itself for `<textinput>` — but a
// `selectable` surface has no default context menu, because which verbs a
// surface offers is the surface's to say. A read-only document offers two:
// Copy, and Select all.
//
// `openEditMenu` is core's own (react-x11#289), so what is left here is the
// verb list. Everything else about the menu — which rows are enabled, Paste
// watching selection ownership rather than asking the server, the arrow
// keys, Escape, the pointer grab that dismisses it, handing the keyboard
// back afterwards — is core's and shared with the field.
import { openEditMenu, useClipboard } from 'react-x11';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';

export interface SelectionMenuHandlers {
  onContextMenu: (ev: X11MouseEvent<DrawnNode>) => void;
}

/**
 * The context-menu handler for a `selectable` root. Spread onto the same
 * `<box>` the `selectable` prop is on — the menu's verbs are read off that
 * node, which is the surface.
 */
export function useSelectionMenu(enabled = true): SelectionMenuHandlers {
  const clipboard = useClipboard();
  return {
    onContextMenu: (ev) => {
      if (!enabled) return;
      const surface = ev.currentTarget;
      if (!surface) return;
      openEditMenu(
        surface,
        { x: ev.x, y: ev.y },
        {
          // A verb left out is a row that is not there rather than a greyed
          // one, so a read-only surface simply never mentions Cut or Paste.
          hasSelection: !(surface.textSelection?.isCollapsed ?? true),
          copy: () => {
            const text = surface.selectedText();
            if (text) clipboard.write(text).catch(() => {});
          },
          selectAll: () => surface.selectAll(),
        },
      );
    },
  };
}
