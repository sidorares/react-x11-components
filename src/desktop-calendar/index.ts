// Read the calendars the user's desktop already has, and hand them to a
// `<Calendar dayContent>`.
//
// The point of this module is that an app gets the user's real events —
// Google, Microsoft, CalDAV, local — without asking for a single credential
// and without an OAuth flow, because the desktop already did all of that. See
// `./eds.js` for how, and `../calendar/` for what to draw them on.
//
// Nothing here opens a D-Bus connection. `useSessionBus()` (or `sessionBus()`
// for the imperative path) hands over react-x11's shared one, so an app is one
// name on the bus however many features it turns on.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSessionBus } from 'react-x11';

import { DesktopCalendar } from './eds.js';
import type {
  CalendarChange,
  DesktopCalendarError,
  DesktopCalendarInfo,
  DesktopEvent,
} from './eds.js';

export { DesktopCalendar, parseKeyFile } from './eds.js';
export type {
  CalendarChange,
  DesktopCalendarError,
  DesktopCalendarInfo,
  DesktopEvent,
  EventsResult,
} from './eds.js';
export { IcalUnavailableError } from './ical.js';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The local calendar day a `Date` falls on, as `'YYYY-MM-DD'`.
 *
 * Deliberately a local three-liner rather than an import from `../calendar/`:
 * no component in this package imports another, because a lateral import
 * makes the two one unit in a bundler's eyes and an app that wanted only the
 * events would start paying for the grid. The **format** is the contract they
 * share, not the function — these keys index straight into a `<Calendar>`'s
 * `dayContent`.
 */
function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Occurrences grouped by the local day they appear on — which is what a
 * calendar grid actually renders.
 *
 * An all-day event spans `[start, end)` across possibly several days, and a
 * timed one can cross midnight, so an event lands under **every** day it
 * touches rather than only under its start.
 */
