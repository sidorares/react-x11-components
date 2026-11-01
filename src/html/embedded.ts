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
// returned fills. Where the element is drawn through a scale
// (`EmbeddedRect.zoom`), a third box inside the frame carries core's `scale`
// prop and is the element's size before it: what the host returned is laid
// out at that size and drawn at the scale, as a browser draws an
// `<iframe>`'s document inside a scaled slide, its text shaped at the size
// it is drawn at rather than stretched. All of it is in a box core keeps
// with what the element is drawn in, at the viewport for a box fixed there
// (`EmbeddedRect.atViewport`) and with a sticky box the viewport keeps
// (`EmbeddedRect.held`), as a widget is (`keptMount` in `widgets.ts`). The
// host's node is keyed by its element, so a mount that moves, is cut or
// fades is the same node in the same place in the tree: a new one would be
// a new document in an `<iframe>`, its scripts started again.
import React from 'react';
import type { ReactNode } from 'react';
import type { DrawnNode } from 'react-x11';

import { hx } from './hx.js';
import { keptMount } from './widgets.js';
import type { Element } from './dom.js';
import type { EmbeddedRect } from './media.js';

export interface Embedded {
  /** What the element reports to. */
  onEmbedded: (rects: EmbeddedRect[]) => void;
  /** The mounts, in the order the document has the elements. */
  render(): ReactNode[];
  /** Whether a node is in what the host mounted: a key typed in an
   *  `<iframe>`'s document is that document's, as a browser's is, and the
   *  embedding document hears nothing of it. */
  contains(node: DrawnNode | null): boolean;
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
  const ports = React.useRef(new Set<DrawnNode>()).current;
  const refs = React.useRef(
    new Map<string, (node: DrawnNode | null) => void>(),
  ).current;
  /** A port's ref, the same function for the same mount, so core is not
   *  told it went and came back at every render. */
  const refOf = (id: string) => {
    let ref = refs.get(id);
    if (!ref) {
      let held: DrawnNode | null = null;
      ref = (node: DrawnNode | null) => {
        if (held) ports.delete(held);
        held = node;
        if (node) ports.add(node);
      };
      refs.set(id, ref);
    }
    return ref;
  };
  return {
    onEmbedded,
    contains: (node) => {
      for (let at = node; at; at = at.parent as DrawnNode | null) {
        if (ports.has(at)) return true;
      }
      return false;
    },
    render: () => {
      if (!renderEmbedded) return [];
      const out: ReactNode[] = [];
      for (const rect of rects) {
        const content = renderEmbedded(rect);
        if (content === null || content === undefined) continue;
        const id = `${idOf(rect.element)}`;
        out.push(mount(rect, id, content, refOf(id)));
      }
      return out;
    },
  };
}

function mount(
  rect: EmbeddedRect,
  id: string,
  content: ReactNode,
  ref: (node: DrawnNode | null) => void,
): ReactNode {
  const { x: left, y: top, width, height } = rect;
  const port = rect.clip ?? { x: left, y: top, width, height };
  const opacity = rect.hidden ? 0 : rect.opacity;
  const zoom = rect.zoom ?? 1;
  const node = hx(
    'box',
    {
      key: `embedded:${id}`,
      ref,
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
          // what takes the pointer is what the host mounted: a canvas's
          // picture lets it through to the element in the document, which
          // the page hears of
          pointerEvents: 'box-none',
        },
      },
      // always there, so a mount whose scale comes or goes is the same
      // node, and an `<iframe>`'s document is not started again
      hx(
        'box',
        {
          selectable: false,
          scale: zoom,
          // sized in the unit it establishes, so it fills the frame
          style: {
            width: width / zoom,
            height: height / zoom,
            pointerEvents: 'box-none',
          },
        },
        content,
      ),
    ),
  );
  return keptMount(rect, `embedded-kept:${id}`, node);
}
