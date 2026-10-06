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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import React from 'react';

import { renderX11, cleanup, screen, act } from 'react-x11/test';
import { openFont } from 'react-x11';
import type { DrawnNode } from 'react-x11';

import { Html, useHtmlHandle } from '../src/html/index.js';
import type {
  HtmlViewNode,
  ResourceRequest,
  ResourceResult,
} from '../src/html/index.js';
import { absoluteUrls, parseStylesheet } from '../src/html/css/parse.js';
import type { FontFaceRule } from '../src/html/css/parse.js';
import { bestFace, refusal } from '../src/html/fonts.js';
import { decodeGif } from '../src/html/gif.js';
import { fontAxes } from '../src/html/layout/axes.js';
import type { FontsLike } from '../src/html/layout/inline.js';
import { isWoff2, woff2ToSfnt } from '../src/html/woff2.js';
import { resolveUrl } from '../src/html/url.js';

const h = React.createElement;

afterEach(cleanup);

// Real font files, as in html/harness.ts: DejaVu on Linux, Arial on macOS, and
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

/** The family the harness's sans-serif file is, which is what a `local()`
 *  can name there: the font manager has that one family to find. */
const LOCAL = found?.[0].includes('Arial') ? 'Arial' : 'DejaVu Sans';

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

// A variable font as the web serves one, WOFF2, small enough to sit here:
// a rectangle for `x` and a `wght` axis, 100 to 900 from 400, that widens
// it. Made with fontTools' FontBuilder (`setupFvar`, `setupGvar`) and saved
// with `flavor = 'woff2'`, its `glyf` transformed as an encoder leaves one.
const WEDGE =
  'd09GMgABAAAAAAGEAAwAAAAAA0QAAAE4AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAAPC8kCjRC' +
  'MEYBNgIkAwwLCAAEIAWBBAcoG3kCAC4K7IZjh1jyDM0e0WMpJzQ1hGgtM7v7RXAoUZ2qA2FqAY1s' +
  'JZB9I2tEWdVYQE+kbtsfiqmbosUsfOwHk9yE5AEpRd38VwtYd/xdDni7HAR/+c1iDyTKy4JECsP0' +
  'hosS5RD5lHc/yrFm1BQuAZg+CiM2c/9T5BFXAIARkJDRJwv0KUbRoAjJiM1/9M//XyMAgS5J6EPT' +
  'hrIREHXyHgSQQQMSmtACKCAQpbTW2ktrbk3Vcf1Y9XL1AgQCDMhArf6tpEvblhnWO2d7NlHfmsn2' +
  '4cw2eY9AcDTxeX382pTzEzzcVMrcJC7TMbIEggsuxItKFZcCAJC3d38RkyqBrAiQAADQYI6BUEOA' +
  'pFFNQNCgTRalWWjRo5p0GCiDNuPz/+VkVkY2NYyNgtBC8l3HS6gKqbmSOWIZAA==';
const wedge = (): Uint8Array => new Uint8Array(Buffer.from(WEDGE, 'base64'));

// The same and a `wdth` axis besides, 50 to 200 from 100: an `x`, and a
// `0` in the same glyph, 500 units wide at the defaults, 250 wider at the
// heaviest and 200 narrower at the lightest, and twice as wide at the
// widest and half at the narrowest, linear either side of each default
// (`spreadX`).
const SPREAD =
  'd09GMgABAAAAAAGoAAwAAAAAA5wAAAFdAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAARC84Chg4' +
  'MHIBNgIkAwwLCAAEIAWBLgcoG+ECAJ4FztmHVlGCRvCCF7hd8Tzvfuh9SQoIbmPNRhMJ28qNbYWd' +
  'UcCyxm58PMFXt01DMXVT1PAoh5//YBC5oRcTx+A/lxSlp27qj23/Tds2AWBMDDANLADpPNE4oAQS' +
  'CETSHbJjiiKmrzt7oppH2dOjiSCAp++Fdbt1vUNdtw8AWAcFFdOqYFpzFP36Faw7areb+s3u7Z8A' +
  'CMYVxTSGd8wTAtmj3oPYuZ6OjutgHxJQQS+Chh5AA5CWnpHmxdcXQFDAsgqWAQduNduGbzkDSN84' +
  'nDl6w+2zvt+3zvi3H7bf6aiOn6/5uuTrTnegdwjC+8curXbiW3+tX+DTh8+XcSJfywtUBYT7r/lK' +
  'VQPsa77iN8gGVUsocNfT76YCohcBRZ9egdBrRCDRY0qVNiCGzeu0GLVdCMOObzHolLNW65HVeFjV' +
  '729fANNxKSYGZZ6NXUQF4xIJIrlqzDWncw==';
const spread = (): Uint8Array => new Uint8Array(Buffer.from(SPREAD, 'base64'));

/** How wide the spread's `x` is at a width and a weight, in its em's
 *  thousandths. */
function spreadX(wdth: number, wght = 400): number {
  const width =
    wdth < 100 ? (-250 * (100 - wdth)) / 50 : (500 * (wdth - 100)) / 100;
  const weight =
    wght < 400 ? (-200 * (400 - wght)) / 300 : (250 * (wght - 400)) / 500;
  return 500 + width + weight;
}

// A font with each thing a WOFF2 stores another way, and the TrueType it
// was made from: a box whose contour overlaps itself, an instructed glyph
// of two contours with curves and a move of every width a triplet has, a
// composite of the two with a scale, and side bearings that equal `xMin`
// throughout, so `hmtx` is transformed too. fontTools' FontBuilder, saved
// with `WOFF2FlavorData(transformedTables={'glyf', 'loca', 'hmtx'})`.
const PIECES_WOFF2 =
  'd09GMgABAAAAAAGEAAoAAAAAAugAAAE6AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAAPAp4fwE2' +
  'AiRDFAsLDAAEIAVdBywbKAIArgpscE1Piie7zag3Lxx+zFIaPaqI8fC5Rr6fZPcAaNXNabQsLJTA' +
  '6FY6IFlf2fHIkiCD5xZNM0zdfyuwKirx2flkzxAI+Ma4GeNVFSvNQnmLTyfHd7tB80sUWQuY8gAT' +
  'DJBzGwOX4BGFTuO4UW53I6EKcsCOFTpXPaYDCRmTssCkYg2tIiSdq7Wic7nW+rJ+IIDQgH5kjGAR' +
  'oxhEC0KqtYg80AyVo553asK162cfj+unB8qHv96OyvCtyfvqq9txJ+e0KhEjcjpVv3R6Yf23HnyT' +
  'vh1uI51A8OgG5eJI+CZy/gDvXnVuW/9aIP1DlkCQu2qYemH92w0BAGhyOiUdCYNANAYkI7IEAJJA' +
  'sS1AaBEg6dHKovQJg4Z6JcPmBrl8h+oGldWoN7o0RrPHoXVCLJrf8lCUAQAAAA==';
