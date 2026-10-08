// <Html> — the document: the streaming source, fragments, and what HTML's
// parser implies.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import type { ChildNode, Element } from 'domhandler';
import {
  HtmlSource,
  appendChild,
  createElement,
  parseFragment,
  rawTextOf,
} from '../../src/html/dom.js';
import { parseColor } from '../../src/html/css/values.js';
import type { HtmlViewNode } from '../../src/html/index.js';
import {
  boxOf,
  drawnText,
  fillsOf,
  findById,
  h,
  lineTextsOf,
  metric,
  pointIn,
  render,
  view,
  type LaidBox,
} from './harness.js';

afterEach(cleanup);

test('a growing source is written as a delta and keeps node identity', () => {
  const source = new HtmlSource();
  source.setSource('<p>one</p>', false);
  const first = source.document.children[0];
  source.setSource('<p>one</p><p>two</p>', false);
  assert.strictEqual(
    source.document.children[0],
    first,
    'the settled node is the same object, so its boxes and layout survive',
  );
  assert.strictEqual(source.document.children.length, 2);
});

test('a source that is not an extension re-parses', () => {
  const source = new HtmlSource();
  source.setSource('<p>one</p>', false);
  const first = source.document.children[0];
  source.setSource('<div>different</div>', false);
  assert.notStrictEqual(source.document.children[0], first);
});

test('the last chunk of a stream is still written as a delta', () => {
  const source = new HtmlSource();
  source.setSource('<p>one</p>', false);
  const first = source.document.children[0];
  source.setSource('<p>one</p><p>two</p>', true);
  assert.strictEqual(
    source.document.children[0],
    first,
    'completing the stream is an append like any other, so identity survives',
  );
  assert.ok(source.complete);
});

test('a completed source that grows re-parses instead of extending the parse', () => {
  const source = new HtmlSource();
  source.setSource('<p>hi</p>', true);
  // An append-shaped edit to a *completed* document: the parser has been
  // ended, so this has to reset rather than write. It threw
  // `.write() after done!` before — and only for an edit at the end of the
  // document, because an edit anywhere else is not a prefix (#77).
  source.setSource('<p>hi</p>!', true);
  assert.strictEqual(rawTextOf(source.document), 'hi!');
  assert.ok(source.complete, 'the re-parse is ended again');
});

test('typing at the end of a completed document is a re-parse per keystroke', () => {
  const source = new HtmlSource();
  // Every one of these extends the last, so every one of them is the crash.
  source.setSource('<p>a', true);
  source.setSource('<p>ab', true);
  source.setSource('<p>abc', true);
  assert.strictEqual(rawTextOf(source.document), 'abc');
  assert.strictEqual(
    source.setSource('<p>abc', true),
    false,
    'and an unchanged source is still no work at all',
  );
});

test('the document reports its stylesheets, scripts and resources in one pass', () => {
  const source = new HtmlSource();
  source.setSource(
    '<title>T</title><style>p{color:red}</style>' +
      '<link rel="stylesheet" href="a.css"><script src="b.js"></script>' +
      '<img src="c.png">',
    true,
  );
  const facts = source.facts();
  assert.strictEqual(facts.title, 'T');
  assert.strictEqual(facts.sheets.length, 2);
  assert.strictEqual(facts.sheets[0].kind, 'inline');
  assert.strictEqual(facts.sheets[1].kind, 'link');
  assert.strictEqual(facts.scripts.length, 1);
  // the stylesheet link and the image are both resources
  assert.strictEqual(facts.resources.length, 2);
});

test("a <template>'s content is none of the document's: no sheet, script, resource, title or base", () => {
  // an inert fragment (HTML 4.12.3), out of the document until a script
  // stamps it in; the walk goes on past it
  const source = new HtmlSource();
  source.setSource(
    '<template><title>Inert</title><base href="http://inert.test/">' +
      '<style>p{color:red}</style><link rel="stylesheet" href="inert.css">' +
      '<script src="inert.js"></script><img src="inert.png">' +
      '<template><img src="deeper.png"></template></template>' +
      '<title>T</title><style>p{color:blue}</style><img src="c.png">',
    true,
  );
  const facts = source.facts();
  assert.strictEqual(facts.title, 'T');
  assert.strictEqual(facts.base, null);
  assert.deepStrictEqual(
    facts.sheets.map((s) => (s.kind === 'inline' ? s.text : s.href)),
    ['p{color:blue}'],
  );
  assert.strictEqual(facts.scripts.length, 0);
  assert.deepStrictEqual(
    facts.resources.map((el) => el.attribs.src),
    ['c.png'],
  );
});

