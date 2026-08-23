// <ColorPicker>, <ColorField>, and the colour arithmetic under them.
//
// The arithmetic is tested directly because it is exported API in its own
// right, and because the subtle bugs live there: a hue that does not survive
// a trip through black, a format that emits a string this renderer cannot
// paint, a round trip that drifts.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, screen, userEvent } from 'react-x11/test';
import { XK_DOWN, XK_LEFT, XK_RIGHT, XK_ESCAPE } from 'react-x11/keysyms';
import type { Node as RetainedNode } from 'react-x11/node';
import type { DrawnNode } from 'react-x11';

import { ColorPicker, ColorField } from '../src/index.js';
import {
  channelsFromHsv,
  contrastGrade,
  contrastRatio,
  formatColor,
  formatOf,
  parseColor,
  rgbToHsv,
  hsvToRgb,
} from '../src/index.js';
import type { ColorChangeEvent } from '../src/index.js';

const h = React.createElement;

afterEach(cleanup);

/** The queries hand back the retained node; their public type describes the
 *  narrower ref-facing view. Same widening as `calendar.test.ts`. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

function byLabel(label: string): DrawnNode {
  const [node] = screen.all((n) => retained(n).props['aria-label'] === label);
  assert.ok(node, `no node labelled ${JSON.stringify(label)}`);
  return node;
}

function maybeByLabel(label: string): DrawnNode | undefined {
  return screen.all((n) => retained(n).props['aria-label'] === label)[0];
}

/** Every `<canvas>` on screen, with the props the drawing was keyed on. */
function canvases(): RetainedNode[] {
  return screen.all((n) => retained(n).kind === 'canvas').map(retained);
}

// --- the arithmetic --------------------------------------------------------

test('parses every spelling a person might paste in', () => {
  const cases: [string, string][] = [
    ['#3498db', '#3498db'],
    ['#39d', '#3399dd'],
    ['#3498db80', '#3498db'],
    ['rgb(52, 152, 219)', '#3498db'],
    ['rgba(52,152,219,0.5)', '#3498db'],
    // The modern space-separated syntax is read even though the renderer
    // cannot paint it — normalizing is what a picker is for.
    ['rgb(52 152 219 / 50%)', '#3498db'],
    ['hsl(204 70% 53%)', '#3398db'],
    ['hsl(204deg, 70%, 53%)', '#3398db'],
    ['rebeccapurple', '#663399'],
  ];
  for (const [input, hex] of cases) {
    const parsed = parseColor(input);
    assert.ok(parsed, `${input} did not parse`);
    assert.strictEqual(formatColor(parsed, 'hex', false), hex, input);
  }
});

test('rejects what is not a colour, including the syntaxes it cannot emit', () => {
  for (const input of [
    '',
    'nope',
    '#12345',
    'oklch(70% 0.1 200)',
    'rgb(1, 2)',
  ]) {
    assert.strictEqual(parseColor(input), null, input);
  }
});

test('alpha survives hex and the functional forms, and only when asked for', () => {
  const half = parseColor('#3498db80');
  assert.ok(half);
  assert.strictEqual(formatColor(half, 'hex', true), '#3498db80');
  assert.strictEqual(formatColor(half, 'rgb', true), 'rgba(52, 152, 219, 0.5)');
  // A picker without an alpha strip must not start emitting `rgba()` because
  // the value it was handed had one.
  assert.strictEqual(formatColor(half, 'hex', false), '#3498db');
  assert.strictEqual(formatColor(half, 'rgb', false), 'rgb(52, 152, 219)');
});

