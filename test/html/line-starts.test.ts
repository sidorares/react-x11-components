// <Html> — a paragraph that may read right to left, made a line at a time:
// each line is laid out from a start of the rest of the paragraph (`startOf`)
// and not from all of it, and is the line all of it makes.
import { afterEach } from 'node:test';
import assert from 'node:assert';
import { act, cleanup } from 'react-x11/test';
import { bidiJs } from '../../src/html/direction.js';
import { layoutDocument } from '../../src/html/layout/block.js';
import type { Box, BoxTree } from '../../src/html/layout/boxes.js';
import type { FontsLike } from '../../src/html/layout/inline.js';
import { mulberry32 } from '../mulberry32.js';
import { metric, render, view } from './harness.js';

afterEach(cleanup);

const SEEDS = Number(process.env.LINE_START_SEEDS ?? 12);
const FROM = Number(process.env.LINE_START_FROM ?? 0);

const HEBREW =
  'ספרו של המחבר יצא לאור בשנה שעברה וזכה לשבחים רבים מצד המבקרים'.split(' ');
const ARABIC =
  'كان الكتاب الجديد من أهم الكتب التي صدرت في العام الماضي وقد نال'.split(' ');
const LATIN = 'The quick brown fox jumps over the lazy dog AV To office'.split(
  ' ',
);

/** A paragraph's tree, laid out at 400px, and the engine it was laid out by. */
async function laid(
  source: string,
): Promise<{ tree: BoxTree; fonts: FontsLike }> {
  const { result, node } = await render(source);
  await act();
  const tree = (view(node) as unknown as { _tree: BoxTree })._tree;
  return { tree, fonts: (result.app as unknown as { fonts: FontsLike }).fonts };
}

/** Text of words with a larger one among them, so that its lines' baselines
 *  move by different amounts and it is made a line at a time. */
function words(from: readonly string[], count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const word = from[i % from.length];
    out += i % 60 === 30 ? `<big>${word}</big> ` : `${word} `;
  }
  return out;
}

/** The work a layout asks for: the letters the engine is handed and the ones
 *  bidi-js is, and how many layouts are asked for each number of lines. */
function workOf(tree: BoxTree, fonts: FontsLike) {
  const work = { handed: 0, resolved: 0, asked: new Map<number, number>() };
  const js = bidiJs();
  const inner = js.getEmbeddingLevels;
  js.getEmbeddingLevels = (text, base) => {
    work.resolved += text.length;
    return inner(text, base);
  };
  try {
    layoutDocument(
      tree,
      {
        layout: (runs, style, options) => {
          for (const run of runs) work.handed += run.text.length;
          const lines = options.maxLines ?? Infinity;
          work.asked.set(lines, (work.asked.get(lines) ?? 0) + 1);
          return fonts.layout(runs, style, options);
        },
        match: (...args) => fonts.match(...args),
      },
      400,
      600,
    );
  } finally {
    js.getEmbeddingLevels = inner;
  }
  return work;
}

for (const [what, source] of [
  [
    'a right-to-left paragraph',
    (n: number) => `<p dir="rtl">${words(HEBREW, n)}</p>`,
  ],
  [
    'Arabic in a left-to-right one',
    (n: number) => `<p>${words(ARABIC, n)}</p>`,
  ],
  [
    'left-to-right text with words of it',
    (n: number) =>
      `<p>${words([...LATIN, ...LATIN, ...LATIN, HEBREW[0]], n)}</p>`,
  ],
  [
    'an isolate all of it is in',
    (n: number) =>
      `<p>x <span dir="rtl">${words([...LATIN, ...HEBREW], n)}</span></p>`,
  ],
  [
    'brackets and what is in them',
    (n: number) =>
      `<p dir="rtl">${words([...HEBREW, ':(', '(a', '1)', '[b]'], n)}</p>`,
  ],
  [
    'text past a float, ordered otherwise than alone',
    (n: number) =>
      '<div style="float:left;width:40px;height:40px"></div>' +
      `<p>x <bdo dir="rtl">${words(LATIN, n).replace(/<.?big>/g, '')}</bdo></p>`,
  ],
] as const) {
  metric(`a line costs no more for what follows it: ${what}`, async () => {
    const short = await laid(source(500));
    const a = workOf(short.tree, short.fonts);
    cleanup();
    const long = await laid(source(4000));
    const b = workOf(long.tree, long.fonts);
    // eight times the text is eight times the work, or a little more, where
    // it was nearer sixty-four
    assert.ok(b.handed < a.handed * 14, `the engine: ${a.handed}, ${b.handed}`);
    assert.ok(
      b.resolved <= a.resolved * 14,
      `bidi-js: ${a.resolved}, ${b.resolved}`,
    );
  });
}

metric('a paragraph of some lines is asked for its lines alone', async () => {
  for (const n of [10, 25, 80]) {
    const { tree, fonts } = await laid(`<p dir="rtl">${words(HEBREW, n)}</p>`);
    const { asked } = workOf(tree, fonts);
    assert.strictEqual(asked.get(4), undefined, `${n} words`);
    cleanup();
  }
});

metric('and text nothing can reverse is, however long', async () => {
  const { tree, fonts } = await laid(`<p>${words(LATIN, 2000)}</p>`);
  const { asked } = workOf(tree, fonts);
  assert.ok((asked.get(1) ?? 0) > 100, 'it is made a line at a time');
  assert.strictEqual(asked.get(4), undefined);
});

