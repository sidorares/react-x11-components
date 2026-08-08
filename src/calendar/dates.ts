// Calendar days, and the arithmetic the date widgets do on them.
//
// Vendored from react-x11's `src/components/dates.js` when `<Calendar>` moved
// out here. It is pure — no renderer, no ntk, no React — which is what made
// the move cheap, and core is expected to drop its copy. Divergence is fine
// and expected; this is the owner now.
//
// **A day here is a string, `'2026-08-07'`, not a `Date`.** A date picker
// selects a square on a wall calendar, and that is not an instant: it has no
// time, no zone, and no duration that survives a DST boundary. A `Date` is an
// instant, so every comparison the widgets need — is this the selected day, is
// it inside the range, is it blocked — would be a comparison of two timestamps
// that are only equal if both were built the same way. `new Date(2026, 7, 7)`
// and `new Date('2026-08-07')` are eleven hours apart in Sydney and neither is
// wrong.
//
// A string has none of that: `a === b` is "the same day", `a < b` is "earlier"
// (fixed-width fields, so lexical order *is* chronological order), it is a
// `Map`/`Set` key without a codec, and it is what a calendar API hands back
// over the wire in the first place — which is exactly the shape the desktop
// event overlay in `../desktop-calendar/` produces.
//
// `Date` is still accepted everywhere a day is taken: `toDay()` converts one
// using its **local** calendar day, because that is the day the user was
// looking at when they built it.
//
// The arithmetic runs in UTC (`Date.UTC`, `getUTC*`) so that "add a day" is
// always 86400 seconds and never 23 or 25 — the local-time trap that puts a
// month grid an hour out on the last Sunday in October.

/** A calendar day, `'YYYY-MM-DD'`. */
export type CalendarDay = string;

/** A calendar month, `'YYYY-MM'`. */
export type CalendarMonth = string;

/** What every day-shaped prop accepts. */
export type DayInput = CalendarDay | Date | null | undefined;

/** The parts of a day, so a caller does not have to parse the string. */
export interface DayParts {
  year: number;
  /** 1-based, unlike `Date`'s. */
  month: number;
  day: number;
  /** `0`-`6` from Sunday, as `Date#getDay()` counts. */
  weekday: number;
  date: Date;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function key(year: number, month: number, day: number): CalendarDay {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * A day key from a `'YYYY-MM-DD'` string, a `Date`, or `null`/`undefined`
 * (which is "no day", and comes back as `null`).
 *
 * Throws on anything else, and on a string that is not a real date —
 * `'2026-02-30'` is a typo, not a day, and silently sliding it to March 2nd
 * the way `new Date()` does is how a booking ends up a day out. The message
 * names what arrived, because the value in a props object is usually miles
 * from the line that built it.
 */
export function toDay(value: DayInput): CalendarDay | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(
        '@react-x11/components: an Invalid Date was passed where a calendar day was expected.',
      );
    }
    // its *local* calendar day: `new Date(2026, 7, 7)` is local midnight, and
    // the day the developer wrote down is the one they meant
    return key(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === 'string') {
    const m = DAY_RE.exec(value);
    if (!m) {
      throw new TypeError(
        `@react-x11/components: expected a calendar day as 'YYYY-MM-DD' or a Date, got ${JSON.stringify(value)}.`,
      );
    }
    const [, y, mo, d] = m;
    // through a real Date and back: the fields on their own are well-formed
    // for '2026-02-30' too, and only the calendar knows February ends earlier
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    const round = key(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
    );
    if (round !== value) {
      throw new TypeError(
        `@react-x11/components: ${JSON.stringify(value)} is not a real calendar date.`,
      );
    }
    return value;
  }
  throw new TypeError(
    `@react-x11/components: expected a calendar day as 'YYYY-MM-DD' or a Date, got ${typeof value}.`,
  );
}

/** `'YYYY-MM'` from the same set of inputs, for the *visible month* props. */
export function toMonth(value: DayInput): CalendarMonth | null {
  if (value == null) return null;
  if (typeof value === 'string' && MONTH_RE.test(value)) return value;
  const day = toDay(value);
  return day == null ? null : monthOf(day);
}

/** Today, on this machine, in local time — which is the day the user's wall
 *  calendar is showing. */
