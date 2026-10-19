// <Html> — what HTML's own elements and attributes look like.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, screen } from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import { setModal } from '../../src/html/dom.js';
import { isInert } from '../../src/html/focus.js';
import type { HtmlViewNode } from '../../src/html/index.js';
import {
  boxOf,
  clipsAround,
  fillsOf,
  findById,
  render,
  view,
} from './harness.js';
import type { LaidBox, PaintOp } from './harness.js';

afterEach(cleanup);

test('an anchor with no href is drawn as the text around it', async () => {
  const { node } = await render(
    '<p style="color:#123456"><a id="n">name</a> <a id="l" href="#">link</a></p>',
  );
  const el = view(node);
  const styleOf = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { color: string; textDecorationLine: string };
      }
    ).style;
  assert.strictEqual(styleOf('n').color, parseColor('#123456'));
  assert.strictEqual(styleOf('n').textDecorationLine, 'none');
  assert.notStrictEqual(styleOf('l').color, parseColor('#123456'));
});

test('an hr with no width set is as wide as its line', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><hr id="a"><hr id="b" style="width:50%">',
    400,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').width, 400);
  assert.strictEqual(boxOf(el, 'b').width, 200);
});

test('align places a table, and <center> or an aligned cell centres the blocks in it', async () => {
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0}td{padding:0}</style>' +
      // the frame of nearly every mail: centred, its text left alone
      '<table id="t1" align="center" width="200"><tr><td id="c1">x</td></tr></table>' +
      '<center><table id="t2" width="100"><tr><td>x</td></tr></table></center>' +
      '<div align="center"><table id="t3" width="100"><tr><td>x</td></tr></table></div>' +
      // a button: no width, so centred once it has shrunk to its cell
      '<table id="t4" align="center"><tr><td>Button</td></tr></table>' +
      '<table id="t5" align="right" width="100"><tr><td>x</td></tr></table>' +
      '<table width="400" style="clear:both"><tr><td align="center">' +
      '<table id="t6" width="50"><tr><td>x</td></tr></table></td></tr></table>' +
      // what mail's own CSS writes for it
      '<div style="text-align:-webkit-center"><div id="d" style="width:100px">x</div></div>',
    400,
  );
  const el = view(node);
  const x = (id: string) => boxOf(el, id).x;
  assert.strictEqual(x('t1'), 100);
  assert.strictEqual(x('t2'), 150);
  assert.strictEqual(x('t3'), 150);
  const t4 = boxOf(el, 't4');
  assert.ok(Math.abs(t4.x - (400 - t4.width) / 2) < 0.01, 'centred shrunk');
  assert.strictEqual(x('t5'), 300, 'floated right');
  assert.strictEqual(x('t6'), 175);
  assert.strictEqual(x('d'), 150);
  const align = (boxOf(el, 'c1') as unknown as { style: { textAlign: string } })
    .style.textAlign;
  assert.notStrictEqual(align, 'center', "the table's text is its own");
});

test("a list, a definition and a figure are indented the HTML standard's 40px, whatever the size", async () => {
  // HTML 15.3.3 and 15.3.8: the indents are lengths, not ems. At 2.5em, a
  // list in a 10px sidebar was indented 25px, and one in a 20px article 50
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="font-size:10px"><ul id="u"><li id="a">item</li></ul>' +
      '<dl><dt>term</dt><dd id="d">definition</dd></dl>' +
      '<figure id="f">figure</figure></div>' +
      '<ol id="o" style="font-size:20px"><li id="b">item</li></ol>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').x, 40, 'a list item at 10px');
  assert.strictEqual(boxOf(el, 'b').x, 40, 'and at 20px');
  assert.strictEqual(boxOf(el, 'd').x, 40, 'a definition');
  assert.strictEqual(boxOf(el, 'f').x, 40, 'a figure');
});

