// <Tabs> — the composition, and the decisions inside it a reader of the
// source would not guess: hidden panels stay mounted so their state survives
// (with `lazyMount` / `unmountOnExit` as the two opt-outs), the strip is one
// tab stop whose arrows follow where layout put the triggers rather than
// mount order, `manual` moves focus without selecting, every selected fill is
// opaque so the strip's rule cannot show through it, and a `<TabsIndicator>`
// is drawn by the selected trigger so layout owns its geometry.
//
// Unlike `timeline.test.ts` this cannot run on the mock backend: half of it
// clicks and types, and `fireEvent` injects through the in-process X server.
// Still headless.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  userEvent,
  pixelAt,
  act,
  roleOf,
  textOf,
  waitFor,
} from 'react-x11/test';
import { ThemeProvider } from 'react-x11';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_RETURN,
  XK_RIGHT,
} from 'react-x11/keysyms';
import type { DrawnNode } from 'react-x11';
import type { Node as RetainedNode } from 'react-x11/node';

import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from '../src/index.js';
import type { TabsProps, TabsValueChange } from '../src/index.js';

const h = React.createElement;

afterEach(cleanup);

/** Widen a query result to the retained node: the queries hand back the
 *  ref-facing `DrawnNode` view, and a test about `style` has to reach for
 *  the retained class underneath. Same widening as `timeline.test.ts`. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

interface Item {
  value: string;
  label?: string;
  disabled?: boolean;
}

const THREE: Item[] = [
  { value: 'members' },
  { value: 'projects' },
  { value: 'settings' },
];

/** A tabs view whose parts are all named for the queries. */
function view(
  props: TabsProps = {},
  items: Item[] = THREE,
  theme: Record<string, string | number> = {},
  extras: { indicator?: boolean } = {},
): React.ReactElement {
  return h(
    'window',
    { width: 500, height: 300 } as Record<string, unknown>,
    h(
      ThemeProvider,
      // pinned, so colour assertions do not depend on the desktop's
      // light-or-dark answer
      { value: theme, colorScheme: 'light' },
      h(
        Tabs,
        { 'data-testname': 'tabs', ...props },
        h(
          TabsList,
          { 'data-testname': 'list' },
          extras.indicator ? h(TabsIndicator) : null,
          items.map((item) =>
            h(
              TabsTrigger,
              {
                key: item.value,
                value: item.value,
                disabled: item.disabled,
                'data-testname': `tab-${item.value}`,
              },
              item.label ?? item.value,
            ),
          ),
        ),
        items.map((item) =>
          h(
            TabsContent,
            {
              key: item.value,
              value: item.value,
              'data-testname': `panel-${item.value}`,
            },
            `${item.value} panel`,
          ),
        ),
      ),
    ),
  );
}

// The in-process X server rather than the mock: half these tests click and
// type, and `fireEvent` injects through a server the mock does not have.
// Still headless — the server is node-x11's pure-JavaScript one.
const mount = (element: React.ReactElement) =>
  renderX11(element, { wrap: false });

const tab = (value: string) => screen.getByTestName(`tab-${value}`);
const panel = (value: string) =>
  retained(screen.getByTestName(`panel-${value}`));

/** Which panel layout is actually showing: `display: 'none'` is out of
 *  layout, so the hidden ones report no height. */
const showing = (value: string) => panel(value).abs.height > 0;

test('a strip of tabs, and it tells a screen reader so', async () => {
  await mount(view({ defaultValue: 'members' }));

  assert.ok(screen.getByRole('tablist'));
  assert.strictEqual(screen.getAllByRole('tab').length, 3);
  // every panel is mounted, so every panel has the role — and the hidden
  // ones say so, which is what keeps a screen reader to the visible one
  assert.strictEqual(screen.getAllByRole('tabpanel').length, 3);
  assert.strictEqual(panel('members').props['aria-hidden'], undefined);
  assert.strictEqual(panel('projects').props['aria-hidden'], true);
  assert.strictEqual(retained(tab('members')).props['aria-selected'], true);
  assert.strictEqual(retained(tab('projects')).props['aria-selected'], false);
});

