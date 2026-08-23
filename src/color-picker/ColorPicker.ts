// <ColorPicker> — a saturation/value field over a hue slider, and whatever
// else the app asked for.
//
// Nothing here registers an element. The question `src/flow/` established is
// whether the feature's viewport is a *transform*; a picker's is not, so this
// is the `<Calendar>` shape — `<box>`, `<text>`, `<textinput>` and three
// `<canvas>` panes — and importing it has no side effect at all.
//
// The three panes are pictures, and they are cheap ones: ntk's 2d context
// hands out real XRender gradients, so the field is a hue fill plus two
// gradients rather than 36 000 pixels of JavaScript, and each pane carries a
// `cacheKey` naming everything its drawing reads. The **thumbs are not part
// of the drawing** — each is an absolutely positioned `<box>` — so a drag
// moves two numbers in a style and repaints a 12px node, instead of
// re-running the gradients on every pointer motion.
//
// The panes are square-cornered on purpose: ntk's rounded-rect fast path
// bails to polygon rasterization when the fill is not a plain colour (the
// `gradient` reason in `stats.shapes`), and a picker is the surface most
// likely to hit that cliff.
import React, { useImperativeHandle, useRef, useState } from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { createStyles } from 'react-x11/style';
import type { Style } from 'react-x11/style';
import { useEyedropper, useTheme } from 'react-x11';
import type {
  ChangeEvent,
  DrawnNode,
  KeyboardEvent,
  MouseEvent,
  TextInputNode,
} from 'react-x11';
import {
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_TAB,
  XK_UP,
} from 'react-x11/keysyms';

import { hx } from '../internal/hx.js';
import { changeEvent } from '../internal/widget.js';
import type { WidgetChangeEvent } from '../internal/widget.js';
import {
  channelsFromHsv,
  channelsFromRgb,
  contrastGrade,
  contrastRatio,
  formatColor,
  formatOf,
  opaqueHex,
  parseColor,
} from './color.js';
import type { ColorChannels, ColorFormat } from './color.js';

// The geometry. Fixed rather than fluid, for the reason `CALENDAR_WIDTH`
// exists: `<ColorField>` has to size a real X window around this *before* it
// is laid out, and it is also what lets the panes carry a `cacheKey` — a key
// naming a width the pane might not have is a stale picture.
const PAD = 10;
const GAP = 8;
const CONTENT = 240;
const AREA_H = 150;
const STRIP_H = 12;
const ROW_H = 26;
const SWATCH = 20;
const SWATCH_GAP = 6;
const THUMB = 12;
/** The checker under anything translucent, in device pixels. */
const CHECKER = 6;

/** How wide a `<ColorPicker>` lays out. */
export const COLOR_PICKER_WIDTH = CONTENT + PAD * 2;

const s = createStyles({
  root: {
    padding: PAD,
    gap: GAP,
    alignItems: 'stretch',
    width: COLOR_PICKER_WIDTH,
    // The geometry is a promise the panes' `cacheKey`s and the thumbs'
    // positions are both written against, so the panel does not shrink: a
    // squashed field would put the thumb somewhere the colour is not.
    flexShrink: 0,
  },
  area: {
    width: CONTENT,
    height: AREA_H,
    flexShrink: 0,
    position: 'relative',
    cursor: 'crosshair',
  },
  strip: {
    width: CONTENT,
    height: STRIP_H,
    flexShrink: 0,
    position: 'relative',
    cursor: 'pointer',
  },
  pane: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  areaThumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 2,
    borderColor: 'white',
  },
  stripThumb: {
    position: 'absolute',
    top: -2,
    width: 8,
    height: STRIP_H + 4,
    borderRadius: 3,
    borderWidth: 2,
    borderColor: 'white',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: ROW_H,
    flexShrink: 0,
  },
  preview: { width: ROW_H, height: ROW_H, flexShrink: 0 },
  field: { flexGrow: 1, height: ROW_H, paddingLeft: 6, paddingRight: 6 },
  readout: { flexGrow: 1 },
  button: {
    height: ROW_H,
    paddingLeft: 8,
    paddingRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    transition: { backgroundColor: 80 },
  },
  glyph: { width: 14, height: 14 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: SWATCH_GAP },
  swatch: { width: SWATCH, height: SWATCH, cursor: 'pointer' },
  contrast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: ROW_H,
  },
});

