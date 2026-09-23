// The "Specs" tab of `json-render.tsx`: json-render with no model in it.
//
// json-render (https://json-render.dev) is a generative-UI framework: you
// declare a *catalog* of components a model is allowed to use, the model
// emits a JSON *spec* naming types from that catalog, and a renderer turns
// the spec into real components. The point of the catalog is that the
// components are yours — so nothing in the framework is web-shaped, and the
// same spec that drives a `<div>` on the web drives a `<box>` here.
//
// This tab is `@json-render/react`'s `<Renderer>` driving react-x11's
// reconciler, with a catalog whose implementations are `<box>`, `<text>`,
// `<textinput>`, core's `<Button>`/`<Switch>` and this package's
// `<BarChart>`. Nothing is adapted, shimmed or re-implemented — json-render
// only ever calls `createElement`, so the host it lands on is whichever
// reconciler is mounted. The one place it reaches for the DOM is the
// confirm dialog `<JSONUIProvider>` mounts, which is why this file composes
// the four providers by hand instead. (Give an action a `confirm` and that
// dialog would try to render a `<div>` here; nothing else in the package
// names an HTML element at all.)
//
// The specs are written by hand, standing in for a model's output, and they
// exercise the parts of the spec language a host could plausibly break:
// `$state` and `$template` reads, `$bindState` two-way binding into a
// `<textinput>` and a `<Switch>`, `repeat` over a state array with
// `$item`/`$index`, a `visible` condition, and an action fired from a
// `<Button>` through `emit`. "Stream it" replays a spec element by element,
// which is what arriving JSONL looks like: the tree grows under you and a
// spec whose children have not landed yet still renders.
import { useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { z } from 'zod';
import { createStateStore, defineCatalog } from '@json-render/core';
import { immutableSetByPath } from '@json-render/core/store-utils';
import { schema } from '@json-render/react/schema';
import {
  ActionProvider,
  Renderer,
  StateProvider,
  ValidationProvider,
  VisibilityProvider,
  defineRegistry,
  useBoundProp,
  useStateStore,
} from '@json-render/react';
import type { SetState, Spec } from '@json-render/react';
import { Button, Switch } from 'react-x11';

import {
  BarChart,
  BarSeries,
  CartesianGrid,
  ChartContainer,
  XAxis,
  YAxis,
} from '../../src/index.js';
import type { ChartConfig } from '../../src/index.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];

// --- 1. the catalog --------------------------------------------------------
//
// The guardrail. A model generating against this may name these eleven
// components and this one action, with props that have to survive zod — and
// nothing else. `slots: ['default']` is json-render's spelling of "takes
// children"; the descriptions are what goes into the prompt.

const catalog = defineCatalog(schema, {
  components: {
    Screen: {
      props: z.object({ title: z.string(), subtitle: z.string().optional() }),
      slots: ['default'],
      description: 'The page shell. One per spec, always the root.',
    },
    Card: {
      props: z.object({ title: z.string().optional() }),
      slots: ['default'],
      description: 'A titled panel.',
    },
    Row: {
      props: z.object({ gap: z.number().optional() }),
      slots: ['default'],
      description: 'Lays its children out left to right.',
    },
    Stack: {
      props: z.object({ gap: z.number().optional() }),
      slots: ['default'],
      description: 'Lays its children out top to bottom.',
    },
    Text: {
      props: z.object({
        text: z.union([z.string(), z.number()]),
        muted: z.boolean().optional(),
        size: z.number().optional(),
      }),
      description: 'A line of prose.',
    },
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        delta: z.string().optional(),
      }),
      description: 'A big number with a caption.',
    },
    Badge: {
      props: z.object({
        text: z.string(),
        tone: z.enum(['neutral', 'success', 'warning', 'danger']),
      }),
      description: 'A small coloured pill.',
    },
    Bars: {
      props: z.object({
        dataPath: z.string(),
        height: z.number().optional(),
      }),
      description:
        'A bar chart over a state array of { label, value }. dataPath is a JSON Pointer into the state model.',
    },
    Field: {
      props: z.object({ label: z.string(), value: z.string() }),
      description:
        'A labelled text field. Pass value as { $bindState } to write back.',
    },
    Toggle: {
      props: z.object({ label: z.string(), checked: z.boolean() }),
      description:
        'A labelled switch. Pass checked as { $bindState } to write back.',
    },
    Action: {
      props: z.object({ label: z.string(), primary: z.boolean().optional() }),
      description: 'A button. Bind an action to its "press" event.',
    },
  },
  actions: {
    shuffle: {
      params: z.object({ path: z.string() }),
      description: 'Re-roll the numbers behind a chart.',
    },
  },
});