export function byDay(events: DesktopEvent[]): Map<string, DesktopEvent[]> {
  const days = new Map<string, DesktopEvent[]>();
  for (const event of events) {
    // `end` is exclusive, so a one-day all-day event ending at the next
    // midnight must not also mark the next day.
    const lastMs = Math.max(event.start.getTime(), event.end.getTime() - 1);
    const last = new Date(lastMs);
    const cursor = new Date(
      event.start.getFullYear(),
      event.start.getMonth(),
      event.start.getDate(),
    );
    while (cursor <= last) {
      const key = dayKeyOf(cursor);
      const list = days.get(key);
      if (list) list.push(event);
      else days.set(key, [event]);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return days;
}

export type DesktopCalendarStatus =
  'idle' | 'loading' | 'ready' | 'unavailable';

export interface UseDesktopCalendarEventsOptions {
  /** Start of the window to read, inclusive. */
  from: Date;
  /** End of the window, exclusive. */
  to: Date;
  /** Restrict to these calendar UIDs. Default: every enabled calendar. */
  calendars?: string[];
  /** Re-query when the desktop says something in the range changed. */
  watch?: boolean;
  /** Set false to hold off entirely — a picker that is not open yet. */
  enabled?: boolean;
}

export interface UseDesktopCalendarEventsResult {
  events: DesktopEvent[];
  /** The same events, keyed by `'YYYY-MM-DD'`, ready for `dayContent`. */
  byDay: Map<string, DesktopEvent[]>;
  /** Every calendar found, for a legend or a filter. */
  calendars: DesktopCalendarInfo[];
  /** Backends that would not answer. Not fatal; the rest still loaded. */
  errors: DesktopCalendarError[];
  status: DesktopCalendarStatus;
  /** Why there are no events: no bus, or no `ical.js`. */
  error: Error | null;
  /** Re-query now. */
  refresh: () => void;
}

const NO_EVENTS: DesktopEvent[] = [];
const NO_CALENDARS: DesktopCalendarInfo[] = [];
const NO_ERRORS: DesktopCalendarError[] = [];

/** The calendars a caller asked for by uid, or every enabled one. `onlyKey`
 *  is the comma-joined list, because an array prop is a new identity every
 *  render and these two effects are keyed on it. */
function pickCalendars(
  all: DesktopCalendarInfo[],
  onlyKey: string,
): DesktopCalendarInfo[] {
  if (!onlyKey) return all.filter((c) => c.enabled);
  const wanted = new Set(onlyKey.split(','));
  return all.filter((c) => wanted.has(c.uid));
}

/**
 * The user's desktop calendar events, as rendering state.
 *
 * ```tsx
 * const { byDay } = useDesktopCalendarEvents({ from, to });
 *
 * <Calendar
 *   dayContent={(day, state) =>
 *     byDay.get(day)?.slice(0, 3).map((ev) => (
 *       <box key={ev.uid} style={{ width: 4, height: 4, borderRadius: 2,
 *                                  backgroundColor: state.selected
 *                                    ? state.color
 *                                    : (ev.calendar.color ?? '$accent') }} />
 *     ))
 *   }
 * />
 * ```
 *
 * **`from` and `to` are read by their timestamps, not their identity**, so
 * `new Date(...)` inline in the render is fine and will not re-query on every
 * paint. That is the mistake this hook would otherwise invite, and it costs a
 * D-Bus round trip per frame.
 *
 * `status` is `'unavailable'` when there is no session bus or `ical.js` is not
 * installed — both are ordinary on a machine that simply does not have them,
 * so neither throws, and `error` says which it was. Treat it as "no calendar
 * integration here", not as a failure to report.
 */
export function useDesktopCalendarEvents(
  options: UseDesktopCalendarEventsOptions,
): UseDesktopCalendarEventsResult {
  const { from, to, calendars: only, watch = false, enabled = true } = options;
  const { bus } = useSessionBus();

  const [events, setEvents] = useState<DesktopEvent[]>(NO_EVENTS);
  const [found, setFound] = useState<DesktopCalendarInfo[]>(NO_CALENDARS);
  const [errors, setErrors] = useState<DesktopCalendarError[]>(NO_ERRORS);
  const [status, setStatus] = useState<DesktopCalendarStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Timestamps, not the Date objects: a caller writing `from={new Date(y, m, 1)}`
  // in the render body hands us a new identity every paint, and an effect keyed
  // on that would re-query the bus on every frame.
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const onlyKey = only ? only.join(',') : '';

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return undefined;
    }
    if (!bus) {
      // `useSessionBus` is still connecting, or there is no bus at all. Its
      // own `status` distinguishes them; from here both mean "nothing yet".
      setStatus('unavailable');
      setEvents(NO_EVENTS);
      return undefined;
    }

    let live = true;
    const desktop = new DesktopCalendar(bus);

    const run = async (): Promise<void> => {
      setStatus('loading');
      setError(null);
      try {
        const all = await desktop.listCalendars();
        if (!live) return;
        setFound(all);

        const result = await desktop.eventsBetween(
          new Date(fromMs),
          new Date(toMs),
          { calendars: pickCalendars(all, onlyKey) },
        );
        if (!live) return;
        setEvents(result.events);
        setErrors(result.errors);
        setStatus('ready');
      } catch (err) {
        if (!live) return;
        // No bus, no ical.js, no EDS on this desktop — all ordinary.
        setError(err instanceof Error ? err : new Error(String(err)));
        setEvents(NO_EVENTS);
        setStatus('unavailable');
      }
    };

    void run();

    return () => {
      live = false;
      void desktop.dispose();
    };
    // `refresh` is stable; `nonce` is what a manual refresh moves.
  }, [bus, enabled, fromMs, toMs, onlyKey, nonce, refresh]);

  // The subscription is a **separate** effect, and deliberately not keyed on
  // `nonce`: a change has to re-run the query, and only the query. Watching
  // from inside the effect the change re-runs means every notification tears
  // the views down and starts new ones — which is a loop as soon as anything
  // is delivered while a view is starting, and was one for as long as
  // `Start()` reported the range's existing contents as a change.
  //
  // The cost is one extra `listCalendars()` per range, not per refresh.
  useEffect(() => {
    if (!enabled || !watch || !bus) return undefined;

    let live = true;
    let stopWatching: (() => Promise<void>) | null = null;
    const desktop = new DesktopCalendar(bus);

    void (async () => {
      try {
        const all = await desktop.listCalendars();
        if (!live) return;
        stopWatching = await desktop.watch(
          new Date(fromMs),
          new Date(toMs),
          () => {
            // Re-query rather than patch: a recurrence master edited months
            // away changes what this range looks like.
            if (live) refresh();
          },
          { calendars: pickCalendars(all, onlyKey) },
        );
        if (!live) await stopWatching();
      } catch {
        // No bus, no EDS, nothing to watch. The query effect above is what
        // reports that to the caller; a second copy of it would only race.
      }
    })();

    return () => {
      live = false;
      void (async () => {
        if (stopWatching) await stopWatching();
        await desktop.dispose();
      })();
    };
  }, [bus, enabled, watch, fromMs, toMs, onlyKey, refresh]);

  const grouped = useMemo(() => byDay(events), [events]);

  return {
    events,
    byDay: grouped,
    calendars: found,
    errors,
    status,
    error,
    refresh,
  };
}

/** A subscription that only reports *when* something changed. */
export type { CalendarChange as DesktopCalendarChange };
