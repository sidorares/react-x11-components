// Writes `test/html/grid-row-contexts.ts`: grids in columns that are not
// plain ones, and where Chromium puts each piece of each item and of each
// grid. A grid's row is broken an item at a time in plain columns alone
// (`layoutColumns`); in these it goes as it did before that was written, and
// `scripts/conformance/grid-rows.ts`, whose cases are all in plain columns,
// says nothing of them. By the class on the case:
//
// - `clone`: `box-decoration-break: clone` on the grid, or on a box around it;
// - `wrap`: rows of columns, of a `column-height` under `column-wrap`;
// - `nested`: a multicol container in another's columns;
// - `repeat`: in a table that repeats its header at each break.
//
// And one in plain columns, whose rows hold what no column's end cuts:
//
// - `whole`: an item, or what an item holds, that is a scroll container, has
//   size containment, is replaced, a table or a multicol container, or is an
//   inline-block, under, at or over the column's height.
//
// The cases are kept and measured again; any added here go after them, as
// many of each class, or of the one `--class` names:
//
//   CHROME=<chromium> node --import tsx \
//     scripts/conformance/grid-row-contexts.ts [--add <count>] \
//     [--class <class>] [--seed <seed>]
//
// Those in `KNOWN` differ from Chromium, and did before a row was broken an
// item at a time (41e331b39), each of them: the test leaves them out by name.
// Take one out of the list when it comes to match, and add none that matched
// there. Nothing in a case is text, as in `grid-rows.ts`. Never edit the
// fixture by hand: regenerate it.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from '../zengarden/chrome.js';

/** The cases that differed from Chromium at 41e331b39, by id. */
const KNOWN: string[] = [
  'c2',
  'c3',
  'c4',
  'c6',
  'c8',
  'c9',
  'c11',
  'c12',
  'c13',
  'c15',
  'c17',
  'c18',
  'c20',
  'c21',
  'c22',
  'c23',
  'c24',
  'c26',
  'c27',
  'c31',
  'c32',
  'c34',
  'c35',
  'c36',
  'c37',
  'c53',
  'c56',
  'c58',
  'c71',
  'c77',
  'c83',
  'c85',
  'c87',
  'c93',
  'c95',
  'c96',
  'c98',
  'c101',
  'c105',
  'c112',
  'c116',
  'c123',
  'c127',
  'c133',
  'c137',
  'c150',
  'c160',
  'c162',
  'c163',
  'c164',
  'c165',
  'c169',
  'c171',
  'c174',
  'c175',
  'c176',
  'c177',
  'c180',
  'c182',
  'c184',
  'c185',
  'c187',
  'c189',
  'c190',
  'c191',
  'c194',
  'c195',
  'c198',
  'c200',
  'c203',
  'c204',
  'c206',
  'c207',
  'c208',
  'c210',
  'c211',
  'c212',
  'c213',
  'c214',
  'c215',
  'c216',
  'c217',
  'c219',
  'c221',
  'c224',
  'c226',
  'c230',
  'c233',
  'c234',
  'c237',
  'c240',
  'c241',
  'c242',
  'c244',
  'c245',
  'c246',
  'c247',
  'c249',
  'c254',
  'c255',
  'c256',
  'c257',
  'c258',
  'c259',
  'c262',
  'c263',
  'c265',
  'c266',
  'c269',
  'c270',
  'c271',
  'c273',
  'c274',
  'c277',
  'c278',
  'c279',
  'c282',
  'c283',
  'c284',
  'c285',
  'c286',
  'c287',
  'c291',
  'c292',
  'c293',
  'c294',
  'c295',
  'c296',
  'c297',
  'c298',
  'c300',
  'c301',
  'c302',
  'c303',
  'c304',
  'c305',
  'c306',
  'c307',
  'c308',
  'c309',
  'c312',
  'c315',
  'c317',
  'c318',
];
const FIXTURE = new URL(
  '../../test/html/grid-row-contexts.ts',
  import.meta.url,
);
const args = process.argv.slice(2);
const option = (name: string, otherwise: number): number => {
  const at = args.indexOf(name);
  return at < 0 ? otherwise : Number(args[at + 1]);
};
const count = option('--add', 0);

// mulberry32: small, seeded, and the same on every machine
let state = option('--seed', 20251122) >>> 0;
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

