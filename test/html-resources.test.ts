// <Html>'s resources, as a host on a network sees them: URLs resolved
// against the document's base and a stylesheet's own, stylesheets that
// arrive after the first paint, `@import`s inside `@import`s, the families a
// document declares with `@font-face`, and the GIFs documents are still full
// of. The pure halves — the resolver, the parser, face matching, the GIF
// decoder — are tested directly; the rest through the harness, on the mock
// backend where no metric is involved and on the in-process X server where
// a font has to be registered with a real font manager.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import React from 'react';

import { renderX11, cleanup, screen, act } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { Html, useHtmlHandle } from '../src/html/index.js';
import type {
  HtmlViewNode,
  ResourceRequest,
  ResourceResult,
} from '../src/html/index.js';
import { absoluteUrls, parseStylesheet } from '../src/html/css/parse.js';
import type { FontFaceRule } from '../src/html/css/parse.js';
import { bestFace } from '../src/html/fonts.js';
import { decodeGif } from '../src/html/gif.js';
import { resolveUrl } from '../src/html/url.js';

const h = React.createElement;

afterEach(cleanup);

// Real font files, as in html.test.ts: DejaVu on Linux, Arial on macOS, and
// the metric tests skip on a box with neither.
const FONT_CANDIDATES: Array<[string, string]> = [
  [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Monaco.ttf',
  ],
  [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  ],
];
const found = FONT_CANDIDATES.find(
  ([sans, mono]) => existsSync(sans) && existsSync(mono),
);
const FONTS = found ? { 'sans-serif': found[0], monospace: found[1] } : null;

// Web fonts to load: KaTeX's, which `katex` (an optional dependency) ships
// as WOFF2 — the format a web font nearly always is now.
const KATEX = new URL('../node_modules/katex/dist/fonts/', import.meta.url);
const woff2 = (name: string): Uint8Array | null => {
  const file = new URL(`KaTeX_${name}.woff2`, KATEX);
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
};
const REGULAR = woff2('Main-Regular');
const BOLD = woff2('Main-Bold');
const withFonts = FONTS && REGULAR && BOLD ? test : test.skip;

function view(node: DrawnNode): HtmlViewNode {
  return (node as unknown as { children: HtmlViewNode[] }).children[0];
}

interface LaidBox {
  el: { attribs: Record<string, string> } | null;
  style: {
    fontFamily: string;
    fontSize: number;
    color: string;
    backgroundImage: unknown;
  };
  children: LaidBox[];
}

function boxOf(el: HtmlViewNode, id: string): LaidBox {
  const root = (el as unknown as { _tree: { root: LaidBox } })._tree.root;
  const find = (box: LaidBox): LaidBox | null => {
    if (box.el?.attribs.id === id) return box;
    for (const child of box.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const hit = find(root);
  assert.ok(hit, `#${id} has a box`);
  return hit;
}

type Answer = (
  request: ResourceRequest,
) => Promise<ResourceResult | null> | ResourceResult | null;

async function mount(
  source: string,
  onResource: Answer,
  extra: Record<string, unknown> = {},
  fonts = false,
) {
  const result = await renderX11(
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        onResource,
        'data-testname': 'doc',
        ...extra,
      }),
    ),
    fonts
      ? { width: 440, height: 300, fonts: FONTS! }
      : { backend: 'mock' as const },
  );
  const node = view(screen.getByTestName('doc') as DrawnNode);
  return { result, node };
}

/** Let a host's promises settle, and the document catch up with them. */
async function settle(node: HtmlViewNode, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  (node as unknown as { _prepare(width: number): void })._prepare(400);
}

// --- resolving ----------------------------------------------------------------

test('a URL resolves against a base, and stays as written without one', () => {
  assert.strictEqual(resolveUrl('a/b.png', null), 'a/b.png');
  assert.strictEqual(
    resolveUrl(' b.png\n', 'https://example.test/docs/page.html'),
    'https://example.test/docs/b.png',
    'the white space round an attribute value is not the URL',
  );
  assert.strictEqual(
    resolveUrl('../img/a.png', 'https://example.test/css/site.css'),
    'https://example.test/img/a.png',
  );
  assert.strictEqual(
    resolveUrl('//cdn.test/x.css', 'https://example.test/'),
    'https://cdn.test/x.css',
  );
  const data =
    'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>';
  assert.strictEqual(resolveUrl(data, 'https://example.test/'), data);
  assert.strictEqual(
    resolveUrl('http://[bad', 'https://example.test/'),
    'http://[bad',
    'a pair that makes no URL is left as it was',
  );
});

