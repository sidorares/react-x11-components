// A document served as XML, read by XML's rules: `<Html contentType>`. The
// reading itself is held here to what HTML's parser does with the same bytes,
// since each of these reads otherwise there, and what a document's scripts do
// is held to what HTML 13.4 has an XML parser do with them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as DomUtils from 'domutils';
import React from 'react';
import { act, renderX11 } from 'react-x11/test';

import {
  Html,
  isXmlType,
  sniffEncoding,
  sniffXmlEncoding,
  useHtmlHandle,
} from '../../src/html/index.js';
import type { HtmlHandle, ResourceResult } from '../../src/html/index.js';
import { xmlTree } from '../../src/html/dom.js';
import { readProlog } from '../../src/html/xml-prolog.js';
import { drawsItself, kindOf } from '../../examples/browser/documents.js';

import {
  FONTS,
  PAGE,
  boxOf,
  metric,
  pixelsIn,
  render,
  view,
} from './harness.js';

const h = React.createElement;

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const STRICT =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">';

/** An XHTML document of a body and a sheet. */
const page = (body: string, css = '') =>
  `<?xml version="1.0"?><html xmlns="${XHTML}"><head><title>t</title><style>${css}</style></head><body>${body}</body></html>`;

/** The `display` an element came to. */
const displayOf = (el: ReturnType<typeof view>, id: string): string =>
  (boxOf(el, id) as unknown as { style: { display: string } }).style.display;

const xhtml = (source: string, width = 400) =>
  render(source, width, { contentType: 'application/xhtml+xml' });

/** What the document holds, as tag names around its text, outermost first. */
function shape(node: unknown): string {
  const n = node as {
    name?: string;
    data?: string;
    children?: unknown[];
    type: string;
  };
  if (n.type === 'text') return (n.data ?? '').trim();
  const inner = (n.children ?? []).map(shape).filter(Boolean).join(' ');
  return n.name ? `(${n.name}${inner ? ` ${inner}` : ''})` : inner;
}

async function treeOf(source: string, contentType?: string): Promise<string> {
  const { node } = await render(source, 400, { contentType });
  return shape(view(node).document);
}

test('a document served as XML keeps what HTML parsing moves or drops', async () => {
  const flex = `<div xmlns="${XHTML}"><td>cell</td><p><div>in</div></p></div>`;
  assert.equal(
    await treeOf(flex, 'application/xhtml+xml'),
    '(div (td cell) (p (div in)))',
  );
  // nothing of it as HTML: the cell dropped, the paragraph closed by a block
  assert.notEqual(await treeOf(flex), '(div (td cell) (p (div in)))');
  // no tbody, head or body is implied
  assert.equal(
    await treeOf(
      `<html xmlns="${XHTML}"><table><tr><td>a</td></tr></table></html>`,
      'application/xhtml+xml',
    ),
    '(html (table (tr (td a))))',
  );
});

test("a drawing's <metadata> holds a <meta>, and a self-closed element is closed", async () => {
  const drawing = `<svg xmlns="${SVG}"><metadata><meta name="a"/></metadata><g/><rect/></svg>`;
  assert.equal(
    await treeOf(drawing, 'image/svg+xml'),
    '(svg (metadata (meta)) (g) (rect))',
  );
});

test('a style sheet is what XML reads in one', async () => {
  const { node } = await xhtml(
    page(
      '<div id="a"><span id="b">x</span></div>',
      'div &gt; span { display: block; height: 10px }<![CDATA[ div > span { width: 20px } ]]>',
    ),
  );
  const box = boxOf(view(node), 'b');
  assert.equal(box.height, 10, 'an entity outside a CDATA section is read');
  assert.equal(box.width, 20, 'and a CDATA section is text');
});

