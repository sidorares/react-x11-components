// The legacy encodings: `encoding.ts`, which names them and finds which one a
// document is in, and `encoding-codecs.ts`, the standard's decoders and
// encoders over its indexes. WPT holds every pointer of every index to them
// (`encoding/`), where the suite cannot go for want of a server; what is here
// is the rules a table says nothing of, and the page's half of it.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import type { Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { act, cleanup, renderX11 } from 'react-x11/test';

import {
  decoderFor,
  encodeForForm,
  percentEncoded,
  urlInEncoding,
} from '../../src/html/encoding-codecs.js';
import {
  bomEncoding,
  decodeInEncoding,
  encodingOf,
  htmlTextDecoder,
  loadEncodings,
  metaEncoding,
  outputEncoding,
  readyFor,
  sniffEncoding,
  xmlEncoding,
} from '../../src/html/encoding.js';
import { formEncoding, formSubmission } from '../../src/html/form.js';
import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { HtmlNetwork } from '../../src/html/network.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { FetchRequest, FetchResponse } from '../../src/html/index.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();
await loadEncodings();

const scripted = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;
const test = nodeTest;

const latin = (text: string): Uint8Array =>
  Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const decoded = (name: string, bytes: number[]): string | null =>
  decoderFor(name)!.decode(Uint8Array.from(bytes), false, false);

test('a label names an encoding as the standard has it: white space around it, ASCII case alone', () => {
  assert.equal(encodingOf('utf8'), 'UTF-8');
  assert.equal(encodingOf('  LATIN1\n'), 'windows-1252');
  assert.equal(encodingOf('ascii'), 'windows-1252');
  assert.equal(encodingOf('x-sjis'), 'Shift_JIS');
  assert.equal(encodingOf('ks_c_5601-1987'), 'EUC-KR');
  assert.equal(encodingOf('hz-gb-2312'), 'replacement');
  assert.equal(encodingOf('utf-16'), 'UTF-16LE');
  assert.equal(encodingOf('iso-8859-8-i'), 'ISO-8859-8-I');
  // a Kelvin sign folds to `k` in a Unicode lower-casing
  assert.equal(encodingOf('Koi8-r'), null);
  assert.equal(encodingOf('utf-7'), null);
  assert.equal(encodingOf(''), null);
});

test('what a form or a URL is written in is an encoding that leaves ASCII alone', () => {
  assert.equal(outputEncoding('UTF-16LE'), 'UTF-8');
  assert.equal(outputEncoding('UTF-16BE'), 'UTF-8');
  assert.equal(outputEncoding('replacement'), 'UTF-8');
  assert.equal(outputEncoding('Shift_JIS'), 'Shift_JIS');
});

test('a prescan finds a <meta> in the first kilobyte, past comments and other tags, and nothing else', () => {
  const meta = (text: string) => metaEncoding(latin(text));
  assert.equal(meta('<meta charset=shift_jis>'), 'Shift_JIS');
  assert.equal(meta('<!doctype html><META CHARSET="EUC-KR">'), 'EUC-KR');
  assert.equal(
    meta('<meta http-equiv=Content-Type content="text/html; charset=big5">'),
    'Big5',
  );
  assert.equal(
    meta("<meta content='text/html;charset=koi8-r' http-equiv='content-type'>"),
    'KOI8-R',
  );
  // `content` needs its `http-equiv`, and a comment holds no tag
  assert.equal(meta('<meta name=x content="charset=big5">'), null);
  assert.equal(meta('<!-- <meta charset=big5> --><p>'), null);
  assert.equal(meta('<title><meta charset=big5></title>'), 'Big5');
  assert.equal(meta('<a title="<meta charset=big5>">'), null);
  assert.equal(meta('<meta charset=nonsense><meta charset=gbk>'), 'GBK');
  // a <meta> was readable as ASCII, so it cannot be UTF-16
  assert.equal(meta('<meta charset=utf-16>'), 'UTF-8');
  assert.equal(meta('<meta charset=x-user-defined>'), 'windows-1252');
  const far = `${' '.repeat(1024)}<meta charset=big5>`;
  assert.equal(meta(far), null);
});

