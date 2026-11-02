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
  blocksParser,
  createElement,
  parseFragment,
  rawTextOf,
} from '../../src/html/dom.js';
import { parseColor } from '../../src/html/css/values.js';
import { controlsOf } from '../../src/html/form.js';
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

test('a source that yields stops after each script that blocks the parser, takes what it writes after it, and goes on when told', () => {
  const source = new HtmlSource();
  source.setScripting(true);
  source.setYields(true);
  source.setSource(
    '<p id="a">a</p><script defer src="d.js"></script>' +
      '<script type="module"></script><script async src="x.js"></script>' +
      '<script type="text/plain"></script><template><script></script></template>' +
      '<noscript><script></script></noscript>' +
      '<script id="s">one</script><p id="b">b</p>' +
      '<script id="t" src="t.js"></script><p id="c">c</p>',
    true,
  );
  const held = source.held!;
  assert.strictEqual(
    held?.attribs.id,
    's',
    'not a deferred one, a module, an async one, a data block, or one in a template or a noscript',
  );
  assert.ok(!source.complete);
  assert.strictEqual(findById(source.document, 'b'), null, 'nothing after it');
  assert.strictEqual(rawTextOf(held), 'one', 'and it is whole');
  // only the script it waits at writes into the stream
  assert.strictEqual(source.write(createElement('script'), '<i></i>'), false);
  assert.ok(source.write(held, '<i id="w">w'));
  assert.ok(findById(source.document, 'w'), 'parsed as it is written');
  assert.ok(source.write(held, '</i>'));
  source.resume(held);
  assert.strictEqual(source.held?.attribs.id, 't', 'a src blocks too');
  assert.ok(findById(source.document, 'b'));
  assert.strictEqual(findById(source.document, 'c'), null);
  const ids = (): string[] =>
    [...source.document.children]
      .filter((n): n is Element => 'attribs' in n)
      .map((n) => n.attribs.id ?? n.name);
  assert.deepStrictEqual(ids(), [
    'a',
    'script',
    'script',
    'script',
    'script',
    'template',
    'noscript',
    's',
    'w',
    'b',
    't',
  ]);
  source.resume(source.held!);
  assert.strictEqual(source.held, null);
  assert.ok(source.complete, 'to the end of the source');
  assert.deepStrictEqual(ids().slice(-2), ['t', 'c']);
});

test('a script a script writes is waited at before what was written after it, and writes before it', () => {
  const source = new HtmlSource();
  source.setScripting(true);
  source.setYields(true);
  source.setSource('<script id="s"></script><p id="tail"></p>', true);
  const outer = source.held!;
  source.write(outer, '<script id="w" src="w.js"></script><p id="after"></p>');
  assert.strictEqual(findById(source.document, 'after'), null, 'it waits');
  source.write(outer, '<p id="later"></p>');
  source.resume(outer);
  const written = source.held!;
  assert.strictEqual(written.attribs.id, 'w');
  source.write(written, '<p id="from-w"></p>');
  source.resume(written);
  assert.ok(source.complete);
  assert.deepStrictEqual(
    source.document.children.map((n) => (n as Element).attribs.id),
    ['s', 'w', 'from-w', 'after', 'later', 'tail'],
  );
});

test('a source that yields with no script that blocks the parser is parsed whole at once', () => {
  const source = new HtmlSource();
  source.setScripting(true);
  source.setYields(true);
  source.setSource(
    '<p>a</p><script type="module"></script><script defer src="d.js"></script><p>b</p>',
    true,
  );
  assert.strictEqual(source.held, null);
  assert.ok(source.complete);
  assert.strictEqual(source.document.children.length, 4);
});

test('a stream that yields reads no `</script>` across two of its chunks', () => {
  const source = new HtmlSource();
  source.setScripting(true);
  source.setYields(true);
  // read through a call, which an assertion of null does not narrow
  const held = (): Element | null => source.held;
  source.setSource('<p>a</p><script id="s">x</scr', false);
  assert.strictEqual(held(), null);
  source.setSource('<p>a</p><script id="s">x</script', false);
  assert.strictEqual(held(), null, 'no `>` yet');
  source.setSource('<p>a</p><script id="s">x</script><p id="b"></p>', false);
  assert.strictEqual(held()?.attribs.id, 's');
  assert.strictEqual(rawTextOf(held()!), 'x');
  assert.strictEqual(findById(source.document, 'b'), null);
  source.resume(held()!);
  assert.ok(findById(source.document, 'b'));
  assert.ok(!source.complete, 'the stream goes on');
  source.setSource('<p>a</p><script id="s">x</script><p id="b"></p>', true);
  assert.ok(source.complete);
});

