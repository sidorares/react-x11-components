// <Html> — what HTML's own elements and attributes look like.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import { boxOf, render, view } from './harness.js';
import type { LaidBox } from './harness.js';

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
