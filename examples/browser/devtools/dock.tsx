// What a tab's page draws for its developer tools whether or not they are
// loaded: the dock that holds them under the page, and the highlight over
// the document. The panels themselves (`index.tsx`) are loaded the first
// time a tab's tools open, so a page process that never opens them loads
// none of the tree, the table or the editor they are made of.
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';

import type { HtmlHandle } from '../../../src/html/index.js';
import {
  BOX_COLOURS,
  boxModelOf,
  printPx,
  selectorOf,
  useStore,
} from './model.js';
import type { Inspection } from './model.js';

// --- the highlight over the page ---------------------------------------------

/** How often a highlight follows a page that moves under it. */
const FOLLOW_MS = 300;

/**
 * The element the pointer is on in the tools — or in the page, while
 * choosing — drawn over the document as a browser's tools draw it: its
 * margin, border, padding and content in four tints, and a caption with its
 * name and size. Mounted in the pane that scrolls the document, at the
 * element's rect, so a scroll carries it with the page and nothing has to
 * follow it; a layout that moves the element is followed a few times a
 * second. It takes no pointer, so the page under it still hears the mouse.
 */
export function Highlight({
  handle,
  inspection,
}: {
  handle: HtmlHandle;
  inspection: Inspection;
}): ReactElement | null {
  const hovered = useStore(inspection.hovered);
  const [, follow] = useState(0);
  useEffect(() => {
    if (!hovered) return;
    const timer = setInterval(() => follow((n) => n + 1), FOLLOW_MS);
    return () => clearInterval(timer);
  }, [hovered]);
  if (!hovered || !handle.document) return null;
  const rect = handle.elementRect(hovered);
  if (!rect) return null;
  const style = handle.computedStyle(hovered) ?? {};
  const box = boxModelOf(style, rect);
  const m = box.margin;
  const ring = (colour: string, sides: typeof m) => ({
    borderTopWidth: Math.max(0, sides.top),
    borderRightWidth: Math.max(0, sides.right),
    borderBottomWidth: Math.max(0, sides.bottom),
    borderLeftWidth: Math.max(0, sides.left),
    borderColor: colour,
    flexGrow: 1,
  });
  const tint = (hex: string) => `${hex}a8`;
  return (
    <box
      style={{
        position: 'absolute',
        left: rect.x - Math.max(0, m.left),
        top: rect.y - Math.max(0, m.top),
        width: rect.width + Math.max(0, m.left) + Math.max(0, m.right),
        height: rect.height + Math.max(0, m.top) + Math.max(0, m.bottom),
        pointerEvents: 'none',
        ...ring(tint(BOX_COLOURS.margin), m),
      }}
    >
      <box style={ring(tint(BOX_COLOURS.border), box.border)}>
        <box style={ring(tint(BOX_COLOURS.padding), box.padding)}>
          <box
            style={{ flexGrow: 1, backgroundColor: tint(BOX_COLOURS.content) }}
          />
        </box>
      </box>
      <box
        style={{
          position: 'absolute',
          left: -Math.max(0, m.left),
          ...(rect.y - Math.max(0, m.top) >= 24
            ? { bottom: '100%' }
            : { top: '100%' }),
          marginTop: 2,
          marginBottom: 2,
          paddingLeft: 6,
          paddingRight: 6,
          paddingTop: 2,
          paddingBottom: 2,
          borderRadius: 3,
          backgroundColor: '#333740',
          flexDirection: 'row',
          gap: 6,
        }}
      >
        <text
          style={{ fontFamily: '$monoFamily', fontSize: 11, color: '#e5c07b' }}
        >
          {selectorOf(hovered)}
        </text>
        <text
          style={{ fontFamily: '$monoFamily', fontSize: 11, color: '#d0d0d0' }}
        >
          {`${printPx(rect.width)} × ${printPx(rect.height)}`}
        </text>
      </box>
    </box>
  );
}

// --- the dock --------------------------------------------------------------------

/** How thick the bar between the page and the tools is, which a drag
 *  moves. */
const DOCK_BAR = 5;

/**
 * The page and, under it, the tools at a height the bar between them sets.
 * The page is the first child whether or not the tools are open, so opening
 * them mounts nothing new above the page's documents: each `<Html>` keeps
 * its node, its scripts and where it was scrolled. `<SplitPane>` would wrap
 * the page in a pane only while the tools are there, which is a new parent,
 * and so a new document, at every open.
 */
export function Dock({
  page,
  tools,
}: {
  page: ReactElement;
  tools: ReactElement | null;
}): ReactElement {
  const [height, setHeight] = useState(300);
  const [total, setTotal] = useState(0);
  const [dragging, setDragging] = useState(false);
  // the drag as it goes, which the moves after a press read before React
  // has rendered the press
  const held = useRef(false);
  const shown = total ? Math.min(height, Math.max(120, total - 120)) : height;
  return (
    <box
      style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
      onLayout={(ev) => setTotal(ev.height)}
    >
      {page}
      {tools ? (
        <box
          role="separator"
          aria-label="Resize the developer tools"
          onMouseDown={(ev: X11MouseEvent<DrawnNode>) => {
            ev.capturePointer();
            held.current = true;
            setDragging(true);
          }}
          onMouseMove={(ev: X11MouseEvent<DrawnNode>) => {
            if (!held.current) return;
            const box = ev.currentTarget?.parent?.getClientRects?.()[0];
            if (!box) return;
            const next = box.y + box.height - ev.y - DOCK_BAR / 2;
            setHeight(Math.max(120, Math.min(box.height - 120, next)));
          }}
          onMouseUp={() => {
            held.current = false;
            setDragging(false);
          }}
          style={{
            height: DOCK_BAR,
            flexShrink: 0,
            cursor: 'ns-resize',
            borderTopWidth: 1,
            borderColor: '$border',
            backgroundColor: dragging ? '$accent' : '$surface',
          }}
        />
      ) : null}
      {tools ? (
        <box style={{ height: shown, flexShrink: 0, minHeight: 0 }}>
          {tools}
        </box>
      ) : null}
    </box>
  );
}