test('turned off while it waits, a source that yields reads on to the end', () => {
  const source = new HtmlSource();
  source.setScripting(true);
  source.setYields(true);
  source.setSource('<script></script><p id="b"></p>', true);
  assert.ok(source.held);
  assert.ok(source.setYields(false));
  assert.strictEqual(source.held, null);
  assert.ok(source.complete);
  assert.ok(findById(source.document, 'b'));
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
    'html(head(title(t)) body(p(a)))',
    'the first thing that is not head content opens it',
  );
  assert.strictEqual(
    shapeOf('<html>hi</html>'),
    'html(head() body(hi))',
    'text too',
  );
  assert.strictEqual(
    shapeOf('<html><body><p>a</p></body><p>b</p></html><div>c</div>'),
    'html(head() body(p(a) p(b) div(c)))',
    'what comes after the body ends goes back into it',
  );
  assert.strictEqual(
    shapeOf('<html><p>a</p><body class="x"><p>b</p></body></html>'),
    'html(head() body(p(a) p(b)))',
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

test("an <html>, a <head> and a doctype inside the document are no nodes, as HTML's parser has them", () => {
  // WordPress saves a post through PHP's DOM, which writes a whole document
  // round it: on github.blog an `<html>` inside the article's column held
  // its blocks, and `.is-layout-constrained > *` reached none of them, so
  // a table's figure kept the 40px side margins Chrome's has taken away.
  // Chrome 154 builds each of these trees.
  const markup =
    '<!doctype html><html lang="en"><body class="a"><section>' +
    '<!DOCTYPE html PUBLIC "x"><html lang="fr" data-x="1">' +
    '<body class="b" id="i"><p>a</p><figure>f</figure></body></html>' +
    '<p>b</p></section></body></html>';
  assert.strictEqual(
    shapeOf(markup),
    '!doctype() html(head() body(section(p(a) figure(f) p(b))))',
  );
  // and their attributes go on the ones there are, where those have none
  const source = new HtmlSource();
  source.setSource(markup, true);
  type E = { name?: string; attribs?: Record<string, string>; children?: E[] };
  const html = (source.document.children as unknown as E[]).find(
    (n) => n.name === 'html',
  )!;
  const body = html.children!.find((n) => n.name === 'body')!;
  assert.deepStrictEqual(html.attribs, { lang: 'en', 'data-x': '1' });
  assert.deepStrictEqual(body.attribs, { class: 'a', id: 'i' });
  assert.strictEqual(
    shapeOf(
      '<!doctype html><html><head></head><body><div><head><title>t</title>' +
        '</head><p>a</p></div></body></html>',
    ),
    '!doctype() html(head() body(div(title(t) p(a))))',
    'a head once the head is behind it',
  );
  assert.strictEqual(
    shapeOf(
      '<!doctype html><html><body><div><html><p>a</p></div><p>b</p></body></html>',
    ),
    '!doctype() html(head() body(div(p(a)) p(b)))',
    'one never closed, closed with what holds it',
  );
});

test("a written <html> has the head HTML's parser implies, round the head content it starts with", () => {
  // Acid3 writes an `<html>` and no `<head>`, and styles its coloured
  // boxes through `:first-child + * .buckets p`: the body after the head
  assert.strictEqual(
    shapeOf(
      '<html><meta charset="x"><title>t</title><style>p{}</style>' +
        '<script>s</script><p>a</p></html>',
    ),
    'html(head(meta() title(t) style(p{}) script(s)) body(p(a)))',
  );
  assert.strictEqual(
    shapeOf('<html><head><title>t</title></head><body>b</body></html>'),
    'html(head(title(t)) body(b))',
    'a written one is the head',
  );
  assert.strictEqual(
    shapeOf('<html><body><p>a</p></body></html>'),
    'html(head() body(p(a)))',
    'and one is implied with nothing in it',
  );
  assert.strictEqual(
    shapeOf('<html><title>t</title></html>'),
    'html(head(title(t)))',
    'and closed with what holds it',
  );
  assert.strictEqual(
    shapeOf('<title>t</title><p>a</p>'),
    'title(t) p(a)',
    'a fragment is left as it was written',
  );
});

test("a source with a doctype is a document, its <html>, head and body written or implied as HTML's parser has them", () => {
  // WPT's tests start `<!doctype html><title>` and write none of the
  // three: `document.head` was null, `document.body` the first element,
  // and `:root` the `<title>` (HTML 13.2.6.4.1 to 13.2.6.4.6)
  assert.strictEqual(
    shapeOf('<!doctype html><title>t</title><script>s</script><div>d</div>'),
    '!doctype() html(head(title(t) script(s)) body(div(d)))',
  );
  assert.strictEqual(
    shapeOf('<!DOCTYPE html>text'),
    '!doctype() html(head() body(text))',
    'text opens the body too',
  );
  assert.strictEqual(
    shapeOf('<!doctype html>'),
    '!doctype() html(head() body())',
    'and an empty document has all three',
  );
  assert.strictEqual(
    shapeOf('<!doctype html><head><title>t</title></head><p>a</p>'),
    '!doctype() html(head(title(t)) body(p(a)))',
    'a written head is the head',
  );
  assert.strictEqual(
    shapeOf('<!doctype html><title>t</title><body class="x"><p>a</p></body>'),
    '!doctype() html(head(title(t)) body(p(a)))',
    'and a written body the body',
  );
  assert.strictEqual(
    shapeOf('<!doctype html><!-- c --><html lang="en"><p>a</p></html>'),
    '!doctype() c html(head() body(p(a)))',
    'and a written html the html, after a comment',
  );
  // a written html after the head content it implied is its attributes,
  // and what follows the head is the body's: WPT's long tests start
  // `<meta name="timeout" content="long"><html class="reftest-wait">`
  assert.strictEqual(
    shapeOf(
      '<!doctype html><meta name="t" content="long"><html class="w">' +
        '<title>t</title><div>d</div>',
    ),
    '!doctype() html(head(meta() title(t)) body(div(d)))',
    'and a written html after an implied one is no element',
  );
  assert.strictEqual(
    shapeOf(
      '<!doctype html><html><title>t</title><head><style></style></head>' +
        '<body><p>a</p></body></html>',
    ),
    '!doctype() html(head(title(t) style()) body(p(a)))',
    'and a written head after an implied one is no element, its end tag closing it',
  );
  assert.strictEqual(
    shapeOf(
      '<!doctype html><meta name="t"><html class="w"><div>d</div></body></html><p>b</p>',
    ),
    '!doctype() html(head(meta()) body(div(d) p(b)))',
    'and what comes after the end tags is the body',
  );
  // a source with no doctype is a fragment, as it always was
  assert.strictEqual(shapeOf('<title>t</title><p>a</p>'), 'title(t) p(a)');
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
  assert.strictEqual(shapeOf('<svg><tr><td></td></tr></svg>'), 'svg(tr(td()))');
});

/** What Chromium, Firefox and WebKit each make of `innerHTML` in a body
 *  (`DOMParser`), element by element: every row here is theirs. */
test('a start tag that ends foreign content closes it, and what comes after is HTML', () => {
  for (const [markup, shape] of [
    ['<svg><g><div><link></div></g></svg>', 'svg(g()) div(link())'],
    ['<svg><g><div></div><link></g></svg>', 'svg(g()) div() link()'],
    ['<svg><p>x</p><link></svg>', 'svg() p(x) link()'],
    ['<svg><g><meta><rect></rect></g></svg>', 'svg(g()) meta() rect()'],
    ['<svg><table><tr><td>x</table></svg>', 'svg() table(tbody(tr(td(x))))'],
    ['<svg><br><rect></rect></svg>', 'svg() br() rect()'],
    ['<svg><text>a<span>b</span>c</text></svg>', 'svg(text(a)) span(b) c'],
    ['<math><mrow><p>x</p></mrow></math>', 'math(mrow()) p(x)'],
    ['<p>a<svg><div>b</div></svg>', 'p(a svg()) div(b)'],
    // as far as the nearest integration point, and no further
    [
      '<svg><foreignObject><svg><div></div></svg></foreignObject></svg>',
      'svg(foreignObject(svg() div()))',
    ],
    // where it is HTML's already there is nothing to end
    [
      '<svg><foreignObject><div></div><rect></rect></foreignObject><rect></rect></svg>',
      'svg(foreignObject(div() rect()) rect())',
    ],
    [
      '<svg><title><b>x</b></title><rect></rect></svg>',
      'svg(title(b(x)) rect())',
    ],
    ['<math><mi><p>x</p></mi></math>', 'math(mi(p(x)))'],
    // and these are names foreign content may have
    ['<svg><a><font>x</font><tr></tr></a></svg>', 'svg(a(font(x) tr()))'],
  ]) {
    assert.strictEqual(shapeOf(markup), shape, markup);
  }
  // every name that does, and some a reading of the list would add
  for (const name of (
    'b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 ' +
    'h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small ' +
    'span strike strong sub sup table tt u ul var'
  ).split(' ')) {
    for (const root of ['svg', 'math']) {
      assert.ok(
        shapeOf(`<body><${root}><g><${name}>`).includes(`${root}(g())`),
        `<${name}> stayed in ${root}`,
      );
    }
  }
  for (const name of 'a dir font form input section tr'.split(' ')) {
    assert.ok(
      !shapeOf(`<body><svg><g><${name}>`).includes('svg(g())'),
      `<${name}> ended the drawing`,
    );
  }
});

const SVG = 'http://www.w3.org/2000/svg';
const MATHML = 'http://www.w3.org/1998/Math/MathML';

test('a <link> and a <base> are in the namespace HTML’s parser reads them in, and only an HTML one is the document’s', () => {
  // no walk up the tree says this: all three engines have a `<link>` a
  // script puts in a drawing as a sheet, and the parser's as no sheet
  const link = 'id="t" rel="stylesheet" href="s.css"';
  for (const [markup, namespace] of [
    [`<svg><link ${link}></svg>`, SVG],
    [`<svg><g><a><link ${link}></a></g></svg>`, SVG],
    [`<svg><foreignObject></foreignObject><link ${link}></svg>`, SVG],
    [
      `<svg><foreignObject><svg><link ${link}></svg></foreignObject></svg>`,
      SVG,
    ],
    [`<svg><foreignObject><link ${link}></foreignObject></svg>`, undefined],
    [
      `<svg><foreignObject><div><link ${link}></div></foreignObject></svg>`,
      undefined,
    ],
    [`<svg><title><link ${link}></title></svg>`, undefined],
    [`<svg><desc><link ${link}></desc></svg>`, undefined],
    // SVG's integration points are not MathML's, nor the other way round
    [`<svg><mi><link ${link}></mi></svg>`, SVG],
    [`<svg><annotation-xml encoding="text/html"><link ${link}></svg>`, SVG],
    [`<math><link ${link}></math>`, MATHML],
    [`<math><mrow><link ${link}></mrow></math>`, MATHML],
    [`<math><title><link ${link}></title></math>`, MATHML],
    [`<math><mi><link ${link}></mi></math>`, undefined],
    [`<math><mtext><link ${link}></mtext></math>`, undefined],
    [`<math><annotation-xml><link ${link}></annotation-xml></math>`, MATHML],
    [
      `<math><annotation-xml encoding="MathML-Content"><link ${link}></annotation-xml></math>`,
      MATHML,
    ],
    [
      `<math><annotation-xml encoding="TEXT/HTML"><link ${link}></annotation-xml></math>`,
      undefined,
    ],
    [
      `<math><annotation-xml encoding="application/xhtml+xml"><link ${link}></annotation-xml></math>`,
      undefined,
    ],
    // what ended the drawing leaves it behind
    [`<svg><p></p><link ${link}></svg>`, undefined],
    [`<svg><meta><link ${link}></svg>`, undefined],
    [`<link ${link}>`, undefined],
  ] as const) {
    const source = new HtmlSource();
    source.setSource(markup, true);
    const el = findById(source.document, 't')!;
    assert.strictEqual(el.namespace, namespace, markup);
    const { sheets, resources } = source.facts();
    const expected = namespace === undefined ? 1 : 0;
    assert.strictEqual(sheets.length, expected, `${markup}: its sheet`);
    assert.strictEqual(resources.length, expected, `${markup}: what is asked`);
  }
  const baseOf = (markup: string): string | null => {
    const source = new HtmlSource();
    source.setSource(markup, true);
    return source.facts().base;
  };
  assert.strictEqual(baseOf('<svg><g><base href="/b/"></g></svg>'), null);
  assert.strictEqual(baseOf('<math><base href="/b/"></math>'), null);
  assert.strictEqual(
    baseOf('<svg><foreignObject><base href="/b/"></foreignObject></svg>'),
    '/b/',
  );
  assert.strictEqual(
    baseOf('<svg><g><base href="/b/"></g></svg><base href="/c/">'),
    '/c/',
    'the first that is HTML’s',
  );
  // a `<style>` is SVG's as well, and stays a sheet
  const styled = new HtmlSource();
  styled.setSource('<svg><g><style>rect{fill:blue}</style></g></svg>', true);
  assert.strictEqual(styled.facts().sheets.length, 1);
  // and a preload of a sheet is a `<link>`'s to ask for as well
  const preload = new HtmlSource();
  preload.setSource(
    '<svg><link rel="preload" as="style" href="s.css"></svg>',
    true,
  );
  assert.strictEqual(preload.facts().resources.length, 0);
});

test('a name HTML has is in the namespace HTML’s parser reads it in, and the scan takes what is another language’s for no HTML element', () => {
  // every value here is what Chromium, Firefox and WebKit each answer
  const factsOf = (markup: string) => {
    const source = new HtmlSource();
    source.setSource(markup, true);
    return { source, facts: source.facts() };
  };
  const marked = (markup: string) =>
    findById(factsOf(markup).source.document, 't')!.namespace;
  const NAMES = [
    'title id="t"',
    'object id="t" data="o.png"',
    'input id="t" type="image" src="i.png"',
    'video id="t" poster="v.png"',
    'image id="t" src="m.png"',
  ];
  for (const name of NAMES) {
    const tag = `<${name}></${name.split(' ')[0]}>`;
    assert.strictEqual(marked(`<svg>${tag}</svg>`), SVG, tag);
    assert.strictEqual(marked(`<svg><g>${tag}</g></svg>`), SVG, tag);
    assert.strictEqual(marked(`<math>${tag}</math>`), MATHML, tag);
    assert.strictEqual(marked(`<math><mrow>${tag}</mrow></math>`), MATHML, tag);
    for (const html of [
      tag,
      `<svg><foreignObject>${tag}</foreignObject></svg>`,
      `<svg><desc>${tag}</desc></svg>`,
      `<math><mtext>${tag}</mtext></math>`,
      `<math><annotation-xml encoding="text/html">${tag}</annotation-xml></math>`,
    ]) {
      assert.strictEqual(marked(html), undefined, html);
    }
  }
  // SVG has both of these, so what says is MathML's alone
  for (const tag of ['<style id="t"></style>', '<script id="t"></script>']) {
    assert.strictEqual(marked(`<svg><g>${tag}</g></svg>`), undefined, tag);
    assert.strictEqual(marked(`<math>${tag}</math>`), MATHML, tag);
    assert.strictEqual(marked(`<math><mi>${tag}</mi></math>`), undefined, tag);
  }

  const titleOf = (markup: string) => factsOf(markup).facts.title;
  for (const [markup, title] of [
    ['<svg><title>drawn</title></svg>', null],
    ['<svg><g><title>drawn</title></g></svg>', null],
    ['<svg><title>drawn</title></svg><title>real</title>', 'real'],
    ['<title>real</title><svg><title>drawn</title></svg>', 'real'],
    ['<svg><desc><title>desc</title></desc></svg>', 'desc'],
    ['<svg><foreignObject><title>fo</title></foreignObject></svg>', 'fo'],
    ['<math><title>m</title></math>', null],
    ['<math><mtext><title>mt</title></mtext></math>', 'mt'],
    [
      '<math><annotation-xml encoding="text/html"><title>ax</title></annotation-xml></math>',
      'ax',
    ],
    ['<math><annotation-xml><title>ax</title></annotation-xml></math>', null],
  ] as const) {
    assert.strictEqual(titleOf(markup), title, markup);
  }

  const askedBy = (markup: string) =>
    factsOf(markup).facts.resources.map((el) => el.name);
  for (const asked of [
    '<object data="o.png"></object>',
    '<input type="image" src="i.png">',
    '<video poster="v.png"></video>',
  ]) {
    const name = /\w+/.exec(asked)![0];
    assert.deepStrictEqual(askedBy(`<svg>${asked}</svg>`), [], asked);
    assert.deepStrictEqual(askedBy(`<math>${asked}</math>`), [], asked);
    assert.deepStrictEqual(
      askedBy(`<svg><foreignObject>${asked}</foreignObject></svg>`),
      [name],
      asked,
    );
    assert.deepStrictEqual(askedBy(asked), [name], asked);
  }
  // an `<image>` is an `<img>` in HTML, a drawing's reads no `src`, and
  // MathML has none
  assert.deepStrictEqual(askedBy('<image src="m.png"></image>'), ['img']);
  assert.deepStrictEqual(askedBy('<svg><image src="m.png"></image></svg>'), []);
  assert.deepStrictEqual(
    askedBy('<math><image src="m.png"></image></math>'),
    [],
  );

  const sheetsIn = (markup: string) => factsOf(markup).facts.sheets.length;
  const scriptsIn = (markup: string) => factsOf(markup).facts.scripts.length;
  const STYLE = '<style>p{color:red}</style>';
  const SCRIPT = '<script>ran()</script>';
  assert.strictEqual(sheetsIn(`<math>${STYLE}</math>`), 0);
  assert.strictEqual(sheetsIn(`<svg>${STYLE}</svg>`), 1);
  assert.strictEqual(sheetsIn(`<math><mtext>${STYLE}</mtext></math>`), 1);
  assert.strictEqual(scriptsIn(`<math>${SCRIPT}</math>`), 0);
  assert.strictEqual(scriptsIn(`<svg>${SCRIPT}</svg>`), 1);
  assert.strictEqual(scriptsIn(`<math><mtext>${SCRIPT}</mtext></math>`), 1);
});

test('an <svg> in a <math> is MathML’s and what it holds with it, and the other way round, where a language’s own point takes it back to HTML', () => {
  // every value here is what Chromium, Firefox and WebKit each answer
  const factsOf = (markup: string) => {
    const source = new HtmlSource();
    source.setSource(markup, true);
    return source.facts();
  };
  const TITLE = '<title>x</title>';
  for (const [markup, title] of [
    [`<math><svg>${TITLE}</svg></math>`, null],
    [`<math><svg><foreignObject>${TITLE}</foreignObject></svg></math>`, null],
    [`<svg><math>${TITLE}</math></svg>`, null],
    [`<svg><math><mi>${TITLE}</mi></math></svg>`, null],
    // an `<annotation-xml>` takes an `<svg>` for one
    [
      `<math><annotation-xml><svg><foreignObject>${TITLE}</foreignObject></svg></annotation-xml></math>`,
      'x',
    ],
    [
      `<math><mtext><svg><foreignObject>${TITLE}</foreignObject></svg></mtext></math>`,
      'x',
    ],
    [
      `<svg><foreignObject><math><mi>${TITLE}</mi></math></foreignObject></svg>`,
      'x',
    ],
  ] as const) {
    assert.strictEqual(factsOf(markup).title, title, markup);
  }
  assert.strictEqual(
    factsOf('<math><svg><script>ran()</script></svg></math>').scripts.length,
    0,
    'a script in it does not run',
  );
  assert.strictEqual(
    factsOf('<math><annotation-xml><svg><script>ran()</script></svg>').scripts
      .length,
    1,
  );
});

test('the parse waits at no <script> a <math> holds, which no one runs, and at one a drawing holds', () => {
  const source = new HtmlSource();
  source.setSource(
    '<math><script id="m">a()</script></math><svg><script id="s">b()</script></svg>',
    true,
  );
  assert.strictEqual(
    blocksParser(findById(source.document, 'm')!, true),
    false,
  );
  assert.strictEqual(blocksParser(findById(source.document, 's')!, true), true);
});

test('what a script makes in a namespace is what it was made as, wherever it is put', () => {
  const source = new HtmlSource();
  source.setSource('<svg><g id="g"></g></svg><p id="p"></p>', true);
  const p = findById(source.document, 'p')!;
  const made = (name: string, namespace?: string) => {
    const el = createElement(name, { src: 'x.png', data: 'x.png' });
    if (namespace !== undefined) el.namespace = namespace;
    appendChild(p, el);
    source.touch();
    return el;
  };
  // SVG has a sheet and a script, as HTML has
  const drawnStyle = made('style', SVG);
  const drawnScript = made('script', SVG);
  assert.deepStrictEqual(
    source.facts().sheets.map((sheet) => sheet.element),
    [drawnStyle],
  );
  assert.deepStrictEqual(source.facts().scripts, [drawnScript]);
  // and a name is only a name in anything else, a language of none as much
  made('style', MATHML);
  made('script', MATHML);
  made('style', 'urn:other');
  made('script', '');
  assert.strictEqual(source.facts().sheets.length, 1);
  assert.strictEqual(source.facts().scripts.length, 1);
  made('object', SVG);
  made('embed', SVG);
  made('img', MATHML);
  made('title', SVG);
  assert.deepStrictEqual(source.facts().resources, []);
  assert.strictEqual(source.facts().title, null);
  // an application's own, with no namespace, is HTML's in a drawing too
  appendChild(findById(source.document, 'g')!, createElement('title'));
  source.touch();
  assert.strictEqual(source.facts().title, '');
});

test('what a drawing or a <math> holds asks onResource for nothing, and what a <foreignObject> holds does', async () => {
  const asked: string[] = [];
  await renderX11(
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, {
        source:
          '<svg width="10" height="10"><object data="a.png"></object>' +
          '<input type="image" src="b.png"><video poster="c.png"></video>' +
          '<foreignObject width="10" height="10">' +
          '<object data="d.png"></object></foreignObject></svg>' +
          '<math><object data="e.png"></object>' +
          '<input type="image" src="f.png"><video poster="g.png"></video>' +
          '<image src="h.png"></image></math>',
        partial: false,
        onResource: (r: { url: string }) => {
          asked.push(r.url);
          return null;
        },
      }),
    ),
    { backend: 'mock' },
  );
  assert.deepStrictEqual(asked.sort(), ['d.png']);
});

