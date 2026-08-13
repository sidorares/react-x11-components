# Calendar and DatePicker

```jsx
import { Calendar, DatePicker } from '@react-x11/components/calendar';
```

A month grid that picks one date or a range, and the same grid on a popup
behind a field. Both moved out of react-x11 core, and this package is their
owner now — core is expected to drop its copies.

Neither registers a host element. They are compositions of `<box>`, `<text>`,
`<canvas>` and core's `<Icon>`, so importing them has **no side effect at
import time at all** — no `registerElement`, no JSX augmentation.

## `<Calendar>`

```jsx
<Calendar value={day} onChange={(ev) => setDay(ev.value)} />
```

```jsx
<Calendar
  mode="range"
  value={range}
  onChange={(ev) => setRange(ev.value)}
  min={today()}
  isDateBlocked={(day) => booked.has(day)}
  spanBlocked={false}
/>
```

### Props

`CalendarProps` is a union of `SingleCalendarProps` and
`RangeCalendarProps`, discriminated on `mode`. That is what keeps
`onChange`'s parameter honest: a range calendar's `ev.value` is a
`DateRange`, a single one's is a `CalendarDay | null`.

| Prop            | Type                                   | Notes                                                                                                                                                                               |
| --------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`          | `'single'` (default) \| `'range'`      | Discriminates the rest of the props.                                                                                                                                                |
| `value`         | `DayInput` \| `DateRangeInput \| null` | Controlled selection. Shape follows `mode`.                                                                                                                                         |
| `defaultValue`  | same                                   | Uncontrolled initial selection.                                                                                                                                                     |
| `onChange`      | `(ev: WidgetChangeEvent<…>) => void`   | `ev.value` is a `CalendarDay \| null` or a `DateRange`.                                                                                                                             |
| `month`         | `CalendarMonth \| null`                | Controlled visible month.                                                                                                                                                           |
| `defaultMonth`  | `DayInput \| CalendarMonth`            | Uncontrolled initial month.                                                                                                                                                         |
| `onMonthChange` | `(month: CalendarMonth) => void`       | Nav buttons, and keyboard month movement.                                                                                                                                           |
| `min` / `max`   | `DayInput`                             | Range ends, inclusive.                                                                                                                                                              |
| `isDateBlocked` | `(day, parts) => boolean`              | Per-day veto. `parts` is the `DayParts` breakdown, so "weekends" is a one-liner.                                                                                                    |
| `spanBlocked`   | `boolean`                              | Range mode: whether a selection may jump over a blocked day. Default false.                                                                                                         |
| `dayContent`    | `(day, state) => ReactNode`            | Drawn under the day number — event dots, prices. `state` carries `selected`, `inRange`, `today`, `blocked`, `outside`, `preview`, `focused` and the `color` the cell is painted in. |
| `name`          | `string`                               | Echoed on the change event, for form libraries.                                                                                                                                     |
| `locale`        | `string`                               | BCP-47. Default: the environment's.                                                                                                                                                 |
| `weekStartsOn`  | `0`–`6`                                | Default: the locale's first day.                                                                                                                                                    |
| `focusable`     | `boolean`                              | A calendar is a control; default true.                                                                                                                                              |
| `focusVisible`  | `boolean`                              | Force the focus ring on, for a picker that owns focus elsewhere.                                                                                                                    |
| `style`         | `Style \| Style[]`                     | The root box.                                                                                                                                                                       |
| `ref`           | `Ref<CalendarHandle>`                  | See below.                                                                                                                                                                          |

`CALENDAR_WIDTH` and `CALENDAR_HEIGHT` are exported for laying one out before
it renders — a popup that needs to know which way it can open.

### `CalendarHandle`

```ts
interface CalendarHandle {
  handleKey: (ev: KeyboardEvent) => boolean;
}
```

One method, and it is what `<DatePicker>` uses: a field that owns keyboard
focus forwards arrow keys, `PageUp`/`PageDown`, `Home`/`End` and `Enter` into
the grid, and `false` back means "not mine, do your own thing".

### `dayContent`

The keys `useDesktopCalendarEvents`'s `byDay` map uses are exactly the
`'YYYY-MM-DD'` days `dayContent` is handed, so nothing sits between the two:

```jsx
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
```

`state.color` is the colour the cell is currently painted in. Reading it
rather than picking your own is what keeps a marker legible on the selected
day, where the background is the accent.

## `<DatePicker>`

```jsx
<DatePicker value={day} onChange={(ev) => setDay(ev.value)} />
```

Every `<Calendar>` prop except `focusable`, `focusVisible`, `ref` and
`style` — the picker owns those — plus:

| Prop          | Type                        | Notes                                                                                                        |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `format`      | `(value) => string \| null` | What the trigger shows. Default: the locale's medium date, and `Intl`'s own range format when there are two. |
| `placeholder` | `string`                    | Shown when nothing is picked yet.                                                                            |
| `disabled`    | `boolean`                   |                                                                                                              |
| `style`       | `Style \| Style[]`          | The trigger, not the sheet.                                                                                  |

The omit is distributed across the union rather than applied to it, so
`<DatePicker mode="range" onChange={…}>` still knows `ev.value` is a
`DateRange`. `Omit` over a union collapses it into one member, which would
have cost exactly that.

The wall-calendar glyph on the trigger is a local `<canvas>`, not a core
`<Icon>`. Core's icon set is affordances — chevrons, checks, a close — and a
calendar page is a noun; the set will never have one. The month nav arrows
_are_ core's `<Icon name="chevronLeft|chevronRight">`, so a picker opened
from a core `<Select>` agrees with it.

## Date vocabulary

The day arithmetic comes out through the barrel too, because an app that
renders a calendar almost always does a little of the same arithmetic to
decide what to block or what to mark:

```ts
import {
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
} from '@react-x11/components/calendar';
```

A `CalendarDay` is a `'YYYY-MM-DD'` string and a `CalendarMonth` is
`'YYYY-MM'`. Both are plain strings on purpose: they compare, sort and key a
`Map` without a helper, and they carry no timezone, which a `Date` cannot
avoid carrying.

`src/calendar/dates.ts` and `src/calendar/internal.ts` are **copies** of code
that is still in react-x11 today. They were copied rather than imported
because they are not on core's exports map, and they are pure. Core is
expected to drop `<Calendar>`, so divergence here is intended rather than
drift — do not try to keep them in sync.

## Example

`npm run examples:calendar` renders both, with the user's real calendar
events dotted onto the grid.
