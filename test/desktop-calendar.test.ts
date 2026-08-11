// Reading the desktop's calendars over D-Bus.
//
// `DesktopCalendar` takes its connection rather than opening one, which is the
// design (react-x11 owns the shared bus) and is also what makes this testable:
// a fake bus answers the two EDS services with canned payloads, and everything
// between the wire and a `dayContent` marker is exercised for real — the
// keyfile parse, the source filter, ical.js's recurrence expansion, the
// grouping by local day.
//
// `useDesktopCalendarEvents` itself is not mounted here. It reaches for
// react-x11's shared session bus, and a test that dials whatever bus happens
// to exist on the developer's machine would pass or fail on the environment
// rather than on this package.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  DesktopCalendar,
  byDay,
  parseKeyFile,
} from '../src/desktop-calendar/index.js';
import type {
  CalendarChange,
  DesktopEvent,
} from '../src/desktop-calendar/index.js';
import type { MessageBus } from 'react-x11';

// --- the keyfile a source carries its whole config in ----------------------

test('a source keyfile parses into sections', () => {
  const cfg = parseKeyFile(
    [
      '[Data Source]',
      'DisplayName=Work',
      'DisplayName[ru]=Работа',
      'Enabled=true',
      '',
      '# a comment',
      '[Calendar]',
      'BackendName=caldav',
      'Color=#3584e4',
    ].join('\n'),
  );

  assert.strictEqual(cfg['Data Source'].DisplayName, 'Work');
  assert.strictEqual(cfg.Calendar.Color, '#3584e4');
  assert.strictEqual(cfg.Calendar.BackendName, 'caldav');
  // a translated key is not the key
  assert.strictEqual(cfg['Data Source']['DisplayName[ru]'], undefined);
});

// --- grouping occurrences onto days ----------------------------------------

/** A minimal event, built in *local* time so the assertions below do not
 *  depend on the machine's timezone. */
function event(
  uid: string,
  start: Date,
  end: Date,
  allDay = false,
): DesktopEvent {
  return {
    uid,
    summary: uid,
    start,
    end,
    allDay,
    recurring: false,
    calendar: { uid: 'cal', name: 'Cal' },
  };
}

test('an event lands on the day it happens', () => {
  const days = byDay([
    event('standup', new Date(2026, 7, 7, 9, 0), new Date(2026, 7, 7, 9, 15)),
  ]);
  assert.deepStrictEqual([...days.keys()], ['2026-08-07']);
  assert.strictEqual(days.get('2026-08-07')?.length, 1);
});

test('a multi-day event lands on every day it touches', () => {
  // an all-day span is [start, end): the 10th, 11th and 12th — not the 13th
  const days = byDay([
    event('conf', new Date(2026, 7, 10), new Date(2026, 7, 13), true),
  ]);
  assert.deepStrictEqual(
    [...days.keys()].sort(),
    ['2026-08-10', '2026-08-11', '2026-08-12'],
    'the exclusive end does not mark a fourth day',
  );
});

test('an event crossing midnight lands on both days', () => {
  const days = byDay([
    event('party', new Date(2026, 7, 7, 22, 0), new Date(2026, 7, 8, 2, 0)),
  ]);
  assert.deepStrictEqual([...days.keys()].sort(), ['2026-08-07', '2026-08-08']);
});

test('several events on one day are kept in order', () => {
  const days = byDay([
    event('a', new Date(2026, 7, 7, 9, 0), new Date(2026, 7, 7, 10, 0)),
    event('b', new Date(2026, 7, 7, 11, 0), new Date(2026, 7, 7, 12, 0)),
  ]);
  assert.deepStrictEqual(
    days.get('2026-08-07')?.map((e) => e.uid),
    ['a', 'b'],
  );
});

// --- the wire --------------------------------------------------------------

const SOURCE_IFACE = 'org.gnome.evolution.dataserver.Source';
const WRITABLE = 'org.gnome.evolution.dataserver.Source.Writable';

function keyfile(name: string, color: string, backend = 'local'): string {
  return [
    '[Data Source]',
    `DisplayName=${name}`,
    'Enabled=true',
    '[Calendar]',
    `BackendName=${backend}`,
    `Color=${color}`,
  ].join('\n');
}

