// <Html> — a date, a time, a month, a week and a `datetime-local` input:
// the segments a browser types them in (`date-fields.ts`) and the picker
// each drops (`date-picker.ts`), the calendar an app's `<Calendar>` is.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  fireEvent,
  screen,
  userEvent,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import {
  XK_BACKSPACE,
  XK_DOWN,
  XK_ESCAPE,
  XK_F4,
  XK_LEFT,
  XK_RETURN,
  XK_RIGHT,
  XK_TAB,
  XK_UP,
} from 'react-x11/keysyms';
import {
  fieldLayout,
  fieldText,
  mondayOfWeek,
  precisionOf,
  segmentsOf,
  stepSegment,
  typeDigit,
  typeLetter,
  valueOf,
  weekOfDay,
} from '../../src/html/date-fields.js';
import type { DateFieldType } from '../../src/html/date-fields.js';
import { parseColor } from '../../src/html/css/values.js';
import {
  FONTS,
  boxOf,
  findById,
  render,
  render2x,
  scriptedPage,
  view,
} from './harness.js';

afterEach(cleanup);

/** A node's props, as core keeps them. */
type Props = { props: Record<string, unknown> };
const propsOf = (node: DrawnNode) =>
  (node as unknown as Props).props as Record<string, unknown>;

// --- the model ----------------------------------------------------------------

test("a date field's segments are the locale's, and its value is HTML's", () => {
  const cases: [DateFieldType, string, string, string][] = [
    ['date', '2026-11-18', 'mm/dd/yyyy', '11/18/2026'],
    ['time', '14:30', '--:-- --', '02:30 PM'],
    [
      'datetime-local',
      '2026-11-18T14:30',
      'mm/dd/yyyy, --:-- --',
      '11/18/2026, 02:30 PM',
    ],
    ['month', '2026-11', '--------- ----', 'November 2026'],
    ['week', '2026-W47', 'Week --, ----', 'Week 47, 2026'],
  ];
  for (const [type, value, empty, shown] of cases) {
    const layout = fieldLayout(type, 'en-US');
    const values = segmentsOf(layout, value);
    assert.strictEqual(fieldText(layout, {}), empty, `${type} with nothing`);
    assert.strictEqual(
      fieldText(layout, values),
      shown,
      `${type} with a value`,
    );
    assert.strictEqual(valueOf(layout, values), value, `${type} comes back`);
  }
  assert.strictEqual(
    fieldText(fieldLayout('date', 'en-GB'), {}),
    'dd/mm/yyyy',
    'a day first where the locale writes it first',
  );
  assert.strictEqual(
    fieldText(
      fieldLayout('time', 'de-DE'),
      segmentsOf(fieldLayout('time', 'de-DE'), '14:30'),
    ),
    '14:30',
    'and a clock of twenty-four hours with no half of the day',
  );
  // a value of another type, or none, shows nothing
  assert.deepStrictEqual(
    segmentsOf(fieldLayout('date', 'en-US'), '2026-W47'),
    {},
  );
  assert.deepStrictEqual(
    segmentsOf(fieldLayout('date', 'en-US'), '2026-02-30'),
    {},
  );
});

test('a value is empty until every segment says something, and is a day some month has', () => {
  const layout = fieldLayout('date', 'en-US');
  assert.strictEqual(valueOf(layout, { year: 2026, month: 11 }), '');
  assert.strictEqual(valueOf(layout, { year: 2026, month: 2, day: 30 }), '');
  assert.strictEqual(
    valueOf(layout, { year: 2024, month: 2, day: 29 }),
    '2024-02-29',
  );
  const week = fieldLayout('week', 'en-US');
  assert.strictEqual(valueOf(week, { year: 2020, week: 53 }), '2020-W53');
  assert.strictEqual(
    valueOf(week, { year: 2021, week: 53 }),
    '',
    '2021 has 52',
  );
  const time = fieldLayout('time', 'en-US');
  assert.strictEqual(
    valueOf(time, { hour: 12, minute: 5 }),
    '',
    'no half of the day',
  );
  assert.strictEqual(
    valueOf(time, { hour: 12, minute: 5, period: 0 }),
    '00:05',
  );
  assert.strictEqual(
    valueOf(time, { hour: 12, minute: 5, period: 1 }),
    '12:05',
  );
});