test("what a comment holds in a <style> is no style sheet, as it is in HTML's", async () => {
  const body = '<div id="a">x</div>';
  const css = '<!-- #a { height: 30px } -->';
  const xml = await xhtml(page(body, css));
  assert.notEqual(boxOf(view(xml.node), 'a').height, 30);
  const html = await render(`<!doctype html><style>${css}</style>${body}`, 400);
  assert.equal(boxOf(view(html.node), 'a').height, 30);
});

test('names have their case in an XML document', async () => {
  const { node } = await xhtml(
    page(
      '<div id="a">x</div><DIV id="b">y</DIV><div id="c" data-Up="1">z</div>',
      'DIV { height: 20px } [data-up] { width: 7px } [data-Up] { height: 9px }',
    ),
  );
  const el = view(node);
  // the selector's `DIV` is the name its element has, and no other
  assert.notEqual(boxOf(el, 'a').height, 20);
  assert.equal(boxOf(el, 'c').height, 9);
  assert.notEqual(boxOf(el, 'c').width, 7);
  // and an element named `DIV` is no `<div>`: the user agent's sheet says
  // nothing of it, and it is an inline box
  assert.equal(displayOf(el, 'b'), 'inline');
  const html = await render(
    `<!doctype html><style>DIV { height: 20px }</style><div id="a">x</div>`,
  );
  assert.equal(boxOf(view(html.node), 'a').height, 20);
});

test('only what is in a language the user agent knows has its look', async () => {
  const { node } = await render(
    `<root><div id="a">in no namespace</div><div xmlns="${XHTML}" id="b">in HTML's</div><h:div xmlns:h="${XHTML}" id="c">under a prefix</h:div></root>`,
    400,
    { contentType: 'application/xml' },
  );
  const el = view(node);
  assert.equal(displayOf(el, 'a'), 'inline');
  assert.equal(displayOf(el, 'b'), 'block');
  assert.equal(displayOf(el, 'c'), 'block');
});

test("an XML document's root element is whatever it says, and takes what a root takes", async () => {
  const { node } = await render(
    `<?xml version="1.0"?><root id="r" style="display: inline; background-color: #123456; font-size: 30px"><item id="i" style="display: block; width: 1rem">x</item></root>`,
    400,
    { contentType: 'text/xml' },
  );
  const el = view(node);
  assert.equal(displayOf(el, 'r'), 'block', 'a root is blockified');
  assert.equal(boxOf(el, 'i').width, 30, 'a rem is of it');
  assert.equal(boxOf(el, 'r').x, 0, 'and nothing implied a margin around it');
});

test('a drawing at the top is its own document, with no body around it', async () => {
  const { node } = await render(
    `<svg xmlns="${SVG}" id="s" width="100" height="50"><rect width="100" height="50" fill="green"/></svg>`,
    400,
    { contentType: 'image/svg+xml' },
  );
  const box = boxOf(view(node), 's');
  assert.equal(box.x, 0);
  assert.equal(box.y, 0);
  assert.equal(box.width, 100);
});

/** A drawing that is its document, in a window of 300 by 300 as `Html`'s box:
 *  whether each point of it came out green. */
async function greenAt(
  source: string,
  points: [number, number][],
): Promise<boolean[]> {
  const result = await renderX11(
    h(
      'box',
      { style: { width: 300, height: 300, flexDirection: 'column' } },
      h(Html, {
        source,
        contentType: 'image/svg+xml',
        style: { flexGrow: 1 },
      }),
    ),
    { width: 300, height: 300, fonts: FONTS! },
  );
  return Promise.all(
    points.map(async ([x, y]) => {
      const [r, g, b] = await pixelsIn(result.ctx, {
        x,
        y,
        width: 1,
        height: 1,
      });
      return r === 0 && g === 128 && b === 0;
    }),
  );
}

metric('a drawing that says no size fills its window', async () => {
  const [inside, past] = await greenAt(
    `<svg xmlns="${SVG}"><rect width="300" height="300" fill="green"/></svg>`,
    [
      [290, 10],
      [10, 290],
    ],
  );
  assert.equal(inside, true, 'wider than a replaced default of 300 is not');
  assert.equal(past, true, 'and taller than 150');
});

