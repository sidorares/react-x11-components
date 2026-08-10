// <Calendar> and <DatePicker>, moved out of react-x11 core.
//
// The date arithmetic is tested directly because it is exported API in its own
// right, and because every subtle calendar bug — a month grid an hour out on a
// DST boundary, February 30th sliding to March 2nd — lives there rather than
// in the rendering.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, screen, userEvent } from 'react-x11/test';
import type { Node as RetainedNode } from 'react-x11/node';
import type { DrawnNode } from 'react-x11';

import { Calendar, DatePicker } from '../src/index.js';
import {
  addDays,
  addMonths,
  clampDay,
  dayParts,
  monthGrid,
  monthOf,
  toDay,
  today,
} from '../src/index.js';
import type {
  CalendarDay,
  CalendarProps,
  DateRange,
  WidgetChangeEvent,
} from '../src/index.js';

const h = React.createElement;

afterEach(cleanup);

// The tests that only look at what rendered use `{ backend: 'mock' }`, which
// is faster and needs no server. The ones that *click* do not: `userEvent`
// injects through the X server, so they run on the default `'xserver'`
// backend — still headless, still no `$DISPLAY`, because react-x11's harness
// runs node-x11's pure-JavaScript server in this process.

/** The queries hand back the retained node; their public type describes the
 *  narrower ref-facing view. Same widening as `sparkline.test.ts`. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

/**
 * Find by `aria-label`. The grid labels its cells and its two nav buttons
 * that way and neither carries text a `ByRole` name could match — a day cell
 * says "7", and a chevron is a `<canvas>` with nothing in it at all.
 */
function byLabel(label: string): DrawnNode {
  const [node] = screen.all((n) => retained(n).props['aria-label'] === label);
  assert.ok(node, `no node labelled ${JSON.stringify(label)}`);
  return node;
}

/** Every day cell on screen. */
function dayCells(): DrawnNode[] {
  return screen.all((n) => retained(n).props.role === 'gridcell');
}

/** Mount without React's report of an escaping error on stderr. */
async function rejectsQuietly(
  fn: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(fn, expected);
  } finally {
    console.error = origError;
  }
}

// --- the day vocabulary ----------------------------------------------------

test('a day is a string, and a Date is read as its local calendar day', () => {
  assert.strictEqual(toDay('2026-08-07'), '2026-08-07');
  assert.strictEqual(toDay(new Date(2026, 7, 7)), '2026-08-07');
  assert.strictEqual(toDay(null), null);
  assert.strictEqual(toDay(undefined), null);
});

test('a date that does not exist is a typo, not a day', () => {
  // the trap this whole representation exists to avoid: `new Date()` slides
  // 2026-02-30 to March 2nd and a booking is silently a day out
  assert.throws(() => toDay('2026-02-30'), /not a real calendar date/);
  assert.throws(() => toDay('2026-13-01'), /not a real calendar date/);
  assert.throws(() => toDay('7 Aug 2026'), /expected a calendar day/);
  assert.throws(() => toDay(new Date('nope')), /Invalid Date/);
});

test('adding a day is always 86400 seconds, DST or not', () => {
  // 2026-10-25 is the European DST fall-back; local-time arithmetic can land
  // back on the 25th here
  assert.strictEqual(addDays('2026-10-25', 1), '2026-10-26');
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(addDays('2028-02-28', 1), '2028-02-29'); // leap
  assert.strictEqual(addDays('2026-02-28', 1), '2026-03-01');
});

test('months are added on the month key, never on a day', () => {
  assert.strictEqual(addMonths('2026-08', 1), '2026-09');
  assert.strictEqual(addMonths('2026-12', 1), '2027-01');
  assert.strictEqual(addMonths('2026-01', -1), '2025-12');
  assert.strictEqual(addMonths('2026-01', -13), '2024-12');
});

test('the grid is always six weeks, whatever the month needs', () => {
  for (const month of ['2026-02', '2026-08', '2027-02', '2026-11']) {
    const weeks = monthGrid(month, 1);
    assert.strictEqual(weeks.length, 6, `${month} has six rows`);
    for (const week of weeks) assert.strictEqual(week.length, 7);
    assert.ok(weeks.flat().some((d) => monthOf(d) === month));
  }
  // February 2026 needs only four rows; it still gets six, which is why the
  // picker's popup does not change height as you page through it
  assert.strictEqual(monthGrid('2026-02', 1)[0][0], '2026-01-26');
});

test('the grid starts on the day the caller asked for', () => {
  assert.strictEqual(dayParts(monthGrid('2026-08', 0)[0][0]).weekday, 0);
  assert.strictEqual(dayParts(monthGrid('2026-08', 1)[0][0]).weekday, 1);
  assert.strictEqual(dayParts(monthGrid('2026-08', 6)[0][0]).weekday, 6);
});

