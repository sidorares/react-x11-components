// The CSS Zen Garden, page by page, against Chrome.
//
//   npm run bench:zengarden                  resume after the last pass
//   npm run bench:zengarden -- --page 7      one page; the state is untouched
//   npm run bench:zengarden -- --from 12 --keep-going
//
// Options: --width 1280 --height 800 (the viewport), --out dir (reports,
// default zengarden-results/), --last N (the newest design, default 221).
//
// Each design (https://www.csszengarden.com/001/ …) is rendered twice: by
// Chrome, headless with JavaScript off (`chrome.ts`), and by <Html> as the
// browser example renders it (`ours.tsx`). The two are compared box by box
// and in blocks of pixels (`compare.ts`); a page passes when no element
// sits or sizes differently past the tolerance and the pixels agree.
//
// `state.json` is the bench's memory, and is committed:
//   lastPassed  the design a plain run resumes after — every page up to it
//               passed, or is an exception
//   exceptions  designs skipped for now, each with why, so that a page
//               nobody is fixing yet does not stop the run
// A plain run stops at the first page that fails and leaves its report —
// chrome.png, ours.png, diff.png, report.txt — under <out>/<NNN>/.
//
// `--native` draws our side on react-x11's native backend (`native.tsx`),
// the window the browser example opens on Windows or a Mac, where it is
// otherwise the in-process X server. Such a run starts at 001, reports
// under zengarden-results/native/, keeps its cache with the X11 run's, and
// leaves `state.json` alone: that is the X11 run's memory.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

import { Chrome } from './chrome.js';
import type { Capture, Image } from './chrome.js';
import { compareBoxes, visualDiff } from './compare.js';
import type { Finding } from './compare.js';
import { CachedNetwork, capture } from './ours.js';
import { captureNative, closeNative } from './native.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATE = join(HERE, 'state.json');

interface State {
  lastPassed: number;
  exceptions: Record<string, string>;
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const number = (name: string, fallback: number) =>
  option(name) !== undefined ? Number(option(name)) : fallback;

const width = number('--width', 1280);
const height = number('--height', 800);
const last = number('--last', 221);
const native = args.includes('--native');
const out = resolve(
  option('--out') ??
    (native ? join('zengarden-results', 'native') : 'zengarden-results'),
);
const keepGoing = args.includes('--keep-going');
const only = option('--page');
/** The most of a page compared, top down: a design is rarely longer. */
const maxHeight = number('--max-height', 12000);
/** Blocks of pixels that may differ, as a fraction of the page. */
const visualAllowance = Number(option('--visual') ?? 0.01);

const state = JSON.parse(readFileSync(STATE, 'utf8')) as State;
const pad = (n: number) => String(n).padStart(3, '0');

const from = number('--from', native ? 1 : state.lastPassed + 1);
const pages: number[] = only
  ? [Number(only)]
  : Array.from({ length: Math.max(0, last - (from - 1)) }, (_, i) => from + i);

const network = new CachedNetwork(
  native ? resolve('zengarden-results', 'cache') : join(out, 'cache'),
);
const ourCapture = native ? captureNative : capture;
const chrome = await Chrome.launch();
let failed = 0;
try {
  for (const n of pages) {
    const id = pad(n);
    const why = state.exceptions[id];
    if (why && !only) {
      console.log(`${id}  skipped: ${why}`);
      if (!failed) advance(n);
      continue;
    }
    const url = `https://www.csszengarden.com/${id}/`;
    const started = Date.now();
    const size = { width, height, maxHeight };
    let reference: Capture;
    let ours: Capture | null;
    try {
      reference = await chrome.capture(url, size);
      ours = await ourCapture(network, url, size);
      // a page drawn without a file its server never answered for is not
      // the page
      const dropped = network.takeDropped();
      if (dropped.length) {
        throw new Error(`no answer from the server for ${dropped.join(', ')}`);
      }
    } catch (error) {
      network.takeDropped();
      console.log(`${id}  error: ${(error as Error).stack ?? error}`);
      failed += 1;
      if (!keepGoing) break;
      continue;
    }
    if (!ours) {
      console.log(`${id}  no such design`);
      if (!failed && !only) advance(n);
      continue;
    }
    const order = [...ours.boxes.keys()];
    const findings = compareBoxes(reference.boxes, ours.boxes, order);
    const visual = visualDiff(reference.image, ours.image);
    const pass =
      findings.length === 0 &&
      visual.fraction <= visualAllowance &&
      Math.abs(reference.height - ours.height) <= 3;
    const dir = join(out, id);
    mkdirSync(dir, { recursive: true });
    writePng(join(dir, 'chrome.png'), reference.image);
    writePng(join(dir, 'ours.png'), ours.image);
    writePng(join(dir, 'diff.png'), visual.image);
    const summary =
      `${id}  ${pass ? 'pass' : 'FAIL'}  ${findings.length} box findings, ` +
      `${(visual.fraction * 100).toFixed(2)}% of blocks differ, ` +
      `height Chrome ${reference.height} ours ${ours.height}, ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s`;
    writeFileSync(
      join(dir, 'report.txt'),
      [summary, url, '', ...findings.map(line)].join('\n') + '\n',
    );
    console.log(summary);
    if (pass) {
      if (!failed && !only) advance(n);
      continue;
    }
    failed += 1;
    for (const finding of findings.slice(0, 15))
      console.log(`    ${line(finding)}`);
    if (findings.length > 15) console.log(`    … ${findings.length - 15} more`);
    console.log(`    report: ${dir}`);
    if (!keepGoing) break;
  }
} finally {
  await chrome.close();
  if (native) await closeNative();
}
process.exit(failed ? 1 : 0);

function line(finding: Finding): string {
  return `${finding.kind.padEnd(11)} ${finding.path}: ${finding.delta}`;
}

/** Record `n` as passed, when every page before it has. */
function advance(n: number): void {
  if (native || n !== state.lastPassed + 1) return;
  state.lastPassed = n;
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
}

function writePng(path: string, image: Image): void {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  writeFileSync(path, PNG.sync.write(png));
}