test("a sheet's url()s come out absolute, wherever they stand", () => {
  const base = 'https://example.test/css/site.css';
  assert.strictEqual(
    absoluteUrls('url(a.png) no-repeat', base),
    'url("https://example.test/css/a.png") no-repeat',
  );
  assert.strictEqual(
    absoluteUrls('URL( "../b c.png" )', base),
    'url("https://example.test/b%20c.png")',
  );
  assert.strictEqual(
    absoluteUrls('image-set(url(a.png) 1x, url(b.png) 2x)', base),
    'image-set(url("https://example.test/css/a.png") 1x, ' +
      'url("https://example.test/css/b.png") 2x)',
    'inside a function too',
  );
  assert.strictEqual(
    absoluteUrls('var(--bg, url(a.png))', base),
    'var(--bg, url("https://example.test/css/a.png"))',
  );
  for (const same of [
    '"url(a.png)"',
    'url(#clip)',
    'url(data:image/png;base64,AAAA)',
    'curl(a.png)',
    'none',
  ]) {
    assert.strictEqual(absoluteUrls(same, base), same, same);
  }
});

test('a sheet parsed with a base resolves its imports and its values', () => {
  const sheet = parseStylesheet(
    '@import "reset.css"; @import url(//cdn.test/x.css) screen;' +
      'p { background: url(../img/bg.png) }',
    0,
    new Map(),
    'https://example.test/css/site.css',
  );
  assert.deepStrictEqual(sheet.imports, [
    'https://example.test/css/reset.css',
    'https://cdn.test/x.css',
  ]);
  assert.strictEqual(
    sheet.rules[0].declarations[0].value,
    'url("https://example.test/img/bg.png")',
  );
  const bare = parseStylesheet('p { background: url(../img/bg.png) }');
  assert.strictEqual(
    bare.rules[0].declarations[0].value,
    'url(../img/bg.png)',
    'with none, as written',
  );
});

// --- @font-face ---------------------------------------------------------------

test('@font-face rules are read, descriptor by descriptor', () => {
  const sheet = parseStylesheet(
    `@font-face {
       font-family: "Open Sans";
       src: local("Open Sans"), url(os.woff2) format("woff2"),
            url('os.woff') format(woff), url(os.eot?#iefix) format("embedded-opentype");
       font-weight: 300 800;
       font-style: oblique 10deg;
       unicode-range: U+0000-00FF, U+0131, U+4??;
     }
     @font-face { font-family: Icons Two; src: url(i.ttf); font-weight: bold;
                  font-family: not, a list; unicode-range: nonsense }
     @font-face { font-family: sans-serif; src: url(hijack.ttf) }
     @font-face { font-family: "Only Local"; src: local(Arial) }
     @media (max-width: 600px) {
       @font-face { font-family: Small; src: url(s.woff2) }
     }`,
    0,
    new Map(),
    'https://example.test/css/fonts.css',
  );
  const [open, icons, small] = sheet.fontFaces;
  assert.strictEqual(sheet.fontFaces.length, 3, 'no generic name, no local');
  assert.deepStrictEqual(open, {
    family: 'Open Sans',
    sources: [
      { url: 'https://example.test/css/os.woff2', format: 'woff2' },
      { url: 'https://example.test/css/os.woff', format: 'woff' },
      {
        url: 'https://example.test/css/os.eot?#iefix',
        format: 'embedded-opentype',
      },
    ],
    weight: [300, 800],
    style: 'italic',
    unicodeRange: [
      [0, 0xff],
      [0x131, 0x131],
      [0x400, 0x4ff],
    ],
    media: null,
  } satisfies FontFaceRule);
  assert.strictEqual(icons.family, 'Icons Two', 'a list is no family');
  assert.deepStrictEqual(icons.weight, [700, 700]);
  assert.strictEqual(icons.unicodeRange, null, 'nonsense is dropped');
  assert.strictEqual(small.family, 'Small');
  assert.ok(small.media, 'a face in @media keeps its condition');
});