metric(
  "a <template>'s <style> styles nothing, and nothing in it is asked for",
  async () => {
    const asked: string[] = [];
    const scripts: (string | null)[] = [];
    const { node } = await render(
      '<style>p { color: #00ff00 }</style>' +
        '<template><style>p { color: #ff0000 }</style>' +
        '<link rel="stylesheet" href="inert.css"><img src="inert.png">' +
        '<script src="inert.js"></script></template>' +
        '<p id="p">text</p><img src="shown.png">',
      400,
      {
        onResource: (r: { url: string }) => {
          asked.push(r.url);
          return null;
        },
        onScript: (s: { src: string | null }) => scripts.push(s.src),
      },
    );
    const p = boxOf(view(node), 'p') as LaidBox & { style: { color: string } };
    assert.strictEqual(p.style.color, '#00ff00');
    assert.deepStrictEqual(asked, ['shown.png']);
    assert.deepStrictEqual(scripts, []);
  },
);

/** A parsed document's elements, and its text that is not white space. */
function shapeOf(markup: string): string {
  const source = new HtmlSource();
  source.setSource(markup, true);
  type N = { name?: string; children?: N[]; data?: string };
  const walk = (nodes: N[]): string =>
    nodes
      .map((n) =>
        n.name !== undefined
          ? `${n.name}(${walk(n.children ?? [])})`
          : (n.data ?? '').trim(),
      )
      .filter(Boolean)
      .join(' ');
  return walk(source.document.children as unknown as N[]);
}

test("a written <html> holds its content in a body, as HTML's parser has it", () => {
  // htmlparser2 puts content where it stands. The root box stood in for a
  // body around the `<html>`, so a first paragraph's margin stood below
  // the body's, 8px lower than the same page with its `<body>` written.
  assert.strictEqual(
    shapeOf('<html><title>t</title><p>a</p></html>'),
    'html(title(t) body(p(a)))',
    'the first thing that is not head content opens it',
  );
  assert.strictEqual(shapeOf('<html>hi</html>'), 'html(body(hi))', 'text too');
  assert.strictEqual(
    shapeOf('<html><body><p>a</p></body><p>b</p></html><div>c</div>'),
    'html(body(p(a) p(b) div(c)))',
    'what comes after the body ends goes back into it',
  );
  assert.strictEqual(
    shapeOf('<html><p>a</p><body class="x"><p>b</p></body></html>'),
    'html(body(p(a) p(b)))',
    'and a second body is its attributes, on the first',
  );
  // with no `<html>`, a body written after content takes that content in
  assert.strictEqual(
    shapeOf('<title>t</title><p>a</p><body><div>b</div></body>'),
    'title(t) body(p(a) div(b))',
  );
  // and a fragment is left as it was written
  assert.strictEqual(shapeOf('<p>a</p>b'), 'p(a) b');
});

test("a table's rows go in the row group and the row HTML's parser implies", () => {
  // htmlparser2 opens none, so a table's rows were its children, and
  // `table.tBodies`, `tbody > tr` and a walk of the tree found another
  // tree than a browser's
  assert.strictEqual(
    shapeOf('<table><tr><td>a</td></tr><tr><td>b</td></tr></table>'),
    'table(tbody(tr(td(a)) tr(td(b))))',
    'one tbody, for both rows',
  );
  assert.strictEqual(
    shapeOf('<table><td>a<td>b</table>'),
    'table(tbody(tr(td(a) td(b))))',
    'a cell opens the row as well',
  );
  assert.strictEqual(
    shapeOf('<table><thead><th>h</th></thead><tbody><td>c</tbody></table>'),
    'table(thead(tr(th(h))) tbody(tr(td(c))))',
    'a written section is used, a row opened in it',
  );
  assert.strictEqual(
    shapeOf('<table><col><tr><td>x</table>'),
    'table(colgroup(col()) tbody(tr(td(x))))',
    'a column opens its group',
  );
  // and an end tag closes what was implied: Acid3's table ends its body
  // from inside a cell, and the space after it is the table's
  const [table] = parseFragment(
    '<table><tr><td><p></tbody> </table>',
  ) as Element[];
  assert.strictEqual(
    table.children
      .map(
        (k) =>
          (k as Element).name ??
          JSON.stringify((k as unknown as { data: string }).data),
      )
      .join(' '),
    'tbody " "',
  );
  // nothing is implied in SVG, whose names these are not
  assert.strictEqual(
    shapeOf('<svg><table><tr></tr></table></svg>'),
    'svg(table(tr()))',
  );
});

