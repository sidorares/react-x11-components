// <Calendar> and <DatePicker> — the date widgets, moved out of react-x11 core.
//
// Unlike `../code-editor/`, nothing here registers a host element: both are
// compositions of `<box>`, `<text>` and `<canvas>`, so there is no
// `registerElement` call, no JSX augmentation, and **no side effect at import
// time at all**. An app that names neither pays for neither.
//
// The date arithmetic in `./dates.js` is exported too. It is the vocabulary
// the props speak — a day is a `'YYYY-MM-DD'` string, not a `Date` — and an
// app that renders a calendar almost always has to do a little of the same
// arithmetic to decide what to block or what to mark.
export { Calendar, CALENDAR_WIDTH, CALENDAR_HEIGHT } from './Calendar.js';
export type {
  CalendarProps,
  SingleCalendarProps,
  RangeCalendarProps,
  CalendarDayState,
  CalendarHandle,
  DateRange,
  DateRangeInput,
} from './Calendar.js';

export { DatePicker } from './DatePicker.js';
export type { DatePickerProps } from './DatePicker.js';

export type { WidgetChangeEvent } from './internal.js';

export {
  addDays,
  addMonths,
  clampDay,
  dayDate,
  dayParts,
  firstOfMonth,
  formatDay,
  formatDayRange,
  formatMonth,
  localeWeekStart,
  monthGrid,
  monthOf,
  toDay,
  toMonth,
  today,
  weekdayLabels,
} from './dates.js';
export type {
  CalendarDay,
  CalendarMonth,
  DayInput,
  DayParts,
} from './dates.js';