test("a segment takes digits as Chrome's does, and moves on when no digit more could fit", () => {
  const layout = fieldLayout('date', 'en-US');
  let typed = typeDigit(layout, {}, 'month', '', '1');
  assert.deepStrictEqual(
    [typed.values.month, typed.advance],
    [1, false],
    '1 could be 10',
  );
  typed = typeDigit(layout, typed.values, 'month', typed.typed, '2');
  assert.deepStrictEqual([typed.values.month, typed.advance], [12, true]);
  typed = typeDigit(layout, {}, 'month', '1', '5');
  assert.deepStrictEqual(
    [typed.values.month, typed.advance],
    [5, true],
    '15 is no month: 5',
  );
  assert.strictEqual(
    typeDigit(layout, {}, 'day', '', '4').advance,
    true,
    'no 40th',
  );
  typed = typeDigit(layout, {}, 'year', '20', '2');
  assert.deepStrictEqual([typed.values.year, typed.advance], [202, false]);
  assert.strictEqual(typeDigit(layout, {}, 'year', '202', '6').advance, true);

  const time = fieldLayout('time', 'en-US');
  const pm = typeLetter(time, {}, 'period', '', 'p');
  assert.strictEqual(pm?.values.period, 1, 'p for PM');
  assert.strictEqual(
    typeLetter(time, {}, 'hour', '', 'p'),
    null,
    'no letter in an hour',
  );
  const month = fieldLayout('month', 'en-US');
  assert.strictEqual(typeLetter(month, {}, 'month', '', 'j')?.values.month, 1);
  const ju = typeLetter(month, {}, 'month', 'j', 'u');
  assert.deepStrictEqual(
    [ju?.values.month, ju?.advance],
    [6, false],
    'June or July',
  );
  assert.strictEqual(
    typeLetter(month, {}, 'month', 'ju', 'l')?.values.month,
    7,
  );
});

test('a segment steps round, but a year stops at its ends, and starts this year', () => {
  const layout = fieldLayout('date', 'en-US');
  assert.strictEqual(
    stepSegment(layout, { month: 12 }, 'month', 1, 2026).month,
    1,
  );
  assert.strictEqual(
    stepSegment(layout, { month: 1 }, 'month', -1, 2026).month,
    12,
  );
  assert.strictEqual(stepSegment(layout, {}, 'month', 1, 2026).month, 1);
  assert.strictEqual(stepSegment(layout, {}, 'day', -1, 2026).day, 31);
  assert.strictEqual(stepSegment(layout, {}, 'year', -1, 2026).year, 2026);
  assert.strictEqual(
    stepSegment(layout, { year: 1 }, 'year', -1, 2026).year,
    1,
  );
  const time = fieldLayout('time', 'en-US');
  assert.strictEqual(stepSegment(time, { hour: 12 }, 'hour', 1, 2026).hour, 1);
});

test("a step that is no whole minute shows seconds, and a value's seconds show", () => {
  assert.deepStrictEqual(precisionOf(undefined, ''), {
    seconds: false,
    millis: false,
  });
  assert.deepStrictEqual(precisionOf('1', ''), {
    seconds: true,
    millis: false,
  });
  assert.deepStrictEqual(precisionOf('0.5', ''), {
    seconds: true,
    millis: true,
  });
  assert.deepStrictEqual(precisionOf('900', ''), {
    seconds: false,
    millis: false,
  });
  assert.deepStrictEqual(precisionOf(undefined, '10:00:30'), {
    seconds: true,
    millis: false,
  });
  const layout = fieldLayout('time', 'en-US', true, true);
  assert.strictEqual(fieldText(layout, {}), '--:--:--.--- --');
  const values = segmentsOf(layout, '10:00:30.5');
  assert.strictEqual(valueOf(layout, values), '10:00:30.500');
});