test('a face is matched as CSS Fonts 4 matches one', () => {
  const face = (
    lo: number,
    hi = lo,
    style: 'normal' | 'italic' = 'normal',
  ) => ({
    rule: {
      family: 'F',
      sources: [],
      weight: [lo, hi] as [number, number],
      style,
      unicodeRange: null,
      media: null,
    },
  });
  const weights = [face(300), face(400), face(700)];
  const pick = (faces: ReturnType<typeof face>[], w: number, italic = false) =>
    bestFace(faces, w, italic)?.rule.weight[0];
  assert.strictEqual(pick(weights, 400), 400);
  assert.strictEqual(pick(weights, 600), 700, 'above 500: heavier first');
  assert.strictEqual(pick(weights, 350), 300, 'below 400: lighter first');
  assert.strictEqual(pick(weights, 500), 400, 'up to 500, then down');
  assert.strictEqual(
    pick([face(300), face(500), face(700)], 450),
    500,
    'between 400 and 500: up to 500 before down',
  );
  assert.strictEqual(pick([face(100, 900)], 650), 100, 'inside a range');
  assert.strictEqual(
    pick([face(400), face(700, 700, 'italic')], 400, true),
    700,
    'the slant before the weight',
  );
});

// --- GIF ----------------------------------------------------------------------

// Pillow's, 16 colours: palette entry i is (16i, 255 − 16i, 48i) mod 256,
// and the pixel at (x, y) is entry (3x + 5y) mod 16 — enough runs that the
// codes grow past their starting width.
const PALETTE = (i: number) => [
  (i * 16) % 256,
  (255 - i * 16) % 256,
  (i * 48) % 256,
];
const PLAIN_GIF =
  'R0lGODdhEAAQAIMAAAD/ABDvMCDfYDDPkEC/wFCv8GCfIHCPUIB/gJBvsKBf4LBPEMA/QNAvcOAf' +
  'oPAP0CwAAAAAEAAQAAAIaQABDDCQgMEDAQUQLHAQgMABBQ0SLmz4sIFAggYFQLxY8KBEhg49KgRZ' +
  'kSMDhxsHdkQ4MsDKjxRTGiAp86VClRlhorTYcqdJjxZxipyIkiXRkkKRYhwKMmdPpQliBl1q1AFV' +
  'nUiP1nQaEAA7';
// the same pattern at 12 by 20, stored interlaced
const INTERLACED_GIF =
  'R0lGODdhDAAUAIMAAAD/ABDvMCDfYDDPkEC/wFCv8GCfIHCPUIB/gJBvsKBf4LBPEMA/QNAvcOAf' +
  'oPAP0CwAAAAADAAUAEAIZQABDDCQgMEDAQUQLHAQQCFDAgcUNBBIkGLBgwkXBoAo0aJBhB8zPozY' +
  'oOPAiwgdbiTpEaNKjhNPhnzJUqbLBSJXmjRwc2RHlDk52kypkUBMgjMX1kTqUudRlEWXFgy6tKdT' +
  'AAEBADs=';
// the one-pixel transparent spacer every table layout of its day used
const SPACER_GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const bytesOf = (base64: string) =>
  new Uint8Array(Buffer.from(base64, 'base64'));

function assertPattern(gif: string, width: number, height: number): void {
  const decoded = decodeGif(bytesOf(gif));
  assert.ok(decoded, 'decodes');
  assert.strictEqual(decoded.width, width);
  assert.strictEqual(decoded.height, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      assert.deepStrictEqual(
        [...decoded.data.subarray(o, o + 4)],
        [...PALETTE((x * 3 + y * 5) % 16), 255],
        `pixel ${x},${y}`,
      );
    }
  }
}

test("a GIF's first frame is decoded, its codes growing", () => {
  assertPattern(PLAIN_GIF, 16, 16);
});

test('an interlaced GIF has its rows put back in order', () => {
  assertPattern(INTERLACED_GIF, 12, 20);
});