/** The parts a picker is made of, in the order they are stacked. */
export type ColorPickerPart =
  'area' | 'hue' | 'alpha' | 'fields' | 'swatches' | 'recent' | 'contrast';

/** A preset. The bare string is the common case; the object is for a preset
 *  whose name is worth reading out ("Brand primary"). */
export type ColorSwatch = string | { value: string; label?: string };

const swatchValue = (sw: ColorSwatch): string =>
  typeof sw === 'string' ? sw : sw.value;
const swatchLabel = (sw: ColorSwatch): string =>
  typeof sw === 'string' ? sw : (sw.label ?? sw.value);

/**
 * What `onChange` is handed.
 *
 * A {@link WidgetChangeEvent} — `{ type, target: { type, name, value } }`,
 * the shape a form library destructures — **plus** `color`. `ev.value` is the
 * string, and `ev.color` is what it was built from, which is how an app that
 * wants channels gets them without a second callback or an object-valued
 * `value`. `ev.color.h` is the live hue, which the string cannot always carry:
 * every black is hue 0 once it is written down.
 */
export interface ColorChangeEvent extends WidgetChangeEvent<string> {
  color: ColorChannels;
}

function colorChangeEvent(
  name: string | undefined,
  value: string,
  color: ColorChannels,
): ColorChangeEvent {
  return { ...changeEvent('color', name, value), color };
}

export interface ColorPickerHandle {
  /** Focus the first axis. */
  focus: () => void;
  /** Feed the picker a key it did not receive itself — what `<ColorField>`
   *  uses, the way `<DatePicker>` feeds `<Calendar>`. Answers whether the
   *  picker took it. */
  handleKey: (ev: KeyboardEvent) => boolean;
  readonly value: string;
  readonly channels: ColorChannels;
}

export interface ColorPickerProps {
  /** The colour, controlled. Any CSS colour this package can parse — which is
   *  more than the renderer can paint; see `formatColor` for what comes out. */
  value?: string;
  /** The colour, uncontrolled. Defaults to `#000000`. */
  defaultValue?: string;
  /** Every step of a drag, every arrow key, every accepted edit of the field. */
  onChange?: (ev: ColorChangeEvent) => void;
  /** The same event, on pointer release and on each keyboard commit — for an
   *  app whose re-render is too expensive to run per pointer step. */
  onChangeEnd?: (ev: ColorChangeEvent) => void;
  /** Carried on `ev.target.name`, for form libraries. */
  name?: string;
  /** Show the alpha strip, and emit alpha. Off by default: a picker without
   *  the strip must not start emitting `rgba()` because the value it was
   *  handed had one. */
  alpha?: boolean;
  /** The output spelling. `'auto'` (the default) follows the spelling the
   *  incoming value used, and hex when it used none. */
  format?: ColorFormat | 'auto';
  /** Presets, as a row under the panel. */
  swatches?: readonly ColorSwatch[];
  /** The app's recently-used colours, as a second row. Nothing is stored
   *  here — a picker that remembered would be a store. */
  recent?: readonly ColorSwatch[];
  /** Which parts appear, and in what order. Defaults to the parts the other
   *  props imply: the field and the hue slider, alpha when `alpha`, the
   *  fields row, and a row per non-empty swatch list. */
  parts?: readonly ColorPickerPart[];
  /** The eyedropper button. `true` (the default) shows it wherever core can
   *  sample the screen — `useEyedropper().supported`. A function replaces the
   *  sampler with your own, which is also how a test drives it. */
  eyedropper?: boolean | (() => Promise<string | null>);
  /** A colour to measure the value against: the `'contrast'` part shows the
   *  WCAG ratio and its grade. */
  contrast?: string;
  disabled?: boolean;
  /** Whether the panel takes the keyboard itself. `<ColorField>` sets this
   *  false and feeds keys through the handle, because an override-redirect
   *  popup never takes focus. */
  focusable?: boolean;
  /** Draw the axis cursor even without the focus — the other half of
   *  `focusable={false}`. */
  focusVisible?: boolean;
  style?: Style | Style[];
  'data-testname'?: string;
  ref?: Ref<ColorPickerHandle>;
  children?: ReactNode;
}

/** The rows a set of parts adds up to — `<ColorField>` needs the height of
 *  the panel before the panel exists. */