/** Everything of a tree's lines: where each is, and each run on it. */
function linesIn(tree: BoxTree): string[] {
  const out: string[] = [];
  const walk = (box: Box): void => {
    for (const line of box.lines ?? []) {
      const texts = line.texts.map((t) => {
        const natural = t.layout.lines[t.layoutLine];
        return [
          t.drawX,
          t.drawY,
          t.textStart,
          t.textEnd,
          natural.x,
          natural.width,
          natural.start,
          natural.end,
          natural.runs.map((r) => [
            r.x,
            r.width,
            r.start,
            r.end,
            (r.run as { level?: number } | undefined)?.level,
          ]),
        ];
      });
      out.push(
        JSON.stringify([line.x, line.y, line.width, line.height, texts]),
      );
    }
    box.children.forEach(walk);
  };
  walk(tree.root);
  return out;
}

const SETTINGS = [
  '',
  '',
  'text-align:justify',
  'white-space:pre-wrap',
  'white-space:pre-line',
  'white-space:break-spaces',
  'text-wrap:pretty',
  'overflow-wrap:anywhere',
  'word-break:break-all',
  'unicode-bidi:bidi-override',
  'unicode-bidi:plaintext',
  'letter-spacing:1px',
  'text-indent:2em hanging',
];

/** A paragraph of some thousand letters, of the kinds a cut may be told
 *  from the whole by. */
function generated(seed: number): string {
  const random = mulberry32(seed);
  const pick = <T>(from: readonly T[]): T =>
    from[Math.floor(random() * from.length)];
  const some = (letters: string, least: number, most: number): string => {
    const count = least + Math.floor(random() * (most - least));
    let out = '';
    for (let i = 0; i < count; i += 1) out += pick([...letters]);
    return out;
  };
  const kinds: (() => string)[] = [
    () => pick(HEBREW),
    () => pick(ARABIC),
    () => pick(LATIN),
    // a word whose letters join across a cut
    () => some('بتثجحخسشصضطظعغفقكلمنهيـ', 8, random() < 0.1 ? 90 : 24),
    // one a soft hyphen may break, and one nothing may
    () => [pick(ARABIC), pick(HEBREW), pick(LATIN)].join('&shy;'),
    () => some(pick(['abcdefgh', 'אבגדהוזח', 'ab1-/אב']), 30, 150),
    () => some('ilו׳.\u05b0\u0301\u064e\u200b', 10, 60),
    // a break between any two letters, and punctuation that takes none
    () => some('日本語中文字。、「」', 4, 24),
    // and an emoji of several joined
    () => pick(['👨‍👩‍👧‍👦', '🏳️‍🌈', '👋🏽', '🇮🇱']),
    () =>
      pick(['24', '3.5', '1,000', '٣٤', '(', ')', '(a)', '[', ':(', '%', '—']),
    () =>
      pick([
        '<bdi>א b</bdi>',
        '<span dir="rtl">ab (גד 5)</span>',
        '<span dir="ltr">אב x (</span>',
        '<bdo dir="rtl">abc 1</bdo>',
      ]),
  ];
  // a few of the kinds, more of some than of others
  const of = Array.from({ length: 3 + Math.floor(random() * 4) }, () =>
    pick(kinds),
  );
  of.push(kinds[Math.floor(random() * 2)]);
  let body = '';
  for (let i = 0; i < 260; i += 1) {
    const word = pick(of)();
    const larger = random() < 0.03 && !word.includes('<');
    body += larger ? `<big>${word}</big>` : word;
    body += random() < 0.01 ? '\n' : ' ';
  }
  // text smaller than its block's, or of letters of no width: more of it on a
  // line than a start is guessed to need, so that the cut is near the line
  const size = pick([0, 0, 5, 7, 9]);
  if (size) body = `<span style="font-size:${size}px">${body}</span>`;
  const float =
    random() < 0.3
      ? '<div style="float:left;width:60px;height:300px"></div>'
      : '';
  const style =
    `direction:${pick(['rtl', 'ltr'])};width:${pick([90, 180, 380])}px;` +
    pick(SETTINGS);
  return `${float}<p style="margin:0;${style}">${body}</p>`;
}

metric('a line made from a start is the line the whole makes', async () => {
  let starts = 0;
  for (let seed = FROM; seed < FROM + SEEDS; seed += 1) {
    const { tree, fonts } = await laid(generated(seed));
    const layout = (whole: boolean): string[] => {
      layoutDocument(
        tree,
        {
          layout: (runs, style, options) => {
            const made = fonts.layout(runs, style, options);
            // a start of too few lines is not taken
            if (options.maxLines !== 4) return made;
            if (!whole) starts += 1;
            return whole ? { ...made, lines: [] } : made;
          },
          match: (...args) => fonts.match(...args),
        },
        400,
        600,
      );
      return linesIn(tree);
    };
    const whole = layout(true);
    const cut = layout(false);
    assert.strictEqual(cut.length, whole.length, `seed ${seed}: lines`);
    for (let i = 0; i < whole.length; i += 1) {
      assert.strictEqual(cut[i], whole[i], `seed ${seed}: line ${i}`);
    }
    cleanup();
  }
  assert.ok(starts > SEEDS * 5, `${starts} starts were tried`);
});
