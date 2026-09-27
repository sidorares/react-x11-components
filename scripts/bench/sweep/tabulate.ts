// A sweep's results as Markdown tables, one per suite — or two sweeps side by
// side, when a baseline is given: a cell that moved by more than the noise
// shows both numbers, and one that got worse is marked.
//
//   npx tsx scripts/bench/sweep/tabulate.ts results.jsonl
//   npx tsx scripts/bench/sweep/tabulate.ts after.jsonl before.jsonl
import { readFileSync } from 'node:fs';

type Row = Record<string, any>;

const load = (file: string): Row[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => normalize(JSON.parse(line) as Row));

/** Results from before the probes said which suite and which variant they
 *  ran: the Flow matrix's rows carry a scene and no suite, and the variant
 *  is in the environment `run.sh` recorded. */
function normalize(r: Row): Row {
  if (!r.suite && r.scene && r.asked) r.suite = 'flow';
  // an instrumented run pays for its counters: not a number to compare
  if (typeof r.action === 'string' && r.action.endsWith('-diag'))
    r.suite = 'diag';
  if (r.variant == null && typeof r.env === 'string') {
    const env = r.env as string;
    r.variant = [
      /\bPLAIN=1\b/.test(env) ? 'plain' : '',
      /\bSIZE=(\d+)/.exec(env)?.[1]
        ? `size ${/\bSIZE=(\d+)/.exec(env)![1]}`
        : '',
      /\bLINES=(\d+)/.exec(env)?.[1]
        ? `${/\bLINES=(\d+)/.exec(env)![1]} lines`
        : '',
    ]
      .filter(Boolean)
      .join(', ');
  }
  return r;
}

const [file, baseFile] = process.argv.slice(2);
if (!file) {
  console.error('usage: tabulate.ts <results.jsonl> [<baseline.jsonl>]');
  process.exit(1);
}
const rows = load(file);
const base = baseFile ? load(baseFile) : [];
for (const r of rows) if (r.failed) console.log(`FAILED ${r.failed}`);

/** What a cell reports: frames a second (more is better) or milliseconds
 *  (less is better), and the noise below which a change is not shown. */
interface Metric {
  label: string;
  value: (r: Row) => number | undefined;
  higherIsBetter: boolean;
}
const fps: Metric = { label: 'fps', value: (r) => r.fps, higherIsBetter: true };
const firstPaint: Metric = {
  label: 'first paint, ms',
  value: (r) => r.firstPaint,
  higherIsBetter: false,
};
const latency: Metric = {
  label: 'input to paint p50, ms',
  value: (r) => r.lat50,
  higherIsBetter: false,
};
const frame: Metric = {
  label: 'frame p50, ms',
  value: (r) => r.frame50,
  higherIsBetter: false,
};

interface Column {
  title: string;
  match: (r: Row) => boolean;
}
interface Suite {
  name: string;
  key: (r: Row) => string;
  metrics: (r: Row) => Metric[];
  columns: Column[];
}

const onBackend =
  (backend: string, extra?: (r: Row) => boolean): Column['match'] =>
  (r) =>
    r.backend === backend && (extra ? extra(r) : true);
const mounts = new Set(['mount', 'long-mount']);

const SUITES: Suite[] = [
  {
    name: 'flow',
    key: (r) =>
      r.W !== 1100
        ? `${r.scene} · ${r.action}, the stress example's view, map ${r.map ? 'on' : 'off'}`
        : `${r.scene} · ${r.action} z${r.zoom}`,
    metrics: () => [fps],
    columns: [
      { title: 'X11 2D', match: onBackend('x11', (r) => r.asked === '2d') },
      { title: 'X11 GL', match: onBackend('x11', (r) => r.asked === 'gl') },
      { title: 'Cocoa 2D', match: onBackend('cocoa', (r) => r.asked === '2d') },
      { title: 'Cocoa GL', match: onBackend('cocoa', (r) => r.asked === 'gl') },
    ],
  },
  {
    name: 'maps',
    key: (r) => r.action,
    metrics: () => [fps],
    columns: [
      {
        title: 'X11 retained',
        match: onBackend('x11', (r) => r.asked === 'retained'),
      },
      { title: 'X11 GL', match: onBackend('x11', (r) => r.asked === 'gl') },
      {
        title: 'Cocoa retained',
        match: onBackend('cocoa', (r) => r.asked === 'retained'),
      },
      { title: 'Cocoa GL', match: onBackend('cocoa', (r) => r.asked === 'gl') },
    ],
  },
  ...['charts', 'table'].map((name): Suite => ({
    name,
    key: (r) => r.action,
    metrics: () => [fps, frame],
    columns: [
      { title: 'X11', match: onBackend('x11') },
      { title: 'Cocoa', match: onBackend('cocoa') },
    ],
  })),
  ...['docs', 'editors'].map((name): Suite => ({
    name,
    key: (r) => `${r.comp} · ${r.action}${r.variant ? ` (${r.variant})` : ''}`,
    metrics: (r) => (mounts.has(r.action) ? [firstPaint] : [latency, fps]),
    columns: [
      { title: 'X11', match: onBackend('x11') },
      { title: 'Cocoa', match: onBackend('cocoa') },
    ],
  })),
];

const round = (v: number) =>
  v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;

/** The number, or "was → now" when it moved by more than 10% and by more
 *  than a frame's worth of noise; ⚠ when the move was the wrong way. */
function cell(
  metric: Metric,
  now: Row | undefined,
  was: Row | undefined,
): string {
  const n = now && metric.value(now);
  if (n == null || Number.isNaN(n)) return '—';
  const fellBack =
    now!.asked === 'gl' && now!.renderer && now!.renderer !== 'gl' ? '²' : '';
  const o = was && metric.value(was);
  if (o == null || Number.isNaN(o)) return `${round(n)}${fellBack}`;
  const noise = metric.higherIsBetter ? 3 : 1;
  if (Math.abs(n - o) <= Math.max(noise, Math.abs(o) * 0.1))
    return `${round(n)}${fellBack}`;
  const better = metric.higherIsBetter ? n > o : n < o;
  return `${round(o)} → **${round(n)}**${fellBack}${better ? '' : ' ⚠'}`;
}

for (const suite of SUITES) {
  const mine = rows.filter((r) => !r.failed && r.suite === suite.name);
  if (!mine.length) continue;
  const theirs = base.filter((r) => !r.failed && r.suite === suite.name);
  const keys = [...new Set(mine.map(suite.key))];
  // one table per distinct set of metrics, so a mount's first paint and a
  // gesture's latency are not in one column
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const sample = mine.find((r) => suite.key(r) === key)!;
    const label = suite
      .metrics(sample)
      .map((m) => m.label)
      .join(' / ');
    groups.set(label, [...(groups.get(label) ?? []), key]);
  }
  for (const [label, group] of groups) {
    console.log(`\n### ${suite.name}: ${label}\n`);
    console.log(`| | ${suite.columns.map((c) => c.title).join(' | ')} |`);
    console.log(`| --- | ${suite.columns.map(() => '--:').join(' | ')} |`);
    for (const key of group) {
      const cells = suite.columns.map((column) => {
        const now = mine.find((r) => suite.key(r) === key && column.match(r));
        const was = theirs.find((r) => suite.key(r) === key && column.match(r));
        if (!now && !was) return '—';
        const metrics = suite.metrics((now ?? was)!);
        return metrics.map((m) => cell(m, now, was)).join(' / ');
      });
      console.log(`| ${key} | ${cells.join(' | ')} |`);
    }
  }
}
