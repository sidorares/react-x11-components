// `htmlsweep.mjs`'s RESULT lines as tables: the corpus's totals, each
// measurement's distribution, and the documents that cost the most of it.
// With a second file, each document's change against it as well.
//
//   node scripts/bench/sweep/htmltab.mjs new.jsonl [old.jsonl]
import { readFileSync } from 'node:fs';

const read = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('RESULT '))
    .map((line) => JSON.parse(line.slice('RESULT '.length)));

const [now, was] = process.argv.slice(2).map(read);
const ok = now.filter((r) => !r.failed);
const failed = now.filter((r) => r.failed);

const METRICS = [
  'first',
  'settle',
  'cpu',
  'builds',
  'textLayouts',
  'textMs',
  'parse',
  'cold',
  'restyle',
  'build',
  'relayout',
  'resize',
  'paint',
  'frame',
  'scroll50',
  'scrollMax',
  'hover50',
  'hoverMax',
  'hoverFrame50',
  'heap',
];

const q = (xs, p) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const f = (v) =>
  Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : '–';
const pad = (s, n) => String(s).padStart(n);

console.log(
  `${ok.length} documents${failed.length ? `, ${failed.length} failed: ${failed.map((r) => r.name).join(' ')}` : ''}`,
);
const total = (key) =>
  ok.reduce((s, r) => s + (Number.isFinite(r[key]) ? r[key] : 0), 0);
console.log(
  `to render them all: ${f(total('settle') / 1000)} s to settle, ${f(total('cpu') / 1000)} s of processor, ` +
    `${f(total('first') / 1000)} s to first frames`,
);
console.log('\nmetric          p50      p90      max   sum      worst');
for (const key of METRICS) {
  const xs = ok.map((r) => r[key]);
  const worst = [...ok]
    .filter((r) => Number.isFinite(r[key]))
    .sort((a, b) => b[key] - a[key])
    .slice(0, 5);
  console.log(
    `${key.padEnd(12)} ${pad(f(q(xs, 0.5)), 8)} ${pad(f(q(xs, 0.9)), 8)} ${pad(f(Math.max(...xs.filter(Number.isFinite))), 8)} ${pad(f(total(key)), 8)}   ` +
      worst.map((r) => `${r.name} ${f(r[key])}`).join(', '),
  );
}

if (was) {
  const old = new Map(was.map((r) => [r.name, r]));
  console.log(
    '\nagainst the older run: the median document, and the documents that moved most',
  );
  for (const key of METRICS) {
    const pairs = ok
      .map((r) => [r, old.get(r.name)])
      .filter(
        ([a, b]) =>
          b && Number.isFinite(a[key]) && Number.isFinite(b[key]) && b[key] > 0,
      );
    if (!pairs.length) continue;
    const ratios = pairs.map(([a, b]) => a[key] / b[key]);
    const moved = pairs
      .map(([a, b]) => ({
        name: a.name,
        a: a[key],
        b: b[key],
        r: a[key] / b[key],
      }))
      .sort((x, y) => Math.abs(Math.log(y.r)) - Math.abs(Math.log(x.r)))
      .slice(0, 4);
    const sumNow = pairs.reduce((s, [a]) => s + a[key], 0);
    const sumWas = pairs.reduce((s, [, b]) => s + b[key], 0);
    console.log(
      `${key.padEnd(12)} median ×${q(ratios, 0.5).toFixed(2)}  sum ${f(sumWas)} → ${f(sumNow)}   ` +
        moved.map((m) => `${m.name} ${f(m.b)}→${f(m.a)}`).join(', '),
    );
  }
}