const ICS_ONE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:standup',
  'SUMMARY:Standup',
  'LOCATION:Kitchen',
  'DTSTART:20260807T090000Z',
  'DTEND:20260807T091500Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const ICS_WEEKLY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:sync',
  'SUMMARY:Weekly sync',
  'DTSTART:20260803T100000Z',
  'DTEND:20260803T110000Z',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

/** `E_CAL_CLIENT_VIEW_FLAGS_NOTIFY_INITIAL` — what EDS creates a view with,
 *  and why `Start()` announces the range's current contents. */
const NOTIFY_INITIAL = 1;

/** A view the fake bus handed out, so a test can make something change on it
 *  after the initial delivery is over. */
interface FakeView {
  flags: number;
  stopped: boolean;
  disposed: boolean;
  emit(signal: string, objects: string[]): void;
}

interface FakeOptions {
  /** uid -> the ICS objects that calendar answers with. */
  objects?: Record<string, string[]>;
  /** uids whose `OpenCalendar` throws, standing in for an offline backend. */
  broken?: string[];
  /** uids whose view refuses `SetFlags`, standing in for a backend that
   *  replays its contents whatever it is asked. */
  refusesFlags?: string[];
  /** Filled in with each view the bus hands out, keyed by calendar uid. */
  views?: Map<string, FakeView>;
}

/** A session bus that answers the two EDS services and nothing else. */
function fakeBus(options: FakeOptions = {}): MessageBus {
  const { objects = {}, broken = [], refusesFlags = [], views } = options;

  const managed = {
    '/org/gnome/evolution/dataserver/SourceManager/Sources/1': {
      [SOURCE_IFACE]: { UID: 'personal', Data: keyfile('Personal', '#3584e4') },
      [WRITABLE]: {},
    },
    '/org/gnome/evolution/dataserver/SourceManager/Sources/2': {
      [SOURCE_IFACE]: {
        UID: 'work',
        Data: keyfile('Work', '#e01b24', 'caldav'),
      },
      // no Writable interface: a subscribed calendar
    },
    '/org/gnome/evolution/dataserver/SourceManager/Sources/3': {
      // an address book — no [Calendar] section, so not a calendar
      [SOURCE_IFACE]: {
        UID: 'contacts',
        Data: ['[Data Source]', 'DisplayName=Contacts', '[Address Book]'].join(
          '\n',
        ),
      },
    },
  };

  const getInterface = async (
    path: string,
    iface: string,
  ): Promise<unknown> => {
    if (iface === 'org.freedesktop.DBus.ObjectManager') {
      return { GetManagedObjects: async () => managed };
    }
    if (iface === 'org.gnome.evolution.dataserver.CalendarFactory') {
      return {
        OpenCalendar: async (uid: string) => {
          if (broken.includes(uid)) throw new Error(`cannot open ${uid}`);
          return [`/org/gnome/evolution/dataserver/Calendar/${uid}`, ':1.99'];
        },
      };
    }
    if (iface === 'org.gnome.evolution.dataserver.Calendar') {
      const uid = path.split('/').pop() ?? '';
      return {
        Open: async () => {},
        GetObjectList: async () => objects[uid] ?? [],
        GetTimezone: async () => {
          throw new Error('no definition');
        },
        GetView: async () => `${path}/view`,
      };
    }
    if (iface === 'org.gnome.evolution.dataserver.CalendarView') {
      const uid = path.split('/').slice(-2)[0] ?? '';
      const handlers = new Map<string, ((objects: string[]) => void)[]>();
      const view: FakeView = {
        flags: NOTIFY_INITIAL,
        stopped: false,
        disposed: false,
        emit: (signal, objs) => {
          for (const fn of handlers.get(signal) ?? []) fn(objs);
        },
      };
      views?.set(uid, view);
      return {
        SetFlags: async (flags: number) => {
          if (refusesFlags.includes(uid)) throw new Error('SetFlags: no');
          view.flags = flags;
        },
        $subscribe: async (signal: string, fn: (objects: string[]) => void) => {
          handlers.set(signal, [...(handlers.get(signal) ?? []), fn]);
        },
        Start: async () => {
          // EDS replays what the query already matches, unless the flags said
          // not to — then `Complete` closes the delivery either way.
          const initial = objects[uid] ?? [];
          if (view.flags & NOTIFY_INITIAL && initial.length) {
            view.emit('ObjectsAdded', initial);
          }
          view.emit('Complete', []);
        },
        Stop: async () => {
          view.stopped = true;
        },
        Dispose: async () => {
          view.disposed = true;
        },
      };
    }
    throw new Error(`unexpected interface ${iface}`);
  };

  return {
    getService: (_name: string) => ({ getInterface }),
  } as unknown as MessageBus;
}