const PIECES_TTF =
  'AAEAAAAKAIAAAwAgT1MvMkEXRecAAAEoAAAAYGNtYXAAtgA8AAABnAAAADxnbHlmPhi9ZgAAAeQA' +
  'AAB2aGVhZEImqBUAAACsAAAANmhoZWEYbQqSAAAA5AAAACRobXR4H0AAtAAAAYgAAAAUbG9jYQAr' +
  'AEgAAAHYAAAADG1heHAADQAdAAABCAAAACBuYW1l1ZcRlgAAAlwAAABdcG9zdABPAIoAAAK8AAAA' +
  'LAABAAAAAQAABekIbF8PPPUAAwPoAAAAAObit/gAAAAA5uK3+AAy9EgVGAL9AAAAAwACAAAAAAAA' +
  'AAEAAAMg/zgAABXgADL1dBUYAAEAAAAAAAAAAAAAAAAAAAAFAAEAAAAFAAsAAgAPAAMAAgAAAAAA' +
  'AAAAAAAAAAACAAEAAwZAAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB' +
  'AAAAAAAAAAAAAAAAPz8/PwAAACAAYwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAACWAAAAlgA' +
  'AAJYADIV4ABQAlgAMgAAAAIAAAADAAAAFAADAAEAAAAUAAQAKAAAAAYABAABAAIAIABj//8AAAAg' +
  'AGH////h/6EAAQAAAAAAAAAAAAAAAAANACsAOwABADIAAAHCArwAAwAAcxEhETIBkAK8/UQAAAIA' +
  'UPRIFRgC/QAHAAoAA7ABIRcRNhchFQEBExIBUAoKBLAQBOtMZGQBOMgDwAUFAfFRCvABLAFA/sAA' +
  '//8AMvoQDOQCvAImAAIAAAEPAAMCWP/sIAAAA7ACIQAAAAAAAAQANgABAAAAAAABAAYAAAABAAAA' +
  'AAACAAcABgADAAEECQABAAwADQADAAEECQACAA4AGVBpZWNlc1JlZ3VsYXIAUABpAGUAYwBlAHMA' +
  'UgBlAGcAdQBsAGEAcgAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAADAEQA' +
  'RQBG';
const brotli = (data: Uint8Array): Uint8Array =>
  new Uint8Array(brotliDecompressSync(data));

/** An sfnt's tables, by tag. */
function tablesOf(sfnt: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < view.getUint16(4); i += 1) {
    const at = 12 + 16 * i;
    const from = view.getUint32(at + 8);
    tables.set(
      String.fromCharCode(...sfnt.subarray(at, at + 4)),
      sfnt.subarray(from, from + view.getUint32(at + 12)),
    );
  }
  return tables;
}

/**
 * Each glyph of an sfnt as what it draws, whichever way its record packs
 * it: a simple glyph's box, where its contours end, its instructions and
 * its points — where each is, on the curve or off it, and the first one's
 * overlap flag — and a composite's record less its padding.
 */
function outlinesOf(tables: Map<string, Uint8Array>): string[] {
  const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.length);
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const long = dv(tables.get('head')!).getInt16(50) === 1;
  const loca = dv(tables.get('loca')!);
  const glyf = tables.get('glyf')!;
  const count = dv(tables.get('maxp')!).getUint16(4);
  const at = (i: number) =>
    long ? loca.getUint32(i * 4) : loca.getUint16(i * 2) * 2;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = glyf.subarray(at(i), at(i + 1));
    if (!bytes.length) {
      out.push('');
      continue;
    }
    const g = dv(bytes);
    const contours = g.getInt16(0);
    if (contours < 0) {
      let end = bytes.length;
      while (end > 0 && bytes[end - 1] === 0) end -= 1;
      out.push(`composite ${hex(bytes.subarray(0, end))}`);
      continue;
    }
    const box = [2, 4, 6, 8].map((o) => g.getInt16(o));
    let p = 10;
    const ends: number[] = [];
    for (let c = 0; c < contours; c += 1, p += 2) ends.push(g.getUint16(p));
    const length = g.getUint16(p);
    const program = hex(bytes.subarray(p + 2, p + 2 + length));
    p += 2 + length;
    const flags: number[] = [];
    while (flags.length <= ends[contours - 1]) {
      const flag = bytes[p++];
      flags.push(flag);
      if (flag & 8) for (let r = bytes[p++]; r > 0; r -= 1) flags.push(flag);
    }
    const axis = (short: number, same: number): number[] => {
      let v = 0;
      return flags.map((flag) => {
        if (flag & short) v += flag & same ? bytes[p++] : -bytes[p++];
        else if (!(flag & same)) {
          v += g.getInt16(p);
          p += 2;
        }
        return v;
      });
    };
    const xs = axis(2, 16);
    const ys = axis(4, 32);
    const points = flags.map(
      (flag, n) => `${xs[n]},${ys[n]},${flag & (n ? 1 : 65)}`,
    );
    out.push(JSON.stringify([box, ends, program, points]));
  }
  return out;
}

/** `console.warn` and `console.error` held for a test, as the lines said. */
function quiet(t: { after(fn: () => void): void }): {
  warned: string[];
  errors: string[];
} {
  const { warn, error } = console;
  const said = { warned: [] as string[], errors: [] as string[] };
  console.warn = (message: unknown) => void said.warned.push(String(message));
  console.error = (message: unknown) => void said.errors.push(String(message));
  t.after(() => {
    console.warn = warn;
    console.error = error;
  });
  return said;
}

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