metric('what a clip draws through reaches as far as the window', async () => {
  // two parts in the clip are more than a context's clip can say, so it is
  // drawn through a surface, which is as large as the viewport it is handed
  const [high, low] = await greenAt(
    `<svg xmlns="${SVG}"><clipPath id="c"><rect width="50" height="50"/><rect y="200" width="50" height="50"/></clipPath><rect width="100" height="300" fill="green" clip-path="url(#c)"/></svg>`,
    [
      [10, 10],
      [10, 220],
    ],
  );
  assert.equal(high, true);
  assert.equal(low, true, 'and not as far as a viewport of 300 by 150');
});

metric(
  'a drawing at the top is cut to its box, as an overflow says of none',
  async () => {
    const [inside, past] = await greenAt(
      `<svg xmlns="${SVG}" width="100" height="100"><rect width="300" height="100" fill="green"/></svg>`,
      [
        [90, 10],
        [150, 10],
      ],
    );
    assert.equal(inside, true);
    assert.equal(past, false);
  },
);

test('a name nothing declared is well-formed only under a DTD that stands for HTML', () => {
  const named = `<html xmlns="${XHTML}"><body>a&nbsp;b&eacute;</body></html>`;
  assert.equal(xmlTree(named).wellFormed, false);
  const read = xmlTree(`${STRICT}${named}`);
  assert.equal(read.wellFormed, true);
  assert.match(shape({ type: 'root', children: read.kids }), /a bé/);
  // not in a comment, which is no text to read one in
  assert.match(
    readProlog(`${STRICT}<html xmlns="${XHTML}"><!-- &nbsp; --></html>`).text,
    /<!-- &nbsp; -->/,
  );
});

test('an attribute value may say the same thing twice', () => {
  assert.equal(
    xmlTree(`<a b="c = 1, c = 2, c = 3" d="e"/>`).wellFormed,
    true,
    'a value is no name',
  );
  assert.equal(xmlTree(`<a b="1" b="2"/>`).wellFormed, false);
});

test('a document that is not well-formed is the error and nothing of it', async () => {
  const { node } = await xhtml(
    `<html xmlns="${XHTML}"><body><p id="p">kept?</b></body></html>`,
  );
  const text = shape(view(node).document);
  assert.match(text, /XML Parsing Error/);
  assert.doesNotMatch(text, /kept/);
});

test('an XML document is read once all of it is here', async () => {
  const source = `<root xmlns="${XHTML}"><p>x</p></root>`;
  const handle = React.createRef<HtmlHandle | null>();
  let doc: unknown = null;
  function Page({ partial }: { partial: boolean }) {
    const held = useHtmlHandle();
    (handle as { current: HtmlHandle | null }).current = held;
    return h(Html, {
      ref: held.ref,
      source,
      contentType: 'application/xml',
      partial,
      onDocument: (d: unknown) => (doc = d),
    });
  }
  const result = await renderX11(
    h(Page, { partial: true }),
    FONTS ? { width: 200, height: 100, fonts: FONTS } : { backend: 'mock' },
  );
  assert.equal(shape(handle.current!.document), '');
  await result.rerender(h(Page, { partial: false }));
  await act(async () => {});
  assert.equal(shape(handle.current!.document), '(root (p x))');
  assert.ok(doc);
});