test('a form submits no <input> a drawing or a <math> holds', () => {
  // what Chromium, Firefox and WebKit each send
  const source = new HtmlSource();
  source.setSource(
    '<form id="f"><input name="a"><svg><input name="b"></svg>' +
      '<math><input name="c"></math>' +
      '<svg><foreignObject><input name="d"></foreignObject></svg></form>',
    true,
  );
  assert.deepStrictEqual(
    controlsOf(findById(source.document, 'f')!).map((el) => el.attribs.name),
    ['a', 'd'],
  );
});

test('a <link> an application puts in a drawing is a sheet, as a script’s is, and one it parsed in a drawing is not', () => {
  const source = new HtmlSource();
  source.setSource('<svg><g id="g"></g></svg><p id="p"></p>', true);
  const g = findById(source.document, 'g')!;
  const own = createElement('link', { rel: 'stylesheet', href: 'own.css' });
  appendChild(g, own);
  source.touch();
  assert.deepStrictEqual(
    source.facts().sheets.map((sheet) => sheet.element),
    [own],
  );
  const [drawing] = parseFragment(
    '<svg><link rel="stylesheet" href="parsed.css"></svg>',
  ) as Element[];
  const parsed = drawing.children[0] as Element;
  // what it was made as stays with it, wherever it goes and in each copy
  appendChild(findById(source.document, 'p')!, parsed);
  appendChild(findById(source.document, 'p')!, parsed.cloneNode() as Element);
  source.touch();
  assert.deepStrictEqual(
    source.facts().sheets.map((sheet) => sheet.element),
    [own],
  );
  // a `<base>` the same way
  const [other] = parseFragment('<svg><base href="/p/"></svg>') as Element[];
  appendChild(g, other.children[0] as Element);
  source.touch();
  assert.strictEqual(source.facts().base, null);
  appendChild(g, createElement('base', { href: '/own/' }));
  source.touch();
  assert.strictEqual(source.facts().base, '/own/');
});