test("a GIF's transparent colour is transparent", () => {
  const spacer = decodeGif(bytesOf(SPACER_GIF));
  assert.ok(spacer);
  assert.deepStrictEqual([...spacer.data], [0, 0, 0, 0]);
});

test('bytes that are not a GIF, or stop short, decode to nothing or less', () => {
  assert.strictEqual(decodeGif(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  const whole = bytesOf(PLAIN_GIF);
  const cut = decodeGif(whole.subarray(0, whole.length - 40));
  assert.ok(cut, 'a frame cut short is still a frame');
  assert.strictEqual(cut.width, 16);
});

test('a GIF handed over as bytes reaches the box as an image', async () => {
  const { node } = await mount('<img id="i" src="spacer.gif">', (r) =>
    r.kind === 'image'
      ? { kind: 'image', bytes: bytesOf(INTERLACED_GIF) }
      : null,
  );
  const box = boxOf(node, 'i') as unknown as {
    intrinsic: { width: number; height: number } | null;
  };
  assert.deepStrictEqual(
    box.intrinsic && [box.intrinsic.width, box.intrinsic.height],
    [12, 20],
  );
});

// --- the document's base ------------------------------------------------------

test('with a base, every reference reaches the host absolute', async () => {
  const asked: string[] = [];
  await mount(
    '<style>@import "print.css"; p { background: url(bg.png) }</style>' +
      '<link rel="stylesheet" href="/css/site.css"><p>x</p>' +
      '<div style="background-image: url(\'inline.png\')"></div>' +
      '<img src="a.png"><object data="//cdn.test/b.svg"></object>',
    (r) => {
      asked.push(`${r.kind} ${r.url}`);
      return null;
    },
    { baseUrl: 'https://example.test/docs/page.html' },
  );
  assert.deepStrictEqual(asked.sort(), [
    'image https://cdn.test/b.svg',
    'image https://example.test/docs/a.png',
    'image https://example.test/docs/bg.png',
    'image https://example.test/docs/inline.png',
    'stylesheet https://example.test/css/site.css',
    'stylesheet https://example.test/docs/print.css',
  ]);
});

test('a <base href> moves the base, and without either nothing resolves', async () => {
  const asked: string[] = [];
  const record: Answer = (r) => {
    asked.push(r.url);
    return null;
  };
  await mount('<base href="/assets/"><img src="a.png">', record, {
    baseUrl: 'https://example.test/docs/page.html',
  });
  assert.deepStrictEqual(asked, ['https://example.test/assets/a.png']);
  cleanup();
  asked.length = 0;
  await mount('<base href="https://cdn.test/v2/"><img src="a.png">', record);
  assert.deepStrictEqual(
    asked,
    ['https://cdn.test/v2/a.png'],
    'an absolute one',
  );
  cleanup();
  asked.length = 0;
  await mount('<img src="a.png"><link rel="stylesheet" href="s.css">', record);
  assert.deepStrictEqual(asked.sort(), ['a.png', 's.css'], 'as written');
});

test("a linked sheet's URLs resolve against it — or where it said it came from", async () => {
  const asked: string[] = [];
  const { node } = await mount(
    '<link rel="stylesheet" href="css/site.css"><p id="p">x</p>',
    (r) => {
      asked.push(r.url);
      if (r.url === 'https://example.test/css/site.css') {
        return {
          kind: 'stylesheet',
          text: '@import "more.css"; p { background: url(../img/bg.png) }',
        };
      }
      if (r.url === 'https://example.test/css/more.css') {
        // a redirect: the host says where the sheet was in the end
        return {
          kind: 'stylesheet',
          text: '@import "deeper.css"; p { color: #00ff00 }',
          url: 'https://cdn.test/moved/more.css',
        };
      }
      return null;
    },
    { baseUrl: 'https://example.test/index.html' },
  );
  assert.deepStrictEqual(asked.sort(), [
    'https://cdn.test/moved/deeper.css',
    'https://example.test/css/more.css',
    'https://example.test/css/site.css',
    'https://example.test/img/bg.png',
  ]);
  const p = boxOf(node, 'p');
  assert.strictEqual(p.style.color, '#00ff00', 'the import applies');
  assert.strictEqual(
    p.style.backgroundImage,
    'https://example.test/img/bg.png',
  );
});

test('a stylesheet that arrives after the first paint restyles the document', async () => {
  // Every stylesheet a host on a network hands over arrives this way. The
  // arrival rebuilt the boxes, and the cascade the boxes are styled from
  // was never read again: the sheet did not apply until something else
  // restyled the document.
  let answer!: (result: ResourceResult) => void;
  const { node } = await mount(
    '<link rel="stylesheet" href="a.css"><p id="p">text</p>',
    (r) =>
      r.kind === 'stylesheet'
        ? new Promise<ResourceResult>((resolve) => (answer = resolve))
        : null,
  );
  await settle(node);
  assert.notStrictEqual(boxOf(node, 'p').style.color, '#ff0000');
  answer({ kind: 'stylesheet', text: 'p { color: #ff0000 }' });
  await settle(node);
  assert.strictEqual(boxOf(node, 'p').style.color, '#ff0000');
});

test('imports nest, and a cycle of them is read once', async () => {
  const asked: string[] = [];
  const sheets: Record<string, string> = {
    'a.css': '@import "b.css"; p { color: #ff0000 }',
    'b.css': '@import "c.css"; @import "a.css";',
    'c.css': 'p { color: #0000ff; background-color: #00ff00 }',
  };
  const { node } = await mount(
    '<style>@import "a.css";</style><p id="p">x</p>',
    (r) => {
      asked.push(r.url);
      const text = sheets[r.url];
      return text ? { kind: 'stylesheet', text } : null;
    },
  );
  assert.deepStrictEqual(asked.sort(), ['a.css', 'b.css', 'c.css']);
  const p = boxOf(node, 'p') as unknown as {
    style: { color: string; backgroundColor: string };
  };
  assert.strictEqual(p.style.backgroundColor, '#00ff00', 'the deepest applies');
  assert.strictEqual(p.style.color, '#ff0000', 'and the importer wins a tie');
});

const metric = FONTS ? test : test.skip;

metric('links, the handle and fragments speak the resolved URL', async () => {
  const clicks: string[] = [];
  let handle!: ReturnType<typeof useHtmlHandle>;
  function Doc() {
    handle = useHtmlHandle();
    return h(Html, {
      source:
        '<p><a href="../other.html#top">a link here</a></p>' +
        '<div style="height:300px"></div><h2 id="target">Target</h2>' +
        '<p>text <a name="anchor"></a>after</p>',
      baseUrl: 'https://example.test/docs/page.html',
      partial: false,
      ref: handle.ref,
      onLink: (href: string) => clicks.push(href),
      'data-testname': 'doc',
    });
  }
  await renderX11(
    h('box', { style: { width: 400, flexDirection: 'column' } }, h(Doc)),
    { width: 440, height: 600, fonts: FONTS! },
  );
  const node = view(screen.getByTestName('doc') as DrawnNode);
  const caret = node.textCaretRect(2)!;
  const x = caret.x + 1;
  const y = caret.y + caret.height / 2;
  assert.strictEqual(
    handle.hrefAt(x, y),
    'https://example.test/other.html#top',
  );
  assert.strictEqual(handle.base, 'https://example.test/docs/page.html');

  const doc = handle.document!;
  const byId = (id: string) => {
    let hit: unknown = null;
    const walk = (n: {
      children?: unknown[];
      attribs?: Record<string, string>;
    }) => {
      if (n.attribs?.id === id || n.attribs?.name === id) hit = n;
      for (const c of (n.children ?? []) as (typeof n)[]) walk(c);
    };
    walk(doc as unknown as { children: unknown[] });
    return hit as Parameters<typeof handle.elementRect>[0];
  };
  const target = handle.elementRect(byId('target'));
  assert.ok(target, 'a block has a rect');
  assert.ok(target.y > 300, `below the spacer: ${target.y}`);
  assert.ok(target.width > 300, 'the width of the column');
  const anchor = handle.elementRect(byId('anchor'));
  assert.ok(anchor, 'an empty inline element is where its text would be');
  assert.ok(anchor.y > target.y, 'after the heading');
  assert.strictEqual(anchor.width, 0);
});

// --- fonts --------------------------------------------------------------------

/** The family a paragraph's text is set in, as the font manager resolves
 *  its list. */
function familyOf(
  app: {
    fonts: { match(family: string, opts?: object): { familyName: string } };
  },
  style: { fontFamily: string },
  weight = 400,
): string {
  return app.fonts.match(style.fontFamily, { weight }).familyName;
}

const FACES =
  '@font-face { font-family: Doc; src: url(r.woff2) format("woff2"); }' +
  '@font-face { font-family: Doc; font-weight: 700;' +
  '  src: url(b.woff2) format("woff2"); }' +
  '@font-face { font-family: Doc; src: url(cyr.woff2) format("woff2");' +
  '  unicode-range: U+0400-045F; }' +
  '@font-face { font-family: Unused; src: url(u.woff2); }';

function fontHost(asked: string[], sync = true): Answer {
  return (r) => {
    asked.push(`${r.kind} ${r.url}`);
    if (r.kind !== 'font') return null;
    const bytes = r.url.endsWith('b.woff2') ? BOLD! : REGULAR!;
    const result: ResourceResult = { kind: 'font', bytes };
    return sync ? result : Promise.resolve(result);
  };
}

withFonts(
  'a face loads when the document uses it, and its family draws the text',
  async () => {
    const asked: string[] = [];
    const { node, result } = await mount(
      `<style>${FACES} p { font-family: Doc, sans-serif }</style>` +
        '<p id="p">Plain text</p>',
      fontHost(asked, false),
      {},
      true,
    );
    await settle(node);
    assert.deepStrictEqual(
      asked,
      ['font r.woff2'],
      'the regular face only: no bold text, no Cyrillic, nothing Unused',
    );
    const p = boxOf(node, 'p');
    assert.match(p.style.fontFamily, /^html webfont [a-z]+, sans-serif$/);
    assert.strictEqual(familyOf(result.app as never, p.style), 'KaTeX_Main');
  },
);

withFonts(
  'until a face arrives, its family is left out of the list',
  async () => {
    const { node } = await mount(
      `<style>${FACES} p { font-family: Doc, monospace }</style>` +
        '<p id="p">x</p><div id="d">y</div>',
      (r) => (r.kind === 'font' ? new Promise(() => {}) : null),
      {},
      true,
    );
    await settle(node);
    const p = boxOf(node, 'p').style;
    const d = boxOf(node, 'd').style;
    // Not `monospace` alone, which the cascade sets at 13/16: the list the
    // author wrote is not that one, and the text would jump when Doc came.
    assert.strictEqual(p.fontFamily, 'monospace, monospace');
    assert.strictEqual(p.fontSize, d.fontSize, 'the size the list has');
  },
);

withFonts(
  'bold text asks for the bold face, and Cyrillic for its range',
  async () => {
    const asked: string[] = [];
    const { node, result } = await mount(
      `<style>${FACES} body { font-family: Doc }</style>` +
        '<p id="p">Plain, and <b id="b">bold</b>, and Привет</p>',
      fontHost(asked),
      {},
      true,
    );
    await settle(node);
    assert.deepStrictEqual(asked.sort(), [
      'font b.woff2',
      'font cyr.woff2',
      'font r.woff2',
    ]);
    // the range with the most of the document's characters leads the list,
    // and the font manager picks the weight among that name's faces
    const [first] = boxOf(node, 'b').style.fontFamily.split(', ');
    const fonts = (
      result.app as unknown as {
        fonts: { match(f: string, o: object): { postscriptName: string } };
      }
    ).fonts;
    assert.strictEqual(
      fonts.match(first, { weight: 700 }).postscriptName,
      'KaTeX_Main-Bold',
    );
    assert.strictEqual(
      fonts.match(first, { weight: 400 }).postscriptName,
      'KaTeX_Main-Regular',
    );
  },
);

withFonts('a range the text reaches only later is asked for then', async () => {
  // a stream: the Latin first, and the Cyrillic further down, after the
  // family's weights were asked for
  const asked: string[] = [];
  const head = `<style>${FACES} body { font-family: Doc }</style><p>Plain</p>`;
  const doc = (source: string) =>
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, { source, onResource: fontHost(asked), 'data-testname': 'doc' }),
    );
  const result = await renderX11(doc(head), {
    width: 440,
    height: 300,
    fonts: FONTS!,
  });
  const node = view(screen.getByTestName('doc') as DrawnNode);
  await settle(node);
  assert.deepStrictEqual(asked, ['font r.woff2']);
  await result.rerender(doc(`${head}<p>Привет</p>`));
  await settle(node);
  assert.deepStrictEqual(asked.sort(), ['font cyr.woff2', 'font r.woff2']);
});

