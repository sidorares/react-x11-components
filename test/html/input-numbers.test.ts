// <Html scripts>' `valueAsNumber`, `valueAsDate`, `stepUp()` and
// `stepDown()` (HTML 4.10.5.4) over the types whose value is a place on a
// line: date, month, week, time, datetime-local, number and range. The
// cases are WPT's `html/semantics/forms/the-input-element/input-valueas*`
// and `input-step*` tests, and Chromium's answers where HTML leaves the
// arithmetic open.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What a function of the page's comes to, through JSON. A number is
 *  handed back as `String()` has it, so that NaN survives. */
async function inPage(code: string): Promise<unknown> {
  const page = await scriptedPage(
    `<script>
       function input(type, attributes) {
         var el = document.createElement('input');
         el.type = type;
         for (var name in attributes || {}) el.setAttribute(name, attributes[name]);
         document.body.appendChild(el);
         return el;
       }
       function thrown(f) {
         try { f(); return 'none'; } catch (e) { return e.name; }
       }
       console.log("out " + JSON.stringify((function () {${code}})()));
     </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

/** What a page reads of `valueAsNumber` for each value, and the value it
 *  comes to for each number it sets, which cross as text, NaN and -0 among
 *  them. */
async function readsAndSets(
  type: string,
  reads: [string, number][],
  sets: [number, string][],
  attributes: Record<string, string> = {},
): Promise<void> {
  const out = (await inPage(
    `var el = input(${JSON.stringify(type)}, ${JSON.stringify(attributes)});
     var reads = ${JSON.stringify(reads.map(([v]) => v))}.map(function (v) {
       el.value = v;
       return String(el.valueAsNumber);
     });
     var sets = ${JSON.stringify(sets.map(([n]) => (Object.is(n, -0) ? '-0' : String(n))))}.map(function (n) {
       el.valueAsNumber = Number(n);
       return el.value;
     });
     return [reads, sets];`,
  )) as [string[], string[]];
  assert.deepEqual(
    out[0],
    reads.map(([, n]) => String(n)),
    `${type}: valueAsNumber read`,
  );
  assert.deepEqual(
    out[1],
    sets.map(([, v]) => v),
    `${type}: valueAsNumber set`,
  );
}

test('a date reads and sets as milliseconds since the epoch', async () => {
  await readsAndSets(
    'date',
    [
      ['', NaN],
      ['0000-12-10', NaN],
      ['2019-00-12', NaN],
      ['2019-12-00', NaN],
      ['2019-13-10', NaN],
      ['2019-02-29', NaN],
      ['2019-12-10', 1575936000000],
      ['2016-02-29', 1456704000000],
      ['2026-11-25', Date.UTC(2026, 10, 25)],
      ['12345-06-07', Date.UTC(12345, 5, 7)],
    ],
    [
      [0, '1970-01-01'],
      [1575936000000, '2019-12-10'],
      [1456704000000, '2016-02-29'],
      // the day the instant falls on, before the epoch too
      [Date.UTC(2026, 10, 25, 23, 59), '2026-11-25'],
      [-1, '1969-12-31'],
      [Date.UTC(999, 0, 1), '0999-01-01'],
      // past the first and the last day HTML and a Date have
      [-62135596800001, ''],
      [8640000000000001, ''],
      [NaN, ''],
    ],
  );
});

test('a month reads and sets as months since 1970-01', async () => {
  await readsAndSets(
    'month',
    [
      ['', NaN],
      ['0000-12', NaN],
      ['2019-00', NaN],
      ['2019-13', NaN],
      ['2019-12', 599],
      ['1969-12', -1],
      ['2026-11', 682],
    ],
    [
      [599, '2019-12'],
      [-1, '1969-12'],
      [682, '2026-11'],
      // a fraction of a month is the nearest month
      [682.4, '2026-11'],
      [-23629, ''],
    ],
  );
});

test('a week reads and sets as its Monday in milliseconds', async () => {
  await readsAndSets(
    'week',
    [
      ['', NaN],
      ['0000-W50', NaN],
      ['2019-W00', NaN],
      ['2019-W60', NaN],
      ['2019-W53', NaN],
      ['2020-W53', Date.UTC(2020, 11, 28)],
      ['2019-W50', 1575849600000],
      ['1969-W20', -20217600000],
    ],
    [
      [0, '1970-W01'],
      [1575849600000, '2019-W50'],
      [-20217600000, '1969-W20'],
      // the week the day is in, which may be the year before's or after's
      [Date.UTC(2021, 0, 3), '2020-W53'],
      [Date.UTC(2024, 11, 30), '2025-W01'],
      [Date.UTC(2026, 10, 25, 12), '2026-W48'],
    ],
  );
});

test('a time reads and sets as milliseconds since midnight, going round the clock', async () => {
  await readsAndSets(
    'time',
    [
      ['', NaN],
      ['24:00', NaN],
      ['00:60', NaN],
      ['00:00', 0],
      ['12:00', 12 * 3600 * 1000],
      ['23:59', (23 * 3600 + 59 * 60) * 1000],
      ['08:30:15.25', (8 * 3600 + 30 * 60 + 15) * 1000 + 250],
    ],
    [
      [0, '00:00'],
      [12 * 3600 * 1000, '12:00'],
      [(23 * 3600 + 59 * 60) * 1000, '23:59'],
      [2.7343337071894478e26, '10:54:10.944'],
      [-3600 * 1000, '23:00'],
      [86400000 + 61000, '00:01:01'],
      [250, '00:00:00.250'],
    ],
  );
});

test('a time is written as finely as its step reaches', async () => {
  const out = await inPage(
    `var steps = [null, '60', '900', '1', '30', '0.5', 'any'];
     return steps.map(function (step) {
       var el = input('time', step === null ? {} : { step: step });
       el.valueAsNumber = 3600000;
       return el.value;
     });`,
  );
  assert.deepEqual(out, [
    '01:00',
    '01:00',
    '01:00',
    '01:00:00',
    '01:00:00',
    '01:00:00.000',
    '01:00',
  ]);
});

test('a datetime-local reads and sets as milliseconds, written as short as it can be', async () => {
  await readsAndSets(
    'datetime-local',
    [
      ['', NaN],
      ['2019-12-10T00:00', 1575936000000],
      ['2019-12-10T12:00', 1575979200000],
      ['2019-12-10 12:00', 1575979200000],
      ['2019-12-10T24:00', NaN],
      ['2026-11-25T09:05:30.5', Date.UTC(2026, 10, 25, 9, 5, 30, 500)],
    ],
    [
      [1575936000000, '2019-12-10T00:00'],
      [1575979200000, '2019-12-10T12:00'],
      [-1000 * 3600 * 24, '1969-12-31T00:00'],
      [2.7343337071894478e26, ''],
      [Date.UTC(2022, 3, 19, 12, 34, 56, 10), '2022-04-19T12:34:56.01'],
      [Date.UTC(2022, 3, 19, 12, 34, 56), '2022-04-19T12:34:56'],
    ],
    // a step in seconds writes no seconds into a datetime-local, which
    // Blink's sanitization takes back off
    { step: '1' },
  );
});

test('a number and a range read and set as themselves', async () => {
  await readsAndSets(
    'number',
    [
      ['', NaN],
      ['123', 123],
      ['123.456', 123.456],
      ['1e3', 1000],
      ['1e', NaN],
      ['-123', -123],
    ],
    [
      [123, '123'],
      [123.456, '123.456'],
      [1e3, '1000'],
      [-123, '-123'],
      [-0, '0'],
    ],
  );
  await readsAndSets(
    'range',
    [
      ['', 50],
      ['0', 0],
      ['50', 50],
      ['100', 100],
      ['-10', 0],
      ['110', 100],
    ],
    [
      [0, '0'],
      [50, '50'],
      [100, '100'],
    ],
    { min: '0', max: '100' },
  );
});

test('valueAsNumber is refused where it does not apply, and for an infinity', async () => {
  const out = await inPage(
    `var text = input('text', { value: '12' });
     var box = input('checkbox');
     var date = input('date', { value: '2026-11-25' });
     var number = input('number');
     return [
       String(text.valueAsNumber),
       thrown(function () { text.valueAsNumber = 5; }),
       thrown(function () { box.valueAsNumber = 5; }),
       thrown(function () { box.valueAsNumber = Infinity; }),
       thrown(function () { date.valueAsNumber = -Infinity; }),
       thrown(function () { number.valueAsNumber = Symbol(); }),
       date.value,
       (number.valueAsNumber = '15', number.value),
       (number.valueAsNumber = NaN, number.value),
       (date.valueAsNumber = NaN, date.value),
     ];`,
  );
  assert.deepEqual(out, [
    'NaN',
    'InvalidStateError',
    'InvalidStateError',
    'TypeError',
    'TypeError',
    'TypeError',
    '2026-11-25',
    '15',
    '',
    '',
  ]);
});

test('valueAsDate reads and sets a date, a month, a week and a time', async () => {
  const out = await inPage(
    `var cases = [
       ['date', ['', '2019-02-29', '2019-12-10', '2016-02-29'], ['2019-12-10T00:00:00.000Z', '2026-11-25T23:30:00.000Z']],
       ['month', ['', '0000-12', '2019-12', '1969-02'], ['2019-12-01T00:00:00.000Z', '2026-11-30T23:00:00.000Z']],
       ['week', ['', '2019-W60', '2019-W50'], ['2019-12-09T00:00:00.000Z', '2026-11-29T12:00:00.000Z']],
       ['time', ['', '24:00', '00:00', '12:00', '23:59:30.5'], ['1970-01-01T12:00:00.000Z', '2026-11-25T09:15:00.000Z']],
     ];
     return cases.map(function (c) {
       var el = input(c[0]);
       var reads = c[1].map(function (v) {
         el.value = v;
         var d = el.valueAsDate;
         return d === null ? null : [d instanceof Date, d.toISOString()];
       });
       var sets = c[2].map(function (iso) {
         el.valueAsDate = new Date(iso);
         return el.value;
       });
       return [reads, sets];
     });`,
  );
  assert.deepEqual(out, [
    [
      [
        null,
        null,
        [true, '2019-12-10T00:00:00.000Z'],
        [true, '2016-02-29T00:00:00.000Z'],
      ],
      ['2019-12-10', '2026-11-25'],
    ],
    [
      [
        null,
        null,
        [true, '2019-12-01T00:00:00.000Z'],
        [true, '1969-02-01T00:00:00.000Z'],
      ],
      ['2019-12', '2026-11'],
    ],
    [
      [null, null, [true, '2019-12-09T00:00:00.000Z']],
      ['2019-W50', '2026-W48'],
    ],
    [
      [
        null,
        null,
        [true, '1970-01-01T00:00:00.000Z'],
        [true, '1970-01-01T12:00:00.000Z'],
        [true, '1970-01-01T23:59:30.500Z'],
      ],
      ['12:00', '09:15'],
    ],
  ]);
});

test('valueAsDate clears with null, refuses what is no Date, and is not a datetime-local’s', async () => {
  const out = await inPage(
    `var date = input('date', { value: '2026-11-25' });
     var local = input('datetime-local', { value: '2026-01-01T00:00' });
     var box = input('checkbox');
     var out = [];
     out.push(thrown(function () { date.valueAsDate = {}; }), date.value);
     out.push(thrown(function () { date.valueAsDate = 1764028800000; }));
     date.valueAsDate = new Date(NaN);
     out.push(date.value);
     date.value = '2026-11-25';
     date.valueAsDate = null;
     out.push(date.value, date.valueAsDate);
     date.value = '2026-11-25';
     date.valueAsDate = undefined;
     out.push(date.value);
     out.push(local.valueAsDate);
     out.push(thrown(function () { local.valueAsDate = new Date(0); }), local.value);
     out.push(box.valueAsDate);
     out.push(thrown(function () { box.valueAsDate = new Date(0); }));
     return out;`,
  );
  assert.deepEqual(out, [
    'TypeError',
    '2026-11-25',
    'TypeError',
    '',
    '',
    null,
    '',
    null,
    'InvalidStateError',
    '2026-01-01T00:00',
    null,
    'InvalidStateError',
  ]);
});

test('a type steps by its own step from nothing, and by what step says', async () => {
  // WPT's input-stepup.html: a step from an empty field, and the next one
  const out = await inPage(
    `var types = ['date', 'datetime-local', 'month', 'number', 'range', 'time', 'week'];
     return types.map(function (type) {
       return [undefined, '0', '-2', 'bogus', '2', '1.6'].map(function (step) {
         var el = input(type, step === undefined ? {} : { step: step });
         el.stepUp();
         var first = el.value;
         var before = el.valueAsNumber;
         el.stepUp();
         return [first, Number((el.valueAsNumber - before).toFixed(6))];
       });
     });`,
  );
  const day = 86400000;
  const unit = (one: number, step = 1): number => one * step;
  assert.deepEqual(out, [
    [
      ['1970-01-02', day],
      ['1970-01-02', day],
      ['1970-01-02', day],
      ['1970-01-02', day],
      ['1970-01-03', 2 * day],
      // a date's step is a whole number of days
      ['1970-01-03', 2 * day],
    ],
    [
      ['1970-01-01T00:01', 60000],
      ['1970-01-01T00:01', 60000],
      ['1970-01-01T00:01', 60000],
      ['1970-01-01T00:01', 60000],
      ['1970-01-01T00:00:02', 2000],
      ['1970-01-01T00:00:01.6', 1600],
    ],
    [
      ['1970-02', 1],
      ['1970-02', 1],
      ['1970-02', 1],
      ['1970-02', 1],
      ['1970-03', 2],
      ['1970-03', 2],
    ],
    [
      ['1', 1],
      ['1', 1],
      ['1', 1],
      ['1', 1],
      ['2', 2],
      ['1.6', 1.6],
    ],
    [
      // a range starts half way along its line
      ['51', 1],
      ['51', 1],
      ['51', 1],
      ['51', 1],
      ['52', 2],
      ['51.2', 1.6],
    ],
    [
      ['00:01', 60000],
      ['00:01', 60000],
      ['00:01', 60000],
      ['00:01', 60000],
      ['00:00:02', 2000],
      ['00:00:01.600', 1600],
    ],
    [
      // a week's steps count from 1970-W01's Monday, so nothing goes to
      // 1970-W02, the next step from 0
      ['1970-W02', unit(7 * day)],
      ['1970-W02', unit(7 * day)],
      ['1970-W02', unit(7 * day)],
      ['1970-W02', unit(7 * day)],
      ['1970-W03', unit(7 * day, 2)],
      ['1970-W03', unit(7 * day, 2)],
    ],
  ]);
});

test('a step is refused where it does not apply, and at step=any', async () => {
  const out = await inPage(
    `var types = ['button', 'checkbox', 'color', 'email', 'file', 'hidden',
       'image', 'password', 'radio', 'reset', 'search', 'submit', 'tel',
       'text', 'url'];
     var out = types.map(function (type) {
       var el = input(type);
       return thrown(function () { el.stepUp(); }) + ' ' +
         thrown(function () { el.stepDown(); });
     });
     var any = input('date', { step: 'ANY', value: '2026-11-25' });
     out.push(thrown(function () { any.stepUp(); }), any.value);
     out.push(thrown(function () { input('date').stepUp(Symbol()); }));
     return out;`,
  );
  assert.deepEqual(out, [
    ...Array(15).fill('InvalidStateError InvalidStateError'),
    'InvalidStateError',
    '2026-11-25',
    'TypeError',
  ]);
});

test('a step keeps to min and max, and does not go the wrong way', async () => {
  const out = await inPage(
    `var out = [];
     function step(type, attributes, value, by) {
       var el = input(type, attributes);
       el.value = value;
       if (by < 0) el.stepDown(-by); else el.stepUp(by);
       return el.value;
     }
     // clamped to the last step at or under max, and the first at or over min
     out.push(step('date', { max: '2026-11-28' }, '2026-11-25', 5));
     out.push(step('date', { min: '2026-11-01', max: '2026-11-28', step: '7' }, '2026-11-22', 1));
     out.push(step('date', { min: '2026-11-20' }, '2026-11-25', -10));
     out.push(step('month', { min: '2026-01', max: '2026-12', step: '5' }, '2026-06', 4));
     out.push(step('week', { max: '2026-W50' }, '2026-W48', 3));
     out.push(step('time', { min: '09:00', max: '17:00', step: '1800' }, '16:30', 3));
     out.push(step('datetime-local', { max: '2026-11-25T12:00' }, '2026-11-25T11:58', 5));
     out.push(step('number', { step: '3', max: '7' }, '0', 3));
     // a value already past a limit is not moved back past it the other way
     out.push(step('date', { min: '2011-02-10', step: '1' }, '2010-02-10', -1));
     out.push(step('month', { min: '2011-02' }, '2010-02', -1));
     out.push(step('week', { min: '2011-W02' }, '2010-W02', -1));
     out.push(step('time', { min: '21:13' }, '20:13', -1));
     out.push(step('datetime-local', { min: '2011-02-10T20:13', step: '1' }, '2010-02-10T20:13', -1));
     out.push(step('number', { min: '300' }, '200', -1));
     // a time does not go round past midnight
     out.push(step('time', {}, '23:59', 1));
     // a minimum above the maximum steps nowhere
     out.push(step('date', { min: '2026-12-01', max: '2026-11-01' }, '2026-11-15', 1));
     return out;`,
  );
  assert.deepEqual(out, [
    '2026-11-28',
    '2026-11-22',
    '2026-11-20',
    '2026-11',
    '2026-W50',
    '17:00',
    '2026-11-25T12:00',
    '6',
    '2010-02-10',
    '2010-02',
    '2010-W02',
    '20:13',
    '2010-02-10T20:13',
    '200',
    '23:59',
    '2026-11-15',
  ]);
});

test('an empty field steps from 0, which the limits move either way', async () => {
  // WPT's input-stepdown-02.html, and the same for a date
  const out = await inPage(
    `return [['', '', -1], ['', '7', -1], ['', '-7', -1], ['7', '7', -1],
       ['3', '7', -1], ['10', '7', -1], ['', '7', 1]].map(function (c) {
       var el = input('number');
       el.value = c[0];
       el.min = c[1];
       if (c[2] < 0) el.stepDown(); else el.stepUp();
       return el.value;
     }).concat([
       (function () {
         var el = input('date', { min: '2026-11-25' });
         el.stepDown();
         return el.value;
       })(),
       (function () {
         var el = input('date', { max: '1960-01-01' });
         el.stepUp();
         return el.value;
       })(),
     ]);`,
  );
  assert.deepEqual(out, [
    '-1',
    '7',
    '-1',
    '7',
    '3',
    '9',
    '7',
    '2026-11-25',
    '1960-01-01',
  ]);
});

test('a value off its steps goes to the next step the way it is stepped, then on', async () => {
  const out = await inPage(
    `function step(type, attributes, value, by) {
       var el = input(type, attributes);
       el.value = value;
       if (by < 0) el.stepDown(-by); else el.stepUp(by);
       return el.value;
     }
     return [
       // steps of a week from the 1st
       step('date', { min: '2026-11-01', step: '7' }, '2026-11-05', 1),
       step('date', { min: '2026-11-01', step: '7' }, '2026-11-05', -1),
       // Blink goes the rest of n on from the step it went to
       step('date', { min: '2026-11-01', step: '7' }, '2026-11-05', 3),
       step('date', { value: '2026-11-01', step: '7' }, '2026-11-12', -2),
       // counted from the value attribute where there is no min
       step('date', { value: '2026-11-03', step: '2' }, '2026-11-06', 1),
       step('month', { min: '2026-01', step: '3' }, '2026-02', 1),
       step('month', { min: '2026-01', step: '3' }, '2026-02', -1),
       step('week', { min: '2026-W01', step: '2' }, '2026-W04', 1),
       step('week', { min: '2026-W01', step: '2' }, '2026-W04', -1),
       step('time', { step: '900' }, '10:07', 1),
       step('time', { step: '900' }, '10:07', -1),
       step('datetime-local', { step: '900' }, '2026-11-25T10:07', 1),
       step('datetime-local', { step: '900' }, '2026-11-25T10:07', -1),
       step('number', { min: '0', step: '2' }, '5', 1),
       step('number', { step: '3' }, '8', -1),
       // a double's error is not a step off
       step('number', { step: '0.3' }, '1.2', -1),
       step('number', { step: '0.1' }, '0.3', 1),
       // a negative n steps the other way
       step('date', {}, '2026-11-25', -2),
       step('date', {}, '2026-11-25', 0),
     ];`,
  );
  assert.deepEqual(out, [
    '2026-11-08',
    '2026-11-01',
    '2026-11-22',
    '2026-11-01',
    '2026-11-07',
    '2026-04',
    '2026-01',
    '2026-W05',
    '2026-W03',
    '10:15',
    '10:00',
    '2026-11-25T10:15',
    '2026-11-25T10:00',
    '6',
    '6',
    '0.9',
    '0.4',
    '2026-11-23',
    '2026-11-25',
  ]);
});

test('a value set through valueAsNumber or a step passes by a value accessor a page put on the element', async () => {
  // React's value tracking defines `value` on each input it renders, and keeps
  // what its setter is handed: a browser's valueAsNumber, valueAsDate and
  // stepUp() never call it
  const out = await inPage(
    `var el = input('date', { value: '2026-11-25' });
     var told = [];
     var proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
     Object.defineProperty(el, 'value', {
       configurable: true,
       get: function () { return proto.get.call(this); },
       set: function (v) { told.push('set ' + v); proto.set.call(this, v); },
     });
     var read = el.valueAsNumber;
     el.valueAsNumber = read + 86400000;
     el.stepUp();
     el.valueAsDate = new Date(Date.UTC(2026, 0, 1));
     var date = el.valueAsDate.toISOString();
     return [told, el.value, date];`,
  );
  assert.deepEqual(out, [[], '2026-01-01', '2026-01-01T00:00:00.000Z']);
});

test('valueAsNumber and the steps agree with each other, a step up and back down', async () => {
  // WPT's input-valueasnumber-stepping.html and input-valueasdate-stepping.html
  const out = await inPage(
    `var day = 86400000;
     var cases = [['date', 0, day], ['time', 0, 60000], ['month', 0, 1],
       ['week', 4 * day, 7 * day], ['datetime-local', 0, 60000],
       ['range', 22, 1], ['number', 24, 1]];
     return cases.map(function (c) {
       var el = input(c[0]);
       el.valueAsNumber = c[1];
       var first = [el.value, el.valueAsNumber === c[1]];
       el.stepUp();
       var up = [el.value, el.valueAsNumber === c[1] + c[2]];
       el.stepDown();
       return [first, up, el.valueAsNumber === c[1]];
     });`,
  );
  assert.deepEqual(out, [
    [['1970-01-01', true], ['1970-01-02', true], true],
    [['00:00', true], ['00:01', true], true],
    [['1970-01', true], ['1970-02', true], true],
    [['1970-W02', true], ['1970-W03', true], true],
    [['1970-01-01T00:00', true], ['1970-01-01T00:01', true], true],
    [['22', true], ['23', true], true],
    [['24', true], ['25', true], true],
  ]);
});
