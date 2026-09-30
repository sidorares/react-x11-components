// <Html> — direction and bidi.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, pixelAt, waitFor } from 'react-x11/test';
import { HtmlViewNode } from '../../src/html/index.js';
import {
  boxOf,
  extentOf,
  findById,
  linesOf,
  metric,
  render,
  view,
} from './harness.js';

afterEach(cleanup);

metric(
  'a right-to-left line with an inline-block on it reads right to left',
  async () => {
    const block =
      '<span style="display:inline-block;width:30px;height:10px"></span>';
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;width:300px;direction:rtl}</style>' +
        `<p id="he">אחת ${block} שתיים</p><p id="en">Hello ${block} world</p>`,
    );
    const [he] = linesOf(view(node), 'he');
    const [one, two] = he.texts.map(extentOf);
    const heBox = he.atomics[0];
    assert.ok(
      two[1] <= heBox.x && heBox.x + heBox.box.width <= one[0],
      `the first word rightmost: ${one}, ${heBox.x}, ${two}`,
    );
    assert.ok(Math.abs(one[1] - 300) < 1, `and flush right: ${one[1]}`);
    // left-to-right words either side of it keep their order (UAX #9 N1)
    const [en] = linesOf(view(node), 'en');
    const [hello, world] = en.texts.map(extentOf);
    const enBox = en.atomics[0];
    assert.ok(
      hello[1] <= enBox.x && enBox.x + enBox.box.width <= world[0],
      `left to right inside it: ${hello}, ${enBox.x}, ${world}`,
    );
    assert.ok(Math.abs(world[1] - 300) < 1, `still flush right: ${world[1]}`);
  },
);

metric("an inline element's start side is its direction's", async () => {
  // CSS 2.1 8.6: a right-to-left element starts on its right
  const { node } = await render(
    '<p id="p" style="margin:0;direction:rtl">אחת <span style="padding-right:12px;' +
      'padding-left:4px">שתיים</span> שלוש</p>',
  );
  const [line] = linesOf(view(node), 'p');
  const inside = extentOf(line.texts[1]);
  const start = line.edges?.find((e) => e.side === 'start');
  const end = line.edges?.find((e) => e.side === 'end');
  assert.ok(start && end, 'both edges are on the line');
  assert.strictEqual(start.width, 12);
  assert.strictEqual(end.width, 4);
  assert.ok(
    Math.abs(start.x - inside[1]) < 0.5,
    'the start, right of its text',
  );
  assert.ok(
    Math.abs(end.x + end.width - inside[0]) < 0.5,
    'the end, left of it',
  );
});

metric('a right-to-left block starts at the right', async () => {
  // CSS 2.1 10.3.3: the margin that takes the slack is the one at the end,
  // the left one in a right-to-left containing block; 16.1: the indent is
  // at the start of the line; 10.3.7: so is an absolute box's static place
  const { node } = await render(
    '<div id="c" style="direction:rtl;width:300px;position:relative">' +
      '<div id="b" style="width:100px;height:10px"></div>' +
      '<p id="p" style="margin:0;text-indent:20px">word</p>' +
      '<div id="a" style="position:absolute;width:50px;height:5px"></div>' +
      '</div>' +
      '<div style="position:relative;margin-left:100px"><div id="f" ' +
      'style="position:fixed;left:0;top:0;width:10px;height:10px"></div></div>',
  );
  const el = view(node);
  const [c, b, p, a, f] = ['c', 'b', 'p', 'a', 'f'].map((id) => boxOf(el, id));
  assert.strictEqual(b.x, c.x + 200, 'a block of a set width');
  const [line] = linesOf(el, 'p');
  assert.ok(
    Math.abs(line.x + line.width - (p.x + p.width - 20)) < 0.5,
    `a line indented from the right: ${line.x + line.width}`,
  );
  assert.strictEqual(a.x, c.x + 250, 'an absolute box with auto offsets');
  assert.strictEqual(f.x, 0, "and a fixed box's containing block is the view");
});

