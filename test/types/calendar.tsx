// Type-level test: the calendar's props compile against react-x11's JSX
// namespace, the two value shapes are told apart by the type as well as at
// run time, and the desktop-event hook lines up with `dayContent`.
//
// That last one is a **cross-package** assertion since react-x11 2.9.1 took
// the desktop calendar: the events come from core and the grid comes from
// here, and the only thing joining them is the `'YYYY-MM-DD'` key. Nothing
// checks that at run time — neither package imports the other's calendar —
// so this file is where the two halves are held against each other.
import React from 'react';
import { useDesktopCalendarEvents } from 'react-x11';
import type { DesktopEvent } from 'react-x11';

import { Calendar, DatePicker } from '../../src/index.js';
import type {
  CalendarDay,
  CalendarDayState,
  CalendarHandle,
  DateRange,
  WidgetChangeEvent,
} from '../../src/index.js';

export const single = (
  <box style={{ flexGrow: 1 }}>
    <Calendar
      value="2026-08-07"
      min="2026-01-01"
      max={new Date(2026, 11, 31)}
      locale="en-GB"
      weekStartsOn={1}
      onChange={(ev) => {
        const day: CalendarDay | null = ev.value;
        void day;
      }}
    />
  </box>
);

export const range = (
  <Calendar
    mode="range"
    value={{ start: '2026-08-07', end: null }}
    spanBlocked
    onChange={(ev) => {
      const picked: DateRange = ev.value;
      void picked.start;
      void picked.end;
    }}
  />
);

export const blocked = (
  <Calendar
    isDateBlocked={(day, parts) =>
      day === '2026-08-10' || parts.weekday === 0 || parts.weekday === 6
    }
  />
);

export const withMarkers = (
  <Calendar
    dayContent={(day: CalendarDay, state: CalendarDayState) =>
      state.selected ? <text style={{ color: state.color }}>{day}</text> : null
    }
  />
);

export const picker = (
  <DatePicker
    mode="range"
    placeholder="Pick dates…"
    format={() => 'custom label'}
    onChange={(ev: WidgetChangeEvent<DateRange>) => void ev.value}
  />
);

// The imperative side, for a control that holds the keyboard for the grid.
export function Held(): React.ReactElement {
  const ref = React.useRef<CalendarHandle>(null);
  return <Calendar ref={ref} focusable={false} focusVisible />;
}

// The two halves fit together: the helper's keys are what `dayContent` is
// handed, so this needs no adapter between them.
export function WithDesktopEvents(): React.ReactElement {
  const { byDay, status } = useDesktopCalendarEvents({
    from: new Date(2026, 7, 1),
    to: new Date(2026, 8, 1),
    watch: true,
  });
  // `'denied'` arrived with the move: the user's answer, which has a
  // Settings switch behind it, against the machine's `'unavailable'`, which
  // has none.
  void (status satisfies
    'idle' | 'loading' | 'ready' | 'denied' | 'unavailable');

  return (
    <Calendar
      dayContent={(day) =>
        byDay.get(day)?.map((ev: DesktopEvent) => (
          <box
            key={ev.uid}
            style={{
              width: 4,
              height: 4,
              backgroundColor: ev.calendar.color,
            }}
          />
        ))
      }
    />
  );
}

// @ts-expect-error a single-date calendar does not take a range
export const wrongShape = <Calendar value={{ start: '2026-08-07' }} />;

export const wrongEvent = (
  <Calendar
    mode="range"
    // @ts-expect-error `mode="range"` reports a range, not a day
    onChange={(ev: WidgetChangeEvent<CalendarDay>) => void ev}
  />
);

// @ts-expect-error a day is 'YYYY-MM-DD' or a Date, never a number
export const wrongDay = <Calendar value={20260807} />;
