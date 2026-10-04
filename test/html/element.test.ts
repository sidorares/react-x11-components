// <Html> — the element, and its seams: what it registers, its text, and what
// it asks its host for.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  expectPixel,
  renderX11,
  screen,
  waitForPixel,
} from 'react-x11/test';
import { drawnKinds, registeredElements } from 'react-x11/host';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import type { ResourceRequest, ResourceResult } from '../../src/html/index.js';
import { decodeStylesheet } from '../../src/html/css/decode.js';
import { FONTS, boxOf, h, render, view } from './harness.js';

afterEach(cleanup);

test('importing the component is what registers the element', () => {
  assert.ok(registeredElements().includes('htmlview'));
  // `drawn` decides whether it paints at all, and a kind missing from the set
  // lays out correctly and never appears — see AGENTS.md, "Gotchas".
  assert.ok(drawnKinds().includes('htmlview'));
});

test('it mounts on the mock backend, where there are no font metrics', async () => {
  const result = await renderX11(
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source: '<p>hi</p>', partial: false, 'data-testname': 'doc' }),
    ),
    { backend: 'mock' },
  );
  const node = screen.getByTestName('doc') as DrawnNode;
  assert.strictEqual(view(node).kind, 'htmlview');
  void result;
});

test('a completed document survives an edit at its end', async () => {
  // The editor case from #77: `partial={false}` passes `complete` on every
  // render, so the parser is ended on the first one — and a keystroke at the
  // *end* of the document makes the next source a prefix extension of it.
  // Writing that delta into the ended parser threw `.write() after done!`
  // out of `commitUpdate`, so the failure was a crash rather than a misdraw,
  // and only for a caret at the end.
  const doc = (source: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, partial: false, 'data-testname': 'doc' }),
    );
  const result = await renderX11(doc('<p>hi</p>'), { backend: 'mock' });
  await act(() => result.rerender(doc('<p>hi</p><p>there</p>')));
  assert.strictEqual(
    view(screen.getByTestName('doc') as DrawnNode).textContent(),
    'hithere',
  );
});

test('the document text is what a copy would take', async () => {
  const { node } = await render('<h1>Title</h1><p>Body <em>text</em>.</p>');
  assert.strictEqual(view(node).textContent(), 'TitleBody text.');
});

test('a control is not in the document text', async () => {
  const { node } = await render(
    '<p>Name: <input type="text" value="secret"></p>',
  );
  assert.ok(!view(node).textContent().includes('secret'));
});

test("an image's alt text joins the document text", async () => {
  const { node } = await render(
    '<p>See <img src="x.png" alt="the chart"> here.</p>',
  );
  assert.ok(view(node).textContent().includes('the chart'));
});

test('a script is handed over, unparsed and unevaluated', async () => {
  const seen: { type: string; src: string | null; text: string }[] = [];
  await renderX11(
    h(Html, {
      source:
        '<script type="module" src="a.js"></script><script>throw new Error("never run")</script>',
      partial: false,
      onScript: (s: { type: string; src: string | null; text: string }) =>
        seen.push({ type: s.type, src: s.src, text: s.text }),
    }),
    { backend: 'mock' },
  );
  assert.strictEqual(seen.length, 2);
  assert.deepStrictEqual(seen[0], { type: 'module', src: 'a.js', text: '' });
  assert.strictEqual(seen[1].src, null);
  assert.ok(
    seen[1].text.includes('never run'),
    'the text is handed over verbatim',
  );
});

test('a script a stream breaks inside is handed over once, whole, after its end tag', async () => {
  const seen: string[] = [];
  const doc = (source: string, partial: boolean) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, {
        source,
        partial,
        onScript: (s: { text: string }) => seen.push(s.text),
      }),
    );
  const head = '<p>a</p><script>var greeting = "hel';
  const result = await renderX11(doc(head, true), { backend: 'mock' });
  // the parser is inside it, and what it holds so far is not the script
  assert.deepStrictEqual(seen, []);
  const more = head + 'lo";</script><p>b</p><script>var x = 1';
  await act(() => result.rerender(doc(more, true)));
  assert.deepStrictEqual(seen, ['var greeting = "hello";']);
  // the parse ends with the second still open: what it holds is all of it
  await act(() => result.rerender(doc(more, false)));
  assert.deepStrictEqual(seen, ['var greeting = "hello";', 'var x = 1']);
});