// --- 2. the registry -------------------------------------------------------
//
// The same catalog, implemented against this renderer's vocabulary. This is
// the whole of the "port": eleven functions, none of which knows it is being
// driven by JSON rather than by JSX.

const TONE = {
  neutral: { bg: '$surface', fg: '$textMuted' },
  success: { bg: '$success', fg: '$successText' },
  warning: { bg: '$warning', fg: '$warningText' },
  danger: { bg: '$danger', fg: '$dangerText' },
} as const;

const barConfig = {
  value: { label: 'Value', color: '$accent' },
} satisfies ChartConfig;

const { registry, handlers } = defineRegistry(catalog, {
  components: {
    Screen: ({ props, children }) => (
      <box style={{ flexDirection: 'column', gap: 10, padding: 14 }}>
        <text style={{ fontSize: 17, color: '$text' }}>{props.title}</text>
        {props.subtitle ? (
          <text style={{ fontSize: 11, color: '$textMuted' }}>
            {props.subtitle}
          </text>
        ) : null}
        {children}
      </box>
    ),

    Card: ({ props, children }) => (
      <box
        style={{
          flexDirection: 'column',
          gap: 8,
          padding: 12,
          backgroundColor: '$surface',
          borderRadius: 6,
          borderWidth: 1,
          borderColor: '$border',
        }}
      >
        {props.title ? (
          <text style={{ fontSize: 12, color: '$textMuted' }}>
            {props.title}
          </text>
        ) : null}
        {children}
      </box>
    ),

    Row: ({ props, children }) => (
      <box
        style={{
          flexDirection: 'row',
          gap: props.gap ?? 10,
          alignItems: 'center',
        }}
      >
        {children}
      </box>
    ),

    Stack: ({ props, children }) => (
      <box style={{ flexDirection: 'column', gap: props.gap ?? 6 }}>
        {children}
      </box>
    ),

    Text: ({ props }) => (
      <text
        style={{
          fontSize: props.size ?? 12,
          color: props.muted ? '$textMuted' : '$text',
        }}
      >
        {String(props.text)}
      </text>
    ),

    Metric: ({ props }) => (
      <box style={{ flexDirection: 'column', gap: 2, flexGrow: 1 }}>
        <text style={{ fontSize: 10, color: '$textMuted' }}>{props.label}</text>
        <text style={{ fontSize: 22, color: '$text' }}>{props.value}</text>
        {props.delta ? (
          <text
            style={{
              fontSize: 10,
              color: props.delta.startsWith('-') ? '$danger' : '$success',
            }}
          >
            {props.delta}
          </text>
        ) : null}
      </box>
    ),

    Badge: ({ props }) => {
      const t = TONE[props.tone];
      return (
        <box
          style={{
            backgroundColor: t.bg,
            borderRadius: 4,
            paddingLeft: 7,
            paddingRight: 7,
            paddingTop: 2,
            paddingBottom: 2,
            alignSelf: 'flex-start',
          }}
        >
          <text style={{ fontSize: 10, color: t.fg }}>{props.text}</text>
        </box>
      );
    },

    // A pointer rather than the rows themselves: a chart's worth of data has
    // no business travelling as literal props in a generated spec, and
    // reading it out of state here is what makes `shuffle` visible.
    Bars: ({ props }) => {
      const { get } = useStateStore();
      const rows = (get(props.dataPath) ?? []) as Record<string, unknown>[];
      return (
        <ChartContainer
          config={barConfig}
          style={{ height: props.height ?? 160 }}
        >
          <BarChart data={rows}>
            <CartesianGrid />
            <XAxis dataKey="label" />
            <YAxis width={34} />
            <BarSeries dataKey="value" radius={3} />
          </BarChart>
        </ChartContainer>
      );
    },

    // `bindings.value` is the absolute state path a `{ $bindState }` prop
    // resolved to; `useBoundProp` hands back the write side of it, so the
    // field and every `$state` reader of the same path move together.
    Field: ({ props, bindings }) => {
      const [value, setValue] = useBoundProp<string>(
        props.value,
        bindings?.value,
      );
      return (
        <box style={{ flexDirection: 'column', gap: 3 }}>
          <text style={{ fontSize: 10, color: '$textMuted' }}>
            {props.label}
          </text>
          <textinput
            value={value ?? ''}
            onChange={(ev) => setValue(ev.value)}
            style={{
              width: 220,
              padding: 5,
              borderWidth: 1,
              borderColor: '$border',
              borderRadius: 4,
            }}
          />
        </box>
      );
    },

    Toggle: ({ props, bindings }) => {
      const [checked, setChecked] = useBoundProp<boolean>(
        props.checked,
        bindings?.checked,
      );
      return (
        <box style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Switch
            checked={checked ?? false}
            onChange={(ev) => setChecked(ev.value)}
          />
          <text style={{ fontSize: 12, color: '$text' }}>{props.label}</text>
        </box>
      );
    },

    // `emit('press')` is the whole binding: which action runs, and with what
    // params, is in the spec's `on` field, not here.
    Action: ({ props, emit }) => (
      <Button
        primary={props.primary}
        size="small"
        style={{ alignSelf: 'flex-start' }}
        onPress={() => emit('press')}
      >
        {props.label}
      </Button>
    ),
  },

  actions: {
    // `setState` is a whole-model updater, so a path write goes through
    // core's `immutableSetByPath` rather than mutating the snapshot.
    shuffle: async (params, setState) => {
      const rows = MONTHS.map((label) => ({
        label,
        value: Math.round(40 + Math.random() * 260),
      }));
      const path = params?.path ?? '/sales';
      setState(
        (prev) =>
          immutableSetByPath(prev, path, rows) as Record<string, unknown>,
      );
    },
  },
});

