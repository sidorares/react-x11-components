// What a date, a time, a month, a week or a `datetime-local` input shows and
// is typed into: the field's segments, read from and written to the value
// the form holds (HTML 4.10.5.1.7 to .11).
//
// A browser draws these as a row of segments — "11/18/2026", "02:30 PM",
// "Week 47, 2026" — each typed into, stepped and cleared on its own, with
// the value the page reads only whole: an empty string until every segment
// says something, and the value's own form (`2026-11-18`, `14:30`,
// `2026-W47`) once they do. This is that model, pure: no React and no
// renderer, so all of it is asserted with no display. The widget that draws
// it, and the picker it drops, is `date-picker.ts`.
//
// The order of the segments and what is between them is the locale's, as
// `Intl.DateTimeFormat` writes a date, as Chrome's is the browser's. A week
// has no `Intl` form, and is written as Chrome writes it in English.

import { fieldNumber } from './form.js';

/** The `<input type>`s that are a date, a time or both. */
export type DateFieldType =
  'date' | 'month' | 'week' | 'time' | 'datetime-local';

const TYPES: ReadonlySet<string> = new Set<DateFieldType>([
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
]);

/** Whether an input's type state is one of them. */
export function isDateFieldType(type: string): type is DateFieldType {
  return TYPES.has(type);
}

/** A segment of the field. An hour is as the field shows it, 1 to 12 where
 *  the locale's clock has twelve hours, and `period` says which half of the
 *  day: 0 before noon, 1 after. */
export type SegmentName =
  | 'year'
  | 'month'
  | 'day'
  | 'week'
  | 'hour'
  | 'minute'
  | 'second'
  | 'millisecond'
  | 'period';

/** What each segment holds, where it holds anything. */
export type SegmentValues = Partial<Record<SegmentName, number>>;

/** A segment, or the text between two. */
export type FieldPart = { segment: SegmentName } | { text: string };

/** How a field of a type is written in a locale. */
export interface FieldLayout {
  type: DateFieldType;
  parts: readonly FieldPart[];
  /** The segments, in the order the parts have them. */
  segments: readonly SegmentName[];
  /** Whether the clock has twelve hours and a `period`. */
  hour12: boolean;
  /** The locale's words for the two halves of the day. */
  periods: readonly [string, string];
  /** The months' names, January first, for a month input's. */
  months: readonly string[];
}

/** The least and the most a segment holds. A day is 1 to 31 whatever the
 *  month, as a browser's segment is: the month may come after it. */
export function segmentRange(
  name: SegmentName,
  layout: FieldLayout,
): readonly [number, number] {
  switch (name) {
    case 'year':
      return [1, 275760];
    case 'month':
      return [1, 12];
    case 'day':
      return [1, 31];
    case 'week':
      return [1, 53];
    case 'hour':
      return layout.hour12 ? [1, 12] : [0, 23];
    case 'minute':
    case 'second':
      return [0, 59];
    case 'millisecond':
      return [0, 999];
    case 'period':
      return [0, 1];
  }
}

/** What a field shows with nothing in a segment. */
export function segmentPlaceholder(
  name: SegmentName,
  layout: FieldLayout,
): string {
  const lettered = layout.type === 'date' || layout.type === 'datetime-local';
  switch (name) {
    case 'year':
      return lettered ? 'yyyy' : '----';
    case 'month':
      return layout.type === 'month' ? '---------' : 'mm';
    case 'day':
      return 'dd';
    case 'millisecond':
      return '---';
    default:
      return '--';
  }
}

/** What a segment shows. */
export function segmentText(
  name: SegmentName,
  values: SegmentValues,
  layout: FieldLayout,
): string {
  const value = values[name];
  if (value === undefined) return segmentPlaceholder(name, layout);
  switch (name) {
    case 'year':
      return String(value).padStart(4, '0');
    case 'month':
      return layout.type === 'month'
        ? (layout.months[value - 1] ?? String(value))
        : String(value).padStart(2, '0');
    case 'millisecond':
      return String(value).padStart(3, '0');
    case 'period':
      return layout.periods[value];
    default:
      return String(value).padStart(2, '0');
  }
}