withFonts(
  'a source the host declines is passed over for the next',
  async () => {
    const asked: string[] = [];
    const { node } = await mount(
      '<style>@font-face { font-family: Doc;' +
        '  src: url(x.eot?#iefix) format("embedded-opentype"),' +
        '       url(gone.woff2) format("woff2"), url(r.woff) format("woff") }' +
        'p { font-family: Doc }</style><p id="p">x</p>',
      (r) => {
        asked.push(r.url);
        return r.url === 'r.woff' ? { kind: 'font', bytes: REGULAR! } : null;
      },
      {},
      true,
    );
    await settle(node);
    assert.deepStrictEqual(asked, ['gone.woff2', 'r.woff'], 'no EOT asked for');
    assert.match(boxOf(node, 'p').style.fontFamily, /^html webfont/);
  },
);

withFonts(
  'a face that is not a font leaves its family out for good',
  async () => {
    const { node } = await mount(
      '<style>@font-face { font-family: Doc; src: url(r.woff2) }' +
        'p { font-family: Doc, monospace }</style><p id="p">x</p>',
      (r) =>
        r.kind === 'font'
          ? { kind: 'font', bytes: new Uint8Array([1, 2, 3, 4]) }
          : null,
      {},
      true,
    );
    await settle(node);
    assert.strictEqual(
      boxOf(node, 'p').style.fontFamily,
      'monospace, monospace',
    );
  },
);