test('uncontrolled: defaultValue starts it, a click moves it', async () => {
  const changes: TabsValueChange[] = [];
  await mount(
    view({ defaultValue: 'members', onValueChange: (c) => changes.push(c) }),
  );

  assert.ok(showing('members'));
  assert.ok(!showing('projects'));

  await userEvent.click(tab('projects'));
  assert.ok(showing('projects'));
  assert.ok(!showing('members'));
  // Chakra's details object, so a handler written for Chakra transfers.
  assert.deepStrictEqual(changes, [{ value: 'projects' }]);

  // clicking the selected tab again is a no-op, not a second event
  await userEvent.click(tab('projects'));
  assert.strictEqual(changes.length, 1);
});

test('controlled: value wins, and the change is a report', async () => {
  const changes: TabsValueChange[] = [];
  await mount(
    view({ value: 'members', onValueChange: (c) => changes.push(c) }),
  );

  await userEvent.click(tab('settings'));
  assert.deepStrictEqual(changes, [{ value: 'settings' }]);
  assert.ok(showing('members'), 'nobody applied the change, so nothing moved');
});

test('with neither value nor defaultValue, nothing is selected', async () => {
  await mount(view({}));
  for (const item of THREE) assert.ok(!showing(item.value));
  // …but the strip is still reachable: with no roving stop to give the
  // tab order, every trigger is in it.
  assert.strictEqual(retained(tab('members')).props.tabIndex, 0);
});

test('a disabled trigger does not select', async () => {
  await mount(
    view({ defaultValue: 'members' }, [
      { value: 'members' },
      { value: 'projects', disabled: true },
    ]),
  );

  await userEvent.click(tab('projects'));
  assert.ok(showing('members'));
});

test('hidden panels stay mounted, out of layout', async () => {
  await mount(view({ defaultValue: 'members' }));

  // The default: the panel exists — a form half-filled on another tab keeps
  // its state — but takes no space and shows nothing.
  const hidden = panel('projects');
  assert.strictEqual(hidden.style.display, 'none');
  assert.strictEqual(hidden.abs.height, 0);
  assert.strictEqual(panel('members').style.display, 'flex');
});

test('lazyMount builds a panel on first selection, and keeps it', async () => {
  await mount(view({ defaultValue: 'members', lazyMount: true }));

  assert.strictEqual(screen.queryByTestName('panel-projects'), null);

  await userEvent.click(tab('projects'));
  assert.ok(showing('projects'));

  await userEvent.click(tab('members'));
  assert.ok(
    screen.queryByTestName('panel-projects'),
    'once built, a lazy panel hides rather than unmounts',
  );
});

test('unmountOnExit gives a panel up when it hides', async () => {
  await mount(view({ defaultValue: 'members', unmountOnExit: true }));

  assert.strictEqual(screen.queryByTestName('panel-projects'), null);
  await userEvent.click(tab('projects'));
  assert.ok(showing('projects'));
  assert.strictEqual(
    screen.queryByTestName('panel-members'),
    null,
    'the deselected panel is gone, state and all',
  );
});

test('the arrows walk, wrap, and skip disabled triggers', async () => {
  await mount(
    view({ defaultValue: 'members' }, [
      { value: 'members' },
      { value: 'projects', disabled: true },
      { value: 'settings' },
    ]),
  );

  await userEvent.click(tab('members'));
  await userEvent.key(XK_RIGHT);
  assert.ok(showing('settings'), 'the disabled trigger was stepped over');

  await userEvent.key(XK_RIGHT);
  assert.ok(showing('members'), 'and the walk wraps at the end');

  await userEvent.key(XK_LEFT);
  assert.ok(showing('settings'), 'backwards wraps too');

  await userEvent.key(XK_HOME);
  assert.ok(showing('members'));
  await userEvent.key(XK_END);
  assert.ok(showing('settings'));
});

test('manual mode moves focus without selecting', async () => {
  await mount(view({ defaultValue: 'members', activationMode: 'manual' }));

  await userEvent.click(tab('members'));
  await userEvent.key(XK_RIGHT);
  assert.ok(showing('members'), 'the arrow moved focus, not the selection');

  // The commit is the click Enter/Space become in core (issue #329) — the
  // click itself is asserted here, since the keys route through it.
  await userEvent.click(tab('projects'));
  assert.ok(showing('projects'));
});

