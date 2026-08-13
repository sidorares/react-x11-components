// Run with: npm run examples:calendar   (needs an X server / DISPLAY)
//
// The two halves of this feature together: the grid, and the user's real
// calendar read off the desktop over D-Bus. If there is no session bus, no
// Evolution Data Server, or no `ical.js` installed, the dots simply do not
// appear and the calendar is still a calendar — which is the whole point of
// `status: 'unavailable'` not being an error.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import {
  Calendar,
  DatePicker,
  monthOf,
  today,
  useDesktopCalendarEvents,
} from '../src/index.js';
import type { CalendarDay } from '../src/index.js';

/** The first and last instant of the month being shown. */
function monthWindow(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number);
  return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) };
}

function App(): ReactElement {
  const [day, setDay] = useState<CalendarDay | null>(today());
  const [month, setMonth] = useState(monthOf(today()));
  const { from, to } = monthWindow(month);

  // `watch` re-queries when the desktop says the range changed, so accepting
  // an invitation in another app lights a dot up here without a reload.
  const { byDay, calendars, status, error } = useDesktopCalendarEvents({
    from,
    to,
    watch: true,
  });

  const events = day ? (byDay.get(day) ?? []) : [];

  return (
    <window width={760} height={520} title="@react-x11/components — calendar">
      <box style={{ flexGrow: 1, padding: 16, gap: 16 }}>
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <text style={{ fontSize: 14, color: '$text' }}>Pick a date</text>
          <DatePicker
            value={day}
            locale="en-GB"
            onChange={(ev) => setDay(ev.value as CalendarDay | null)}
          />
          <text style={{ fontSize: 11, color: '$textMuted' }}>
            {status === 'ready'
              ? `${calendars.filter((c) => c.enabled).length} desktop calendars`
              : status === 'loading'
                ? 'reading desktop calendars…'
                : (error?.message.split('.')[0] ?? 'no desktop calendars')}
          </text>
        </box>

        <box style={{ flexDirection: 'row', gap: 16, flexGrow: 1 }}>
          <Calendar
            value={day}
            month={month}
            onMonthChange={setMonth}
            locale="en-GB"
            onChange={(ev) => setDay(ev.value)}
            // Up to three dots under the number, in each calendar's own
            // colour. On a selected day the ink is the accent's text colour,
            // so the marker follows it rather than vanishing into the fill.
            dayContent={(d, state) =>
              (byDay.get(d) ?? []).slice(0, 3).map((ev, i) => (
                <box
                  key={`${ev.uid}-${i}`}
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

          <box style={{ flexGrow: 1, gap: 8 }}>
            <text style={{ fontSize: 13, fontWeight: 'bold', color: '$text' }}>
              {day ?? 'nothing picked'}
            </text>
            {events.length === 0 ? (
              <text style={{ fontSize: 12, color: '$textMuted' }}>
                Nothing on this day.
              </text>
            ) : (
              events.map((ev) => (
                <box
                  key={ev.uid + ev.start.toISOString()}
                  style={{
                    flexDirection: 'row',
                    gap: 8,
                    alignItems: 'center',
                    padding: 6,
                    borderRadius: 4,
                    backgroundColor: '$surfaceHover',
                  }}
                >
                  <box
                    style={{
                      width: 3,
                      height: 22,
                      borderRadius: 2,
                      backgroundColor: ev.calendar.color ?? '$accent',
                    }}
                  />
                  <box style={{ gap: 2, flexGrow: 1 }}>
                    <text style={{ fontSize: 12, color: '$text' }}>
                      {ev.summary || '(no title)'}
                    </text>
                    <text style={{ fontSize: 11, color: '$textMuted' }}>
                      {ev.allDay
                        ? 'all day'
                        : ev.start.toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                      {ev.location ? ` · ${ev.location}` : ''}
                      {` · ${ev.calendar.name}`}
                    </text>
                  </box>
                </box>
              ))
            )}
          </box>
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
