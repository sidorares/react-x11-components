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
// button in its corner, the controls fixed over it — a `<canvas>` it is
// painted on again (`HtmlViewNode.paintCovers`), cut to the port: a sibling
// after the player is over it, as the box is over the video in the document.
// It draws at each repaint that reaches it, so a fade of what is on it needs
// no telling.
//
// All of it in a box core keeps with a sticky box the viewport keeps, where
// the video is in one (`MediaRect.held`, `keptMount` in `widgets.ts`).
//
// A press goes through to the document — a drag across a video selects the
// text around it — unless the page asked for `controls`. There is no bar of
// them: a press plays and pauses, as a browser's video does, and the rest is
// an application's to draw, around the document. A video that takes the
// press shows the arrow over it, as a browser's does: the boxes it is in say
// nothing, and the document's root, a selectable surface, would have it
// show the I-beam.
//
// A video whose stream is a page's `MediaSource` (`MediaRect.reports`) says
// what its player does — its time, its end, a failure — as a sound does, and
// the page's clock follows it.
//
// What a page's script asks of a video — `play()`, `pause()`, `muted`,
// `volume`, `playbackRate` — is in its rect (`HtmlViewNode.setMediaState`),
// and goes to the player as core's props, which tell the player that is
// playing rather than make another: none of them is in the key. A seek is
// a count in the rect, and the player is sought once each time it moves.
import React from 'react';
import type { ReactNode } from 'react';
import { useVideoFrames } from 'react-x11';
import type {
  DrawnNode,
  VideoColorSpace,
  VideoFormat,
  VideoNode,
} from 'react-x11';
import type { Style } from 'react-x11/style';

import { hx } from './hx.js';
import { keptMount } from './widgets.js';
import type { Element } from './dom.js';
import type { EmbeddedRect, MediaRect } from './media.js';
import type { MediaVideoFrame, ShownSource } from './media-devices.js';
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
        const video = renderVideo(rect, id, view, playerOf(rect.element));
        return keptMount(rect, `video-kept:${id}`, video, over);
      }),
  };
}

/** The `<canvas>` what the document paints over a player is painted on
 *  again, where it shows: over what the player shows, and nowhere a press
 *  stops, which is the document's. Not at the video's opacity, which fades
 *  the video and not what is painted over it: a box that fades both keeps
 *  the poster (`coversOf`), and a cover's own is painted with it. */
export function renderCovers(
  rect: MediaRect | EmbeddedRect,
  id: string,
  view: { readonly current: HtmlViewNode | null },
  /** Whether what is mounted under it takes presses, as a frame does, so
   *  that a press has to be handed to the document here: it finds what is
   *  under the point itself, and what is over a frame is the page's, whose
   *  close button a press through the canvas would never reach. */
  takesPresses = false,
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
  // in a port as round as the player's, where a rounded box cuts both: a
  // cover is let through only where it is that box that rounds it
  const round = 'clipRadius' in rect ? rect.clipRadius : undefined;
  const from = round ? port : { x: 0, y: 0 };
  const canvas = hx('canvas', {
    key: `over:${id}`,
    ref: takesPresses ? (node: Cover | null) => coverOf(node, view) : undefined,
    style: {
      position: 'absolute',
      left: x - from.x,
      top: y - from.y,
      width,
      height,
      ...(!takesPresses && { pointerEvents: 'none' as const }),
    },
    onDraw: (ctx, info) => view.current?.paintCovers(el, ctx, info.node.abs),
  });
  if (!round) return canvas;
  return hx(
    'box',
    {
      key: `over:${id}`,
      selectable: false,
      style: {
        position: 'absolute',
        left: port.x,
        top: port.y,
        width: port.width,
        height: port.height,
        borderRadius: round,
        overflow: 'hidden',
        pointerEvents: 'box-none',
      },
    },
    canvas,
  );
}

/** What core asks of a node for the node under a point, which `DrawnNode`
 *  does not declare. */
type Cover = DrawnNode & {
  hitTest?: (x: number, y: number) => DrawnNode | null;
};

/** A press on a cover is the document's, which every path a press takes
 *  goes by: what is under the point it finds for itself. */
function coverOf(
  node: Cover | null,
  view: { readonly current: HtmlViewNode | null },
): void {
  if (!node) return;
  node.hitTest = (x, y) => {
    const { abs } = node;
    const inside =
      x >= abs.x &&
      y >= abs.y &&
      x < abs.x + abs.width &&
      y < abs.y + abs.height;
    return inside ? (view.current as DrawnNode | null) : null;
  };
}