test('a vertical strip walks with Up and Down', async () => {
  await mount(view({ defaultValue: 'members', orientation: 'vertical' }));

  const list = retained(screen.getByTestName('list'));
  assert.strictEqual(list.style.flexDirection, 'column');
  assert.strictEqual(list.props['aria-orientation'], 'vertical');

  await userEvent.click(tab('members'));
  await userEvent.key(XK_DOWN);
  assert.ok(showing('projects'));
});

test('an RTL strip mirrors, and the arrows stay visual', async () => {
  await mount(
    h(
      'window',
      { width: 500, height: 300 } as Record<string, unknown>,
      h(
        ThemeProvider,
        { value: { direction: 'rtl' }, colorScheme: 'light' },
        h(
          Tabs,
          { defaultValue: 'members', 'data-testname': 'tabs' },
          h(
            TabsList,
            { 'data-testname': 'list' },
            THREE.map((item) =>
              h(
                TabsTrigger,
                {
                  key: item.value,
                  value: item.value,
                  'data-testname': `tab-${item.value}`,
                },
                item.value,
              ),
            ),
          ),
          THREE.map((item) =>
            h(
              TabsContent,
              {
                key: item.value,
                value: item.value,
                'data-testname': `panel-${item.value}`,
              },
              'panel',
            ),
          ),
        ),
      ),
    ),
  );

  // yoga mirrored the row: the first trigger is the rightmost
  const first = retained(tab('members'));
  const second = retained(tab('projects'));
  assert.ok(first.abs.x > second.abs.x, 'the strip reads right to left');

  // …so the *next* tab is the one to the left
  await userEvent.click(tab('members'));
  await userEvent.key(XK_LEFT);
  assert.ok(showing('projects'));
});

test('line: an accent marker on the selected trigger, over the rule', async () => {
  await mount(view({ defaultValue: 'members' }, THREE, { accent: '#2980b9' }));

  const marker = (value: string) =>
    retained(tab(value)).children.find(
      (c) => c.kind === 'box' && c.style.position === 'absolute',
    ) as RetainedNode;

  assert.strictEqual(marker('members').style.backgroundColor, '#2980b9');
  assert.strictEqual(marker('projects').style.backgroundColor, 'transparent');
  // the marker rides the panel edge of its trigger
  const node = retained(tab('members'));
  const m = marker('members');
  assert.strictEqual(m.abs.y + m.abs.height, node.abs.y + node.abs.height);
  // and the selected label takes the accent
  assert.strictEqual(node.style.color, '#2980b9');
});

test('enclosed: the strip is a chip, the selected trigger is the ground', async () => {
  await mount(
    view({ defaultValue: 'members', variant: 'enclosed' }, THREE, {
      background: '#ffffff',
    }),
  );

  const list = retained(screen.getByTestName('list'));
  assert.ok(
    typeof list.style.backgroundColor === 'string' &&
      !/rgba\([^)]*,\s*0?\.\d+\)/.test(list.style.backgroundColor),
    'the chip is opaque, mixed from the palette rather than laid over it',
  );
  assert.strictEqual(
    retained(tab('members')).style.backgroundColor,
    '#ffffff',
    'the selected trigger is filled with the ground',
  );
  assert.strictEqual(
    retained(tab('members')).style.borderWidth,
    retained(tab('projects')).style.borderWidth,
    'every trigger carries the border, so selecting cannot change a size',
  );
});

