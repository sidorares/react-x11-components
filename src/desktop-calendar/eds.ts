// The user's desktop calendars, over D-Bus, through Evolution Data Server.
//
// EDS is the store every GNOME calendar UI reads from, and GNOME Online
// Accounts feeds Google/Microsoft/CalDAV into it — so anything the user
// connected in Settings shows up here with no OAuth work on our side, and no
// credentials ever touching this package.
//
// Two services are involved:
//   Sources5   — the registry: which calendars exist, their names and colours
//   Calendar8  — the store: open a calendar, query a time range, watch changes
//
// Recurring events come back as unexpanded masters, so occurrences are
// generated client-side with `ical.js` (an optional dependency — see
// `./ical.js`).
//
// **The connection is not ours.** It arrives from react-x11's shared bus, so
// the app's exported service, its tray, its menus and this all speak on one
// socket under one unique name. Dialling a second one would make the app look
// like two applications on the bus, and would leak a connection per mount.
import type { MessageBus } from 'react-x11';

import { loadIcal } from './ical.js';
import type { IcalComponent, IcalModule, IcalTime } from './ical.js';

const SOURCES_NAME = 'org.gnome.evolution.dataserver.Sources5';
const SOURCES_PATH = '/org/gnome/evolution/dataserver/SourceManager';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const FACTORY_NAME = 'org.gnome.evolution.dataserver.Calendar8';
const FACTORY_PATH = '/org/gnome/evolution/dataserver/CalendarFactory';
const FACTORY_IFACE = 'org.gnome.evolution.dataserver.CalendarFactory';
const CAL_IFACE = 'org.gnome.evolution.dataserver.Calendar';
const VIEW_IFACE = 'org.gnome.evolution.dataserver.CalendarView';

/**
 * `E_CAL_CLIENT_VIEW_FLAGS_NONE`. A view is created with
 * `NOTIFY_INITIAL` instead, which makes `Start()` replay everything already
 * matching the query as `ObjectsAdded` — the current contents, announced as
 * if they had just changed.
 *
 * That is the wrong signal for a watcher whose answer to a change is to run
 * the query again: the re-query tears the view down, starts a new one, and is
 * told the same thing again, for as long as the app is open. Flags of NONE is
 * the whole of "only tell me what changes from here".
 */
const VIEW_FLAGS_NONE = 0;

/** One calendar the desktop knows about. */
export interface DesktopCalendarInfo {
  uid: string;
  /** The name shown in the desktop's own calendar UI. */
  name: string;
  enabled: boolean;
  /** The colour that UI draws it in — worth carrying into a day marker. */
  color?: string;
  /** `caldav`, `google`, `local`, `webcal`… */
  backend?: string;
  readOnly: boolean;
  /** Set when the calendar came from an Online Accounts login. */
  account?: string;
}

/** One occurrence, already expanded out of any recurrence rule. */
export interface DesktopEvent {
  uid: string;
  summary: string;
  location?: string;
  description?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurring: boolean;
  calendar: { uid: string; name: string; color?: string };
}

/** A calendar that would not answer. One broken backend is not a failure. */
export interface DesktopCalendarError {
  calendar: DesktopCalendarInfo;
  message: string;
}

export interface EventsResult {
  events: DesktopEvent[];
  errors: DesktopCalendarError[];
}

/** What `watch` reports. Deliberately thin: re-query rather than patch. */
export interface CalendarChange {
  calendar: DesktopCalendarInfo;
  kind: 'ObjectsAdded' | 'ObjectsModified' | 'ObjectsRemoved';
  count: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `20260807T113000Z` — what the S-expression query wants. */
function icalStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** The query EDS understands for "anything happening between these two". */
function rangeQuery(from: Date, to: Date): string {
  return `(occur-in-time-range? (make-time "${icalStamp(from)}") (make-time "${icalStamp(to)}"))`;
}

/**
 * A source's whole configuration is an ini-style keyfile carried in one D-Bus
 * property, so it has to be parsed to find out whether a source is even a
 * calendar (as opposed to an address book, a mail account or a task list).
 */
export function parseKeyFile(
  text: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      out[section] = out[section] ?? {};
      continue;
    }
    if (!section) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key.includes('[')) continue; // a DisplayName[ru] translation
    out[section][key] = line.slice(eq + 1).trim();
  }
  return out;
}