// --- 3. what a model would have emitted ------------------------------------
//
// Three specs over one catalog and one state model. Nothing below is code
// the app shipped: swap these objects for a model's streamed output and the
// window changes with no rebuild, which is the claim json-render makes and
// the thing this example exists to make literal.

const initialState = {
  team: 'Platform',
  revenue: { total: '$48,200', growth: '+12%', churn: '-1.4%' },
  sales: MONTHS.map((label, i) => ({ label, value: 120 + i * 37 })),
  compact: false,
  incidents: [
    { title: 'Tile cache stampede', severity: 'warning', age: '2h' },
    { title: 'Cocoa blit regression', severity: 'danger', age: '6h' },
    { title: 'Flaky reorder test', severity: 'neutral', age: '2d' },
  ],
};

interface Prompt {
  prompt: string;
  note: string;
  spec: Spec;
}

const PROMPTS: Prompt[] = [
  {
    prompt: 'Show a revenue dashboard',
    note: '$state reads, a chart over a state path, an action',
    spec: {
      root: 'screen',
      elements: {
        screen: {
          type: 'Screen',
          props: {
            title: { $template: '${/team} revenue' },
            subtitle: 'Generated from a prompt. Every panel below is a <box>.',
          },
          children: ['metrics', 'chart'],
        },
        metrics: { type: 'Card', props: {}, children: ['row'] },
        row: {
          type: 'Row',
          props: { gap: 20 },
          children: ['total', 'growth', 'churn'],
        },
        total: {
          type: 'Metric',
          props: {
            label: 'Total revenue',
            value: { $state: '/revenue/total' },
          },
        },
        growth: {
          type: 'Metric',
          props: {
            label: 'Growth',
            value: { $state: '/revenue/growth' },
            delta: { $state: '/revenue/growth' },
          },
        },
        churn: {
          type: 'Metric',
          props: {
            label: 'Churn',
            value: { $state: '/revenue/churn' },
            delta: { $state: '/revenue/churn' },
          },
        },
        chart: {
          type: 'Card',
          props: { title: 'Sales by month' },
          children: ['bars', 'shuffle'],
        },
        bars: { type: 'Bars', props: { dataPath: '/sales', height: 180 } },
        shuffle: {
          type: 'Action',
          props: { label: 'Re-roll', primary: true },
          on: { press: { action: 'shuffle', params: { path: '/sales' } } },
        },
      },
    },
  },

  {
    prompt: 'List open incidents by severity',
    note: 'repeat over a state array, with $item and $index',
    spec: {
      root: 'screen',
      elements: {
        screen: {
          type: 'Screen',
          props: {
            title: 'Open incidents',
            subtitle:
              'One repeat element. The rows are the state array, not the spec.',
          },
          children: ['card'],
        },
        card: { type: 'Card', props: {}, children: ['list'] },
        list: {
          type: 'Stack',
          props: { gap: 8 },
          // The children below are a template: one copy per item in
          // /incidents, with $item/$index resolved per copy.
          repeat: { statePath: '/incidents' },
          children: ['row'],
        },
        row: {
          type: 'Row',
          props: { gap: 10 },
          children: ['n', 'sev', 'title', 'age'],
        },
        n: { type: 'Text', props: { text: { $index: true }, muted: true } },
        sev: {
          type: 'Badge',
          props: { text: { $item: 'severity' }, tone: { $item: 'severity' } },
        },
        title: { type: 'Text', props: { text: { $item: 'title' } } },
        age: { type: 'Text', props: { text: { $item: 'age' }, muted: true } },
      },
    },
  },

  {
    prompt: 'Let me edit the team settings',
    note: '$bindState both ways, and a visible condition',
    spec: {
      root: 'screen',
      elements: {
        screen: {
          type: 'Screen',
          props: {
            title: 'Settings',
            subtitle:
              'Type in the field, then pick the first prompt again — its heading reads the same path.',
          },
          children: ['card'],
        },
        card: {
          type: 'Card',
          props: {},
          children: ['name', 'compact', 'hint', 'echo'],
        },
        name: {
          type: 'Field',
          props: { label: 'Team name', value: { $bindState: '/team' } },
        },
        compact: {
          type: 'Toggle',
          props: {
            label: 'Compact layout',
            checked: { $bindState: '/compact' },
          },
        },
        // Shown only while the switch is on. `visible` is the spec's own
        // conditional, evaluated by json-render — no code here tests it.
        hint: {
          type: 'Text',
          props: {
            text: 'Compact is on — rows would tighten up.',
            muted: true,
          },
          visible: { $state: '/compact' },
        },
        echo: {
          type: 'Badge',
          props: { text: { $template: 'team = ${/team}' }, tone: 'neutral' },
        },
      },
    },
  },
];

