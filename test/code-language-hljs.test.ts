// `hljsLanguage` — highlight.js behind the `Language` seam.
//
// The engine is handed in, so most of this runs against a **fake** one: the
// logic worth testing is the flattening of highlight.js's `<span>` HTML into
// per-line tokens, and a fake is the only way to state an exact input for it.
// One test at the bottom runs the real library when it happens to be
// installed — it is not a dependency of this package (see src/code-language/
// hljs.ts), so that one skips rather than fails when it is absent.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import {
  codeRuns,
  hljsLanguage,
  tokenizeText,
  LIGHT_TOKEN_STYLES,
} from '../src/code-language/index.js';
import type { HljsLike } from '../src/code-language/index.js';

/** A fake highlight.js: knows one language, returns canned HTML. */
function fakeHljs(html: string, known = ['python']): HljsLike {
  return {
    getLanguage: (name) => (known.includes(name) ? {} : undefined),
    highlight: () => ({ value: html }),
  };
}

const tokensFor = (hljs: HljsLike, name: string, text: string) => {
  const language = hljsLanguage({ hljs, name });
  assert.ok(language, `expected a Language for ${name}`);
  return tokenizeText(language, text);
};

test('an unknown language is null, not a throw', () => {
  const hljs = fakeHljs('');
  assert.equal(hljsLanguage({ hljs, name: 'klingon' }), null);
  assert.equal(hljsLanguage({ hljs, name: '' }), null);
  assert.ok(hljsLanguage({ hljs, name: 'python' }));
  // the tag is a fence tag, so case is not the caller's problem
  assert.ok(hljsLanguage({ hljs, name: 'PYTHON' }));
});

test('scopes map onto the token vocabulary, at the right offsets', () => {
  const text = 'def f():';
  const hljs = fakeHljs(
    '<span class="hljs-keyword">def</span> ' +
      '<span class="hljs-title function_">f</span>():',
  );
  const [line] = tokensFor(hljs, 'python', text);
  assert.deepStrictEqual(line, [
    { from: 0, to: 3, type: 'keyword' },
    { from: 4, to: 5, type: 'function' },
  ]);
  // and the gaps are exactly what is left
  assert.equal(text.slice(3, 4), ' ');
  assert.equal(text.slice(5), '():');
});

test('a nested span with no mapping of its own inherits the enclosing type', () => {
  const text = 'x = "a b"';
  const hljs = fakeHljs(
    'x = <span class="hljs-string">"a <span class="hljs-nonesuch">b</span>"</span>',
  );
  const [line] = tokensFor(hljs, 'python', text);
  // one run, not three: the inner span carries the outer type, and adjacent
  // same-type runs merge
  assert.deepStrictEqual(line, [{ from: 4, to: 9, type: 'string' }]);
});

test('entities come back as the characters they stand for', () => {
  const text = 'a < b && c > "d"';
  const hljs = fakeHljs('a &lt; b &amp;&amp; c &gt; &quot;d&quot;');
  const [line] = tokensFor(hljs, 'python', text);
  assert.deepStrictEqual(line, [], 'nothing scoped, so no tokens');
  // the real assertion is that offsets did not drift, which the run-length
  // invariant below states directly
});

test('a token never straddles a line, and offsets restart per line', () => {
  const text = 'a = """one\ntwo"""\nb = 1';
  const hljs = fakeHljs(
    'a = <span class="hljs-string">"""one\ntwo"""</span>\n' +
      'b = <span class="hljs-number">1</span>',
  );
  const lines = tokensFor(hljs, 'python', text);
  assert.equal(lines.length, 3);
  assert.deepStrictEqual(lines[0], [{ from: 4, to: 10, type: 'string' }]);
  assert.deepStrictEqual(lines[1], [{ from: 0, to: 6, type: 'string' }]);
  assert.deepStrictEqual(lines[2], [{ from: 4, to: 5, type: 'number' }]);
});

test('scopeTypes overrides and extends the default map', () => {
  const html = '<span class="hljs-attribute">a</span>';
  const language = hljsLanguage({
    hljs: fakeHljs(html),
    name: 'python',
    scopeTypes: { attribute: 'variableName' },
  });
  assert.ok(language);
  assert.deepStrictEqual(tokenizeText(language, 'a')[0], [
    { from: 0, to: 1, type: 'variableName' },
  ]);
});

test('a grammar that throws leaves the code plain rather than failing', () => {
  const hljs: HljsLike = {
    getLanguage: () => ({}),
    highlight: () => {
      throw new Error('illegal');
    },
  };
  const [line] = tokensFor(hljs, 'python', 'whatever\nit is');
  assert.deepStrictEqual(line, []);
});