export function colorPickerHeight(
  parts: readonly ColorPickerPart[],
  counts: { swatches?: number; recent?: number } = {},
): number {
  const perRow = Math.floor((CONTENT + SWATCH_GAP) / (SWATCH + SWATCH_GAP));
  const rows = (n: number): number =>
    n
      ? Math.ceil(n / perRow) * SWATCH +
        (Math.ceil(n / perRow) - 1) * SWATCH_GAP
      : 0;
  const heightOf = (part: ColorPickerPart): number => {
    switch (part) {
      case 'area':
        return AREA_H;
      case 'hue':
      case 'alpha':
        return STRIP_H;
      case 'fields':
      case 'contrast':
        return ROW_H;
      case 'swatches':
        return rows(counts.swatches ?? 0);
      case 'recent':
        return rows(counts.recent ?? 0);
      default:
        return 0;
    }
  };
  const heights = parts.map(heightOf).filter((h) => h > 0);
  return (
    PAD * 2 +
    heights.reduce((sum, h) => sum + h, 0) +
    Math.max(0, heights.length - 1) * GAP
  );
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The checkerboard under anything translucent. Two greys rather than a
 *  theme colour: it is a *hole*, and a hole looks the same on every palette. */
function drawChecker(ctx: any, width: number, height: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#c8c8c8';
  for (let y = 0; y < height; y += CHECKER) {
    for (let x = 0; x < width; x += CHECKER) {
      if (((x / CHECKER) & 1) === ((y / CHECKER) & 1)) continue;
      ctx.fillRect(
        x,
        y,
        Math.min(CHECKER, width - x),
        Math.min(CHECKER, height - y),
      );
    }
  }
}

/**
 * The dropper glyph: the bulb at the top right, the stem running down to the
 * left, and the tip it draws with. Three shapes rather than one clever path,
 * because at 14 pixels a pipette reads only if the bulb and the tip are both
 * solid — the first draft was a single stroke and looked like a slash.
 */
function EyedropperGlyph({ color }: { color: string }): ReactElement {
  return hx('canvas', {
    style: s.glyph,
    cacheKey: `eyedropper:${color}`,
    onDraw: (ctx, { width, height }) => {
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      // the bulb
      ctx.beginPath();
      ctx.arc(width - 3.5, 3.5, 3, 0, Math.PI * 2);
      ctx.fill();
      // the stem
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(width - 5, 5);
      ctx.lineTo(4.5, height - 4.5);
      ctx.stroke();
      // the tip, pointing at what it will sample
      ctx.beginPath();
      ctx.moveTo(1, height - 1);
      ctx.lineTo(5.5, height - 2.5);
      ctx.lineTo(2.5, height - 5.5);
      ctx.closePath();
      ctx.fill();
    },
  });
}

/**
 * `<ColorPicker value onChange>` — the colour panel.
 *
 *   <ColorPicker value={accent} onChange={(ev) => setAccent(ev.value)} />
 *   <ColorPicker … alpha swatches={brand.colors} />
 *   <ColorPicker … parts={['swatches']} />          // the palette-only shape
 *
 * The value is a **CSS colour string**, the way a `<Calendar>`'s day is a
 * `'YYYY-MM-DD'` string: it drops straight into `backgroundColor`, survives
 * JSON, and needs no constructor. What it cannot carry is the hue behind a
 * black or a grey, so the picker holds HSVA of its own and adopts the `value`
 * prop only when that prop is not the string it last emitted. Drag the
 * brightness to zero and back and the hue is still where it was.
 */
export function ColorPicker(props: ColorPickerProps): ReactElement {
  const {
    value,
    defaultValue,
    onChange,
    onChangeEnd,
    name,
    alpha = false,
    format = 'auto',
    swatches,
    recent,
    parts,
    eyedropper = true,
    contrast,
    disabled = false,
    focusable = true,
    focusVisible,
    style,
    children,
    ref,
  } = props;

  const theme = useTheme();
  const [model, setModel] = useState<ColorChannels>(
    () =>
      parseColor(value ?? defaultValue ?? '') ?? channelsFromHsv(0, 0, 0, 1),
  );
  // What the last emitted string was, so that an app echoing it back is a
  // no-op rather than a re-parse that loses the hue.
  const emitted = useRef<string | null>(null);
  // The spelling `format="auto"` follows: whatever the last string that came
  // *in* was written in.
  const [sourceFormat, setSourceFormat] = useState<ColorFormat>(
    () => formatOf(value ?? defaultValue ?? '') ?? 'hex',
  );
  const [prevValue, setPrevValue] = useState(value);
  const [dragging, setDragging] = useState<'area' | 'hue' | 'alpha' | null>(
    null,
  );
  const [active, setActive] = useState<'area' | 'hue' | 'alpha'>('area');
  const [focused, setFocused] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [textModel, setTextModel] = useState<ColorFormat>('hex');
  const areaRef = useRef<DrawnNode | null>(null);
  const hueRef = useRef<DrawnNode | null>(null);
  const alphaRef = useRef<DrawnNode | null>(null);

  // Controlled reconciliation, at render — React's own "adjusting state when
  // a prop changes" pattern. The hue of the model survives a value that has
  // none of its own, which is what makes dragging through black work.
  if (value !== undefined && value !== prevValue) {
    setPrevValue(value);
    if (value !== emitted.current) {
      const parsed = parseColor(value);
      if (parsed) {
        setModel(
          channelsFromRgb(parsed.r, parsed.g, parsed.b, parsed.a, model.h),
        );
        setSourceFormat(formatOf(value) ?? sourceFormat);
        setTyped(null);
      }
    }
  }

  const outputFormat: ColorFormat = format === 'auto' ? sourceFormat : format;
  const text = formatColor(model, outputFormat, alpha);
  const dropper = useEyedropper();

  const emit = (
    next: ColorChannels,
    done: boolean,
    // The spelling to emit in, when the caller already knows it: `setState`
    // does not land until the next render, so a swatch or a typed value that
    // brings its own format has to hand it over rather than set it and read
    // it back in the same handler.
    spelling: ColorFormat = outputFormat,
  ): void => {
    const out = formatColor(next, spelling, alpha);
    emitted.current = out;
    setModel(next);
    setTyped(null);
    const ev = colorChangeEvent(name, out, next);
    onChange?.(ev);
    if (done) onChangeEnd?.(ev);
  };

  /** Commit whatever the current model is — the release of a drag, and the
   *  end of a keyboard step. */
  const commit = (next: ColorChannels): void => emit(next, true);

  /** Take a colour from somewhere that is not this widget — the screen, or a
   *  swatch. The hue comes along when the new colour has none of its own, and
   *  the alpha only when there is a strip to show it on. */
  const adopt = (colour: string): void => {
    const parsed = parseColor(colour);
    if (!parsed) return;
    const spelling = formatOf(colour) ?? sourceFormat;
    setSourceFormat(spelling);
    emit(
      channelsFromRgb(
        parsed.r,
        parsed.g,
        parsed.b,
        alpha ? parsed.a : 1,
        model.h,
      ),
      true,
      format === 'auto' ? spelling : outputFormat,
    );
  };

  // `eyedropper` is a switch and a seam at once: `true` takes core's sampler
  // — `useEyedropper()` answers `supported: false` where there is none, which
  // is the button's existence — and a function replaces it, which is both the
  // kiosk case and how a test drives a pick without a server.
  const ownDropper = typeof eyedropper === 'function' ? eyedropper : null;
  const showDropper =
    !disabled &&
    (ownDropper !== null || (eyedropper !== false && dropper.supported));
  const pickFromScreen = (): void => {
    const pick = ownDropper ?? dropper.pick;
    void Promise.resolve(pick()).then((hex) => {
      // null is a cancel, and a cancel leaves the colour alone.
      if (hex) adopt(hex);
    });
  };

  const setHsv = (h: number, sat: number, v: number, done = false): void =>
    emit(channelsFromHsv(h, sat, v, model.a), done);

  // --- pointer ------------------------------------------------------------

  const fractionIn = (
    node: DrawnNode | null,
    ev: MouseEvent,
  ): { x: number; y: number } | null => {
    const box = node?.abs;
    if (!box?.width || !box.height) return null;
    return {
      x: clamp01((ev.x - box.x) / box.width),
      y: clamp01((ev.y - box.y) / box.height),
    };
  };

  const areaTo = (ev: MouseEvent, done: boolean): void => {
    const at = fractionIn(areaRef.current, ev);
    if (at) setHsv(model.h, at.x, 1 - at.y, done);
  };
  const hueTo = (ev: MouseEvent, done: boolean): void => {
    const at = fractionIn(hueRef.current, ev);
    if (at) setHsv(at.x * 360, model.s, model.v, done);
  };
  const alphaTo = (ev: MouseEvent, done: boolean): void => {
    const at = fractionIn(alphaRef.current, ev);
    if (at) emit(channelsFromHsv(model.h, model.s, model.v, at.x), done);
  };

  const track = (
    axis: 'area' | 'hue' | 'alpha',
    to: (ev: MouseEvent, done: boolean) => void,
  ): Record<string, (ev: MouseEvent) => void> =>
    disabled
      ? {}
      : {
          onMouseDown: (ev: MouseEvent) => {
            ev.capturePointer();
            setDragging(axis);
            setActive(axis);
            to(ev, false);
          },
          onMouseMove: (ev: MouseEvent) => {
            if (dragging === axis) to(ev, false);
          },
          onMouseUp: (ev: MouseEvent) => {
            if (dragging !== axis) return;
            setDragging(null);
            to(ev, true);
          },
        };

  // --- keyboard -----------------------------------------------------------

  const axes = (): ('area' | 'hue' | 'alpha')[] =>
    (['area', 'hue', 'alpha'] as const).filter((part) => shown.includes(part));

  const step = (ev: KeyboardEvent, coarse: number, fine: number): number =>
    ev.shiftKey ? coarse : fine;

  const handleKey = (ev: KeyboardEvent): boolean => {
    if (disabled) return false;
    const axis = axes().includes(active) ? active : (axes()[0] ?? 'area');
    const dx = step(ev, 0.1, 0.01);
    switch (ev.keysym) {
      case XK_LEFT:
      case XK_RIGHT: {
        const dir = ev.keysym === XK_LEFT ? -1 : 1;
        if (axis === 'hue')
          setHsv(model.h + dir * step(ev, 10, 1), model.s, model.v, true);
        else if (axis === 'alpha')
          commit(
            channelsFromHsv(model.h, model.s, model.v, model.a + dir * dx),
          );
        else setHsv(model.h, model.s + dir * dx, model.v, true);
        return true;
      }
      case XK_UP:
      case XK_DOWN: {
        if (axis !== 'area') return false;
        const dir = ev.keysym === XK_UP ? 1 : -1;
        setHsv(model.h, model.s, model.v + dir * dx, true);
        return true;
      }
      case XK_HOME:
      case XK_END: {
        const end = ev.keysym === XK_END;
        if (axis === 'hue') setHsv(end ? 360 : 0, model.s, model.v, true);
        else if (axis === 'alpha')
          commit(channelsFromHsv(model.h, model.s, model.v, end ? 1 : 0));
        else setHsv(model.h, end ? 1 : 0, model.v, true);
        return true;
      }
      case XK_PAGE_UP:
      case XK_PAGE_DOWN: {
        if (axis !== 'area') return false;
        setHsv(model.h, model.s, ev.keysym === XK_PAGE_UP ? 1 : 0, true);
        return true;
      }
      case XK_TAB: {
        // Only ours when the panel does not own the focus: a picker on a
        // popup is fed its keys by the trigger, and without this its hue
        // slider would be unreachable from the keyboard. Answering `false` at
        // the ends is what lets Tab leave the picker.
        if (focusable) return false;
        const list = axes();
        const at = list.indexOf(axis);
        const next = at + (ev.shiftKey ? -1 : 1);
        if (next < 0 || next >= list.length) return false;
        setActive(list[next]);
        return true;
      }
      default:
        return false;
    }
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      areaRef.current?.focus() ?? hueRef.current?.focus();
    },
    handleKey,
    get value() {
      return text;
    },
    get channels() {
      return model;
    },
  }));

  // --- the parts ----------------------------------------------------------

  const shown: ColorPickerPart[] =
    parts !== undefined
      ? [...parts]
      : [
          'area',
          'hue',
          ...(alpha ? (['alpha'] as const) : []),
          'fields',
          ...(swatches?.length ? (['swatches'] as const) : []),
          ...(recent?.length ? (['recent'] as const) : []),
          ...(contrast ? (['contrast'] as const) : []),
        ];

  const cursorShown = focusVisible ?? focused;
  const hue = opaqueHex(channelsFromHsv(model.h, 1, 1));
  const ink = disabled ? theme.textMuted : theme.text;

  const axisProps = (
    axis: 'area' | 'hue' | 'alpha',
    label: string,
    valueText: string,
    now: number,
    max: number,
  ): Record<string, unknown> => ({
    role: 'slider',
    'aria-label': label,
    // The number alone means nothing read out loud, so every axis says what
    // it is in words as well — the one part of React Aria's colour grammar
    // that is pure gain.
    'aria-valuetext': valueText,
    'aria-valuenow': Math.round(now),
    'aria-valuemin': 0,
    'aria-valuemax': max,
    'aria-disabled': disabled || undefined,
    focusable: focusable && !disabled,
    onFocus: () => {
      setFocused(true);
      setActive(axis);
    },
    onBlur: () => setFocused(false),
    onKeyDown: focusable ? handleKey : undefined,
  });

  const renderArea = (): ReactElement =>
    hx(
      'box',
      {
        key: 'area',
        ref: areaRef,
        ...axisProps(
          'area',
          'Saturation and brightness',
          `saturation ${Math.round(model.s * 100)}%, brightness ${Math.round(model.v * 100)}%`,
          model.s * 100,
          100,
        ),
        style: [
          s.area,
          {
            borderWidth: theme.borderWidth,
            borderColor:
              cursorShown && active === 'area'
                ? theme.borderFocus
                : theme.border,
          },
        ],
        ...track('area', areaTo),
      },
      hx('canvas', {
        style: s.pane,
        // Everything the drawing reads: the hue, and the size, which is a
        // constant here precisely so this key can name it.
        cacheKey: `sv:${Math.round(model.h)}:${CONTENT}x${AREA_H}`,
        onDraw: (ctx, { width, height }) => {
          ctx.fillStyle = hue;
          ctx.fillRect(0, 0, width, height);
          // Legacy comma spelling in the stops, for the same reason
          // `formatColor` emits it: it is what ntk's parser understands.
          const white = ctx.createLinearGradient(0, 0, width, 0);
          white.addColorStop(0, 'rgb(255, 255, 255)');
          white.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = white;
          ctx.fillRect(0, 0, width, height);
          const black = ctx.createLinearGradient(0, 0, 0, height);
          black.addColorStop(0, 'rgba(0, 0, 0, 0)');
          black.addColorStop(1, 'rgb(0, 0, 0)');
          ctx.fillStyle = black;
          ctx.fillRect(0, 0, width, height);
        },
      }),
      hx('box', {
        style: [
          s.areaThumb,
          {
            left: model.s * CONTENT - THUMB / 2,
            top: (1 - model.v) * AREA_H - THUMB / 2,
            backgroundColor: opaqueHex(model),
          },
        ],
      }),
    );

  const renderHue = (): ReactElement =>
    hx(
      'box',
      {
        key: 'hue',
        ref: hueRef,
        ...axisProps(
          'hue',
          'Hue',
          `hue ${Math.round(model.h)} degrees`,
          model.h,
          360,
        ),
        style: [
          s.strip,
          {
            borderWidth: theme.borderWidth,
            borderColor:
              cursorShown && active === 'hue'
                ? theme.borderFocus
                : theme.border,
          },
        ],
        ...track('hue', hueTo),
      },
      hx('canvas', {
        style: s.pane,
        cacheKey: `hue:${CONTENT}x${STRIP_H}`,
        onDraw: (ctx, { width, height }) => {
          const ramp = ctx.createLinearGradient(0, 0, width, 0);
          for (let stop = 0; stop <= 6; stop += 1) {
            ramp.addColorStop(
              stop / 6,
              opaqueHex(channelsFromHsv(stop * 60, 1, 1)),
            );
          }
          ctx.fillStyle = ramp;
          ctx.fillRect(0, 0, width, height);
        },
      }),
      hx('box', {
        style: [
          s.stripThumb,
          { left: (model.h / 360) * CONTENT - 4, backgroundColor: hue },
        ],
      }),
    );

  const renderAlpha = (): ReactElement =>
    hx(
      'box',
      {
        key: 'alpha',
        ref: alphaRef,
        ...axisProps(
          'alpha',
          'Opacity',
          `opacity ${Math.round(model.a * 100)}%`,
          model.a * 100,
          100,
        ),
        style: [
          s.strip,
          {
            borderWidth: theme.borderWidth,
            borderColor:
              cursorShown && active === 'alpha'
                ? theme.borderFocus
                : theme.border,
          },
        ],
        ...track('alpha', alphaTo),
      },
      hx('canvas', {
        style: s.pane,
        cacheKey: `alpha:${opaqueHex(model)}:${CONTENT}x${STRIP_H}`,
        onDraw: (ctx, { width, height }) => {
          drawChecker(ctx, width, height);
          const ramp = ctx.createLinearGradient(0, 0, width, 0);
          const { r, g, b } = model;
          ramp.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
          ramp.addColorStop(1, `rgb(${r}, ${g}, ${b})`);
          ctx.fillStyle = ramp;
          ctx.fillRect(0, 0, width, height);
        },
      }),
      hx('box', {
        style: [
          s.stripThumb,
          { left: model.a * CONTENT - 4, backgroundColor: opaqueHex(model) },
        ],
      }),
    );

  /** A colour chip: the checkerboard, then the colour over it. Used for the
   *  preview and for every swatch, so a translucent preset reads as one. */
  const chip = (
    // `where` is part of the cache key, not decoration: every chip is the
    // same drawing at a different size, and a key that named only the colour
    // would let a 16px contrast chip composite a 26px preview's surface. The
    // sizes are constants per call site, so the name is enough to separate
    // them — this is the "a key that leaves an input out shows stale pixels"
    // trap, found by looking at a real window.
    where: 'preview' | 'swatch' | 'contrast',
    colour: ColorChannels,
    style: Style | Style[],
    key?: string,
  ): ReactElement =>
    hx('canvas', {
      key,
      style,
      cacheKey: `chip:${where}:${formatColor(colour, 'hex', true)}`,
      onDraw: (ctx, { width, height }) => {
        if (colour.a < 1) drawChecker(ctx, width, height);
        const { r, g, b, a } = colour;
        ctx.fillStyle =
          a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : opaqueHex(colour);
        ctx.fillRect(0, 0, width, height);
      },
    });

  /** What the field accepted, or a revert. A typed value that is not a colour
   *  is not an error state — the field simply goes back to the model, which
   *  is what every other picker does and what an escape key would have. */
  const applyText = (raw: string): void => {
    if (parseColor(raw)) adopt(raw);
    else setTyped(null);
  };

  const modelText = (): string => {
    if (textModel === 'hex') return formatColor(model, 'hex', alpha);
    if (textModel === 'rgb') return formatColor(model, 'rgb', alpha);
    return formatColor(model, 'hsl', alpha);
  };

  const renderFields = (): ReactElement =>
    hx(
      'box',
      { key: 'fields', style: s.row },
      chip('preview', model, [
        s.preview,
        { borderWidth: theme.borderWidth, borderColor: theme.border },
      ]),
      // An override-redirect popup never takes the focus, so a `<textinput>`
      // inside one could never be typed into — `<ColorField>` renders the
      // value as a readout instead, and its own trigger is where a typed
      // colour goes.
      focusable
        ? hx('textinput', {
            value: typed ?? modelText(),
            'aria-label': 'Colour value',
            disabled: disabled || undefined,
            style: [
              s.field,
              {
                borderWidth: theme.borderWidth,
                borderRadius: theme.radius,
                borderColor: theme.border,
                backgroundColor: theme.surface,
                fontFamily: theme.monoFamily,
              },
            ],
            onChange: (ev: ChangeEvent<TextInputNode>) => setTyped(ev.value),
            onSubmit: () => applyText(typed ?? ''),
            onBlur: () => (typed === null ? undefined : applyText(typed)),
            onKeyDown: (ev: KeyboardEvent) => {
              if (ev.keysym === XK_ESCAPE) setTyped(null);
              else if (ev.keysym === XK_RETURN) applyText(typed ?? '');
            },
          })
        : hx(
            'text',
            {
              style: [s.readout, { color: ink, fontFamily: theme.monoFamily }],
            },
            modelText(),
          ),
      hx(
        'box',
        {
          role: 'button',
          'aria-label': `Value as ${textModel.toUpperCase()} — press to change`,
          focusable: focusable && !disabled,
          style: [
            s.button,
            {
              borderRadius: theme.radius,
              ':hover': { backgroundColor: theme.surfaceHover },
              ':active': { backgroundColor: theme.surfaceActive },
            },
          ],
          onClick: disabled
            ? undefined
            : () => {
                setTyped(null);
                setTextModel(
                  textModel === 'hex'
                    ? 'rgb'
                    : textModel === 'rgb'
                      ? 'hsl'
                      : 'hex',
                );
              },
        },
        hx(
          'text',
          { style: { color: ink, fontSize: 11 } },
          textModel.toUpperCase(),
        ),
      ),
      showDropper &&
        hx(
          'box',
          {
            role: 'button',
            'aria-label': 'Pick a colour from the screen',
            focusable: focusable && !disabled,
            disabled: disabled || dropper.picking || undefined,
            style: [
              s.button,
              {
                borderRadius: theme.radius,
                ':hover': { backgroundColor: theme.surfaceHover },
                ':active': { backgroundColor: theme.surfaceActive },
              },
            ],
            onClick: disabled || dropper.picking ? undefined : pickFromScreen,
          },
          React.createElement(EyedropperGlyph, { color: ink }),
        ),
    );

  const renderSwatches = (
    key: 'swatches' | 'recent',
    list: readonly ColorSwatch[],
  ): ReactElement =>
    hx(
      'box',
      {
        key,
        role: 'group',
        'aria-label': key === 'recent' ? 'Recent colours' : 'Swatches',
        style: s.swatches,
      },
      ...list.map((sw, i) => {
        const parsed = parseColor(swatchValue(sw));
        const chosen =
          parsed &&
          formatColor(parsed, 'hex', true) === formatColor(model, 'hex', true);
        return hx(
          'box',
          {
            key: `${key}:${i}`,
            role: 'button',
            'aria-label': swatchLabel(sw),
            'aria-pressed': Boolean(chosen),
            focusable: focusable && !disabled,
            style: [
              s.swatch,
              {
                borderRadius: theme.radius,
                borderWidth: chosen ? 2 : theme.borderWidth,
                borderColor: chosen ? theme.accent : theme.border,
              },
            ],
            onClick: disabled ? undefined : () => adopt(swatchValue(sw)),
            onKeyDown: (ev: KeyboardEvent) => {
              if (disabled) return;
              if (ev.keysym === XK_RETURN || ev.codepoint === 32)
                adopt(swatchValue(sw));
            },
          },
          parsed ? chip('swatch', parsed, s.pane) : null,
        );
      }),
    );

  const renderContrast = (): ReactElement | null => {
    if (!contrast) return null;
    const ratio = contrastRatio(model, contrast);
    if (ratio === null) return null;
    const grade = contrastGrade(ratio);
    const colour =
      grade === 'fail'
        ? theme.danger
        : grade === 'AA'
          ? theme.warning
          : theme.success;
    return hx(
      'box',
      { key: 'contrast', style: s.contrast },
      chip('contrast', parseColor(contrast) ?? model, [
        {
          width: 16,
          height: 16,
          borderWidth: theme.borderWidth,
          borderColor: theme.border,
        },
      ]),
      hx(
        'text',
        { style: { color: ink, fontSize: 11, flexGrow: 1 } },
        `${ratio.toFixed(2)}:1`,
      ),
      hx(
        'text',
        { style: { color: colour, fontSize: 11, fontWeight: 'bold' } },
        grade,
      ),
    );
  };

  const renderPart = (part: ColorPickerPart): ReactElement | null => {
    switch (part) {
      case 'area':
        return renderArea();
      case 'hue':
        return renderHue();
      case 'alpha':
        return renderAlpha();
      case 'fields':
        return renderFields();
      case 'swatches':
        return swatches?.length ? renderSwatches('swatches', swatches) : null;
      case 'recent':
        return recent?.length ? renderSwatches('recent', recent) : null;
      case 'contrast':
        return renderContrast();
      default:
        return null;
    }
  };

  // `data-testname` is a runtime convention — react-x11's queries read it off
  // `props` — and its element declarations do not carry it, so it is attached
  // past the type the way `<Terminal>` does.
  return hx(
    'box',
    {
      theme,
      role: 'group',
      'aria-label': 'Colour picker',
      'aria-disabled': disabled || undefined,
      style: [s.root, style],
      'data-testname': props['data-testname'],
    } as Parameters<typeof hx<'box'>>[1],
    ...shown.map(renderPart),
    children,
  );
}
