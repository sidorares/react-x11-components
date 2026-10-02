// The players `<Html>` mounts over its videos: core's `<video>`, one for each
// rect the element reports (`onMedia`, `media.ts`), absolutely placed beside
// the document as a form control's widget is (`widgets.ts`).
//
// Three boxes a video, always, so that one the document comes to cut, or
// round, or fade, is the same `<video>` in the same place in the tree — a
// new one would be a new player, and the video would start again:
//
//  - the **port**, what the video shows through: its own rectangle, or what
//    the boxes that clip it and the boxes fixed over it leave of it, its
//    corners rounded where a rounded box is what clips it, and faded by the
//    opacity the document fades it by;
//  - the **frame**, the video's content box, its corners rounded where the
//    document rounds them;
//  - the **video**, filling the frame, the picture fitted into it by the
//    element's `object-fit`.
//
// A press goes through to the document — a drag across a video selects the
// text around it — unless the page asked for `controls`. There is no bar of
// them: a press plays and pauses, as a browser's video does, and the rest is
// an application's to draw, around the document.
import React from 'react';
import type { ReactNode } from 'react';
import type { VideoNode } from 'react-x11';
import type { Style } from 'react-x11/style';

import { hx } from './hx.js';
import type { Element } from './dom.js';
import type { MediaRect } from './media.js';
import type { HtmlViewNode } from './node.js';

export interface Videos {
  /** What the element reports to. */
  onMedia: (rects: MediaRect[]) => void;
  /** The players, in the order the document has the videos. */
  render(): ReactNode[];
}

/** The players over a document, kept as the rects the element reported. */
export function useVideos(view: {
  readonly current: HtmlViewNode | null;
}): Videos {
  const [rects, setRects] = React.useState<MediaRect[]>([]);
  const ids = React.useRef(new WeakMap<Element, number>()).current;
  const next = React.useRef(0);
  const idOf = (el: Element): number => {
    let id = ids.get(el);
    if (id === undefined) ids.set(el, (id = ++next.current));
    return id;
  };
  return {
    onMedia: React.useCallback((reported: MediaRect[]) => {
      setRects(reported);
    }, []),
    render: () =>
      rects.map((rect) => renderVideo(rect, `${idOf(rect.element)}`, view)),
  };
}

function renderVideo(
  rect: MediaRect,
  id: string,
  view: { readonly current: HtmlViewNode | null },
): ReactNode {
  const el = rect.element;
  // on the device pixels the document drew the box on already: rounded
  // again in logical ones, a rect at 2x moved a device pixel off the box,
  // and the document's background showed in the row it left
  const { x: left, y: top, width, height } = rect;
  const port = rect.clip ?? { x: left, y: top, width, height };
  const opacity = rect.hidden ? 0 : rect.opacity;
  const source =
    'frames' in rect.source
      ? { frames: rect.source.frames }
      : { src: rect.source.src };
  const style: Style = { width, height, objectFit: rect.fit };
  return hx(
    'box',
    {
      // a new source is a new player, and where the element changes its
      // source a new one is what HTML has too
      key: `video:${id}:${rect.url}`,
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
        pointerEvents: rect.controls ? 'box-none' : 'none',
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
      hx('video', {
        ...source,
        autoPlay: rect.autoPlay,
        loop: rect.loop,
        muted: rect.muted,
        style,
        ...(rect.label && { 'aria-label': rect.label }),
        onLoadedMetadata: (ev) =>
          view.current?.mediaLoaded(el, ev.width, ev.height),
        onError: () => view.current?.mediaFailed(el, rect.url),
        ...(rect.controls && {
          onClick: (ev: { currentTarget: VideoNode | null }) => {
            const node = ev.currentTarget;
            if (!node) return;
            if (node.paused) node.play();
            else node.pause();
          },
        }),
      }),
    ),
  );
}