/** The one class to add to, where `--class` names it. */
const only =
  args.indexOf('--class') < 0 ? '' : args[args.indexOf('--class') + 1];

const STYLE =
  '<style>body{margin:0}.case{position:relative;margin-bottom:200px}' +
  '.case i{display:inline-block;width:20px;vertical-align:top}</style>\n';
const CLONE = 'box-decoration-break:clone;border:solid;border-width:5px 0 10px';

/** The grid of a case, `c<n>g`, whose items are `c<n>i<k>`. */
function grid(n: number, extra: string): string {
  const tracks = int(2, 3);
  const rows = int(1, 2);
  const items: string[] = [];
  for (let k = 0; k < tracks * rows; k += 1) {
    const lines = next() < 0.6;
    const parts: string[] = [];
    for (let j = int(1, 3); j > 0; j -= 1) {
      const h = pick([10, 20, 30, 40, 50]);
      parts.push(
        lines
          ? `<div><i style="height:${h}px"></i></div>`
          : `<div style="height:${h}px"></div>`,
      );
    }
    items.push(
      `<div id="c${n}i${k}" style="line-height:0">${parts.join('')}</div>`,
    );
  }
  return (
    `<div id="c${n}g" style="display:grid;grid-template-columns:` +
    `repeat(${tracks},20px);${extra}">${items.join('')}</div>`
  );
}

const room = (before: number): string =>
  before ? `<div style="height:${before}px"></div>` : '';

const MAKERS: Record<string, (n: number) => string> = {
  clone: (n) => {
    const on = pick(['grid', 'around']);
    const height = pick([80, 100, 120]);
    const columns = int(2, 4);
    const before = pick([0, 10, 30, 50]);
    const body =
      on === 'grid'
        ? grid(n, CLONE)
        : `<div style="${CLONE}">${grid(n, '')}</div>`;
    return (
      `<div class="case clone" id="c${n}" style="columns:${columns};` +
      `column-gap:0;column-fill:${pick(['auto', 'balance'])};` +
      `width:${columns * 60}px;height:${height}px">${room(before)}${body}</div>`
    );
  },
  wrap: (n) => {
    const columns = int(2, 3);
    const before = pick([0, 10, 30, 50]);
    const height = pick([60, 80, 100]);
    return (
      `<div class="case wrap" id="c${n}" style="columns:${columns};` +
      'column-gap:0;row-gap:0;column-fill:auto;column-wrap:wrap;' +
      `column-height:${height}px;width:${columns * 60}px">` +
      `${room(before)}${grid(n, '')}</div>`
    );
  },
  nested: (n) => {
    const before = pick([0, 10, 30, 50]);
    const height = pick([80, 100, 120]);
    const fill = pick(['auto', 'balance']);
    return (
      `<div class="case nested" id="c${n}" style="columns:3;column-gap:0;` +
      `column-fill:auto;width:360px;height:${height}px">${room(before)}` +
      `<div style="columns:2;column-gap:0;column-fill:${fill}">` +
      `${grid(n, '')}</div></div>`
    );
  },
  whole: (n) => {
    const height = pick([60, 80, 100]);
    const tall = pick([30, height, 110, 150]);
    const i = (h: number) => `<i style="height:${h}px"></i>`;
    const line = (h: number) => `<div>${i(h)}</div>`;
    const css = 'line-height:0';
    const make = pick([
      (id: string) =>
        `<div id="${id}" style="${css};contain:size;height:${tall}px">${i(20)}</div>`,
      (id: string) =>
        `<div id="${id}" style="${css};contain:size;height:${tall}px">${line(20)}${line(20)}</div>`,
      (id: string) =>
        `<div id="${id}" style="${css};overflow:auto;height:${tall}px">${i(20)}</div>`,
      (id: string) =>
        `<div id="${id}" style="${css};overflow:hidden">${i(tall)}</div>`,
      (id: string) =>
        `<div id="${id}" style="${css};overflow:hidden">${line(tall)}${line(20)}</div>`,
      (id: string) =>
        `<div id="${id}" style="${css};overflow:scroll;scrollbar-width:none;height:${tall}px">${i(20)}</div>`,
      (id: string) =>
        `<canvas id="${id}" style="width:20px;height:${tall}px"></canvas>`,
      (id: string) =>
        `<div id="${id}" style="${css}"><canvas style="width:20px;height:${tall}px;vertical-align:top"></canvas></div>`,
      (id: string) =>
        `<div id="${id}" style="${css}"><canvas style="display:block;width:20px;height:${tall}px"></canvas>${line(20)}</div>`,
      (id: string) =>
        `<div id="${id}" style="${css};display:table">${line(tall)}${line(20)}</div>`,
      (id: string) =>
        `<div id="${id}" style="${css};columns:2;column-gap:0;height:${tall}px">${i(20)}</div>`,
      (id: string) =>
        `<div id="${id}" style="${css}"><div style="contain:size;height:${tall}px"></div>${line(20)}</div>`,
      (id: string) => `<div id="${id}" style="${css}">${i(tall)}</div>`,
      (id: string) =>
        `<div id="${id}" style="${css}">${line(20)}${line(tall)}</div>`,
    ]);
    const items = [0, 1, 2].slice(0, int(2, 3)).map((k) => {
      const id = `c${n}i${k}`;
      return k === 0 || next() < 0.3
        ? make(id)
        : `<div id="${id}" style="${css}">${line(pick([20, 40, 60]))}${line(pick([20, 40]))}</div>`;
    });
    const before = pick([0, 0, 10, 30, 50]);
    return (
      `<div class="case whole" id="c${n}" style="columns:4;column-gap:0;` +
      `column-fill:${pick(['auto', 'balance'])};width:400px;height:${height}px">` +
      `${room(before)}<div id="c${n}g" style="display:grid;grid-template-` +
      `columns:repeat(${items.length},30px)">${items.join('')}</div>` +
      `<div id="c${n}i9" style="height:10px"></div></div>`
    );
  },
  repeat: (n) => {
    const before = pick([0, 10, 30]);
    const height = pick([80, 100, 120]);
    return (
      `<div class="case repeat" id="c${n}" style="columns:3;column-gap:0;` +
      `column-fill:auto;width:300px;height:${height}px">${room(before)}` +
      '<table style="border-spacing:0;line-height:0"><thead><tr>' +
      '<td style="padding:0"><div style="height:10px;break-inside:avoid">' +
      '</div></td></tr></thead><tbody><tr><td style="padding:0">' +
      `${grid(n, '')}</td></tr></tbody></table></div>`
    );
  },
};