test('outline: rounded shoulders, open toward the panel', async () => {
  const { ctx } = await mount(
    view({ defaultValue: 'members', variant: 'outline' }),
  );

  // The trigger itself is deliberately borderless — a node's own border
  // paints *after* its children, so a border here could never be opened.
  // The stroke lives on the frame child; the skirt after it is what covers
  // the frame's panel edge and the two corners that would curl toward it.
  const selected = retained(tab('members'));
  assert.strictEqual(selected.style.borderWidth, undefined);
  assert.strictEqual(selected.style.borderRadius, 6, 'the fill rounds too');

  const boxes = selected.children.filter((c) => c.kind === 'box');
  const frame = boxes.find((c) => c.style.borderWidth === 1) as RetainedNode;
  const skirt = boxes.find(
    (c) => c.style.borderStartWidth === 1,
  ) as RetainedNode;
  assert.ok(frame, 'the frame carries the rounded border');
  assert.strictEqual(frame.style.borderRadius, 6);
  assert.ok(skirt, 'and the skirt opens it');
  assert.ok(
    boxes.indexOf(skirt) > boxes.indexOf(frame),
    'the skirt can only cover a sibling painted before it',
  );
  assert.strictEqual(skirt.abs.width, selected.abs.width);
  assert.strictEqual(
    skirt.abs.y + skirt.abs.height,
    selected.abs.y + selected.abs.height,
    'flush with the panel edge',
  );

  // What the eye actually checks, checked in pixels: the shoulder line is
  // there and the panel edge is not. (This is the assertion that caught the
  // border-over-children paint order — the retained tree looked right while
  // the tab painted closed.)
  const cx = Math.round(selected.abs.x + selected.abs.width / 2);
  const top = await pixelAt(ctx as never, cx, selected.abs.y);
  const bottom = await pixelAt(
    ctx as never,
    cx,
    selected.abs.y + selected.abs.height - 1,
  );
  assert.ok(
    top[0] < 250,
    `the top edge carries the frame's stroke, got rgb(${top.join()})`,
  );
  assert.deepStrictEqual(
    bottom,
    [255, 255, 255],
    'the bottom edge is open — pure ground, no stroke and no rule',
  );

  assert.strictEqual(
    retained(tab('projects')).style.borderWidth,
    undefined,
    'unselected triggers carry no border',
  );

  // …and the same holds after the shape moves to a clicked tab, which is
  // the path the eye first caught it on.
  await userEvent.click(tab('projects'));
  const next = retained(tab('projects'));
  const nx = Math.round(next.abs.x + next.abs.width / 2);
  assert.deepStrictEqual(
    await pixelAt(ctx as never, nx, next.abs.y + next.abs.height - 1),
    [255, 255, 255],
    'open at the bottom on the re-render path too',
  );
});

test('subtle: an opaque wash of the accent behind the selected label', async () => {
  await mount(view({ defaultValue: 'members', variant: 'subtle' }));

  const fill = retained(tab('members')).style.backgroundColor;
  assert.ok(
    typeof fill === 'string' && !/rgba\([^)]*,\s*0?\.\d+\)/.test(fill),
    `the wash is mixed against the ground, not laid translucently over it: ${fill}`,
  );
  assert.strictEqual(
    retained(tab('projects')).style.backgroundColor,
    undefined,
  );
});

test('plain: no chrome at all, until an indicator asks for some', async () => {
  await mount(view({ defaultValue: 'members', variant: 'plain' }));
  const trigger = retained(tab('members'));
  assert.strictEqual(trigger.style.backgroundColor, undefined);
  assert.strictEqual(
    trigger.children.filter((c) => c.kind === 'box').length,
    0,
    'no marker box either — the label is the whole trigger',
  );
});

test('a <TabsIndicator> is drawn by the selected trigger', async () => {
  await mount(
    view(
      { defaultValue: 'members', variant: 'plain' },
      THREE,
      {},
      {
        indicator: true,
      },
    ),
  );

  const chipOf = (value: string) =>
    retained(tab(value)).children.find((c) => c.kind === 'box');

  const chip = chipOf('members');
  assert.ok(chip, 'the selected trigger drew the indicator');
  assert.strictEqual(chip.style.zIndex, -1, 'behind its own label');
  assert.strictEqual(chipOf('projects'), undefined);

  await userEvent.click(tab('projects'));
  assert.ok(chipOf('projects'), 'the indicator follows the selection');
  assert.strictEqual(chipOf('members'), undefined);
});

test('fitted: the triggers share the strip', async () => {
  await mount(view({ defaultValue: 'members', fitted: true }));
  const list = retained(screen.getByTestName('list'));
  const last = retained(tab('settings'));
  assert.strictEqual(retained(tab('members')).style.flexGrow, 1);
  assert.strictEqual(
    last.abs.x + last.abs.width,
    list.abs.x + list.abs.width,
    'the strip is filled to its far edge',
  );
});