// --- 4. streaming ----------------------------------------------------------
//
// A model does not hand over the spec; it dribbles it. Replaying one element
// at a time is the shape the JSONL stream has, and it is worth watching
// because a half-arrived spec is a tree with dangling child keys in it —
// `<Renderer>` renders what it has and fills the rest in as it lands.

function usePartialSpec(spec: Spec): {
  shown: Spec;
  streaming: boolean;
  start: () => void;
} {
  const keys = useMemo(() => Object.keys(spec.elements), [spec]);
  const [upto, setUpto] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const start = (): void => {
    clearInterval(timer.current);
    setUpto(0);
    timer.current = setInterval(() => {
      setUpto((n) => {
        if (n === null || n >= keys.length) {
          clearInterval(timer.current);
          return null;
        }
        return n + 1;
      });
    }, 240);
  };

  const shown = useMemo(() => {
    if (upto === null) return spec;
    const elements: Spec['elements'] = {};
    for (const k of keys.slice(0, upto)) elements[k] = spec.elements[k]!;
    return { root: spec.root, elements };
  }, [spec, keys, upto]);

  return { shown, streaming: upto !== null, start };
}

// --- 5. the app ------------------------------------------------------------
//
// One store for all three specs, so a value the settings spec writes is
// still there when the dashboard spec reads it. Owning the store here
// (`<StateProvider store={...}>` is json-render's controlled mode) is also
// what lets the action handlers, which are built outside the tree, write to
// the same state the components read.