test('the string an image-set() option starts with is a URL, and comes out absolute as a url() does', () => {
  // CSS Images 4, 2.4: `image-set("a.png" 1x)` names the image a `url()`
  // would, and it was left relative, to be resolved by a host that cannot
  // know which sheet it came from
  const base = 'https://example.test/css/site.css';
  const abs = (name: string) => `url("https://example.test/css/${name}")`;
  assert.strictEqual(
    absoluteUrls(`image-set('a.png' 1x, "b.png" type("image/png") 2x)`, base),
    `image-set(${abs('a.png')} 1x, ${abs('b.png')} type("image/png") 2x)`,
    "and a type()'s string is a string",
  );
  assert.strictEqual(
    absoluteUrls('-webkit-image-set( "a.png" 1x , url(b.png) 2x)', base),
    `-webkit-image-set( ${abs('a.png')} 1x , ${abs('b.png')} 2x)`,
  );
  assert.strictEqual(
    absoluteUrls('image-set(linear-gradient(red, blue) 1x, "c.png")', base),
    `image-set(linear-gradient(red, blue) 1x, ${abs('c.png')})`,
  );
  assert.strictEqual(
    absoluteUrls(`var(--x, image-set('v.png'))`, base),
    `var(--x, image-set(${abs('v.png')}))`,
  );
  for (const same of [
    '"a.png"',
    'foo-image-set("a.png")',
    'image-set("#a" 1x, "data:image/png;base64,AAAA" 2x)',
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
       font-stretch: 100% 75%;
       unicode-range: U+0000-00FF, U+0131, U+4??;
     }
     @font-face { font-family: Icons Two; src: url(i.ttf); font-weight: bold;
                  font-family: not, a list; unicode-range: nonsense;
                  font-stretch: condensed; font-stretch: -10% }
     @font-face { font-family: sans-serif; src: url(hijack.ttf) }
     @font-face { font-family: "Only Local";
                  src: local(Gentium Bold), local("Gentium-Bold") }
     @font-face { font-family: Keyword; src: local(inherit), local(serif) }
     @font-face { font-family: Nothing; src: format("woff2") }
     @media (max-width: 600px) {
       @font-face { font-family: Small; src: url(s.woff2) }
     }`,
    0,
    new Map(),
    'https://example.test/css/fonts.css',
  );
  const [open, icons, local, small] = sheet.fontFaces;
  assert.deepStrictEqual(
    sheet.fontFaces.map((f) => f.family),
    ['Open Sans', 'Icons Two', 'Only Local', 'Small'],
    'no generic name, and no rule without a source',
  );
  assert.deepStrictEqual(open, {
    family: 'Open Sans',
    sources: [
      { local: 'Open Sans' },
      { url: 'https://example.test/css/os.woff2', format: 'woff2' },
      { url: 'https://example.test/css/os.woff', format: 'woff' },
      {
        url: 'https://example.test/css/os.eot?#iefix',
        format: 'embedded-opentype',
      },
    ],
    weight: [300, 800],
    style: 'italic',
    stretch: [75, 100],
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
  assert.deepStrictEqual(
    icons.stretch,
    [75, 75],
    'a keyword is its width, and a width below nothing is dropped',
  );
  assert.strictEqual(local.stretch, null, 'and none is `auto`');
  // A family of `local()`s alone is a family the document declares, and its
  // rule is kept: dropped, the name went to the system as any other would.
  assert.deepStrictEqual(
    local.sources,
    [{ local: 'Gentium Bold' }, { local: 'Gentium-Bold' }],
    'a name as identifiers or as a string, and never a keyword',
  );
  assert.strictEqual(small.family, 'Small');
  assert.ok(small.media, 'a face in @media keeps its condition');
});

test('a face is matched as CSS Fonts 4 matches one', () => {
  const face = (
    lo: number,
    hi = lo,
    style: 'normal' | 'italic' = 'normal',
    stretch: [number, number] | null = null,
  ) => ({
    rule: {
      family: 'F',
      sources: [],
      weight: [lo, hi] as [number, number],
      style,
      stretch,
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
  // and the width before both: at or under normal the nearest narrower,
  // then the nearest wider, and over it the other way round
  const widths = [
    face(400, 400, 'normal', null),
    face(500, 500, 'normal', [75, 75]),
    face(600, 600, 'normal', [125, 150]),
  ];
  const width = (w: number) => bestFace(widths, 400, false, w)?.rule.weight[0];
  assert.strictEqual(width(100), 400, '`auto` is the normal width');
  assert.strictEqual(width(80), 500, 'narrower first');
  assert.strictEqual(width(50), 500, 'then wider');
  assert.strictEqual(width(110), 600, 'over normal, wider first');
  assert.strictEqual(width(140), 600, 'inside a range');
  assert.strictEqual(width(300), 600, 'then narrower');
  assert.strictEqual(
    bestFace(
      [face(400, 400, 'italic'), face(400, 400, 'normal', [75, 75])],
      400,
      true,
      75,
    )?.rule.style,
    'normal',
    'the width before the slant',
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
    '<link rel="stylesheet" href="css/site.css"><p id="p">x</p><div></div>',
    (r) => {
      asked.push(r.url);
      if (r.url === 'https://example.test/css/site.css') {
        return {
          kind: 'stylesheet',
          text:
            '@import "more.css"; p { background: url(../img/bg.png) }' +
            // an image-set()'s strings are its URLs, and this its 1x
            'div { background: image-set("../img/a.png", "../img/b.png" 2x) }',
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
    'https://example.test/img/a.png',
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
  // A sheet the body links to arrives this way over a network; one the
  // head links to holds the first paint instead (`test/html/element`). The
  // arrival rebuilt the boxes, and the cascade the boxes are styled from
  // was never read again: the sheet did not apply until something else
  // restyled the document.
  let answer!: (result: ResourceResult) => void;
  const { node } = await mount(
    '<p id="p">text</p><link rel="stylesheet" href="a.css">',
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

// --- local() ------------------------------------------------------------------

withFonts(
  'a family of local() faces is the family the system has, by that name',
  async () => {
    // next/font's fallback: `"GeistSans Fallback"` is Arial with its metrics
    // adjusted, declared with no file at all. The rule was dropped for
    // having no `url()`, so the name reached the font manager as written,
    // and a name nobody has is answered with a guess.
    const asked: string[] = [];
    let arrive!: (result: ResourceResult) => void;
    const { node, result } = await mount(
      '<style>@font-face { font-family: Doc; src: url(r.woff2) }' +
        `@font-face { font-family: "Doc Fallback"; src: local("${LOCAL}");` +
        '  ascent-override: 92%; size-adjust: 104% }' +
        'p { font-family: Doc, "Doc Fallback" }</style><p id="p">Plain</p>',
      (r) => {
        asked.push(r.url);
        return new Promise((resolve) => (arrive = resolve));
      },
      {},
      true,
    );
    await settle(node);
    assert.deepStrictEqual(
      asked,
      ['r.woff2'],
      'a local() asks the host nothing',
    );
    // and the list ends in the document's own family, having no generic —
    // the system's, and after it the name that marks it as the face whose
    // metrics its rule adjusts, which no engine has
    assert.match(
      boxOf(node, 'p').style.fontFamily,
      new RegExp(`^${LOCAL}, html webfont [a-z]+, sans-serif$`),
    );
    arrive({ kind: 'font', bytes: REGULAR! });
    await settle(node);
    const p = boxOf(node, 'p').style;
    assert.match(
      p.fontFamily,
      new RegExp(
        `^html webfont [a-z]+, ${LOCAL}, html webfont [a-z]+, sans-serif$`,
      ),
    );
    assert.strictEqual(familyOf(result.app as never, p), 'KaTeX_Main');
  },
);

test("@font-face's size-adjust and metric overrides are percentages, an override's `normal` its face's own", () => {
  const faces = parseStylesheet(
    '@font-face { font-family: A; src: local(Arial); size-adjust: 280%;' +
      '  ascent-override: 92%; descent-override: 300%; line-gap-override: 0% }' +
      '@font-face { font-family: B; src: local(Arial); size-adjust: 100%;' +
      '  ascent-override: 90%; ascent-override: normal;' +
      // none below nought, and no `normal` for a size
      '  descent-override: -5%; size-adjust: normal; line-gap-override: 1px }',
  ).fontFaces;
  const metrics = (f: FontFaceRule) => [
    f.sizeAdjust,
    f.ascentOverride,
    f.descentOverride,
    f.lineGapOverride,
  ];
  assert.deepStrictEqual(metrics(faces[0]), [2.8, 0.92, 3, 0]);
  assert.deepStrictEqual(metrics(faces[1]), [
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

/** Each line's width, height and baseline under an element, from its
 *  top. */
function linesUnder(node: HtmlViewNode, id: string) {
  const box = boxOf(node, id) as unknown as {
    y: number;
    lines: { width: number; height: number; y: number; baseline: number }[];
  };
  return box.lines.map((l) => ({
    width: Math.round(l.width * 10) / 10,
    height: Math.round(l.height * 10) / 10,
    baseline: Math.round((l.y + l.baseline - box.y) * 10) / 10,
  }));
}

withFonts(
  "a face's size-adjust scales its glyphs and its metrics overrides set its lines, as Chromium sets them",
  async () => {
    const { node } = await mount(
      `<style>@font-face { font-family: Big; src: local("${LOCAL}"); size-adjust: 200% }` +
        `@font-face { font-family: Lined; src: local("${LOCAL}");` +
        '  ascent-override: 150%; descent-override: 50%; line-gap-override: 0% }' +
        `@font-face { font-family: Deep; src: local("${LOCAL}"); descent-override: 300% }` +
        'div { font-size: 18px; line-height: normal; white-space: nowrap }' +
        `#big { font-family: Big } #plain, #own { font-family: ${LOCAL}, serif }` +
        '#lined { font-family: Lined } #deep { font-family: Deep; line-height: 1.4 }' +
        '</style><div id="big">0 0</div><div id="plain">0 0</div>' +
        '<div id="own">0 0</div><div id="lined">0 0</div><div id="deep">0 0</div>',
      () => null,
      {},
      true,
    );
    await settle(node);
    const [big] = linesUnder(node, 'big');
    const [plain] = linesUnder(node, 'plain');
    // twice the size, to the 64th of a pixel each run's advance rounds to
    assert.ok(
      Math.abs(big.width / plain.width - 2) < 0.01,
      `${big.width} against ${plain.width}`,
    );
    // an author's own list naming the family the face came to is not the
    // face, and is set at its own size
    assert.deepStrictEqual(linesUnder(node, 'own'), [plain]);
    // `normal` lines are the overrides' together: 150% and 50% of 18px
    assert.deepStrictEqual(
      linesUnder(node, 'lined').map((l) => [l.height, l.baseline]),
      [[36, 27]],
    );
    // and under a line height of its own the line is that tall, the text
    // standing where its metrics put it: a descent of three ems takes the
    // baseline over the line's top, as Chromium draws it
    const [deep] = linesUnder(node, 'deep');
    assert.strictEqual(deep.height, 25.2);
    assert.ok(deep.baseline < 0, `baseline ${deep.baseline}`);
  },
);

withFonts(
  "a face from a url() is set at its size-adjust, and an override answers the layout's metrics",
  async () => {
    const { node } = await mount(
      '<style>@font-face { font-family: Doc; src: url(r.woff2); size-adjust: 150%;' +
        '  ascent-override: 100%; descent-override: 0%; line-gap-override: 0% }' +
        '@font-face { font-family: Same; src: url(r.woff2) }' +
        'div { font-size: 20px; line-height: normal; white-space: nowrap }' +
        '#a { font-family: Doc } #b { font-family: Same }' +
        '</style><div id="a">Plain</div><div id="b">Plain</div>',
      () => ({ kind: 'font', bytes: REGULAR! }),
      {},
      true,
    );
    await settle(node);
    const [a] = linesUnder(node, 'a');
    const [b] = linesUnder(node, 'b');
    assert.ok(
      Math.abs(a.width / b.width - 1.5) < 0.01,
      `${a.width} against ${b.width}`,
    );
    // all of a line is its ascent, a hundred percent of 20px half again
    assert.deepStrictEqual([a.height, a.baseline], [30, 30]);
  },
);

test('a local() the system lacks leaves its family out of the list', async () => {
  // CSS Fonts 4 (5.2): a family `@font-face` defines with no face present
  // is missing, and a platform font is not matched by its name. On the
  // mock backend, which has no font manager to ask, and so no face.
  const { node } = await mount(
    '<style>@font-face { font-family: Gone; src: local("No Such Face") }' +
      'p { font-family: Gone, monospace } div { font-family: Gone }</style>' +
      '<p id="p">x</p><div id="d">y</div>',
    () => null,
  );
  await settle(node);
  assert.strictEqual(boxOf(node, 'p').style.fontFamily, 'monospace, monospace');
  assert.strictEqual(
    boxOf(node, 'd').style.fontFamily,
    'sans-serif',
    "the document's default, where the list names nothing else",
  );
});

withFonts('a face is not found by a name it does not have', async () => {
  // The font manager answers any family with its best guess — here the one
  // file it has. The guess is a face, and not the one that was named.
  const { node } = await mount(
    '<style>@font-face { font-family: Gone; src: local("No Such Face") }' +
      'p { font-family: Gone, monospace }</style><p id="p">x</p>',
    () => null,
    {},
    true,
  );
  await settle(node);
  assert.strictEqual(boxOf(node, 'p').style.fontFamily, 'monospace, monospace');
});

withFonts(
  'the sources of a face are tried in the order src has them',
  async () => {
    const asked: string[] = [];
    const { node, result } = await mount(
      '<style>' +
        // the system has it: nothing is asked for
        `@font-face { font-family: Here; src: local("${LOCAL}"), url(here.woff2) }` +
        // it does not: the file is
        '@font-face { font-family: Away;' +
        '  src: local("No Such Face"), url(r.woff2) }' +
        // and a file the host declines falls to the face the system has
        `@font-face { font-family: Last; src: url(gone.woff2), local("${LOCAL}") }` +
        '#a { font-family: Here, monospace } #b { font-family: Away, monospace }' +
        '#c { font-family: Last, monospace }</style>' +
        '<p id="a">x</p><p id="b">y</p><p id="c">z</p>',
      (r) => {
        asked.push(r.url);
        return r.url === 'r.woff2' ? { kind: 'font', bytes: REGULAR! } : null;
      },
      {},
      true,
    );
    await settle(node);
    assert.deepStrictEqual(asked.sort(), ['gone.woff2', 'r.woff2']);
    assert.strictEqual(
      boxOf(node, 'a').style.fontFamily,
      `${LOCAL}, monospace`,
    );
    const away = boxOf(node, 'b').style;
    assert.match(away.fontFamily, /^html webfont [a-z]+, monospace$/);
    assert.strictEqual(familyOf(result.app as never, away), 'KaTeX_Main');
    assert.strictEqual(
      boxOf(node, 'c').style.fontFamily,
      `${LOCAL}, monospace`,
    );
  },
);

withFonts(
  'a second document finds a local() face where the first left it',
  async () => {
    const source =
      `<style>@font-face { font-family: Doc; src: local("${LOCAL}") }` +
      'p { font-family: Doc, monospace }</style><p id="p">x</p>';
    await renderX11(
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, { source, partial: false, 'data-testname': 'one' }),
        h(Html, { source, partial: false, 'data-testname': 'two' }),
      ),
      { width: 440, height: 300, fonts: FONTS! },
    );
    for (const name of ['one', 'two']) {
      const node = view(screen.getByTestName(name) as DrawnNode);
      await settle(node);
      assert.strictEqual(
        boxOf(node, 'p').style.fontFamily,
        `${LOCAL}, monospace`,
        `${name}: the family, and not a name nothing was registered under`,
      );
    }
  },
);