test("an ISO week is its Thursday's year's", () => {
  assert.deepStrictEqual(weekOfDay('2026-11-18'), { year: 2026, week: 47 });
  assert.deepStrictEqual(weekOfDay('2021-01-03'), { year: 2020, week: 53 });
  assert.deepStrictEqual(weekOfDay('2024-12-30'), { year: 2025, week: 1 });
  assert.strictEqual(mondayOfWeek(2026, 47), '2026-11-16');
  assert.strictEqual(mondayOfWeek(2025, 1), '2024-12-30');
});

// --- the widget ---------------------------------------------------------------

/** The nodes of a role whose `aria-label` is `label`: core's queries go
 *  by a node's text, which an indicator has none of. */
function allByLabel(role: string, label: string): DrawnNode[] {
  return screen
    .queryAllByRole(role)
    .filter((node) => propsOf(node)['aria-label'] === label);
}
function byLabel(role: string, label: string): DrawnNode {
  const [node] = allByLabel(role, label);
  assert.ok(node, `a ${role} called ${label}`);
  return node;
}

/** The field mounted for an element, by what it says. */
function fieldOf(label: string): DrawnNode {
  return screen
    .getAllByRole('group')
    .find((node) => propsOf(node)['aria-label'] === label)!;
}

/** What `onDomEvent` heard, by type, for an element. */
function heard() {
  const events: string[] = [];
  return {
    events,
    onDomEvent: (ev: {
      type: string;
      target: { attribs: Record<string, string> };
    }) => {
      if (ev.type === 'input' || ev.type === 'change') {
        events.push(`${ev.type}:${ev.target.attribs.id}`);
      }
      return true;
    },
  };
}

const LOCALE_DATE = (value: string) => {
  const layout = fieldLayout('date');
  return fieldText(layout, segmentsOf(layout, value));
};

test('a date input is a field of segments, typed into, which the form reads whole', async () => {
  const told = heard();
  const { node } = await render(
    '<form><input id="d" type="date" value="2026-11-18"></form>',
    400,
    { onDomEvent: told.onDomEvent },
  );
  const el = view(node);
  const input = findById(el.document, 'd')!;
  const field = fieldOf(LOCALE_DATE('2026-11-18'));
  assert.ok(field, 'the value in the locale’s segments');
  assert.strictEqual(
    screen.queryAllByRole('textbox').length,
    0,
    'and no text field',
  );

  // Backspace clears the segment that has the keys, and the value with it
  const forms = el.interactive!;
  assert.ok(forms.focus(input), 'it takes the focus');
  await act();
  await userEvent.key(XK_BACKSPACE);
  assert.strictEqual(forms.controlValue(input), '');
  assert.deepStrictEqual(told.events, ['input:d', 'change:d'], 'told at once');
  const layout = fieldLayout('date');
  for (let i = 1; i < layout.segments.length; i++) {
    await userEvent.key(XK_RIGHT);
    await userEvent.key(XK_BACKSPACE);
  }
  assert.ok(fieldOf(fieldText(layout, {})), 'all of it cleared');

  // typed in full, a segment gives the keys to the next; the value is
  // there only once all of them say something
  told.events.length = 0;
  await userEvent.key(XK_LEFT);
  await userEvent.key(XK_LEFT);
  const digits: Record<string, string> = {
    year: '2027',
    month: '03',
    day: '04',
  };
  const [first, second, third] = layout.segments;
  for (const ch of digits[first] + digits[second]) {
    await act(() => fireEvent.char(ch));
  }
  assert.strictEqual(forms.controlValue(input), '', 'two of three is no value');
  assert.deepStrictEqual(told.events, [], 'nor anything to tell');
  for (const ch of digits[third]) await act(() => fireEvent.char(ch));
  assert.strictEqual(forms.controlValue(input), '2027-03-04');
  // each digit that leaves a whole value is one, as Chrome tells a year
  // typed: 0002, then 0020, 0202 and 2027
  assert.ok(told.events.length >= 2, 'told');
  for (let i = 0; i < told.events.length; i += 2) {
    assert.deepStrictEqual(told.events.slice(i, i + 2), [
      'input:d',
      'change:d',
    ]);
  }

  // Up steps the one that has the keys, the last typed into
  await userEvent.key(XK_UP);
  const stepped: Record<string, string> = {
    year: '2028-03-04',
    month: '2027-04-04',
    day: '2027-03-05',
  };
  assert.strictEqual(forms.controlValue(input), stepped[third]);

  // a script's value is what the segments show
  await act(() => forms.setControlValue(input, '2001-02-03'));
  assert.ok(fieldOf(LOCALE_DATE('2001-02-03')), 'a script set it');
  await act(() => forms.setControlValue(input, 'nonsense'));
  assert.ok(fieldOf(fieldText(layout, {})), 'and none of the type is nothing');
});