test('it lists the calendars and skips what is not one', async () => {
  const desktop = new DesktopCalendar(fakeBus());
  const calendars = await desktop.listCalendars();

  assert.deepStrictEqual(
    calendars.map((c) => c.name).sort(),
    ['Personal', 'Work'],
    'the address book is not a calendar',
  );

  const work = calendars.find((c) => c.uid === 'work');
  assert.strictEqual(work?.color, '#e01b24');
  assert.strictEqual(work?.backend, 'caldav');
  assert.strictEqual(work?.readOnly, true, 'no Writable interface');
  assert.strictEqual(work?.enabled, true);

  const personal = calendars.find((c) => c.uid === 'personal');
  assert.strictEqual(personal?.readOnly, false);
});

test('it reads events, and tags each with the calendar it came from', async () => {
  const desktop = new DesktopCalendar(
    fakeBus({ objects: { personal: [ICS_ONE] } }),
  );
  const { events, errors } = await desktop.eventsBetween(
    new Date(Date.UTC(2026, 7, 1)),
    new Date(Date.UTC(2026, 8, 1)),
  );

  assert.deepStrictEqual(errors, []);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].summary, 'Standup');
  assert.strictEqual(events[0].location, 'Kitchen');
  assert.strictEqual(events[0].allDay, false);
  assert.strictEqual(events[0].recurring, false);
  // the colour is what a day marker is drawn in
  assert.strictEqual(events[0].calendar.color, '#3584e4');
  assert.strictEqual(events[0].calendar.name, 'Personal');
});

test('a recurring event is expanded into its occurrences', async () => {
  const desktop = new DesktopCalendar(
    fakeBus({ objects: { personal: [ICS_WEEKLY] } }),
  );
  const { events } = await desktop.eventsBetween(
    new Date(Date.UTC(2026, 7, 1)),
    new Date(Date.UTC(2026, 8, 1)),
  );

  // COUNT=4 from 3 August, weekly: the 3rd, 10th, 17th and 24th
  assert.strictEqual(events.length, 4, 'the RRULE was expanded client-side');
  assert.ok(events.every((e) => e.recurring));
  assert.ok(events.every((e) => e.uid === 'sync'));
  assert.deepStrictEqual(
    events.map((e) => e.start.toISOString().slice(0, 10)),
    ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'],
  );
});

test('occurrences outside the window are not returned', async () => {
  const desktop = new DesktopCalendar(
    fakeBus({ objects: { personal: [ICS_WEEKLY] } }),
  );
  const { events } = await desktop.eventsBetween(
    new Date(Date.UTC(2026, 7, 9)),
    new Date(Date.UTC(2026, 7, 18)),
  );
  assert.deepStrictEqual(
    events.map((e) => e.start.toISOString().slice(0, 10)),
    ['2026-08-10', '2026-08-17'],
  );
});

test('events from every calendar come back sorted together', async () => {
  const desktop = new DesktopCalendar(
    fakeBus({ objects: { work: [ICS_ONE], personal: [ICS_WEEKLY] } }),
  );
  const { events } = await desktop.eventsBetween(
    new Date(Date.UTC(2026, 7, 1)),
    new Date(Date.UTC(2026, 8, 1)),
  );

  const times = events.map((e) => e.start.getTime());
  assert.deepStrictEqual(
    times,
    [...times].sort((a, b) => a - b),
    'sorted by start across calendars',
  );
  assert.ok(events.some((e) => e.calendar.name === 'Work'));
  assert.ok(events.some((e) => e.calendar.name === 'Personal'));
});