test('prose is legal wherever a part takes children', async () => {
  await mount(view({ defaultValue: 'members' }));

  // A bare string is only legal inside `<text>`; the parts wrap one, so
  // `<TabsTrigger value="a">Members</TabsTrigger>` renders rather than
  // throwing. A trigger's label is cap-trimmed — core's `labelContent` rule:
  // the line box carries more space over a capital than under the baseline,
  // so an untrimmed label centred beside an icon sits visibly low.
  const texts = retained(tab('members')).children.filter(
    (c) => c.kind === 'text',
  );
  assert.strictEqual(texts.length, 1);
  assert.strictEqual(texts[0].style.textBoxTrim, 'cap-alphabetic');
  // Panel prose is a paragraph, not a label: its wrapper carries no style,
  // because the ink inherits and a paragraph keeps its line boxes.
  const prose = panel('members').children.filter((c) => c.kind === 'text');
  assert.deepStrictEqual(prose[0].props.style, undefined);
});

test('a part outside <Tabs> says what is wrong', async () => {
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
        h(Boundary, null, h(TabsTrigger, { value: 'a' }, 'orphan')),
      ),
    );
  } finally {
    console.error = quiet;
  }

  assert.match(errors[0] ?? '', /<TabsTrigger> has to be inside a <Tabs>/);
});

// --- overflow ---------------------------------------------------------------
//
// The strip decides what fits from what layout actually did, which takes a
// pass to measure and a pass to settle — so every assertion here is inside a
// `waitFor`, which `act`s between attempts.

/** Seven tabs off a repository's own navigation, which is where the shape of
 *  this feature comes from. */
const MANY: Item[] = [
  { value: 'code' },
  { value: 'issues' },
  { value: 'pulls', label: 'Pull requests' },
  { value: 'discussions' },
  { value: 'actions' },
  { value: 'projects' },
  { value: 'wiki' },
];

/** The same tabs in a window narrow enough that they cannot all fit. */
function narrow(
  width: number,
  rootProps: TabsProps = {},
  items: Item[] = MANY,
  more: TabsProps = {},
): React.ReactElement {
  return h(
    'window',
    { width, height: 200 } as Record<string, unknown>,
    h(
      ThemeProvider,
      { value: {}, colorScheme: 'light' },
      h(
        Tabs,
        {
          'data-testname': 'tabs',
          defaultValue: 'code',
          ...rootProps,
          ...more,
        },
        h(
          TabsList,
          { 'data-testname': 'list' },
          items.map((item) =>
            h(
              TabsTrigger,
              {
                key: item.value,
                value: item.value,
                disabled: item.disabled,
                'data-testname': `tab-${item.value}`,
              },
              item.label ?? item.value,
            ),
          ),
        ),
        items.map((item) =>
          h(
            TabsContent,
            {
              key: item.value,
              value: item.value,
              'data-testname': `panel-${item.value}`,
            },
            `${item.value} panel`,
          ),
        ),
      ),
    ),
  );
}

/** Which tabs are on the strip, in the order layout put them. */
const onStrip = (): string[] =>
  MANY.map((item) => item.value).filter((value) =>
    Boolean(screen.queryByTestName(`tab-${value}`)),
  );

const more = () => screen.getByTestName('tabs-more');

/** The rows of the open overflow menu, in order. */
const rows = () => screen.all((node) => roleOf(node) === 'menuitemradio');

/** An accent-coloured mark inside a node — the `line` marker under the
 *  overflow button, or the bar beside the menu row that is selected. */
const marked = (node: DrawnNode): boolean =>
  retained(node).children.some(
    (child) =>
      child.kind === 'box' && child.style.backgroundColor === ACCENT_HEX,
  );

const props = (node: DrawnNode): Record<string, unknown> =>
  retained(node).props;

const ACCENT_HEX = '#2980b9';
const ACCENT = { accent: ACCENT_HEX };