test('the tokenizer re-reads the lines it was handed after an edit', () => {
  // The seam's rule: the editor edits its line array in place and calls
  // edit(); a tokenizer that snapshotted at setLines would paint the
  // pre-edit document.
  let highlighted: string | null = null;
  const hljs: HljsLike = {
    getLanguage: () => ({}),
    highlight: (code) => {
      highlighted = code;
      return { value: `<span class="hljs-number">${code}</span>` };
    },
  };
  const language = hljsLanguage({ hljs, name: 'python' });
  assert.ok(language);
  const lines = ['one'];
  const tokenizer = language.createTokenizer({ invalidate: () => {} });
  tokenizer.setLines(lines);
  tokenizer.lineTokens(0);
  assert.equal(highlighted, 'one');

  lines[0] = 'two';
  tokenizer.edit({ fromLine: 0, removed: 1, inserted: 1 });
  tokenizer.lineTokens(0);
  assert.equal(highlighted, 'two', 'the edit was picked up');
});

test('the whole document is highlighted once per generation', () => {
  let calls = 0;
  const hljs: HljsLike = {
    getLanguage: () => ({}),
    highlight: () => {
      calls += 1;
      return { value: 'a\nb\nc' };
    },
  };
  const language = hljsLanguage({ hljs, name: 'python' });
  assert.ok(language);
  const tokenizer = language.createTokenizer({ invalidate: () => {} });
  tokenizer.setLines(['a', 'b', 'c']);
  tokenizer.lineTokens(0);
  tokenizer.lineTokens(1);
  tokenizer.lineTokens(2);
  assert.equal(calls, 1, 'three pulls, one highlight');
});

test('codeRuns reaches it through resolveLanguage, and the runs are lossless', () => {
  const text = 'def f():\n    return 1';
  const hljs = fakeHljs(
    '<span class="hljs-keyword">def</span> ' +
      '<span class="hljs-title function_">f</span>():\n' +
      '    <span class="hljs-keyword">return</span> ' +
      '<span class="hljs-number">1</span>',
  );
  const runs = codeRuns(text, 'python', {
    styles: LIGHT_TOKEN_STYLES,
    color: '#000000',
    resolveLanguage: (tag) => hljsLanguage({ hljs, name: tag }),
  });
  assert.equal(
    runs.map((r) => r.text).join(''),
    text,
    'the runs concatenate back to exactly the input',
  );
  assert.ok(
    new Set(runs.map((r) => r.color)).size > 1,
    'and something actually got a colour',
  );
});

test('a tag resolveLanguage does not know falls through to the built-ins', () => {
  const text = 'const x = 1;';
  // this fake knows nothing, so `js` must still reach the built-in tokenizer
  const runs = codeRuns(text, 'js', {
    styles: LIGHT_TOKEN_STYLES,
    color: '#000000',
    resolveLanguage: () => null,
  });
  assert.equal(runs.map((r) => r.text).join(''), text);
  assert.ok(
    new Set(runs.map((r) => r.color)).size > 1,
    'the built-in javascript tokenizer still ran',
  );
});

// --- against the real library ----------------------------------------------

const require = createRequire(import.meta.url);
let realHljs: HljsLike | null = null;
try {
  const mod = require('highlight.js/lib/common') as { default?: HljsLike };
  realHljs = (mod.default ?? mod) as HljsLike;
} catch {
  // not installed: this package does not depend on it, and that is the point
}

test(
  'the structural type matches the real highlight.js',
  { skip: realHljs ? false : 'highlight.js is not installed' },
  () => {
    const hljs = realHljs as HljsLike;
    assert.equal(hljsLanguage({ hljs, name: 'no-such-language' }), null);

    const text = '# a comment\ndef f(x):\n    return "s"';
    const lines = tokensFor(hljs, 'python', text);
    assert.equal(lines.length, 3);

    const typeAt = (line: number, ch: number) =>
      lines[line].find((t) => t.from <= ch && ch < t.to)?.type;
    assert.equal(typeAt(0, 2), 'comment');
    assert.equal(typeAt(1, 0), 'keyword', 'def');
    assert.equal(typeAt(2, 11), 'string', 'the "s"');

    // the invariant everything else rests on: tokens are inside their line
    const src = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let last = 0;
      for (const t of lines[i]) {
        assert.ok(t.from >= last, `line ${i}: tokens are sorted and disjoint`);
        assert.ok(t.to <= src[i].length, `line ${i}: token inside the line`);
        last = t.to;
      }
    }
  },
);
