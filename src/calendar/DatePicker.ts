// <DatePicker> — a <Calendar> on a <popup>, hung off a field that shows the
// current date. Ported from react-x11's `src/components/DatePicker.js`.
import React, { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createStyles } from 'react-x11/style';
import type { Style, StyleProperties } from 'react-x11/style';
import { useAnchor, useAnchorTracking, useTheme } from 'react-x11';
import type {
  AnchorOptions,
  AnchorRect,
  DrawnNode,
  KeyboardEvent,
} from 'react-x11';
import { XK_DOWN, XK_ESCAPE, XK_RETURN, XK_UP } from 'react-x11/keysyms';

import { hx } from './hx.js';
import { useDismissOnWindowBlur } from './internal.js';
import type { WidgetChangeEvent } from './internal.js';
import { CALENDAR_HEIGHT, CALENDAR_WIDTH, Calendar } from './Calendar.js';
import type {
  CalendarHandle,
  CalendarProps,
  DateRange,
  DateRangeInput,
} from './Calendar.js';
import { formatDay, formatDayRange, toDay } from './dates.js';
import type { DayInput } from './dates.js';

// A hairline round the sheet, as the menus and `Select` use: this border is
// where the popup meets the desktop, not a control's outline, so a theme that
// draws 2px borders on its buttons does not get a 2px frame here.
const SHEET_BORDER = 1;

/**
 * `'@supports transparency'` is a real style block — react-x11 answers it from
 * whether the display gave the window an ARGB visual — but its `Style` type
 * models only the `@width`/`@height` size queries and the `:state` blocks. So
 * the block is spelled out here rather than by augmenting `StyleBlocks`
 * globally: this package should not quietly widen what type-checks in an app
 * that merely installs it.
 */
type SupportsStyle = Style & {
  '@supports transparency'?: StyleProperties;
};

const s = createStyles({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    paddingLeft: 10,
    paddingRight: 10,
    cursor: 'pointer',
  },
  label: { flexGrow: 1 },
  icon: { width: 14, height: 14, flexShrink: 0 },
  sheet: { flexGrow: 1, flexShrink: 1, borderWidth: SHEET_BORDER },
});

/** A wall calendar, 14×14: the page, its two hangers and the ruled week. */
function CalendarGlyph({ color }: { color: string }): ReactElement {
  return hx('canvas', {
    style: s.icon,
    onDraw: (ctx, { width, height }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 2.5, width - 1, height - 3);
      ctx.beginPath();
      ctx.moveTo(0.5, 6.5);
      ctx.lineTo(width - 0.5, 6.5);
      ctx.moveTo(4.5, 0.5);
      ctx.lineTo(4.5, 3.5);
      ctx.moveTo(width - 4.5, 0.5);
      ctx.lineTo(width - 4.5, 3.5);
      ctx.stroke();
    },
  });
}

/** What the trigger says, when the app has not said it itself. */
function defaultFormat(
  mode: string,
  value: unknown,
  locale: string | undefined,
): string | null {
  if (mode === 'range') {
    const range = (value ?? {}) as DateRangeInput;
    const start = toDay(range.start);
    const end = toDay(range.end);
    if (!start) return null;
    if (!end) return `${formatDay(start, locale)} → …`;
    return formatDayRange(start, end, locale);
  }
  const day = toDay(value as DayInput);
  return day ? formatDay(day, locale) : null;
}

type PickerOwnProps = {
  /** What the trigger shows. Defaults to the locale's medium date, and
   *  `Intl`'s own range format when there are two of them. */
  format?: (value: unknown) => string | null;
  /** Shown when nothing is picked yet. */
  placeholder?: string;
  disabled?: boolean;
  style?: Style | Style[];
};