test("a pre and its code are HTML's: no padding, no scroll, no size of their own", async () => {
  // HTML 15.3.3 and 15.3.4 give a `<pre>` its margins, `white-space: pre`
  // and the generic monospace, and code, kbd, samp and tt the family alone.
  // The sheet framed every pre in 0.7em 0.9em of padding and a scroll, and
  // set it and its code at 0.9em: joshwcomeau.com's code blocks, which no
  // browser pads, were 20px taller than Chrome's and their code a tenth
  // smaller. The code face is the generic's, at its size
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<pre id="p">pre</pre>' +
      '<div id="d" style="font-family:monospace;white-space:pre">pre</div>' +
      '<pre><code id="c" style="font-family:Menlo, Courier">code</code></pre>' +
      '<p>a <code id="i">code</code> <kbd id="k">kbd</kbd></p>' +
      '<div style="font-size:15px"><pre id="r">pre</pre></div>',
    400,
    { fontSize: 16 },
  );
  const el = view(node);
  const box = (id: string) =>
    boxOf(el, id) as LaidBox & {
      style: {
        fontSize: number;
        paddingTop: unknown;
        paddingLeft: unknown;
        marginTop: unknown;
        overflowX: string;
      };
    };
  const pre = box('p');
  assert.strictEqual(pre.style.fontSize, 13, "the generic's medium");
  assert.strictEqual(pre.style.paddingTop, 0);
  assert.strictEqual(pre.style.paddingLeft, 0);
  assert.strictEqual(pre.style.overflowX, 'visible');
  assert.strictEqual(pre.style.marginTop, 13, 'an em of its own size');
  assert.strictEqual(pre.height, box('d').height, 'its line, and no more');
  assert.strictEqual(box('c').style.fontSize, 16, 'a family of its own');
  assert.strictEqual(box('i').style.fontSize, 13);
  assert.strictEqual(box('k').style.fontSize, 13);
  assert.strictEqual(box('r').style.fontSize, 15, 'under a length, the length');
});

