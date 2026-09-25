// The "Composition" tab of `json-render.tsx`: nobody writes the spec.
//
// `experimental_composeSpec` from `@json-render/core` builds it out of
// *candidates* — configured component instances this file declares — and a
// decision model picks which ones the prompt needs, where they go and in what
// order. The model is Jev (`typesafe-ai/jev`): it never writes prose, it
// answers multiple-choice questions. Composition is two of them, batched —
// "which candidates does this request need?" then "what order do the
// siblings go in?" — so a whole tree costs two round trips, not one per
// element. Without a key the tab runs on a keyword stub instead; the banner
// on the tab says how to get a real model (see `compose.tsx`).
//
// What Jev can and cannot be handed, in v1: candidate props may use literals,
// `$state`, `$bindState` and state-based `visible` — and nothing else. The
// `$template`, `$item`, `$index` and `repeat` the "Specs" tab leans on are
// all unsupported here, which is why this catalog is the plainer one. Jev
// also cannot invent prose or data: every string a candidate shows is a
// string this file already wrote down.
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { createStateStore, defineCatalog } from '@json-render/core';
import { immutableSetByPath } from '@json-render/core/store-utils';
import { schema } from '@json-render/react/schema';
import {
  defineRegistry,
  useBoundProp,
  useStateStore,
} from '@json-render/react';
import type { Experimental_CompositionCandidate } from '@json-render/core';
import type { SetState } from '@json-render/react';
import { Button, Switch } from 'react-x11';

import {
  BarChart,
  BarSeries,
  CartesianGrid,
  ChartContainer,
  XAxis,
  YAxis,
} from '../../src/charts/index.js';
import type { ChartConfig } from '../../src/charts/index.js';

import {
  Heading,
  Line,
  ModelSetup,
  PromptList,
  Preview,
  Trace,
  useComposer,
} from './compose.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];

// --- 1. the catalog --------------------------------------------------------

const catalog = defineCatalog(schema, {
  components: {
    Panel: {
      props: z.object({ title: z.string() }),
      slots: ['default'],
      description: 'A titled panel. The outermost element of a screen.',
    },
    Heading: {
      props: z.object({ text: z.string() }),
      description: 'A section heading.',
    },
    Note: {
      props: z.object({ text: z.string() }),
      description: 'A muted line of explanatory text.',
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
      props: z.object({ dataPath: z.string(), height: z.number().optional() }),
      description: 'A bar chart over a state array of { label, value }.',
    },
    Field: {
      props: z.object({ label: z.string(), value: z.string() }),
      description: 'A labelled text field.',
    },
    Toggle: {
      props: z.object({ label: z.string(), checked: z.boolean() }),
      description: 'A labelled switch.',
    },
    Action: {
      props: z.object({ label: z.string(), primary: z.boolean().optional() }),
      // `events` is what makes an action binding legal on this component;
      // the composer rejects an `on` the catalog never declared.
      events: ['press'],
      description: 'A button.',
    },
  },
  actions: {
    shuffle: {
      params: z.object({ path: z.string() }),
      description: 'Re-roll the numbers behind a chart.',
    },
  },
});

// --- 2. the candidates -----------------------------------------------------
//
// The real difference from the Specs tab. A catalog says what *kinds* of
// element exist; a candidate is one fully configured instance of one — its
// props already filled in, its bindings already chosen, its action binding
// already written. Jev picks among these. It cannot edit a single prop, so
// every string and every state path below is this file's decision, not the
// model's, and a prompt asking for something no candidate covers gets
// `stopReason: 'unavailable'` rather than an invention.
//
// `description` is the *only* thing the evaluator sees about a candidate —
// not the props, not the bindings, not the state. It is the prompt.

const candidates = [
  {
    id: 'revenue-panel',
    description: 'A revenue dashboard panel',
    element: { type: 'Panel', props: { title: 'Revenue' } },
  },
  {
    id: 'settings-panel',
    description: 'An account settings panel',
    element: { type: 'Panel', props: { title: 'Settings' } },
  },

  {
    id: 'heading-performance',
    description: 'Heading that reads "This quarter"',
    root: false,
    element: { type: 'Heading', props: { text: 'This quarter' } },
  },
  {
    id: 'note-source',
    description: 'A note saying the figures are from the billing export',
    root: false,
    element: {
      type: 'Note',
      props: { text: 'Figures from the billing export, updated hourly.' },
    },
  },

  {
    id: 'metric-total',
    description: 'Total revenue for the period',
    root: false,
    resource: 'revenue',
    element: {
      type: 'Metric',
      props: { label: 'Total revenue', value: { $state: '/revenue/total' } },
    },
  },
  {
    id: 'metric-growth',
    description: 'Revenue growth rate',
    root: false,
    element: {
      type: 'Metric',
      props: {
        label: 'Growth',
        value: { $state: '/revenue/growth' },
        delta: { $state: '/revenue/growth' },
      },
    },
  },
  {
    id: 'metric-churn',
    description: 'Customer churn rate',
    root: false,
    element: {
      type: 'Metric',
      props: {
        label: 'Churn',
        value: { $state: '/revenue/churn' },
        delta: { $state: '/revenue/churn' },
      },
    },
  },

  // Two ways to show the same numbers. `resource` makes them mutually
  // exclusive, so a request gets the chart or the headline figure, never
  // both — this is how you offer a model a choice of presentation without
  // letting it pick both.
  {
    id: 'sales-chart',
    description: 'A bar chart of monthly sales',
    root: false,
    resource: 'sales',
    element: { type: 'Bars', props: { dataPath: '/sales', height: 180 } },
  },
  {
    id: 'sales-headline',
    description: 'Monthly sales as a single headline number',
    root: false,
    resource: 'sales',
    element: {
      type: 'Metric',
      props: { label: 'Sales, best month', value: { $state: '/sales-best' } },
    },
  },

  {
    id: 'status-healthy',
    description: 'A green badge saying billing is healthy',
    root: false,
    element: {
      type: 'Badge',
      props: { text: 'billing healthy', tone: 'success' },
    },
  },

  {
    id: 'field-team',
    description: 'An editable team name field',
    root: false,
    element: {
      type: 'Field',
      props: { label: 'Team name', value: { $bindState: '/team' } },
    },
  },
  {
    id: 'toggle-compact',
    description: 'A switch for compact layout',
    root: false,
    element: {
      type: 'Toggle',
      props: { label: 'Compact layout', checked: { $bindState: '/compact' } },
    },
  },
  {
    id: 'toggle-emails',
    description: 'A switch for weekly email summaries',
    root: false,
    element: {
      type: 'Toggle',
      props: {
        label: 'Weekly email summary',
        checked: { $bindState: '/email' },
      },
    },
  },

  {
    id: 'action-reroll',
    description: 'A button that re-rolls the sales numbers',
    root: false,
    element: {
      type: 'Action',
      props: { label: 'Re-roll', primary: true },
      on: { press: { action: 'shuffle', params: { path: '/sales' } } },
    },
  },
] satisfies Experimental_CompositionCandidate[];