test('nothing loads without onResource, and every reference is offered to it', async () => {
  const asked: string[] = [];
  await renderX11(
    h(Html, {
      source:
        '<link rel="stylesheet" href="a.css"><img src="b.png"><p>text</p>',
      partial: false,
      onResource: (r: { url: string }) => {
        asked.push(r.url);
        return null;
      },
    }),
    { backend: 'mock' },
  );
  assert.deepStrictEqual(asked.sort(), ['a.css', 'b.png']);
});

test("a pseudo-element's background image is asked for, as its element's", async () => {
  // A generated box has no element of its own, and the images its styles
  // named were never asked for, so it drew none: design 057 hangs its
  // coffee cup, its small logo and its photo credit each on an `::after`
  // with no content but a background. They are its element's to ask for
  const asked: { url: string; element: string }[] = [];
  await renderX11(
    h(Html, {
      source:
        '<style>p::after{content:"";display:block;height:10px;' +
        'background:url(cup.png) no-repeat}' +
        'p::first-letter{background-image:url(letter.png)}' +
        'div::before{content:"";border:4px solid;' +
        'border-image:url(frame.png) 4}</style>' +
        '<p>text</p><div>more</div>',
      partial: false,
      onResource: (r: { url: string; element: { name: string } }) => {
        asked.push({ url: r.url, element: r.element.name });
        return null;
      },
    }),
    { backend: 'mock' },
  );
  assert.deepStrictEqual(
    asked.sort((a, b) => a.url.localeCompare(b.url)),
    [
      { url: 'cup.png', element: 'p' },
      { url: 'frame.png', element: 'div' },
      { url: 'letter.png', element: 'p' },
    ],
    `each asked for once, as its element's: ${JSON.stringify(asked)}`,
  );
});

test('a stylesheet handed back by the seam reaches the cascade', async () => {
  const result = await renderX11(
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, {
        source: '<link rel="stylesheet" href="a.css"><p>text</p>',
        partial: false,
        onResource: (r: { url: string; kind: string }) =>
          r.kind === 'stylesheet'
            ? { kind: 'stylesheet' as const, text: 'p { color: #ff0000 }' }
            : null,
        'data-testname': 'doc',
      }),
    ),
    { backend: 'mock' },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const tree = (
    el as unknown as {
      _tree: { root: { children: { style: { color: string } }[] } };
    }
  )._tree;
  assert.strictEqual(tree.root.children[0].style.color, '#ff0000');
  void result;
});

test('a stylesheet handed over as bytes is decoded as CSS says', () => {
  // CSS 2.1 4.4 and CSS Syntax 3 3.2, in order: a byte order mark, the
  // protocol's charset, an `@charset` at the very start — UTF-16 named in
  // ASCII meaning UTF-8 — the referrer's encodings, then UTF-8. An é is E9
  // in windows-1252 and C3 A9 in UTF-8.
  const bytes = (text: string, ...tail: number[]): Uint8Array =>
    new Uint8Array([...text].map((c) => c.charCodeAt(0)).concat(tail));
  const decode = (b: Uint8Array, charset?: string, ...fallbacks: string[]) =>
    decodeStylesheet(b, charset, fallbacks);
  assert.deepStrictEqual(
    decode(bytes('', 0xef, 0xbb, 0xbf, 0xc3, 0xa9), 'windows-1252'),
    { text: 'é', encoding: 'utf-8' },
    'the byte order mark first, and it is not text',
  );
  assert.strictEqual(
    decode(bytes('@charset "shift_jis";', 0xe9), 'windows-1252').text,
    '@charset "shift_jis";é',
    "then the protocol's",
  );
  assert.strictEqual(
    decode(bytes('@charset "windows-1252";', 0xe9), undefined, 'shift_jis')
      .encoding,
    'windows-1252',
    "then the rule, over the referrer's",
  );
  assert.strictEqual(
    decode(bytes('@charset "utf-16le";', 0xc3, 0xa9)).encoding,
    'utf-8',
  );
  assert.strictEqual(
    decode(bytes(' @charset "windows-1252";', 0xc3, 0xa9)).encoding,
    'utf-8',
    'only at the very start',
  );
  assert.strictEqual(
    decode(bytes('', 0xe9), undefined, 'no-such-encoding', 'windows-1252').text,
    'é',
    'a name that names no encoding is passed over',
  );
  assert.deepStrictEqual(decode(bytes('', 0xc3, 0xa9)), {
    text: 'é',
    encoding: 'utf-8',
  });
});

