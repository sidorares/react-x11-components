// A sheet's `@namespace` rules and the selectors that name them, and a page's
// own queries with a bar in them (CSS Namespaces 3; Selectors 4, 5 and 6.1).
// Every answer in a table here is what Chromium, Firefox and WebKit all come
// to, asked of these same documents with `getComputedStyle`, unless a case
// says otherwise.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, waitFor } from 'react-x11/test';

import { shadowRootOf } from '../../src/html/index.js';
import type { Element, HtmlViewNode } from '../../src/html/index.js';
import { parseStylesheet } from '../../src/html/css/parse.js';

import {
  findById,
  metric,
  pixelsIn,
  pointIn,
  render,
  scriptedPage,
  view,
} from './harness.js';

afterEach(cleanup);

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const MATH = 'http://www.w3.org/1998/Math/MathML';
const XLINK = 'http://www.w3.org/1999/xlink';

/** The prefixes each case below can name. `u` is declared by none. */
const PREFIXES = `@namespace h "${XHTML}";@namespace s "${SVG}";@namespace m "${MATH}";@namespace x "${XLINK}";@namespace f "urn:foo";`;

/** An HTML document with each of the languages this draws in it. */
const HTML_DOCUMENT =
  '<div id=d class=c title=t lang=en><svg id=s class=c xlink:href=a foo:bar=b viewBox="0 0 1 1"><g id=g class=c><rect id=r class=c xlink:title=q></rect><a id=sa class=c xlink:href=a></a><foreignObject id=fo class=c><p id=p class=c></p><p id=p2 class=c></p></foreignObject></g></svg><math id=m class=c><mi id=mi class=c>x</mi></math><span id=sp class=c foo:bar=b xlink:href=a></span></div>';

/** An XHTML document with elements of one name in four namespaces. */
const XML_DOCUMENT = `<html xmlns="${XHTML}" xmlns:xl="${XLINK}" xmlns:foo="urn:foo" xmlns:html="${XHTML}"><head><title>t</title><style>STYLE</style></head><body><div id="d" class="c" title="t"><svg xmlns="${SVG}" id="s" class="c" xl:href="a" foo:bar="b" viewBox="0 0 1 1"><g id="g" class="c"><rect id="r" class="c" xl:title="q"/></g></svg><p xmlns="" id="nn" class="c" title="x"/><foo:p id="fp" class="c" foo:title="v" title="w"/><html:p id="hp" class="c"/><p id="p" class="c"/><p id="p2" class="c" foo:bar="B"/><P id="up" class="c" TITLE="x"/><html:div id="hd" class="c"><foo:div id="fd" class="c"/></html:div></div></body></html>`;

/** The ids of the elements a rule reached, as `order: 7` says. */
function reached(el: HtmlViewNode): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly unknown[]): void => {
    for (const node of nodes as Element[]) {
      if (node.attribs === undefined) continue;
      const id = node.attribs.id;
      if (id !== undefined && el.computedStyle(node)?.order === '7')
        out.push(id);
      walk(node.children);
    }
  };
  walk(el.document.children);
  return out;
}

/** What `selector` reaches of a document, under a sheet that declares
 *  `PREFIXES` after the default namespace `fallback`. */
async function reachedBy(
  selector: string,
  xml: boolean,
  fallback: string | null,
): Promise<string[]> {
  const sheet = `${fallback === null ? '' : `@namespace "${fallback}";`}${PREFIXES}${selector} { order: 7 }`;
  const { result, node } = await render(
    xml
      ? XML_DOCUMENT.replace('STYLE', sheet.replaceAll('&', '&amp;'))
      : `<style>${sheet}</style>${HTML_DOCUMENT}`,
    400,
    xml ? { contentType: 'application/xhtml+xml' } : {},
  );
  await act();
  const hits = reached(view(node));
  result.unmount();
  return hits;
}

const every = (list: string) => list.split(' ').filter(Boolean);