test('one broken backend does not sink the others', async () => {
  // the failure this is written against: an offline CalDAV server blanking a
  // whole month of the user's own local calendar
  const desktop = new DesktopCalendar(
    fakeBus({ objects: { personal: [ICS_ONE] }, broken: ['work'] }),
  );
  const { events, errors } = await desktop.eventsBetween(
    new Date(Date.UTC(2026, 7, 1)),
    new Date(Date.UTC(2026, 8, 1)),
  );

  assert.strictEqual(events.length, 1, 'the working calendar still loaded');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].calendar.uid, 'work');
  assert.match(errors[0].message, /cannot open work/);
});

test('the grouped result is keyed the way a calendar grid asks', async () => {
  const desktop = new DesktopCalendar(
    fakeBus({ objects: { personal: [ICS_WEEKLY] } }),
  );
  const { events } = await desktop.eventsBetween(
    new Date(Date.UTC(2026, 7, 1)),
    new Date(Date.UTC(2026, 8, 1)),
  );

  for (const key of byDay(events).keys()) {
    // exactly what `<Calendar dayContent>` is handed
    assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
  }
});

// --- watching for changes --------------------------------------------------
//
// The failure these are written against: `Start()` announces the range's
// current contents as `ObjectsAdded`, a caller whose answer to a change is to
// re-query does so, the re-query starts a new view, and that view says the
// same thing again — for as long as the app is open.

const AUGUST = [new Date(Date.UTC(2026, 7, 1)), new Date(Date.UTC(2026, 8, 1))];

test('watch does not report the contents the range already had', async () => {
  const views = new Map<string, FakeView>();
  const desktop = new DesktopCalendar(
    fakeBus({ objects: { personal: [ICS_ONE], work: [ICS_WEEKLY] }, views }),
  );

  const changes: CalendarChange[] = [];
  await desktop.watch(AUGUST[0], AUGUST[1], (c) => changes.push(c));

  assert.deepStrictEqual(changes, [], 'Start() replayed nothing at the caller');
  // and this is why: the view was told to notify changes only
  assert.strictEqual(views.get('personal')?.flags, 0);
  assert.strictEqual(views.get('work')?.flags, 0);
});

test('watch reports what changes after the initial delivery', async () => {
  const views = new Map<string, FakeView>();
  const desktop = new DesktopCalendar(
    fakeBus({ objects: { personal: [ICS_ONE] }, views }),
  );

  const changes: CalendarChange[] = [];
  await desktop.watch(AUGUST[0], AUGUST[1], (c) => changes.push(c));
  views.get('personal')?.emit('ObjectsModified', [ICS_ONE]);

  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].kind, 'ObjectsModified');
  assert.strictEqual(changes[0].count, 1);
  assert.strictEqual(changes[0].calendar.uid, 'personal');
});

test('a backend that refuses the flags still replays into silence', async () => {
  const views = new Map<string, FakeView>();
  const desktop = new DesktopCalendar(
    fakeBus({
      objects: { personal: [ICS_ONE] },
      refusesFlags: ['personal'],
      views,
    }),
  );

  const changes: CalendarChange[] = [];
  await desktop.watch(AUGUST[0], AUGUST[1], (c) => changes.push(c));

  assert.strictEqual(
    views.get('personal')?.flags,
    NOTIFY_INITIAL,
    'it replayed',
  );
  assert.deepStrictEqual(changes, [], 'and the replay was not a change');

  // `Complete` closed the delivery, so this one is
  views.get('personal')?.emit('ObjectsAdded', [ICS_ONE]);
  assert.strictEqual(changes.length, 1, 'a later change still gets through');
});

test('unsubscribing stops and disposes the views it started', async () => {
  // what the hook's subscription effect runs on cleanup — a month the user
  // paged away from must not leave a live view behind
  const views = new Map<string, FakeView>();
  const desktop = new DesktopCalendar(
    fakeBus({ objects: { personal: [ICS_ONE] }, views }),
  );
  const stop = await desktop.watch(AUGUST[0], AUGUST[1], () => {});
  await stop();

  assert.ok(views.get('personal')?.stopped, 'the view was stopped');
  assert.ok(views.get('personal')?.disposed, 'and disposed');
});