test('one <Html> handed XML after HTML matches names as the new document has them', async () => {
  const sheet = 'DIV { height: 20px }';
  const source = `<html xmlns="${XHTML}"><head><style>${sheet}</style></head><body><div id="a">x</div></body></html>`;
  const handle = React.createRef<ReturnType<typeof useHtmlHandle> | null>();
  function Page({ contentType }: { contentType?: string }) {
    const held = useHtmlHandle();
    (handle as { current: typeof held | null }).current = held;
    return h(Html, { ref: held.ref, source, contentType, partial: false });
  }
  const result = await renderX11(
    h(Page, {}),
    FONTS ? { width: 200, height: 100, fonts: FONTS } : { backend: 'mock' },
  );
  const heightOf = () => {
    const a = DomUtils.findOne(
      (el) => el.attribs.id === 'a',
      handle.current!.document!.children,
    );
    return handle.current!.computedStyle(a!)?.height;
  };
  assert.equal(heightOf(), '20px');
  await result.rerender(h(Page, { contentType: 'application/xhtml+xml' }));
  await act(async () => {});
  assert.notEqual(heightOf(), '20px');
});

test('a type says XML however it is written', () => {
  for (const type of [
    'application/xhtml+xml',
    'APPLICATION/XML; charset=utf-8',
    'text/xml',
    'image/svg+xml',
    'application/atom+xml',
  ]) {
    assert.equal(isXmlType(type), true, type);
  }
  for (const type of ['text/html', 'text/plain', 'application/json']) {
    assert.equal(isXmlType(type), false, type);
  }
});

test("an XML document's encoding is in its declaration, and a <meta> says nothing", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  assert.equal(
    sniffXmlEncoding(bytes('<?xml version="1.0" encoding="ISO-8859-2"?><a/>')),
    'ISO-8859-2',
  );
  assert.equal(
    sniffXmlEncoding(bytes('<a><meta charset="koi8-r"/></a>')),
    'UTF-8',
  );
  assert.equal(sniffEncoding(bytes('<meta charset="koi8-r">')), 'KOI8-R');
});

test('the browser shows a page served as XHTML or a drawing as a document', () => {
  assert.equal(kindOf('application/xhtml+xml', PAGE), 'html');
  assert.equal(kindOf('image/svg+xml', PAGE), 'html');
  assert.equal(kindOf('application/xml', PAGE), 'xml');
  // and XML that says how it looks, where the rest goes to the tree viewer
  assert.equal(drawsItself(`<a xmlns="${XHTML}"/>`), true);
  assert.equal(drawsItself(`<s:a xmlns:s="${SVG}"/>`), true);
  assert.equal(drawsItself('<?xml-stylesheet href="a.css"?><a/>'), true);
  assert.equal(drawsItself('<a xmlns="urn:b"><c/></a>'), false);
});

/** An XML document whose scripts run: what they log, in order, once a line
 *  starting with `end` has come or `ms` have gone. */
async function run(
  source: string,
  contentType = 'application/xhtml+xml',
  scripts: Record<string, string> = {},
  ms = 1500,
): Promise<string[]> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source,
      contentType,
      baseUrl: PAGE,
      onResource: ({ url, kind }: { url: string; kind: string }) => {
        const name = url.slice(url.lastIndexOf('/') + 1);
        return kind === 'script' && scripts[name] !== undefined
          ? { kind: 'script' as const, text: scripts[name] }
          : null;
      },
      scripts: {
        log: (_level: string, text: string) => void logs.push(text),
      },
    }),
    FONTS
      ? { width: 200, height: 120, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  const end = Date.now() + ms;
  while (Date.now() < end && !logs.some((l) => l.startsWith('end'))) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  return logs;
}

const ran = (name: string) =>
  `console.log('${name}', !!document.getElementById('before'), !!document.getElementById('after'));`;

test('a script in an XML document runs where the parser met it', async () => {
  const logs = await run(
    `<?xml version="1.0"?>
<html xmlns="${XHTML}"><head><title>t</title>
<script><![CDATA[${ran('head')}]]></script></head>
<body><p id="before"/>
<script src="one.js"/>
<script>${ran('inline')}</script>
<p id="after"/>
<script defer="defer" src="two.js"/>
<script>addEventListener('DOMContentLoaded', () => console.log('ready'));
addEventListener('load', () => console.log('end'));</script>
</body></html>`,
    'application/xhtml+xml',
    { 'one.js': ran('one'), 'two.js': ran('deferred') },
  );
  assert.deepEqual(logs, [
    'head false false',
    'one true false',
    'inline true false',
    'deferred true true',
    'ready',
    'end',
  ]);
});