const store = createStateStore(initialState);

// `defineRegistry`'s handlers want the whole-model updater shape; the store
// takes JSON Pointer paths. `update` compares each path by reference, so a
// re-roll notifies for `/sales` and nothing else.
const setState: SetState = (updater) => {
  const next = updater(store.getSnapshot());
  store.update(
    Object.fromEntries(Object.keys(next).map((k) => [`/${k}`, next[k]])),
  );
};

const actionHandlers = handlers(
  () => setState,
  () => store.getSnapshot(),
);

function PromptButton(props: {
  prompt: Prompt;
  selected: boolean;
  onPick: () => void;
}): ReactElement {
  const fg = props.selected ? '$accentText' : '$text';
  return (
    <box
      onClick={props.onPick}
      style={{
        flexDirection: 'column',
        gap: 3,
        padding: 9,
        borderRadius: 4,
        backgroundColor: props.selected ? '$accent' : '$surface',
        borderWidth: 1,
        borderColor: props.selected ? '$accent' : '$border',
      }}
    >
      <text style={{ fontSize: 12, color: fg }}>{props.prompt.prompt}</text>
      <text
        style={{
          fontSize: 10,
          color: props.selected ? '$accentText' : '$textMuted',
        }}
      >
        {props.prompt.note}
      </text>
    </box>
  );
}

function Panel(props: { children?: ReactNode }): ReactElement {
  return (
    <box
      style={{
        flexDirection: 'column',
        flexGrow: 1,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '$border',
        overflow: 'scroll',
      }}
    >
      {props.children}
    </box>
  );
}

/** The "Specs" tab: no model at all. The JSON is written by hand in this
 *  file; `<Renderer>` turns it into a window. */
export function SpecsTab(): ReactElement {
  const [pick, setPick] = useState(0);
  const chosen = PROMPTS[pick]!;
  const { shown, streaming, start } = usePartialSpec(chosen.spec);

  const arrived = Object.keys(shown.elements).length;
  const total = Object.keys(chosen.spec.elements).length;

  return (
    <box style={{ flexDirection: 'row', flexGrow: 1, gap: 14, padding: 14 }}>
      <box style={{ flexDirection: 'column', gap: 8, width: 250 }}>
        <text style={{ fontSize: 13, color: '$text' }}>Hand-written specs</text>
        <text style={{ fontSize: 10, color: '$textMuted' }}>
          No model here. Each prompt stands in for what a model constrained to
          the catalog would have emitted; the JSON is in specs.tsx, the window
          it became is not.
        </text>
        {PROMPTS.map((p, i) => (
          <PromptButton
            key={p.prompt}
            prompt={p}
            selected={i === pick}
            onPick={() => setPick(i)}
          />
        ))}
        <Button size="small" onPress={start} disabled={streaming}>
          {streaming ? 'Streaming…' : 'Stream it'}
        </Button>
        <text
          style={{
            fontSize: 10,
            color: '$textMuted',
            fontFamily: '$monoFamily',
          }}
        >
          {streaming
            ? `${arrived}/${total} elements arrived`
            : `${total} elements`}
        </text>
      </box>

      <Panel>
        <StateProvider store={store}>
          <VisibilityProvider>
            <ValidationProvider>
              <ActionProvider handlers={actionHandlers}>
                <Renderer
                  spec={shown}
                  registry={registry}
                  loading={streaming}
                />
              </ActionProvider>
            </ValidationProvider>
          </VisibilityProvider>
        </StateProvider>
      </Panel>
    </box>
  );
}
