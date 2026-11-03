// An `<input type=range>`'s widget: core's `<Slider>`, and what HTML asks of
// a range that an application's slider does not.
//
// `<Slider>` is the drawing, the platform's own on a Mac, the accessible
// node and the stop in the Tab order. It takes every handler it is handed
// over its own, and each of these is taken, so that the one way a range moves
// is here: a press that a page cancelled moves nothing, a press on the thumb
// moves nothing until the pointer does, what it comes to is on the steps
// `form.ts` counts from the element's own base and not from its `min`, and a
// key does what it does in Chrome, in each writing mode. Its value is in
// `FormState`, as a field's is, and a move is told as `input` as it happens
// and as `change` once it is settled — at the release, and only where the
// range holds something other than it did at the press.
//
// Core's slider runs across and has no way to run down, so a range in a
// vertical writing mode is drawn here, from the same tokens. That half goes
// when core's can.
import React from 'react';
import type { ReactElement } from 'react';
import { Slider, useTheme } from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent as X11KeyboardEvent,
  MouseEvent as X11MouseEvent,
} from 'react-x11';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';
import type { Style } from 'react-x11/style';

import type { RangeLook, RangePart } from './controls.js';
import type { Element } from './dom.js';
import { rangeValue } from './form.js';
import type { FormState } from './form.js';
import { hx } from './hx.js';

const h = React.createElement;

/** How long the widget's own thumb is along the track: core's, and Blink's. */
const THUMB = 16;

/** How thick the track is that the widget here draws: core's. */
const TRACK = 4;

export interface RangeProps {
  element: Element;
  look: RangeLook;
  forms: FormState;
  disabled: boolean;
  tabIndex?: -1;
  /** What the pointer shows over it (`ControlRect.cursor`). */
  cursor?: string;
  /** The content box the widget fills. */
  size: { width: number; height: number };
  /** How far the element's border box reaches past that, each way: the
   *  element takes a press on all of it, as Chrome's does. */
  reach: { top: number; right: number; bottom: number; left: number };
  /** The user moved it: what it holds now, to keep and to tell. */
  moved: (value: string) => void;
  /** What it was moved to is settled: its `change`. */
  settled: () => void;
  focused: (on: boolean) => void;
  /** What asks each range to show what `FormState` holds, which a script
   *  changes with no render of anything else. */
  redraws: Map<Element, () => void>;
}