function renderVideo(
  rect: MediaRect,
  id: string,
  view: { readonly current: HtmlViewNode | null },
  ref: (node: VideoNode | null) => void,
): ReactNode {
  const el = rect.element;
  // on the device pixels the document drew the box on already: rounded
  // again in logical ones, a rect at 2x moved a device pixel off the box,
  // and the document's background showed in the row it left
  const { x: left, y: top, width, height } = rect;
  const port = rect.clip ?? { x: left, y: top, width, height };
  const opacity = rect.hidden ? 0 : rect.opacity;
  const stream = 'stream' in rect.source ? rect.source.stream : null;
  const source =
    'stream' in rect.source
      ? {}
      : 'frames' in rect.source
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
      playerOf(stream, {
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
        onLoadedMetadata: (ev) =>
          view.current?.mediaLoaded(el, ev.width, ev.height),
        // a `MediaSource`'s stream: what its player says is the page's
        // clock, and a failure is the host's to start again
        ...(rect.reports
          ? {
              onTimeUpdate: ({ currentTime }: { currentTime: number }) =>
                view.current?.videoEvent(
                  el,
                  rect.url,
                  'time',
                  `${currentTime}`,
                ),
              onEnded: () => view.current?.videoEvent(el, rect.url, 'ended'),
              onError: (err: Error | null) =>
                view.current?.videoEvent(el, rect.url, 'error', err?.message),
            }
          : { onError: () => view.current?.mediaFailed(el, rect.url) }),
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

type VideoProps = NonNullable<Parameters<typeof hx<'video'>>[1]>;

/** The player a video is handed: core's `<video>`, or what shows a
 *  stream's picture where its `srcObject` is one. */
function playerOf(stream: ShownSource | null, props: VideoProps): ReactNode {
  return stream
    ? React.createElement(StreamPicture, { stream, video: props })
    : hx('video', props);
}

/** Video range black, Y then Cb and Cr. */
const BLACK = [16, 128, 128];

/**
 * A `<video srcObject>`'s picture: core's own `<video srcObject>` where the
 * source shows itself (a camera, on a layer of its own on macOS), and
 * otherwise a `VideoFrames` sink its frames are pushed into, a sink of the
 * size and format they come in, made again as those change. A track the
 * page disabled is black, at the size its frames have; a paused video
 * holds the frame it had.
 */
function StreamPicture(props: {
  stream: ShownSource;
  video: VideoProps;
}): ReactNode {
  const { stream, video } = props;
  const present = stream.enabled ? stream.present() : null;
  const settings = stream.settings();
  const [shape, setShape] = React.useState<{
    width: number;
    height: number;
    format: VideoFormat;
    colorSpace: VideoColorSpace;
  }>(() => ({
    width: Math.max(2, Math.round(settings.width ?? 2)),
    height: Math.max(2, Math.round(settings.height ?? 2)),
    format: 'I420',
    colorSpace: 'bt601',
  }));
  const sink = useVideoFrames(shape);
  const live = React.useRef({ sink, paused: !!video.paused });
  live.current = { sink, paused: !!video.paused };
  React.useEffect(() => {
    if (present) return;
    let black: Uint8Array[] | null = null;
    return stream.read((data) => {
      const frame = data as MediaVideoFrame;
      const format: VideoFormat = stream.enabled
        ? (frame.format ?? 'I420')
        : 'I420';
      const colorSpace = frame.colorSpace ?? 'bt601';
      const { sink, paused } = live.current;
      if (
        sink.width !== frame.width ||
        sink.height !== frame.height ||
        sink.format !== format ||
        sink.colorSpace !== colorSpace
      ) {
        black = null;
        setShape({
          width: frame.width,
          height: frame.height,
          format,
          colorSpace,
        });
        return;
      }
      if (paused || sink.closed) return;
      if (stream.enabled) {
        sink.push(frame.planes, {
          strides: frame.strides,
          time: frame.timestamp / 1e6,
        });
        return;
      }
      if (!black) {
        const cw = (frame.width + 1) >> 1;
        const ch = (frame.height + 1) >> 1;
        black = [
          new Uint8Array(frame.width * frame.height).fill(BLACK[0]),
          new Uint8Array(cw * ch).fill(BLACK[1]),
          new Uint8Array(cw * ch).fill(BLACK[2]),
        ];
        sink.push(black);
      }
    });
  }, [stream, present]);
  return present
    ? hx('video', { ...video, srcObject: present })
    : hx('video', { ...video, frames: sink });
}