const IN_HTML: readonly (readonly [string, string])[] = [
  ['h|div', 'd'],
  ['s|div', ''],
  ['|div', ''],
  ['s|rect', 'r'],
  ['h|rect', ''],
  ['*|rect', 'r'],
  ['s|*', 's g r sa fo'],
  ['m|*', 'm mi'],
  ['|*', ''],
  ['h|p', 'p p2'],
  ['*|p', 'p p2'],
  ['s|g > *|*', 'r sa fo'],
  ['s|foreignObject h|p', 'p p2'],
  ['h|div s|rect', 'r'],
  ['s|svg.c#s', 's'],
  // a prefix nothing declares makes the selector none, and the rule goes
  ['u|*', ''],
  [':not(u|div)', ''],
  ['s|rect, u|div', ''],
  // but an `:is()` forgives it
  [':is(u|div)', ''],
  ['s|*:is(u|div, rect)', 'r'],
  [':where(s|rect)', 'r'],
  ['*|*:has(s|rect)', 'd s g'],
  ['*|*:nth-child(1 of s|*)', 's g r'],
  ['[|title]', 'd'],
  ['[*|title]', 'd r'],
  ['[f|title]', ''],
  ['[u|title]', ''],
  ['[*|href]', 's sa'],
  ['[x|href]', 's sa'],
  ['[x|href=a]', 's sa'],
  ['[x|title=q]', 'r'],
  // no prefix of the HTML parser's but those it adjusts is one, and on an
  // HTML element none is
  ['[*|bar]', ''],
  ['[f|bar]', ''],
  ['[|xlink\\:href]', 'sp'],
  ['[*|viewBox]', 's'],
  ['*|*:not([*|href])', 'd g r fo p p2 m mi sp'],
];

test('a namespaced selector reaches what all three engines say in an HTML document', async () => {
  for (const [selector, ids] of IN_HTML) {
    assert.deepEqual(
      await reachedBy(selector, false, null),
      every(ids),
      selector,
    );
  }
});

const IN_XML: readonly (readonly [string, string])[] = [
  ['h|div', 'd hd'],
  ['s|rect', 'r'],
  ['s|*', 's g r'],
  ['|*', 'nn'],
  ['p', 'nn fp hp p p2'],
  ['*|p', 'nn fp hp p p2'],
  ['h|p', 'hp p p2'],
  ['f|p', 'fp'],
  ['|p', 'nn'],
  // a name has its case
  ['h|P', 'up'],
  ['*|P', 'up'],
  ['f|div', 'fd'],
  ['h|div > f|div', 'fd'],
  ['[|title]', 'd nn fp'],
  ['[f|title]', 'fp'],
  // any of the attributes of the name, and not the first
  ['[*|title=w]', 'fp'],
  ['[*|title=v]', 'fp'],
  ['[|title=v]', ''],
  ['[x|href]', 's'],
  ['[*|href]', 's'],
  ['[*|bar]', 's p2'],
  ['[f|bar=B]', 'p2'],
  ['[f|bar=b i]', 's p2'],
  ['[*|TITLE]', 'up'],
];

test('a namespaced selector reaches what all three engines say in an XML document', async () => {
  for (const [selector, ids] of IN_XML) {
    assert.deepEqual(
      await reachedBy(selector, true, null),
      every(ids),
      selector,
    );
  }
});

const UNDER_XHTML: readonly (readonly [string, string])[] = [
  // a compound with no prefix is of the default namespace, type or none
  ['.c', 'd p p2 sp'],
  ['rect', ''],
  ['*|rect', 'r'],
  ['*', 'd p p2 sp'],
  ['#s', ''],
  ['*|*#s', 's'],
  // and in a selector with no type in its subject, not there: an `:is()`'s,
  // a `:not()`'s and a `:has()`'s subject says its own, but for what it names
  ['*|*:not(.c)', ''],
  ['*|*:not(div)', 's g r sa fo p p2 m mi sp'],
  ['*|*:is(.c .c)', 's g r sa fo p p2 m mi sp'],
  // the rest of it is of the default namespace: Chromium and WebKit, and
  // WPT's is-default-ns-003, where Firefox lets all of it go
  ['*|*:is(#g .c)', ''],
  ['*|*:has(.c)', 'd s g fo m'],
  ['*|*:has(rect)', ''],
  // no attribute is of it
  ['[|title]', 'd'],
  ['[x|href]', ''],
  ['s|*[x|href]', 's sa'],
];

test('a default namespace is every compound’s, and stops at the subject of an :is(), a :not() and a :has()', async () => {
  for (const [selector, ids] of UNDER_XHTML) {
    const hits = await reachedBy(selector, false, XHTML);
    assert.deepEqual(hits, every(ids), selector);
  }
});

test('a name of one type in an XML document is of its namespace, and :first-of-type counts by both', async () => {
  // `<p>` and `<html:p>` are one type, and the others one each
  const sheet = `*|*:first-of-type { order: 7 }`;
  const { node } = await render(
    `<html xmlns="${XHTML}" xmlns:html="${XHTML}" xmlns:o="urn:o"><head><style>${sheet}</style></head><body id="b"><p id="a"/><html:p id="b2"/><o:p id="c"/><p xmlns="" id="d"/><p id="e"/></body></html>`,
    400,
    { contentType: 'application/xhtml+xml' },
  );
  await act();
  assert.deepEqual(reached(view(node)), every('b a c d'));
});