test("a date input's picker is the calendar: a press drops it, a day picks, and :open follows", async () => {
  const told = heard();
  const { node } = await render(
    '<style>input:open{color:#ff0000}input:closed{color:#0000ff}</style>' +
      '<input id="d" type="date" value="2026-11-18" min="2026-11-03">',
    400,
    { onDomEvent: told.onDomEvent },
  );
  const el = view(node);
  const input = findById(el.document, 'd')!;
  const color = () =>
    (boxOf(el, 'd') as unknown as { style: { color: string } }).style.color;
  const [red, blue] = [parseColor('#ff0000'), parseColor('#0000ff')];
  assert.strictEqual(color(), blue, 'shut is :closed');
  const indicator = byLabel('button', 'Show local date picker');
  await act(() => fireEvent.mouseDown(indicator));
  await act(() => fireEvent.mouseUp(indicator));
  await act();
  const grid = await screen.findByRole('grid');
  assert.ok(grid, 'the press drops the calendar');
  assert.strictEqual(color(), red, 'and the input is :open');
  assert.ok(
    screen
      .getAllByRole('gridcell')
      .some(
        (c) =>
          propsOf(c)['aria-selected'] === true &&
          propsOf(c)['aria-label'] === '2026-11-18',
      ),
    'on its day',
  );
  const blocked = screen
    .getAllByRole('gridcell')
    .find((c) => propsOf(c)['aria-label'] === '2026-11-02')!;
  assert.strictEqual(propsOf(blocked).disabled, true, 'its min blocks a day');

  const day = screen
    .getAllByRole('gridcell')
    .find((c) => propsOf(c)['aria-label'] === '2026-11-25')!;
  await userEvent.click(day.children[day.children.length - 1] as DrawnNode);
  await act();
  assert.strictEqual(el.interactive!.controlValue(input), '2026-11-25');
  assert.deepStrictEqual(told.events, ['input:d', 'change:d']);
  assert.strictEqual(
    screen.queryByRole('grid'),
    null,
    'a day picked takes it up',
  );
  assert.strictEqual(color(), blue);

  // the keyboard: F4 drops it, the arrows move its day, Enter picks
  assert.ok(el.interactive!.focus(input));
  await act();
  await userEvent.key(XK_F4);
  assert.ok(await screen.findByRole('grid'));
  await userEvent.key(XK_RIGHT);
  await userEvent.key(XK_DOWN);
  await userEvent.key(XK_RETURN);
  assert.strictEqual(el.interactive!.controlValue(input), '2026-12-03');
  assert.strictEqual(screen.queryByRole('grid'), null);
  await userEvent.key(XK_DOWN, { modifiers: ['Alt'] });
  assert.ok(await screen.findByRole('grid'), 'Alt+Down drops it too');
  await userEvent.key(XK_ESCAPE);
  assert.strictEqual(
    screen.queryByRole('grid'),
    null,
    'and Escape takes it up',
  );
});