// --- 4. the state, and the registry ----------------------------------------

const initialState = {
  team: 'Platform',
  compact: false,
  email: true,
  revenue: { total: '$48,200', growth: '+12%', churn: '-1.4%' },
  sales: MONTHS.map((label, i) => ({ label, value: 120 + i * 37 })),
  'sales-best': '$305k in Jun',
};

const store = createStateStore(initialState);

const setState: SetState = (updater) => {
  const next = updater(store.getSnapshot());
  store.update(
    Object.fromEntries(Object.keys(next).map((k) => [`/${k}`, next[k]])),
  );
};

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
    Panel: ({ props, children }) => (
      <box style={{ flexDirection: 'column', gap: 10, padding: 14 }}>
        <text style={{ fontSize: 17, color: '$text' }}>{props.title}</text>
        {children}
      </box>
    ),

    Heading: ({ props }) => (
      <text style={{ fontSize: 13, color: '$text' }}>{props.text}</text>
    ),

    Note: ({ props }) => (
      <text style={{ fontSize: 11, color: '$textMuted' }}>{props.text}</text>
    ),

    Metric: ({ props }) => (
      <box style={{ flexDirection: 'column', gap: 2 }}>
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
    shuffle: async (params, set) => {
      const rows = MONTHS.map((label) => ({
        label,
        value: Math.round(40 + Math.random() * 260),
      }));
      const path = params?.path ?? '/sales';
      set((prev) => immutableSetByPath(prev, path, rows) as typeof prev);
    },
  },
});

const actionHandlers = handlers(
  () => setState,
  () => store.getSnapshot(),
);

// --- 5. driving the composer -----------------------------------------------

const PROMPTS = [
  'Show revenue for this quarter with a chart and a re-roll button',
  'Account settings: the team name and the notification switches',
  'Just the headline revenue and growth numbers, no chart',
  'Book me a flight to Melbourne',
];

const COMPOSITION_LIMITS = { maxSteps: 12, maxElements: 14, maxDepth: 4 };

/** The "Composition" tab. */
export function CompositionTab(): ReactElement {
  const { run, compose } = useComposer({
    catalog,
    initialState,
    limits: COMPOSITION_LIMITS,
    // A fixed candidate list: every prompt is offered the same fourteen.
    prepare: () => ({ candidates, meta: undefined }),
  });
  const kept = useMemo(
    () => (run.spec ? Object.keys(run.spec.elements).length : 0),
    [run.spec],
  );

  return (
    <box style={{ flexDirection: 'row', flexGrow: 1, gap: 14, padding: 14 }}>
      {/* Scrolls: without a key the setup steps alone are most of the
            column's height. */}
      <box
        style={{
          flexDirection: 'column',
          gap: 8,
          width: 300,
          overflow: 'scroll',
        }}
      >
        <text style={{ fontSize: 13, color: '$text' }}>Compose a screen</text>
        <text style={{ fontSize: 10, color: '$textMuted' }}>
          No spec is written anywhere. The composer offers the candidates to a
          decision model, which answers "is this one needed?" and "where does it
          go?" — nothing else.
        </text>
        <ModelSetup />
        <PromptList prompts={PROMPTS} busy={run.busy} onPick={compose} />
        <Line muted>{`${candidates.length} candidates, ${kept} kept`}</Line>
        <Heading>Trace</Heading>
        <Trace run={run} />
      </box>
      <Preview
        run={run}
        store={store}
        registry={registry}
        handlers={actionHandlers}
        idle="Pick a prompt. The last one asks for something no candidate covers — that is what `unavailable` looks like."
        empty="Nothing composed — the request is outside what these candidates can do. The Flights tab is what it takes to change that."
      />
    </box>
  );
}