/**
 * `Omit` over a union collapses it into one member, which would cost the
 * picker the thing that makes it pleasant to use: `mode` discriminating
 * single from range, and with it the type of the `onChange` parameter. So the
 * omit is distributed across the union instead, and `<DatePicker mode="range"
 * onChange={(ev) => …}>` still knows `ev.value` is a `DateRange`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type DatePickerProps = DistributiveOmit<
  CalendarProps,
  'focusable' | 'focusVisible' | 'ref' | 'style'
> &
  PickerOwnProps;

/**
 * <DatePicker value onChange …boxProps> — a `<Calendar>` on a `<popup>`, hung
 * off a field that shows the current date.
 *
 *   <DatePicker value={day} onChange={(ev) => setDay(ev.value)} />
 *   <DatePicker mode="range" value={span} onChange={…} max="2026-12-31" />
 *
 * Every calendar prop passes straight through — `mode`, `min`/`max`,
 * `isDateBlocked`, `spanBlocked`, `dayContent`, `locale`, `weekStartsOn` — and
 * the value has the same shape here as there: a `'YYYY-MM-DD'` day, or
 * `{ start, end }` in range mode.
 *
 * The calendar opens on the **press**, not the release, for the reason
 * `Select`'s menu does: a control whose whole purpose is to be looked at has
 * nothing to gain from waiting out the length of the click. It closes when the
 * value is complete — the day in single mode, the second end of a range — on
 * Escape, on a second press of the trigger, and when the window loses focus.
 *
 * The popup is override-redirect and never takes focus, so the **trigger keeps
 * the keyboard** and hands the calendar its keys: Down/Up/Enter/Space open it,
 * and once it is open everything the grid understands (arrows, Home/End,
 * PageUp/PageDown, Enter, Space) goes there. Escape and Tab stay here, which
 * is why `handleKey` reports whether it took the key.
 *
 * `format(value)` is the seam for the label: the default is the locale's
 * medium date, and `Intl`'s own range format when there are two of them, which
 * collapses the parts the ends share ("7 – 12 Aug 2026").
 */