export function RangeWidget(props: RangeProps): ReactElement {
  const { element: el, look, forms, disabled, size, reach, redraws } = props;
  const { line, vertical, flipped } = look;
  const theme = useTheme();
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    redraws.set(el, redraw);
    return () => {
      redraws.delete(el);
    };
  }, [redraws, el]);

  const value = Number(forms.value(el));
  const span = line.max - line.min;
  const fraction = span > 0 ? (value - line.min) / span : 0;
  const part = look.thumb;
  // how long the thumb is along the track, how far it stands across it, and
  // how thick that makes the track, which is as thick as it where it says
  // nothing: Blink's holds its thumb
  const length = part ? ((vertical ? part.height : part.width) ?? 0) : THUMB;
  const across = part ? ((vertical ? part.width : part.height) ?? 0) : THUMB;
  const margin = vertical ? 0 : (part?.marginTop ?? 0);
  const thick =
    (vertical ? look.track?.width : look.track?.height) ?? across + margin;

  // what it held at the press, while the pointer has it
  const dragging = React.useRef<string | null>(null);
  // what lights the thumb the vertical half draws, as core's lights its own
  const [lit, setLit] = React.useState(false);

  /** What the range holds now, where that is news. */
  const set = (next: string): boolean => {
    if (next === forms.value(el)) return false;
    props.moved(next);
    redraw();
    return true;
  };

  /** Where along the track a point is, from where its thumb starts to
   *  where it ends: a share of the way, in the way the value grows, as
   *  `SliderThumbElement::SetPositionFromPoint` has it. */
  const shareAt = (ev: X11MouseEvent<DrawnNode>): number => {
    const box = (ev.currentTarget as DrawnNode).getClientRects()[0];
    const travel = Math.max(1, (vertical ? box.height : box.width) - length);
    const from = vertical ? ev.y - box.y : ev.x - box.x;
    const share = Math.min(1, Math.max(0, (from - length / 2) / travel));
    return flipped ? 1 - share : share;
  };
  /** Whether a point is on the thumb, which a press there leaves alone:
   *  only the pointer's moving from it moves the range. */
  const onThumb = (ev: X11MouseEvent<DrawnNode>): boolean => {
    const box = (ev.currentTarget as DrawnNode).getClientRects()[0];
    const run = vertical ? box.height : box.width;
    const at = flipped ? 1 - fraction : fraction;
    const centre = length / 2 + at * (run - length);
    const from = vertical ? ev.y - box.y : ev.x - box.x;
    return Math.abs(from - centre) <= length / 2;
  };
  const slide = (ev: X11MouseEvent<DrawnNode>) => {
    set(rangeValue(el, line.min + shareAt(ev) * span));
  };

  const handlers = {
    onMouseDown: (ev: X11MouseEvent<DrawnNode>) => {
      if (ev.defaultPrevented || ev.button !== 1) return;
      ev.capturePointer();
      dragging.current = forms.value(el);
      if (!onThumb(ev)) slide(ev);
    },
    onMouseMove: (ev: X11MouseEvent<DrawnNode>) => {
      if (dragging.current !== null) slide(ev);
    },
    onMouseUp: () => {
      // any button's, since core's capture ends with whichever comes up
      const from = dragging.current;
      if (from === null) return;
      dragging.current = null;
      if (from !== forms.value(el)) props.settled();
    },
    onKeyDown: (ev: X11KeyboardEvent<DrawnNode>) => {
      if (ev.defaultPrevented) return;
      const next = keyed(ev.keysym, value, look);
      if (next !== null && set(rangeValue(el, next))) props.settled();
    },
    onFocus: () => {
      setLit(true);
      props.focused(true);
    },
    onBlur: () => {
      setLit(false);
      props.focused(false);
    },
  };
  const live = disabled ? null : handlers;
  // the document draws the ring, as the outline `:focus-visible` gives the
  // element. A press is the element's on all of its box and on a thumb that
  // stands out of it, and on no more.
  const over = Math.max(
    0,
    (Math.max(thick, across) - (vertical ? size.width : size.height)) / 2,
  );
  const box: Style = {
    outlineWidth: 0,
    hitSlop: vertical
      ? { ...reach, left: reach.left + over, right: reach.right + over }
      : { ...reach, top: reach.top + over, bottom: reach.bottom + over },
  };

  if (vertical) {
    const thumb: Style = {
      width: THUMB,
      height: THUMB,
      borderRadius: THUMB / 2,
      borderWidth: 1,
      borderColor: disabled
        ? theme.border
        : lit || dragging.current !== null
          ? theme.accentHover
          : theme.border,
      backgroundColor: disabled ? theme.surfaceHover : theme.surface,
    };
    const along = `${fraction * 100}%` as const;
    return hx(
      'box',
      {
        role: 'slider',
        'aria-valuenow': value,
        'aria-valuemin': line.min,
        'aria-valuemax': line.max,
        'aria-orientation': 'vertical',
        ...(disabled ? { disabled: true } : { focusable: true }),
        ...(props.tabIndex !== undefined && { tabIndex: props.tabIndex }),
        ...live,
        style: [
          box,
          { width: '100%', height: '100%', alignItems: 'center' },
          { cursor: props.cursor },
        ],
      } as never,
      hx(
        'box',
        {
          style: [
            {
              width: TRACK,
              borderRadius: TRACK / 2,
              backgroundColor: theme.track,
            },
            look.track && [partStyle(look.track), { width: thick }],
            {
              height: '100%',
              flexDirection: flipped ? 'column-reverse' : 'column',
              pointerEvents: 'none',
            },
          ],
        },
        hx('box', {
          key: 'fill',
          style: [
            {
              width: '100%',
              backgroundColor: look.track
                ? 'transparent'
                : disabled
                  ? theme.textMuted
                  : theme.accent,
            },
            { flexGrow: fraction, flexShrink: 0, flexBasis: 0 },
          ],
        }),
        hx('box', {
          key: 'rest',
          style: { flexGrow: 1 - fraction, flexShrink: 0, flexBasis: 0 },
        }),
      ),
      hx('box', {
        style: [
          thumb,
          part && partStyle(part),
          {
            position: 'absolute',
            pointerEvents: 'none',
            ...(flipped
              ? { bottom: along, marginBottom: -length * fraction }
              : { top: along, marginTop: -length * fraction }),
          },
        ],
      }),
    );
  }

  return h(Slider, {
    value,
    min: line.min,
    max: line.max,
    step: line.step,
    disabled,
    // AppKit's bezel has no rtl, and a slot's style no bezel
    ...(flipped && { native: false }),
    ...slots(look, thick, size.height - thick),
    ...(props.tabIndex !== undefined && { tabIndex: props.tabIndex }),
    style: [
      box,
      {
        width: '100%',
        height: '100%',
        direction: flipped ? 'rtl' : 'ltr',
        cursor: props.cursor,
      },
    ],
    // what an assistive technology sets, the one way left that is core's
    onChange: (ev) => {
      if (set(rangeValue(el, ev.value))) props.settled();
    },
    ...live,
  } as React.ComponentProps<typeof Slider>);
}