test('a document is in what its byte order mark says, then its transport, then a <meta>, then its parent', () => {
  const meta = latin('<meta charset=gbk>é');
  assert.equal(
    sniffEncoding(Uint8Array.from([0xef, 0xbb, 0xbf]), 'big5'),
    'UTF-8',
  );
  assert.equal(
    sniffEncoding(Uint8Array.from([0xff, 0xfe]), 'big5'),
    'UTF-16LE',
  );
  assert.equal(
    sniffEncoding(Uint8Array.from([0xfe, 0xff]), 'big5'),
    'UTF-16BE',
  );
  assert.equal(sniffEncoding(meta, 'big5'), 'Big5');
  assert.equal(sniffEncoding(meta, 'nonsense'), 'GBK');
  assert.equal(sniffEncoding(latin('plain'), null, 'EUC-JP'), 'EUC-JP');
  assert.equal(sniffEncoding(latin('plain')), 'windows-1252');
  assert.equal(sniffEncoding(latin('caf\xe9')), 'windows-1252');
  // what no label says and only UTF-8 could be, where a browser would show
  // its bytes as windows-1252
  assert.equal(sniffEncoding(latin('caf\xc3\xa9')), 'UTF-8');
  assert.equal(
    xmlEncoding(latin('<?xml version="1.0" encoding="koi8-r"?>')),
    'KOI8-R',
  );
  assert.equal(xmlEncoding(latin('<?xml version="1.0"?>')), null);
  assert.equal(bomEncoding(latin('plain')), null);
});

test('a decoder reads what a runtime’s does not: UHC, HKSCS, gb18030’s ranges', () => {
  // ICU's euc-kr stops at KS X 1001, and its big5 has no HKSCS
  assert.equal(decoded('EUC-KR', [0x81, 0x41]), '갂');
  assert.equal(decoded('Big5', [0x88, 0x62]), 'Ê̄');
  assert.equal(decoded('Big5', [0x87, 0x40]), '䏰');
  assert.equal(decoded('gb18030', [0x94, 0x39, 0xfc, 0x36]), '\u{1f600}');
  assert.equal(decoded('GBK', [0x94, 0x39, 0xfc, 0x36]), '\u{1f600}');
  assert.equal(decoded('gb18030', [0x80]), '€');
  assert.equal(decoded('Shift_JIS', [0xf0, 0x40]), '');
  assert.equal(decoded('EUC-JP', [0x8f, 0xb0, 0xa1]), '丂');
  assert.equal(decoded('x-user-defined', [0x41, 0xff]), 'A');
  assert.equal(decoded('ISO-8859-8-I', [0xe0]), 'א');
  assert.equal(decoded('windows-1252', [0x80]), '€');
});

test('an error takes what the standard says it takes: an ASCII byte is read again, and a stream ends in U+FFFD', () => {
  assert.equal(decoded('EUC-KR', [0x81, 0x20, 0x41]), '\ufffd A');
  assert.equal(decoded('Big5', [0x81]), '\ufffd');
  assert.equal(decoded('gb18030', [0x81, 0x30, 0x81, 0x41]), '\ufffd0\u4e04');
  assert.equal(decoded('UTF-16LE', [0x00, 0xd8, 0x41, 0x00]), '\ufffdA');
  assert.equal(decoded('UTF-16BE', [0xd8, 0x00, 0x00, 0x41]), '\ufffdA');
  assert.equal(decoded('UTF-16LE', [0x41]), '\ufffd');
  assert.equal(decoded('ISO-8859-3', [0xa5]), '\ufffd');
  // `replacement` says once that it read nothing it can show
  assert.equal(decoded('replacement', [0x41, 0x42, 0x43]), '\ufffd');
  assert.equal(decoded('replacement', []), '');
});