test('a fragment can be parsed and spliced in', () => {
  const nodes = parseFragment('<em>hi</em>');
  assert.strictEqual(nodes.length, 1);
  const holder = createElement('div');
  appendChild(holder, nodes[0]);
  assert.strictEqual(holder.children[0], nodes[0]);
  assert.strictEqual(nodes[0].parent, holder);
});

test('a /> closes a void element and one in SVG, and opens any other', () => {
  // melbcss.com comments an attribute out as `/*target="_blank"*/`, which
  // is no comment inside a tag: the `/` before `>` read as a self-closing
  // flag, and the link was empty, its text beside it
  const serialize = (nodes: ChildNode[]): string =>
    nodes
      .map((node) =>
        node.type === 'text'
          ? (node as unknown as { data: string }).data
          : `<${(node as Element).name}>${serialize((node as Element).children)}</${(node as Element).name}>`,
      )
      .join('');
  assert.strictEqual(
    serialize(
      parseFragment(
        '<a href="" /*target="_blank"*/><address>TBD</address></a>' +
          '<div/>in<br/>div</div>' +
          '<svg><rect/><circle/></svg><math><mi/><mo>+</mo></math>' +
          // an integration point is closed too: it is read in SVG
          '<svg><title/><desc/><foreignObject/><path/></svg>',
      ),
    ),
    '<a><address>TBD</address></a>' +
      '<div>in<br></br>div</div>' +
      '<svg><rect></rect><circle></circle></svg>' +
      '<math><mi></mi><mo>+</mo></math>' +
      '<svg><title></title><desc></desc><foreignObject></foreignObject><path></path></svg>',
  );
});

test('a degenerately nested document is capped, not crashed', async () => {
  // The box tree stops at depth 512 (Blink flattens at the same number), so
  // fuzzer-shaped nesting cannot blow the stack five phases later.
  const depth = 4000;
  const source =
    '<div>'.repeat(depth) + '<p>bottom</p>' + '</div>'.repeat(depth);
  const result = await renderX11(
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, partial: false, 'data-testname': 'doc' }),
    ),
    { backend: 'mock' },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  // The capped content is dropped; the point is that nothing threw.
  assert.strictEqual(typeof el.textContent(), 'string');
  void result;
});

test('the head is shown where a stylesheet says so, as a browser shows it', async () => {
  // `display: none` by the UA sheet, like the rest of what has no box of
  // its own, and no longer skipped whatever the stylesheet said
  const { node } = await render(
    '<html><head><meta name="x" content="PASS"><title>T</title>' +
      '<style>head, meta { display: block } meta::before { content: attr(content) }</style>' +
      '</head><body><p>body</p></body></html>',
  );
  const text = drawnText(view(node));
  assert.ok(text.includes('PASS'), `the meta's ::before is drawn: ${text}`);
  assert.ok(!text.includes('T\n') && !text.startsWith('T'), 'the title is not');
  assert.ok(text.includes('body'));
});

test('head content with no <head> around it stays hidden, as in the head a browser implies', async () => {
  const { node } = await render(
    '<title>Title</title><style>* { display: block }</style><p>body</p>',
  );
  const text = view(node).textContent();
  assert.ok(!text.includes('Title'), `no title: ${text}`);
  assert.ok(!text.includes('display'), 'no stylesheet');
  assert.ok(text.includes('body'));
});