test("a stylesheet in bytes falls back to its referrer's encoding", async () => {
  // `.é { … }` in windows-1252: read as UTF-8, a selector nothing matches
  const sheet = new Uint8Array([
    0x2e,
    0xe9,
    ...[...' { color: #00ff00 }'].map((c) => c.charCodeAt(0)),
  ]);
  const colorOf = async (source: string, charset?: string) => {
    await renderX11(
      h(
        'box',
        { style: { width: 300, flexDirection: 'column' } },
        h(Html, {
          source: `${source}<p id="p" class="é">text</p>`,
          charset,
          partial: false,
          onResource: (r: { kind: string }) =>
            r.kind === 'stylesheet'
              ? { kind: 'stylesheet' as const, bytes: sheet }
              : null,
          'data-testname': 'doc',
        }),
      ),
      { backend: 'mock' },
    );
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const p = boxOf(el, 'p') as unknown as { style: { color: string } };
    cleanup();
    return p.style.color;
  };
  const link = '<link rel="stylesheet" href="a.css">';
  assert.notStrictEqual(await colorOf(link), '#00ff00', 'UTF-8 by default');
  assert.strictEqual(await colorOf(link, 'windows-1252'), '#00ff00');
  assert.strictEqual(
    await colorOf(
      '<link rel="stylesheet" charset="windows-1252" href="a.css">',
    ),
    '#00ff00',
    'a <link charset> goes before the document',
  );
  assert.strictEqual(
    await colorOf('<style>@import "b.css";</style>', 'windows-1252'),
    '#00ff00',
    'an import is in the encoding of the sheet importing it',
  );
});

test("an imported stylesheet's rules come before its importer's", async () => {
  // CSS 2.1 6.4.1: an import stands where its `@import` does, so the sheet
  // importing it wins a tie. It was parsed after the sheet, and won.
  await renderX11(
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>@import "a.css"; p { color: #00ff00 }</style><p id="p">x</p>',
        partial: false,
        onResource: (r: { kind: string }) =>
          r.kind === 'stylesheet'
            ? { kind: 'stylesheet' as const, text: 'p { color: #ff0000 }' }
            : null,
        'data-testname': 'doc',
      }),
    ),
    { backend: 'mock' },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const p = boxOf(el, 'p') as unknown as { style: { color: string } };
  assert.strictEqual(p.style.color, '#00ff00');
});

test('a stylesheet the head links to, or imports, holds the first rendering until it arrives or is declined; one in the body, for print or declined at once holds nothing', async () => {
  // A browser paints a page once its head's sheets are in (HTML,
  // "render-blocking"). Drawn before then, the document was built, laid out
  // and painted in the user agent's styles, and built again when the sheet
  // landed: a flash of unstyled content, and the first frame's work twice.
  const held = new Map<string, () => void>();
  /** How the host answers: with the sheet, declining it at once, or
   *  declining or failing it once it is held for. */
  type Answer = 'sheet' | 'declined' | 'declined later' | 'failed later';
  const mount = async (source: string, how: Answer = 'sheet') => {
    await renderX11(
      h(
        'box',
        { style: { width: 300, flexDirection: 'column' } },
        h(Html, {
          source,
          partial: false,
          onResource: (r: ResourceRequest) => {
            if (r.kind !== 'stylesheet' || how === 'declined') return null;
            return new Promise<ResourceResult | null>((answer, fail) =>
              held.set(r.url, () =>
                how === 'declined later'
                  ? answer(null)
                  : how === 'failed later'
                    ? fail(new Error('offline'))
                    : answer({
                        kind: 'stylesheet' as const,
                        text:
                          r.url === 'a.css'
                            ? '@import "b.css"; p { color: #ff0000 }'
                            : 'p { margin: 0 }',
                      }),
              ),
            );
          },
          'data-testname': 'doc',
        }),
      ),
      { backend: 'mock' },
    );
    await act();
    const el = view(screen.getByTestName('doc') as DrawnNode);
    return () => (el as unknown as { _tree: object | null })._tree;
  };
  const release = async (url: string) => {
    held.get(url)!();
    held.delete(url);
    await act();
    await act();
  };

  // in the head: nothing until the sheet, and what it imports, are in
  let tree = await mount(
    '<html><head><link rel="stylesheet" href="a.css"></head>' +
      '<body><p id="p">text</p></body></html>',
  );
  assert.strictEqual(tree(), null, 'held for a.css');
  await release('a.css');
  assert.strictEqual(tree(), null, 'and for the b.css it imports');
  await release('b.css');
  assert.ok(tree(), 'drawn once both are in');
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const p = boxOf(el, 'p') as unknown as { style: { color: string } };
  assert.strictEqual(p.style.color, '#ff0000', 'styled from the first');
  cleanup();

  // a fragment's link before its content is in the head as well
  tree = await mount('<link rel="stylesheet" href="b.css"><p>text</p>');
  assert.strictEqual(tree(), null, 'a fragment held');
  await release('b.css');
  assert.ok(tree());
  cleanup();

  // after content, in the body: drawn before it arrives
  tree = await mount('<p>text</p><link rel="stylesheet" href="b.css">');
  assert.ok(tree(), 'not held by a sheet in the body');
  await release('b.css');
  cleanup();
  tree = await mount(
    '<link rel="stylesheet" href="b.css" media="print"><p>text</p>',
  );
  assert.ok(tree(), 'nor by one for print');
  held.clear();
  cleanup();
  tree = await mount(
    '<link rel="stylesheet" href="b.css"><p>text</p>',
    'declined',
  );
  assert.ok(tree(), 'nor by one the host declined');
  cleanup();

  // Declined or failed once it is held for, it holds nothing from then:
  // nothing else was going to ask again, and Zen Garden 215, which imports
  // two `http:` sheets a secure page's host refuses, was never drawn
  for (const how of ['declined later', 'failed later'] as const) {
    tree = await mount('<link rel="stylesheet" href="b.css"><p>text</p>', how);
    assert.strictEqual(tree(), null, `held until it is ${how}`);
    await release('b.css');
    assert.ok(tree(), `drawn once it is ${how}`);
    const doc = screen.getByTestName('doc') as DrawnNode;
    assert.ok(doc.abs.height > 0, `and as tall as it is, ${how}`);
    cleanup();
  }
});