/** `dbus-native`'s proxies are built by introspection, so they are `any`
 *  shaped. These name only what is called. */
interface CalendarIface {
  Open(): Promise<void>;
  GetObjectList(query: string): Promise<string[]>;
  GetTimezone(tzid: string): Promise<string>;
  GetView(query: string): Promise<string>;
}
interface ViewIface {
  $subscribe(signal: string, fn: (...args: unknown[]) => void): Promise<void>;
  SetFlags(flags: number): Promise<void>;
  Start(): Promise<void>;
  Stop(): Promise<void>;
  Dispose(): Promise<void>;
}

/**
 * The desktop's calendars, read over a bus someone else owns.
 *
 * ```ts
 * const ref = await sessionBus();
 * if (!ref) return;                       // no bus here; no calendars
 * const desktop = new DesktopCalendar(ref.bus);
 * const { events } = await desktop.eventsBetween(from, to);
 * ```
 *
 * Nothing here closes the connection, because nothing here opened it. Call
 * `dispose()` to drop the views this instance started, then release your own
 * reference to the bus.
 */
export class DesktopCalendar {
  #bus: MessageBus;
  #open = new Map<string, { cal: CalendarIface; busName: string }>();
  #views: ViewIface[] = [];
  #timezones = new Set<string>();

  constructor(bus: MessageBus) {
    this.#bus = bus;
  }

  /** Every calendar the desktop knows about, colour included. */
  async listCalendars(): Promise<DesktopCalendarInfo[]> {
    const om = (await this.#bus
      .getService(SOURCES_NAME)
      .getInterface(SOURCES_PATH, OBJECT_MANAGER)) as {
      GetManagedObjects(): Promise<
        Record<string, Record<string, Record<string, unknown>>>
      >;
    };
    const managed = await om.GetManagedObjects();

    const calendars: DesktopCalendarInfo[] = [];
    for (const interfaces of Object.values(managed)) {
      const src = interfaces['org.gnome.evolution.dataserver.Source'];
      if (!src) continue;
      const cfg = parseKeyFile(String(src.Data ?? ''));
      // no [Calendar] section means an address book, a task list or mail
      if (!cfg.Calendar) continue;
      const ds = cfg['Data Source'] ?? {};
      calendars.push({
        uid: String(src.UID ?? ''),
        name: ds.DisplayName ?? '',
        enabled: ds.Enabled !== 'false',
        color: cfg.Calendar.Color,
        backend: cfg.Calendar.BackendName,
        readOnly: !interfaces['org.gnome.evolution.dataserver.Source.Writable'],
        account: cfg['GNOME Online Accounts']?.Account,
      });
    }
    return calendars;
  }