withFonts(
  'a variable WOFF2 is set in its face, whether or not the engine cuts an instance out of the container',
  async (t) => {
    // ntk sets a variable face at the weight a style asks for by cutting an
    // instance out of it, inside `match`, and fontkit cut none out of a
    // WOFF2: the first bold word of nextjs.org's blog, in Geist, threw out
    // of its layout and the page was left blank. An engine that can cut one
    // takes the file as served; one that cannot is handed the font inside
    // it, which it can. Either way the text is set in the face.
    const said = quiet(t);
    const { node, result } = await mount(
      '<style>@font-face { font-family: Doc; font-weight: 100 900;' +
        '  src: url(v.woff2) format("woff2") }' +
        'body { font-family: Doc, monospace }</style>' +
        '<p id="p">x <b id="b">x</b></p><p id="q">after</p>',
      (r) => (r.kind === 'font' ? { kind: 'font', bytes: wedge() } : null),
      {},
      true,
    );
    await settle(node, 8);
    assert.ok(node['_tree' as keyof typeof node], 'laid out, not left blank');
    assert.deepStrictEqual(said.errors, [], 'and nothing failed');
    const family = boxOf(node, 'b').style.fontFamily;
    assert.match(family, /^html webfont [a-z]+, monospace$/);
    assert.strictEqual(
      familyOf(result.app as never, { fontFamily: family }, 700),
      'Wedge',
    );
    assert.deepStrictEqual(said.warned, [], 'and nothing was refused');
  },
);