test('ISO-2022-JP keeps its state across escapes, and an escape with nothing after it is an error', () => {
  const esc = 0x1b;
  assert.equal(decoded('ISO-2022-JP', [esc, 0x24, 0x42, 0x24, 0x22]), 'あ');
  assert.equal(
    decoded('ISO-2022-JP', [
      esc,
      0x28,
      0x4a,
      0x5c,
      0x7e,
      esc,
      0x28,
      0x42,
      0x5c,
    ]),
    '¥‾\\',
  );
  assert.equal(decoded('ISO-2022-JP', [esc, 0x28, 0x49, 0x21]), '｡');
  // two escapes with nothing between them
  assert.equal(
    decoded('ISO-2022-JP', [esc, 0x24, 0x42, esc, 0x28, 0x42, 0x41]),
    '\ufffdA',
  );
  assert.equal(decoded('ISO-2022-JP', [esc]), '\ufffd');
  assert.equal(decoded('ISO-2022-JP', [esc, 0x24]), '\ufffd$');
  assert.equal(decoded('ISO-2022-JP', [0x0e]), '\ufffd');
});

test('a decoder holds what a chunk left unfinished, and `fatal` stops at the first error', () => {
  const decoder = decoderFor('gb18030')!;
  const bytes = [0x94, 0x39, 0xfc, 0x36, 0x41];
  const pieces = bytes.map((byte) =>
    decoder.decode(Uint8Array.of(byte), true, false),
  );
  assert.equal(pieces.join(''), '\u{1f600}A');
  assert.equal(decoder.decode(new Uint8Array(0), false, false), '');

  const fatal = decoderFor('EUC-KR')!;
  assert.equal(fatal.decode(Uint8Array.of(0xff), false, true), null);
  const short = decoderFor('Shift_JIS')!;
  assert.equal(short.decode(Uint8Array.of(0x81), false, true), null);
  assert.equal(decoderFor('UTF-8'), null);
});

test('a decoder a chunk at a time goes by the same rules, and bytes in a legacy encoding read the same on any runtime', async () => {
  const utf8 = await htmlTextDecoder('utf-8');
  assert.equal(utf8.decode(latin('\xc3'), { stream: true }), '');
  assert.equal(utf8.decode(latin('\xa9')), 'é');
  const korean = await htmlTextDecoder('ks_c_5601-1987');
  assert.equal(korean.decode(Uint8Array.of(0x81), { stream: true }), '');
  assert.equal(korean.decode(Uint8Array.of(0x41)), '갂');
  assert.equal(korean.decode(), '');
  await assert.rejects(htmlTextDecoder('nonsense'), RangeError);

  await readyFor('big5');
  assert.equal(decodeInEncoding(Uint8Array.of(0x88, 0x62), 'big5'), 'Ê̄');
  // a byte order mark wins over the label, and is no part of the text
  assert.equal(
    decodeInEncoding(Uint8Array.of(0xff, 0xfe, 0x41, 0x00), 'big5'),
    'A',
  );
  assert.equal(
    decodeInEncoding(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41), 'big5'),
    'A',
  );
  assert.equal(decodeInEncoding(latin('caf\xc3\xa9'), 'nonsense'), 'café');
});