test('clampDay holds a day inside its bounds', () => {
  assert.strictEqual(clampDay('2026-08-07', '2026-08-10', null), '2026-08-10');
  assert.strictEqual(clampDay('2026-08-07', null, '2026-08-01'), '2026-08-01');
  assert.strictEqual(clampDay('2026-08-07', null, null), '2026-08-07');
});

// --- the grid --------------------------------------------------------------

test('it renders six weeks of days for the month it is showing', async () => {
  await renderX11(h(Calendar, { defaultMonth: '2026-08' }), {
    backend: 'mock',
  });
  assert.strictEqual(dayCells().length, 42, 'six weeks of seven');
  screen.getByText('August 2026');
});

test('the month steps, and the title follows', async () => {
  await renderX11(h(Calendar, { defaultMonth: '2026-08' }));
  await userEvent.click(byLabel('Next month'));
  screen.getByText('September 2026');

  await userEvent.click(byLabel('Previous month'));
  await userEvent.click(byLabel('Previous month'));
  screen.getByText('July 2026');
});

/**
 * The glyph is core's, so what is worth pinning here is not its shape but the
 * pairing: the button that says "Previous month" points left. A chevron that
 * followed the wrong branch would still lay out, still click and still step
 * the month — the arrow would simply point the other way, which no other
 * assertion in this file can see. `cacheKey` is the name `<Icon>` hands the
 * canvas, and it is the whole of what the drawing is identified by.
 */
test('each nav button is drawn with the chevron that matches its label', async () => {
  await renderX11(h(Calendar, { defaultMonth: '2026-08' }), {
    backend: 'mock',
  });
  for (const [label, name] of [
    ['Previous month', 'chevronLeft'],
    ['Next month', 'chevronRight'],
  ]) {
    const [glyph] = retained(byLabel(label)).children;
    assert.strictEqual(glyph?.kind, 'canvas');
    assert.strictEqual(glyph.props.cacheKey, name);
    // `mono` is what takes the colour out of the cache key, so the four
    // chevrons on screen in a `<DatePicker>` are two rendered copies.
    assert.strictEqual(glyph.props.mono, true);
  }
});

test('picking a day reports it as a form-shaped change event', async () => {
  const seen: WidgetChangeEvent<CalendarDay | null>[] = [];
  await renderX11(
    h(Calendar, {
      defaultMonth: '2026-08',
      name: 'when',
      onChange: (ev: WidgetChangeEvent<CalendarDay | null>) => seen.push(ev),
    }),
  );

  await userEvent.click(byLabel('2026-08-07'));
  assert.strictEqual(seen.length, 1);
  // the shape a form library destructures — `ev.target.value`, `ev.target.name`
  assert.strictEqual(seen[0].value, '2026-08-07');
  assert.strictEqual(seen[0].name, 'when');
  assert.strictEqual(seen[0].target.value, '2026-08-07');
  assert.strictEqual(seen[0].target.name, 'when');
  assert.strictEqual(seen[0].type, 'change');
});

test('min and max block the days outside them', async () => {
  const seen: unknown[] = [];
  await renderX11(
    h(Calendar, {
      defaultMonth: '2026-08',
      min: '2026-08-10',
      max: '2026-08-20',
      onChange: (ev: WidgetChangeEvent<CalendarDay | null>) =>
        seen.push(ev.value),
    }),
  );

  await userEvent.click(byLabel('2026-08-05'));
  assert.deepStrictEqual(seen, [], 'a blocked day does not report a change');

  await userEvent.click(byLabel('2026-08-15'));
  assert.deepStrictEqual(seen, ['2026-08-15']);
});

test('isDateBlocked gets the parts, so weekends do not need parsing', async () => {
  const seen: unknown[] = [];
  await renderX11(
    h(Calendar, {
      defaultMonth: '2026-08',
      isDateBlocked: (_day, parts) =>
        parts.weekday === 0 || parts.weekday === 6,
      onChange: (ev: WidgetChangeEvent<CalendarDay | null>) =>
        seen.push(ev.value),
    }),
  );

  await userEvent.click(byLabel('2026-08-08')); // a Saturday
  assert.deepStrictEqual(seen, [], 'the weekend was blocked');
  await userEvent.click(byLabel('2026-08-07')); // the Friday before it
  assert.deepStrictEqual(seen, ['2026-08-07']);
});

test('a range takes two clicks and reports the half-picked state', async () => {
  const seen: DateRange[] = [];
  await renderX11(
    h(Calendar, {
      mode: 'range',
      defaultMonth: '2026-08',
      onChange: (ev: WidgetChangeEvent<DateRange>) => seen.push(ev.value),
    }),
  );

  await userEvent.click(byLabel('2026-08-07'));
  assert.deepStrictEqual(seen[0], { start: '2026-08-07', end: null });

  await userEvent.click(byLabel('2026-08-12'));
  assert.deepStrictEqual(seen[1], { start: '2026-08-07', end: '2026-08-12' });
});