withFonts(
  'documents that declare a family alike share it; one that differs does not',
  async () => {
    const first: string[] = [];
    const second: string[] = [];
    const third: string[] = [];
    const doc = (name: string) =>
      `<style>@font-face { font-family: Doc; src: url(${name}) }` +
      `p { font-family: Doc }</style><p id="p">x</p>`;
    await renderX11(
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source: doc('r.woff2'),
          partial: false,
          onResource: fontHost(first),
          'data-testname': 'one',
        }),
        h(Html, {
          source: doc('r.woff2'),
          partial: false,
          onResource: fontHost(second),
          'data-testname': 'two',
        }),
        h(Html, {
          source: doc('b.woff2'),
          partial: false,
          onResource: fontHost(third),
          'data-testname': 'three',
        }),
      ),
      { width: 440, height: 300, fonts: FONTS! },
    );
    const one = view(screen.getByTestName('one') as DrawnNode);
    const two = view(screen.getByTestName('two') as DrawnNode);
    const three = view(screen.getByTestName('three') as DrawnNode);
    await settle(one);
    await settle(two);
    await settle(three);
    assert.deepStrictEqual(first, ['font r.woff2']);
    assert.deepStrictEqual(second, [], 'the second found it registered');
    assert.deepStrictEqual(third, ['font b.woff2']);
    const family = (n: HtmlViewNode) => boxOf(n, 'p').style.fontFamily;
    assert.strictEqual(family(one), family(two));
    assert.notStrictEqual(
      family(one),
      family(three),
      'another file, another name',
    );
  },
);

withFonts(
  "a document's family does not leak into the window around it",
  async () => {
    const { result, node } = await mount(
      `<style>${FACES} p { font-family: Doc }</style><p id="p">x</p>`,
      fontHost([]),
      {},
      true,
    );
    await settle(node);
    const app = result.app as never;
    assert.notStrictEqual(familyOf(app, { fontFamily: 'Doc' }), 'KaTeX_Main');
    assert.strictEqual(familyOf(app, boxOf(node, 'p').style), 'KaTeX_Main');
  },
);