test('an encoder is the standard’s where an index is no inverse of its decoder', () => {
  const encoded = (name: string, text: string) => [
    ...encodeForForm(name, text),
  ];
  // Big5 takes the last pointer of these, and nothing of Hong Kong's
  assert.deepEqual(encoded('Big5', '═'), [0xf9, 0xf9]);
  assert.deepEqual(encoded('Big5', '十'), [0xa4, 0x51]);
  // Shift_JIS's duplicates are skipped, so a later pointer is taken
  assert.deepEqual(encoded('Shift_JIS', '≒'), [0x81, 0xe0]);
  assert.deepEqual(encoded('Shift_JIS', '−'), [0x81, 0x7c]);
  assert.deepEqual(encoded('EUC-JP', '¥'), [0x5c]);
  assert.deepEqual(encoded('EUC-JP', 'ｱ'), [0x8e, 0xb1]);
  assert.deepEqual(encoded('GBK', '€'), [0x80]);
  assert.deepEqual(encoded('gb18030', '€'), [0xa2, 0xe3]);
  assert.deepEqual(encoded('gb18030', ''), [0xa6, 0xd9]);
  assert.deepEqual(encoded('gb18030', '\u{1f600}'), [0x94, 0x39, 0xfc, 0x36]);
  assert.deepEqual(encoded('x-user-defined', ''), [0xff]);
  // what the encoding has no bytes for goes as a reference to it
  assert.deepEqual(encoded('GBK', '\u{1f600}'), [...latin('&#128512;')]);
  assert.deepEqual(encoded('gb18030', ''), [...latin('&#58853;')]);
  assert.deepEqual(encoded('windows-1252', 'Ā'), [...latin('&#256;')]);
  // a lone surrogate is no scalar value
  assert.deepEqual(encoded('windows-1252', '\ud800'), [...latin('&#65533;')]);
});

test('ISO-2022-JP’s encoder escapes in and out, and U+001B stays out of what it writes', () => {
  const encoded = (text: string) => [...encodeForForm('ISO-2022-JP', text)];
  const out = [0x1b, 0x28, 0x42];
  assert.deepEqual(encoded('A'), [0x41]);
  assert.deepEqual(encoded('あ'), [0x1b, 0x24, 0x42, 0x24, 0x22, ...out]);
  assert.deepEqual(encoded('¥'), [0x1b, 0x28, 0x4a, 0x5c, ...out]);
  // half-width katakana goes out as the full-width letter
  assert.deepEqual(encoded('ｱ'), [0x1b, 0x24, 0x42, 0x25, 0x22, ...out]);
  // U+FFFD rather than the code point, since a page could write an escape
  assert.deepEqual(encoded('\u001b'), [...latin('&#65533;')]);
  assert.deepEqual(encoded('ก'), [...latin('&#3585;')]);
});

test('a percent-encoded form writes what the encoding cannot hold as a character reference, encoded', () => {
  const everything = () => false;
  assert.equal(
    percentEncoded('EUC-JP', '한', everything, false),
    '%26%2354620%3B',
  );
  assert.equal(percentEncoded('EUC-JP', 'あ', everything, false), '%A4%A2');
  assert.equal(
    percentEncoded('Shift_JIS', ' a', (b) => b === 0x61, true),
    '+a',
  );
});

test('a URL’s query alone is in the document’s encoding, and a scheme with no such query keeps UTF-8', () => {
  const base = 'https://example.test/dir/page.html';
  const url = (input: string, name = 'EUC-JP') =>
    urlInEncoding(name, input, base);
  assert.equal(url('?あ'), 'https://example.test/dir/page.html?%A4%A2');
  // the path and the fragment are UTF-8 whatever the document is in
  assert.equal(
    url('あ?あ#あ'),
    'https://example.test/dir/%E3%81%82?%A4%A2#%E3%81%82',
  );
  assert.equal(url('?한'), 'https://example.test/dir/page.html?%26%2354620%3B');
  assert.equal(url('/plain?a=b'), 'https://example.test/plain?a=b');
  assert.equal(url('wss://example.test/?あ'), 'wss://example.test/?%E3%81%82');
  // a trail byte in ASCII's range stays as it is, as a query keeps `\` and `|`
  assert.equal(
    url('?表', 'Shift_JIS'),
    'https://example.test/dir/page.html?%95\\',
  );
  // what the parser takes off is not encoded
  assert.equal(url('?あ \n'), 'https://example.test/dir/page.html?%A4%A2');
});