/** The whole field as it is shown: what a test, an accessible name and a
 *  measure read. */
export function fieldText(layout: FieldLayout, values: SegmentValues): string {
  return layout.parts
    .map((part) =>
      'text' in part ? part.text : segmentText(part.segment, values, layout),
    )
    .join('');
}

// --- the locale's form ------------------------------------------------------

/** What `Intl` calls each part a segment is made of. */
const INTL_PARTS: Readonly<Record<string, SegmentName>> = {
  year: 'year',
  month: 'month',
  day: 'day',
  hour: 'hour',
  minute: 'minute',
  second: 'second',
  fractionalSecond: 'millisecond',
  dayPeriod: 'period',
};

const LAYOUTS = new Map<string, FieldLayout>();

/**
 * How a field of `type` is written in `locale` (the runtime's where it is
 * undefined), with `seconds` and `millis` shown where the field's step or
 * its value has them. Kept by its arguments, since every render of every
 * field asks.
 */
export function fieldLayout(
  type: DateFieldType,
  locale?: string,
  seconds = false,
  millis = false,
): FieldLayout {
  const key = `${type}|${locale ?? ''}|${seconds}|${millis}`;
  let layout = LAYOUTS.get(key);
  if (!layout) {
    layout = makeLayout(type, locale, seconds || millis, millis);
    LAYOUTS.set(key, layout);
  }
  return layout;
}

function makeLayout(
  type: DateFieldType,
  locale: string | undefined,
  seconds: boolean,
  millis: boolean,
): FieldLayout {
  const clock = timeFormat(locale, seconds, millis);
  const hour12 = clockHas12(clock);
  const periods = periodNames(locale);
  const months = monthNames(locale);
  let parts: FieldPart[];
  switch (type) {
    case 'date':
      parts = partsOf(dateFormat(locale));
      break;
    case 'time':
      parts = partsOf(clock);
      break;
    case 'datetime-local': {
      // the locale's own way of putting a date and a time together, ", "
      // in English
      parts = partsOf(
        safeFormat(locale, {
          ...dateOptions(),
          ...timeOptions(seconds, millis),
          hourCycle: hour12 ? 'h12' : 'h23',
        }),
      );
      break;
    }
    case 'month':
      parts = partsOf(
        safeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }),
      );
      break;
    case 'week':
      // no `Intl` form: Chrome's English
      parts = [
        { text: 'Week ' },
        { segment: 'week' },
        { text: ', ' },
        { segment: 'year' },
      ];
      break;
  }
  parts = complete(type, parts, seconds, millis, hour12);
  return {
    type,
    parts,
    segments: parts.flatMap((p) => ('segment' in p ? [p.segment] : [])),
    hour12,
    periods,
    months,
  };
}

function dateOptions(): Intl.DateTimeFormatOptions {
  return { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' };
}

function timeOptions(
  seconds: boolean,
  millis: boolean,
): Intl.DateTimeFormatOptions {
  return {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds && { second: '2-digit' }),
    ...(millis && { fractionalSecondDigits: 3 }),
    timeZone: 'UTC',
  };
}

function dateFormat(locale: string | undefined): Intl.DateTimeFormat {
  return safeFormat(locale, dateOptions());
}

function timeFormat(
  locale: string | undefined,
  seconds: boolean,
  millis: boolean,
): Intl.DateTimeFormat {
  return safeFormat(locale, timeOptions(seconds, millis));
}

/** A format in the locale, or in the runtime's where it names none `Intl`
 *  takes, as a page's `lang` may. */
function safeFormat(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat(undefined, options);
  }
}

