// The widget a date, a time, a month, a week or a `datetime-local` input is
// mounted as: a row of segments typed into as a browser's are, and the
// picker it drops (HTML 4.10.5.1.7 to .11, and 4.10.5.4's `showPicker()`).
//
// The segments are `date-fields.ts`'s. The picker is the grid an app's
// `<Calendar>` is (`../internal/calendar/`): a day for a date, a week drawn
// as the span from its Monday for a week, the same grid beside a column of
// hours and minutes for a `datetime-local`, the columns alone for a time,
// and the twelve months of a year for a month. Like `<DatePicker>`'s, it is
// a `<popup>` that never takes the focus: the field keeps the keyboard and
// hands the grid its keys.
//
// What the field holds is the form's (`FormState`), never this widget's:
// a script's `value`, a reset and a submission read and write it there,
// and a part of a value — a month typed and no day — is the widget's alone,
// since the value the page reads is empty until every segment says
// something. A script that sets the value asks the widget to show it
// through `redraws`, as it asks a range.
import React from 'react';
import type { ReactElement, Ref } from 'react';
import { Icon, useAnchor, useAnchorTracking, useTheme } from 'react-x11';
import type {
  AnchorOptions,
  AnchorRect,
  DrawnNode,
  KeyboardEvent,
  ScrollableNode,
  Theme,
} from 'react-x11';
import { createStyles } from 'react-x11/style';
import type { Style, StyleProperties } from 'react-x11/style';
import {
  XK_BACKSPACE,
  XK_DELETE,
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_F4,
  XK_HOME,
  XK_KP_ENTER,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_TAB,
  XK_UP,
} from 'react-x11/keysyms';

import {
  CALENDAR_HEIGHT,
  CALENDAR_WIDTH,
  Calendar,
} from '../internal/calendar/Calendar.js';
import type {
  CalendarHandle,
  CalendarProps,
  DateRange,
} from '../internal/calendar/Calendar.js';
import { CalendarGlyph } from '../internal/calendar/glyph.js';
import { useDismissOnWindowBlur } from '../internal/widget.js';
import {
  addDaysTo,
  fieldLayout,
  fieldText,
  mondayOfWeek,
  precisionOf,
  segmentRange,
  segmentText,
  segmentsOf,
  stepSegment,
  typeDigit,
  typeLetter,
  valueOf,
  weekOfDay,
} from './date-fields.js';
import type {
  DateFieldType,
  FieldLayout,
  SegmentName,
  SegmentValues,
} from './date-fields.js';
import { attr } from './dom.js';
import type { Element } from './dom.js';
import type { FormState } from './form.js';
import { hx } from './hx.js';

// A hairline round the sheet, as `<DatePicker>`'s and the menus': where the
// popup meets the desktop, not a control's outline.
const SHEET_BORDER = 1;
// the time columns: an item a line of the palette's text, and as many in
// view as make a time picker of its own about as tall as its calendar
const COLUMN_W = 48;
const ITEM_H = 28;
const PAD = 8;
const TIME_ITEMS = 7;
const TIME_HEIGHT = PAD * 2 + ITEM_H * TIME_ITEMS;
// the month grid: three months across, four down, under a year's header
const MONTH_COLUMNS = 3;
const MONTH_ROW_H = 40;
const NAV = 26;
const MONTH_HEIGHT = PAD * 2 + NAV + 4 * (MONTH_ROW_H + 4);

/** The `'@supports transparency'` block `<DatePicker>`'s sheet has, which
 *  react-x11's `Style` does not model (see `src/calendar/DatePicker.ts`). */
type SupportsStyle = Style & { '@supports transparency'?: StyleProperties };