test('clicking before the start re-anchors instead of selecting backwards', async () => {
  const seen: DateRange[] = [];
  await renderX11(
    h(Calendar, {
      mode: 'range',
      defaultMonth: '2026-08',
      onChange: (ev: WidgetChangeEvent<DateRange>) => seen.push(ev.value),
    }),
  );

  await userEvent.click(byLabel('2026-08-12'));
  await userEvent.click(byLabel('2026-08-07'));
  assert.deepStrictEqual(seen[1], { start: '2026-08-07', end: null });
});

test('a range may not be completed across a blocked day', async () => {
  const seen: DateRange[] = [];
  await renderX11(
    h(Calendar, {
      mode: 'range',
      defaultMonth: '2026-08',
      // the 10th is taken; a booking that spans it was never offered
      isDateBlocked: (day) => day === '2026-08-10',
      onChange: (ev: WidgetChangeEvent<DateRange>) => seen.push(ev.value),
    }),
  );

  await userEvent.click(byLabel('2026-08-07'));
  await userEvent.click(byLabel('2026-08-12'));
  assert.strictEqual(seen.length, 1, 'the end past the wall was refused');
});

test('spanBlocked is the other reading: only the ends must be free', async () => {
  const seen: DateRange[] = [];
  await renderX11(
    h(Calendar, {
      mode: 'range',
      defaultMonth: '2026-08',
      spanBlocked: true,
      isDateBlocked: (day) => day === '2026-08-10',
      onChange: (ev: WidgetChangeEvent<DateRange>) => seen.push(ev.value),
    }),
  );

  await userEvent.click(byLabel('2026-08-07'));
  await userEvent.click(byLabel('2026-08-12'));
  assert.deepStrictEqual(seen[1], { start: '2026-08-07', end: '2026-08-12' });
});

test('the two value shapes are told apart loudly', async () => {
  // silently showing an empty calendar is the failure this replaces
  await rejectsQuietly(
    () =>
      renderX11(
        h(Calendar, {
          value: { start: '2026-08-07', end: null },
        } as unknown as CalendarProps),
        { backend: 'mock' },
      ),
    /Pass mode="range"/,
  );

  await cleanup();
  await rejectsQuietly(
    () =>
      renderX11(
        h(Calendar, {
          mode: 'range',
          value: '2026-08-07',
        } as unknown as CalendarProps),
        { backend: 'mock' },
      ),
    /a range calendar's value is \{ start, end \}/,
  );
});

test('dayContent draws under the number and is given the cell state', async () => {
  const seen = new Map<string, { selected: boolean; color: string }>();
  await renderX11(
    h(Calendar, {
      defaultMonth: '2026-08',
      defaultValue: '2026-08-07',
      dayContent: (day, state) => {
        seen.set(day, { selected: state.selected, color: state.color });
        return null;
      },
    }),
    { backend: 'mock' },
  );

  assert.strictEqual(seen.get('2026-08-07')?.selected, true);
  assert.strictEqual(seen.get('2026-08-08')?.selected, false);
  // the resolved ink, so a marker stays legible on a filled end of a range
  assert.ok(seen.get('2026-08-07')?.color, 'the colour is resolved for it');
});

test('today is marked without being selected', async () => {
  const marked: string[] = [];
  await renderX11(
    h(Calendar, {
      dayContent: (day, state) => {
        if (state.today) marked.push(day);
        return null;
      },
    }),
    { backend: 'mock' },
  );
  assert.deepStrictEqual(marked, [today()]);
});

// --- the picker ------------------------------------------------------------

test('the picker shows a placeholder until something is picked', async () => {
  await renderX11(h(DatePicker, {}), { backend: 'mock' });
  screen.getByText('Pick a date…');
});

test('the picker formats the value it was given', async () => {
  await renderX11(h(DatePicker, { value: '2026-08-07', locale: 'en-GB' }), {
    backend: 'mock',
  });
  screen.getByText('7 Aug 2026');
});

test('format() is the seam for the label', async () => {
  await renderX11(
    h(DatePicker, { value: '2026-08-07', format: () => 'whenever' }),
    { backend: 'mock' },
  );
  screen.getByText('whenever');
});

test('the calendar is not mounted until the trigger is pressed', async () => {
  await renderX11(h(DatePicker, { defaultMonth: '2026-08' }), {
    backend: 'mock',
  });
  assert.strictEqual(dayCells().length, 0, 'no grid before it is opened');
});
