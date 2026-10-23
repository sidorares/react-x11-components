// Text fragments (WICG Scroll To Text Fragment): a URL's `#:~:text=…`
// names text in the document, which is found in the text the document
// draws, lit in `::target-text` and handed to the host to scroll to, and
// which is no part of the fragment that names `:target`.
import { test } from 'node:test';
import assert from 'node:assert';
import { act } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import {
  findById,
  h,
  metric,
  pixelsIn,
  render,
  render2x,
  treeOf,
  view,
} from './harness.js';
import type { HtmlViewNode } from '../../src/html/index.js';
import type { BoxTree } from '../../src/html/layout/boxes.js';
import {
  findTextDirective,
  parseTextDirective,
  parseTextDirectives,
  searchTextOf,
  splitFragment,
  withoutFragmentDirective,
} from '../../src/html/text-fragments.js';

test('a fragment directive is split from the fragment, and taken out of the URL', () => {
  assert.deepStrictEqual(splitFragment('sec:~:text=a'), {
    fragment: 'sec',
    directive: 'text=a',
  });
  assert.deepStrictEqual(splitFragment(':~:text=a&text=b'), {
    fragment: '',
    directive: 'text=a&text=b',
  });
  assert.deepStrictEqual(splitFragment('sec'), {
    fragment: 'sec',
    directive: null,
  });
  assert.strictEqual(
    withoutFragmentDirective('https://x.test/p?q=1#sec:~:text=a'),
    'https://x.test/p?q=1#sec',
  );
  // a fragment that was only the directive is an empty one, as a browser's
  // `location.href` has it
  assert.strictEqual(
    withoutFragmentDirective('https://x.test/p#:~:text=a'),
    'https://x.test/p#',
  );
  assert.strictEqual(
    withoutFragmentDirective('https://x.test/p#sec'),
    'https://x.test/p#sec',
  );
  assert.strictEqual(
    withoutFragmentDirective('https://x.test/p'),
    'https://x.test/p',
  );
});

test("a text directive's terms are its prefix, start, end and suffix, each percent-decoded", () => {
  assert.deepStrictEqual(parseTextDirective('an%20example'), {
    prefix: null,
    start: 'an example',
    end: null,
    suffix: null,
  });
  assert.deepStrictEqual(parseTextDirective('the-,quick,lazy,-dog'), {
    prefix: 'the',
    start: 'quick',
    end: 'lazy',
    suffix: 'dog',
  });
  assert.deepStrictEqual(parseTextDirective('quick,-fox'), {
    prefix: null,
    start: 'quick',
    end: null,
    suffix: 'fox',
  });
  // a dash in a term is written %2D; a term that is a dash alone is none
  assert.deepStrictEqual(parseTextDirective('well%2Dknown'), {
    prefix: null,
    start: 'well-known',
    end: null,
    suffix: null,
  });
  assert.deepStrictEqual(parseTextDirective('caf%C3%A9%zz'), {
    prefix: null,
    start: 'café%zz',
    end: null,
    suffix: null,
  });
  for (const bad of ['', 'a,,b', 'a,b,c', 'p-,a,b,c,-s', '-,a', 'p-,-s']) {
    assert.strictEqual(parseTextDirective(bad), null, bad);
  }
  // `&` joins directives, and those of another kind are passed over
  assert.deepStrictEqual(
    parseTextDirectives('text=one&unknown=x&text=&text=two,three').map((d) => [
      d.start,
      d.end,
    ]),
    [
      ['one', null],
      ['two', 'three'],
    ],
  );
});

/** What a directive finds in a document, as the text it covers. */
async function found(
  source: string,
  ...directives: string[]
): Promise<(string | null)[]> {
  const { node } = await render(source, 300);
  const tree = treeOf(view(node)) as BoxTree;
  const text = searchTextOf(tree);
  return directives.map((value) => {
    const directive = parseTextDirective(value);
    assert.ok(directive, value);
    const match = findTextDirective(text, directive);
    return match && tree.text.slice(match[0], match[1]);
  });
}

test('a directive is matched in the text the document draws, case and accents aside', async () => {
  assert.deepStrictEqual(
    await found(
      '<p>The  QUICK <b>brown</b>\n fox</p><p style="text-transform: uppercase">Café crème</p>',
      'quick%20brown%20fox',
      'cafe%20creme',
      'CAFÉ',
      'quick%20%20brown',
    ),
    // white space collapsed in the text and in the query alike
    ['QUICK brown fox', 'CAFÉ CRÈME', 'CAFÉ', 'QUICK brown'],
  );
});