const s = createStyles({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  segments: {
    flexDirection: 'row',
    alignItems: 'center',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  segment: { borderRadius: 2 },
  text: { textWrap: 'nowrap' },
  indicator: {
    marginLeft: 4,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheet: {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'row',
    borderWidth: SHEET_BORDER,
  },
  columns: { flexDirection: 'row', padding: PAD, gap: 2 },
  column: { width: COLUMN_W, overflow: 'scroll', flexShrink: 0 },
  item: {
    height: ITEM_H,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  months: { padding: PAD, gap: 4, alignItems: 'flex-start' },
  monthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    height: NAV,
    width: CALENDAR_WIDTH - PAD * 2,
  },
  monthTitle: { flexGrow: 1, textAlign: 'center', fontWeight: 'bold' },
  nav: {
    width: NAV,
    height: NAV,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  monthRow: { flexDirection: 'row', height: MONTH_ROW_H, flexShrink: 0 },
  monthCell: {
    width: (CALENDAR_WIDTH - PAD * 2) / MONTH_COLUMNS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthPill: {
    width: (CALENDAR_WIDTH - PAD * 2) / MONTH_COLUMNS - 6,
    height: MONTH_ROW_H - 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    hitSlop: 3,
  },
});

/** What each segment is called to an assistive technology, as Chrome
 *  names its own. */
const SEGMENT_NAMES: Record<SegmentName, string> = {
  year: 'Year',
  month: 'Month',
  day: 'Day',
  week: 'Week',
  hour: 'Hours',
  minute: 'Minutes',
  second: 'Seconds',
  millisecond: 'Milliseconds',
  period: 'AM/PM',
};

export interface DateFieldProps {
  element: Element;
  type: DateFieldType;
  forms: FormState;
  disabled: boolean;
  readOnly: boolean;
  /** `{ tabIndex: -1 }` where the element is out of the Tab order. */
  order?: { tabIndex: -1 };
  /** The field's frame and text: the palette's field, or none of its own
   *  where the document draws the box (`bareField`). */
  style: Style | Style[];
  /** The colour the indicator is drawn in: the page's text where the page
   *  drew the box, else the palette's muted ink. */
  ink?: string;
  /** Whether the document draws the field's box, and so its focus. */
  bare: boolean;
  /** The size of the field's text, logical pixels: the indicator's. */
  fontSize: number;
  /** Whether the picker is down: the document's, so `showPicker()` drops
   *  it and `:open` follows it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The user made the field hold another value, or none: the form holds
   *  it from here, and the page hears its `input` and `change`. */
  picked: (value: string) => void;
  focused: (on: boolean) => void;
  /** Enter: the form's implicit submission. */
  submit: () => void;
  /** Where a script's value or a reset asks the widget to show what the
   *  form holds. */
  redraws: Map<Element, () => void>;
}

/** What the widget holds between renders: the segments, which one takes
 *  the keys, and what was typed into it since. */
interface Edit {
  values: SegmentValues;
  /** The value the segments were read from, or came to. */
  seen: string;
  active: number;
  typed: string;
}

/** A picker sheet's imperative side, as a `<Calendar>`'s: whether it took
 *  a key the field handed it. */
interface SheetHandle {
  handleKey: (ev: KeyboardEvent) => boolean;
}

/**
 * <DateField> — a date or a time input, as Chrome draws one.
 *
 * Its segments run in the locale's order, each typed into with digits (a
 * period and a month's name with their letters too), stepped with Up and
 * Down, cleared with Backspace or Delete, and left with Left, Right, Tab,
 * or a separator. A segment takes the next once no digit more could make a
 * value it holds, as Chrome's does. Alt+Down and F4 drop the picker, as in
 * Chrome; a press on the indicator does too, and Escape takes it up.
 */
export function DateField(props: DateFieldProps): ReactElement {
  const {
    element: el,
    type,
    forms,
    disabled,
    readOnly,
    order,
    style,
    ink,
    bare,
    fontSize,
    open,
    onOpenChange,
    picked,
    focused,
    submit,
    redraws,
  } = props;
  const theme = useTheme();
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    redraws.set(el, redraw);
    return () => {
      redraws.delete(el);
    };
  }, [redraws, el]);

  const value = forms.value(el);
  const step = attr(el, 'step');
  const edit = React.useRef<Edit | null>(null);
  let precision = precisionOf(step, value);
  // a value the form holds that the segments did not come to is a
  // script's, or a reset's: the segments show it from here
  if (!edit.current || edit.current.seen !== value) {
    edit.current = {
      values: segmentsOf(
        fieldLayout(type, undefined, precision.seconds, precision.millis),
        value,
      ),
      seen: value,
      active: edit.current?.active ?? 0,
      typed: '',
    };
  }
  const e = edit.current;
  // seconds typed stay shown while the rest of the value is cleared
  precision = {
    seconds:
      precision.seconds ||
      e.values.second !== undefined ||
      e.values.millisecond !== undefined,
    millis: precision.millis || e.values.millisecond !== undefined,
  };
  const layout = fieldLayout(
    type,
    undefined,
    precision.seconds,
    precision.millis,
  );
  const last = layout.segments.length - 1;
  e.active = Math.min(e.active, last);

  const [hasFocus, setHasFocus] = React.useState(false);
  // A press on a segment, or on the indicator, says so to the field's own
  // handler, which hears it after them: what it takes is theirs. The press
  // goes on to the document's root as any does.
  const pressedPart = React.useRef(false);
  const editable = !disabled && !readOnly;

  /** The segments are these from here: the form holds what they come to,
   *  where it is another value than it held. */
  const commit = (values: SegmentValues) => {
    e.values = values;
    const next = valueOf(layout, values);
    if (next !== e.seen) {
      e.seen = next;
      picked(next);
    }
    redraw();
  };
  const moveTo = (index: number) => {
    e.active = Math.max(0, Math.min(last, index));
    e.typed = '';
    redraw();
  };
  const thisYear = new Date().getFullYear();

  // --- the picker ----------------------------------------------------------

  const triggerRef = React.useRef<DrawnNode | null>(null);
  const sheetRef = React.useRef<SheetHandle | null>(null);
  const measure = useAnchor(triggerRef);
  const [anchor, setAnchor] = React.useState<AnchorRect | null>(null);
  const size = sheetSize(type, layout);
  const anchorOptions = (): AnchorOptions => ({
    placement: 'bottom',
    width: size.width,
    height: size.height,
  });
  const close = () => onOpenChange(false);
  // Dropped by a press, a key or a script's `showPicker()`, which may come
  // before the field is laid out: measured where the field is once it is,
  // and kept under it from there by the tracking.
  React.useLayoutEffect(() => {
    if (!open) {
      if (anchor) setAnchor(null);
      return;
    }
    if (anchor) return;
    const rect = measure(anchorOptions());
    if (rect) setAnchor(rect);
  });
  useAnchorTracking(triggerRef, open, anchorOptions, setAnchor, close);
  useDismissOnWindowBlur(triggerRef, open, close);

  const toggle = () => {
    if (!editable) return;
    onOpenChange(!open);
  };

  // --- keys ----------------------------------------------------------------

  const onKeyDown = (ev: KeyboardEvent) => {
    // a key the page cancelled does nothing here, as in a browser
    if (ev.defaultPrevented || disabled) return;
    const handled = () => {
      ev.preventDefault();
      ev.stopPropagation?.();
    };
    const key = ev.keysym;
    if ((key === XK_DOWN && ev.altKey) || key === XK_F4) {
      toggle();
      handled();
      return;
    }
    if (open) {
      if (key === XK_ESCAPE) {
        close();
        handled();
        return;
      }
      if (sheetRef.current?.handleKey(ev)) {
        handled();
        return;
      }
      // a time's columns take no keys: the segments do, and the columns
      // follow them, and Enter takes the picker up as a choice made
      if (key === XK_RETURN || key === XK_KP_ENTER) {
        close();
        handled();
        return;
      }
    }
    if (key === XK_RETURN || key === XK_KP_ENTER) {
      submit();
      return;
    }
    if (ev.ctrlKey || ev.metaKey) return;
    if (key === XK_TAB && !ev.altKey) {
      // through the segments, and on out of the field past either end
      const to = e.active + (ev.shiftKey ? -1 : 1);
      if (to < 0 || to > last) {
        e.active = ev.shiftKey ? last : 0;
        e.typed = '';
        return;
      }
      moveTo(to);
      handled();
      return;
    }
    if (ev.altKey) return;
    const name = layout.segments[e.active];
    switch (key) {
      case XK_LEFT:
        moveTo(e.active - 1);
        handled();
        return;
      case XK_RIGHT:
        moveTo(e.active + 1);
        handled();
        return;
      case XK_HOME:
      case XK_END:
        moveTo(key === XK_HOME ? 0 : last);
        handled();
        return;
      case XK_UP:
      case XK_DOWN:
      case XK_PAGE_UP:
      case XK_PAGE_DOWN: {
        handled();
        if (!editable) return;
        const up = key === XK_UP || key === XK_PAGE_UP;
        const page = key === XK_PAGE_UP || key === XK_PAGE_DOWN;
        const by = (up ? 1 : -1) * (page ? pageStep(name) : 1);
        e.typed = '';
        commit(stepSegment(layout, e.values, name, by, thisYear));
        return;
      }
      case XK_BACKSPACE:
      case XK_DELETE: {
        handled();
        if (!editable) return;
        e.typed = '';
        const values = { ...e.values };
        delete values[name];
        commit(values);
        return;
      }
      default:
        break;
    }
    const char = ev.codepoint ? String.fromCodePoint(ev.codepoint) : '';
    if (!char) return;
    if (/^\d$/.test(char) && name !== 'period') {
      handled();
      if (!editable) return;
      const typed = typeDigit(layout, e.values, name, e.typed, char);
      e.typed = typed.typed;
      if (typed.advance && e.active < last) e.active++;
      commit(typed.values);
      return;
    }
    // a separator the field shows takes the next segment, as Chrome's
    if (/^[/.:,\-\s]$/.test(char) && char !== ' ') {
      handled();
      if (e.typed || e.values[name] !== undefined) moveTo(e.active + 1);
      return;
    }
    const letter = typeLetter(layout, e.values, name, e.typed, char);
    if (letter) {
      handled();
      if (!editable) return;
      e.typed = letter.typed;
      if (letter.advance && e.active < last) e.active++;
      commit(letter.values);
    }
  };

  // --- what the sheets set ---------------------------------------------------

  /** Days set from a day the calendar picked, whatever time is beside it. */
  const pickDay = (day: string | null) => {
    if (!day) return;
    const [year, month, date] = day.split('-').map(Number);
    commit({ ...e.values, year, month, day: date });
    if (type === 'date') close();
  };
  const pickWeek = (range: DateRange) => {
    const day = range.start;
    if (!day) return;
    const { year, week } = weekOfDay(day);
    commit({ ...e.values, year, week });
    close();
  };
  const pickMonth = (year: number, month: number) => {
    commit({ ...e.values, year, month });
    close();
  };
  const pickTime = (name: SegmentName, n: number) => {
    const values = { ...e.values, [name]: n };
    // a time picked has its minutes, as Chrome's list starts them
    if (name === 'hour' && values.minute === undefined) values.minute = 0;
    if (
      (name === 'hour' || name === 'minute') &&
      layout.hour12 &&
      values.period === undefined
    ) {
      values.period = 0;
    }
    for (const extra of ['second', 'millisecond'] as const) {
      if (layout.segments.includes(extra) && values[extra] === undefined) {
        values[extra] = 0;
      }
    }
    commit(values);
  };

  // --- the field -------------------------------------------------------------

  const active = hasFocus && !disabled ? e.active : -1;
  let index = -1;
  const segments = layout.parts.map((part, i) => {
    if ('text' in part) {
      // a `<text>` trims the white space at its ends, which is all of
      // ", " and " " between two segments
      const shown = part.text.replace(/\s/g, '\u00a0');
      return hx('text', { key: `t${i}`, style: s.text }, shown);
    }
    const at = ++index;
    const name = part.segment;
    const lit = at === active;
    const shown = segmentText(name, e.values, layout);
    return hx(
      'box',
      {
        key: `s${i}`,
        role: 'spinbutton',
        'aria-label': SEGMENT_NAMES[name],
        'aria-valuetext': e.values[name] === undefined ? 'blank' : shown,
        ...(e.values[name] !== undefined && {
          'aria-valuenow': e.values[name],
          'aria-valuemin': segmentRange(name, layout)[0],
          'aria-valuemax': segmentRange(name, layout)[1],
        }),
        onMouseDown: () => {
          pressedPart.current = true;
          if (disabled) return;
          e.active = at;
          e.typed = '';
          redraw();
        },
        style: [s.segment, lit && { backgroundColor: theme.accent }],
      },
      hx(
        'text',
        { style: [s.text, lit && { color: theme.accentText }] },
        shown,
      ),
    );
  });

  const glyph = Math.max(10, Math.min(18, Math.round(fontSize)));
  const glyphInk = disabled ? theme.border : (ink ?? theme.textMuted);
  const indicator = readOnly
    ? null
    : hx(
        'box',
        {
          key: 'indicator',
          role: 'button',
          'aria-label':
            type === 'time' ? 'Show time picker' : 'Show local date picker',
          // the field takes the focus, and the picker drops or goes
          onMouseDown: () => {
            pressedPart.current = true;
            if (disabled) return;
            toggle();
          },
          style: [s.indicator, { cursor: disabled ? 'default' : 'pointer' }],
        },
        type === 'time'
          ? React.createElement(ClockGlyph, { size: glyph, color: glyphInk })
          : React.createElement(CalendarGlyph, {
              size: glyph,
              color: glyphInk,
            }),
      );

  return hx(
    'box',
    {
      ref: triggerRef,
      role: 'group',
      'aria-label': fieldText(layout, e.values),
      'aria-haspopup': type === 'time' ? 'listbox' : 'dialog',
      'aria-expanded': open,
      'aria-readonly': readOnly || undefined,
      disabled: disabled || undefined,
      focusable: !disabled,
      selectable: false,
      ...order,
      onFocus: () => {
        setHasFocus(true);
        focused(true);
      },
      onBlur: () => {
        setHasFocus(false);
        e.typed = '';
        close();
        focused(false);
      },
      onKeyDown,
      onMouseDown: () => {
        const part = pressedPart.current;
        pressedPart.current = false;
        // a press past the segments that focuses the field takes the first
        // that holds nothing, or the last
        if (part || disabled || hasFocus) return;
        const empty = layout.segments.findIndex(
          (n) => e.values[n] === undefined,
        );
        e.active = empty < 0 ? last : empty;
        e.typed = '';
      },
      style: [
        style,
        s.field,
        !bare && hasFocus && { borderColor: theme.borderFocus },
        disabled && !bare && { color: theme.textMuted },
      ],
    },
    hx('box', { key: 'segments', style: s.segments }, segments),
    indicator,
    open &&
      anchor &&
      renderSheet({
        type,
        layout,
        values: e.values,
        element: el,
        theme,
        anchor,
        size,
        sheetRef,
        close,
        pickDay,
        pickWeek,
        pickMonth,
        pickTime,
      }),
  );
}

/** How far PageUp and PageDown step a segment: a decade of years, a
 *  quarter of an hour, as many as a page of a list would. */
function pageStep(name: SegmentName): number {
  switch (name) {
    case 'year':
      return 10;
    case 'month':
      return 3;
    case 'day':
    case 'week':
      return 7;
    case 'minute':
    case 'second':
      return 15;
    case 'hour':
      return 3;
    default:
      return 1;
  }
}

/** The sheet's size, as the popup has to be made before it is laid out. */
function sheetSize(
  type: DateFieldType,
  layout: FieldLayout,
): { width: number; height: number } {
  const columns = timeColumns(layout).length;
  const time = PAD * 2 + columns * COLUMN_W + Math.max(0, columns - 1) * 2;
  const [width, height] =
    type === 'time'
      ? [time, TIME_HEIGHT]
      : type === 'datetime-local'
        ? [CALENDAR_WIDTH + 1 + time, CALENDAR_HEIGHT]
        : type === 'month'
          ? [CALENDAR_WIDTH, MONTH_HEIGHT]
          : [CALENDAR_WIDTH, CALENDAR_HEIGHT];
  return { width: width + SHEET_BORDER * 2, height: height + SHEET_BORDER * 2 };
}

/** The segments a time's columns pick. */
function timeColumns(layout: FieldLayout): SegmentName[] {
  return layout.segments.filter(
    (n) => n === 'hour' || n === 'minute' || n === 'second' || n === 'period',
  );
}

interface SheetArgs {
  type: DateFieldType;
  layout: FieldLayout;
  values: SegmentValues;
  element: Element;
  theme: Theme;
  anchor: AnchorRect;
  size: { width: number; height: number };
  sheetRef: React.RefObject<SheetHandle | null>;
  close: () => void;
  pickDay: (day: string | null) => void;
  pickWeek: (range: DateRange) => void;
  pickMonth: (year: number, month: number) => void;
  pickTime: (name: SegmentName, n: number) => void;
}

/** The popup the picker is, over the field. */
function renderSheet(args: SheetArgs): ReactElement {
  const { type, layout, values, element: el, theme, anchor, size } = args;
  const limits = limitsOf(el, type);
  let content: React.ReactNode;
  const calendar = (week: boolean) => {
    const day = dayOf(values);
    const monday =
      week && values.year !== undefined && values.week !== undefined
        ? safeDay(mondayOfWeek(values.year, values.week))
        : null;
    return React.createElement(Calendar, {
      key: 'calendar',
      ref: args.sheetRef as Ref<CalendarHandle>,
      ...(week
        ? {
            mode: 'range',
            value: monday
              ? { start: monday, end: addDaysTo(monday, 6) }
              : { start: null, end: null },
            onChange: (ev: { value: DateRange }) => args.pickWeek(ev.value),
            // ISO 8601's weeks, which a week input's are, start on Monday
            weekStartsOn: 1,
          }
        : {
            value: day,
            onChange: (ev: { value: string | null }) => args.pickDay(ev.value),
          }),
      min: limits.min,
      max: limits.max,
      // The field owns the keyboard: the popup is override-redirect and
      // never takes the focus, so a grid that took it on a press would blur
      // the field, whose blur takes the picker up under the pointer.
      focusable: false,
      focusVisible: true,
    } as CalendarProps);
  };
  switch (type) {
    case 'date':
      content = calendar(false);
      break;
    case 'week':
      content = calendar(true);
      break;
    case 'month':
      content = React.createElement(MonthSheet, {
        key: 'months',
        ref: args.sheetRef,
        values,
        layout,
        theme,
        min: limits.minMonth,
        max: limits.maxMonth,
        pick: args.pickMonth,
      });
      break;
    case 'time':
      content = React.createElement(TimeSheet, {
        key: 'time',
        values,
        layout,
        theme,
        height: TIME_HEIGHT,
        minuteStep: minuteStep(el),
        pick: args.pickTime,
      });
      break;
    case 'datetime-local':
      content = [
        calendar(false),
        hx('box', {
          key: 'rule',
          style: { width: 1, backgroundColor: theme.border },
        }),
        React.createElement(TimeSheet, {
          key: 'time',
          values,
          layout,
          theme,
          height: CALENDAR_HEIGHT,
          minuteStep: minuteStep(el),
          pick: args.pickTime,
        }),
      ];
      break;
  }
  return hx(
    'popup',
    {
      key: 'picker',
      theme,
      x: anchor.x,
      y: anchor.y,
      width: size.width,
      height: size.height,
      grab: true,
      onDismiss: args.close,
      // the corners its radius gives up are the desktop's, where the
      // display can show it, as `<DatePicker>`'s
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
      content,
    ),
  );
}

/** The day the segments say, where they say a whole one the calendar can
 *  show. */
function dayOf(values: SegmentValues): string | null {
  const { year, month, day } = values;
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  return safeDay(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
}

/**
 * A day the calendar takes, or null: its days are four-digit years from 100,
 * since `Date.UTC` reads a year under it as the twentieth century's, and it
 * refuses a day no month has. HTML's run from year 1 to 275760, and a field
 * holding one outside that shows the calendar on today.
 */
function safeDay(day: string | null | undefined): string | null {
  if (!day) return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(day);
  if (!m || Number(m[1]) < 100) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCDate() === Number(m[3]) &&
    date.getUTCMonth() === Number(m[2]) - 1
    ? day
    : null;
}

/** The days, and the months, a field's `min` and `max` hold it to, in the
 *  calendar's terms. */
function limitsOf(
  el: Element,
  type: DateFieldType,
): {
  min: string | undefined;
  max: string | undefined;
  minMonth: number | undefined;
  maxMonth: number | undefined;
} {
  const read = (name: 'min' | 'max') => {
    const text = attr(el, name)?.trim() ?? '';
    if (type === 'week') {
      const m = /^(\d{4})-W(\d\d)$/.exec(text);
      if (!m) return undefined;
      const monday = safeDay(mondayOfWeek(Number(m[1]), Number(m[2])));
      if (!monday) return undefined;
      return (
        (name === 'min' ? monday : safeDay(addDaysTo(monday, 6))) ?? undefined
      );
    }
    // a month's limit is its first day, which says which month it is
    if (type === 'month') {
      const m = /^(\d{4})-(\d\d)$/.exec(text);
      return (m ? safeDay(`${m[1]}-${m[2]}-01`) : null) ?? undefined;
    }
    return safeDay(text.slice(0, 10)) ?? undefined;
  };
  const min = read('min');
  const max = read('max');
  const monthOf = (day: string | undefined) =>
    day
      ? Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1
      : undefined;
  return { min, max, minMonth: monthOf(min), maxMonth: monthOf(max) };
}

/** How far apart the minutes the time columns list are: the field's step,
 *  where it is a whole number of minutes that goes into an hour, as
 *  Chrome's list steps them. */
function minuteStep(el: Element): number {
  const written = attr(el, 'step')?.trim();
  const n = written && /^\d+$/.test(written) ? Number(written) : 60;
  if (n < 60 || n % 60 !== 0) return 1;
  const minutes = n / 60;
  return minutes <= 60 && 60 % minutes === 0 ? minutes : 1;
}

// --- the time columns --------------------------------------------------------

/**
 * <TimeSheet> — a column for each of the hours, the minutes, the seconds
 * where the field shows them, and the half of the day where its clock has
 * twelve hours: a press on an item sets the segment, and the field's other
 * segments take what makes the time whole, as Chrome's list does. The keys
 * stay the field's, whose segments the columns follow.
 */
function TimeSheet({
  values,
  layout,
  theme,
  height,
  minuteStep: stepBy,
  pick,
}: {
  values: SegmentValues;
  layout: FieldLayout;
  theme: Theme;
  height: number;
  minuteStep: number;
  pick: (name: SegmentName, n: number) => void;
}): ReactElement {
  const names = timeColumns(layout);
  const refs = React.useRef(new Map<SegmentName, ScrollableNode>());
  const itemsOf = (name: SegmentName): number[] => {
    const [low, high] = segmentRange(name, layout);
    const by = name === 'minute' ? stepBy : 1;
    const out: number[] = [];
    for (let n = low; n <= high; n += by) out.push(n);
    return out;
  };
  // what is chosen at the top of its column as the sheet opens, as
  // Chrome's list has it
  React.useLayoutEffect(() => {
    for (const name of names) {
      const at = itemsOf(name).indexOf(values[name] ?? -1);
      if (at > 0) refs.current.get(name)?.scrollTo({ y: at * ITEM_H });
    }
  }, []);
  return hx(
    'box',
    { style: [s.columns, { height }] },
    names.map((name) =>
      hx(
        'box',
        {
          key: name,
          role: 'listbox',
          'aria-label': SEGMENT_NAMES[name],
          // the wheel and the field's keys move it, and a bar over items as
          // narrow as these would cover their text
          scrollbar: false,
          // A scroll pane takes the focus on a press, to scroll by its keys:
          // from the field, whose blur takes the picker up under the
          // pointer before the release is a click. The field has the keys.
          focusable: false,
          ref: (node: ScrollableNode | null) => {
            if (node) refs.current.set(name, node);
            else refs.current.delete(name);
          },
          style: [s.column, { height: height - PAD * 2 }],
        },
        itemsOf(name).map((n) => {
          const chosen = values[name] === n;
          return hx(
            'box',
            {
              key: n,
              role: 'option',
              'aria-selected': chosen,
              onClick: () => pick(name, n),
              style: [
                s.item,
                {
                  borderRadius: theme.radius,
                  backgroundColor: chosen ? theme.accent : 'transparent',
                },
                {
                  ':hover': {
                    backgroundColor: chosen
                      ? theme.accentHover
                      : theme.surfaceHover,
                  },
                },
              ],
            },
            hx(
              'text',
              { style: { color: chosen ? theme.accentText : theme.text } },
              segmentText(name, { [name]: n }, layout),
            ),
          );
        }),
      ),
    ),
  );
}

// --- the months --------------------------------------------------------------

/**
 * <MonthSheet> — a year's twelve months, three across, under the year and
 * the arrows to the ones either side: a month input's picker, in the
 * calendar's look. Its keys are the calendar's in kind: the arrows move a
 * month across and a row down, PageUp and PageDown a year, Home and End to
 * a row's ends, Enter and Space pick.
 */
const MonthSheet = React.forwardRef(function MonthSheet(
  {
    values,
    layout,
    theme,
    min,
    max,
    pick,
  }: {
    values: SegmentValues;
    layout: FieldLayout;
    theme: Theme;
    /** Months since year 0, `year * 12 + month - 1`. */
    min: number | undefined;
    max: number | undefined;
    pick: (year: number, month: number) => void;
  },
  ref: React.ForwardedRef<SheetHandle>,
): ReactElement {
  const now = new Date();
  const chosen =
    values.year !== undefined && values.month !== undefined
      ? values.year * 12 + values.month - 1
      : null;
  const clamp = (n: number) =>
    Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n));
  const [cursor, setCursor] = React.useState(() =>
    clamp(chosen ?? now.getFullYear() * 12 + now.getMonth()),
  );
  const year = Math.floor(cursor / 12);
  const blocked = (n: number) =>
    (min !== undefined && n < min) || (max !== undefined && n > max);
  const choose = (n: number) => {
    if (blocked(n)) return;
    pick(Math.floor(n / 12), (n % 12) + 1);
  };
  const move = (by: number) => setCursor((c) => clamp(c + by));
  React.useImperativeHandle(ref, () => ({
    handleKey: (ev) => {
      switch (ev.keysym) {
        case XK_LEFT:
          move(-1);
          return true;
        case XK_RIGHT:
          move(1);
          return true;
        case XK_UP:
          move(-MONTH_COLUMNS);
          return true;
        case XK_DOWN:
          move(MONTH_COLUMNS);
          return true;
        case XK_HOME:
          move(-(cursor % MONTH_COLUMNS));
          return true;
        case XK_END:
          move(MONTH_COLUMNS - 1 - (cursor % MONTH_COLUMNS));
          return true;
        case XK_PAGE_UP:
          move(-12);
          return true;
        case XK_PAGE_DOWN:
          move(12);
          return true;
        case XK_RETURN:
        case XK_KP_ENTER:
          choose(cursor);
          return true;
        default:
          break;
      }
      if (ev.codepoint === 32) {
        choose(cursor);
        return true;
      }
      return false;
    },
  }));
  const nav = (by: -1 | 1) => {
    const disabled = blocked(by < 0 ? year * 12 - 1 : (year + 1) * 12);
    return hx(
      'box',
      {
        key: by < 0 ? 'previous' : 'next',
        role: 'button',
        'aria-label': by < 0 ? 'Previous year' : 'Next year',
        disabled: disabled || undefined,
        onClick: disabled ? undefined : () => move(by * 12),
        style: [
          s.nav,
          { borderRadius: theme.radius },
          !disabled && {
            ':hover': { backgroundColor: theme.surfaceHover },
          },
        ],
      },
      React.createElement(Icon, {
        name: by < 0 ? 'chevronLeft' : 'chevronRight',
        size: 12,
        color: disabled ? theme.border : theme.textMuted,
      }),
    );
  };
  const short = shortMonths();
  const rows: ReactElement[] = [];
  for (let row = 0; row < 12 / MONTH_COLUMNS; row++) {
    rows.push(
      hx(
        'box',
        { key: row, role: 'row', style: s.monthRow },
        Array.from({ length: MONTH_COLUMNS }, (_, col) => {
          const month = row * MONTH_COLUMNS + col;
          const n = year * 12 + month;
          const off = blocked(n);
          const picked = n === chosen;
          return hx(
            'box',
            {
              key: col,
              role: 'gridcell',
              'aria-label': layout.months[month],
              'aria-selected': picked,
              disabled: off || undefined,
              style: s.monthCell,
            },
            hx(
              'box',
              {
                onClick: off ? undefined : () => choose(n),
                style: [
                  s.monthPill,
                  {
                    cursor: off ? 'default' : 'pointer',
                    borderRadius: theme.radius,
                    backgroundColor: picked ? theme.accent : 'transparent',
                    borderColor:
                      n === cursor
                        ? theme.borderFocus
                        : n === now.getFullYear() * 12 + now.getMonth()
                          ? theme.accent
                          : 'transparent',
                  },
                  !off && {
                    ':hover': {
                      backgroundColor: picked
                        ? theme.accentHover
                        : theme.surfaceHover,
                    },
                  },
                ],
              },
              hx(
                'text',
                {
                  style: {
                    color: picked
                      ? theme.accentText
                      : off
                        ? theme.textMuted
                        : theme.text,
                  },
                },
                short[month],
              ),
            ),
          );
        }),
      ),
    );
  }
  return hx(
    'box',
    { role: 'grid', style: s.months },
    hx(
      'box',
      { key: 'header', style: s.monthHeader },
      nav(-1),
      hx(
        'text',
        { key: 'year', style: [s.monthTitle, { color: theme.text }] },
        String(year).padStart(4, '0'),
      ),
      nav(1),
    ),
    rows,
  );
});

let SHORT_MONTHS: string[] | null = null;

/** The months' short names in the runtime's locale, as the field's are. */
function shortMonths(): string[] {
  if (!SHORT_MONTHS) {
    const format = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      timeZone: 'UTC',
    });
    SHORT_MONTHS = Array.from({ length: 12 }, (_, i) =>
      format.format(Date.UTC(2026, i, 1)),
    );
  }
  return SHORT_MONTHS;
}

/** A clock's face, `size` across: a time input's indicator. A noun, so
 *  drawn here, as the calendar's page is. */
function ClockGlyph({
  color,
  size,
}: {
  color: string;
  size: number;
}): ReactElement {
  return hx('canvas', {
    style: { width: size, height: size, flexShrink: 0 },
    onDraw: (ctx, { width, height }) => {
      const r = Math.min(width, height) / 2 - 0.5;
      const cx = width / 2;
      const cy = height / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - r * 0.6);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + r * 0.45, cy);
      ctx.stroke();
    },
  });
}