withFonts(
  'a face the engine cannot cut an instance from is passed over for the next source',
  async (t) => {
    // the face a document opens is the one opened here, the same bytes, and
    // it refuses every instance. Served as the TrueType it is: there is no
    // other font inside it to hand the engine instead.
    const said = quiet(t);
    const variable = woff2ToSfnt(wedge(), brotli)!;
    const asked: string[] = [];
    const host: Answer = (r) => {
      asked.push(r.url);
      if (r.kind !== 'font') return null;
      return { kind: 'font', bytes: r.url === 'v.ttf' ? variable : BOLD! };
    };
    const { result } = await mount('<p>x</p>', host, {}, true);
    const opened = openFont(result.app as never, variable) as unknown as {
      variation(settings: Record<string, number>): unknown;
    };
    const cut: Record<string, number>[] = [];
    opened.variation = (settings) => {
      cut.push(settings);
      throw new Error('cannot instantiate a variation');
    };
    await act(() =>
      result.rerender(
        h(
          'box',
          { style: { width: 400, flexDirection: 'column' } },
          h(Html, {
            source:
              '<style>@font-face { font-family: Doc; font-weight: 100 900;' +
              '  src: url(v.ttf), url(b.woff2) format("woff2") }' +
              'p { font-family: Doc, monospace; font-weight: 700 }</style>' +
              '<p id="p">x</p>',
            partial: false,
            onResource: host,
            'data-testname': 'doc',
          }),
        ),
      ),
    );
    const node = view(screen.getByTestName('doc') as DrawnNode);
    await settle(node);
    assert.deepStrictEqual(asked, ['v.ttf', 'b.woff2']);
    assert.deepStrictEqual(cut, [{ wght: 900 }], 'asked once, off its default');
    const p = boxOf(node, 'p');
    assert.match(p.style.fontFamily, /^html webfont [a-z]+, monospace$/);
    assert.strictEqual(
      familyOf(result.app as never, p.style, 700),
      'KaTeX_Main',
    );
    assert.deepStrictEqual(said.errors, []);
    assert.strictEqual(said.warned.length, 1, 'said once');
    assert.match(said.warned[0], /v\.ttf[^]*cannot instantiate a variation/);
  },
);

test('a face is asked for the instance a layout will ask it for', () => {
  const axis = (min: number, def: number, max: number) => ({
    min,
    default: def,
    max,
  });
  const asked: Record<string, number>[] = [];
  const face = (
    axes: Record<string, ReturnType<typeof axis>>,
    cuts = false,
  ) => ({
    variationAxes: axes,
    variation(settings: Record<string, number>) {
      asked.push(settings);
      if (!cuts) throw new Error('no instance');
      return this;
    },
  });
  // an engine whose faces are cut into instances, as ntk's are, and one
  // that moves an axis itself: CoreText, whose faces have no `variation`
  const ntk = { fonts: { match: () => face({}) } };
  const coreText = { fonts: { match: () => ({}) } };
  const wght = { wght: axis(100, 400, 900) };

  assert.strictEqual(refusal(ntk, face(wght), 'serif'), 'no instance');
  assert.strictEqual(refusal(ntk, face(wght, true), 'serif'), null);
  assert.strictEqual(
    refusal(coreText, face(wght), 'serif'),
    null,
    'an engine that does not draw through the face is not asked',
  );
  assert.strictEqual(refusal(ntk, face({}), 'serif'), null, 'a static face');
  assert.strictEqual(
    refusal(ntk, face({ slnt: axis(-10, 0, 0) }), 'serif'),
    null,
    'an axis no style moves is never cut',
  );
  assert.strictEqual(
    refusal(ntk, face({ wdth: axis(75, 100, 125) }), 'serif'),
    'no instance',
    'and the width is one a style moves',
  );
  assert.strictEqual(
    refusal(ntk, face({ wght: axis(400, 400, 400) }), 'serif'),
    null,
    'nor one with nowhere to go',
  );
  asked.length = 0;
  refusal(
    ntk,
    face({ wght: axis(100, 900, 900), opsz: axis(8, 14, 144) }, true),
    'serif',
  );
  assert.deepStrictEqual(
    asked,
    [{ wght: 100, opsz: 144 }],
    'the far end of each axis a style moves, in one instance',
  );
  assert.strictEqual(
    refusal({ fonts: null }, face(wght), 'serif'),
    'no instance',
    'an engine that cannot say is taken to draw through it',
  );
});

// --- WOFF2 ------------------------------------------------------------------

test('the font inside a WOFF2 is the font it was made from', () => {
  // every WOFF2 KaTeX ships has the TrueType it was made from beside it,
  // and the one above has the two transforms theirs do not use
  const pairs: Array<[string, Uint8Array, Uint8Array]> = [
    ['Pieces', bytesOf(PIECES_WOFF2), bytesOf(PIECES_TTF)],
  ];
  if (existsSync(KATEX)) {
    for (const file of readdirSync(KATEX)) {
      if (!file.endsWith('.woff2')) continue;
      const ttf = new URL(file.replace(/woff2$/, 'ttf'), KATEX);
      if (!existsSync(ttf)) continue;
      pairs.push([
        file,
        new Uint8Array(readFileSync(new URL(file, KATEX))),
        new Uint8Array(readFileSync(ttf)),
      ]);
    }
  }
  for (const [name, woff2, ttf] of pairs) {
    assert.ok(
      isWoff2(woff2) && !isWoff2(ttf),
      `${name}: told by its signature`,
    );
    const sfnt = woff2ToSfnt(woff2, brotli);
    assert.ok(sfnt, `${name}: read`);
    const made = tablesOf(sfnt);
    const from = tablesOf(ttf);
    assert.deepStrictEqual(
      [...made.keys()],
      [...from.keys()].sort(),
      `${name}: every table, in a directory in tag order`,
    );
    for (const [tag, table] of from) {
      // the outlines are packed again and found at other offsets, and
      // `head` carries the checksum of the file it is in
      if (tag === 'glyf' || tag === 'loca') continue;
      const same = Buffer.from(made.get(tag)!);
      if (tag === 'head') {
        same.fill(0, 8, 12);
        table.fill(0, 8, 12);
        // an encoder says that it transformed the font, in a flag (bit 11),
        // and KaTeX's two files were each stamped when they were built
        same[16] &= ~0x08;
        table[16] &= ~0x08;
        same.fill(0, 20, 36);
        table.fill(0, 20, 36);
      }
      assert.ok(same.equals(table), `${name}: ${tag} is the table it was`);
    }
    const drawn = outlinesOf(made);
    const original = outlinesOf(from);
    assert.strictEqual(drawn.length, original.length, `${name}: every glyph`);
    const differs = drawn.findIndex((glyph, i) => glyph !== original[i]);
    assert.ok(
      differs < 0,
      `${name}: glyph ${differs} is ${drawn[differs]}, was ${original[differs]}`,
    );
    // the whole file sums to the constant an sfnt's `head` brings it to
    const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.length);
    let sum = 0;
    for (let at = 0; at < sfnt.length; at += 4) {
      sum = (sum + view.getUint32(at)) >>> 0;
    }
    assert.strictEqual(sum, 0xb1b0afba, `${name}: the checksum of an sfnt`);
  }
  assert.ok(pairs.length > 1 || !REGULAR, 'and the fonts a page is served');
});

