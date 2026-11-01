// <Html> — what a box's min-content width comes to with no layout of it
// (`exactMinContent`), held to what a probe at no width lays out to find.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import {
  answerMinContentExactly,
  boxLayoutsMade,
  minContentsExact,
} from '../../src/html/layout/block.js';
import { RED_PNG, boxOf, render, renderWithBytes, view } from './harness.js';
import { MIN_CONTENT_DOCUMENT, MIN_CONTENT_WIDTHS } from './min-contents.js';

afterEach(cleanup);
afterEach(() => answerMinContentExactly(true));

const SEEDS = Number(process.env.MIN_CONTENT_SEEDS ?? 100);
const FROM = Number(process.env.MIN_CONTENT_FROM ?? 1);

function random(seed: number): () => number {
  let at = seed;
  return () => {
    at = (at * 1103515245 + 12345) % 2147483648;
    return at / 2147483648;
  };
}

/** A document of flex boxes and of all that can be in one, much of which
 *  `exactMinContent` turns down, in rooms narrow enough that what their
 *  items come to at their narrowest decides where everything goes. */
function documentFor(next: () => number): { source: string; ids: number } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const words = ['a', 'lorem', 'ipsum', 'consectetur', 'sit amet', 'dolor sit'];
  let ids = 0;
  const text = () =>
    Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(words)).join(
      ' ',
    );
  const edges = (): string[] => {
    const css: string[] = [];
    if (next() < 0.3) css.push(`padding:0 ${pick(['3px', '8px', '5%'])}`);
    if (next() < 0.3) {
      css.push(`margin:0 ${pick(['4px', '-2px', 'auto', '3%'])}`);
    }
    if (next() < 0.15) css.push('border:1px solid');
    if (next() < 0.2) css.push('box-sizing:border-box');
    return css;
  };
  const sizes = (): string[] => {
    const css: string[] = [];
    if (next() < 0.3) {
      const width = pick([
        '30px',
        '60px',
        '100%',
        '50%',
        'calc(100% - 7px)',
        'calc(50% + 4px)',
        'min-content',
        'max-content',
      ]);
      css.push(`width:${width}`);
    }
    if (next() < 0.25) {
      css.push(`min-width:${pick(['0', '20px', '70px', '40%'])}`);
    }
    if (next() < 0.25) {
      css.push(`max-width:${pick(['25px', '50px', '80%'])}`);
    }
    return css;
  };
  const item = (): string[] =>
    next() < 0.5
      ? []
      : [
          `flex:${pick(['none', '1', 'auto', '0 0 auto', '1 1 0', '0 1 40px'])}`,
        ];
  const wraps = (): string[] => {
    const css: string[] = [];
    const nowrap = next() < 0.35;
    if (nowrap) css.push('white-space:nowrap');
    if (next() < 0.25) css.push('overflow:hidden');
    if (nowrap && next() < 0.5) css.push('text-overflow:ellipsis');
    return css;
  };
  const leaf = (css: string[]): string => {
    const id = `e${ids++}`;
    const kind = next();
    if (kind < 0.12) {
      return `<img id="${id}" src="red.png" style="${[...css, pick(['', 'width:12px', 'height:9px', 'max-width:100%'])].join(';')}">`;
    }
    if (kind < 0.2) {
      return `<div id="${id}" style="${css.join(';')}">${text()} <b style="display:inline-block;width:14px">x</b> ${text()}</div>`;
    }
    if (kind < 0.3) {
      return `<div id="${id}" style="${css.join(';')}">${text()} <em>${text()}</em></div>`;
    }
    return `<div id="${id}" style="${css.join(';')}">${text()}</div>`;
  };
  const box = (depth: number): string => {
    const css = [...edges(), ...sizes(), ...item(), ...wraps()];
    if (depth >= 3 || next() < 0.35) return leaf(css);
    const id = `e${ids++}`;
    const display = next();
    if (display < 0.08) {
      css.push('display:grid;grid-template-columns:auto 1fr');
    } else if (display < 0.8) {
      css.push('display:flex');
      const shape = next();
      if (shape < 0.3) css.push('flex-direction:column');
      else if (shape < 0.42) css.push('flex-wrap:wrap');
      else if (shape < 0.5) css.push('flex-direction:row-reverse');
      if (next() < 0.4) css.push(`gap:${pick(['4px', '10px', '5%'])}`);
      if (next() < 0.2) css.push('align-items:flex-start');
    }
    const kids = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
      box(depth + 1),
    ).join('');
    return `<div id="${id}" style="${css.join(';')}">${kids}</div>`;
  };
  const items = Array.from({ length: 2 + Math.floor(next() * 2) }, () =>
    box(0),
  ).join('');
  const room = pick([40, 90, 160, 260]);
  const wrapper = pick([
    `display:flex;width:${room}px`,
    `display:flex;flex-direction:column;width:${room}px;align-items:flex-start`,
    'width:min-content',
    `display:grid;grid-template-columns:auto auto;width:${room}px`,
  ]);
  return {
    source: `<style>body{margin:0;font:14px sans-serif}</style><div style="${wrapper}">${items}</div>`,
    ids,
  };
}

const places = (el: ReturnType<typeof view>, ids: number): number[][] =>
  Array.from({ length: ids }, (_, i) => {
    const b = boxOf(el, `e${i}`);
    return b ? [i, b.x, b.y, b.width, b.height] : [i];
  });