test('a fragment is read as what its context holds', () => {
  const inNamespace = (name: string, namespace?: string): Element => {
    const el = createElement(name);
    if (namespace !== undefined) el.namespace = namespace;
    return el;
  };
  const [drawing] = parseFragment(
    '<svg><g id="g"><title id="t"></svg>',
  ) as Element[];
  const g = findById(drawing, 'g')!;
  const name = (nodes: ChildNode[]) =>
    nodes.map((node) => (node as Element).name).join(' ');
  // SVG's own rules, which read as HTML nested each `<path/>` in the last,
  // and folded what its names keep in capitals
  for (const context of [g, inNamespace('g', SVG), inNamespace('svg', SVG)]) {
    assert.strictEqual(
      name(parseFragment('<path/><path/><clipPath/>', false, context)),
      'path path clipPath',
    );
  }
  assert.strictEqual(
    (
      parseFragment(
        '<mi/><mo/>',
        false,
        inNamespace('math', MATHML),
      ) as Element[]
    ).length,
    2,
  );
  // what breaks out of the context is HTML's until it closes, and the
  // context is there again after it, in all three engines
  const shape = (nodes: ChildNode[]): string =>
    nodes
      .map((node) =>
        node.type === 'text'
          ? (node as unknown as { data: string }).data.trim()
          : `${(node as Element).name}(${shape((node as Element).children)})`,
      )
      .filter(Boolean)
      .join(' ');
  for (const [markup, expected] of [
    ['<div><span/>x</div><path/><path/>', 'div(span(x)) path() path()'],
    ['<br><path/><path/>', 'br() path() path()'],
    ['<p>a</p><clipPath/>b', 'p(a) clipPath() b'],
    ['<svg><div></div></svg><path/>', 'svg() div() path()'],
    ['<b/>x', 'b(x)'],
  ]) {
    assert.strictEqual(
      shape(parseFragment(markup, false, g)),
      expected,
      markup,
    );
  }
  // every row is what `innerHTML` makes of `<link id=a><div id=b><link
  // id=c></div><a><link id=d></a>` in all three engines
  for (const [context, a, c, d] of [
    [g, SVG, undefined, SVG],
    [inNamespace('g', SVG), SVG, undefined, SVG],
    [inNamespace('svg', SVG), SVG, undefined, SVG],
    [findById(drawing, 't')!, undefined, undefined, undefined],
    [inNamespace('foreignObject', SVG), undefined, undefined, undefined],
    [inNamespace('title', SVG), undefined, undefined, undefined],
    [inNamespace('math', MATHML), MATHML, undefined, MATHML],
    [inNamespace('mrow', MATHML), MATHML, undefined, MATHML],
    [inNamespace('mi', MATHML), undefined, undefined, undefined],
    [createElement('div'), undefined, undefined, undefined],
    [createElement('g'), undefined, undefined, undefined],
    [null, undefined, undefined, undefined],
  ] as const) {
    const held = parseFragment(
      '<link id="a"><div id="b"><link id="c"></div><a><link id="d"></a>',
      false,
      context,
    );
    const holder = createElement('div', {}, held);
    const made = (id: string) => findById(holder, id)!.namespace;
    const named = context?.name ?? 'no context';
    assert.strictEqual(made('a'), a, `<link> in ${named}`);
    assert.strictEqual(made('b'), undefined, `<div> in ${named}`);
    assert.strictEqual(made('c'), c, `<link> in a <div> in ${named}`);
    assert.strictEqual(made('d'), d, `<link> after a <div> in ${named}`);
  }
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