export function today(): CalendarDay {
  const now = new Date();
  return key(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** The day as a UTC-midnight `Date`, for `Intl` and for arithmetic. */
export function dayDate(day: CalendarDay): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * `{ year, month, day, weekday, date }` — the parts a caller needs to decide
 * something about a day without parsing the string itself. `weekday` is
 * `0`-`6` from Sunday, as `Date#getDay()` counts, so blocking weekends is
 * `weekday === 0 || weekday === 6`. `month` is 1-based, unlike `Date`'s.
 */
export function dayParts(day: CalendarDay): DayParts {
  const date = dayDate(day);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    date,
  };
}

export function addDays(day: CalendarDay, n: number): CalendarDay {
  const date = dayDate(day);
  date.setUTCDate(date.getUTCDate() + n);
  return key(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** `'2026-08'` — the month a day is in. */
export function monthOf(day: CalendarDay): CalendarMonth {
  return day.slice(0, 7);
}

/** The first day of a `'YYYY-MM'`. */
export function firstOfMonth(month: CalendarMonth): CalendarDay {
  return `${month}-01`;
}

/**
 * `n` months on from a `'YYYY-MM'`. Months, unlike days, are not all the same
 * length, so this deliberately works on the month key and never on a day: the
 * "same date next month" question (Jan 31 → Feb 31?) has no good answer and
 * nothing here asks it.
 */
export function addMonths(month: CalendarMonth, n: number): CalendarMonth {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1, 2)}`;
}

/** `day` held inside `[min, max]`; either bound may be null. */
export function clampDay(
  day: CalendarDay,
  min: CalendarDay | null,
  max: CalendarDay | null,
): CalendarDay {
  if (min && day < min) return min;
  if (max && day > max) return max;
  return day;
}

/**
 * The grid a month is drawn on: **six weeks of seven days**, always, starting
 * on `weekStartsOn` and running through whatever days of the neighbouring
 * months it takes to fill the corners.
 *
 * Six rows even when five would do (and a 28-day February starting on the
 * first day of the week needs only four) because the alternative is a picker
 * whose popup changes height as you page through it, moving the very buttons
 * the pointer is aiming at.
 */
export function monthGrid(
  month: CalendarMonth,
  weekStartsOn = 1,
): CalendarDay[][] {
  const first = firstOfMonth(month);
  const lead = (dayParts(first).weekday - weekStartsOn + 7) % 7;
  const start = addDays(first, -lead);
  const weeks: CalendarDay[][] = [];
  for (let w = 0; w < 6; w++) {
    const days: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) days.push(addDays(start, w * 7 + d));
    weeks.push(days);
  }
  return weeks;
}

// Intl formatters are expensive to build and every cell in the grid wants the
// same three, so they are made once per (locale, shape) and kept.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const id = `${locale ?? ''}|${JSON.stringify(options)}`;
  let f = formatters.get(id);
  if (!f) {
    // everything here is a UTC-midnight Date, so the formatter has to read it
    // in UTC or a negative offset prints the day before
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    formatters.set(id, f);
  }
  return f;
}

/**
 * Which day the week starts on for a locale: `0` Sunday … `6` Saturday.
 *
 * The runtime knows this — CLDR carries it — but only through
 * `Intl.Locale#getWeekInfo`, which is recent enough that a small-ICU build or
 * an older V8 has neither it nor the `weekInfo` property it was proposed as.
 * So it is feature-detected, and what is left when it is missing is **Monday**:
 * ISO 8601's answer, and the one most of the world uses.
 */
export function localeWeekStart(locale?: string): number {
  try {
    const info = new Intl.Locale(locale ?? 'und');
    // `getWeekInfo()` is the standardised spelling; `weekInfo` is what the
    // proposal shipped as and what older V8 still has.
    const withWeek = info as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };
    const week = withWeek.getWeekInfo?.() ?? withWeek.weekInfo;
    // CLDR counts 1 Monday … 7 Sunday; JS counts 0 Sunday … 6 Saturday
    if (week?.firstDay) return week.firstDay % 7;
  } catch {
    // an invalid locale tag: the caller's formatters will complain about it
    // more usefully than a week-start fallback could
  }
  return 1;
}

/** `['Mon', 'Tue', …]` in the locale, rotated to start on `weekStartsOn`. */
export function weekdayLabels(locale?: string, weekStartsOn = 1): string[] {
  const f = formatter(locale, { weekday: 'short' });
  // 2026-08-02 is a Sunday, so `+ weekday` lands on the day we want a name for
  return Array.from({ length: 7 }, (_, i) =>
    f.format(dayDate(addDays('2026-08-02', (weekStartsOn + i) % 7))),
  );
}

/** `'August 2026'` in the locale. */
export function formatMonth(month: CalendarMonth, locale?: string): string {
  return formatter(locale, { month: 'long', year: 'numeric' }).format(
    dayDate(firstOfMonth(month)),
  );
}

/** `'7 Aug 2026'` in the locale — what a picker's trigger shows. */
export function formatDay(
  day: CalendarDay,
  locale?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatter(locale, options ?? { dateStyle: 'medium' }).format(
    dayDate(day),
  );
}

/**
 * `'7 – 12 Aug 2026'`: the locale's own way of writing a span, which collapses
 * the parts the two ends share. `formatRange` is ES2021 and universal in the
 * Node versions this package supports, but a small-ICU build can still throw,
 * so a plain "a – b" is kept behind it.
 */
export function formatDayRange(
  start: CalendarDay,
  end: CalendarDay,
  locale?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const f = formatter(locale, options ?? { dateStyle: 'medium' });
  try {
    return f.formatRange(dayDate(start), dayDate(end));
  } catch {
    return `${f.format(dayDate(start))} – ${f.format(dayDate(end))}`;
  }
}