test('what is left to a probe is left to it, over generated documents', async () => {
  // what the arithmetic answers is held to Chromium below, and where a
  // probe differs it is the probe that is out. This is what it must turn
  // down: a percentage of a room, a grid, a wrapped row, a flex basis
  for (let seed = FROM; seed < FROM + SEEDS; seed += 1) {
    const { source, ids } = documentFor(random(seed * 7919));
    answerMinContentExactly(true);
    const exact = await renderWithBytes(source, { 'red.png': RED_PNG }, 400);
    const answered = places(exact.el, ids);
    await cleanup();
    answerMinContentExactly(false);
    const probed = await renderWithBytes(source, { 'red.png': RED_PNG }, 400);
    const laid = places(probed.el, ids);
    await cleanup();
    const at = answered.findIndex(
      (box, i) =>
        box.length !== laid[i].length ||
        box.some((v, j) => Math.abs(v - laid[i][j]) > 0.02),
    );
    assert.ok(
      at < 0,
      `seed ${seed}: e${at} exact ${JSON.stringify(answered[at])} probed ${JSON.stringify(laid[at])}\n${source}`,
    );
  }
});

test('a flex box at its narrowest comes to what Chromium has it come to, with no layout of it', async () => {
  // boxes of known widths nested as a page nests them: gaps, margins and
  // `auto` ones, least and greatest widths, percentages of no room, lines
  // that do not wrap
  const answers = minContentsExact();
  const { node } = await render(MIN_CONTENT_DOCUMENT, 400);
  const el = view(node);
  MIN_CONTENT_WIDTHS.forEach((width, i) => {
    assert.ok(
      Math.abs(boxOf(el, `c${i}`).width - width) < 0.05,
      `c${i}: ${boxOf(el, `c${i}`).width}, where Chromium has ${width}`,
    );
  });
  assert.ok(
    minContentsExact() - answers >= MIN_CONTENT_WIDTHS.length,
    `${minContentsExact() - answers} answered`,
  );
});

test('a row that wraps and an item with a flex basis are no sum of their items at their narrowest', async () => {
  // each its widest item, and a basis over its content: Chromium's
  const sized = (width: number) =>
    `<i style="display:block;width:${width}px;height:4px"></i>`;
  const item = async (held: string): Promise<number> => {
    const { node } = await render(
      '<style>body{margin:0}</style><div style="display:flex;width:10px">' +
        `<div id="item" style="display:flex">${held}</div></div>`,
      400,
    );
    const width = boxOf(view(node), 'item').width;
    await cleanup();
    return width;
  };
  assert.strictEqual(
    await item(
      `<div style="display:flex;flex-wrap:wrap;gap:6px">${sized(30)}${sized(20)}${sized(25)}</div>`,
    ),
    30,
  );
  assert.strictEqual(
    await item(
      `<div style="display:flex"><div style="flex:0 0 40px">${sized(10)}</div><div>${sized(15)}</div></div>`,
    ),
    55,
  );
});

test('a line cut short by text-overflow gives its box what its text comes to', async () => {
  // ink alone (CSS Overflow 3, 5.1): an item given less than its text is
  // laid out with the line cut, which no longer says how wide the text is,
  // and it is no narrower for that
  const doc = (cut: string) =>
    '<style>body{margin:0;font:14px sans-serif}</style>' +
    '<div style="display:flex;width:60px">' +
    '<div id="item">' +
    `<div id="line" style="white-space:nowrap;${cut}">` +
    'a line of text a good deal wider than the room</div></div>' +
    '<div style="flex:none;width:40px"></div></div>';
  const held = async (cut: string): Promise<number> => {
    const { node } = await render(doc(cut), 400);
    const width = boxOf(view(node), 'item').width;
    await cleanup();
    return width;
  };
  const whole = await held('');
  assert.ok(whole > 100, `${whole}`);
  assert.strictEqual(
    await held('overflow:hidden;text-overflow:ellipsis'),
    whole,
  );
});

test('a row of many items comes to its narrowest with none of them laid out at it', async () => {
  // a webmail page's strip of 2,499 senders was laid out at no width in
  // every probe of the page, each item in it twice
  const items = Array.from(
    { length: 200 },
    (_, i) =>
      `<div style="flex:none;display:flex"><button style="display:flex"><span>name ${i}</span></button></div>`,
  ).join('');
  const source =
    '<style>body{margin:0}</style>' +
    '<div style="display:flex;width:300px"><div id="pane" style="display:flex;flex-direction:column;width:calc(100% - 20px)">' +
    `<div id="strip" style="display:flex;overflow:hidden;width:100%">${items}</div></div>` +
    '<div style="flex:none;width:60px">x</div></div>';
  answerMinContentExactly(false);
  const before = boxLayoutsMade();
  const probed = await render(source, 400);
  const byProbe = boxLayoutsMade() - before;
  const width = boxOf(view(probed.node), 'pane').width;
  await cleanup();
  answerMinContentExactly(true);
  const at = boxLayoutsMade();
  const exact = await render(source, 400);
  const answered = boxLayoutsMade() - at;
  assert.strictEqual(boxOf(view(exact.node), 'pane').width, width);
  assert.ok(
    answered < byProbe * 0.7,
    `${answered} boxes laid out, where a probe laid out ${byProbe}`,
  );
});
