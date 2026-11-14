// <Html> — `text-decoration-inset` (CSS Text Decoration 4, 2.6): how far in
// from its decorating box's start and end an underline or a line through
// begins and ends. WPT's `css/css-text-decor/text-decoration-inset-*` hold
// the rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup } from 'react-x11/test';

import { parseColor } from '../../src/html/css/values.js';
import { findById, fillsOf, metric, render, view } from './harness.js';

afterEach(cleanup);

test('text-decoration-inset reads back as it computes, and is no inherited property', async () => {
  const { node } = await render(
    '<style>body{font-size:20px}</style>' +
      '<u id="a" style="text-decoration-inset:10px -10px">a</u>' +
      '<u id="b" style="text-decoration-inset:0.5em">b</u>' +
      '<u id="c" style="text-decoration-inset:0 20%">c</u>' +
      '<u id="d" style="text-decoration-inset:auto"><span id="e">e</span></u>' +
      '<u id="f" style="text-decoration-inset:1px 1px">f</u>' +
      '<u id="g">g</u>' +
      '<u id="h" style="text-decoration-inset:circle(1px)">h</u>',
  );
  const el = view(node);
  const read = (id: string) =>
    el.computedStyle(findById(el.document, id)!)!['text-decoration-inset'];
  assert.equal(read('a'), '10px -10px');
  assert.equal(read('b'), '10px', 'an em of its own font');
  assert.equal(read('c'), '0px 20%');
  assert.equal(read('d'), 'auto');
  assert.equal(read('e'), '0px', 'not inherited');
  assert.equal(read('f'), '1px', 'one where both are one');
  assert.equal(read('g'), '0px');
  assert.equal(read('h'), '0px', 'no value of it');
});