test('two elements of one tag in two namespaces share no style', async () => {
  // alike in every attribute, which is what a sharing key is otherwise made of
  const { node } = await render(
    `<html xmlns="${XHTML}" xmlns:html="${XHTML}" xmlns:svg="${SVG}"><head><style>@namespace h "${XHTML}"; h|p { order: 7 }</style></head><body><html:p/><svg:p/></body></html>`,
    400,
    { contentType: 'application/xhtml+xml' },
  );
  await act();
  const el = view(node);
  const body = el.document.children
    .flatMap((n) => (n as Element).children ?? [])
    .find((n) => (n as Element).name === 'body') as Element;
  assert.deepEqual(
    body.children.map((n) => el.computedStyle(n as Element)?.order),
    ['7', '0'],
  );
});

test('a name with a capital is SVG’s in an HTML document, as a selector writes it', async () => {
  const { node } = await render(
    `<style>@namespace s "${SVG}"; s|linearGradient { order: 7 } foreignObject { order: 7 }</style><svg><linearGradient id="l"></linearGradient><foreignObject id="o"></foreignObject></svg>`,
  );
  await act();
  assert.deepEqual(reached(view(node)), ['l', 'o']);
});

test('a namespace is worth what its type is, and a default namespace nothing', () => {
  const { rules } = parseStylesheet(
    `@namespace s "${SVG}";@namespace "${XHTML}";s|rect{order:1} *|*{order:1} .c{order:1} |p{order:1} s|*.c{order:1} p{order:1} [s|a]{order:1}`,
  );
  assert.deepEqual(
    rules.map((rule) => rule.specificity),
    [1, 0, 1_000, 1, 1_000, 1, 1_000],
  );
});

test('@namespace takes its name and its URL with escapes, its last word on a prefix, and no place after a rule', async () => {
  for (const [sheet, ids] of [
    // the URL function by another spelling, and a prefix by one
    [`@namespace u\\00072l("${XHTML}");div{order:7}`, 'd'],
    [`@namespace u\\00072l("urn:o");div{order:7}`, ''],
    [`@namespace \\68 "${XHTML}";\\68|div{order:7}`, 'd'],
    [`@namespace h "${SVG}";@namespace h "${XHTML}";h|div{order:7}`, 'd'],
    [`@namespace "${SVG}";@namespace "${XHTML}";div{order:7}`, 'd'],
    // a URL is compared as it is written
    [`@namespace "${XHTML}/";div{order:7}`, ''],
    // and one in no place is none, so its prefix is declared by nothing
    [`p{order:1}@namespace h "${XHTML}";h|div{order:7}`, ''],
    [`@media all{@namespace h "${XHTML}";h|div{order:7}}`, ''],
    [`@namespace h "${XHTML}" x;h|div{order:7}`, ''],
    [`@namespace url "${XHTML}";url|div{order:7}`, 'd'],
    // what is nested goes with a rule that is none
    [`u|div{order:7;& p{order:7}}`, ''],
    [`#d, u|div{& p{order:7}}`, ''],
    [`#d{order:7;& u|p{order:7}}`, 'd'],
    // a rule that is none is no rule, so an @namespace still has its place
    [`u|div{order:1}@namespace h "${XHTML}";h|div{order:7}`, 'd'],
    [`@namespace h "${XHTML}";h|div{& p{order:7}}`, 'p'],
    [`@namespace h "${XHTML}";div{& h|p{order:7}}`, 'p'],
  ] as const) {
    const { result, node } = await render(
      `<style>${sheet}</style><div id="d"><p id="p"></p></div>`,
    );
    await act();
    assert.deepEqual(reached(view(node)), every(ids), sheet);
    result.unmount();
  }
});

