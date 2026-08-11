// <Calendar> — a month grid: one date, or a range, with any day blockable.
//
// Ported from react-x11's `src/components/Calendar.js`. Built purely on the
// host primitives, so there is no `registerElement` here and nothing for the
// reconciler to learn — a `<Calendar>` is `<box>`es, `<text>` and, for the
// month nav, two glyphs out of core's system icon set.
import React, { useImperativeHandle, useMemo, useState } from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { createStyles } from 'react-x11/style';
import type { Style } from 'react-x11/style';
import { Icon, useTheme } from 'react-x11';
import type { KeyboardEvent, Theme } from 'react-x11';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';

import { hx } from './hx.js';
import type { Host } from './hx.js';
import { tint, changeEvent } from './internal.js';
import type { WidgetChangeEvent } from './internal.js';
import {
  addDays,
  addMonths,
  clampDay,
  dayParts,
  firstOfMonth,
  formatMonth,
  localeWeekStart,
  monthGrid,
  monthOf,
  toDay,
  toMonth,
  today,
  weekdayLabels,
} from './dates.js';
import type {
  CalendarDay,
  CalendarMonth,
  DayInput,
  DayParts,
} from './dates.js';

// The grid's geometry. A cell is the square the pointer aims at and the band
// runs through; the pill inside it is what gets filled, rounded and hovered,
// which is what leaves the band visible on either side of a selected end.
const CELL_W = 36;
const CELL_H = 32;
const PILL_W = 32;
const PILL_H = 28;
// Reserved under the number when `dayContent` is given — and only then, so a
// plain calendar is not 6×8 pixels taller for a feature it is not using.
const MARKER_H = 8;
const NAV = 26;
// The month-nav glyph inside its 26px button. The chevron this calendar drew
// itself was tall and narrow (7×12) so that it read as an arrow at all; a
// square box at 12 puts the same ink there, because a system chevron's long
// axis is its box and its short one is half of that.
const NAV_CHEVRON = 12;
const PAD = 8;
const GAP = 4;
const WEEKDAY_H = 20;

/**
 * How big a `<Calendar>` lays out — exported because `DatePicker` has to size
 * a real X window around one *before* it is laid out, and a popup that
 * guesses is a popup that clips the last week of the month. Everything the
 * sum reads is a constant above it, so the two cannot drift apart.
 *
 * Eight rows in the column (the header, the weekday names, six weeks), so
 * seven gaps between them.
 */
export const CALENDAR_WIDTH = CELL_W * 7 + PAD * 2;
export const CALENDAR_HEIGHT = PAD * 2 + NAV + WEEKDAY_H + CELL_H * 6 + GAP * 7;

