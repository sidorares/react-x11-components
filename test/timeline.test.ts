// <Timeline> — the composition, and the four decisions inside it that a
// reader of the source would not guess: the line spans the whole item and is
// painted *under* the indicator, the last step drops both the line and the
// gap under it, an indicator's chip is opaque so the line cannot show
// through, and prose children are wrapped so a string is legal where the API
// takes one.
//
// Everything here runs on the mock backend: none of it is about pixels, and
// the geometry that is (the line's height, its offset under the indicator)
// comes off the layout, which the mock runs in full.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, screen } from 'react-x11/test';
import { ThemeProvider } from 'react-x11';
import type { Node as RetainedNode } from 'react-x11/node';

import {
  Timeline,
  TimelineConnector,
  TimelineContent,
  TimelineDescription,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from '../src/index.js';
import type { TimelineProps, TimelineIndicatorProps } from '../src/index.js';

const h = React.createElement;

afterEach(cleanup);

/** Widen a query result to the retained node: the queries hand back the
 *  ref-facing `DrawnNode` view, and a test about `style` and `theme` has to
 *  reach for the retained class underneath. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

interface StepOptions {
  indicator?: TimelineIndicatorProps;
  description?: boolean;
}

/** One step, with every part named for the queries. */
function step(n: number, options: StepOptions = {}): React.ReactElement {
  return h(
    TimelineItem,
    { key: n, 'data-testname': `item-${n}` },
    h(
      TimelineConnector,
      { 'data-testname': `connector-${n}` },
      // Chakra's own order — separator first, indicator second.
      h(TimelineSeparator, { 'data-testname': `line-${n}` }),
      h(
        TimelineIndicator,
        { 'data-testname': `dot-${n}`, ...options.indicator },
        String(n),
      ),
    ),
    h(
      TimelineContent,
      { 'data-testname': `content-${n}` },
      h(TimelineTitle, { 'data-testname': `title-${n}` }, `Step ${n}`),
      options.description === false
        ? null
        : h(TimelineDescription, { 'data-testname': `when-${n}` }, '13th May'),
    ),
  );
}

/**
 * A timeline of `count` steps, under a palette a test can pin.
 *
 * `<ThemeProvider>` rather than a `theme` prop on the window, because the two
 * are not the same route: a `theme` prop is what a `$token` in a *style*
 * resolves against, and `useTheme()` — which is how this component reads a
 * size or an accent — is React context. The provider feeds both. `colorScheme`
 * is pinned too: with nothing said the palette follows the desktop, so a test
 * asserting a colour would answer differently on a dark machine.
 */
function view(
  props: TimelineProps = {},
  count = 3,
  theme: Record<string, string | number> = {},
): React.ReactElement {
  const steps = Array.from({ length: count }, (_, i) => step(i + 1));
  return h(
    'window',
    { width: 400, height: 400 } as Record<string, unknown>,
    h(
      ThemeProvider,
      { value: theme, colorScheme: 'light' },
      h(Timeline, { 'data-testname': 'timeline', ...props }, ...steps),
    ),
  );
}

const mount = (element: React.ReactElement) =>
  renderX11(element, { backend: 'mock', wrap: false });

/** The palette in force, read off a node rather than imported — the provider
 *  puts the merged one on a real node, which is the same object the widgets
 *  got through context. */
function palette(): Record<string, unknown> {
  return retained(screen.getByTestName('timeline')).theme ?? {};
}

test('a timeline is a list of steps, and tells a screen reader so', async () => {
  await mount(view({}, 3));

  assert.ok(screen.getByRole('list'), 'the run of steps is a list');
  assert.strictEqual(screen.getAllByRole('listitem').length, 3);
  // `listitem` takes its name from its contents, so this is also what an
  // assistive technology reads out for the step.
  assert.ok(screen.getByText('Step 2'), 'the title is prose, not a prop');
  assert.strictEqual(screen.getAllByText('13th May').length, 3);
});

test('prose is legal wherever a part takes children', async () => {
  await mount(view({}, 1));

  // A bare string is only legal inside `<text>`; the parts wrap one, so
  // `<TimelineTitle>Step 1</TimelineTitle>` renders rather than throwing.
  const title = screen.getByTestName('title-1');
  const texts = retained(title).children.filter((c) => c.kind === 'text');
  assert.strictEqual(texts.length, 1, 'the string became one <text>');
  assert.strictEqual(retained(title).style.fontWeight, 'bold');
  // …and the wrapper carries no style of its own, because the ink and the
  // face inherit from the box above it.
  assert.deepStrictEqual(texts[0].props.style, undefined);
});

test('the last step drops the line, and the gap under it', async () => {
  await mount(view({}, 3));

  assert.ok(screen.getByTestName('line-1'));
  assert.ok(screen.getByTestName('line-2'));
  assert.strictEqual(
    screen.queryByTestName('line-3'),
    null,
    'a line past the last indicator would promise a step that is not there',
  );

  const padding = (n: number) =>
    retained(screen.getByTestName(`content-${n}`)).style.paddingBottom;
  assert.ok((padding(1) as number) > 0, 'the run between two steps');
  assert.strictEqual(padding(3), 0, 'and nothing under the last one');
});

test('showLastSeparator keeps the line running past the end', async () => {
  await mount(view({ showLastSeparator: true }, 3));
  assert.ok(
    screen.getByTestName('line-3'),
    'an open-ended timeline says there is more below',
  );
});

test('the line spans its whole item and runs under the indicator', async () => {
  await mount(view({}, 3));

  const item = retained(screen.getByTestName('item-1'));
  const line = retained(screen.getByTestName('line-1'));
  const dot = retained(screen.getByTestName('dot-1'));

  assert.strictEqual(
    line.abs.height,
    item.abs.height,
    'the line is as tall as the step it belongs to, so the gutter is ' +
      'measured by the content beside it rather than by a fixed height',
  );
  // Within half a pixel, which is as close as a 1px line gets to the middle
  // of an even-sized circle: the two candidate columns straddle it.
  const off = line.abs.x + line.abs.width / 2 - (dot.abs.x + dot.abs.width / 2);
  assert.ok(Math.abs(off) <= 0.5, `the line sits ${off}px off the mark`);
  // Painted first whichever order the two are written in: paint order is
  // otherwise document order, and Chakra's snippets put the separator
  // before the indicator while a reader may well put it after.
  assert.strictEqual(line.style.zIndex, -1);
  assert.strictEqual(
    dot.style.outlineWidth,
    2,
    'the ring is what cuts the line at the mark',
  );
});

test('the indicator is opaque, so the line cannot show through it', async () => {
  // Every variant, because this is the one thing each of them has to get
  // right: `plain` has no chip and still needs a fill, and `subtle` is a
  // wash of the accent that would be translucent if it were a `tint`.
  for (const variant of ['solid', 'subtle', 'outline', 'plain'] as const) {
    await mount(view({ variant }, 1));
    const fill = retained(screen.getByTestName('dot-1')).style.backgroundColor;
    assert.ok(
      typeof fill === 'string' && !/rgba\([^)]*,\s*0?\.\d+\)/.test(fill),
      `${variant} painted a translucent chip: ${fill}`,
    );
    await cleanup();
  }
});

