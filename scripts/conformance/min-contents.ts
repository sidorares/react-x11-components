// Writes `test/html/min-contents.ts`: boxes of known widths nested as a page
// nests them, and what Chromium has each come to at its narrowest. Its cases
// are kept and asked about again, and any added here go after them:
//
//   CHROME=<chromium> node --import tsx scripts/conformance/min-contents.ts \
//     [--add <count>] [--seed <seed>]
//
// Nothing in a case is text, which a platform's fonts would have another
// width for, and a case is a line of the document, so a diff of the fixture
// is a diff of its cases. A new case that comes to no more than its room
// says nothing of how narrow it can be, and is left out: it was its widest.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from '../zengarden/chrome.js';

const FIXTURE = new URL('../../test/html/min-contents.ts', import.meta.url);
/** How wide `.room` is in the document. */
const ROOM = 10;

const args = process.argv.slice(2);
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

const WIDTHS = ['100%', '50%', 'calc(100% - 7px)', 'calc(50% + 4px)'];
const FLEX = [
  'none',
  '1',
  'auto',
  '0 0 auto',
  '1 1 0',
  // a basis of a length, and whether the item may grow or shrink from it
  '0 0 40px',
  '0 1 30px',
  '1 0 25px',
  '1 1 35px',
  '0 0 15px',
  '0 1 12px',
  '0 0 0',
  '0 1 0',
  // and a percentage of a room that is not known
  '0 0 50%',
  '0 1 25%',
];

function edges(): string[] {
  const css: string[] = [];
  if (next() < 0.3) css.push(`padding:0 ${pick(['5%', `${int(1, 8)}px`])}`);
  if (next() < 0.3) {
    css.push(`margin:0 ${pick(['-2px', 'auto', '3%', `${int(1, 6)}px`])}`);
  }
  if (next() < 0.2) css.push('border:1px solid');
  if (next() < 0.25) css.push('box-sizing:border-box');
  return css;
}

function sizes(): string[] {
  const css: string[] = [];
  if (next() < 0.25) css.push(`width:${pick([...WIDTHS, `${int(12, 56)}px`])}`);
  if (next() < 0.2) css.push(`min-width:${pick(['0', `${int(20, 89)}px`])}`);
  if (next() < 0.2) css.push(`max-width:${int(20, 68)}px`);
  return css;
}

const inlineBlocks = (): string =>
  Array.from(
    { length: int(1, 3) },
    () =>
      `<b style="display:inline-block;width:${int(5, 29)}px;height:4px"></b>`,
  ).join('');

function leaf(css: string[]): string {
  const kind = next();
  const style = css.join(';');
  // what is replaced, and what has columns, which no line says
  if (kind < 0.06) {
    return `<canvas width="${int(5, 60)}" height="4" style="display:block;${style}"></canvas>`;
  }
  if (kind < 0.12) {
    const cell = (): string =>
      `<td style="padding:0"><i style="display:block;width:${int(5, 40)}px;height:4px"></i></td>`;
    return `<table style="border-spacing:0;${style}"><tr>${cell()}${cell()}</tr></table>`;
  }
  // a line that does not wrap is one width; one that does has two, its
  // widest box and all of them, with no text to give it them
  if (kind < 0.35) {
    return `<div style="${[...css, 'white-space:nowrap'].join(';')}">${inlineBlocks()}</div>`;
  }
  if (kind < 0.55) {
    return `<div${style ? ` style="${style}"` : ''}>${inlineBlocks()}${inlineBlocks()}</div>`;
  }
  return `<div style="${[...css, 'height:4px'].join(';')}"><i style="display:block;width:${int(5, 69)}px;height:4px"></i></div>`;
}

function box(depth: number): string {
  const css = [...edges(), ...sizes()];
  if (next() < 0.5) css.push(`flex:${pick(FLEX)}`);
  if (next() < 0.2) css.push('overflow:hidden');
  if (depth >= 3 || next() < 0.45) return leaf(css);
  const held = (): string =>
    Array.from({ length: int(1, 3) }, () => box(depth + 1)).join('');
  // a block around them, whose content its items' narrowest reach through
  if (next() < 0.2) {
    const style = css.length ? ` style="${css.join(';')}"` : '';
    return `<div${style}>${held()}</div>`;
  }
  css.push('display:flex');
  const shape = next();
  if (shape < 0.28) css.push('flex-direction:column');
  else if (shape < 0.45) css.push('flex-wrap:wrap');
  else if (shape < 0.5) css.push('flex-wrap:wrap-reverse');
  else if (shape < 0.58) css.push('flex-direction:row-reverse');
  if (next() < 0.4) css.push(`gap:${int(1, 11)}px`);
  if (next() < 0.25) css.push('align-items:flex-start');
  return `<div style="${css.join(';')}">${held()}</div>`;
}

const [, style, kept] = readFileSync(FIXTURE, 'utf8').match(
  /MIN_CONTENT_DOCUMENT = `(<style>[^\n]*\n)([^`]*)`/,
)!;
const cases = kept.split('\n').filter(Boolean);
const before = cases.length;
for (let i = 0; i < count; i += 1) {
  const items = Array.from({ length: int(1, 3) }, () => box(0)).join('');
  cases.push(
    `<div class="room"><div id="c${cases.length}" class="item">${items}</div></div>`,
  );
}

const page = join(tmpdir(), `min-contents-${process.pid}.html`);
writeFileSync(page, `<!doctype html>${style}${cases.join('\n')}\n`);
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
        const read = () => done(JSON.stringify(
          [...document.querySelectorAll('.item')].map(
            (item) => item.getBoundingClientRect().width,
          ),
        ));
        document.readyState === 'complete'
          ? read()
          : addEventListener('load', read);
      })`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  )) as { result: { value: string } };
  const measured = JSON.parse(result.value) as number[];
  if (measured.length !== cases.length) throw new Error('a case has no box');
  const held = cases.flatMap((line, i) =>
    i < before || measured[i] > ROOM ? [{ line, width: measured[i] }] : [],
  );
  const document =
    style +
    held
      .map(({ line }, i) => line.replace(/id="c\d+"/, `id="c${i}"`))
      .join('\n') +
    '\n';
  const { product } = (await chrome.send('Browser.getVersion')) as {
    product: string;
  };
  const version = product.match(/\/(\d+)/)![1];
  const lines = ['  '];
  for (const { width } of held) {
    const entry = `${width}, `;
    if (lines[lines.length - 1].length + entry.length > 81) lines.push('  ');
    lines[lines.length - 1] += entry;
  }
  writeFileSync(
    FIXTURE,
    `// What a flex box comes to at its narrowest, as Chromium ${version} has it: each
// \`.item\` below is an item of a row with no room for it, held to its
// automatic minimum, and every width is that item's in Chromium over this
// document, none of them written by hand: \`scripts/conformance/min-contents.ts\`
// writes this file. Nothing in it is text, which a platform's fonts would
// have another width for.

export const MIN_CONTENT_DOCUMENT = \`${document}\`;

export const MIN_CONTENT_WIDTHS: readonly number[] = [
${lines.map((line) => line.trimEnd()).join('\n')}
];
`,
  );
} finally {
  await chrome.close();
}
