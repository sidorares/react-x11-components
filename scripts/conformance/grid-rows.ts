// Writes `test/html/grid-rows.ts`: grids of two or three items to a row in
// columns of random heights, and where Chromium puts each piece of each item
// and of each grid. A row the columns end inside is broken an item at a time,
// each item going on at the head of the next column from its own break, so
// the cases are rows whose items break in different places. The cases are
// kept and measured again; any added here go after them:
//
//   CHROME=<chromium> node --import tsx scripts/conformance/grid-rows.ts \
//     [--add <count>] [--seed <seed>] [--forced --out <file>]
//
// A forced break inside an item is left out of the fixture: where one is,
// Blink ends the row's piece at the column's foot, and chooses balanced
// columns by rules of its own, so such a row goes as it did (`gridRows`).
// `--forced` makes such cases, to measure them, into another file
// (`--out`), never the fixture.
//
// Every case the generator made is in the fixture. Those in `KNOWN` differ
// from Chromium where an item is aligned in its row rather than stretched:
// Blink keeps such an item where alignment put it before the row broke,
// and moves some such rows to the next column whole, by rules this does
// not follow yet. The test leaves them out by name; take one out of the
// list when it comes to match.
//
// Nothing in a case is text, which a platform's fonts would set at another
// height: every line is a line of inline blocks at `line-height: 0`, or a
// block of a height, and none is taller than the shortest column, which a
// fragment holding it would be as tall as. The items are as tall as their
// rows. Never edit the fixture by hand: regenerate it.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from '../zengarden/chrome.js';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const forced = args.includes('--forced');
/** The cases known to differ from Chromium, by id (see above). */
const KNOWN: string[] = [
  'c3',
  'c4',
  'c8',
  'c13',
  'c15',
  'c19',
  'c20',
  'c21',
  'c40',
  'c46',
  'c57',
  'c59',
  'c60',
  'c67',
  'c79',
  'c80',
  'c83',
  'c84',
];
const FIXTURE =
  outAt >= 0
    ? new URL(args[outAt + 1], `file://${process.cwd()}/`)
    : new URL('../../test/html/grid-rows.ts', import.meta.url);
if (forced && outAt < 0) {
  throw new Error('--forced writes to --out, never the fixture');
}
const option = (name: string, otherwise: number): number => {
  const at = args.indexOf(name);
  return at < 0 ? otherwise : Number(args[at + 1]);
};
const count = option('--add', 0);

// mulberry32: small, seeded, and the same on every machine
let state = option('--seed', 1) >>> 0;
const next = (): number => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
const int = (from: number, to: number): number =>
  from + Math.floor(next() * (to - from + 1));

const STYLE =
  '<style>body{margin:0}.case{position:relative;margin-bottom:20px}' +
  '.case i{display:inline-block;width:20px;vertical-align:top}</style>\n';

/** One case: a multicol container, something before its grid, and the
 *  grid, whose items are `c<n>i<k>` and which is `c<n>g`. */
function makeCase(n: number): string {
  const columns = int(2, 4);
  const height = pick([60, 80, 100, 120]);
  const fill = pick(['auto', 'balance']);
  const tracks = int(2, 3);
  const rows = int(1, 2);
  const before = pick([0, 0, 10, 30, 50]);
  const items: string[] = [];
  for (let k = 0; k < tracks * rows; k += 1) {
    const css = ['line-height:0'];
    const self = pick(['', '', '', 'align-self:end', 'align-self:start']);
    if (self) css.push(self);
    const parts: string[] = [];
    const lines = next() < 0.6;
    const many = int(1, 3);
    for (let j = 0; j < many; j += 1) {
      const h = pick([10, 20, 30, 40, 50]);
      const breaks =
        forced && j > 0 && next() < 0.3 ? ';break-before:column' : '';
      parts.push(
        lines && !breaks
          ? `<div><i style="height:${h}px"></i></div>`
          : `<div style="height:${h}px${breaks}"></div>`,
      );
    }
    items.push(
      `<div id="c${n}i${k}" style="${css.join(';')}">${parts.join('')}</div>`,
    );
  }
  return (
    `<div class="case" id="c${n}" style="columns:${columns};column-gap:0;` +
    `column-fill:${fill};width:${columns * 60}px;height:${height}px">` +
    (before ? `<div style="height:${before}px"></div>` : '') +
    `<div id="c${n}g" style="display:grid;grid-template-columns:repeat(${tracks},20px)">` +
    items.join('') +
    '</div></div>'
  );
}

let kept: string[] = [];
try {
  const [, body] = readFileSync(FIXTURE, 'utf8').match(
    /GRID_ROWS_DOCUMENT = `<style>[^\n]*\n([^`]*)`/,
  )!;
  kept = body.split('\n').filter(Boolean);
} catch {
  // a first run, with no fixture yet
}
const cases = kept.slice();
for (let i = 0; i < count; i += 1) cases.push(makeCase(cases.length));

const page = join(tmpdir(), `grid-rows-${process.pid}.html`);
writeFileSync(page, `<!doctype html>${STYLE}${cases.join('\n')}\n`);
const chrome = await Chrome.launch();
try {
  const { targetId } = (await chrome.send('Target.createTarget', {
    url: pathToFileURL(page).href,
  })) as { targetId: string };
  const { sessionId } = (await chrome.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  const { result } = (await chrome.send(
    'Runtime.evaluate',
    {
      expression: `new Promise((done) => {
        const read = () => {
          const out = {};
          for (const box of document.querySelectorAll('.case')) {
            const at = box.getBoundingClientRect();
            for (const el of box.querySelectorAll('[id]')) {
              out[el.id] = [...el.getClientRects()]
                .filter((r) => r.width > 0 && r.height > 0)
                .map((r) => [r.x - at.x, r.y - at.y, r.width, r.height]);
            }
          }
          done(JSON.stringify(out));
        };
        document.readyState === 'complete'
          ? read()
          : addEventListener('load', read);
      })`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  )) as { result: { value: string } };
  const rects = JSON.parse(result.value) as Record<string, number[][]>;
  const { product } = (await chrome.send('Browser.getVersion')) as {
    product: string;
  };
  const version = product.match(/\/(\d+)/)![1];
  const entries = Object.entries(rects)
    .map(([id, list]) => `  ${id}: ${JSON.stringify(list)},`)
    .join('\n');
  const text = `// Where each piece of each grid item, and of each grid, is in columns, as
// Chromium ${version} has it, from the top left of its multicol container:
// \`scripts/conformance/grid-rows.ts\` writes this file, and nothing in it is
// written by hand. The rows are broken an item at a time.

export const GRID_ROWS_DOCUMENT = \`${STYLE}${cases.join('\n')}
\`;

export const GRID_ROWS_RECTS: Record<string, number[][]> = {
${entries}
};

/** The cases known to differ from Chromium (\`KNOWN\` in the script). */
export const GRID_ROWS_KNOWN: string[] = ${JSON.stringify(forced ? [] : KNOWN)};
`;
  // as prettier writes it, which the repository holds every file to
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(FIXTURE.pathname)) ?? {};
  writeFileSync(
    FIXTURE,
    await prettier.format(text, { ...options, parser: 'typescript' }),
  );
  console.log(`${cases.length} cases, ${cases.length - kept.length} new`);
} finally {
  await chrome.close();
}