/** The style an element's box computed. */
function styleOf(el: HtmlViewNode, id: string): Record<string, unknown> {
  return (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
}

metric(
  'a <noscript> in the body is drawn, as a browser with scripting off draws it',
  async () => {
    // nothing here runs a script, so a noscript represents its children
    // (HTML 4.12.2): a page's fallback for a browser without JavaScript is
    // what this draws, where the UA sheet hid it as one with JavaScript does
    const { node } = await render(
      '<!DOCTYPE html><html><head><title>t</title></head><body>' +
        '<p id="p">before <noscript><a id="a" href="https://example.test/nojs" ' +
        'style="background: #00ff00">no JavaScript</a></noscript> after</p>' +
        '</body></html>',
    );
    const el = view(node);
    const a = el.elementRect(findById(el.document, 'a')!);
    assert.ok(a && a.width > 0 && a.height > 0, 'the link is laid out');
    assert.ok(
      (await fillsOf(el)).some((f) => f.style === parseColor('#00ff00')),
      'and its background painted',
    );
    assert.strictEqual(
      el.hrefAtPoint(...pointIn(el, 'a')),
      'https://example.test/nojs',
      'and it is a link',
    );
    // inline, as an element the UA sheet has no rule for is
    assert.deepStrictEqual(lineTextsOf(el, 'p'), [
      'before no JavaScript after',
    ]);
  },
);

metric(
  'a <noscript> in the head applies its stylesheets, as a browser with scripting off does',
  async () => {
    // with scripting off HTML's parser keeps a head noscript's <style> and
    // <link> in it (13.2.6.4.5, "in head noscript"), and they apply
    const { node } = await render(
      '<!DOCTYPE html><html><head><title>t</title>' +
        '<noscript><style>p { color: red }</style>' +
        '<link rel="stylesheet" href="nojs.css"></noscript>' +
        '</head><body><p id="p">x</p></body></html>',
      400,
      {
        onResource: (r: { url: string; kind: string }) =>
          r.kind === 'stylesheet' && r.url === 'nojs.css'
            ? { kind: 'stylesheet', text: 'p { margin-left: 13px }' }
            : null,
      },
    );
    const el = view(node);
    assert.strictEqual(styleOf(el, 'p').color, 'red');
    assert.strictEqual(styleOf(el, 'p').marginLeft, 13, 'and the linked one');
    const text = el.textContent();
    assert.ok(
      !text.includes('color'),
      `and nothing of the head drawn: ${text}`,
    );
  },
);

metric(
  "a <noscript> with no <head> around it draws what HTML's parser takes into the body",
  async () => {
    // at the top of the document a noscript is the implied head's, and with
    // scripting off the parser moves what it holds that is not head content
    // into the body (13.2.6.4.5): the link is drawn, the sheet applies and,
    // as the head's, stays hidden whatever another sheet says
    const { node } = await render(
      '<noscript><style>p { color: red }</style>' +
        '<a id="a" href="https://example.test/nojs">no JavaScript</a></noscript>' +
        '<style>* { display: block }</style><p id="p">x</p>',
    );
    const el = view(node);
    const text = el.textContent();
    assert.ok(text.includes('no JavaScript'), `the link is drawn: ${text}`);
    assert.ok(!text.includes('color'), 'and the sheet is not');
    assert.strictEqual(styleOf(el, 'p').color, 'red');
  },
);

metric(
  'a newline straight after a <pre> start tag is no part of its text',
  async () => {
    // HTML's parser drops it as an authoring convenience (13.2.6.4.7), so a
    // code block written `<pre>` and a line break starts on its first line
    // of code, and a second newline is a blank line
    const { node } = await render(
      '<pre id="p">\nfirst\n  second</pre><pre id="q">\n\nafter a blank</pre>' +
        '<pre id="r">\r\ncrlf</pre>',
    );
    const el = view(node);
    assert.deepStrictEqual(lineTextsOf(el, 'p'), ['first\n', '  second']);
    assert.deepStrictEqual(lineTextsOf(el, 'q'), ['\n', 'after a blank']);
    assert.deepStrictEqual(lineTextsOf(el, 'r'), ['crlf']);
    assert.ok(!el.textContent().startsWith('\n'), 'nor of the document');
  },
);