test('a strip with no room keeps what fits and offers the rest', async () => {
  await mount(narrow(260));

  await waitFor(() => {
    assert.ok(more(), 'a strip that overflowed grows a button');
    const shown = onStrip();
    assert.ok(shown.length > 0, 'the tabs that fit stay on the strip');
    assert.ok(shown.length < MANY.length, 'the ones that do not are gone');
    // …and what is left really does fit, which is the whole claim
    const list = retained(screen.getByTestName('list'));
    const last = retained(screen.getByTestName('tabs-more'));
    assert.ok(
      last.abs.x + last.abs.width <= list.abs.x + list.abs.width + 1,
      'the button is inside the strip it was added to',
    );
  });

  // the strip is still one tab stop, and the button is the last of them
  assert.strictEqual(more().kind, 'box');
});

test('a selected tab stays in the menu, and the button wears its mark', async () => {
  await mount(narrow(260, { defaultValue: 'wiki' }, MANY, ACCENT));

  await waitFor(() => {
    assert.ok(more());
    assert.ok(
      !onStrip().includes('wiki'),
      'the last tab does not displace one that fitted just for being selected',
    );
    assert.ok(
      marked(more()),
      'the button carries the selected mark instead, in the accent',
    );
  });

  // …and it takes the strip's one tab stop, since the trigger that would
  // normally hold it is not on the strip to hold anything
  assert.strictEqual(props(more()).tabIndex, 0);
  for (const value of onStrip()) {
    assert.strictEqual(props(tab(value)).tabIndex, -1);
  }
});

test('picking a tab out of the menu leaves the strip as it was', async () => {
  const changes: TabsValueChange[] = [];
  await mount(
    narrow(260, { onValueChange: (c) => changes.push(c) }, MANY, ACCENT),
  );
  await waitFor(() => assert.ok(more()));

  const shown = onStrip();
  const missing = MANY.find((item) => !shown.includes(item.value));
  assert.ok(missing, 'something is in the menu to pick');
  const label = missing.label ?? missing.value;

  await userEvent.click(more());
  const row = await waitFor(() => {
    const found = rows().find((node) => textOf(node) === label);
    assert.ok(found, `the menu offers ${label}`);
    return found;
  });

  await userEvent.click(row);
  assert.deepStrictEqual(changes, [{ value: missing.value }]);
  await waitFor(() => {
    assert.strictEqual(rows().length, 0, 'the menu is gone');
    assert.deepStrictEqual(
      onStrip(),
      shown,
      'and the strip is exactly the tabs that fitted, still',
    );
    assert.ok(marked(more()), 'the button says where the selection went');
  });

  // reopened, the menu marks the row it stands for
  await userEvent.click(more());
  await waitFor(() => {
    const again = rows().find((node) => textOf(node) === label);
    assert.ok(again);
    assert.strictEqual(props(again)['aria-checked'], true);
    assert.ok(marked(again), 'and draws the accent bar beside it');
  });
});

test('the strip takes its tabs back when the window makes room', async () => {
  const view = await mount(narrow(260));
  await waitFor(() => assert.ok(more()));
  const cramped = onStrip().length;

  // A resize re-lays out without re-rendering anything, which is the path
  // the window's own `onAnchorChange` is subscribed for.
  await view.rerender(narrow(900));
  await waitFor(() => {
    assert.strictEqual(
      screen.queryByTestName('tabs-more'),
      null,
      'nothing is left over, so there is no button',
    );
    assert.strictEqual(onStrip().length, MANY.length);
  });
  assert.ok(cramped < MANY.length);
});

test('overflow="clip" leaves the strip to spill, as it always did', async () => {
  await mount(narrow(260, { overflow: 'clip' }));
  await waitFor(() => assert.strictEqual(onStrip().length, MANY.length));
  assert.strictEqual(screen.queryByTestName('tabs-more'), null);
});

test('a vertical strip overflows downward and grows no button', async () => {
  await mount(narrow(260, { orientation: 'vertical' }));
  await waitFor(() => assert.strictEqual(onStrip().length, MANY.length));
  assert.strictEqual(screen.queryByTestName('tabs-more'), null);
});