test('a shadow tree’s host says no namespace of its own, and what a function holds does', async () => {
  const hits = async (sheet: string): Promise<string[]> => {
    const { result, node } = await render(
      `<div id="host" class="on"><template shadowrootmode="open"><style>${sheet}{order:7}</style><slot id="sl"></slot><i id="in" class="in"></i></template><p id="light" class="k"></p></div>`,
    );
    await act();
    const el = view(node);
    const host = findById(el.document, 'host')!;
    const tree = shadowRootOf(host)!;
    const hit = [host, ...host.children, ...tree.children]
      .filter((n) => (n as Element).attribs?.id)
      .filter((n) => el.computedStyle(n as Element)?.order === '7')
      .map((n) => (n as Element).attribs.id);
    result.unmount();
    return hit;
  };
  const xhtml = `@namespace "${XHTML}";`;
  const other = '@namespace "urn:o";';
  for (const [sheet, ids] of [
    [`${xhtml}:host`, 'host'],
    [`${other}:host`, 'host'],
    [`${other}*:host`, ''],
    [`${other}:host(.on)`, ''],
    [`${xhtml}:host(.on)`, 'host'],
    [`@namespace h "${XHTML}";:host(h|div)`, 'host'],
    [`@namespace h "urn:o";:host(h|div)`, ''],
    [`${other}::slotted(.k)`, ''],
    [`${xhtml}::slotted(.k)`, 'light'],
    [`${other}*|slot::slotted(*|*.k)`, 'light'],
    [`@namespace h "${XHTML}";*|slot::slotted(h|p)`, 'light'],
    [`${other}:host .in`, ''],
    [`${other}:host *|*.in`, 'in'],
    [`${xhtml}:host .in`, 'in'],
  ] as const) {
    assert.deepEqual(await hits(sheet), every(ids), sheet);
  }
});

test('a developer’s tools read a rule as its sheet has it', async () => {
  const { node } = await render(
    `<style>@namespace h "${XHTML}";h|div[*|title]{order:7}*|div{order:1}#d{order:2}</style><div id="d" title="t"></div>`,
  );
  await act();
  const el = view(node);
  const selectors = el
    .matchedRules(findById(el.document, 'd')!)
    .filter((rule) => rule.origin === 'author')
    .map((rule) => rule.selector);
  assert.deepEqual(selectors.sort(), ['#d', '*|div', 'h|div[*|title]'].sort());
});

test('a sheet’s prefixes are its own', async () => {
  const { node } = await render(
    `<style>@namespace h "${XHTML}";</style><style>h|div{order:7}</style><div id="d"></div>`,
  );
  await act();
  assert.deepEqual(reached(view(node)), []);
});

test('what a change told of an attribute reaches is found by its local name, whatever a selector says of its namespace', async () => {
  for (const selector of ['[*|data-x=y]', '[|data-x=y]', 'h|*[*|data-x=y]']) {
    for (const [rule, at] of [
      [`${selector}`, 't'],
      [`${selector} p`, 'k'],
      [`${selector} + div`, 'n'],
      [`*|*:has(> ${selector})`, 'o'],
    ] as const) {
      const { result, node } = await render(
        `<style>@namespace h "${XHTML}";${rule}{order:7}</style><div id="o"><div id="t"><p id="k"></p></div><div id="n"></div></div>`,
      );
      await act();
      const el = view(node);
      const target = findById(el.document, 't')!;
      assert.deepEqual(reached(el), [], rule);
      target.attribs['data-x'] = 'y';
      el.touchDocument([
        {
          type: 'attributes',
          target,
          attributeName: 'data-x',
          oldValue: null,
        },
      ]);
      assert.deepEqual(reached(el), [at], rule);
      result.unmount();
    }
  }
});

test('a change told of an attribute under a prefix reaches a selector of its local name in an XML document', async () => {
  const { node } = await render(
    `<html xmlns="${XHTML}" xmlns:f="urn:f" xmlns:g="urn:g"><head><style>@namespace f "urn:f"; *|*[f|class~=on] { order: 7 }</style></head><body><p id="t" g:class="on" f:class="off"/></body></html>`,
    400,
    { contentType: 'application/xhtml+xml' },
  );
  await act();
  const el = view(node);
  const target = findById(el.document, 't')!;
  assert.deepEqual(reached(el), []);
  target.attribs['f:class'] = 'on';
  el.touchDocument([
    {
      type: 'attributes',
      target,
      attributeName: 'f:class',
      oldValue: 'off',
    },
  ]);
  assert.deepEqual(reached(el), ['t']);
});