const s = createStyles({
  root: { alignItems: 'flex-start', padding: PAD, gap: GAP },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    width: CELL_W * 7,
    height: NAV,
    flexShrink: 0,
  },
  title: { flexGrow: 1, textAlign: 'center', fontWeight: 'bold' },
  nav: {
    width: NAV,
    height: NAV,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: { backgroundColor: 80 },
  },
  week: { flexDirection: 'row', flexShrink: 0 },
  weekdayCell: {
    width: CELL_W,
    height: WEEKDAY_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekdayLabel: { fontSize: 11 },
  cell: {
    width: CELL_W,
    height: CELL_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  band: { position: 'absolute', top: 2, bottom: 2 },
  pill: {
    width: PILL_W,
    height: PILL_H,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    // the 2px the pill gives up on each side of the cell are still part of
    // its target, so the whole square is clickable and the gap between two
    // days is not a dead strip
    hitSlop: 2,
    transition: { backgroundColor: 80 },
  },
  number: { fontSize: 13 },
  markers: {
    flexDirection: 'row',
    height: MARKER_H,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
});

const TRANSPARENT = 'transparent';

/** A picked span. Either end may be null while it is being picked. */
export interface DateRange {
  start: CalendarDay | null;
  end: CalendarDay | null;
}

/** What a range calendar accepts as its value. */
export interface DateRangeInput {
  start?: DayInput;
  end?: DayInput;
}

/** What a cell is, when `dayContent` is asked what to draw in it. */
export interface CalendarDayState {
  blocked: boolean;
  /** A day of the neighbouring month, filling a corner of the grid. */
  outside: boolean;
  today: boolean;
  selected: boolean;
  inRange: boolean;
  /** Inside a range that is being previewed rather than picked. */
  preview: boolean;
  focused: boolean;
  /** The colour the day's number is drawn in — a marker that follows it
   *  stays legible on the filled ends of a range. */
  color: string;
}

/** A `<Calendar>`'s imperative side, for a control that holds the keyboard on
 *  its behalf. `handleKey` reports whether the grid took the key. */
export interface CalendarHandle {
  handleKey: (ev: KeyboardEvent) => boolean;
}

type BoxProps = Host['box'];

interface CalendarCommonProps extends Omit<
  BoxProps,
  'style' | 'children' | 'ref' | 'onChange' | 'onKeyDown'
> {
  /** Visible month, `'2026-08'`; controlled with `onMonthChange`. */
  month?: CalendarMonth | null;
  defaultMonth?: DayInput | CalendarMonth;
  onMonthChange?: (month: CalendarMonth) => void;
  /** Earliest selectable day. */
  min?: DayInput;
  /** Latest selectable day. */
  max?: DayInput;
  /** Block a day for any other reason — weekends, holidays, taken slots. */
  isDateBlocked?: (day: CalendarDay, parts: DayParts) => boolean;
  /** Let a range run across blocked days, so only its ends must be free. */
  spanBlocked?: boolean;
  /** Rendered under the number, in a strip reserved only when this is given. */
  dayContent?: (day: CalendarDay, state: CalendarDayState) => ReactNode;
  /** The form-field name reported on the change event. */
  name?: string;
  locale?: string;
  /** `0` Sunday … `6` Saturday. Defaults to the locale's own answer. */
  weekStartsOn?: number;
  /** Whether the grid is a tab stop. `false` for a grid inside a popup, whose
   *  trigger holds the keyboard on its behalf. */
  focusable?: boolean;
  /** Draw the day cursor regardless of whether the grid holds the focus. */
  focusVisible?: boolean;
  style?: Style | Style[];
  ref?: Ref<CalendarHandle>;
}

export interface SingleCalendarProps extends CalendarCommonProps {
  mode?: 'single';
  value?: DayInput;
  defaultValue?: DayInput;
  onChange?: (ev: WidgetChangeEvent<CalendarDay | null>) => void;
}

export interface RangeCalendarProps extends CalendarCommonProps {
  mode: 'range';
  value?: DateRangeInput | null;
  defaultValue?: DateRangeInput | null;
  onChange?: (ev: WidgetChangeEvent<DateRange>) => void;
}

export type CalendarProps = SingleCalendarProps | RangeCalendarProps;

/** The selection, with every day normalized — and with the two shapes told
 *  apart loudly, since passing a range to a single-date calendar otherwise
 *  shows up as an empty calendar rather than as the mistake it is. */
function normalizeValue(
  mode: string,
  value: unknown,
): CalendarDay | null | DateRange {
  if (mode === 'range') {
    if (value == null) return { start: null, end: null };
    if (typeof value !== 'object' || value instanceof Date) {
      throw new TypeError(
        "@react-x11/components: a range calendar's value is { start, end }, got " +
          `${JSON.stringify(value)}. Drop mode="range" for a single date.`,
      );
    }
    const range = value as DateRangeInput;
    return { start: toDay(range.start), end: toDay(range.end) };
  }
  if (value != null && typeof value === 'object' && !(value instanceof Date)) {
    throw new TypeError(
      "@react-x11/components: a single-date calendar's value is one day, got " +
        `${JSON.stringify(value)}. Pass mode="range" to select a span.`,
    );
  }
  return toDay(value as DayInput);
}

/**
 * The first blocked day after `start`, up to `last` — where a range that may
 * not contain a blocked day has to stop.
 *
 * Scanned over the days the grid can show rather than per candidate end:
 * nothing off the grid is clickable, and the keyboard's focus is always on it.
 * With no half-picked start there is nothing to scan for.
 */
function firstBlockedAfter(
  start: CalendarDay | null,
  last: CalendarDay,
  blocked: (day: CalendarDay) => boolean,
): CalendarDay | null {
  if (!start) return null;
  for (let d = addDays(start, 1); d <= last; d = addDays(d, 1)) {
    if (blocked(d)) return d;
  }
  return null;
}

/** The day in `month` with the same day-of-month as `day`, or the last one
 *  the month has — so paging from the 31st does not skip February. */
function sameDayIn(month: CalendarMonth, day: CalendarDay): CalendarDay {
  const wanted = Number(day.slice(8));
  const last = Number(addDays(firstOfMonth(addMonths(month, 1)), -1).slice(8));
  return `${month}-${String(Math.min(wanted, last)).padStart(2, '0')}`;
}

/**
 * `direction` is the number of months the button steps, `-1` or `+1` — the
 * argument it already hands `stepMonth`, rather than a second vocabulary
 * beside it. Core's copy of this component took the same shape when the icon
 * set landed, and there a `'left'`/`'right'` string sitting next to a
 * `direction < 0` test had already made every button announce itself as "Next
 * month". One name and one type is what leaves no second comparison to get
 * wrong.
 */
function NavButton({
  direction,
  disabled,
  onPress,
  theme,
}: {
  direction: -1 | 1;
  disabled: boolean;
  onPress: () => void;
  theme: Theme;
}): ReactElement {
  return hx(
    'box',
    {
      role: 'button',
      'aria-label': direction < 0 ? 'Previous month' : 'Next month',
      disabled: disabled || undefined,
      onClick: disabled ? undefined : onPress,
      style: [
        s.nav,
        {
          borderRadius: theme.radius,
          cursor: disabled ? 'default' : 'pointer',
        },
        !disabled && {
          ':hover': { backgroundColor: theme.surfaceHover },
          ':active': { backgroundColor: theme.surfaceActive },
        },
      ],
    },
    React.createElement(Icon, {
      name: direction < 0 ? 'chevronLeft' : 'chevronRight',
      size: NAV_CHEVRON,
      // The button carries the `:hover`, but neither colour nor a state block
      // reaches down to the glyph — disabled is the state that has to be
      // handed over by name.
      color: disabled ? theme.border : theme.dim,
    }),
  );
}

interface BandShape {
  opensRight: boolean;
  opensLeft: boolean;
}

function DayCell({
  day,
  state,
  theme,
  band,
  onPick,
  onHover,
  dayContent,
}: {
  day: CalendarDay;
  /** Everything but `color`, which this cell is the one that resolves. */
  state: Omit<CalendarDayState, 'color'>;
  theme: Theme;
  band: BandShape | null;
  onPick: (day: CalendarDay) => void;
  onHover?: ((day: CalendarDay) => void) | undefined;
  dayContent?:
    ((day: CalendarDay, state: CalendarDayState) => ReactNode) | undefined;
}): ReactElement {
  const { blocked, outside, selected, focused } = state;
  const color = selected
    ? theme.accentText
    : blocked || outside
      ? theme.dim
      : theme.text;
  const markers = dayContent?.(day, { ...state, color });

  return hx(
    'box',
    {
      role: 'gridcell',
      'aria-label': day,
      'aria-selected': selected,
      disabled: blocked || undefined,
      style: s.cell,
    },
    // Behind the pill and out of flow, so an end of the range keeps its own
    // fill while the band still runs out of it towards the next day. Half a
    // cell at each end is what joins one pill to the next without drawing
    // over either.
    band &&
      hx('box', {
        style: [
          s.band,
          {
            left: band.opensRight ? CELL_W / 2 : 0,
            right: band.opensLeft ? CELL_W / 2 : 0,
            backgroundColor: tint(theme.accent, 0.18),
          },
        ],
      }),
    hx(
      'box',
      {
        onClick: blocked ? undefined : () => onPick(day),
        onMouseEnter: onHover ? () => onHover(day) : undefined,
        style: [
          s.pill,
          {
            cursor: blocked ? 'default' : 'pointer',
            borderRadius: theme.radius,
            backgroundColor: selected ? theme.accent : TRANSPARENT,
            // today keeps its outline whatever else is going on, and every
            // other cell carries the same border in nothing — a border that
            // appears would inset the number by a pixel as the day turns
            borderColor: focused
              ? theme.borderFocus
              : state.today
                ? theme.accent
                : TRANSPARENT,
          },
          !blocked && {
            ':hover': {
              backgroundColor: selected
                ? theme.accentHover
                : theme.surfaceHover,
            },
            ':active': {
              backgroundColor: selected
                ? theme.accentActive
                : theme.surfaceActive,
            },
          },
        ],
      },
      hx(
        'text',
        { style: [s.number, { color }] },
        String(Number(day.slice(8))),
      ),
      markers ? hx('box', { style: s.markers }, markers) : null,
    ),
  );
}

/**
 * <Calendar value onChange …/> — a month grid: one date, or a range, with any
 * day blockable.
 *
 *   <Calendar value={day} onChange={(ev) => setDay(ev.value)} />
 *   <Calendar mode="range" value={{ start, end }} onChange={…} />
 *
 * **A day is a `'YYYY-MM-DD'` string** in and out (a `Date` is accepted on the
 * way in and read as its local calendar day). See `dates.ts` for why: a square
 * on a wall calendar is not an instant, and comparing two of them should not
 * depend on which constructor built them.
 *
 * Blocking is `min`/`max` for the usual bounds and `isDateBlocked(day, parts)`
 * for everything else — weekends, holidays, whatever the server said is taken.
 * `parts` is `{ year, month, day, weekday, date }` so the common cases do not
 * have to parse the string back apart.
 *
 * In `range` mode the first click sets the start and reports
 * `{ start, end: null }`, the second completes it. Clicking before the start
 * re-anchors rather than selecting backwards. **A range may not contain a
 * blocked day**: the preview stops at the first one, because an app that
 * blocked a date did not mean "unless it is in the middle", and a selection
 * that quietly included it would have to be validated all over again on the
 * way out. `spanBlocked` is the other reading — only the ends must be free —
 * for holidays a booking is allowed to run across.
 *
 * `dayContent(day, state)` renders under the number, in a strip the grid
 * reserves only when the prop is there. It is the seam for anything drawn per
 * day — an event dot, a price, an availability count — and `state` carries
 * `{ selected, inRange, blocked, outside, today, focused, color }` so a marker
 * can stay legible on the filled ends of the range. `../desktop-calendar/` is
 * the worked example: real events from the user's desktop, as dots.
 *
 * The grid is a **single tab stop**. Arrows move a day at a time and a week at
 * a time, Home/End go to the ends of the week, PageUp/PageDown change month
 * (with Shift, year), Enter and Space select. Moving off the edge of the month
 * turns the page.
 *
 * A calendar inside a popup does not hold the keyboard — the trigger does, on
 * its behalf, because an override-redirect window never takes focus. That is
 * what `focusable: false` plus `focusVisible: true` say together: someone else
 * is feeding this grid its keys through the `handleKey` on its ref, and the
 * day cursor still has to be drawn or the arrows move something invisible.
 */
export function Calendar(props: CalendarProps): ReactElement {
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
    spanBlocked = false,
    dayContent,
    locale,
    weekStartsOn,
    focusable = true,
    focusVisible,
    ref,
    style,
    ...boxProps
  } = props as CalendarProps & {
    mode?: string;
    value?: unknown;
    defaultValue?: unknown;
    onChange?: (ev: WidgetChangeEvent<never>) => void;
  };

  const isRange = mode === 'range';
  const theme = useTheme();
  const minDay = toDay(min);
  const maxDay = toDay(max);
  const todayKey = today();

  const [ownValue, setOwnValue] = useState(() =>
    normalizeValue(mode, defaultValue ?? null),
  );
  const selection =
    value === undefined ? ownValue : normalizeValue(mode, value);
  const range = isRange ? (selection as DateRange) : null;
  const single = isRange ? null : (selection as CalendarDay | null);
  const anchor = isRange ? (range as DateRange).start : single;

  const [ownMonth, setOwnMonth] = useState<CalendarMonth>(
    () =>
      toMonth(defaultMonth as DayInput) ??
      monthOf(anchor ?? clampDay(todayKey, minDay, maxDay)),
  );
  const visibleMonth =
    month == null ? ownMonth : (toMonth(month) as CalendarMonth);

  const [focusedDay, setFocusedDay] = useState<CalendarDay>(() =>
    clampDay(anchor ?? todayKey, minDay, maxDay),
  );
  const [focused, setFocused] = useState(false);
  // Only ever set while a range is half-picked, which is the only time the
  // grid repaints on pointer movement: with nothing pending the highlight is
  // a `:hover` block on one cell and React hears nothing about it.
  const [hovered, setHovered] = useState<CalendarDay | null>(null);

  const weekStart = weekStartsOn ?? localeWeekStart(locale);
  const weeks = useMemo(
    () => monthGrid(visibleMonth, weekStart),
    [visibleMonth, weekStart],
  );
  const weekdays = useMemo(
    () => weekdayLabels(locale, weekStart),
    [locale, weekStart],
  );

  const isBlocked = (day: CalendarDay): boolean => {
    if (minDay && day < minDay) return true;
    if (maxDay && day > maxDay) return true;
    return isDateBlocked ? Boolean(isDateBlocked(day, dayParts(day))) : false;
  };

  const pending = isRange && Boolean(range?.start && !range.end);

  // The first blocked day after a half-picked start, which is where the range
  // has to stop. Scanned once per render over the days the grid can actually
  // show, rather than per candidate end: nothing outside the grid is clickable
  // and the keyboard's focus is always on it.
  const wall = firstBlockedAfter(
    pending && !spanBlocked ? (range as DateRange).start : null,
    weeks[5][6],
    isBlocked,
  );

  const canEndAt = (day: CalendarDay): boolean =>
    pending &&
    day >= (range as DateRange).start! &&
    !isBlocked(day) &&
    (!wall || day < wall);

  const preview = pending && hovered && canEndAt(hovered) ? hovered : null;
  const bandStart = isRange ? (range as DateRange).start : null;
  const bandEnd = isRange ? ((range as DateRange).end ?? preview) : null;

  const setMonth = (next: CalendarMonth): void => {
    if (month == null) setOwnMonth(next);
    onMonthChange?.(next);
  };

  const commit = (next: CalendarDay | null | DateRange): void => {
    if (value === undefined) setOwnValue(next);
    onChange?.(
      changeEvent(isRange ? 'date-range' : 'date', name, next) as never,
    );
  };

  const show = (day: CalendarDay): void => {
    setFocusedDay(day);
    if (monthOf(day) !== visibleMonth) setMonth(monthOf(day));
  };

  const pick = (day: CalendarDay): void => {
    if (isBlocked(day)) return;
    if (isRange) {
      const start = (range as DateRange).start;
      if (!pending || (start && day < start)) commit({ start: day, end: null });
      else if (canEndAt(day)) commit({ start, end: day });
      else return;
    } else {
      commit(day);
    }
    show(day);
  };

  const moveFocus = (delta: number): void =>
    show(clampDay(addDays(focusedDay, delta), minDay, maxDay));

  const stepMonth = (delta: number): void => {
    const next = addMonths(visibleMonth, delta);
    setMonth(next);
    setFocusedDay(clampDay(sameDayIn(next, focusedDay), minDay, maxDay));
  };

  /** Returns whether the key was the calendar's — a picker wrapping this one
   *  still owns Escape and Tab, and has no other way to tell. */
  const handleKey = (ev: KeyboardEvent): boolean => {
    switch (ev.keysym) {
      case XK_LEFT:
        moveFocus(-1);
        return true;
      case XK_RIGHT:
        moveFocus(1);
        return true;
      case XK_UP:
        moveFocus(-7);
        return true;
      case XK_DOWN:
        moveFocus(7);
        return true;
      case XK_HOME:
        moveFocus(-((dayParts(focusedDay).weekday - weekStart + 7) % 7));
        return true;
      case XK_END:
        moveFocus(6 - ((dayParts(focusedDay).weekday - weekStart + 7) % 7));
        return true;
      case XK_PAGE_UP:
        stepMonth(ev.shiftKey ? -12 : -1);
        return true;
      case XK_PAGE_DOWN:
        stepMonth(ev.shiftKey ? 12 : 1);
        return true;
      case XK_RETURN:
        pick(focusedDay);
        return true;
      default:
        break;
    }
    if (ev.codepoint === 32) {
      pick(focusedDay);
      return true;
    }
    return false;
  };

  useImperativeHandle(ref, () => ({ handleKey }));

  const canGoBack = !minDay || firstOfMonth(visibleMonth) > minDay;
  const canGoOn = !maxDay || firstOfMonth(addMonths(visibleMonth, 1)) <= maxDay;

  return hx(
    'box',
    {
      theme,
      role: 'grid',
      focusable,
      onKeyDown: handleKey,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      // the preview belongs to the pointer, and the pointer has left
      onMouseLeave: pending ? () => setHovered(null) : undefined,
      ...boxProps,
      style: [s.root, style],
    },
    hx(
      'box',
      { style: s.header },
      React.createElement(NavButton, {
        direction: -1,
        disabled: !canGoBack,
        theme,
        onPress: () => stepMonth(-1),
      }),
      hx(
        'text',
        { style: [s.title, { color: theme.text, fontSize: theme.fontSize }] },
        formatMonth(visibleMonth, locale),
      ),
      React.createElement(NavButton, {
        direction: 1,
        disabled: !canGoOn,
        theme,
        onPress: () => stepMonth(1),
      }),
    ),
    hx(
      'box',
      { style: s.week },
      weekdays.map((label, i) =>
        hx(
          'box',
          { key: i, style: s.weekdayCell },
          hx('text', { style: [s.weekdayLabel, { color: theme.dim }] }, label),
        ),
      ),
    ),
    weeks.map((days, w) =>
      hx(
        'box',
        { key: w, style: s.week },
        days.map((day) => {
          const inBand =
            bandStart != null &&
            bandEnd != null &&
            bandStart !== bandEnd &&
            day >= bandStart &&
            day <= bandEnd;
          return React.createElement(DayCell, {
            key: day,
            day,
            theme,
            dayContent,
            onPick: pick,
            onHover: pending ? setHovered : undefined,
            band: inBand
              ? { opensRight: day === bandStart, opensLeft: day === bandEnd }
              : null,
            state: {
              blocked: isBlocked(day),
              outside: monthOf(day) !== visibleMonth,
              today: day === todayKey,
              selected: isRange
                ? day === bandStart || day === bandEnd
                : day === single,
              inRange: inBand,
              preview: inBand && (range as DateRange).end == null,
              focused: (focusVisible ?? focused) && day === focusedDay,
            },
          });
        }),
      ),
    ),
  );
}