test('line: the hover is a wash, standing clear of the strip rule', async () => {
  // `clip`, because this is a test about what a hovered trigger looks like:
  // whether three short labels happen to fit the strip in whatever face the
  // machine resolved is not a variable it should have.
  await mount(view({ defaultValue: 'members', overflow: 'clip' }, THREE));

  const washOf = (value: string) =>
    retained(tab(value)).children.find(
      (child) =>
        child.kind === 'box' &&
        child.style.position === 'absolute' &&
        child.style.borderRadius === 4,
    ) as RetainedNode | undefined;

  // Both "no wash" checks put the pointer somewhere of their own choosing
  // first, rather than trusting where it is. Going in, it is wherever the
  // previous test left it and the X server is shared, so where it lands in a
  // freshly mounted tree depends on how wide the labels came out; coming out,
  // `unhover` leaves it at the trigger's own edge, which is a coordinate this
  // test would rather not be deciding hit-testing questions about. The panel
  // is nowhere near the strip either way.
  const park = async (why: string): Promise<void> => {
    await userEvent.hover(screen.getByTestName('panel-members'));
    await waitFor(() =>
      assert.strictEqual(Boolean(washOf('projects')), false, why),
    );
  };

  await park('nothing until hovered');

  await userEvent.hover(tab('projects'));
  // Laid out, not merely mounted: the box appears on the render the hover
  // causes and is placed on the layout pass after it, and a run that reads
  // it in between gets a rect of zeroes — which is a whole trigger's worth
  // of "distance to the rule" and passes for a real number.
  const wash = await waitFor(() => {
    const found = washOf('projects');
    assert.ok(found, 'a hovered `line` trigger wears the wash');
    assert.ok(found.abs.height > 0, 'and layout has placed it');
    return found;
  });
  // The wash is the size a `subtle` fill is — the label with the same padding
  // round it — and it keeps that same distance again off the panel edge.
  const trigger = retained(tab('projects'));
  const label = trigger.children.find((child) => child.kind === 'text');
  assert.ok(label);
  const pad = label.abs.y - wash.abs.y;
  const below =
    trigger.abs.y + trigger.abs.height - (wash.abs.y + wash.abs.height);
  assert.ok(pad > 0, 'the wash stands off the label');
  assert.strictEqual(
    below,
    pad,
    `text to wash edge is wash edge to rule (${pad}/${below})`,
  );
  assert.strictEqual(
    wash.abs.y,
    trigger.abs.y,
    'and the far side is flush: the room came out of the panel side',
  );

  await park('and it goes with the pointer');
});

test('fitted: a strip with no room stops sharing, and settles there', async () => {
  await mount(narrow(260, { fitted: true }));
  await waitFor(() => assert.ok(more()));

  // The oscillation this guards against: a `fitted` trigger grows to its
  // share of the strip, so measuring one after a tab has been taken away
  // reads the space it left as the label needing it — and every pass hides
  // one more. Two more layout passes have to give the same answer.
  const settled = onStrip();
  await act();
  await act();
  assert.deepStrictEqual(onStrip(), settled);
  assert.ok(settled.length > 0 && settled.length < MANY.length);
});

test('the overflow button is the last stop on the walk, and takes the keys', async () => {
  const changes: TabsValueChange[] = [];
  await mount(narrow(260, { onValueChange: (c) => changes.push(c) }));
  await waitFor(() => assert.ok(more()));

  await userEvent.click(tab('code'));
  changes.length = 0;
  await userEvent.key(XK_END);
  assert.ok(more().focused, 'End walks past the last tab, to the button');
  assert.strictEqual(
    changes.length,
    0,
    'and selects nothing: the button is the way to the tabs, not one of them',
  );

  const shown = onStrip();
  await userEvent.key(XK_DOWN);
  await waitFor(() => assert.ok(rows().length > 0, 'Down drops the menu'));

  await userEvent.key(XK_RETURN);
  await waitFor(() => {
    assert.strictEqual(
      rows().length,
      0,
      'Enter commits the row the cursor is on and shuts the menu',
    );
    assert.strictEqual(changes.length, 1);
    assert.deepStrictEqual(onStrip(), shown, 'the strip is unchanged');
    assert.ok(marked(more()), 'and the button is holding the selection');
  });
});
