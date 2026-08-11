// The convenience barrel. `import { Sparkline } from '@react-x11/components'`
// and `import { Sparkline } from '@react-x11/components/sparkline'` are the
// same module either way — with `sideEffects: false` and no side effects at
// this level, a bundler drops the components an app does not name.
//
// This file must never do more than re-export. Anything with a side effect
// here (a registration, a theme install, a feature probe) runs for every
// consumer of the barrel and takes the whole package into their bundle.
export { Sparkline, SPARKLINE_ELEMENT } from './sparkline/index.js';
export type { SparklineProps } from './sparkline/index.js';

export {
  Calendar,
  DatePicker,
  CALENDAR_WIDTH,
  CALENDAR_HEIGHT,
  // The day vocabulary the calendar props speak. An app that renders one
  // almost always does a little of the same arithmetic to decide what to
  // block or what to mark, so it comes out through the barrel too.
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
} from './calendar/index.js';
export type {
  CalendarProps,
  SingleCalendarProps,
  RangeCalendarProps,
  CalendarDayState,
  CalendarHandle,
  DatePickerProps,
  DateRange,
  DateRangeInput,
  CalendarDay,
  CalendarMonth,
  DayInput,
  DayParts,
  WidgetChangeEvent,
} from './calendar/index.js';

export {
  Markdown,
  MarkdownSelection,
  MDTEXT_ELEMENT,
  MdTextNode,
  parse as parseMarkdown,
} from './markdown/index.js';
export type {
  MarkdownProps,
  MarkdownDocument,
  MdRun,
  MdTextProps,
  BlockNode,
  InlineNode,
  ParseOptions,
} from './markdown/index.js';

export {
  DesktopCalendar,
  IcalUnavailableError,
  byDay,
  parseKeyFile,
  useDesktopCalendarEvents,
} from './desktop-calendar/index.js';
export type {
  DesktopCalendarChange,
  DesktopCalendarError,
  DesktopCalendarInfo,
  DesktopCalendarStatus,
  DesktopEvent,
  EventsResult,
  UseDesktopCalendarEventsOptions,
  UseDesktopCalendarEventsResult,
} from './desktop-calendar/index.js';