let kept: string[] = [];
try {
  const [, body] = readFileSync(FIXTURE, 'utf8').match(
    /GRID_ROW_CONTEXTS_DOCUMENT = `<style>[^\n]*\n([^`]*)`/,
  )!;
  kept = body.split('\n').filter(Boolean);
} catch {
  // a first run, with no fixture yet
}
const cases = kept.slice();
for (const [name, make] of Object.entries(MAKERS)) {
  if (only ? name !== only : name === 'whole') continue;
  for (let i = 0; i < count; i += 1) cases.push(make(cases.length));
}

const page = join(tmpdir(), `grid-row-contexts-${process.pid}.html`);
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
          const reads = ['column-wrap:wrap', 'column-height:80px',
            'box-decoration-break:clone'].every((d) => CSS.supports(d));
          done(JSON.stringify({ out, reads }));
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
  const { out: rects, reads } = JSON.parse(result.value) as {
    out: Record<string, number[][]>;
    reads: boolean;
  };
  if (!reads) throw new Error('this Chromium lacks what the cases use');
  if (!Object.keys(rects).length) throw new Error('no rectangle was read');
  const { product } = (await chrome.send('Browser.getVersion')) as {
    product: string;
  };
  const version = product.match(/\/(\d+)/)![1];
  const entries = Object.entries(rects)
    .map(([id, list]) => `  ${id}: ${JSON.stringify(list)},`)
    .join('\n');
  const text = `// Where each piece of each grid item, and of each grid, is in columns that
// are not plain ones, as Chromium ${version} has it, from the top left of its
// multicol container: \`scripts/conformance/grid-row-contexts.ts\` writes this
// file, and nothing in it is written by hand.

export const GRID_ROW_CONTEXTS_DOCUMENT = \`${STYLE}${cases.join('\n')}
\`;

export const GRID_ROW_CONTEXTS_RECTS: Record<string, number[][]> = {
${entries}
};

/** The cases that differed from Chromium before a grid's row was broken an
 *  item at a time (\`KNOWN\` in the script). */
export const GRID_ROW_CONTEXTS_KNOWN: string[] = ${JSON.stringify(KNOWN)};
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