export function DatePicker(props: DatePickerProps): ReactElement {
  const {
    mode = 'single',
    value,
    defaultValue,
    onChange,
    name,
    month,
    defaultMonth,
    onMonthChange,
    min,
    max,
    isDateBlocked,
    spanBlocked,
    dayContent,
    locale,
    weekStartsOn,
    format,
    placeholder,
    disabled = false,
    style,
    ...boxProps
  } = props as DatePickerProps & {
    mode?: string;
    value?: unknown;
    defaultValue?: unknown;
    onChange?: (ev: WidgetChangeEvent<unknown>) => void;
  };

  const theme = useTheme();
  const [open, setOpen] = useState(false);
  // `AnchorRect` rather than `Rect`: `useAnchorTracking` reports the side the
  // sheet actually landed on (react-x11#280), and its `setRect` is typed to
  // hand that back. Nothing here reads `placement` — the sheet has no arrow
  // to aim — but the state has to be able to hold it.
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [focused, setFocused] = useState(false);
  const [ownValue, setOwnValue] = useState<unknown>(defaultValue ?? null);
  const triggerRef = useRef<DrawnNode | null>(null);
  const calendarRef = useRef<CalendarHandle | null>(null);

  const measureAnchor = useAnchor(triggerRef);
  const current = value === undefined ? ownValue : value;

  const width = CALENDAR_WIDTH + SHEET_BORDER * 2;
  const height = CALENDAR_HEIGHT + SHEET_BORDER * 2;
  const anchorOptions = (): AnchorOptions => ({
    placement: 'bottom',
    width,
    height,
  });

  const close = (): void => setOpen(false);
  const openCalendar = (): void => {
    const rect = measureAnchor(anchorOptions());
    if (!rect) return;
    setAnchor(rect);
    setOpen(true);
  };
  const toggle = (): void => (open ? close() : openCalendar());

  // the same two the other popups take: keep the sheet under the trigger while
  // anything moves it, and shut it when the window itself loses focus (the
  // trigger keeps its focus, so its own onBlur never hears about that)
  useAnchorTracking(triggerRef, open, anchorOptions, setAnchor, close);
  useDismissOnWindowBlur(triggerRef, open, close);

  const handleChange = (ev: WidgetChangeEvent<unknown>): void => {
    if (value === undefined) setOwnValue(ev.value);
    onChange?.(ev);
    // a half-picked range is the one selection that is not finished, and the
    // calendar has to stay up for the other end of it
    if (mode !== 'range' || (ev.value as DateRange | null)?.end) close();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.keysym === XK_ESCAPE) {
      if (open) close();
      return;
    }
    if (open && calendarRef.current?.handleKey(ev)) return;
    if (
      ev.keysym === XK_DOWN ||
      ev.keysym === XK_UP ||
      ev.keysym === XK_RETURN ||
      ev.codepoint === 32
    ) {
      if (!open) openCalendar();
    }
  };

  const label = format ? format(current) : defaultFormat(mode, current, locale);
  const empty = label == null || label === '';
  const text = empty
    ? (placeholder ?? (mode === 'range' ? 'Pick dates…' : 'Pick a date…'))
    : label;

  return hx(
    'box',
    {
      theme,
      role: 'combobox',
      'aria-expanded': Boolean(open),
      'aria-haspopup': 'dialog',
      disabled: disabled || undefined,
      ref: triggerRef,
      focusable: !disabled,
      onMouseDown: disabled ? undefined : toggle,
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        close();
      },
      onKeyDown: disabled ? undefined : onKeyDown,
      ...boxProps,
      style: [
        s.trigger,
        {
          cursor: disabled ? 'default' : 'pointer',
          borderWidth: theme.borderWidth,
          borderRadius: theme.radius,
          borderColor: focused || open ? theme.borderFocus : theme.border,
          backgroundColor: disabled ? theme.surfaceHover : theme.background,
        },
        // hover and press say "this opens", so they belong to the trigger
        // while it is shut and are simply not declared once the calendar is
        // down — a state block always outranks the base style, so the only
        // way for the open look to win is for nothing to be competing
        !disabled &&
          !open && {
            ':hover': { backgroundColor: theme.surfaceHover },
            ':active': { backgroundColor: theme.surfaceActive },
          },
        style,
      ],
    },
    hx(
      'text',
      {
        style: [s.label, { color: disabled || empty ? theme.dim : theme.text }],
      },
      text,
    ),
    React.createElement(CalendarGlyph, {
      color: disabled ? theme.border : theme.dim,
    }),
    open &&
      anchor &&
      hx(
        'popup',
        {
          theme,
          x: anchor.x,
          y: anchor.y,
          width,
          height,
          grab: true,
          onDismiss: close,
          // ARGB where the display has it, so the corners the sheet gives up
          // are the desktop rather than a colour. The window paints nothing
          // itself when it can be seen through — the box below is the whole
          // of the sheet, and a square fill under it would put the corners
          // straight back.
          transparent: true,
          style: {
            backgroundColor: theme.background,
            '@supports transparency': { backgroundColor: 'transparent' },
          } as SupportsStyle,
        },
        hx(
          'box',
          {
            style: [
              s.sheet,
              {
                borderColor: theme.border,
                backgroundColor: theme.background,
                '@supports transparency': { borderRadius: theme.radiusPopup },
              } as SupportsStyle,
            ],
          },
          React.createElement(Calendar, {
            ref: calendarRef,
            mode,
            value: current,
            onChange: handleChange,
            name,
            month,
            defaultMonth,
            onMonthChange,
            min,
            max,
            isDateBlocked,
            spanBlocked,
            dayContent,
            locale,
            weekStartsOn,
            // The trigger owns the keyboard: the popup is override-redirect
            // and never takes focus, so a focusable grid inside it would take
            // focus on the press instead — blurring the trigger, whose onBlur
            // closes the sheet, unmounting the day under the pointer before
            // the release could turn into a click.
            focusable: false,
            // …and because it does not hold the focus, it would not draw the
            // day cursor either, leaving the arrow keys moving something
            // invisible.
            focusVisible: true,
          } as CalendarProps),
        ),
      ),
  );
}
