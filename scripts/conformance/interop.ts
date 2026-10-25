// The Interop 2026 score of <Html scripts>, as wpt.fyi works it out for a
// browser: the tests each focus area's label names in wpt-metadata, run
// through `testharness.tsx` against WPT's own server, and scored by the
// rule results-analysis scores a run with.
//
//   npx tsx scripts/conformance/interop.ts <wpt root> <wpt-metadata root>
//     [--jobs N] [--out dir] [--chunk N] [--only label,label] [--memory 4G]
//
// `<wpt root>` must be serving: `./wpt serve` in it, with `server_host` set
// to 127.0.0.1 and `check_subdomains` off where the machine does not map
// web-platform.test (the children resolve it themselves). Neither checkout
// is vendored —
//
//   git clone --depth 1 https://github.com/web-platform-tests/wpt-metadata.git
//   git clone --depth 1 --filter=blob:none --sparse \
//     https://github.com/web-platform-tests/wpt.git
//
// Each child runs in a cgroup of its own capped at `--memory`, where the
// user's systemd can make one (`systemd-run --user --scope`): a document
// that runs away with memory is then the death of its child, recorded as a
// crash, and not of the machine. One in the Interop 2026 set does —
// `fetch/api/basic/request-upload.h2.any.worker.html` grows past 27 GB.
//
// A test scores the fraction of its subtests that pass, in thousandths and
// rounded down; a reftest or a crashtest 1000 or 0; a test with no result 0.
// A focus area is the mean of its tests, rounded down, and the total the
// mean of the areas (results-analysis, `interop-scoring/main.js`).
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const jobs = Number(flag('--jobs', '6'));
const out = resolve(flag('--out', 'interop-results'));
const chunkSize = Number(flag('--chunk', '20'));
const only = flag('--only', '').split(',').filter(Boolean);
const memory = flag('--memory', '4G');
const [wptRoot, metadataRoot] = args;
if (!wptRoot || !metadataRoot) {
  console.error('usage: interop.ts <wpt root> <wpt-metadata root> [--jobs N]');
  process.exit(2);
}
const WPT = resolve(wptRoot);
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Interop 2026's focus areas and the label each is scored by
 *  (wpt.fyi's `interop-data.json`): anchor positioning carries 2025's. */
const AREAS: Record<string, string> = {
  'anchor-positioning': 'interop-2025-anchor-positioning',
  attr: 'interop-2026-attr',
  'contrast-color': 'interop-2026-contrast-color',
  'container-style-queries': 'interop-2026-container-style-queries',
  'custom-highlights': 'interop-2026-custom-highlights',
  'dialogs-and-popovers': 'interop-2026-dialogs-and-popovers',
  fetch: 'interop-2026-fetch',
  indexeddb: 'interop-2026-indexeddb',
  'jspi-for-wasm': 'interop-2026-jspi-for-wasm',
  'media-pseudo-classes': 'interop-2026-media-pseudo-classes',
  navigation: 'interop-2026-navigation',
  'scoped-custom-element-registries':
    'interop-2026-scoped-custom-element-registries',
  'scroll-driven-animations': 'interop-2026-scroll-driven-animations',
  'scroll-snap': 'interop-2026-scroll-snap',
  shape: 'interop-2026-shape',
  'view-transitions': 'interop-2026-view-transitions',
  webcompat: 'interop-2026-webcompat',
  webrtc: 'interop-2026-webrtc',
  webtransport: 'interop-2026-webtransport',
  zoom: 'interop-2026-zoom',
};

/** Every test a label names, from the META.yml files under the root. */
function labelled(root: string): Map<string, string[]> {
  const byLabel = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'META.yml') {
        const meta = YAML.parse(readFileSync(path, 'utf8')) as {
          links?: Array<{ label?: string; results?: Array<{ test: string }> }>;
        } | null;
        const at = relative(root, dir);
        for (const link of meta?.links ?? []) {
          if (!link.label) continue;
          const list = byLabel.get(link.label) ?? [];
          for (const r of link.results ?? []) {
            list.push(at ? `${at}/${r.test}` : r.test);
          }
          byLabel.set(link.label, list);
        }
      }
    }
  };
  walk(root);
  return byLabel;
}

const labels = labelled(resolve(metadataRoot));
const areas = Object.entries(AREAS).filter(
  ([area]) => only.length === 0 || only.includes(area),
);
const tests = [
  ...new Set(areas.flatMap(([, label]) => labels.get(label) ?? [])),
].sort();
console.log(
  `${tests.length} tests in ${areas.length} focus areas, ${jobs} jobs`,
);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'chunks'), { recursive: true });

const queue: string[][] = [];
for (let i = 0; i < tests.length; i += chunkSize) {
  queue.push(tests.slice(i, i + chunkSize));
}

let serial = 0;
let done = 0;
const extra: string[] = [];

/** How long a child may go without finishing a test: the longest a long
 *  test and a reftest's two documents take, with room. */
const STALL_MS = 120000;

/** Whether a child can be put in a cgroup of its own (`--memory`). */
const capped =
  spawnSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], {
    stdio: 'ignore',
  }).status === 0;
/** `--memory` in bytes, for a child watched rather than capped. */
const memoryBytes = (() => {
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(memory);
  if (!m) throw new Error(`--memory ${memory}: a size like 4G or 512M`);
  const unit = { '': 1, K: 1 << 10, M: 1 << 20, G: 1 << 30, T: 2 ** 40 };
  return Number(m[1]) * unit[m[2].toUpperCase() as keyof typeof unit];
})();
if (!capped) {
  console.log(
    `no systemd-run --user: a child is killed once it is resident past ${memory}`,
  );
}