/**
 * What a key makes of a range, or null for one that does nothing: Chrome's
 * (`RangeInputType::HandleKeydownEvent`), read from one in each writing mode
 * and direction. Up raises it wherever its value does not run down the page,
 * and the page keys and the ends are the same in all of them. A big step is a
 * tenth of the way, a `step=any` taking a hundredth for its small one.
 */
function keyed(
  keysym: number | undefined,
  value: number,
  look: RangeLook,
): number | null {
  const { line, vertical, flipped, leftRaises } = look;
  const span = line.max - line.min;
  const step = line.step || span / 100;
  const big = Math.max(span / 10, step);
  const upRaises = !vertical || flipped;
  switch (keysym) {
    case XK_UP:
      return value + (upRaises ? step : -step);
    case XK_DOWN:
      return value - (upRaises ? step : -step);
    case XK_LEFT:
      return value + (leftRaises ? step : -step);
    case XK_RIGHT:
      return value - (leftRaises ? step : -step);
    case XK_PAGE_UP:
      return value + big;
    case XK_PAGE_DOWN:
      return value - big;
    case XK_HOME:
      return line.min;
    case XK_END:
      return line.max;
    default:
      return null;
  }
}

/** A part as a slot's style: all of what it says, and none of the widget's
 *  own look that it does not. */
function partStyle(part: RangePart): Style {
  return {
    ...(part.width !== undefined && { width: part.width }),
    ...(part.height !== undefined && { height: part.height }),
    backgroundColor: part.backgroundColor ?? 'transparent',
    borderWidth: part.borderWidth ?? 0,
    ...(part.borderColor !== undefined && { borderColor: part.borderColor }),
    borderRadius: part.borderRadius ?? 0,
    ...(part.boxShadow !== undefined && { boxShadow: part.boxShadow }),
    ...(part.opacity !== undefined && { opacity: part.opacity }),
  };
}

/**
 * The slots of a `<Slider>` the page has taken parts of. A slot chooses the
 * drawn slider over the platform's, and that is what a page that draws its
 * own thumb means.
 *
 * Blink's thumb is in its track, from the track's top, and the track is
 * centred in the box. So a thumb taller than a track that says how thick it
 * is stands below it until the page's `margin-top` brings it back, which is
 * what every such page writes. Core's centres it, so it is told where it
 * stands: `room` is what the box has over the track.
 */
function slots(look: RangeLook, thick: number, room: number): object | null {
  const { thumb, track } = look;
  if (!thumb && !track) return null;
  return {
    thumbStyle: [
      thumb && partStyle(thumb),
      { top: room / 2 + (thumb?.marginTop ?? 0) },
    ],
    ...(track && {
      trackStyle: [partStyle(track), { height: thick }],
      fillStyle: { backgroundColor: 'transparent' },
    }),
  };
}