test('a term is matched on word boundaries, and within one block', async () => {
  assert.deepStrictEqual(
    await found(
      '<p>an example of examples</p><p>end</p><p>start</p>' +
        '<div>outer<div>inner</div></div>' +
        '<p>press <span style="display: inline-block">here</span> now</p>',
      'example',
      'xample',
      'examples',
      'end%20start',
      'outerinner',
      'outer',
      // an inline-block's text runs on with its line's
      'press%20here%20now',
    ),
    ['example', null, 'examples', null, null, 'outer', 'press here now'],
  );
});

test('a range runs from its start to the first end after it, across blocks', async () => {
  assert.deepStrictEqual(
    await found(
      '<p>Chapter one begins</p><p>the middle</p><p>and one ends here, one ends</p>',
      'begins,ends',
      'one,here',
      'chapter,middle',
      'ends,chapter',
    ),
    // the document's text holds nothing between two blocks
    [
      'beginsthe middleand one ends',
      'one beginsthe middleand one ends here',
      'Chapter one beginsthe middle',
      null,
    ],
  );
});

test('a prefix and a suffix pick the place they are next to, with only white space between', async () => {
  assert.deepStrictEqual(
    await found(
      '<p>a cat sat. the cat ran. my cat sat</p>',
      'the-,cat',
      'cat,-ran',
      'my-,cat,-sat',
      'the-,cat,-sat',
      'dog-,cat',
    ),
    ['cat', 'cat', 'cat', null, null],
  );
  // a suffix in the next block is right after
  assert.deepStrictEqual(
    await found('<p>one two</p><p>three</p>', 'two,-three', 'one,-three'),
    ['two', null],
  );
  // with an end, the first end after which the suffix follows
  assert.deepStrictEqual(
    await found('<p>from a to b. to c here</p>', 'from,to,-c'),
    ['from a to b. to'],
  );
});

test('what the document does not draw, or draws but holds no text node of, is not searched', async () => {
  assert.deepStrictEqual(
    await found(
      '<style>.g::before { content: "made up" }</style>' +
        '<p>shown</p><p style="display:none">gone</p>' +
        '<p style="visibility:hidden">hidden</p><p class="g">real</p>' +
        '<p>said <q>hi</q></p>',
      'shown',
      'gone',
      'hidden',
      'made',
      'real',
      'said%20hi',
    ),
    ['shown', null, null, null, 'real', 'said “hi'],
  );
});

/** A document's element by id, with the view it is in. */
function byId(el: HtmlViewNode, id: string) {
  const found = findById(el.document, id);
  assert.ok(found, id);
  return found;
}

/** The pixels of two elements' boxes, the first's size, and how many of
 *  them differ. */
async function differing(
  result: Awaited<ReturnType<typeof render>>['result'],
  el: HtmlViewNode,
  a: string,
  b: string,
): Promise<number> {
  const { abs } = el as unknown as DrawnNode;
  const lit = el.elementRect(byId(el, a))!;
  const ref = el.elementRect(byId(el, b))!;
  const width = Math.round(lit.width);
  const height = Math.round(lit.height);
  const at = (r: typeof lit) =>
    pixelsIn(result.ctx, {
      x: Math.round(abs.x + r.x),
      y: Math.round(abs.y + r.y),
      width,
      height,
    });
  await act();
  const [p, q] = [await at(lit), await at(ref)];
  let differ = 0;
  for (let i = 0; i < p.length; i += 1) if (p[i] !== q[i]) differ += 1;
  return differ;
}

const LINES =
  '<style>body { margin: 0; font: 20px/30px sans-serif; color: #000000 }' +
  ' p { margin: 0 } .mark { background-color: #ffff00; color: #000000 }' +
  ' .own { background-color: #00ff00; color: #ff0000 } %s</style>' +
  '<p id="t">one two three</p>' +
  '<p id="plain">one two three</p>' +
  '<p id="ref">one <span class="mark">two</span> three</p>' +
  '<p id="own">one <span class="own">two</span> three</p>';