test('bytes that are not a WOFF2 this reads are no font', () => {
  const woff2 = bytesOf(PIECES_WOFF2);
  assert.strictEqual(woff2ToSfnt(bytesOf(PIECES_TTF), brotli), null);
  assert.strictEqual(woff2ToSfnt(new Uint8Array(0), brotli), null);
  assert.strictEqual(
    woff2ToSfnt(woff2.subarray(0, woff2.length - 40), brotli),
    null,
    'a file that ends early',
  );
  assert.strictEqual(
    woff2ToSfnt(woff2, (data) => brotli(data).subarray(0, 200)),
    null,
    'a stream shorter than its tables',
  );
  assert.strictEqual(
    woff2ToSfnt(woff2, () => {
      throw new Error('not Brotli');
    }),
    null,
  );
  const collection = woff2.slice();
  collection.set([0x74, 0x74, 0x63, 0x66], 4); // 'ttcf'
  assert.strictEqual(woff2ToSfnt(collection, brotli), null, 'a collection');
  // every byte of the stream wrong in turn: never a throw, and never a
  // loop that does not end
  for (let i = 0; i < 300; i += 1) {
    const out = woff2ToSfnt(woff2, (data) => {
      const bytes = brotli(data);
      bytes[i % bytes.length] ^= 0xff;
      return bytes;
    });
    assert.ok(out === null || out.length > 0, `byte ${i}`);
  }
});

withFonts(
  'a WOFF2 the font manager does not read is registered as the font inside it',
  async (t) => {
    // CoreText reads no WOFF2, so react-x11's font manager on macOS throws
    // for one, and a page's web font was never set there: nextjs.org's blog
    // was set in its fallback, Arial, for Geist. The same refusal, from the
    // font manager here.
    const said = quiet(t);
    const { result } = await mount('<p>x</p>', () => null, {}, true);
    const fonts = (
      result.app as unknown as {
        fonts: { load(source: unknown, opts?: object): unknown };
      }
    ).fonts;
    const load = fonts.load.bind(fonts);
    const loaded: string[] = [];
    fonts.load = (source, opts) => {
      const bytes = source as Uint8Array;
      const woff2 = isWoff2(bytes);
      loaded.push(woff2 ? 'woff2' : `sfnt ${bytes[0]},${bytes[1]}`);
      if (woff2) throw new Error('CoreText does not read that container');
      return load(source, opts);
    };
    t.after(() => {
      fonts.load = load;
    });
    const asked: string[] = [];
    const host: Answer = (r) => {
      asked.push(r.url);
      return r.kind === 'font' ? { kind: 'font', bytes: REGULAR! } : null;
    };
    await act(() =>
      result.rerender(
        h(
          'box',
          { style: { width: 400, flexDirection: 'column' } },
          h(Html, {
            source:
              '<style>@font-face { font-family: Doc;' +
              '  src: url(r.woff2) format("woff2"), url(b.woff2) }' +
              'p { font-family: Doc, monospace }</style><p id="p">x</p>',
            partial: false,
            onResource: host,
            'data-testname': 'doc',
          }),
        ),
      ),
    );
    const node = view(screen.getByTestName('doc') as DrawnNode);
    await settle(node, 8);
    const p = boxOf(node, 'p');
    assert.match(p.style.fontFamily, /^html webfont [a-z]+, monospace$/);
    assert.strictEqual(familyOf(result.app as never, p.style), 'KaTeX_Main');
    assert.deepStrictEqual(
      loaded,
      ['woff2', 'sfnt 0,1'],
      'offered as served, then as the TrueType inside it',
    );
    assert.deepStrictEqual(asked, ['r.woff2'], 'and no other source asked for');
    assert.deepStrictEqual(said.warned, []);
    assert.deepStrictEqual(said.errors, []);
  },
);

// --- the weight and width axes -----------------------------------------------

test('a run is handed on with the family and the axis values it has', () => {
  const seen: Array<{ content: unknown; style: unknown }> = [];
  const engine = {
    layout(content: unknown, style: unknown) {
      seen.push({ content, style });
      return 'laid out';
    },
    match: () => ({}),
    prewarm() {
      return this === engine;
    },
  } as unknown as FontsLike & { prewarm(): boolean };
  const asked: string[] = [];
  const faces = {
    active: true,
    setting(list: string, weight: number, italic: boolean, stretch: number) {
      asked.push(`${list}|${weight}|${italic}|${stretch}`);
      if (!list.startsWith('web')) return null;
      return {
        // the faces of another width are under a name of their own
        family: stretch < 100 ? 'narrow, web, serif' : list,
        variations: { wght: Math.min(weight, 500) },
      };
    },
  };
  const fonts = fontAxes(engine, faces) as typeof engine;
  const base = { family: 'web, serif', weight: 400, style: 'normal' };
  const runs = [
    { text: 'a' },
    { text: 'b', weight: 700 },
    { text: 'c', family: 'serif', weight: 700 },
    { text: 'd', weight: 'bold' as const, style: 'italic' as const },
    { text: 'e', stretch: 75 },
  ];
  assert.strictEqual(fonts.layout(runs, base, {}), 'laid out');
  assert.deepStrictEqual(asked, [
    'web, serif|400|false|100',
    'web, serif|700|false|100',
    'serif|700|false|100',
    'web, serif|700|true|100',
    'web, serif|400|false|75',
  ]);
  const handed = seen[0].content as Array<Record<string, unknown>>;
  assert.deepStrictEqual(handed, [
    { text: 'a', variations: { wght: 400 } },
    { text: 'b', weight: 700, variations: { wght: 500 } },
    { text: 'c', family: 'serif', weight: 700 },
    { text: 'd', weight: 'bold', style: 'italic', variations: { wght: 500 } },
    {
      text: 'e',
      stretch: 75,
      family: 'narrow, web, serif',
      variations: { wght: 400 },
    },
  ]);
  assert.ok(handed[2] === runs[2], 'a run in another family is the run given');
  assert.ok(seen[0].style === base, 'and the paragraph carries no axis');
  assert.deepStrictEqual(
    runs[0],
    { text: 'a' },
    'the caller’s runs are its own',
  );

  // a document with no face to set: the engine as it is
  faces.active = false;
  asked.length = 0;
  fonts.layout(runs, base, {});
  assert.ok(seen[1].content === runs, 'the runs given');
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(
    fonts.prewarm(),
    true,
    'and the rest of the engine is its own',
  );
});

