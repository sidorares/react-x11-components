// htmlpage.mjs's lines as a table, a page a row; with a second file, each
// cell that moved as `was→now`.
//
//   node scripts/bench/sweep/htmlpagetab.mjs now.jsonl [was.jsonl]
//
// Several files joined with `+` are read as repetitions, and each cell is
// their median: `a.jsonl+b.jsonl+c.jsonl`.
import { readFileSync } from 'node:fs';

const COLUMNS = [
  ['elems', 'elements'],
  ['first', 'load.first'],
  ['settle', 'load.settle'],
  ['cpu', 'load.cpu'],
  ['gc', 'load.gc'],
  ['allocMB', 'load.alloc'],
  ['block', 'load.block'],
  ['re.set', 'reload.settle'],
  ['re.cpu', 'reload.cpu'],
  ['scr50', 'scroll.frame50'],
  ['scr95', 'scroll.frame95'],
  ['scrMax', 'scroll.frameMax'],
  ['scrCpu', 'scroll.cpu'],
  ['scrMB', 'scroll.alloc'],
  ['rsz50', 'resize.frame50'],
  ['rsz95', 'resize.frame95'],
  ['rszMax', 'resize.frameMax'],
  ['rszCpu', 'resize.cpu'],
  ['rszMB', 'resize.alloc'],
  ['hovCpu', 'hover.cpu'],
  ['heap', 'heap'],
];

const read = (spec) => {
  const runs = spec.split('+').map((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('RESULT '))
      .map((l) => JSON.parse(l.slice(7))),
  );
  const byName = new Map();
  for (const run of runs)
    for (const r of run) {
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name).push(r);
    }
  return byName;
};
const at = (r, path) => path.split('.').reduce((o, k) => o?.[k], r);
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};
const cell = (rows, path) => median(rows.map((r) => at(r, path)));
const fmt = (v) =>
  !Number.isFinite(v)
    ? '-'
    : v >= 100
      ? String(Math.round(v))
      : v >= 10
        ? v.toFixed(1)
        : v.toFixed(2);

const [nowSpec, wasSpec] = process.argv.slice(2);
const now = read(nowSpec);
const was = wasSpec ? read(wasSpec) : null;
const header = [
  'page'.padEnd(34),
  ...COLUMNS.map(([c]) => c.padStart(wasSpec ? 13 : 7)),
];
console.log(header.join(' '));
const totals = COLUMNS.map(() => [0, 0]);
for (const [name, rows] of now) {
  const old = was?.get(name);
  const cells = COLUMNS.map(([, path], i) => {
    const v = cell(rows, path);
    if (Number.isFinite(v)) totals[i][0] += v;
    if (!old) return fmt(v).padStart(wasSpec ? 13 : 7);
    const o = cell(old, path);
    if (Number.isFinite(o)) totals[i][1] += o;
    const moved = Math.abs(v - o) > Math.max(0.1 * Math.abs(o), 0.05);
    return (moved ? `${fmt(o)}→${fmt(v)}` : fmt(v)).padStart(13);
  });
  console.log([name.slice(0, 34).padEnd(34), ...cells].join(' '));
}
console.log(
  [
    'TOTAL'.padEnd(34),
    ...totals.map(([n, o]) =>
      (was ? `${fmt(o)}→${fmt(n)}` : fmt(n)).padStart(wasSpec ? 13 : 7),
    ),
  ].join(' '),
);