metric(
  'the text a directive names is lit in ::target-text, yellow by default, and as an author rule says',
  async () => {
    const source = LINES.replace('%s', '');
    const { result, node } = await render(source, 300, {
      baseUrl: 'https://x.test/p#:~:text=two',
    });
    const el = view(node);
    assert.notEqual(
      await differing(result, el, 'plain', 'ref'),
      0,
      'the reference is lit',
    );
    assert.equal(
      await differing(result, el, 't', 'ref'),
      0,
      'Mark under MarkText, as a span in them is drawn',
    );
    const styled = await render(
      LINES.replace(
        '%s',
        '::target-text { background-color: #00ff00; color: #ff0000 }',
      ),
      300,
      { baseUrl: 'https://x.test/p#:~:text=two' },
    );
    assert.equal(
      await differing(styled.result, view(styled.node), 't', 'own'),
      0,
      "the page's own look",
    );
  },
);

metric(
  'text is lit only where a directive names it, and a new fragment lights what it names',
  async () => {
    const source = LINES.replace('%s', '');
    const { result, node } = await render(source, 300, {
      baseUrl: 'https://x.test/p#:~:text=nowhere',
    });
    const el = view(node);
    assert.equal(await differing(result, el, 't', 'plain'), 0, 'unlit');
    assert.strictEqual(el.indicatedPart(), null);
    await act(() =>
      result.rerender(doc(source, 'https://x.test/p#:~:text=one%20two,-three')),
    );
    assert.notEqual(await differing(result, el, 't', 'plain'), 0, 'lit');
    await act(() => result.rerender(doc(source, 'https://x.test/p')));
    assert.equal(
      await differing(result, el, 't', 'plain'),
      0,
      'no directive, nothing lit',
    );
  },
);

/** `<Html>` as `render` mounts it, at another URL. */
function doc(source: string, baseUrl: string) {
  return h(
    'box',
    { style: { width: 300, flexDirection: 'column' } },
    h(Html, { source, partial: false, baseUrl, 'data-testname': 'doc' }),
  );
}

metric(
  "the indicated part is the text a directive found, to be scrolled to the middle, else the fragment's element",
  async () => {
    const source =
      '<style>body { margin: 0; font: 20px/30px sans-serif } p { margin: 0 }' +
      ' :target { color: #00ff00 }</style>' +
      '<p id="sec">a section</p><div style="height: 500px"></div>' +
      '<p id="far">some <b>far</b> away text</p>';
    const { result, node } = await render(source, 300, {
      baseUrl: 'https://x.test/p#sec:~:text=far%20away',
    });
    const el = view(node);
    const part = el.indicatedPart()!;
    assert.strictEqual(part.element, null);
    assert.strictEqual(part.block, 'center');
    const far = el.elementRect(byId(el, 'far'))!;
    // the line's top and height, worked out through the text's own
    // extents, come to the element's within a last bit of rounding
    const near = (a: number, b: number, what: string) =>
      assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} against ${b}`);
    near(part.rect.y, far.y, 'its top');
    near(part.rect.height, far.height, 'its height');
    assert.ok(part.rect.x > far.x && part.rect.width < far.width);
    // the directive is no part of what names `:target`
    const sec = byId(el, 'sec');
    const style = (
      treeOf(el) as BoxTree & {
        styles: Map<unknown, { style: { color: string } }>;
      }
    ).styles.get(sec)!.style;
    assert.strictEqual(style.color, '#00ff00');
    // text that is nowhere leaves the element
    await act(() =>
      result.rerender(doc(source, 'https://x.test/p#sec:~:text=nowhere')),
    );
    const element = el.indicatedPart()!;
    assert.strictEqual(element.element, sec);
    assert.strictEqual(element.block, 'start');
    assert.deepStrictEqual(element.rect, el.elementRect(sec));
  },
);

metric('the indicated part is in logical pixels at a scale of 2', async () => {
  const source =
    '<style>body { margin: 0; font: 20px/30px sans-serif } p { margin: 0 }</style>' +
    '<div style="height: 90px"></div><p>some <b>far</b> away text</p>';
  const props = { baseUrl: 'https://x.test/p#:~:text=far%20away' };
  const at1 = view((await render(source, 300, props)).node).indicatedPart()!;
  const at2 = view((await render2x(source, 300, props)).node).indicatedPart()!;
  assert.strictEqual(at2.rect.y, 90);
  assert.strictEqual(at2.rect.y, at1.rect.y);
  assert.strictEqual(at2.rect.height, at1.rect.height);
  assert.ok(Math.abs(at2.rect.x - at1.rect.x) < 1, `${at2.rect.x}`);
  assert.ok(Math.abs(at2.rect.width - at1.rect.width) < 2, `${at2.rect.width}`);
});