/** The underlines drawn in a colour, as [left, right] each. */
async function rulesIn(
  el: ReturnType<typeof view>,
  color: string,
): Promise<[number, number][]> {
  const ink = parseColor(color);
  const fills = await fillsOf(el);
  return fills
    .filter((f) => f.style === ink && f.h <= 4)
    .map((f) => [f.x, f.x + f.w] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

metric(
  'an underline is drawn in from its element’s start and end, out where the inset is negative',
  async () => {
    const { node } = await render(
      '<style>body{margin:0;font:20px monospace} u{text-decoration-color:#ff0000;' +
        'text-decoration-thickness:2px}</style>' +
        '<p>the quick <u id="a" style="text-decoration-inset:10px -10px">brown</u> fox</p>',
    );
    const el = view(node);
    await act();
    const box = el.elementRect(findById(el.document, 'a')!)!;
    const rules = await rulesIn(el, '#ff0000');
    assert.equal(rules.length, 1);
    const [[left, right]] = rules;
    assert.ok(Math.abs(left - (box.x + 10)) <= 1, `${left} for ${box.x + 10}`);
    assert.ok(
      Math.abs(right - (box.x + box.width + 10)) <= 1,
      `${right} for ${box.x + box.width + 10}`,
    );
  },
);

metric(
  'two elements side by side are two rules, each in from its own ends',
  async () => {
    const { node } = await render(
      '<style>body{margin:0;font:20px monospace} u{text-decoration-color:#ff0000;' +
        'text-decoration-thickness:2px;text-decoration-inset:5px}</style>' +
        '<p><u id="a">ab</u><u id="b">cd</u></p>',
    );
    const el = view(node);
    await act();
    const a = el.elementRect(findById(el.document, 'a')!)!;
    const b = el.elementRect(findById(el.document, 'b')!)!;
    const rules = await rulesIn(el, '#ff0000');
    assert.equal(rules.length, 2, JSON.stringify(rules));
    const near = (x: number, y: number) => Math.abs(x - y) <= 1;
    assert.ok(
      near(rules[0][0], a.x + 5) && near(rules[0][1], a.x + a.width - 5),
    );
    assert.ok(
      near(rules[1][0], b.x + 5) && near(rules[1][1], b.x + b.width - 5),
    );
  },
);

metric(
  'auto is half the rule’s thickness, between one pixel and two',
  async () => {
    const { node } = await render(
      '<style>body{margin:0;font:20px monospace} u{text-decoration-inset:auto}</style>' +
        '<p><u id="a" style="text-decoration-color:#ff0000;text-decoration-thickness:2px">abc</u></p>' +
        '<p><u id="b" style="text-decoration-color:#0000ff;text-decoration-thickness:8px">abc</u></p>',
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const [[a0, a1]] = await rulesIn(el, '#ff0000');
    const thick = (await fillsOf(el)).filter(
      (f) => f.style === parseColor('#0000ff') && f.h > 4,
    );
    assert.ok(thick.length > 0, 'the thick rule');
    const near = (x: number, y: number) => Math.abs(x - y) <= 1;
    const a = rect('a');
    assert.ok(
      near(a0, a.x + 1) && near(a1, a.x + a.width - 1),
      `2px thick, in 1px: ${a0}, ${a1} for ${a.x}, ${a.x + a.width}`,
    );
    const b = rect('b');
    const b0 = Math.min(...thick.map((f) => f.x));
    const b1 = Math.max(...thick.map((f) => f.x + f.w));
    assert.ok(
      near(b0, b.x + 2) && near(b1, b.x + b.width - 2),
      `8px thick, in 2px: ${b0}, ${b1} for ${b.x}, ${b.x + b.width}`,
    );
  },
);

metric(
  'a percentage is of the element’s inline size, its padding with its text',
  async () => {
    // WPT's text-decoration-inset-percentage-padding: two texts and 20px of
    // padding at each side, a quarter of which is in at each end
    const { node } = await render(
      '<style>body{margin:0;font:20px monospace} u{text-decoration-color:#ff0000;' +
        'text-decoration-thickness:2px;padding:0 20px;text-decoration-inset:25%}' +
        'b{font-weight:normal}</style><p><u id="a">aaaa<b>bbbb</b></u></p>',
    );
    const el = view(node);
    await act();
    // its border box, padding and all; the rule is under its text, 20px in
    // from each side
    const a = el.elementRect(findById(el.document, 'a')!)!;
    const by = a.width / 4;
    const rules = await rulesIn(el, '#ff0000');
    assert.equal(rules.length, 1, JSON.stringify(rules));
    const [[left, right]] = rules;
    assert.ok(
      Math.abs(left - (a.x + 20 + by)) <= 1,
      `${left} for ${a.x + 20 + by}`,
    );
    assert.ok(
      Math.abs(right - (a.x + a.width - 20 - by)) <= 1,
      `${right} for ${a.x + a.width - 20 - by}`,
    );
  },
);

metric(
  'over lines it is in at the element’s start and end where sliced, and at every line’s where cloned',
  async () => {
    const { node } = await render(
      '<style>body{margin:0;font:20px monospace} p{width:6ch;margin:0}' +
        'u{text-decoration-thickness:2px;text-decoration-inset:5px}</style>' +
        '<p><u style="text-decoration-color:#ff0000">abc def</u></p>' +
        '<p><u style="text-decoration-color:#0000ff;box-decoration-break:clone">abc def</u></p>',
    );
    const el = view(node);
    await act();
    const sliced = await rulesIn(el, '#ff0000');
    const cloned = await rulesIn(el, '#0000ff');
    assert.equal(sliced.length, 2, JSON.stringify(sliced));
    assert.equal(cloned.length, 2, JSON.stringify(cloned));
    const byLine = (rules: [number, number][]) =>
      rules.map(([l, r]) => r - l).sort((x, y) => x - y);
    // each line's text is three characters: in at one end of each sliced
    // line, and at both of each cloned one
    const [s0, s1] = byLine(sliced);
    const [c0, c1] = byLine(cloned);
    assert.ok(Math.abs(s0 - s1) <= 1, `sliced: ${s0}, ${s1}`);
    assert.ok(Math.abs(c0 - c1) <= 1, `cloned: ${c0}, ${c1}`);
    assert.ok(
      Math.abs(s0 - c0 - 5) <= 1,
      `cloned lines 5px shorter: ${s0}, ${c0}`,
    );
  },
);