test('an image handed over as bytes is decoded and drawn', async (t) => {
  // `decodeImage` is a named export of react-x11/ntk; read off the default
  // one it was undefined, and every image a host returned as bytes drew as
  // an empty frame. A red square, then: its middle is red or it is not.
  if (!FONTS) return t.skip('no font files for the in-process server');
  // a 10x10 PNG, solid #ff0000
  const bytes = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAIUlEQVR4AX3BAQEAAAiDMKR/' +
        '59uA7UaRJEmSJEmSJEmS9EEsAROhAw00AAAAAElFTkSuQmCC',
      'base64',
    ),
  );
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source: '<img src="red.png" style="display: block">',
        partial: false,
        onResource: (r: { kind: string }) =>
          r.kind === 'image' ? { kind: 'image' as const, bytes } : null,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  // the body's 8px margin, and the middle of the square
  await expectPixel(result.ctx, 13, 13, '#ff0000', {
    message: 'the decoded image is drawn',
  });
});

test('a WebP handed over as bytes lands after the first frame and is drawn', async (t) => {
  // core's decoder ladder, `decodeImageBytes` off react-x11/ntk, the one
  // `<image>` decodes bytes with; ntk's own `decodeImage`, which this read
  // before, is PNG and JPEG alone, and a WebP drew as an empty frame. Under
  // Node the WebP decoder loads on the first WebP, so the image lands a
  // moment after the first frame rather than in it.
  if (!FONTS) return t.skip('no font files for the in-process server');
  // a 10x10 lossless WebP, solid #ff0000
  const bytes = new Uint8Array(
    Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvCUACAAcQ/Y/+ByKi/wEA', 'base64'),
  );
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source: '<img src="red.webp" style="display: block">',
        partial: false,
        onResource: (r: { kind: string }) =>
          r.kind === 'image' ? { kind: 'image' as const, bytes } : null,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  // the body's 8px margin, and the middle of the square
  await waitForPixel(result.ctx, 13, 13, '#ff0000', {
    message: 'the decoded WebP is drawn',
  });
});

test('a document with no seams renders anyway', async () => {
  const { node } = await render(
    '<img src="nope.png" alt="x"><p>still here</p>',
  );
  assert.ok(view(node).textContent().includes('still here'));
});

test("every layer's image is asked for", async () => {
  const asked: string[] = [];
  await renderX11(
    h(Html, {
      source:
        '<div style="background:url(one.png),linear-gradient(red,blue),' +
        'url(two.png)">x</div>',
      partial: false,
      onResource: (r: { url: string; kind: string }) => {
        if (r.kind === 'image') asked.push(r.url);
        return null;
      },
    }),
    FONTS ? { width: 200, height: 100, fonts: FONTS } : { backend: 'mock' },
  );
  assert.deepStrictEqual(asked.sort(), ['one.png', 'two.png']);
});