withFonts(
  'a variable face is set at the weight its rule has for a style’s',
  async (t) => {
    // CSS Fonts 4 (7.2): the weight a style asks for, clamped to the range
    // the face's `@font-face` declares, is where on its `wght` axis the
    // text is set. `Doc` declares all of the file's axis and `Part` a
    // fifth of it; the wedge's `x` is a box that widens with the weight.
    const source =
      '<style>@font-face { font-family: Doc; font-weight: 100 900;' +
      '  src: url(doc.woff2) format("woff2") }' +
      '@font-face { font-family: Part; font-weight: 400 500;' +
      '  src: url(part.woff2) format("woff2") }' +
      '@font-face { font-family: One; src: url(one.woff2) }' +
      'p { font-family: Doc, monospace; margin: 0; font-size: 40px }' +
      '.part { font-family: Part, monospace }' +
      '.one { font-family: One, monospace }' +
      '.mono { font-family: monospace }</style>' +
      '<p><span id="d4">x</span><span id="d7" style="font-weight: 700">x</span>' +
      '<span id="d9" style="font-weight: 900">x</span></p>' +
      '<p class="part"><span id="p1" style="font-weight: 100">x</span>' +
      '<span id="p4">x</span><span id="p5" style="font-weight: 500">x</span>' +
      '<span id="p9" style="font-weight: 900">x</span></p>' +
      '<p class="one"><b id="o7">x</b></p><p class="mono"><b id="m7">x</b></p>';
    const host: Answer = (r) =>
      r.kind === 'font' ? { kind: 'font', bytes: wedge() } : null;
    // what the engine is handed, run by run, from the first layout on
    const { result } = await mount('<p>x</p>', host, {}, true);
    const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
    const layout = fonts.layout.bind(fonts);
    const handed = new Map<string, unknown>();
    fonts.layout = (content, style, options) => {
      for (const run of content as Array<{
        family?: string;
        weight?: unknown;
        variations?: unknown;
      }>) {
        const weight = run.weight ?? style.weight;
        handed.set(`${run.family ?? style.family} ${weight}`, run.variations);
      }
      return layout(content, style, options);
    };
    t.after(() => {
      fonts.layout = layout;
    });
    await act(() =>
      result.rerender(
        h(
          'box',
          { style: { width: 400, flexDirection: 'column' } },
          h(Html, {
            source,
            partial: false,
            onResource: host,
            'data-testname': 'doc',
          }),
        ),
      ),
    );
    const node = view(screen.getByTestName('doc') as DrawnNode);
    await settle(node, 8);
    const axis = (id: string, weight: number) =>
      handed.get(`${boxOf(node, id).style.fontFamily} ${weight}`);
    assert.match(
      boxOf(node, 'd4').style.fontFamily,
      /^html webfont/,
      'the faces loaded',
    );
    assert.deepStrictEqual(
      [axis('d4', 400), axis('d7', 700), axis('d9', 900)],
      [{ wght: 400 }, { wght: 700 }, { wght: 900 }],
      'inside the range a rule declares, the weight asked for',
    );
    assert.deepStrictEqual(
      [axis('p1', 100), axis('p4', 400), axis('p5', 500), axis('p9', 900)],
      [{ wght: 400 }, { wght: 400 }, { wght: 500 }, { wght: 500 }],
      'outside it, its nearest end',
    );
    const width = (id: string) =>
      node.elementRect(boxOf(node, id).el as never)!.width;
    assert.ok(width('d4') < width('d7'), 'and drawn wider');
    assert.ok(width('d7') < width('d9'), 'the heavier it is');
    assert.strictEqual(width('p1'), width('p4'), '100 of 400–500 is 400');
    assert.strictEqual(width('p4'), width('d4'));
    assert.ok(width('p4') < width('p5'), '500 is 500');
    assert.strictEqual(width('p9'), width('p5'), 'and 900 is 500');
    assert.ok(width('p9') < width('d9'), 'not the file’s 900');
    // a face declared at one weight is the engine's to set, and so is a
    // family that is not the document's
    assert.match(boxOf(node, 'o7').style.fontFamily, /^html webfont/);
    assert.strictEqual(axis('o7', 700), undefined, 'a rule with no range');
    assert.strictEqual(axis('m7', 700), undefined, 'a family of the system’s');
    assert.ok(handed.has('monospace 700'), 'which the engine was handed');
  },
);

withFonts(
  'a variable face is set at the width its rule has for a style’s',
  async (t) => {
    // CSS Fonts 4 (7.2): a style's `font-stretch`, clamped to the range the
    // face's `@font-face` declares, is where on its `wdth` axis the text is
    // set — bun.sh's Archivo, `font-stretch: 62% 125%`, under headings at
    // 62% — and a rule's `auto` clamps it to the file's own range alone
    // (4.4). No engine moves the axis by itself.
    const source =
      '<style>@font-face { font-family: Doc; font-weight: 100 900;' +
      '  font-stretch: 62% 125%; src: url(doc.woff2) format("woff2") }' +
      '@font-face { font-family: Auto; font-weight: 100 900;' +
      '  src: url(auto.woff2) format("woff2") }' +
      'p { font-family: Doc, monospace; margin: 0; font-size: 40px }' +
      '.auto { font-family: Auto, monospace }</style>' +
      '<p><span id="d100">x</span>' +
      '<span id="d75" style="font-stretch: condensed">x</span>' +
      '<span id="d62" style="font-stretch: 62%">x</span>' +
      '<span id="d50" style="font-stretch: 50%">x</span>' +
      '<span id="d150" style="font-stretch: calc(100% + 50%)">x</span>' +
      '<span id="d9" style="font-weight: 900; font-stretch: 62%">x</span>' +
      '<span id="dx" style="font: extra-condensed 40px Doc">x</span></p>' +
      '<p class="auto"><span id="a50" style="font-stretch: 50%">x</span>' +
      '<span id="a300" style="font-stretch: 300%">x</span></p>' +
      '<p style="font-stretch: 62%"><span id="ch"' +
      ' style="display: inline-block; width: 10ch; height: 1px"></span>' +
      '<span id="ch100" style="display: inline-block; width: 10ch;' +
      ' height: 1px; font-stretch: normal"></span></p>';
    const host: Answer = (r) =>
      r.kind === 'font' ? { kind: 'font', bytes: spread() } : null;
    const { result } = await mount('<p>x</p>', host, {}, true);
    const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
    const layout = fonts.layout.bind(fonts);
    const handed = new Map<string, unknown>();
    fonts.layout = (content, style, options) => {
      for (const run of content as Array<{
        family?: string;
        weight?: unknown;
        stretch?: number;
        variations?: unknown;
      }>) {
        const weight = run.weight ?? style.weight;
        handed.set(
          `${run.family ?? style.family} ${weight} ${run.stretch}`,
          run.variations,
        );
      }
      return layout(content, style, options);
    };
    t.after(() => {
      fonts.layout = layout;
    });
    await act(() =>
      result.rerender(
        h(
          'box',
          { style: { width: 400, flexDirection: 'column' } },
          h(Html, {
            source,
            partial: false,
            onResource: host,
            'data-testname': 'doc',
          }),
        ),
      ),
    );
    const node = view(screen.getByTestName('doc') as DrawnNode);
    await settle(node, 8);
    assert.match(boxOf(node, 'd62').style.fontFamily, /^html webfont/);
    const axes = (id: string, weight: number, stretch: number) =>
      handed.get(`${boxOf(node, id).style.fontFamily} ${weight} ${stretch}`);
    assert.deepStrictEqual(
      [
        axes('d100', 400, 100),
        axes('d75', 400, 75),
        axes('d62', 400, 62),
        axes('d9', 900, 62),
        axes('dx', 400, 62.5),
      ],
      [
        { wght: 400 },
        { wght: 400, wdth: 75 },
        { wght: 400, wdth: 62 },
        { wght: 900, wdth: 62 },
        { wght: 400, wdth: 62.5 },
      ],
      'inside the range a rule declares, the width asked for',
    );
    assert.deepStrictEqual(
      [axes('d50', 400, 50), axes('d150', 400, 150)],
      [
        { wght: 400, wdth: 62 },
        { wght: 400, wdth: 125 },
      ],
      'outside it, its nearest end',
    );
    assert.deepStrictEqual(
      [axes('a50', 400, 50), axes('a300', 400, 300)],
      [
        { wght: 400, wdth: 50 },
        { wght: 400, wdth: 200 },
      ],
      'and under `auto`, the nearest the file has',
    );
    const width = (id: string) =>
      node.elementRect(boxOf(node, id).el as never)!.width;
    const near = (id: string, units: number) => {
      const want = (40 * units) / 1000;
      assert.ok(
        Math.abs(width(id) - want) < 0.1,
        `#${id} is ${width(id)} wide, where it is drawn ${want}`,
      );
    };
    near('d100', spreadX(100));
    near('d75', spreadX(75));
    near('d62', spreadX(62));
    near('d50', spreadX(62));
    near('d150', spreadX(125));
    near('d9', spreadX(62, 900));
    near('dx', spreadX(62.5));
    near('a50', spreadX(50));
    near('a300', spreadX(200));
    // a `ch` is the advance of the "0" in the face at its width
    assert.ok(
      Math.abs(width('ch') - (10 * 40 * spreadX(62)) / 1000) < 1,
      `10ch at 62% is ${width('ch')}`,
    );
    assert.ok(
      Math.abs(width('ch100') - (10 * 40 * spreadX(100)) / 1000) < 1,
      `10ch at 100% is ${width('ch100')}`,
    );
  },
);