test('a closed details shows its summary, and an open one all of it', async () => {
  // a closed `<details>` showed everything in it: an FAQ of them was every
  // answer at once
  const { node } = await render(
    '<details id="closed"><summary id="s1">Question</summary>' +
      '<p id="hidden">Answer</p></details>' +
      '<details id="open" open><summary id="s2">Question</summary>' +
      '<p id="shown">Answer</p></details>' +
      '<details id="two"><summary id="s3">First</summary>' +
      '<summary id="s4">Second</summary></details>',
  );
  const el = view(node);
  const has = (id: string) => {
    try {
      boxOf(el, id);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(has('s1'), 'the summary');
  assert.ok(!has('hidden'), 'not the answer');
  assert.ok(has('shown'), "an open one's answer");
  assert.ok(has('s3') && !has('s4'), 'the first summary only');
  // with the marker HTML gives a summary, turned down when open
  const type = (id: string) =>
    (boxOf(el, id) as unknown as { style: { listStyleType: string } }).style
      .listStyleType;
  assert.strictEqual(type('s1'), 'disclosure-closed');
  assert.strictEqual(type('s2'), 'disclosure-open');
});

test('a closed dialog is not drawn, and an open one is a framed box centred across its containing block, out of the flow', async () => {
  // docs.github.com keeps its search dialog in the page, empty and closed,
  // styled as a card fixed under the header: with no rule for a dialog it
  // was drawn there, an empty rounded box over the breadcrumbs
  const { node } = await render(
    '<style>body{margin:0;font-size:16px}</style>' +
      '<div style="position:relative;width:400px;height:300px">' +
      '<p id="p" style="margin:0;height:20px"></p>' +
      '<dialog id="closed" style="position:fixed;padding:16px">closed</dialog>' +
      '<dialog id="open" open><div style="width:100px;height:30px"></div>' +
      '</dialog><p id="q" style="margin:0;height:20px"></p></div>',
  );
  const el = view(node);
  assert.throws(() => boxOf(el, 'closed'), 'a closed dialog has no box');
  // Chrome 154: 1em of padding and a medium solid border round what it
  // holds, at its static position down and centred across
  const open = boxOf(el, 'open');
  assert.deepStrictEqual(
    [open.x, open.y, open.width, open.height],
    [131, 20, 138, 68],
  );
  assert.strictEqual(boxOf(el, 'q').y, 20, 'and the flow goes on under it');
});

/** Make a dialog modal, or not, as `showModal()` and `close()` do through
 *  the script engine's `modal` op, and tell the document. */
async function modal(el: HtmlViewNode, id: string, on: boolean): Promise<void> {
  const d = findById(el.document, id)!;
  if (on) d.attribs.open = '';
  else delete d.attribs.open;
  setModal(d, on);
  el.touchDocument([
    { type: 'attributes', target: d, attributeName: '-rx-modal' },
    { type: 'attributes', target: d, attributeName: 'open' },
  ] as never);
  await act();
}

test('a modal dialog is in the top layer: centred in the viewport over every stacking context, its ::backdrop under it, and out of the box that clips, moves and fades it', async () => {
  const { node } = await render(
    '<style>body{margin:0;font-size:16px}</style>' +
      '<div style="position:relative;z-index:1;transform:scale(2);transform-origin:0 0;' +
      'overflow:hidden;opacity:.5;width:300px;height:100px;background:blue">' +
      '<dialog id="d"><div id="in" style="width:100px;height:30px;background:lime"></div></dialog></div>' +
      '<div id="top" style="position:fixed;z-index:2147483647;left:0;top:0;width:50px;height:50px;background:red"></div>',
  );
  const el = view(node);
  await modal(el, 'd', true);
  // Chrome 152 in a 400 by 600 viewport: HTML's `dialog:modal` rule
  // centres it there, whatever it is in
  const d = boxOf(el, 'd');
  assert.deepStrictEqual([d.x, d.y, d.width, d.height], [131, 266, 138, 68]);
  assert.strictEqual(
    el.computedStyle(findById(el.document, 'd')!)?.position,
    'fixed',
  );
  const ops: PaintOp[] = [];
  const fills = await fillsOf(el, ops);
  const at = (color: string) =>
    fills.findIndex((f) => f.style === parseColor(color));
  // the backdrop over the box at the greatest `z-index` there is, as wide
  // and tall as the viewport, and the dialog over it
  const backdrop = fills.findIndex((f) => f.style === 'rgba(0, 0, 0, 0.1)');
  assert.ok(at('red') < backdrop && backdrop < at('white'), 'painted last');
  const { x, y, w, h } = fills[backdrop];
  assert.deepStrictEqual([x, y, w, h], [0, 0, 400, 600]);
  // and none of what the box it is in does to what it holds: no matrix,
  // and no clip but its own padding box, which `overflow: auto` cuts at
  const lime = fills[at('lime')];
  assert.strictEqual(lime.matrix, undefined);
  assert.deepStrictEqual([lime.x, lime.y, lime.w, lime.h], [150, 285, 100, 30]);
  assert.deepStrictEqual(clipsAround(ops, 'lime'), [
    [{ op: 'clip', x: 134, y: 269, w: 132, h: 62, radii: null }],
  ]);
  // a press anywhere around it is the dialog's
  const { abs } = el as unknown as { abs: { x: number; y: number } };
  const hit = (px: number, py: number) =>
    el.elementAtPoint(abs.x + px, abs.y + py)?.attribs.id;
  assert.strictEqual(hit(5, 5), 'd', 'over the fixed box, the backdrop');
  assert.strictEqual(hit(200, 300), 'in');
  // closed, it is in the box it is in again
  await modal(el, 'd', false);
  assert.throws(() => boxOf(el, 'd'));
  assert.ok(
    !(await fillsOf(el)).some((f) => f.style === 'rgba(0, 0, 0, 0.1)'),
    'and its backdrop goes with it',
  );
});

test("a modal dialog's ::backdrop is the page's to style, and inherits from its dialog", async () => {
  // Primer's search dialog sets its own
  const { node } = await render(
    '<style>body{margin:0} dialog{color:rgb(4,5,6)}' +
      '.search::backdrop{background-color:rgba(1,2,3,0.5);border-top:5px solid}</style>' +
      '<dialog id="d" class="search">x</dialog>',
  );
  const el = view(node);
  await modal(el, 'd', true);
  const fills = await fillsOf(el);
  const dim = fills.find((f) => f.style === 'rgba(1, 2, 3, 0.5)');
  assert.ok(dim, 'its own background');
  // `currentColor` is the dialog's colour
  const edge = fills.find(
    (f) => f.style === parseColor('rgb(4,5,6)') && f.h === 5,
  );
  assert.ok(edge, 'a border in the colour it takes from the dialog');
  assert.deepStrictEqual([edge.x, edge.y, edge.w], [0, 0, 400]);
});

test('a modal dialog blocks the rest of the document: its controls get no widget, and none of it takes the focus', async () => {
  const { node } = await render(
    '<p><input id="page"> <a id="link" href="#x">link</a></p>' +
      '<dialog id="d"><input id="field"></dialog>',
  );
  const el = view(node);
  const byId = (id: string) => findById(el.document, id)!;
  assert.strictEqual(screen.getAllByRole('textbox').length, 1);
  assert.ok(!isInert(byId('link')));
  await modal(el, 'd', true);
  await act();
  // the one in the dialog is its widget, and the page's is not mounted
  assert.strictEqual(screen.getAllByRole('textbox').length, 1);
  assert.ok(isInert(byId('page')) && isInert(byId('link')));
  assert.ok(!isInert(byId('field')));
  await modal(el, 'd', false);
  await act();
  assert.ok(!isInert(byId('link')));
  assert.strictEqual(screen.getAllByRole('textbox').length, 1);
});

test("a body's text and link colours, and a background attribute", async () => {
  const { node } = await render(
    '<body text="#123456" link="#00ff00">' +
      '<p id="p">x</p><a id="a" href="#">l</a>' +
      '<table id="t" background="bg.png"><tr><td>x</td></tr></table></body>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { color: string; backgroundImage: string | null };
      }
    ).style;
  assert.strictEqual(style('p').color, '#123456');
  assert.strictEqual(style('a').color, '#00ff00');
  assert.strictEqual(style('t').backgroundImage, 'bg.png');
});

test("nowrap, a clearing br, an image aligned in its line, and a rule's own attributes", async () => {
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0}td{padding:0}p{margin:0}</style>' +
      '<div style="width:60px"><table><tr>' +
      '<td id="n" nowrap>one two three</td></tr></table></div>' +
      '<img id="f" src="a.png" width="30" height="30" style="float:left">x' +
      '<br clear="all"><p id="after">after</p>' +
      '<p><img id="m" src="a.png" width="10" height="10" align="middle">x</p>' +
      '<hr id="h" width="50%" size="3" color="#ff0000">' +
      '<hr id="l" width="50%" align="left">',
    400,
  );
  const el = view(node);
  type Styled = LaidBox & {
    lines: unknown[] | null;
    style: {
      verticalAlign: string;
      borderTopWidth: number;
      borderTopColor: string;
    };
  };
  const box = (id: string) => boxOf(el, id) as Styled;
  assert.strictEqual(box('n').lines?.length, 1, 'one line, and no wrap');
  const f = box('f');
  assert.ok(box('after').y >= f.y + f.height, 'below the float');
  assert.strictEqual(box('m').style.verticalAlign, 'middle');
  const h = box('h');
  assert.strictEqual(h.x, 100, 'centred, as a browser centres a rule');
  assert.strictEqual(h.style.borderTopWidth, 3);
  assert.strictEqual(h.style.borderTopColor, '#ff0000');
  assert.strictEqual(box('l').x, 0);
});

test('an abbreviation with a title is underlined dotted, as the HTML standard sets it', async () => {
  // HTML 15.3.4: `abbr[title], acronym[title] { text-decoration: dotted
  // underline }`. The user-agent sheet said `none`, so the Zen Garden's
  // first design had its W3C and WaSP plain where a browser marks them
  const { node } = await render(
    '<p><abbr id="t" title="World Wide Web Consortium">W3C</abbr> ' +
      '<acronym id="a" title="Web Standards Project">WaSP</acronym> ' +
      '<abbr id="n">CSS</abbr></p>',
  );
  const el = view(node);
  const styleOf = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { textDecorationLine: string; textDecorationStyle: string };
      }
    ).style;
  for (const id of ['t', 'a']) {
    assert.strictEqual(styleOf(id).textDecorationLine, 'underline', id);
    assert.strictEqual(styleOf(id).textDecorationStyle, 'dotted', id);
  }
  assert.strictEqual(styleOf('n').textDecorationLine, 'none', 'no title');
});