test('a page’s query reads a bar as a selector with no namespace declared does', async () => {
  const p = await scriptedPage(
    `<svg id="s" xlink:href="a"></svg><div id="d" title="t"></div><script>
     const q = (s) => { try { return [...document.querySelectorAll(s)].map((e) => e.id).filter(Boolean).join(' ') } catch (e) { return e.name } };
     console.log('asked ' + JSON.stringify([
       '*|div', '|div', 'ns|div', ':not(ns|div)', ':is(ns|div)', ':is(ns|div, #d)',
       '[*|href]', '[|href]', '[xlink|href]', ':is([xlink|href])', '[*|TiTlE]',
       '[-rx-1|title]', '[*|*=test]', '^|div', '*|', '|',
     ].map(q)));
     const d = document.getElementById('d');
     const made = document.createElementNS('urn:n', 'p:q');
     made.setAttributeNS('urn:n', 'p:a', '1');
     made.setAttributeNS('urn:n', 'b', '1');
     d.append(made);
     const copy = made.cloneNode();
     console.log('made ' + JSON.stringify([
       made.matches('*|q'), made.matches('|q'), made.matches('[*|a]'),
       made.matches('[|a]'), made.matches('[*|b]'), made.matches('[|b]'),
       copy.matches('[*|a]'), copy.matches('[|b]'),
     ]));
     made.removeAttribute('b');
     made.setAttribute('b', '1');
     console.log('again ' + JSON.stringify(made.matches('[|b]')));
     const xml = new DOMParser().parseFromString('<a:b xmlns:a="urn:a" xml:lang="en"/>', 'application/xml');
     console.log('xml ' + JSON.stringify([
       !!xml.querySelector('b'), !!xml.querySelector('*|b'), !!xml.querySelector('[lang]'),
       !!xml.querySelector('[*|lang]'), !!xml.querySelector(':is([xml|lang])'),
     ]));
     </script>`,
  );
  assert.deepEqual(JSON.parse(await p.until('asked')), [
    'd',
    '',
    'SyntaxError',
    'SyntaxError',
    '',
    'd',
    's',
    '',
    'SyntaxError',
    '',
    'd',
    'SyntaxError',
    'SyntaxError',
    'SyntaxError',
    'SyntaxError',
    'SyntaxError',
  ]);
  assert.deepEqual(JSON.parse(await p.until('made')), [
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
  ]);
  assert.equal(await p.until('again'), 'true');
  assert.deepEqual(JSON.parse(await p.until('xml')), [
    true,
    true,
    false,
    true,
    false,
  ]);
});

test('what a page’s createElement puts in a drawing is HTML’s, as what it makes in a namespace is that one’s', async () => {
  const p = await scriptedPage(
    `<style>@namespace h "${XHTML}";@namespace s "${SVG}";h|i{order:1}s|i{order:2}|i{order:3}</style>
     <svg id="s"></svg><script>
     const s = document.getElementById('s');
     const made = [document.createElement('i'), document.createElementNS('${SVG}', 'i'), document.createElementNS(null, 'i')];
     s.append(...made);
     console.log('orders ' + JSON.stringify(made.map((e) => getComputedStyle(e).order)));
     </script>`,
  );
  assert.deepEqual(JSON.parse(await p.until('orders')), ['1', '2', '3']);
});

metric(
  'a shape takes what a namespaced rule gives it, in a drawing and in what a <use> copies',
  async () => {
    const { result } = await render(
      `<style>@namespace s "${SVG}";@namespace h "${XHTML}";body{margin:0}svg{display:block}s|rect{fill:#00ff00}h|rect{fill:#ff0000}</style><svg width="20" height="20"><defs><rect id="r" width="20" height="20"></rect></defs><use href="#r"></use></svg>`,
    );
    await act();
    const [r, g, b] = await pixelsIn(result.ctx, {
      x: 5,
      y: 5,
      width: 1,
      height: 1,
    });
    assert.deepEqual([r, g, b], [0, 255, 0]);
  },
);

metric(
  'a hover on a namespaced compound restyles what it reaches',
  async () => {
    const { node } = await render(
      `<style>@namespace h "${XHTML}";body{margin:0}h|div:hover>h|p{color:#00ff00}[*|data-a]:hover{color:#0000ff}</style><div id="d" style="height:40px"><p id="k" style="margin:0">x</p></div><div id="e" data-a="1" style="height:40px">y</div>`,
    );
    await act();
    const el = view(node);
    const colour = (id: string) =>
      el.computedStyle(findById(el.document, id)!)?.color;
    const hover = (id: string) => {
      const [x, y] = pointIn(el, id);
      const { abs } = node as unknown as {
        abs: { x: number; y: number; width: number; height: number };
      };
      fireEvent.mouseMove(node, {
        dx: x - abs.x - abs.width / 2,
        dy: y - abs.y - abs.height / 2,
      });
    };
    hover('d');
    await waitFor(() => assert.equal(colour('k'), 'rgb(0, 255, 0)'));
    hover('e');
    await waitFor(() => assert.equal(colour('e'), 'rgb(0, 0, 255)'));
    assert.notEqual(colour('k'), 'rgb(0, 255, 0)');
  },
);