test('right to left, a relative box set on both sides moves by its right, and a table starts at the right', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div dir="rtl" style="width:200px">' +
      '<div id="r" style="position:relative;left:50px;right:50px;width:50px;height:10px"></div></div>' +
      '<table dir="rtl" style="border-spacing:0"><tr>' +
      '<td id="a" style="width:50px;padding:0"></td><td id="b" style="width:30px;padding:0"></td>' +
      '</tr></table>',
    400,
  );
  const el = view(node);
  // at the right of its 200px block, then 50px back to the left
  assert.strictEqual(boxOf(el, 'r').x, 100);
  const a = boxOf(el, 'a');
  const b = boxOf(el, 'b');
  assert.strictEqual(a.x, b.x + b.width, 'the first cell at the right');
});

metric(
  'unicode-bidi overrides and embeds as its controls do, and they are no text',
  async () => {
    // carried out as the bidi controls it stands for, which are laid out
    // and are no text of the document's: the text, a caret and a
    // selection skip them (CSS Writing Modes 3, 2.4.2)
    const { node } = await render(
      '<p style="margin:0">ab<span style="direction:rtl;unicode-bidi:bidi-override">' +
        'cde</span>fg <bdo dir="rtl">hij</bdo></p>',
    );
    const el = view(node);
    assert.strictEqual(el.textContent(), 'abcdefg hij');
    const at = (i: number) => el.textCaretRect(i)!.x;
    // `cde` is drawn `edc`: before `d` is right of before `e`. The carets
    // at the run's two ends are the engine's to place, on either side.
    assert.ok(at(3) > at(4), `d at ${at(3)}, e at ${at(4)}`);
    // and the text on either side reads on
    assert.ok(at(1) < at(3) && at(6) < at(7));
    // `<bdo dir="rtl">` overrides by the UA sheet's rule
    assert.ok(at(9) > at(10), `i at ${at(9)}, j at ${at(10)}`);
  },
);

test('HTML isolates what has a dir of its own, and a <bdo> overrides', async () => {
  const { node } = await render(
    '<p id="a" dir="rtl">x</p><span id="b" dir="ltr">y</span>' +
      '<bdi id="c">z</bdi><bdo id="d" dir="rtl">w</bdo>',
  );
  const el = view(node);
  const of = (id: string) =>
    (boxOf(el, id) as unknown as { style: { unicodeBidi: string } }).style
      .unicodeBidi;
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map(of), [
    'isolate',
    'isolate',
    'plaintext',
    'isolate-override',
  ]);
});

/** Where each of a document's letters is drawn, left to right: its
 *  centre, from the band a range of it alone makes. */
function visualOrder(el: HtmlViewNode, letters: string): string {
  const text = el.textContent();
  const centre = (ch: string): number => {
    const at = text.indexOf(ch);
    const [band] = el.textRangeRects(at, at + 1);
    assert.ok(band, `${ch} is drawn`);
    return band.x + band.width / 2;
  };
  return [...letters].sort((a, b) => centre(a) - centre(b)).join('');
}

metric(
  "an override opened outside an element's edges and closed inside them reorders across them",
  async () => {
    // A paragraph with an inline box's edges in it is laid out a piece at
    // a time, and a piece was ordered by the engine alone: `de` and `f`
    // were read as though no override had opened before them, left to
    // right. They are ordered by the paragraph's levels now (#149).
    const { node } = await render(
      '<p style="margin:0;font:20px monospace">a\u202ebc<span ' +
        'style="padding:0 4px">de</span>f\u202cg</p>',
    );
    assert.strictEqual(visualOrder(view(node), 'abcdefg'), 'afedcbg');
  },
);

metric(
  'a neutral at the edge of a piece takes the direction around it',
  async () => {
    // an image between two English words in a right-to-left paragraph is
    // among them, and so are the spaces either side of it (UAX #9, N1):
    // laid out apart, the space before `world` read as the paragraph
    // does, and went to its right
    const { node } = await render(
      '<p dir="rtl" style="margin:0;font:20px monospace">Hello <img id="i" ' +
        'style="width:10px;height:10px"> world</p>',
    );
    const el = view(node);
    const text = el.textContent();
    const band = (i: number) => el.textRangeRects(i, i + 1)[0];
    const image = boxOf(el, 'i');
    const w = band(text.indexOf('w'));
    const o = band(text.indexOf('o'));
    assert.ok(
      o.x + o.width < image.x && w.x > image.x + image.width,
      'Hello, the image, world',
    );
    const gap = w.x - (image.x + image.width);
    assert.ok(Math.abs(gap - w.width) < 1, `a space before world: ${gap}`);
  },
);

