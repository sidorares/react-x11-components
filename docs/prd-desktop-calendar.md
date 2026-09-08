# PRD: the user's calendar on macOS — EventKit, and where the desktop calendar lives

> **Status: milestones 1 and 2 are done.** The core half shipped in react-x11
> **2.9.1** (sidorares/react-x11#508, over #504) — the ladder, the EDS rung
> moved from here, the `osascript` rung, the cocoa rung, and the two
> permission kinds. This side is the same PR as this document: the module,
> its test, its page, the subpath and the `ical.js` optional dependency are
> gone, and the floor is `^2.9.1`. Milestones 3 to 5 (the bridge release,
> writes, the `source` seam) are open.
>
> The measurements in §2 and §3 were taken on 2026-09-08 against react-x11
> 2.9.0, `@windowkit/appkit` 0.7.0 and this package at 0.4.0, on one machine —
> macOS 15.2 (24C101), the Cocoa backend's home. **Two of §13's risks were
> retired by measuring them during implementation, and both changed the
> design** — see §14, which is the record of what the prompt actually did.

`useDesktopCalendarEvents` reads the calendars the desktop already has and
hands them to a `<Calendar dayContent>`. On a GNOME desktop that is the real
thing: Google, Microsoft, CalDAV and local calendars, through Evolution Data
Server over the session bus, with no credential ever reaching the app. On a
Mac it is nothing. There is no session bus on a stock Mac (§2), so the hook
answers `'unavailable'` and the grid renders without dots — correctly, and
uselessly, on the platform react-x11 now has a native backend for.

macOS has the exact counterpart of EDS plus GNOME Online Accounts: **EventKit**.
Every account the user added in System Settings › Internet Accounts — iCloud,
Google, Exchange, CalDAV, a subscribed feed — is one `EKEventStore`, and the
desktop did the OAuth. This document specifies the rung that reads it, the
rung beneath it that needs no native code at all, and — because the question
has to be answered before either is built — **where the whole feature lives**:
here, in react-x11, or on the bus. The answer is react-x11, and §4 is the
argument.

## 1. Summary

- **The feature moves to core.** `src/desktop-calendar/` — the EDS client,
  the `ical.js` loader and the hook — becomes react-x11's desktop-calendar
  ladder, the third instance of the shape notifications and permissions
  already have: a function API plus a hook, a rung per platform mechanism,
  chosen by what the connection the tree renders through can do, and a
  typed "nothing here" at the floor. `<Calendar>`, `<DatePicker>` and the
  `dayContent` seam stay here, and the `'YYYY-MM-DD'` key is the contract
  between the two packages.
- **"An extra API on the bus" is the right instinct and the wrong transport.**
  What every desktop feature in core does is hang a capability off the app
  the tree renders through — `app.permissions`, `app.notifications`,
  `app.filePanels` — and let the ladder find it. That is bus-shaped without
  being D-Bus, which does not exist on a Mac and is process identity where it
  does. §4 has both readings and why they collapse into one.
- **Two macOS rungs, one framework.** EventKit through `@windowkit/appkit` on
  the Cocoa backend, and EventKit through a long-lived `osascript -l
JavaScript` child everywhere else on a Mac — the X11 backend under XQuartz,
  a Cocoa app over a bridge that predates the verbs. The second needs nothing
  from anyone and ships first (§7.2, measured in §3). Both expand recurrences
  in the store, so neither needs `ical.js`; EDS still does.
- **Permission is part of the design, not a prerequisite.** `'calendars'`
  and `'reminders'` join core's `PermissionKind`; the calendar API asks on its
  first read; a refusal is `status: 'denied'` with `openSettings()`, distinct
  from `'unavailable'`. Attribution and the `Info.plist` keys are §8.
- **What unblocks it upstream:** windowkit/appkit#39 (the TCC kinds), #40
  (calendars, occurrences, the change event) and #41 (writes). Nothing in
  react-x11 blocks the move itself.

## 2. What exists, and what a Mac gets today

### The surface here

Two directories, and the seam between them is a string format.

| module                                | lines | what it is                                                                                                                                                                                                                                              |
| ------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/calendar/Calendar.ts`            |   744 | the month grid: single or range, blockable days, keyboard, a11y, `dayContent` under the number in a strip reserved only when the prop is given                                                                                                          |
| `src/calendar/DatePicker.ts`          |   368 | a field that opens the grid in a `<popup>`                                                                                                                                                                                                              |
| `src/calendar/dates.ts`               |   307 | the day arithmetic; a day is `'YYYY-MM-DD'`, never a `Date`                                                                                                                                                                                             |
| `src/desktop-calendar/eds.ts`         |   484 | the EDS client over a `MessageBus` it is handed: `Sources5` for the registry (a GLib keyfile per source, parsed to find the calendars among the address books), `Calendar8` to open one, an S-expression range query, a `View` per calendar for changes |
| `src/desktop-calendar/ical.ts`        |   119 | `ical.js` behind a dynamic `import()` that may fail, its types written out structurally so an app that skipped the optional dependency still type-checks                                                                                                |
| `src/desktop-calendar/index.ts`       |   287 | `useDesktopCalendarEvents`, `byDay`, the result shape                                                                                                                                                                                                   |
| `test/desktop-calendar.test.ts`       |   477 | the keyfile, the grouping, and the wire over a fake bus                                                                                                                                                                                                 |
| `docs/components/desktop-calendar.md` |   125 | the reference page                                                                                                                                                                                                                                      |
| `examples/calendar.tsx`               |   147 | the grid with the machine's real events dotted on                                                                                                                                                                                                       |

Nothing in `src/calendar/` knows about events. `dayContent` is handed a day
and a `CalendarDayState` — `selected`, `inRange`, `today`, `blocked`,
`outside`, `preview`, `focused`, and the `color` the number is drawn in so a
marker stays legible on a filled end — and returns whatever the app wants
under the number. Nothing in `src/desktop-calendar/` knows about the grid: it
groups occurrences by the local day they touch, keyed `'YYYY-MM-DD'`, and
`dayKeyOf` is a deliberate three-line copy rather than an import, because a
lateral import makes two components one bundle. **The format is the
contract, not a function**, and that is the property the move has to keep.

Three decisions in the EDS client are worth carrying across whole, because
each was paid for:

- **The connection is not ours.** `DesktopCalendar` takes its bus as a
  constructor argument; `useSessionBus()` hands over react-x11's shared one.
  A second connection is a second name on the bus and a leak per mount.
- **Watch reports changes, not contents.** A view started with
  `NOTIFY_INITIAL` replays the range as `ObjectsAdded`, and a watcher whose
  answer to a change is to re-query loops on that forever (0d81b8e →
  f18b8eb). Flags of `NONE`, and `Complete` as the belt for a backend that
  will not take the flags.
- **Re-query rather than patch.** A recurrence master edited three months
  away changes what today looks like. The change signal carries a kind and
  a count and nothing else, and the hook's answer is `refresh()`.

### What a Mac gets, measured

On this machine, with nothing installed beyond what the repository needs:

| probe                                                                                                  | answer                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DBUS_SESSION_BUS_ADDRESS`, `launchctl getenv DBUS_LAUNCHD_SESSION_BUS_SOCKET`                         | both unset — no session bus, so the EDS rung is `'unavailable'` before it asks anything                                                                   |
| `ls ~/Library/Calendars`                                                                               | `Operation not permitted` — Calendar.app's own store is behind the Calendars TCC grant even for the shell                                                 |
| `EKEventStore.authorizationStatusForEntityType(0)` through `osascript -l JavaScript`                   | `0`, `notDetermined`, **with no prompt** — the status can be read from an unbundled process before deciding to ask                                        |
| the same for reminders (`1`)                                                                           | `0`                                                                                                                                                       |
| `osascript -l JavaScript -e "ObjC.import('EventKit'); …"` wall time                                    | 80 ms, spawn included                                                                                                                                     |
| a JavaScript function passed where a block is expected; `ObjC.registerSubclass` with a selector method | both work — the completion handlers and the notification observer the rung needs are expressible                                                          |
| `icalBuddy`, `khal`, `vdirsyncer`                                                                      | not installed                                                                                                                                             |
| `ical.js` 2.2.1, the parser the EDS rung needs                                                         | 1.2 MB unpacked in 70 files; one 268 KB file loads (about 70 KB gzipped); no dependencies, no native code, no install script, no top-level await; MPL-2.0 |

The first row is the whole of today's macOS story. The third and the sixth are
what make §7.2 a rung rather than a wish.

## 3. Every way to reach the user's calendar

The survey, so that the next person does not redo it. "Credential" means
whether the app has to hold one; "expansion" is who turns an RRULE into
occurrences; "change" is how the app learns something moved.

### macOS

| rung                                                         | mechanism                                                                                                                            | credential | expansion | change                                       | write | attribution / grant                                                                                        | verdict                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- | --------- | -------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EventKit through the bridge**                              | `EKEventStore` in-process, `@windowkit/appkit` verbs (#40)                                                                           | none       | the store | `EKEventStoreChangedNotification`            | yes   | TCC `Calendars`; bare `node` → the responsible process; a bundle → `NSCalendarsFullAccessUsageDescription` | **the top rung** on the Cocoa backend                                                                                                                                                                |
| **EventKit through `osascript`**                             | a long-lived `osascript -l JavaScript` child with `ObjC.import('EventKit')`, JSON lines over its pipes — `appearance.js`'s own shape | none       | the store | the same notification, observed in the child | yes   | the same grant; the child is attributed to its responsible process                                         | **the rung beneath**: the X11 backend under XQuartz, or a Cocoa app on a bridge without the verbs. Needs nothing from anyone. Measured viable (§2).                                                  |
| Calendar.app by Apple Events (`tell application "Calendar"`) | AppleScript / JXA scripting of the app                                                                                               | none       | the app   | none — poll                                  | yes   | TCC `Automation` for Calendar.app, **and** the app launches                                                | rejected: launches Calendar.app, fetches properties one Apple Event at a time (minutes on a large calendar), and is the same framework one process further away. Not a crude floor, a worse product. |
| `icalBuddy` and friends                                      | a third-party CLI over EventKit                                                                                                      | none       | the store | none                                         | no    | its own                                                                                                    | rejected: a binary nobody has, for what the `osascript` rung does with one the OS ships                                                                                                              |
| `~/Library/Calendars/*.calendar`                             | read Calendar.app's cache                                                                                                            | none       | ours      | fs watch                                     | no    | the same TCC grant (§2), with no way to ask for it                                                         | rejected: private format, and it is behind the grant anyway                                                                                                                                          |
| CalDAV directly                                              | HTTP to the account's server                                                                                                         | **yes**    | ours      | poll / sync-token                            | yes   | none                                                                                                       | not a built-in rung — it is the credential the design exists to avoid. A `source` an app supplies (§7.4).                                                                                            |
| an `.ics` file or a `webcal:` feed                           | text the app already has                                                                                                             | none       | ours      | the app's                                    | no    | none                                                                                                       | a `source` too, and the reason `ical.js` stays: feeds, fixtures, tests (§7.4)                                                                                                                        |

### Linux

| rung                          | mechanism                                                  | verdict                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evolution Data Server**     | what exists: `Sources5` + `Calendar8` over the session bus | the rung; moves whole                                                                                                                                                 |
| Akonadi                       | KDE PIM's store, its own D-Bus and item protocol           | not planned: a second client of comparable size for one desktop, and KDE's own calendar can be told to use CalDAV sources EDS also sees. Recorded as a rung if wanted |
| `xdg-desktop-portal`          | —                                                          | there is **no calendar portal**; nothing to wait for                                                                                                                  |
| Thunderbird                   | no IPC                                                     | no                                                                                                                                                                    |
| a vdir (`khal`, `vdirsyncer`) | `.ics` files in a directory                                | the `source` seam covers it                                                                                                                                           |

### Elsewhere

Windows has `Windows.ApplicationModel.Appointments.AppointmentManager`, which
is the same shape as EventKit (a store, a range query, a change event, the OS
did the account). react-x11 has no Windows backend; the ladder is designed so
that one would add a rung, not an API.

### What the survey settles

- **Both macOS rungs are the same framework**, so they answer identically and
  one is the other's test oracle (§9). The difference is process and cost,
  not data.
- **No rung on a Mac needs `ical.js`**, and no rung on a Mac can avoid the
  TCC grant. The parser and the permission are both real, and they belong
  to different rungs.
- **Nothing here is a bus.** The freedesktop rung is D-Bus because EDS is;
  the macOS rungs are a framework in this process or in a child. The seam
  that spans them is not a transport.

## 4. Where it lives

AGENTS.md's governing rule: core when the vast majority of apps use it, when
it depends on internals, or when it needs enough standards compliance that
the behaviour is hard to agree on piecemeal; here when a smaller fraction
needs it, it stands on public API, and it is big enough that core would pay
for it. The calendar failed the first clause when it was written here, and
that was right. Two things have changed.

### The precedent is settled, and it is unanimous

Every integration an app does outside its own windows was decided in the
same direction, on the same argument, in the same month:

| feature                | the decision               | the freedesktop half            | the macOS half                        |
| ---------------------- | -------------------------- | ------------------------------- | ------------------------------------- |
| notifications          | core, react-x11#353 → #469 | `org.freedesktop.Notifications` | `UNUserNotificationCenter`, appkit#26 |
| permissions            | core, react-x11#466        | the device portals (pending)    | TCC, appkit#19                        |
| the tray               | core, react-x11#463        | StatusNotifierItem (pending)    | `NSStatusItem`, appkit#17             |
| file dialogs           | core, react-x11#461        | the FileChooser portal          | `NSOpenPanel`, appkit#14              |
| badge, Dock, attention | core, react-x11#464        | `LauncherEntry`                 | `NSDockTile`, appkit#15               |
| deep links             | core, react-x11#465        | `org.freedesktop.Application`   | Apple Events, appkit#18               |

`@react-x11/desktop`, the sibling package react-x11#129 and #163 planned for
exactly this kind of service, was never published (`npm view` answers 404),
and #353 — the issue that asked the core-or-sibling question in writing —
was answered by building notifications in core. The clause that carried
every row is the third: a published protocol with many daemons, or a
framework with one owner, where three wrappers would decide the same five
things three ways. A calendar is that clause too: exclusive ends, all-day
semantics, floating times, what a change signal carries, when to ask for the
grant.

### The macOS rung cannot be built out here

The second clause is the one that bites. On Linux the calendar stands on
public API — `useSessionBus()` is public and D-Bus is a wire. On the Cocoa
backend the only way to EventKit is `@windowkit/appkit`, which react-x11
reaches through `CocoaApp._native`, and core's Cocoa modules are
**deliberately off the exports map** (AGENTS.md, "core's cocoa modules are
not on its exports map … fine for investigation, not for a committed test").
For this package to add the rung, core would have to export one of two
things:

- **the raw bridge** — every mechanism verb the addon has, as public API.
  That is the addon's whole surface becoming react-x11's contract, for one
  consumer; or
- **a typed calendar capability** — `app.calendars` with `list`, `between`,
  `watch`. That _is_ the feature. Once core carries the store, the
  vocabulary and the change event, what is left here is a hook over it, and
  the design would be split across two packages with the policy in the wrong
  one.

Either way the decision lands in core. Better to land it there on purpose,
with the EDS rung beside it, than to leave the Linux half here and grow the
macOS half there.

### The bus is not the seam

The instinct behind "an extra API on the bus" is right: a consumer should not
name a backend, it should ask the connection it renders through. There are
two readings, and both resolve the same way.

- **Literally D-Bus** — the Cocoa backend serves EDS's interfaces on a bus so
  the client here works unchanged. There is no bus on a Mac (§2), and where
  there is one it is process identity, which `docs/dbus.md` spends a page
  protecting; a service the app exports to itself is a lie every other
  consumer of that connection would have to know about.
- **Bus-shaped** — a capability on the app, found by feature-detection. This
  is what core does for every row of the table above: `CocoaApp.permissions`
  is present exactly when the bridge has the verbs, `permissionBackend()`
  answers `'cocoa'` when it is, and the freedesktop rung is found by
  `hasService()` on the real bus. `CocoaApp.calendars` takes the same seat.

So the answer to "here, react-x11, or the bus" is react-x11, as a
capability-shaped ladder, and the bus stays what it is: the transport of one
rung.

### What moves, what stays

| today, here                                                                                                                   | proposed                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/desktop-calendar/eds.ts`                                                                                                 | react-x11 `src/desktopcalendar.js` — the ladder and the EDS rung; the JXA program of §7.2 beside it                                                                                                                                  |
| `src/desktop-calendar/ical.ts`                                                                                                | react-x11, shrunk: `ical.js` becomes a **regular** dependency of core (§12, Q3), so the loader is one lazy `import('ical.js')` with a static specifier and the structural types go — core imports the declarations the package ships |
| `src/desktop-calendar/index.ts` (the hook, `byDay`)                                                                           | react-x11 `src/desktopcalendarhooks.js`; `byDay` stays on the result, its key documented as `<Calendar>`'s vocabulary                                                                                                                |
| —                                                                                                                             | react-x11 `src/cocoa/calendar.js`, `src/types/desktopcalendar.d.ts`, `docs/desktop-calendar.md`                                                                                                                                      |
| `test/desktop-calendar.test.ts`                                                                                               | react-x11, over its own fake bus (dbus-native's `createBroker`, which #129 inventories) and a recording fake bridge                                                                                                                  |
| `docs/components/desktop-calendar.md`, the README section, the `/desktop-calendar` subpath, the `ical.js` optional dependency | **deleted here.** Pre-release, no users, no alias: the rule in core's AGENTS.md, and this package is 0.4.0                                                                                                                           |
| `src/calendar/`, `dayContent`, `CalendarDayState`                                                                             | **stay.** The grid is composition over public elements and a small fraction of apps want it — every clause points here                                                                                                               |
| `examples/calendar.tsx`                                                                                                       | stays, importing the hook from `react-x11`; it is the only place the two halves meet on screen                                                                                                                                       |

The `'YYYY-MM-DD'` local-day key is the one thing both packages have to agree
on, and it is a format rather than a function on both sides today. The move
does not change that; `docs/components/calendar.md`'s `dayContent` section
keeps pointing at core's `byDay`.

## 5. Goals and non-goals

### Goals

- **P0 — a Mac gets its calendar**, on both backends, from the accounts the
  user already added, with no credential and no OAuth in the app. Measured
  by `examples/calendar.tsx` showing this machine's events under XQuartz and
  under the Cocoa backend.
- **P0 — one API, one result shape, on every platform**, and `'unavailable'`
  stays an ordinary answer rather than an error.
- **P0 — the grant is asked for once, honestly.** Status readable without a
  prompt; the prompt raised on the first read; a refusal distinguishable from
  an absence; a way to the Settings pane.
- **P1 — the bridge-free rung ships first.** Nothing on the macOS path waits
  for `@windowkit/appkit`; the bridge upgrades the rung and deletes nothing —
  the path the appearance ladder took.
- **P1 — change notification on every rung that has one**, delivered as the
  same "something moved, re-query" the EDS rung already speaks.
- **P2 — writes**, with the recurring-event span, where the rung can.
- **P2 — a `source` seam** for a calendar the desktop does not have: an
  `.ics` the app read, a CalDAV account the app holds.

### Non-goals

- **Reminders and contacts.** Same store, same shape, separate grants;
  nothing here precludes them and nothing here builds them.
- **A calendar UI beyond the grid.** Week and day views, an agenda, an editor
  are components, and the day this package wants one it composes it over the
  same hook.
- **Free/busy, invitations, attendee replies.** EventKit exposes some of it
  and EDS most of it; neither rung's vocabulary carries it in the first cut,
  and the result shape has room.
- **Syncing anything.** The desktop syncs; this reads what it synced.

## 6. Public API

In react-x11, alongside `notify()` and `usePermission()`. The names are the
ones in use today wherever they were already right, so the move is an import
change for the example and the docs.

### 6.1 The vocabulary

```ts
type CalendarBackend = 'cocoa' | 'osascript' | 'eds' | null;

interface DesktopCalendarInfo {
  uid: string;
  /** As the desktop's own calendar UI shows it. */
  name: string;
  enabled: boolean;
  /** A CSS colour, for a day marker. */
  color?: string;
  /** EDS: `local`, `caldav`, `google`, `webcal`… EventKit: `local`, `caldav`,
   *  `exchange`, `subscribed`, `birthdays`. */
  backend?: string;
  readOnly: boolean;
  /** The account it came from — GNOME Online Accounts' id, or the EventKit
   *  source's title (`iCloud`, `Google`, `Exchange`). */
  account?: string;
}

interface DesktopEvent {
  uid: string;
  summary: string;
  location?: string;
  description?: string;
  url?: string;
  /** `[start, end)` — the end is exclusive on every rung. */
  start: Date;
  end: Date;
  allDay: boolean;
  recurring: boolean;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  calendar: { uid: string; name: string; color?: string };
}

interface DesktopCalendarError {
  calendar: DesktopCalendarInfo;
  message: string;
}
interface EventsResult {
  events: DesktopEvent[];
  errors: DesktopCalendarError[];
}
interface CalendarChange {
  calendar: DesktopCalendarInfo | null;
  kind: 'added' | 'modified' | 'removed' | 'changed';
  count?: number;
}
```

Two changes from today's types, both forced by the second rung. `end` is
**exclusive by contract** rather than by EDS's habit: EventKit reports an
all-day event as ending at the last second of its last day, and the Cocoa
half normalises before anything downstream sees it, because `byDay`'s
"exclusive end does not mark a fourth day" is a rule about the vocabulary,
not about one store. And `CalendarChange` gains `'changed'` with a null
calendar: `EKEventStoreChangedNotification` says nothing about which
calendar or how many, and a rung must not invent a count to fit a shape.

### 6.2 The handle

```ts
import { desktopCalendar, calendarBackend, NoCalendarServiceError } from 'react-x11';

const cal = await desktopCalendar();          // DesktopCalendar | null — never rejects
const cal = await desktopCalendar({ required: true }); // rejects with NoCalendarServiceError, carrying why

await cal.listCalendars();                                    // DesktopCalendarInfo[]
await cal.eventsBetween(from, to, { calendars? });            // EventsResult
const stop = await cal.watch(from, to, onChange, { calendars? }); // () => Promise<void>
await cal.dispose();                                          // views, the child's observer — never the bus

await calendarBackend();                      // 'cocoa' | 'osascript' | 'eds' | null, without reading anything
```

The `sessionBus()` pair's shape: `null` for plumbing that feature-probes,
`required` for an app whose purpose is the calendar. `calendarBackend()` is
asynchronous because the EDS rung's answer is a bus round trip, the way
`notificationBackend()` is and `permissionBackend()` is not. Options take
`app` for a process with several connections and `backend` to pin a rung —
for an A/B run, never as the way a rung is normally chosen.

### 6.3 The hook

```ts
const {
  events, byDay, calendars, errors,
  status,        // 'idle' | 'loading' | 'ready' | 'denied' | 'unavailable'
  error,         // why 'unavailable': no rung, or no grant to ask for
  backend,       // the rung that answered, or null
  refresh,       // re-query now
  openSettings,  // the Calendars pane, on a Mac; resolves false elsewhere
} = useDesktopCalendarEvents({ from, to, calendars?, watch?, enabled? });
```

Today's shape plus `'denied'`, `backend` and `openSettings`. **The hook asks
for the grant on its first read** — the notification centre's rule, "the
first post asks" — and `enabled: false` is how an app defers that to a
button. `'denied'` is the user's answer and `'unavailable'` is the machine's;
an app that shows an "Allow" button on `'unavailable'` has the bug
`docs/permissions.md` warns about, so the two are separate words. `from` and
`to` keep being read by timestamp, not identity.

### 6.4 The permission

```ts
type PermissionKind = … | 'calendars' | 'reminders';
usePermission('calendars');            // status, request, openSettings — the existing hook
openPrivacySettings('calendars');      // Privacy_Calendars, on any Mac
```

The calendar API asks through this; an app can ask ahead of it. On macOS 14+
a `write-only` grant exists (`EKAuthorizationStatusWriteOnly`); the bridge
reports it as its own word (#39) and core maps it to `'granted'` for a write
and `'denied'` for a read, which is the reason a request carries
`{ access: 'full' | 'write-only' }` on this kind only.

### 6.5 How a rung is chosen

Never by naming a backend. In order:

1. the app the tree renders through carries `calendars` — the Cocoa backend
   over a bridge with #40's verbs → `'cocoa'`;
2. `process.platform === 'darwin'` and `osascript` on the path — the X11
   backend under XQuartz, or the Cocoa backend over an older bridge →
   `'osascript'`;
3. a session bus, and `hasService('org.gnome.evolution.dataserver.Sources5')`
   — activation-aware, because EDS is D-Bus-activatable and `NameHasOwner`
   alone says no on a healthy GNOME that has not opened a calendar yet (the
   lesson of react-x11#129) → `'eds'`;
4. nothing → `null`; the hook says `'unavailable'`, the handle is `null`, and
   `required` rejects with `NoCalendarServiceError`.

Where a consumer runs and what answers:

| where                                              | rung                                          |
| -------------------------------------------------- | --------------------------------------------- |
| macOS, the Cocoa backend, bridge ≥ the #40 release | `cocoa`                                       |
| macOS, the Cocoa backend, an older bridge          | `osascript`                                   |
| macOS + XQuartz                                    | `osascript`                                   |
| GNOME, or any desktop running EDS                  | `eds`                                         |
| KDE without EDS                                    | `null` (Akonadi is a rung nobody has written) |
| ssh, `startx`, a container, CI                     | `null`                                        |

## 7. Design, per rung

### 7.1 EventKit through the bridge (`'cocoa'`)

`src/cocoa/calendar.js`, and `CocoaApp.calendars` set in the constructor
exactly when `native.calendars` and `native.eventsBetween` are functions —
the `permissions`/`notifications` rule, so a fake bridge without the verbs
leaves the ladder as it was.

- **Listing** is `native.calendars(cb)`, translated: the bridge's sRGB
  `[r, g, b, a]` becomes a CSS colour, `immutable || !allowsModifications`
  becomes `readOnly`, the source's title becomes `account`, the calendar
  type becomes `backend`.
- **Reading** is `native.eventsBetween({ start, end, calendars }, cb)` in
  chunks of at most four years, because the predicate is capped there and the
  bridge refuses a longer one rather than truncating. The bridge runs the
  fetch on a background queue and answers through a thread-safe function, so
  a slow year across a dozen calendars costs the JS thread nothing.
- **All-day ends are normalised here**, not in the bridge: `end = local
midnight after the last day`, so `byDay` sees the same `[start, end)` it
  sees from EDS. The bridge's own test pins EventKit's convention (#40), so
  this translation has a fixed point.
- **Change** is the `calendar-store-changed` backend event, routed in
  `CocoaApp._route` the way `notification-action` is, to every live `watch`
  as `{ calendar: null, kind: 'changed' }`. No filtering by range: the store
  does not say what moved, and the hook's answer is `refresh()` either way.
- **The grant** is asked for through `app.permissions` — `'calendars'` — on
  the first `listCalendars()` or `eventsBetween()` whose status is
  `'prompt'`; a `'denied'` or `'restricted'` status makes the handle reject
  with a typed `CalendarAccessDeniedError` carrying the status, which the hook
  turns into `status: 'denied'`. The re-read after a refused request — "a
  refusal is an answer; a prompt nobody saw is not" — is `CocoaPermissions`'
  already.

No `ical.js` on this rung. Occurrences arrive expanded, detached instances
included.

### 7.2 EventKit through `osascript` (`'osascript'`)

The same framework, one process away, on the shape `appearance.js` already
runs: `spawn('osascript', ['-l', 'JavaScript', '-e', PROGRAM])` once, kept
alive, JSON lines in both directions, respawned on exit but not on a failed
spawn.

The program, in outline:

```js
ObjC.import('EventKit');
ObjC.import('Foundation');
const store = $.EKEventStore.alloc.init; // creating a store never prompts
ObjC.registerSubclass({
  name: 'Observer',
  methods: {
    'changed:': {
      types: ['void', ['id']],
      implementation: () => emit({ type: 'changed' }),
    },
  },
});
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(
  $.Observer.alloc.init,
  'changed:',
  'EKEventStoreChangedNotification',
  store,
);
// per request line: status | request(access) | calendars | between(start, end, calendars)
// requestFullAccessToEventsWithCompletion: takes a JS function as its block (measured)
// eventsMatchingPredicate: is synchronous — fine, this is not the UI's thread
```

Each answer is `NSJSONSerialization` output over stdout, one line per
request id, the same plain shapes the bridge hands back (#40's), so
`src/desktopcalendar.js` has one translation for both macOS rungs and the
Cocoa half is only "which transport carried it".

What it costs and cannot do, honestly:

- **80 ms to start** (§2), paid once per process and never on the first
  frame — the child is spawned on the first read, not at `createRoot()`,
  under the same "not blocking the first frame on the bus" rule
  `docs/desktop.md` has for the bus address.
- **A second process holding the grant.** TCC attributes `osascript` to its
  responsible process, which is the terminal for a bare `node` and the bundle
  for a bundled app — the same attribution the bridge gets. This is asserted
  from the rule, not measured (§13); it is the first thing the adopting
  branch verifies on a real prompt.
- **No Notification-Center-style bundle question.** The centre needs a bundle
  identity; TCC does not. The `osascript` rung here is not the crude floor
  the notification one is — it answers everything the bridge answers.

And what it buys: **the macOS integration ships before the bridge does**, and
the bridge, when it lands, is a faster transport for the same answers, which
is the strongest possible test of the bridge (§9).

### 7.3 EDS over the session bus (`'eds'`)

`eds.ts` moves with its three decisions (§2). The bus comes from
`sessionBus()` inside core rather than from a hook argument, which is the
one simplification the move affords: the rung is module code that can run
with no root mounted, the way `notify()` can. `ical.js` moves with it as a
**regular** dependency of core — §12's Q3, decided on the numbers there:
dependency-free, pure JavaScript, 268 KB loaded — behind one lazy
`import('ical.js')` with a static specifier, so it stays off the startup
path while a bundler or the single-executable build still includes it.
`IcalUnavailableError` and the structural types of `ical.ts` go with the
optionality that justified them; core imports the declarations the package
ships. The rule for a dependency that cannot be assumed — `dbus-native`,
`@windowkit/appkit` — stays what it is; this one can be.

### 7.4 The `source` seam (P2)

```ts
interface CalendarSource {
  listCalendars(): Promise<DesktopCalendarInfo[]>;
  eventsBetween(from: Date, to: Date, options?): Promise<EventsResult>;
  watch?(from: Date, to: Date, onChange: (c: CalendarChange) => void, options?): Promise<() => Promise<void>>;
}
desktopCalendar({ source });                 // the handle over it, no ladder
useDesktopCalendarEvents({ from, to, source });
icsSource(text: string): CalendarSource;     // built in: a file, a feed, a fixture
```

`ProcessHost` and `PtyHost` are public because "run it over there" is a real
thing to want, and this is the same argument: a CalDAV account the app holds,
a `webcal:` feed it fetched under its own policy, a vdir on disk. The
built-in `icsSource` is `ical.js` over text the app already has — nothing is
fetched, which is the `<Html onResource>` rule — and it is also the way a
test or an example runs with no desktop at all.

### 7.5 Writes (P2)

```ts
await cal.createEvent({ calendar, summary, start, end, allDay?, location?, description?, url?, recurrence? });
await cal.updateEvent(uid, patch, { span: 'this' | 'future' });
await cal.removeEvent(uid, { span });
```

The Cocoa rung over #41, the `osascript` rung over the same calls in the
child, EDS over `CreateObjects`/`ModifyObjects`/`RemoveObjects` with
`E_CAL_OBJ_MOD_THIS`/`_THIS_AND_FUTURE`. The recurrence shape is the
`EKRecurrenceRule` subset #41 names, which is also expressible as an RRULE
for EDS; a consumer holding iCalendar text parses it with `ical.js` on its
own side. Deliberately after reading ships: every question about writes —
read-only calendars, the write-only grant, what a subscribed calendar
refuses — is answered by data reading already produced.

## 8. Packaging and attribution

The rules `docs/permissions.md` and `docs/packaging.md` already state, with
the calendar's keys filled in:

| how the app runs               | who the prompt names                           | what has to be in place                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bare `node`, either backend    | the responsible process — the terminal, an IDE | nothing; the prompt carries no usage string                                                                                                                                                                            |
| a bundle (`docs/packaging.md`) | the app                                        | `NSCalendarsFullAccessUsageDescription` (14+; `NSCalendarsUsageDescription` before), `NSCalendarsWriteOnlyAccessUsageDescription` if it only writes, `NSRemindersFullAccessUsageDescription` if it ever asks for those |
| a sandboxed bundle             | the app                                        | the above, plus the `com.apple.security.personal-information.calendars` entitlement                                                                                                                                    |

A bundle without the key **never prompts** and the status stays
`notDetermined`, which the ladder reports as `'unavailable'` with a cause,
not as a refusal — the same care the notification rung takes with an
unregistered bundle. The status read itself needs no key and no prompt (§2),
so a consumer can always tell which of the three it is in.

## 9. Testing

- **The Cocoa rung over a recording fake bridge**, the `test/permissions.test.js`
  shape: what reached `native.calendars`/`eventsBetween`, the chunking at
  four years, the all-day normalisation against the convention #40's test
  pins, a `calendar-store-changed` reaching a `watch`, the grant asked once
  and the three answers.
- **The `osascript` rung over a fake child**: the spawn goes through one
  seam (`REACT_X11_OSASCRIPT`, or an option on the handle) so a node script
  speaking the same JSON lines stands in for `osascript` on CI. The real
  program runs behind `REACT_X11_REAL_CALENDAR=1` on a Mac — opt-in, because
  it prompts — the way the real pty does here.
- **EDS over a fake bus**: today's 477 lines move, over dbus-native's
  in-process broker where core has one.
- **The two macOS rungs agree.** A script, not a CI job: on a machine with
  the bridge, `eventsBetween` through both, same range, `deepStrictEqual`
  after sorting. The bridge's first bug will be a field the child got right.
- **Here**: `<Calendar dayContent>` tests are untouched; the example is the
  integration test, run by hand under XQuartz and the Cocoa backend.

## 10. Milestones

1. **Core: the move, and the bridge-free Mac. — done, react-x11 2.9.1.**
   `src/desktopcalendar.js` (ladder, EDS, the JXA program), the hook, the
   types, `ical.js` as a regular dependency, `'calendars'`/`'reminders'` in
   `PermissionKind` with the panes, and `docs/desktop-calendar.md`. Linux
   behaviour unchanged; every Mac gets the `osascript` rung. It also took the
   cocoa rung, which this document had put in milestone 3 — the bridge verbs
   landed in `@windowkit/appkit` 0.8 sooner than the plan assumed.
2. **Here: the deletion. — done, this PR.** `src/desktop-calendar/`, its
   test, its page, the README section, the subpath, the optional dependency;
   the example and `docs/components/calendar.md` re-pointed; the floor at
   `^2.9.1`. "Delete the copy, import the export."
3. **The bridge release.** `@windowkit/appkit` 0.8 carries #39 and #40, and
   core's `src/cocoa/calendar.js` uses them; what is left is the release of
   this package that requires it, and the agreement script of §9 run on a
   machine with both rungs.
4. **Writes: #41**, the EDS write calls, `createEvent`/`updateEvent`/
   `removeEvent`.
5. **The `source` seam and `icsSource`.**

## 11. Upstream

Filed on windowkit/appkit, in the bridge's own ticket shape — the mechanism,
the framework calls, the threading, what crosses to JS, and the consumer:

- **#39 — Privacy authorizations: `calendars` and `reminders` kinds.**
  `EKEventStore.authorizationStatusForEntityType:`, the 14+ request calls
  with the pre-14 fallback, `'writeOnly'` as a word of its own, the Settings
  panes, `-framework EventKit`, one store per process.
- **#40 — EventKit: the calendars, the occurrences in a range, the change
  event.** `calendars(cb)`, `eventsBetween({ start, end, calendars }, cb)`
  off the main thread, the four-year cap as a `TypeError`, all-day dates as
  the store reports them, `calendar-store-changed` held and replayed before a
  listener.
- **#41 — EventKit: writing.** `saveEvent`/`removeEvent` with the span,
  `defaultCalendar`, `EKError` codes crossing as errors, the recurrence
  subset.

**Filed on react-x11:** #504 — the consumer issue that pairs with the
three bridge tickets, the way react-x11#469 pairs with appkit#26. Its body is
§1, §4 and §6 of this document, the dependency decision of §12 Q3, the
milestones, and the bridge links.

## 12. Open questions (decision needed, defaults proposed)

- **Q1 — ask on first read, or expose `request()`?** Default: ask on the
  first read, `enabled: false` to defer. A date picker opening is the user
  asking to see their days. A `request()` on the result is cheap to add if
  an app wants the button first.
- **Q2 — where does `byDay` live?** Default: on the hook's result in core,
  keyed by local `'YYYY-MM-DD'`, documented as the format `<Calendar
dayContent>` is handed. The alternative — a helper here over `events` —
  makes every app write the grouping and the exclusive-end rule again.
- **Q3 — `ical.js` in core, or `icsSource` here? Decided 2026-09-08: in
  core, as a regular dependency.** Measured: 2.2.1 is 1.2 MB unpacked in 70
  files, of which one 268 KB file (about 70 KB gzipped) is what loads; no
  dependencies of any kind, no native code, no install script, no top-level
  await; MPL-2.0, which is file-level copyleft and changes nothing for the
  files around it. Regular rather than optional because a dependency-free
  268 KB does not earn a missing-module state, and a lazy import with a
  static specifier keeps it off the startup path while a bundler or the
  single-executable build can still include it — where the runtime-built
  specifier an optional dependency needs cannot be. The cost is 1.2 MB on
  disk for installs that never run the EDS rung, accepted.
- **Q4 — an `osascript` rung for the permission ladder itself?** The child
  can answer `authorizationStatus` and raise the prompt, which would give
  `usePermission('calendars')` an answer under XQuartz where every other
  kind says `'unknown'`. Default: no — the calendar rung asks for its own
  grant, and a kind that answers on one backend's shell-out rung and not on
  the others is a vocabulary surprise. Revisit if a second kind wants it.
- **Q5 — Reminders?** Default: the permission kind lands with #39 because it
  is a switch case; the store verbs do not. A `useDesktopReminders` is a
  follow-up with its own PRD paragraph.
- **Q6 — the hook's name.** `useDesktopCalendarEvents` is kept. It says
  desktop, which is the point, and it does not collide with the grid.

## 13. Risks

- **The prompt from a bare process is asserted, not measured.** The status
  read without a prompt is measured (§2); the prompt itself was deliberately
  not raised while writing this, because it is a system dialog and a
  persistent TCC grant. The adopting branch raises it once, on both rungs,
  and records who it named and whether a bundle without the key stays
  `notDetermined`.
- **Fetch cost is unmeasured.** `eventsMatchingPredicate:` over a year and a
  dozen calendars may be tens or hundreds of milliseconds. The design does
  not depend on the number — both macOS rungs answer off the JS thread, and
  the hook already keys on timestamps so a re-render costs nothing — but a
  number belongs in `docs/desktop-calendar.md` and this is where it is
  missing.
- **The four-year cap** is a bridge `TypeError` and a core chunk; an app
  asking for a decade pays the fetches. Acceptable; documented.
- **Deleting a subpath here.** Pre-release and unpublicised, but a subpath
  that vanishes between 0.4 and 0.5 is a breaking change in the changelog's
  sense and gets the `!` and the footer.
- **JXA's bridge has edges.** Blocks and subclasses work (§2); `ObjC.unwrap`
  of nested structures does not, which is why the child serialises with
  `NSJSONSerialization` and hands over strings. A macOS release that changes
  the JXA bridge changes the rung; the bridge rung above it is the answer.
- **The all-day convention** is the one place two rungs could disagree
  silently. The bridge's test pins the store's; core's test pins the
  normalisation; §9's agreement script catches the rest.

## 14. What implementing it changed

Two of §13's risks were live questions rather than caveats, and measuring
them during the core implementation (sidorares/react-x11#508) changed the
design. Both are recorded here because this document asserted the opposite.

**The `osascript` rung's request never calls back.**
`requestFullAccessToEventsWithCompletion:` from an `osascript` process is
never called back — not on a refusal, and not even when the grant is already
held; retaining the block does not help. §7.2 assumed the completion arrived,
so the rung as designed would have hung on its first read forever. It answers
from the **status**, polled, with a 30-second deadline for the case where TCC
declines to ask at all. That deadline's `'prompt'` is the machine's silence
rather than a refusal, so the hook reports `'unavailable'` and nothing
remembers it.

**The attribution is three processes, not one.** §7.2 said the child is
attributed to its responsible process, "the same attribution the bridge
gets". `tccd` in fact records three roles — `responsible` (the app that owns
the tree: a terminal, an IDE), `accessing` (`osascript`) and `requesting`
(`calaccessd`) — and keys the decision on the responsible one. So the grant is
shared with **everything that terminal runs**, which is a broader blast radius
than this document claimed and is the sort of thing a user should be told
once rather than discover.

Both are in react-x11's `docs/desktop-calendar.md`, along with four things
measured with the grant still undecided: a status read never prompts, creating
the store never prompts, an ungranted read answers an **empty list** rather
than an error, and the child starts in about 130 ms.

The general lesson is the one this repository already writes down for the
cocoa drag work: **a fix for a platform you cannot exercise is a hypothesis.**
§13 said so about the prompt and was right to; what it could not predict is
that the hypothesis would be wrong in two different directions at once.