test('a drawing at the top runs its scripts, by `href` where it names one', async () => {
  const logs = await run(
    `<svg xmlns="${SVG}" xmlns:xlink="http://www.w3.org/1999/xlink">
<script>console.log(document.documentElement.localName, document.contentType, document.body === null);</script>
<script href="a.js"/><script xlink:href="b.js"/>
<script>console.log('end');</script></svg>`,
    'image/svg+xml',
    { 'a.js': "console.log('a')", 'b.js': "console.log('b')" },
  );
  assert.deepEqual(logs, ['svg image/svg+xml true', 'a', 'b', 'end']);
});

test('only what is HTML or SVG is a script, and none runs in a document that is not well-formed', async () => {
  assert.deepEqual(
    await run(
      `<root><script>console.log('no namespace');</script><m:script xmlns:m="http://www.w3.org/1998/Math/MathML">console.log('MathML');</m:script><h:script xmlns:h="${XHTML}">console.log('end');</h:script></root>`,
      'application/xml',
    ),
    ['end'],
  );
  assert.deepEqual(
    await run(
      `<html xmlns="${XHTML}"><script>console.log('ran');</script><b></i></html>`,
      'application/xhtml+xml',
      {},
      150,
    ),
    [],
  );
});

test('a page sees an XML document in what its API answers', async () => {
  const logs = await run(
    `<html xmlns="${XHTML}"><body><script><![CDATA[
const made = document.createElement('DIV');
let wrote = 'wrote';
try { document.write('x'); } catch (e) { wrote = e.name; }
console.log(made.localName, made.namespaceURI, made.tagName);
console.log(document.documentElement.tagName, wrote, document.compatMode);
console.log(matchMedia('all').matches, document.querySelector('BODY'), !!document.querySelector('body'));
document.body.innerHTML = '<b>a<br/>b</b>';
const b = document.body.firstChild;
console.log(b.localName, b.namespaceURI, b.childNodes.length, document.body.innerHTML);
try { document.body.innerHTML = '<p>open'; } catch (e) { console.log(e.name); }
console.log('end');
]]></script></body></html>`,
  );
  assert.deepEqual(logs, [
    `DIV ${XHTML} DIV`,
    'html InvalidStateError CSS1Compat',
    'true null true',
    `b ${XHTML} 3 <b xmlns="${XHTML}">a<br />b</b>`,
    'SyntaxError',
    'end',
  ]);
});

test('a style sheet an instruction links holds the scripts after it, and applies', async () => {
  const sheet = 'html { z-index: 3 }';
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source: `<?xml version="1.0"?><?xml-stylesheet type="text/css" href="a.css"?><html xmlns="${XHTML}"><head><script><![CDATA[
console.log(getComputedStyle(document.documentElement).zIndex, document.styleSheets.length);
console.log('end');
]]></script></head></html>`,
      contentType: 'application/xhtml+xml',
      baseUrl: PAGE,
      onResource: ({ url }: { url: string }) =>
        new Promise<ResourceResult | null>((done) =>
          setTimeout(
            () =>
              done(
                url.endsWith('a.css')
                  ? { kind: 'stylesheet' as const, text: sheet }
                  : null,
              ),
            40,
          ),
        ),
      scripts: {
        log: (_level: string, text: string) => void logs.push(text),
      },
    }),
    FONTS
      ? { width: 200, height: 120, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  const end = Date.now() + 1500;
  while (Date.now() < end && !logs.includes('end')) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.deepEqual(logs, ['3 1', 'end']);
});
