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
// And after the port, where the document paints over the video — a play
// button in its corner — a `<canvas>` it is painted on again
// (`HtmlViewNode.paintCovers`), cut to the port: a sibling after the player
// is over it, as the box is over the video in the document.
//
// A press goes through to the document — a drag across a video selects the
// text around it — unless the page asked for `controls`. There is no bar of
// them: a press plays and pauses, as a browser's video does, and the rest is
// an application's to draw, around the document. A video that takes the
// press shows the arrow over it, as a browser's does: the boxes it is in say
// nothing, and the document's root, a selectable surface, would have it
// show the I-beam.
//
// What a page's script asks of a video — `play()`, `pause()`, `muted`,
// `volume`, `playbackRate` — is in its rect (`HtmlViewNode.setMediaState`),
// and goes to the player as core's props, which tell the player that is
// playing rather than make another: none of them is in the key. A seek is
// a count in the rect, and the player is sought once each time it moves.
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

/** The players over a document, kept as the rects the element reported.
 *  `loaded` is told when a player has what it plays, for the page: what
 *  its scripts read as ready, and what an `autoplay` waits for. */
export function useVideos(
  view: { readonly current: HtmlViewNode | null },
  loaded: (element: Element) => void,
): Videos {
  const [rects, setRects] = React.useState<MediaRect[]>([]);
  const told = React.useRef(loaded);
  told.current = loaded;
  const ids = React.useRef(new WeakMap<Element, number>()).current;
  const next = React.useRef(0);
  const idOf = (el: Element): number => {
    let id = ids.get(el);
    if (id === undefined) ids.set(el, (id = ++next.current));
    return id;
  };
  // each element's player, and the seek it was last sought by: a seek
  // asked while no player was mounted is the next one's
  const players = React.useRef(new Map<Element, VideoNode>()).current;
  const sought = React.useRef(new WeakMap<Element, number>()).current;
  React.useEffect(() => {
    for (const { element, seek } of rects) {
      const node = seek && players.get(element);
      if (!node || sought.get(element) === seek.count) continue;
      sought.set(element, seek.count);
      node.seek(seek.time);
    }
  }, [rects, players, sought]);
  const playerOf = (el: Element) => (node: VideoNode | null) => {
    if (node) players.set(el, node);
    else players.delete(el);
  };
  return {
    onMedia: React.useCallback((reported: MediaRect[]) => {
      setRects(reported);
    }, []),
    render: () =>
      rects.flatMap((rect) => {
        const id = `${idOf(rect.element)}`;
        const over = renderCovers(rect, id, view);
        const video = renderVideo(
          rect,
          id,
          view,
          playerOf(rect.element),
          (el) => told.current(el),
        );
        return over ? [video, over] : [video];
      }),
  };
}

/** The `<canvas>` what the document paints over a player is painted on
 *  again, where it shows: over what the player shows, and nowhere a press
 *  stops, which is the document's. */
function renderCovers(
  rect: MediaRect,
  id: string,
  view: { readonly current: HtmlViewNode | null },
): ReactNode {
  if (!rect.over || rect.hidden) return null;
  const el = rect.element;
  const port = rect.clip ?? rect;
  const x = Math.max(rect.over.x, port.x);
  const y = Math.max(rect.over.y, port.y);
  const width =
    Math.min(rect.over.x + rect.over.width, port.x + port.width) - x;
  const height =
    Math.min(rect.over.y + rect.over.height, port.y + port.height) - y;
  if (!(width > 0 && height > 0)) return null;
  return hx('canvas', {
    key: `over:${id}`,
    style: {
      position: 'absolute',
      left: x,
      top: y,
      width,
      height,
      pointerEvents: 'none',
      ...(rect.opacity !== undefined && { opacity: rect.opacity }),
    },
    onDraw: (ctx, info) => view.current?.paintCovers(el, ctx, info.node.abs),
  });
}

function renderVideo(
  rect: MediaRect,
  id: string,
  view: { readonly current: HtmlViewNode | null },
  ref: (node: VideoNode | null) => void,
  loaded: (element: Element) => void,
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
  const style: Style = {
    width,
    height,
    objectFit: rect.fit,
    ...(rect.controls && { cursor: 'default' }),
  };
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
        ref,
        autoPlay: rect.autoPlay,
        loop: rect.loop,
        muted: rect.muted,
        // controlled once something said, and left to `autoPlay` until
        ...(rect.paused !== undefined && { paused: rect.paused }),
        ...(rect.volume !== undefined && { volume: rect.volume }),
        ...(rect.playbackRate !== undefined && {
          playbackRate: rect.playbackRate,
        }),
        style,
        ...(rect.label && { 'aria-label': rect.label }),
        onLoadedMetadata: (ev) => {
          view.current?.mediaLoaded(el, ev.width, ev.height);
          loaded(el);
        },
        onError: () => view.current?.mediaFailed(el, rect.url),
        ...(rect.controls && {
          onClick: (ev: { currentTarget: VideoNode | null }) => {
            const node = ev.currentTarget;
            if (!node) return;
            // at once, which plays an ended video from its start, and kept
            // as what the player was last told: a script's `pause()` after
            // a press that played it changes the prop again
            const paused = !node.paused;
            if (paused) node.pause();
            else node.play();
            view.current?.setMediaState(el, { paused });
          },
        }),
      }),
    ),
  );
}