test('a form goes in `accept-charset`’s first encoding, then its document’s, and says so in `_charset_`', () => {
  const formOf = (attributes: string): Element => {
    const doc = parseDocument(
      `<form ${attributes} action="/go"><input type=hidden name=_charset_><input name=q value="あ b"></form>`,
    );
    const find = (nodes: readonly unknown[]): Element | null => {
      for (const node of nodes as Element[]) {
        if (node.name === 'form') return node;
        const found = node.children && find(node.children);
        if (found) return found;
      }
      return null;
    };
    return find(doc.children)!;
  };
  assert.equal(formEncoding(formOf(''), 'euc-jp'), 'EUC-JP');
  assert.equal(
    formEncoding(formOf('accept-charset="nope shift_jis gbk"')),
    'Shift_JIS',
  );
  assert.equal(
    formEncoding(formOf('accept-charset="nope"'), 'euc-jp'),
    'UTF-8',
  );
  assert.equal(formEncoding(formOf('accept-charset=""'), 'euc-jp'), 'UTF-8');
  assert.equal(formEncoding(formOf('accept-charset="utf-16"')), 'UTF-8');
  assert.equal(formEncoding(formOf(''), 'utf-16le'), 'UTF-8');

  const submit = (attributes: string, encoding?: string) =>
    formSubmission(formOf(attributes), null, {
      base: 'https://example.test/',
      encoding,
      boundary: 'B',
    })!;
  assert.equal(
    submit('', 'euc-jp').url,
    'https://example.test/go?_charset_=EUC-JP&q=%A4%A2+b',
  );
  assert.equal(
    submit('').url,
    'https://example.test/go?_charset_=UTF-8&q=%E3%81%82+b',
  );
  const posted = submit('method=post', 'euc-jp');
  assert.equal(posted.body, '_charset_=EUC-JP&q=%A4%A2+b');
  const plain = submit('method=post enctype=text/plain', 'euc-jp');
  assert.deepEqual(
    [...(plain.body as Uint8Array)],
    [...latin('_charset_=EUC-JP\r\nq=\xa4\xa2 b\r\n')],
  );
  const parts = submit('method=post enctype=multipart/form-data', 'euc-jp');
  assert.ok(
    Buffer.from(parts.body as Uint8Array)
      .toString('latin1')
      .includes('name="q"\r\n\r\n\xa4\xa2 b\r\n'),
  );
});

test('HtmlNetwork decodes a document in what it finds, and says what it found', async (t) => {
  const answers: Record<string, [string, Uint8Array]> = {
    'https://example.test/header': [
      'text/html; charset=ks_c_5601-1987',
      Uint8Array.of(0x81, 0x41),
    ],
    'https://example.test/meta': [
      'text/html',
      Uint8Array.from([...latin('<meta charset=big5>'), 0x88, 0x62]),
    ],
    'https://example.test/none': ['text/html', latin('caf\xe9')],
  };
  const fetched = t.mock.method(globalThis, 'fetch', async (url: string) => {
    const [type, bytes] = answers[url];
    return new Response(bytes, { headers: { 'content-type': type } });
  });
  const network = new HtmlNetwork();
  const header = await network.html('https://example.test/header');
  assert.equal(header.charset, 'EUC-KR');
  assert.equal(header.source, '갂');
  const meta = await network.html('https://example.test/meta');
  assert.equal(meta.charset, 'Big5');
  assert.ok(meta.source.endsWith('Ê̄'));
  const none = await network.html('https://example.test/none');
  assert.equal(none.charset, 'windows-1252');
  assert.equal(none.source, 'café');
  assert.equal(fetched.mock.callCount(), 3);
});

