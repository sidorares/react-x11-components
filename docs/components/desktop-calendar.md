# Desktop calendar

```jsx
import { useDesktopCalendarEvents } from '@react-x11/components/desktop-calendar';
```

The user's **real** calendars — Google, Microsoft, CalDAV, local — read
through Evolution Data Server over D-Bus.

**Your app never sees a credential and never runs an OAuth flow**, because
the desktop did that already, in Settings. This is a hook and a couple of
plain functions, not a component: what to draw with the events is the app's
business.

## `useDesktopCalendarEvents(options)`

```jsx
import { Calendar, useDesktopCalendarEvents } from '@react-x11/components';

function Month({ from, to }) {
  const { byDay } = useDesktopCalendarEvents({ from, to, watch: true });

  return (
    <Calendar
      dayContent={(day, state) =>
        (byDay.get(day) ?? []).slice(0, 3).map((ev, i) => (
          <box
            key={i}
            style={{
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: state.selected
                ? state.color
                : (ev.calendar.color ?? '$accent'),
            }}
          />
        ))
      }
    />
  );
}
```

The keys `byDay` uses are exactly the `'YYYY-MM-DD'` days
[`<Calendar>`](calendar.md)'s `dayContent` is handed, so nothing sits between
the two.

### Options

| Option      | Type       | Notes                                                           |
| ----------- | ---------- | --------------------------------------------------------------- |
| `from`      | `Date`     | Start of the window to read, inclusive. Required.               |
| `to`        | `Date`     | End of the window, exclusive. Required.                         |
| `calendars` | `string[]` | Restrict to these calendar UIDs. Default: every enabled one.    |
| `watch`     | `boolean`  | Re-query when the desktop says something in the range changed.  |
| `enabled`   | `boolean`  | Set false to hold off entirely — a picker that is not open yet. |

### Result

| Field       | Type                                              | Notes                                                                  |
| ----------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `events`    | `DesktopEvent[]`                                  |                                                                        |
| `byDay`     | `Map<string, DesktopEvent[]>`                     | The same events keyed by `'YYYY-MM-DD'`, ready for `dayContent`.       |
| `calendars` | `DesktopCalendarInfo[]`                           | Every calendar found, for a legend or a filter.                        |
| `errors`    | `DesktopCalendarError[]`                          | Backends that would not answer. **Not fatal** — the rest still loaded. |
| `status`    | `'idle' \| 'loading' \| 'ready' \| 'unavailable'` |                                                                        |
| `error`     | `Error \| null`                                   | Why there are no events: no bus, or no `ical.js`.                      |
| `refresh`   | `() => void`                                      | Re-query now.                                                          |

### Types

```ts
interface DesktopEvent {
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

interface DesktopCalendarInfo {
  uid: string;
  name: string; // as the desktop's own calendar UI shows it
  enabled: boolean;
  color?: string; // worth carrying into a day marker
  backend?: string; // 'caldav', 'google', 'local', 'webcal'…
  readOnly: boolean;
  account?: string; // set when it came from an Online Accounts login
}
```

## `ical.js` is optional, and so is having a calendar at all

Expanding recurring events needs [`ical.js`](https://github.com/kewisch/ical.js):

```bash
npm install ical.js
```

Without it, or with no session bus, or on a desktop with no Evolution Data
Server, `status` is `'unavailable'` and a calendar simply renders without
dots. **None of those is an error** — they are ordinary states of a healthy
machine, which is why the hook reports them through `status` and `error`
rather than throwing. `IcalUnavailableError` is exported so the missing-module
case can be told apart from the missing-bus one.

## Lower-level exports

- `DesktopCalendar` — the EDS client on its own, without React: list the
  sources, open a calendar, query a range.
- `byDay(events)` — the grouping, as a plain function, for events that came
  from somewhere else.
- `parseKeyFile(text)` — EDS stores its source definitions as GLib key files;
  this reads one. Exported because it is useful and testable on its own.

## Example

`npm run examples:calendar` is the whole thing working: a real month grid
with the machine's real events dotted onto it. It needs a `$DISPLAY` and a
session bus.