/**
 * Where no cgroup holds a child (a Mac), the cap is a watch: the child's
 * resident memory every two seconds, and its group killed past `--memory` —
 * recorded as a crash, as the cgroup's kill is. Coarser than a cgroup, since
 * a document can grow a few gigabytes between two looks, but without it
 * `request-upload.h2.any.worker.html` took the machine's memory.
 */
function residentBytes(pid: number): number {
  const ps = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  const kb = Number(ps.stdout?.trim());
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

function runChunk(chunk: string[]): Promise<void> {
  const id = serial++;
  const list = join(out, 'chunks', `${id}.txt`);
  const result = join(out, 'chunks', `${id}.jsonl`);
  writeFileSync(list, chunk.join('\n') + '\n');
  return new Promise((finish) => {
    const command = [
      process.execPath,
      '--experimental-vm-modules',
      '--no-warnings',
      '--import',
      'tsx',
      join(HERE, 'testharness.tsx'),
      list,
      result,
    ];
    const capping = [
      '--user',
      '--scope',
      '--quiet',
      '-p',
      `MemoryMax=${memory}`,
      '-p',
      'MemorySwapMax=0',
      '--',
    ];
    const child = spawn(
      capped ? 'systemd-run' : command[0],
      capped ? [...capping, ...command] : command.slice(1),
      {
        // a group of its own, so a stall kills the child under
        // systemd-run as well as systemd-run
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          REACT_X11_THREADED: '0',
          NODE_EXTRA_CA_CERTS: join(WPT, 'tools/certs/cacert.pem'),
        },
      },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    let size = -1;
    let moved = Date.now();
    const watch = setInterval(() => {
      const now = existsSync(result) ? statSync(result).size : 0;
      if (now !== size) {
        size = now;
        moved = Date.now();
      } else if (Date.now() - moved > STALL_MS) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }
      if (!capped && residentBytes(child.pid!) > memoryBytes) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }
    }, 2000);
    child.on('exit', (code, signal) => {
      clearInterval(watch);
      const seen = new Set(
        existsSync(result)
          ? readFileSync(result, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => (JSON.parse(l) as { test: string }).test)
          : [],
      );
      const missing = chunk.filter((t) => !seen.has(t));
      if (missing.length > 0) {
        // the first one it did not finish is the one it died on
        extra.push(
          JSON.stringify({
            test: missing[0],
            kind: 'unknown',
            status: 'CRASH',
            message:
              `${signal ?? code} ${stderr.trim().split('\n').slice(-3).join(' | ')}`.slice(
                0,
                400,
              ),
          }),
        );
        if (missing.length > 1) queue.push(missing.slice(1));
      }
      done += chunk.length - Math.max(0, missing.length - 1);
      process.stdout.write(`\r${done}/${tests.length}`);
      finish();
    });
  });
}

async function worker(): Promise<void> {
  for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
    await runChunk(chunk);
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: jobs }, worker));
process.stdout.write('\n');

const lines: string[] = [];
for (const file of readdirSync(join(out, 'chunks'))) {
  if (file.endsWith('.jsonl')) {
    lines.push(
      ...readFileSync(join(out, 'chunks', file), 'utf8')
        .split('\n')
        .filter(Boolean),
    );
  }
}
lines.push(...extra);
lines.sort();
writeFileSync(join(out, 'results.jsonl'), lines.join('\n') + '\n');
rmSync(join(out, 'chunks'), { recursive: true, force: true });

interface Result {
  test: string;
  kind: string;
  status: string;
  subtests?: Array<{ status: string }>;
}
const results = new Map<string, Result>();
for (const line of lines) {
  const r = JSON.parse(line) as Result;
  results.set(r.test, r);
}

/** A test's score in thousandths, as results-analysis has it. */
function scoreOf(r: Result | undefined): {
  passes: number;
  total: number;
  score: number;
} {
  if (!r) return { passes: 0, total: 1, score: 0 };
  if (r.kind === 'testharness' && r.subtests && r.subtests.length > 0) {
    const passes = r.subtests.filter((s) => s.status === 'PASS').length;
    const total = r.subtests.length;
    return { passes, total, score: Math.floor((1000 * passes) / total) };
  }
  const pass = r.status === 'PASS' ? 1 : 0;
  return { passes: pass, total: 1, score: pass * 1000 };
}

const report: Record<string, unknown> = {};
let sum = 0;
console.log(
  `\n${'focus area'.padEnd(34)} ${'tests'.padStart(5)} ${'subtests'.padStart(13)} ${'score'.padStart(6)}`,
);
for (const [area, label] of areas) {
  const set = [...new Set(labels.get(label) ?? [])];
  let total = 0;
  let passes = 0;
  let subtests = 0;
  for (const test of set) {
    const s = scoreOf(results.get(test));
    total += s.score;
    passes += s.passes;
    subtests += s.total;
  }
  const score = set.length ? Math.floor(total / set.length) : 0;
  sum += score;
  report[area] = { label, tests: set.length, passes, subtests, score };
  console.log(
    `${area.padEnd(34)} ${String(set.length).padStart(5)} ${`${passes}/${subtests}`.padStart(13)} ${(score / 10).toFixed(1).padStart(5)}%`,
  );
}
const overall = areas.length ? sum / areas.length : 0;
console.log(`${'total'.padEnd(54)} ${(overall / 10).toFixed(1).padStart(5)}%`);
writeFileSync(
  join(out, 'scores.json'),
  JSON.stringify({ overall: overall / 10, areas: report }, null, 2) + '\n',
);
console.log(`in ${Math.round((Date.now() - started) / 1000)} s`);