/** A page whose scripts run, in `charset`, and what it logged. */
async function page(
  script: string,
  options: {
    charset?: string;
    fetch?: (request: FetchRequest) => Promise<FetchResponse>;
    body?: string;
  } = {},
): Promise<{ until(prefix: string): Promise<string> }> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source: `<!doctype html><html><body>${options.body ?? ''}<script>${script}</script></body></html>`,
      partial: false,
      baseUrl: 'https://example.test/page.html',
      charset: options.charset,
      scripts: {
        ...(options.fetch && { fetch: options.fetch }),
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
      },
    }),
    FONTS ? { width: 200, height: 100, fonts: FONTS } : { backend: 'mock' },
  );
  return {
    async until(prefix) {
      const end = Date.now() + 5000;
      const found = () => logs.find((l) => l.startsWith(`log: ${prefix}`));
      while (!found() && Date.now() < end) {
        await act(() => new Promise((r) => setTimeout(r, 10)));
      }
      const line = found();
      assert.ok(line, `no "${prefix}" in:\n${logs.join('\n')}`);
      return line.slice(`log: ${prefix}`.length);
    },
  };
}

const LOG =
  'function log() { console.log([].slice.call(arguments).join("|")); }';

scripted(
  'a page reads the encoding its document came in, in each of its names',
  async () => {
    const p = await page(
      LOG +
        'log("set", document.characterSet, document.charset, document.inputEncoding);' +
        'log("own", document.implementation.createHTMLDocument("x").characterSet);',
      { charset: 'x-sjis' },
    );
    assert.equal(await p.until('set|'), 'Shift_JIS|Shift_JIS|Shift_JIS');
    assert.equal(await p.until('own|'), 'UTF-8');
  },
);

scripted('a document a host says nothing of is UTF-8', async () => {
  const p = await page(LOG + 'log("set", document.characterSet);');
  assert.equal(await p.until('set|'), 'UTF-8');
});

scripted(
  'a TextDecoder takes every label, and answers with the name in lower case',
  async () => {
    const p = await page(
      LOG +
        'var names = ["utf8", "windows-1251", "koi8-u", "gbk", "x-sjis", "iso-8859-8-i", "x-user-defined", "utf-16"];' +
        'log("names", names.map(function (n) { return new TextDecoder(n).encoding; }).join(","));' +
        'function refused(label) { try { new TextDecoder(label); return "no"; } catch (e) { return e.name; } }' +
        'log("refused", refused("nonsense"), refused("replacement"), refused("hz-gb-2312"), refused(""));' +
        'log("bytes", new TextDecoder("windows-1251").decode(new Uint8Array([0xcf, 0xf0])));' +
        'log("kr", new TextDecoder("euc-kr").decode(new Uint8Array([0x81, 0x41])));',
    );
    assert.equal(
      await p.until('names|'),
      'utf-8,windows-1251,koi8-u,gbk,shift_jis,iso-8859-8-i,x-user-defined,utf-16le',
    );
    assert.equal(
      await p.until('refused|'),
      'RangeError|RangeError|RangeError|RangeError',
    );
    assert.equal(await p.until('bytes|'), 'Пр');
    assert.equal(await p.until('kr|'), '갂');
  },
);