withFonts(
  'a family of faces of several widths is matched by the width first',
  async () => {
    // CSS Fonts 4 (5.2): the width first, then the slant, then the weight.
    // `Wide` is KaTeX's regular declared at the normal width and its bold
    // declared condensed: text at 80% is set in the condensed face, whose
    // weight is not the text's, and so is text at 50%, narrower than any
    // face — at or under normal, the narrower widths are tried and then
    // the wider — while text at 110% is set in the normal face, the wider
    // having none. The font manager picks among one name's faces by weight
    // and slant alone, so the widths are two names.
    const asked: string[] = [];
    const { node } = await mount(
      '<style>' +
        '@font-face { font-family: Wide; src: url(r.woff2) }' +
        '@font-face { font-family: Wide; font-stretch: condensed;' +
        '  src: url(b.woff2) }' +
        '@font-face { font-family: Plain; src: url(r.woff2) }' +
        '@font-face { font-family: Heavy; src: url(b.woff2) }' +
        'p { font-family: Wide, monospace; margin: 0; font-size: 40px }' +
        '</style>' +
        '<p><span id="n">mm</span> <span id="c" style="font-stretch: 80%">' +
        'mm</span> <span id="u" style="font-stretch: 50%">mm</span>' +
        ' <span id="e" style="font-stretch: 110%">mm</span></p>' +
        '<p style="font-family: Plain"><span id="r">mm</span></p>' +
        '<p style="font-family: Heavy"><span id="b">mm</span></p>',
      fontHost(asked),
      {},
      true,
    );
    await settle(node);
    const width = (id: string) =>
      node.elementRect(boxOf(node, id).el as never)!.width;
    // where a span ends less where it starts, which can be a bit off
    const same = (id: string, face: string, message: string) =>
      assert.ok(Math.abs(width(id) - width(face)) < 0.01, message);
    assert.ok(width('b') > width('r') + 1, 'the bold is the wider face');
    same('n', 'r', 'normal is the normal face');
    same('c', 'b', '80% is the condensed face');
    same('u', 'b', 'and so is 50%');
    same('e', 'r', '110% is the normal face');
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

/** A face's metrics at a size, as the font manager answers for a family
 *  list at a weight. */
function metricsOf(
  app: unknown,
  family: string,
  size: number,
  weight = 400,
): { xHeight: number; lineHeight: number } {
  const fonts = (
    app as {
      fonts: {
        match(
          f: string,
          o: object,
        ): { metrics(size: number): { xHeight: number; lineHeight: number } };
      };
    }
  ).fonts;
  return fonts.match(family, { size, weight, style: 'normal' }).metrics(size);
}

/** A length a computed style holds, in pixels. */
const px = (box: LaidBox, prop: 'width' | 'height'): number =>
  (box.style as unknown as Record<string, number>)[prop];

withFonts(
  'an ex and an lh are measured in the face the element is set in',
  async () => {
    // A family's faces can be different fonts: a page's bold is often
    // another file. The units were measured in the family's regular face
    // whatever the weight, and before an inline weight that came after the
    // rule holding them had been applied at all.
    const { result, node } = await mount(
      `<style>${FACES} div { font-family: Doc; font-size: 100px;` +
        ' width: 10ex; height: 2lh }</style>' +
        '<div id="r"></div><div id="b" style="font-weight: 700"></div>',
      fontHost([]),
      {},
      true,
    );
    await settle(node);
    const r = boxOf(node, 'r');
    const b = boxOf(node, 'b');
    const regular = metricsOf(result.app, r.style.fontFamily, 100, 400);
    const bold = metricsOf(result.app, b.style.fontFamily, 100, 700);
    assert.notStrictEqual(regular.xHeight, bold.xHeight, 'two faces');
    assert.ok(Math.abs(px(r, 'width') - 10 * regular.xHeight) < 0.01);
    assert.ok(
      Math.abs(px(b, 'width') - 10 * bold.xHeight) < 0.01,
      `the bold face's ex: ${px(b, 'width')} for ${10 * bold.xHeight}`,
    );
    assert.ok(
      Math.abs(px(b, 'height') - 2 * bold.lineHeight) < 0.01,
      `and its line height: ${px(b, 'height')} for ${2 * bold.lineHeight}`,
    );
  },
);

withFonts(
  "an ex in a rule is the element's font, whatever the rule sets",
  async () => {
    // The cascade applies every declaration in order, the rule's own
    // `font-family` just ahead of its `width`, and the width was read in
    // the rule's family under an inline family that outranks it.
    const { result, node } = await mount(
      `<style>${FACES} div { font-family: Doc; font-size: 100px;` +
        ' width: 10ex; height: 4px }</style>' +
        '<div id="d"></div><div id="s" style="font-family: sans-serif"></div>',
      fontHost([]),
      {},
      true,
    );
    await settle(node);
    const d = boxOf(node, 'd');
    const s = boxOf(node, 's');
    assert.strictEqual(s.style.fontFamily, 'sans-serif');
    const doc = metricsOf(result.app, d.style.fontFamily, 100).xHeight;
    const sans = metricsOf(result.app, 'sans-serif', 100).xHeight;
    assert.notStrictEqual(doc, sans, 'two fonts');
    assert.ok(Math.abs(px(d, 'width') - 10 * doc) < 0.01);
    assert.ok(
      Math.abs(px(s, 'width') - 10 * sans) < 0.01,
      `sans-serif's ex: ${px(s, 'width')} for ${10 * sans}`,
    );
  },
);