metric(
  'an element bidi splits apart on a line is drawn as a fragment a part',
  async () => {
    // `c` and `d` are the span's and `e` is not, and reordered, `e` goes
    // between them: the span is two boxes, not one across `e` (CSS 2.1
    // 9.10), whose background showed behind a letter not its own
    const { result, node } = await render(
      '<p style="margin:0;font:20px monospace">a\u202eb<span ' +
        'style="background:#0000ff">c\u202dd</span>e\u202c\u202cf</p>',
    );
    const el = view(node);
    assert.strictEqual(visualOrder(el, 'abcdef'), 'adecbf');
    const text = el.textContent();
    const at = (node as unknown as { abs: { x: number; y: number } }).abs;
    // across the letter's middle, some of which its glyph leaves bare
    const blue = async (ch: string) => {
      const i = text.indexOf(ch);
      const band = el.textRangeRects(i, i + 1)[0];
      const y = Math.round(at.y + band.y + band.height / 2);
      for (let x = band.x + 1; x < band.x + band.width - 1; x += 1) {
        const [r, g, b] = await pixelAt(result.ctx, Math.round(at.x + x), y);
        if (b > 200 && r < 60 && g < 60) return true;
      }
      return false;
    };
    await waitFor(async () => {
      assert.ok(await blue('c'), 'behind c');
      assert.ok(await blue('d'), 'behind d');
      assert.ok(!(await blue('e')), 'not behind e');
    });
  },
);

metric(
  'a space before a bidi control that a piece ends on takes its room',
  async () => {
    // the engine strips the spaces a piece ends on, before a control as
    // well, and they are measured back where the line goes on after them:
    // through the override `ab ` ends on, which hid them
    const { node } = await render(
      '<p style="margin:0;font:20px monospace">ab \u202e<span id="s" ' +
        'style="padding:0 4px">cd</span>\u202c ef</p>',
    );
    const el = view(node);
    const b = el.textRangeRects(1, 2)[0];
    const s = el.elementRect(findById(el.document, 's')!)!;
    const gap = s.x - (b.x + b.width);
    assert.ok(Math.abs(gap - b.width) < 1, `a space after b: ${gap}`);
    assert.strictEqual(visualOrder(el, 'abcdef'), 'abdcef');
  },
);

metric(
  'a word split into pieces by its levels is still one word to a float',
  async () => {
    // the pieces of `abcde` a level at a time run on from one another, as
    // the fragment ran on from the text before it (#420's joins): a float
    // too narrow for the word is as wide as all of it, padding and all
    const { node } = await render(
      '<div style="width:30px;font:20px monospace"><div id="f" ' +
        'style="float:left">a\u202eb<span style="padding:0 2px">c' +
        '</span>d\u202ce</div></div>',
    );
    const el = view(node);
    const a = el.textRangeRects(0, 1)[0];
    const width = boxOf(el, 'f').width;
    assert.ok(
      Math.abs(width - (5 * a.width + 4)) < 1,
      `five letters and the padding: ${width} for ${a.width}`,
    );
  },
);

metric(
  'a piece split by its levels keeps the spaces pre-wrap hangs at its end',
  async () => {
    // `d` is under the override and `e` is not, so their fragment is laid
    // out again a level at a time, and the spaces `e` ends the block on
    // are the last piece's: its box covers them and they take room
    const { node } = await render(
      '<p style="margin:0;font:20px monospace;white-space:pre-wrap">' +
        'a\u202eb<span style="padding:0 2px">c</span>d\u202c<span ' +
        'id="s" style="background:#0000ff">e  </span></p>',
    );
    const el = view(node);
    const text = el.textContent();
    const a = el.textRangeRects(0, 1)[0];
    const s = el.elementRect(findById(el.document, 's')!)!;
    assert.ok(
      Math.abs(s.width - 3 * a.width) < 1,
      `e and its two spaces: ${s.width} for ${a.width}`,
    );
    const e = el.textRangeRects(text.indexOf('e'), text.indexOf('e') + 1)[0];
    assert.ok(Math.abs(s.x - e.x) < 1, `from e on: ${s.x}, ${e.x}`);
  },
);