test("a script's showPicker() drops a date input's calendar, and a read-only one has none", async () => {
  const { node } = await render(
    '<input id="d" type="date"><input id="r" type="date" readonly>',
  );
  const el = view(node);
  const forms = el.interactive!;
  assert.strictEqual(forms.showPicker(findById(el.document, 'r')!), false);
  assert.strictEqual(
    allByLabel('button', 'Show local date picker').length,
    1,
    'nor an indicator',
  );
  assert.strictEqual(forms.showPicker(findById(el.document, 'd')!), true);
  await act();
  assert.ok(await screen.findByRole('grid'));
});

test("a page's script drops the calendar with showPicker(), and hears the day picked as an input and a change", async () => {
  const page = await scriptedPage(
    '<input id="d" type="date" value="2026-11-18">' +
      '<input id="b" type="button" value="open">' +
      '<script>var d = document.getElementById("d");' +
      'd.addEventListener("input", function () {' +
      '  console.log("input " + d.value); });' +
      'd.addEventListener("change", function () { console.log("change " + d.value); });' +
      'document.getElementById("b").onclick = function () {' +
      '  d.showPicker(); console.log("open " + d.matches(":open")); };' +
      '</script>',
  );
  const open = screen.getByText('open', { exact: true });
  await userEvent.click(open);
  assert.strictEqual(await page.until('open'), 'true', ':open at once');
  await screen.findByRole('grid');
  const day = screen
    .getAllByRole('gridcell')
    .find((c) => propsOf(c)['aria-label'] === '2026-11-25')!;
  await userEvent.click(day.children[day.children.length - 1] as DrawnNode);
  assert.strictEqual(await page.until('input'), '2026-11-25');
  assert.strictEqual(await page.until('change'), '2026-11-25');
});

test('a picker dropped before its field is mounted drops as the field comes', async () => {
  const { node } = await render(
    '<input id="d" type="date" value="2026-11-18" style="display:none">',
  );
  const el = view(node);
  const input = findById(el.document, 'd')!;
  assert.strictEqual(screen.queryAllByRole('group').length, 0, 'none yet');
  delete input.attribs.style;
  el.touchDocument([
    { type: 'attributes', target: input, attributeName: 'style' },
  ]);
  assert.ok(el.interactive!.showPicker(input), 'asked at once');
  await act();
  assert.ok(await screen.findByRole('grid'), 'and down once it is there');
});

test('a week input picks the week of the day pressed, Monday to Sunday', async () => {
  const told = heard();
  const { node } = await render(
    '<input id="w" type="week" value="2026-W47">',
    400,
    {
      onDomEvent: told.onDomEvent,
    },
  );
  const el = view(node);
  const input = findById(el.document, 'w')!;
  assert.ok(el.interactive!.showPicker(input));
  await act();
  await screen.findByRole('grid');
  const cells = screen.getAllByRole('gridcell');
  const selected = cells
    .filter((c) => propsOf(c)['aria-selected'] === true)
    .map((c) => propsOf(c)['aria-label']);
  assert.deepStrictEqual(selected, ['2026-11-16', '2026-11-22'], 'its ends');
  const day = cells.find((c) => propsOf(c)['aria-label'] === '2026-11-05')!;
  await userEvent.click(day.children[day.children.length - 1] as DrawnNode);
  await act();
  assert.strictEqual(el.interactive!.controlValue(input), '2026-W45');
  assert.deepStrictEqual(told.events, ['input:w', 'change:w']);
});

test('a month input picks from the twelve months of a year', async () => {
  const { node } = await render(
    '<input id="m" type="month" value="2026-11" max="2027-02">',
  );
  const el = view(node);
  const input = findById(el.document, 'm')!;
  assert.ok(el.interactive!.focus(input));
  await act();
  await userEvent.key(XK_F4);
  await screen.findByRole('grid');
  const cell = (label: string) =>
    screen
      .getAllByRole('gridcell')
      .find((c) => propsOf(c)['aria-label'] === label)!;
  assert.strictEqual(propsOf(cell('November'))['aria-selected'], true);
  // a year on is past its max but for January and February
  await userEvent.click(byLabel('button', 'Next year'));
  await act();
  assert.strictEqual(propsOf(cell('March')).disabled, true);
  await userEvent.key(XK_RIGHT);
  await userEvent.key(XK_RETURN);
  assert.strictEqual(
    el.interactive!.controlValue(input),
    '2027-02',
    'the cursor stays inside',
  );
  assert.strictEqual(screen.queryByRole('grid'), null);
});