function clockHas12(format: Intl.DateTimeFormat): boolean {
  const { hourCycle, hour12 } = format.resolvedOptions() as {
    hourCycle?: string;
    hour12?: boolean;
  };
  if (hourCycle) return hourCycle === 'h11' || hourCycle === 'h12';
  return hour12 === true;
}

// a Thursday in the middle of a month, whose parts are all two digits
const SAMPLE = Date.UTC(2026, 10, 18, 14, 30, 45, 123);

/** The segments and what is between them, as a format writes them. */
function partsOf(format: Intl.DateTimeFormat): FieldPart[] {
  const out: FieldPart[] = [];
  let text = '';
  for (const part of format.formatToParts(SAMPLE)) {
    const segment = INTL_PARTS[part.type];
    if (part.type === 'literal') {
      // ICU puts a narrow no-break space before a period in some versions,
      // and a plain one in others: a space either way
      text += part.value.replace(/[\u00a0\u202f]/g, ' ');
      continue;
    }
    // an era, a related year: nothing a value of the type holds
    if (!segment || out.some((p) => 'segment' in p && p.segment === segment)) {
      continue;
    }
    if (text && out.length) out.push({ text });
    text = '';
    out.push({ segment });
  }
  return out;
}

/** The parts, with any segment the value needs that the locale's form left
 *  out put at the end, so no value has a segment it cannot be typed in. */
function complete(
  type: DateFieldType,
  parts: FieldPart[],
  seconds: boolean,
  millis: boolean,
  hour12: boolean,
): FieldPart[] {
  const need: SegmentName[] = [];
  if (type === 'date' || type === 'datetime-local') {
    need.push('year', 'month', 'day');
  }
  if (type === 'month') need.push('year', 'month');
  if (type === 'time' || type === 'datetime-local') {
    need.push('hour', 'minute');
    if (seconds) need.push('second');
    if (millis) need.push('millisecond');
    if (hour12) need.push('period');
  }
  const has = new Set(
    parts.flatMap((p) => ('segment' in p ? [p.segment] : [])),
  );
  // a clock of twenty-four hours has no half of the day to type
  const out = parts.filter(
    (p) => !('segment' in p) || p.segment !== 'period' || hour12,
  );
  for (const name of need) {
    if (has.has(name)) continue;
    out.push({ text: name === 'millisecond' ? '.' : ' ' }, { segment: name });
  }
  return out;
}

function periodNames(locale: string | undefined): [string, string] {
  const format = safeFormat(locale, {
    hour: 'numeric',
    hourCycle: 'h12',
    timeZone: 'UTC',
  });
  const name = (hour: number) =>
    format
      .formatToParts(Date.UTC(2026, 0, 1, hour))
      .find((p) => p.type === 'dayPeriod')?.value;
  return [name(1) ?? 'AM', name(13) ?? 'PM'];
}

function monthNames(locale: string | undefined): string[] {
  const format = safeFormat(locale, { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) =>
    format.format(Date.UTC(2026, i, 1)),
  );
}

// --- the value --------------------------------------------------------------

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * What the segments of a field show of a value: nothing for an empty one,
 * or one that is no valid value of the type, which the form's sanitization
 * has made empty already.
 */