test('variant and accent decide the chip, per timeline and per step', async () => {
  await mount(
    view(
      { accent: '$success' },
      2,
      // pinned, so the assertions below do not depend on the desktop's
      // light-or-dark answer
      { accent: '#2980b9', accentText: 'white', success: '#1e8449' },
    ),
  );
  const theme = palette();

  assert.strictEqual(
    retained(screen.getByTestName('dot-1')).style.backgroundColor,
    theme.success,
    'a `$token` accent is resolved against the palette',
  );

  await cleanup();
  await mount(view({}, 2, { accent: '#2980b9', accentText: 'white' }));
  const dot = retained(screen.getByTestName('dot-1'));
  assert.strictEqual(dot.style.backgroundColor, '#2980b9');
  assert.strictEqual(
    dot.style.color,
    'white',
    "the palette's own answer for ink on the accent, not a second one",
  );
});

test('an indicator overrides the timeline it is in', async () => {
  await mount(
    h(
      'window',
      { width: 400, height: 400 } as Record<string, unknown>,
      h(
        ThemeProvider,
        { value: {}, colorScheme: 'light' },
        h(
          Timeline,
          { 'data-testname': 'timeline', variant: 'solid' },
          step(1),
          step(2, { indicator: { variant: 'outline', accent: '#c0392b' } }),
        ),
      ),
    ),
  );

  const first = retained(screen.getByTestName('dot-1'));
  const second = retained(screen.getByTestName('dot-2'));
  assert.strictEqual(first.style.borderWidth, undefined, 'solid has no ring');
  assert.strictEqual(
    second.style.borderWidth,
    1,
    'the step that has not happened yet is outlined, on its own say-so',
  );
});

test('size picks the indicator, and the type follows the theme', async () => {
  await mount(view({ size: 'sm' }, 1));
  assert.strictEqual(retained(screen.getByTestName('dot-1')).style.width, 16);
  await cleanup();

  await mount(view({ size: 'xl' }, 1));
  assert.strictEqual(retained(screen.getByTestName('dot-1')).style.width, 32);
  assert.strictEqual(
    retained(screen.getByTestName('title-1')).style.fontSize,
    14,
    'the default body size',
  );
  await cleanup();

  // A theme that scales its type scales the timeline with it — which a
  // fixed scale of its own would not do.
  await mount(view({ size: 'xl' }, 1, { fontSize: 18 }));
  assert.strictEqual(
    retained(screen.getByTestName('title-1')).style.fontSize,
    18,
  );
  assert.strictEqual(
    retained(screen.getByTestName('when-1')).style.fontSize,
    16,
    'and the caption stays a step under it',
  );
});

test('the ring is cleared with the ground, which a card can name', async () => {
  await mount(view({ ground: '$surface' }, 2, { surface: '#101820' }));
  assert.strictEqual(
    retained(screen.getByTestName('dot-1')).style.outlineColor,
    '#101820',
    'a timeline on a card clears the line with the card, not the window',
  );
});

test('a part outside a timeline says what is wrong', async () => {
  // React reports a render throw through the root's `onCaughtError` when a
  // boundary handles it — which is why this one has a boundary: the
  // uncaught path sets `process.exitCode`, and a test that fails the whole
  // run to prove an error message is not a test.
  const errors: string[] = [];
  class Boundary extends React.Component<
    { children?: React.ReactNode },
    { failed: string | null }
  > {
    override state = { failed: null as string | null };
    static getDerivedStateFromError(error: Error) {
      return { failed: error.message };
    }
    override render() {
      if (this.state.failed) errors.push(this.state.failed);
      return this.state.failed ? null : this.props.children;
    }
  }

  const quiet = console.error;
  console.error = () => {};
  try {
    await mount(
      h(
        'window',
        { width: 200, height: 200 } as Record<string, unknown>,
        h(Boundary, null, h(TimelineTitle, null, 'orphan')),
      ),
    );
  } finally {
    console.error = quiet;
  }

  assert.match(
    errors[0] ?? '',
    /<TimelineTitle> has to be inside a <Timeline>/,
  );
});