test('everything it emits is a colour the renderer can paint', () => {
  // The legacy comma spelling is not a style choice: ntk hands anything that
  // is not hex to `parse-color`, which does not know the modern one.
  const c = parseColor('hsl(204, 70%, 53%)');
  assert.ok(c);
  for (const format of ['hex', 'rgb', 'hsl'] as const) {
    for (const alpha of [false, true]) {
      const text = formatColor({ ...c, a: 0.5 }, format, alpha);
      assert.ok(parseColor(text), `${text} did not round trip`);
      assert.ok(!/\d\s+\d|\//.test(text), `${text} used the modern syntax`);
    }
  }
});

test('hsv round trips, and grey keeps the hue it was given', () => {
  for (let hue = 0; hue < 360; hue += 30) {
    const { r, g, b } = hsvToRgb(hue, 1, 1);
    assert.strictEqual(Math.round(rgbToHsv(r, g, b).h), hue);
  }
  // The whole reason the widget holds HSV rather than a string: black has no
  // hue to read back out of it.
  const black = channelsFromHsv(204, 0.7, 0);
  assert.strictEqual(formatColor(black, 'hex', false), '#000000');
  assert.strictEqual(black.h, 204);
});

test('formatOf reports the spelling a value was written in', () => {
  assert.strictEqual(formatOf('#3498db'), 'hex');
  assert.strictEqual(formatOf('rgba(1,2,3,.5)'), 'rgb');
  assert.strictEqual(formatOf('hsl(204, 70%, 53%)'), 'hsl');
  assert.strictEqual(formatOf('rebeccapurple'), null);
});

test('contrast is WCAG', () => {
  assert.strictEqual(contrastRatio('#ffffff', '#000000'), 21);
  assert.strictEqual(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.strictEqual(contrastGrade(21), 'AAA');
  assert.strictEqual(contrastGrade(4.6), 'AA');
  assert.strictEqual(contrastGrade(3), 'fail');
  assert.strictEqual(contrastRatio('nope', '#000'), null);
});

// --- what renders ----------------------------------------------------------

test('the default panel is the field, the hue slider and the value row', async () => {
  await renderX11(h(ColorPicker, { defaultValue: '#3498db' }), {
    backend: 'mock',
  });
  byLabel('Saturation and brightness');
  byLabel('Hue');
  byLabel('Colour value');
  assert.strictEqual(
    maybeByLabel('Opacity'),
    undefined,
    'no alpha strip unasked',
  );
});

test('alpha adds the strip', async () => {
  await renderX11(h(ColorPicker, { defaultValue: '#3498db', alpha: true }), {
    backend: 'mock',
  });
  byLabel('Opacity');
});

test('parts is the whole layout — a palette-only picker is the same element', async () => {
  await renderX11(
    h(ColorPicker, {
      defaultValue: '#3498db',
      swatches: ['#e74c3c', '#2ecc71'],
      parts: ['swatches'],
    }),
    { backend: 'mock' },
  );
  assert.strictEqual(maybeByLabel('Saturation and brightness'), undefined);
  assert.strictEqual(maybeByLabel('Hue'), undefined);
  byLabel('#e74c3c');
  byLabel('#2ecc71');
});

test('every axis says its value in words, for a screen reader', async () => {
  await renderX11(
    h(ColorPicker, { defaultValue: 'hsl(204, 70%, 53%)', alpha: true }),
    { backend: 'mock' },
  );
  assert.match(
    String(retained(byLabel('Hue')).props['aria-valuetext']),
    /hue 204 degrees/,
  );
  assert.match(
    String(
      retained(byLabel('Saturation and brightness')).props['aria-valuetext'],
    ),
    /saturation 77%, brightness 86%/,
  );
  assert.match(
    String(retained(byLabel('Opacity')).props['aria-valuetext']),
    /opacity 100%/,
  );
});

test('the panes are cached on everything their drawing reads', async () => {
  await renderX11(h(ColorPicker, { defaultValue: 'hsl(204, 70%, 53%)' }), {
    backend: 'mock',
  });
  const keys = canvases().map((n) => String(n.props.cacheKey ?? ''));
  // The saturation/value field is keyed on the hue: everything else about it
  // is a constant, which is why the geometry is fixed.
  assert.ok(
    keys.some((k) => k.startsWith('sv:204:')),
    `no hue-keyed field in ${JSON.stringify(keys)}`,
  );
  // The hue ramp never changes at all.
  assert.ok(
    keys.some((k) => k.startsWith('hue:')),
    'no hue ramp',
  );
});

// --- interaction -----------------------------------------------------------

test('a swatch is a colour, and the change event carries both spellings of it', async () => {
  const changes: ColorChangeEvent[] = [];
  await renderX11(
    h(ColorPicker, {
      defaultValue: '#000000',
      name: 'accent',
      swatches: ['#3498db'],
      onChange: (ev: ColorChangeEvent) => changes.push(ev),
    }),
  );
  await userEvent.click(byLabel('#3498db'));
  assert.strictEqual(changes.length, 1);
  const [ev] = changes;
  assert.strictEqual(ev.value, '#3498db');
  assert.strictEqual(ev.name, 'accent');
  assert.strictEqual(ev.target.value, '#3498db');
  assert.strictEqual(ev.color.r, 52);
  assert.strictEqual(Math.round(ev.color.h), 204);
});

test('arrows drive the focused axis, and each step is a commit', async () => {
  const changes: string[] = [];
  const ends: string[] = [];
  await renderX11(
    h(ColorPicker, {
      defaultValue: 'hsl(204, 70%, 53%)',
      onChange: (ev: ColorChangeEvent) => changes.push(ev.value),
      onChangeEnd: (ev: ColorChangeEvent) => ends.push(ev.value),
    }),
  );
  const hue = byLabel('Hue');
  hue.focus();
  await userEvent.key(XK_RIGHT, { target: hue });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(
    ends.length,
    1,
    'a keyboard step is finished when it lands',
  );
  assert.match(
    String(retained(hue).props['aria-valuetext']),
    /hue 205 degrees/,
  );
});

test('shift is the coarse step', async () => {
  await renderX11(h(ColorPicker, { defaultValue: 'hsl(204, 70%, 53%)' }));
  const hue = byLabel('Hue');
  hue.focus();
  await userEvent.key(XK_RIGHT, { target: hue, modifiers: ['Shift'] });
  assert.match(
    String(retained(hue).props['aria-valuetext']),
    /hue 214 degrees/,
  );
});

test('the hue survives a trip through black', async () => {
  // The bug every string-valued picker has unless it is designed out: drag
  // the brightness to zero and the string is #000000, which has no hue in it.
  const values: string[] = [];
  await renderX11(
    h(ColorPicker, {
      defaultValue: 'hsl(204, 70%, 53%)',
      onChange: (ev: ColorChangeEvent) => values.push(ev.value),
    }),
  );
  const area = byLabel('Saturation and brightness');
  area.focus();
  // Ten coarse steps of the brightness axis is the whole of it.
  for (let i = 0; i < 10; i += 1) {
    await userEvent.key(XK_DOWN, { target: area, modifiers: ['Shift'] });
  }
  const black = parseColor(String(values.at(-1)));
  assert.ok(
    black && formatColor(black, 'hex', false) === '#000000',
    'reached black',
  );
  await userEvent.key(XK_LEFT, { target: area }); // and moved while there
  assert.match(
    String(retained(byLabel('Hue')).props['aria-valuetext']),
    /hue 204 degrees/,
    'the hue slider did not snap to red',
  );
});

test('a controlled picker that is echoed its own value does not lose the model', async () => {
  function Controlled(): React.ReactElement {
    const [colour, setColour] = React.useState('hsl(204, 70%, 53%)');
    return h(ColorPicker, {
      value: colour,
      onChange: (ev: ColorChangeEvent) => setColour(ev.value),
    });
  }
  await renderX11(h(Controlled));
  const area = byLabel('Saturation and brightness');
  area.focus();
  for (let i = 0; i < 12; i += 1) {
    await userEvent.key(XK_DOWN, { target: area, modifiers: ['Shift'] });
  }
  assert.match(
    String(retained(byLabel('Hue')).props['aria-valuetext']),
    /hue 204 degrees/,
  );
});

test('a controlled picker follows a value it did not emit', async () => {
  const { rerender } = await renderX11(
    h(ColorPicker, { value: '#3498db', onChange: () => {} }),
    { backend: 'mock' },
  );
  await rerender(h(ColorPicker, { value: '#e74c3c', onChange: () => {} }));
  assert.match(
    String(retained(byLabel('Hue')).props['aria-valuetext']),
    /hue 6 degrees/,
  );
});

test('format follows the spelling it was given, and format overrides that', async () => {
  const values: string[] = [];
  await renderX11(
    h(ColorPicker, {
      defaultValue: 'rgb(52, 152, 219)',
      onChange: (ev: ColorChangeEvent) => values.push(ev.value),
      swatches: ['#e74c3c'],
    }),
  );
  await userEvent.click(byLabel('#e74c3c'));
  assert.strictEqual(
    values.at(-1),
    '#e74c3c',
    'a swatch brings its own spelling',
  );

  cleanup();
  const forced: string[] = [];
  await renderX11(
    h(ColorPicker, {
      defaultValue: '#3498db',
      format: 'hsl',
      onChange: (ev: ColorChangeEvent) => forced.push(ev.value),
    }),
  );
  const hue = byLabel('Hue');
  hue.focus();
  await userEvent.key(XK_RIGHT, { target: hue });
  assert.match(String(forced.at(-1)), /^hsl\(205, /);
});

test('the eyedropper is a seam: a sampler of your own replaces core’s', async () => {
  const values: string[] = [];
  await renderX11(
    h(ColorPicker, {
      defaultValue: '#000000',
      eyedropper: async () => '#3498db',
      onChange: (ev: ColorChangeEvent) => values.push(ev.value),
    }),
  );
  await userEvent.click(byLabel('Pick a colour from the screen'));
  // The pick is a promise; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(values.at(-1), '#3498db');
});

test('a cancelled pick leaves the colour alone', async () => {
  const values: string[] = [];
  await renderX11(
    h(ColorPicker, {
      defaultValue: '#000000',
      eyedropper: async () => null,
      onChange: (ev: ColorChangeEvent) => values.push(ev.value),
    }),
  );
  await userEvent.click(byLabel('Pick a colour from the screen'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(values, []);
});

test('eyedropper={false} is no button at all', async () => {
  await renderX11(h(ColorPicker, { defaultValue: '#000', eyedropper: false }), {
    backend: 'mock',
  });
  assert.strictEqual(maybeByLabel('Pick a colour from the screen'), undefined);
});

// --- the field -------------------------------------------------------------

test('<ColorField> opens on the press and closes on Escape', async () => {
  await renderX11(h(ColorField, { defaultValue: '#3498db' }));
  assert.strictEqual(
    maybeByLabel('Colour picker'),
    undefined,
    'shut to begin with',
  );
  const trigger = byLabel('Colour');
  await userEvent.click(trigger);
  byLabel('Colour picker');
  await userEvent.key(XK_ESCAPE, { target: trigger });
  assert.strictEqual(
    maybeByLabel('Colour picker'),
    undefined,
    'Escape shut it',
  );
});

test('<ColorField> keeps the keyboard and feeds the panel its keys', async () => {
  const values: string[] = [];
  await renderX11(
    h(ColorField, {
      defaultValue: 'hsl(204, 70%, 53%)',
      onChange: (ev: ColorChangeEvent) => values.push(ev.value),
    }),
  );
  const trigger = byLabel('Colour');
  await userEvent.click(trigger);
  // The popup never takes focus, so the arrows arrive at the trigger and the
  // panel gets them through its handle.
  await userEvent.key(XK_RIGHT, { target: trigger });
  assert.strictEqual(values.length, 1, 'the panel took the key');
});

test('<ColorField> shows the value, and a placeholder when there is none', async () => {
  await renderX11(h(ColorField, { placeholder: 'No fill' }), {
    backend: 'mock',
  });
  screen.getByText('No fill');
  cleanup();
  await renderX11(h(ColorField, { defaultValue: '#3498db' }), {
    backend: 'mock',
  });
  screen.getByText('#3498db');
});
