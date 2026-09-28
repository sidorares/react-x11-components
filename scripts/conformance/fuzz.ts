// Pages for `run.ts` to crash on: WPT's tests, cut up.
//
//   npx tsx scripts/conformance/fuzz.ts <wpt root> <out dir> [count] [seed]
//     [--from css/CSS2,css/css-grid,…]
//   npx tsx scripts/conformance/run.ts <wpt root> <out dir> --chunk 50 --timeout 60000
//
// The pages are CSS 2.1's by default; `--from` names other directories of
// the checkout, which is how the grid, flex, colour and custom-property code
// is reached with the syntax it reads.
//
// Each page is a test of the suite with a few things done to it — a span cut
// out or repeated, a token put in (a brace, an unclosed `calc(`, a length of
// 1e308, `<td colspan=1000000>`), a run of a few hundred or thousand nested
// elements — and is its own reference, so the runner renders it twice and
// compares nothing that matters. What matters is the outcome: a page the
// runner records as `crash` threw out of the renderer or never finished,
// which in an application is its end or its freeze, for a document it did
// not write. `<out dir>` is under the WPT root, where the runner looks.
//
// The seed makes a run repeatable: the same seed and count write the same
// pages, so a crash found once can be found again after a fix.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const fromAt = args.indexOf('--from');
const from = fromAt < 0 ? ['css/CSS2'] : args.splice(fromAt, 2)[1].split(',');
const [root, out, countArg = '3000', seedArg = '1'] = args;
if (!root || !out) {
  console.error(
    'usage: fuzz.ts <wpt root> <out dir> [count] [seed] [--from dir,…]',
  );
  process.exit(2);
}

// mulberry32: small, seeded, and the same on every machine
let state = Number(seedArg) >>> 0;
const random = (): number => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const below = (n: number): number => Math.floor(random() * n);
const pick = <T>(list: readonly T[]): T => list[below(list.length)];

const TOKENS = [
  '{',
  '}',
  ';',
  ':',
  '(',
  ')',
  '"',
  "'",
  '/*',
  '*/',
  '<',
  '>',
  '\\',
  '&',
  'calc(',
  'calc(Infinity * 1px)',
  'calc(-Infinity * 1em)',
  'calc(NaN * 1px)',
  'min(',
  'max(1px,',
  'var(--x)',
  'var(--x, ',
  '--x: var(--x);',
  '@media (',
  '@media (min-width: 1e308px) {',
  '@import url(',
  '@supports (',
  '@layer a {',
  'url(',
  '!important',
  '::before{content:"',
  '::after{content:counter(',
  'attr(',
  '1e308px',
  '-1e308px',
  '99999999em',
  '0.0000001px',
  'NaN',
  'Infinity',
  'width: 1e308px;',
  'height: -1e308px;',
  'margin: -99999999px;',
  'padding: 1e30px;',
  'font-size: 1e308px;',
  'line-height: 1e308;',
  'letter-spacing: -1e9px;',
  'text-indent: -1e308px;',
  'border: 1e9px solid red;',
  'border-radius: 1e308px;',
  'box-shadow: 0 0 1e9px red;',
  'text-shadow: 1e9px 1e9px 1e9px red;',
  'outline: 1e9px solid;',
  'z-index: 99999999999;',
  'counter-increment: c 2147483647;',
  'transform: translate(1e308px);',
  'background: linear-gradient(red 1e308px, blue -1e308px);',
  'display: table-cell;',
  'display: contents;',
  'display: inline-block;',
  'display: flex;',
  'display: grid;',
  'float: left;',
  'position: absolute;',
  'white-space: pre;',
  'direction: rtl; unicode-bidi: bidi-override;',
  'grid-template-columns: repeat(1000000, 1px);',
  'flex: 1e308 1e308 0;',
  '-webkit-line-clamp: 99999999;',
  '<div>',
  '</div>',
  '<table>',
  '<td colspan=1000000 rowspan=65535>',
  '<col span=1000000>',
  '<ol start=-2147483648>',
  '<li value=99999999999>',
  '<br>',
  '<img src=x width=1e9 height=1e9>',
  '<pre>\t\t\t',
  '<details open><summary>',
  '<select>',
  '<textarea>',
  '<!--',
  '-->',
  '‮',
  '⁦',
  '́́',
  '­',
  '​',
  '&#0;',
  '&#x110000;',
  // what documents written for today's browsers are made of
  'grid-template-columns: repeat(auto-fit, minmax(0, 1fr));',
  'grid-template-areas: "a a" "b";',
  'grid-area: 1 / 1 / -1 / -1;',
  'grid-column: span 1000000;',
  'grid-row: -2147483648;',
  'aspect-ratio: 0 / 0;',
  'aspect-ratio: 1e308;',
  'color: oklch(1e308 1e308 1e308);',
  'background: color-mix(in oklab, red 1e308%, blue);',
  'width: fit-content(1e308px);',
  'width: min-content;',
  'height: max-content;',
  'min-width: max-content;',
  'inset: 1e308px;',
  'translate: 1e308px 1e308px;',
  'outline-offset: -1e308px;',
  'background-size: 1e308px 0;',
  'text-wrap: balance;',
  'order: -2147483648;',
  'flex-basis: 1e308%;',
  'gap: 1e308px;',
  'line-clamp: 1;',
  '& .x {',
  ':has(',
  ':is(',
  ':where(',
  '@container (',
  'clamp(',
  '--a: var(--b); --b: var(--a);',
  'color: var(--a, var(--b, var(--c)));',
];
const NESTING = ['div', 'span', 'b', 'table', 'ul', 'li', 'blockquote'];

function mutate(text: string): string {
  const times = 1 + below(6);
  for (let i = 0; i < times && text.length; i++) {
    const at = below(text.length);
    const roll = random();
    if (roll < 0.2) {
      text = text.slice(0, at) + text.slice(at + 1 + below(60));
    } else if (roll < 0.35) {
      const span = text.slice(at, at + 1 + below(200));
      text = text.slice(0, at) + span.repeat(2 + below(29)) + text.slice(at);
    } else if (roll < 0.9) {
      text = text.slice(0, at) + pick(TOKENS) + text.slice(at);
    } else {
      const depth = pick([100, 1000, 3000]);
      const tag = pick(NESTING);
      text =
        text.slice(0, at) +
        `<${tag}>`.repeat(depth) +
        'x' +
        `</${tag}>`.repeat(depth) +
        text.slice(at);
    }
  }
  return text;
}

const tests: string[] = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'support' && entry.name !== 'reference') walk(path);
    } else if (
      /\.(xht|html?)$/.test(entry.name) &&
      !/-ref\./.test(entry.name)
    ) {
      tests.push(path);
    }
  }
};
for (const dir of from) walk(join(root, dir));
tests.sort();

const dir = join(root, out);
mkdirSync(dir, { recursive: true });
const count = Number(countArg);
for (let i = 0; i < count; i++) {
  const from = pick(tests);
  let text = readFileSync(from, 'utf8').replace(
    /<link[^>]*rel="(?:mis)?match"[^>]*>/g,
    '',
  );
  text = mutate(text);
  const name = `f${String(i).padStart(5, '0')}.html`;
  const link = `<link rel="match" href="${name}">`;
  text = text.includes('<head>')
    ? text.replace('<head>', `<head>${link}`)
    : link + text;
  writeFileSync(
    join(dir, name),
    `<!-- from ${relative(root, from)} -->\n${text}`,
  );
}
console.log(`wrote ${count} pages to ${dir}`);
