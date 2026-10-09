// What a host mounts over an embedded element (`renderEmbedded`): an
// `<iframe>`'s document, a `<canvas>`'s drawing, an `<embed>`'s plugin. The
// document lays each out as a box of its size and draws nothing in it
// (`ReplacedKind` 'frame'); what shows there is the host's, mounted beside
// the document at the box's content rectangle as a video's player is
// (`videos.ts`), and held to the same rules (`media.ts`, `placementOf`).
//
// Two boxes a mount: the **port**, what it shows through — its rectangle,
// or what the boxes that clip it and the boxes fixed over it leave of it,
// faded as the document fades it — and the **frame**, the content box, its
// corners rounded where the document rounds them, which what the host
// returned fills. The host's node is keyed by its element, so a mount that
// moves, is cut or fades is the same node in the same place in the tree: a
// new one would be a new document in an `<iframe>`, its scripts started
// again.
import React from 'react';
import type { ReactNode } from 'react';

import { hx } from './hx.js';
import type { Element } from './dom.js';
import type { EmbeddedRect } from './media.js';

export interface Embedded {
  /** What the element reports to. */
  onEmbedded: (rects: EmbeddedRect[]) => void;
  /** The mounts, in the order the document has the elements. */
  render(): ReactNode[];
}

/** What a host gives for an embedded element: the node to mount over it,
 *  or null to leave its box as the document draws it, empty. */
export type RenderEmbedded = (embedded: EmbeddedRect) => ReactNode | null;

/** The mounts over a document's embedded elements, kept as the rects the
 *  element reported. */
export function useEmbedded(
  renderEmbedded: RenderEmbedded | undefined,
): Embedded {
  const [rects, setRects] = React.useState<EmbeddedRect[]>([]);
  const ids = React.useRef(new WeakMap<Element, number>()).current;
  const next = React.useRef(0);
  const idOf = (el: Element): number => {
    let id = ids.get(el);
    if (id === undefined) ids.set(el, (id = ++next.current));
    return id;
  };
  const onEmbedded = React.useCallback((reported: EmbeddedRect[]) => {
    setRects(reported);
  }, []);
  return {
    onEmbedded,
    render: () => {
      if (!renderEmbedded) return [];
      const out: ReactNode[] = [];
      for (const rect of rects) {
        const content = renderEmbedded(rect);
        if (content === null || content === undefined) continue;
        out.push(mount(rect, `${idOf(rect.element)}`, content));
      }
      return out;
    },
  };
}

function mount(rect: EmbeddedRect, id: string, content: ReactNode): ReactNode {
  const { x: left, y: top, width, height } = rect;
  const port = rect.clip ?? { x: left, y: top, width, height };
  const opacity = rect.hidden ? 0 : rect.opacity;
  return hx(
    'box',
    {
      key: `embedded:${id}`,
      selectable: false,
      style: {
        position: 'absolute',
        left: port.x,
        top: port.y,
        width: port.width,
        height: port.height,
        ...(rect.clip && { overflow: 'hidden' }),
        ...(rect.clipRadius && { borderRadius: rect.clipRadius }),
        ...(opacity !== undefined && { opacity }),
        // a mount nothing of shows takes no input either
        pointerEvents: rect.hidden ? 'none' : 'box-none',
      },
    },
    hx(
      'box',
      {
        selectable: false,
        style: {
          position: 'absolute',
          left: left - port.x,
          top: top - port.y,
          width,
          height,
          ...(rect.radius && {
            borderRadius: rect.radius,
            overflow: 'hidden',
          }),
        },
      },
      content,
    ),
  );
}