test("a time input's columns set its segments, and the keys go on editing them", async () => {
  const told = heard();
  const { node } = await render('<input id="t" type="time" step="900">', 400, {
    onDomEvent: told.onDomEvent,
  });
  const el = view(node);
  const input = findById(el.document, 't')!;
  const layout = fieldLayout('time');
  await userEvent.click(byLabel('button', 'Show time picker'));
  await act();
  const columns = await waitFor(() => {
    const lists = screen.getAllByRole('listbox');
    assert.ok(lists.length >= 2);
    return lists;
  });
  const minutes = columns.find((c) => propsOf(c)['aria-label'] === 'Minutes')!;
  assert.strictEqual(minutes.children.length, 4, 'a quarter of an hour apart');
  const hours = columns.find((c) => propsOf(c)['aria-label'] === 'Hours')!;
  assert.strictEqual(hours.children.length, layout.hour12 ? 12 : 24);
  await userEvent.click(screen.getByText('03', { exact: true }));
  await act();
  assert.strictEqual(
    el.interactive!.controlValue(input),
    layout.hour12 ? '03:00' : '03:00',
    'the hour, and the rest whole',
  );
  assert.deepStrictEqual(told.events, ['input:t', 'change:t']);
  assert.ok(screen.queryAllByRole('listbox').length, 'the columns stay down');
  // the field keeps the keys: Up on its hour, which it took the press on
  await userEvent.key(XK_UP);
  assert.strictEqual(el.interactive!.controlValue(input), '04:00');
  await userEvent.key(XK_RETURN);
  assert.strictEqual(
    screen.queryAllByRole('listbox').length,
    0,
    'Enter takes them up',
  );
});

test('Tab goes through the segments before it leaves the field', async () => {
  const { node } = await render(
    '<input id="d" type="date"><input id="after" placeholder="after">',
  );
  const el = view(node);
  const input = findById(el.document, 'd')!;
  assert.ok(el.interactive!.focus(input));
  await act();
  const count = fieldLayout('date').segments.length;
  for (let i = 1; i < count; i++) {
    await userEvent.key(XK_TAB);
    assert.strictEqual(el.focusedElement, input, `segment ${i + 1}`);
  }
  await userEvent.key(XK_TAB);
  assert.strictEqual(
    el.focusedElement,
    findById(el.document, 'after'),
    'and past the last, on',
  );
});

const metric = FONTS ? test : test.skip;

metric(
  'a date input is as wide as what it shows, at 1x and at 2x',
  async () => {
    const markup =
      '<style>body{margin:0}</style><input id="d" type="date"><br>' +
      '<input id="t" type="time"><br><input id="l" type="datetime-local"><br>' +
      '<input id="x">';
    const one = await render(markup);
    const widths = ['d', 't', 'l', 'x'].map(
      (id) => boxOf(view(one.node), id).width,
    );
    assert.ok(
      widths[0] < widths[3],
      `a date is narrower than a text field: ${widths}`,
    );
    assert.ok(widths[1] < widths[0], 'a time narrower still');
    assert.ok(widths[2] > widths[0], 'and both together wider');
    cleanup();
    const two = await render2x(markup);
    const doubled = ['d', 't', 'l'].map(
      (id) => boxOf(view(two.node), id).width,
    );
    for (let i = 0; i < 3; i++) {
      assert.ok(
        Math.abs(doubled[i] - widths[i] * 2) <= 4,
        `the same size in logical pixels: ${doubled[i]} for ${widths[i]}`,
      );
    }
  },
);