export function segmentsOf(layout: FieldLayout, value: string): SegmentValues {
  const out: SegmentValues = {};
  if (fieldNumber(layout.type, value) === null) return out;
  let rest = value;
  if (layout.type === 'week') {
    const m = /^(\d{4,})-W(\d\d)$/.exec(rest)!;
    out.year = Number(m[1]);
    out.week = Number(m[2]);
  } else if (layout.type !== 'time') {
    const m = /^(\d{4,})-(\d\d)(?:-(\d\d))?/.exec(rest)!;
    out.year = Number(m[1]);
    out.month = Number(m[2]);
    if (m[3] !== undefined) out.day = Number(m[3]);
    // past the `T`, or the space HTML takes for one
    rest = rest.slice(m[0].length + 1);
  }
  if (layout.type === 'time' || layout.type === 'datetime-local') {
    const m = /^(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?$/.exec(rest)!;
    const hour = Number(m[1]);
    out.minute = Number(m[2]);
    if (layout.segments.includes('second')) out.second = Number(m[3] ?? 0);
    if (layout.segments.includes('millisecond')) {
      out.millisecond = Number((m[4] ?? '').padEnd(3, '0'));
    }
    if (layout.hour12) {
      out.hour = hour % 12 || 12;
      out.period = hour < 12 ? 0 : 1;
    } else {
      out.hour = hour;
    }
  }
  return out;
}

/** The hour of the day, 0 to 23, the segments come to, where they say. */
export function hourOfDay(
  layout: FieldLayout,
  values: SegmentValues,
): number | undefined {
  const { hour, period } = values;
  if (hour === undefined) return undefined;
  if (!layout.hour12) return hour;
  if (period === undefined || hour < 1 || hour > 12) return undefined;
  return (hour % 12) + period * 12;
}

/**
 * The value the segments come to (HTML's normalized forms), or the empty
 * string while any of them is empty or they come to no valid value of the
 * type: the 31st of a month of thirty days, a week 53 of a year of 52.
 */
export function valueOf(layout: FieldLayout, values: SegmentValues): string {
  for (const name of layout.segments) {
    if (values[name] === undefined) return '';
    const [low, high] = segmentRange(name, layout);
    if (values[name]! < low || values[name]! > high) return '';
  }
  const { type } = layout;
  const year = values.year === undefined ? '' : pad(values.year, 4);
  let text = '';
  if (type === 'date' || type === 'datetime-local') {
    text = `${year}-${pad(values.month!)}-${pad(values.day!)}`;
  } else if (type === 'month') {
    text = `${year}-${pad(values.month!)}`;
  } else if (type === 'week') {
    text = `${year}-W${pad(values.week!)}`;
  }
  if (type === 'time' || type === 'datetime-local') {
    let time = `${pad(hourOfDay(layout, values)!)}:${pad(values.minute!)}`;
    if (values.second !== undefined) time += `:${pad(values.second)}`;
    if (values.millisecond !== undefined) {
      time += `.${pad(values.millisecond, 3)}`;
    }
    text = type === 'time' ? time : `${text}T${time}`;
  }
  return fieldNumber(type, text) === null ? '' : text;
}

/**
 * Whether a field shows seconds, and milliseconds: where its `step` is no
 * whole number of minutes, or of seconds, or its value has either. A step
 * of `any` shows neither, as a step of a minute does (Chrome's).
 */
export function precisionOf(
  step: string | undefined,
  value: string,
): { seconds: boolean; millis: boolean } {
  const written = step?.trim();
  const n =
    written && /^\d*\.?\d+(?:e[+-]?\d+)?$/i.test(written) ? Number(written) : 0;
  const m = /:\d\d:(\d\d)(?:\.(\d{1,3}))?$/.exec(value);
  const millis = (n > 0 && !Number.isInteger(n)) || Number(m?.[2] ?? 0) > 0;
  const seconds = millis || (n > 0 && n % 60 !== 0) || Number(m?.[1] ?? 0) > 0;
  return { seconds, millis };
}

// --- editing ----------------------------------------------------------------

/** A segment stepped up or down by `by`, as an arrow key steps it: round
 *  from its most to its least, and from nothing to the first value on the
 *  way, or this year for a year, which goes no further than its ends. */
export function stepSegment(
  layout: FieldLayout,
  values: SegmentValues,
  name: SegmentName,
  by: number,
  thisYear: number,
): SegmentValues {
  const [low, high] = segmentRange(name, layout);
  const now = values[name];
  let next: number;
  if (now === undefined) {
    next = name === 'year' ? thisYear : by > 0 ? low : high;
  } else if (name === 'year') {
    next = Math.min(high, Math.max(low, now + by));
  } else {
    const span = high - low + 1;
    next = low + ((((now - low + by) % span) + span) % span);
  }
  return { ...values, [name]: next };
}

/** How many digits a segment is typed in before the next one takes the
 *  keys. */
function digitsOf(name: SegmentName, layout: FieldLayout): number {
  if (name === 'year') return 4;
  return String(segmentRange(name, layout)[1]).length;
}

/**
 * A digit typed into a segment, after `typed`, the digits typed into it
 * since it took the keys: the segment's value and the digits so far, and
 * whether the next segment takes the keys from here — once no digit more
 * could make a value the segment holds (a "2" in a month, two in a day),
 * as Chrome moves on. A digit that would take it past its most starts it
 * again.
 */
export function typeDigit(
  layout: FieldLayout,
  values: SegmentValues,
  name: SegmentName,
  typed: string,
  digit: string,
): { values: SegmentValues; typed: string; advance: boolean } {
  const [, high] = segmentRange(name, layout);
  const digits = digitsOf(name, layout);
  let next = typed + digit;
  if (Number(next) > high || next.length > digits) next = digit;
  const value = Number(next);
  const advance = next.length >= digits || value * 10 > high;
  return {
    values: { ...values, [name]: value },
    typed: advance ? '' : next,
    advance,
  };
}

/**
 * A letter typed into a segment that holds a word: a period by the first
 * letters of its name ("p" for PM), and a month input's month by its name,
 * from what was typed since it took the keys. Null where no word starts
 * with it, which leaves the segment as it is.
 */
export function typeLetter(
  layout: FieldLayout,
  values: SegmentValues,
  name: SegmentName,
  typed: string,
  letter: string,
): { values: SegmentValues; typed: string; advance: boolean } | null {
  const words =
    name === 'period'
      ? layout.periods
      : name === 'month' && layout.type === 'month'
        ? layout.months
        : null;
  if (!words) return null;
  const find = (prefix: string) =>
    words.findIndex((w) => w.toLocaleLowerCase().startsWith(prefix));
  let prefix = (typed + letter).toLocaleLowerCase();
  let at = find(prefix);
  if (at < 0) {
    prefix = letter.toLocaleLowerCase();
    at = find(prefix);
  }
  if (at < 0) return null;
  const index = name === 'period' ? at : at + 1;
  // the one word this prefix names is all it can be
  const only = words.filter((w) => w.toLocaleLowerCase().startsWith(prefix));
  const advance = only.length === 1;
  return {
    values: { ...values, [name]: index },
    typed: advance ? '' : prefix,
    advance,
  };
}

// --- weeks ------------------------------------------------------------------

const DAY_MS = 86400000;

/** The ISO 8601 week a day is in: its year, which may be the day's year's
 *  neighbour, and its number. `day` is `YYYY-MM-DD`. */
export function weekOfDay(day: string): { year: number; week: number } {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  // the Thursday of its week names the year it is in
  const weekday = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date.getTime() + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const first = new Date(0);
  first.setUTCFullYear(year, 0, 1);
  const week =
    Math.floor((thursday.getTime() - first.getTime()) / DAY_MS / 7) + 1;
  return { year, week };
}

/** The Monday a week starts on, as `YYYY-MM-DD`. */
export function mondayOfWeek(year: number, week: number): string {
  const fourth = new Date(0);
  fourth.setUTCFullYear(year, 0, 4);
  const monday =
    fourth.getTime() -
    ((fourth.getUTCDay() + 6) % 7) * DAY_MS +
    (week - 1) * 7 * DAY_MS;
  return dayKey(new Date(monday));
}

/** A day as `YYYY-MM-DD`, from a UTC instant. */
export function dayKey(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The day `n` days on from a `YYYY-MM-DD`. */
export function addDaysTo(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d + n);
  return dayKey(date);
}
