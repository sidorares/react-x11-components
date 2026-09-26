// The web-platform-tests reftest run for <Html>, driven across processes.
//
//   npx tsx scripts/conformance/run.ts <wpt root> [dir …] [--backend x11|cocoa]
//     [--jobs N] [--out dir]
//
// X11 runs headless, in node-x11's in-process server. Cocoa renders into a
// real window per job, through core's native backend: fewer jobs, and the
// windows are on screen while it runs.
//
// Finds every reftest under the directories (default `css/CSS2`), splits them
// into chunks and runs each chunk in a child process of `wpt.tsx`. A child
// that crashes or hangs is replaced: the test it was on is recorded as
// `crash`, and the rest of its chunk goes back in the queue. The outcomes are
// merged into <out>/results.jsonl, and `report.ts` summarises them.
//
// The suite is not vendored: check out WPT yourself, sparsely —
//
//   git clone --depth 1 --filter=blob:none --sparse \
//     https://github.com/web-platform-tests/wpt.git
//   git -C wpt sparse-checkout set css/CSS2 css/reference css/support fonts
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const backend = flag('--backend', 'x11') === 'cocoa' ? 'cocoa' : 'x11';
const jobs = Number(
  flag(
    '--jobs',
    String(backend === 'cocoa' ? 4 : Math.max(1, cpus().length - 2)),
  ),
);
const out = resolve(flag('--out', 'conformance-results'));
const chunkSize = Number(flag('--chunk', '150'));
const timeoutMs = Number(flag('--timeout', '240000'));
const [wptRoot, ...dirs] = args;
if (!wptRoot) {
  console.error(
    'usage: run.ts <wpt root> [dir …] [--jobs N] [--out dir] [--chunk N]',
  );
  process.exit(2);
}
const ROOT = resolve(wptRoot);
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Every reftest under a directory: a document with a match or mismatch
 *  link, that is not itself a reference or a support file. */
function reftests(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (/^(reference|support|crashtests|resources)$/.test(entry.name)) {
          continue;
        }
        walk(path);
      } else if (
        /\.(html?|xht|xhtml)$/i.test(entry.name) &&
        !/-(ref|notref)(\.|-|\d)/i.test(entry.name) &&
        /\brel\s*=\s*["']?(match|mismatch)\b/i.test(readFileSync(path, 'utf8'))
      ) {
        found.push(relative(ROOT, path));
      }
    }
  };
  walk(join(ROOT, dir));
  return found.sort();
}

const tests = (dirs.length ? dirs : ['css/CSS2']).flatMap(reftests);
console.log(`${tests.length} reftests, ${backend}, ${jobs} jobs`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'chunks'), { recursive: true });

const queue: string[][] = [];
for (let i = 0; i < tests.length; i += chunkSize) {
  queue.push(tests.slice(i, i + chunkSize));
}

let serial = 0;
let done = 0;
const extra: string[] = [];

function runChunk(chunk: string[]): Promise<void> {
  const id = serial++;
  const list = join(out, 'chunks', `${id}.txt`);
  const result = join(out, 'chunks', `${id}.jsonl`);
  writeFileSync(list, chunk.join('\n') + '\n');
  return new Promise((finish) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(HERE, 'wpt.tsx'), ROOT, list, result],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        // X11 needs no AppKit thread, and without the worker react-x11
        // otherwise moves the run onto, a hung test can be paused and read
        env:
          backend === 'cocoa'
            ? {
                ...process.env,
                WPT_BACKEND: 'cocoa',
                REACT_X11_BACKEND: 'cocoa',
              }
            : { ...process.env, REACT_X11_THREADED: '0' },
      },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
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
            result: 'error',
            error:
              `crash: ${signal ?? code} ${stderr.trim().split('\n').slice(-3).join(' | ')}`.slice(
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

const counts = new Map<string, number>();
for (const line of lines) {
  const { result } = JSON.parse(line) as { result: string };
  counts.set(result, (counts.get(result) ?? 0) + 1);
}
console.log(
  `${lines.length} outcomes in ${Math.round((Date.now() - started) / 1000)} s:`,
  Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
);