scripted(
  'a TextDecoder’s stream, `fatal` and BOM are the standard’s, and a byte U+0001 is text',
  async () => {
    const p = await page(
      LOG +
        'var d = new TextDecoder("gb18030");' +
        'var out = [0x94, 0x39, 0xfc, 0x36].map(function (b) { return d.decode(new Uint8Array([b]), { stream: true }); }).join("");' +
        'log("stream", out + d.decode(), d.decode(new Uint8Array([0x41])));' +
        'function fatal(name, bytes) { try { return new TextDecoder(name, { fatal: true }).decode(new Uint8Array(bytes)); } catch (e) { return e.name; } }' +
        'log("fatal", fatal("euc-kr", [0xff]), fatal("utf-16le", [0x00]), fatal("iso-8859-3", [0xa5]), fatal("big5", [0x41]));' +
        'var bom = new TextDecoder("utf-16le");' +
        'log("bom", bom.decode(new Uint8Array([0xff, 0xfe, 0x41, 0x00])).length, new TextDecoder("utf-16le", { ignoreBOM: true }).decode(new Uint8Array([0xff, 0xfe, 0x41, 0x00])).length);' +
        'log("gb bom", new TextDecoder("gb18030").decode(new Uint8Array([0x84, 0x31, 0x95, 0x33])).charCodeAt(0));' +
        'log("one", new TextDecoder("windows-1252").decode(new Uint8Array([1])).charCodeAt(0));',
    );
    assert.equal(await p.until('stream|'), '\u{1f600}|A');
    assert.equal(await p.until('fatal|'), 'TypeError|TypeError|TypeError|A');
    assert.equal(await p.until('bom|'), '1|2');
    assert.equal(await p.until('gb bom|'), '65279');
    assert.equal(await p.until('one|'), '1');
  },
);

scripted(
  'a stream of text keeps a surrogate pair a chunk split, and each stream has the IDL’s shape',
  async () => {
    const p = await page(
      LOG +
        'var stream = new TextEncoderStream(); var writer = stream.writable.getWriter(); var reader = stream.readable.getReader();' +
        'var read = []; (function pull() { reader.read().then(function (r) { if (r.done) { log("bytes", read.join(",")); return; } read.push.apply(read, r.value); pull(); }); })();' +
        'writer.write("\\ud83d"); writer.write("\\ude00"); writer.close();' +
        'log("shape", Object.getPrototypeOf(TextDecoderStream) === Function.prototype, TextDecoderStream.length, "encoding" in TextDecoder.prototype, Object.keys(new TextDecoder()).filter(function (k) { return k[0] !== "_"; }).length);',
    );
    assert.equal(await p.until('bytes|'), '240,159,152,128');
    assert.equal(await p.until('shape|'), 'true|0|true|0');
  },
);

scripted(
  'a link’s query is in the document’s encoding, and `URL` keeps UTF-8',
  async () => {
    const p = await page(
      LOG +
        'var a = document.createElement("a"); a.href = "?\\u3042";' +
        'log("href", a.search, new URL("https://example.test/?\\u3042").search);',
      { charset: 'euc-jp' },
    );
    assert.equal(await p.until('href|'), '?%A4%A2|?%E3%81%82');
  },
);

scripted(
  'a frame is in what its bytes say, then in its parent’s encoding, and its text is decoded with it',
  async () => {
    const answers: Record<string, [string, number[]]> = {
      '/labelled': ['text/html; charset=big5', [0x88, 0x62]],
      '/inherits': ['text/html', [0x81, 0x41]],
      '/xml': ['application/xml', [...latin('<?xml version="1.0"?><a/>')]],
    };
    const p = await page(
      LOG +
        'var left = 3; document.querySelectorAll("iframe").forEach(function (f) {' +
        '  f.onload = function () {' +
        '    var d = f.contentDocument; log(f.id, d.characterSet, (d.body || d.documentElement).textContent);' +
        '  };' +
        '});',
      {
        charset: 'euc-kr',
        body: '<iframe id=one src=/labelled></iframe><iframe id=two src=/inherits></iframe><iframe id=three src=/xml></iframe>',
        fetch: async (request) => {
          const [type, bytes] = answers[new URL(request.url).pathname];
          return {
            url: request.url,
            status: 200,
            statusText: 'OK',
            redirected: false,
            headers: [['content-type', type]],
            body: new TextDecoder('latin1').decode(Uint8Array.from(bytes)),
            bytes: Uint8Array.from(bytes),
            type: 'basic',
          };
        },
      },
    );
    assert.equal(await p.until('one|'), 'Big5|Ê̄');
    assert.equal(await p.until('two|'), 'EUC-KR|갂');
    assert.ok((await p.until('three|')).startsWith('UTF-8|'));
  },
);