  async #openCalendar(
    uid: string,
  ): Promise<{ cal: CalendarIface; busName: string }> {
    const existing = this.#open.get(uid);
    if (existing) return existing;

    const factory = (await this.#bus
      .getService(FACTORY_NAME)
      .getInterface(FACTORY_PATH, FACTORY_IFACE)) as {
      OpenCalendar(uid: string): Promise<[string, string]>;
    };
    const [path, busName] = await factory.OpenCalendar(uid);
    const cal = (await this.#bus
      .getService(busName)
      .getInterface(path, CAL_IFACE)) as CalendarIface;
    await cal.Open();

    const entry = { cal, busName };
    this.#open.set(uid, entry);
    return entry;
  }

  /**
   * Events reference timezones by id, but the payload rarely carries the
   * matching VTIMEZONE — so definitions are fetched on demand and registered
   * with ical.js. A backend that has none leaves the time floating, which is
   * ical.js's own fallback and better than refusing the event.
   */
  async #ensureTimezone(
    ICAL: IcalModule,
    cal: CalendarIface,
    tzid: string | undefined,
  ): Promise<void> {
    if (!tzid || this.#timezones.has(tzid) || ICAL.TimezoneService.has(tzid)) {
      return;
    }
    this.#timezones.add(tzid);
    try {
      const vtz = await cal.GetTimezone(tzid);
      const comp = new ICAL.Component(ICAL.parse(vtz));
      const sub =
        comp.name === 'vtimezone'
          ? comp
          : comp.getFirstSubcomponent('vtimezone');
      if (sub) ICAL.TimezoneService.register(tzid, new ICAL.Timezone(sub));
    } catch {
      /* no definition for it; ical.js falls back to floating time */
    }
  }

  /**
   * Expanded occurrences between two `Date`s, across the calendars given (or
   * every enabled one). Sorted by start.
   *
   * A backend that is offline or broken contributes an entry in `errors`
   * rather than throwing: one unreachable CalDAV server must not blank a
   * whole month of the user's own local calendar.
   */
  async eventsBetween(
    from: Date,
    to: Date,
    options: { calendars?: DesktopCalendarInfo[] } = {},
  ): Promise<EventsResult> {
    const ICAL = await loadIcal();
    const list =
      options.calendars ??
      (await this.listCalendars()).filter((c) => c.enabled);
    const query = rangeQuery(from, to);

    const perCalendar = await Promise.all(
      list.map(async (meta) => {
        try {
          const { cal } = await this.#openCalendar(meta.uid);
          const objects = await cal.GetObjectList(query);
          return {
            events: await this.#expand(ICAL, cal, objects, from, to, meta),
            error: null,
          };
        } catch (err) {
          return {
            events: [],
            error: {
              calendar: meta,
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }),
    );

    const events: DesktopEvent[] = [];
    const errors: DesktopCalendarError[] = [];
    for (const chunk of perCalendar) {
      events.push(...chunk.events);
      if (chunk.error) errors.push(chunk.error);
    }
    events.sort((a, b) => a.start.getTime() - b.start.getTime());
    return { events, errors };
  }

  async #expand(
    ICAL: IcalModule,
    cal: CalendarIface,
    objects: string[],
    from: Date,
    to: Date,
    meta: DesktopCalendarInfo,
  ): Promise<DesktopEvent[]> {
    const out: DesktopEvent[] = [];
    for (const ics of objects) {
      let comp: IcalComponent;
      try {
        comp = new ICAL.Component(ICAL.parse(ics));
      } catch {
        continue; // one unparseable object is not the range's problem
      }

      // Register any VTIMEZONE shipped inline, then any referenced by id.
      for (const vtz of comp.getAllSubcomponents('vtimezone')) {
        const tz = new ICAL.Timezone(vtz);
        if (!ICAL.TimezoneService.has(tz.tzid)) {
          ICAL.TimezoneService.register(tz.tzid, tz);
        }
      }

      const vevents =
        comp.name === 'vevent' ? [comp] : comp.getAllSubcomponents('vevent');
      for (const ve of vevents) {
        for (const prop of ['dtstart', 'dtend']) {
          const p = ve.getFirstProperty(prop);
          if (p) await this.#ensureTimezone(ICAL, cal, p.getParameter('tzid'));
        }
        const event = new ICAL.Event(ve);
        // folded in by the recurrence iterator below
        if (event.isRecurrenceException()) continue;

        const push = (startTime: IcalTime, endTime: IcalTime | null): void => {
          const start = startTime.toJSDate();
          const end = endTime ? endTime.toJSDate() : start;
          if (end < from || start >= to) return;
          out.push({
            uid: event.uid,
            summary: event.summary || '',
            location: event.location || undefined,
            description: event.description || undefined,
            start,
            end,
            allDay: event.startDate.isDate,
            recurring: event.isRecurring(),
            calendar: { uid: meta.uid, name: meta.name, color: meta.color },
          });
        };

        if (!event.isRecurring()) {
          push(event.startDate, event.endDate);
          continue;
        }

        const duration = event.duration;
        const it = event.iterator();
        let next: IcalTime | null;
        // A malformed RRULE with no UNTIL and a tiny interval can iterate
        // forever; the range check below normally ends it, and this is the
        // backstop for the case where it cannot.
        let guard = 0;
        while ((next = it.next()) && guard++ < 2000) {
          if (next.toJSDate() >= to) break;
          const end = next.clone();
          end.addDuration(duration);
          if (end.toJSDate() < from) continue;
          const details = event.getOccurrenceDetails(next);
          push(details.startDate, details.endDate);
        }
      }
    }
    return out;
  }

  /**
   * Live updates: `onChange` fires whenever anything in the range moves, so
   * the caller can re-query. Returns an unsubscribe function.
   *
   * Deliberately a "something changed" signal rather than a patch — a
   * recurrence master edited three months away can change what today looks
   * like, and re-running the query is both simpler and correct.
   *
   * **Changes only.** What is in the range already is what `eventsBetween`
   * answered; `onChange` fires for what happens after that. See
   * {@link VIEW_FLAGS_NONE} for the loop that reporting the initial contents
   * as a change costs a caller who re-queries on one.
   */
  async watch(
    from: Date,
    to: Date,
    onChange: (change: CalendarChange) => void,
    options: { calendars?: DesktopCalendarInfo[] } = {},
  ): Promise<() => Promise<void>> {
    const list =
      options.calendars ??
      (await this.listCalendars()).filter((c) => c.enabled);
    const query = rangeQuery(from, to);
    const started: ViewIface[] = [];

    for (const meta of list) {
      try {
        const { cal, busName } = await this.#openCalendar(meta.uid);
        const viewPath = await cal.GetView(query);
        const view = (await this.#bus
          .getService(busName)
          .getInterface(viewPath, VIEW_IFACE)) as ViewIface;

        // Belt to `VIEW_FLAGS_NONE`'s braces, for a backend that would not
        // take the flags: `Complete` closes the initial delivery, so anything
        // before it is the replay rather than a change. Only armed when
        // `SetFlags` failed — a view that never reports `Complete` would
        // otherwise be watched in silence, and losing live updates is the
        // worse half of the trade.
        let replaying = false;
        try {
          await view.SetFlags(VIEW_FLAGS_NONE);
        } catch {
          replaying = true;
        }
        await view.$subscribe('Complete', () => {
          replaying = false;
        });

        for (const signal of [
          'ObjectsAdded',
          'ObjectsModified',
          'ObjectsRemoved',
        ] as const) {
          await view.$subscribe(signal, (objects) => {
            if (replaying) return;
            onChange({
              calendar: meta,
              kind: signal,
              count: Array.isArray(objects) ? objects.length : 0,
            });
          });
        }
        await view.Start();
        started.push(view);
        this.#views.push(view);
      } catch {
        /* skip a calendar that will not open; the others still update */
      }
    }

    return async () => {
      for (const view of started) {
        this.#views = this.#views.filter((v) => v !== view);
        try {
          await view.Stop();
          await view.Dispose();
        } catch {
          /* already gone */
        }
      }
    };
  }

  /** Stop every view this instance started. Does **not** touch the bus. */
  async dispose(): Promise<void> {
    const views = this.#views;
    this.#views = [];
    for (const view of views) {
      try {
        await view.Stop();
        await view.Dispose();
      } catch {
        /* already gone */
      }
    }
    this.#open.clear();
  }
}
