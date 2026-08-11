// The language half of the code editor, no display needed: the stream
// engine (laziness, edit invalidation, convergence), each built-in mode's
// interesting corners, the tab display mapping, completion sources, and
// both ecosystem adapters driven by hand-built fakes.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  glsl,
  javascript,
  json,
  lezerLanguage,
  lineModeLanguage,
  rankCompletions,
  shell,
  sql,
  sqlCompletionSource,
  textMateLanguage,
  wordCompletionSource,
} from '../src/code-editor/index.js';
import type {
  CompletionContext,
  Language,
  Token,
} from '../src/code-editor/index.js';
import { tabMap } from '../src/code-editor/doc.js';
import type { TextMateStateLike } from '../src/code-editor/index.js';

const host = { invalidate: () => {} };

function tokenize(language: Language, text: string): Token[][] {
  const tok = language.createTokenizer(host);
  const lines = text.split('\n');
  tok.setLines(lines);
  return lines.map((_, i) => [...tok.lineTokens(i)]);
}

/** The `type` painted at one character of one line, or null. */
function typeAt(tokens: Token[][], line: number, ch: number): string | null {
  for (const t of tokens[line]) {
    if (t.from <= ch && ch < t.to) return t.type;
  }
  return null;
}

function textOf(line: string, t: Token): string {
  return line.slice(t.from, t.to);
}

// --- engine ----------------------------------------------------------------

test('stream engine: lazy, incremental, converging', () => {
  let runs = 0;
  const lang = lineModeLanguage<{ n: number }>({
    name: 'count',
    startState: () => ({ n: 0 }),
    runLine(text, state) {
      runs++;
      if (text.includes('open')) state.n++;
      return [
        { from: 0, to: text.length, type: state.n > 0 ? 'string' : 'comment' },
      ];
    },
  });
  const lines = ['a', 'b', 'open', 'c', 'd'];
  const tok = lang.createTokenizer(host);
  tok.setLines(lines);

  assert.deepEqual(tok.lineTokens(1), [{ from: 0, to: 1, type: 'comment' }]);
  assert.equal(runs, 2, 'tokenizes only up to the asked line');

  assert.equal(tok.lineTokens(4)[0].type, 'string');
  assert.equal(runs, 5);

  // edit line 3 (same line count): re-tokenizes 3 and 4, then the entry
  // state matches the cache and everything below survives. (The engine
  // converges one line past the edit — the splice punches the candidate for
  // the first following line — which is a line of wasted work, not two.)
  lines[3] = 'c!';
  tok.edit({ fromLine: 3, removed: 1, inserted: 1 });
  runs = 0;
  assert.equal(tok.lineTokens(4)[0].type, 'string');
  assert.equal(runs, 2, 'converged just after the edited line');

  // edit line 0 so the *state* downstream changes: no convergence
  lines[0] = 'open';
  tok.edit({ fromLine: 0, removed: 1, inserted: 1 });
  runs = 0;
  assert.equal(tok.lineTokens(4)[0].type, 'string');
  assert.equal(runs, 5, 'state change re-tokenizes everything below');
});

test('stream engine: inserting lines shifts caches without lying', () => {
  const lang = lineModeLanguage<{ depth: number }>({
    name: 'depth',
    startState: () => ({ depth: 0 }),
    runLine(text, state) {
      if (text === '{') state.depth++;
      if (text === '}') state.depth--;
      return [
        { from: 0, to: Math.max(1, text.length), type: `d${state.depth}` },
      ];
    },
  });
  const lines = ['{', 'x', '}'];
  const tok = lang.createTokenizer(host);
  tok.setLines(lines);
  assert.equal(tok.lineTokens(2)[0].type, 'd0');

  lines.splice(1, 0, '{');
  tok.edit({ fromLine: 1, removed: 0, inserted: 1 });
  assert.equal(tok.lineTokens(1)[0].type, 'd2');
  assert.equal(tok.lineTokens(2)[0].type, 'd2', 'old cache below was invalid');
  assert.equal(tok.lineTokens(3)[0].type, 'd1');
});

// --- sql -------------------------------------------------------------------

test('sql: keywords, strings, comments, params', () => {
  const t = tokenize(
    sql(),
    "select id, 'it''s' from users -- trailing\nwhere x = $1 /* note\nstill */ and y = 2.5e3",
  );
  assert.equal(typeAt(t, 0, 0), 'keyword'); // select
  assert.equal(typeAt(t, 0, 11), 'string'); // 'it''s'
  assert.equal(typeAt(t, 0, 30), 'comment'); // --
  assert.equal(typeAt(t, 1, 10), 'atom'); // $1
  assert.equal(typeAt(t, 1, 13), 'comment'); // /* note
  assert.equal(typeAt(t, 2, 0), 'comment'); // still */
  assert.equal(typeAt(t, 2, 19), 'number'); // 2.5e3
});

test('sql: multi-line string carries state', () => {
  const t = tokenize(sql(), "select 'one\ntwo' as x");
  assert.equal(typeAt(t, 1, 0), 'string');
  assert.equal(typeAt(t, 1, 5), 'keyword'); // as
});

// --- shell -----------------------------------------------------------------

test('shell: command position, strings, expansions', () => {
  const t = tokenize(shell(), 'if grep -q "x $HOME" f; then\n  echo done\nfi');
  assert.equal(typeAt(t, 0, 0), 'keyword'); // if
  assert.equal(typeAt(t, 0, 3), 'function'); // grep (command position)
  assert.equal(typeAt(t, 0, 12), 'string');
  assert.equal(typeAt(t, 0, 15), 'variableName'); // $HOME
  assert.equal(typeAt(t, 1, 2), 'function'); // echo
  assert.equal(typeAt(t, 1, 7), null); // done is an argument here
  assert.equal(typeAt(t, 2, 0), 'keyword'); // fi
});

test('shell: heredoc', () => {
  const t = tokenize(shell(), 'cat <<EOF\nliteral $stuff\nEOF\nls');
  assert.equal(typeAt(t, 1, 0), 'string2');
  assert.equal(typeAt(t, 2, 0), 'atom'); // the terminator
  assert.equal(typeAt(t, 3, 0), 'function'); // back to commands
});

// --- glsl ------------------------------------------------------------------

test('glsl: preprocessor, types, swizzles, builtins', () => {
  const t = tokenize(
    glsl(),
    '#version 330\nuniform vec2 u_res;\nvoid main() { gl_FragColor.rgb = mix(a, b, 0.5f); }',
  );
  assert.equal(typeAt(t, 0, 0), 'meta');
  assert.equal(typeAt(t, 1, 0), 'modifier'); // uniform
  assert.equal(typeAt(t, 1, 8), 'typeName'); // vec2
  assert.equal(typeAt(t, 2, 0), 'typeName'); // void
  assert.equal(typeAt(t, 2, 14), 'atom'); // gl_FragColor
  assert.equal(typeAt(t, 2, 27), 'propertyName'); // .rgb swizzle
  assert.equal(typeAt(t, 2, 33), 'function'); // mix(
  assert.equal(typeAt(t, 2, 43), 'number'); // 0.5f
});

// --- javascript ------------------------------------------------------------

test('javascript: template literals nest through ${}', () => {
  const src = 'const s = `a ${x + `${y}`} b`;\nconst n = 1;';
  //           0123456789012345678901234567890
  const t = tokenize(javascript(), src);
  assert.equal(typeAt(t, 0, 11), 'string2'); // a inside the outer template
  assert.equal(typeAt(t, 0, 15), 'variableName'); // x in the interpolation
  assert.equal(typeAt(t, 0, 19), 'string2'); // the inner template's backtick
  assert.equal(typeAt(t, 0, 22), 'variableName'); // y, one level deeper
  assert.equal(typeAt(t, 0, 24), 'string2'); // inner closing backtick
  assert.equal(typeAt(t, 0, 27), 'string2'); // ␣b — the outer resumed
  assert.equal(typeAt(t, 1, 0), 'keyword'); // const on the next line
});

test('javascript: regex vs division', () => {
  const t = tokenize(
    javascript(),
    'const r = /ab[c/]+/g;\nconst q = a / b / c;',
  );
  assert.equal(typeAt(t, 0, 10), 'string2'); // the regex, / in class included
  assert.equal(typeAt(t, 0, 19), 'string2'); // flags
  assert.equal(typeAt(t, 1, 12), 'operator'); // division
  assert.equal(typeAt(t, 1, 14), 'variableName'); // b, not regex body
});

test('javascript: unterminated block comment carries; strings do not', () => {
  const t = tokenize(javascript(), 'let a; /* c\nstill */ let b = "x\ny";');
  assert.equal(typeAt(t, 0, 7), 'comment');
  assert.equal(typeAt(t, 1, 0), 'comment');
  assert.equal(typeAt(t, 1, 9), 'keyword'); // let
  assert.equal(typeAt(t, 1, 17), 'string'); // "x — painted to its line end
  // …but the next line is code again: an unterminated string (no trailing
  // backslash) does not swallow the rest of the file
  assert.equal(typeAt(t, 2, 0), 'variableName');
});

test('typescript keywords are opt-in', () => {
  const plain = tokenize(javascript(), 'interface X {}');
  const ts = tokenize(javascript({ typescript: true }), 'interface X {}');
  assert.equal(typeAt(plain, 0, 0), 'variableName');
  assert.equal(typeAt(ts, 0, 0), 'keyword');
});

// --- json ------------------------------------------------------------------

test('json: keys vs values', () => {
  const t = tokenize(json(), '{ "a": "b", "c": [1, true, null] }');
  assert.equal(typeAt(t, 0, 3), 'propertyName'); // "a"
  assert.equal(typeAt(t, 0, 8), 'string'); // "b"
  assert.equal(typeAt(t, 0, 13), 'propertyName'); // "c"
  assert.equal(typeAt(t, 0, 18), 'number');
  assert.equal(typeAt(t, 0, 22), 'bool');
  assert.equal(typeAt(t, 0, 28), 'atom');
});

// --- tabs ------------------------------------------------------------------

test('tabMap: expansion and both mappings', () => {
  const m = tabMap('\ta\tbc', 4);
  assert.equal(m.display, '    a   bc');
  assert.equal(m.toDisplay(0), 0); // at the tab
  assert.equal(m.toDisplay(1), 4); // 'a'
  assert.equal(m.toDisplay(2), 5); // second tab
  assert.equal(m.toDisplay(3), 8); // 'b'
  assert.equal(m.toDisplay(5), 10); // end of line
  assert.equal(m.toRaw(4), 1);
  assert.equal(m.toRaw(1), 0, 'inside the expansion snaps to the tab');
  assert.equal(m.toRaw(3), 1, 'near the end of the expansion snaps past it');
  assert.equal(m.toRaw(10), 5);
  const plain = tabMap('abc', 4);
  assert.equal(plain.display, 'abc');
  assert.equal(plain.toDisplay(2), 2);
});

// --- completion ------------------------------------------------------------

function contextFor(
  text: string,
  line: number,
  ch: number,
  language: Language | null = null,
): CompletionContext {
  const lines = text.split('\n');
  const wordMatch = /[\w$]*$/.exec(lines[line].slice(0, ch))?.[0] ?? '';
  return {
    lines,
    pos: { line, ch },
    word: {
      from: { line, ch: ch - wordMatch.length },
      text: wordMatch,
    },
    trigger: 'explicit',
    language,
  };
}

test('rankCompletions: prefix beats substring, boost breaks ties', () => {
  const ranked = rankCompletions(
    [
      { label: 'select' },
      { label: 'unselect' },
      { label: 'selfie', boost: 5 },
      { label: 'other' },
    ],
    'sel',
  );
  assert.deepEqual(
    ranked.map((r) => r.label),
    ['selfie', 'select', 'unselect'],
  );
});

test('sqlCompletionSource: tables, aliases, columns', () => {
  const source = sqlCompletionSource({
    users: ['id', 'name'],
    orders: ['id', 'total'],
  });
  const tables = source(contextFor('select * from us', 0, 16));
  assert.ok(tables && !(tables instanceof Promise));
  assert.ok(
    tables.items.some((i) => i.label === 'users' && i.kind === 'table'),
  );

  const viaAlias = source(contextFor('select u.na from users u', 0, 11));
  assert.ok(viaAlias && !(viaAlias instanceof Promise));
  assert.deepEqual(
    viaAlias.items.map((i) => i.label),
    ['id', 'name'],
  );
  assert.equal(viaAlias.from?.ch, 9, 'replaces only the part after the dot');
});

test('wordCompletionSource: document words minus the one being typed', () => {
  const source = wordCompletionSource();
  const result = source(contextFor('alpha beta\nalp', 1, 3));
  assert.ok(result && !(result instanceof Promise));
  const labels = result.items.map((i) => i.label);
  assert.ok(labels.includes('alpha'));
  assert.ok(labels.includes('beta'));
  assert.ok(!labels.includes('alp'), 'the word under the caret is not itself');
});

// --- adapters --------------------------------------------------------------

test('textMateLanguage: scopes map, state converges via equals()', () => {
  // a fake IGrammar: '/*' opens a comment that '*/' closes, line-state via
  // a stack object with equals(), the way vscode-textmate's StateStack works
  interface FakeStack extends TextMateStateLike {
    inComment: boolean;
  }
  const stack = (inComment: boolean): FakeStack => ({
    inComment,
    equals: (other) => (other as FakeStack).inComment === inComment,
  });
  let calls = 0;
  const grammar = {
    tokenizeLine(line: string, prev: TextMateStateLike | null) {
      calls++;
      const wasIn = (prev as FakeStack | null)?.inComment ?? false;
      const nowIn = wasIn ? !line.includes('*/') : line.includes('/*');
      return {
        tokens: [
          {
            startIndex: 0,
            endIndex: line.length,
            scopes:
              wasIn || line.includes('/*')
                ? ['source.fake', 'comment.block.fake']
                : ['source.fake', 'keyword.control.fake'],
          },
        ],
        ruleStack: stack(nowIn),
      };
    },
  };
  const lang = textMateLanguage({ name: 'fake', grammar });
  const lines = ['if', '/* c', 'still c */', 'fi'];
  const tok = lang.createTokenizer(host);
  tok.setLines(lines);
  assert.equal(tok.lineTokens(0)[0].type, 'keyword');
  assert.equal(tok.lineTokens(1)[0].type, 'comment');
  assert.equal(tok.lineTokens(2)[0].type, 'comment');
  assert.equal(tok.lineTokens(3)[0].type, 'keyword');

  // editing the last line re-tokenizes it alone: earlier states converge
  lines[3] = 'done';
  tok.edit({ fromLine: 3, removed: 1, inserted: 1 });
  calls = 0;
  tok.lineTokens(3);
  assert.equal(calls, 1);
});

test('lezerLanguage: injected highlighter, async tokens, invalidate', async () => {
  const parsed: string[] = [];
  const parser = {
    parse(input: string) {
      parsed.push(input);
      return { input };
    },
  };
  // a fake @lezer/highlight: mark every "kw" occurrence as tok-keyword
  const highlight = {
    classHighlighter: {},
    highlightTree(
      tree: unknown,
      _hl: unknown,
      put: (from: number, to: number, classes: string) => void,
    ) {
      const input = (tree as { input: string }).input;
      for (const m of input.matchAll(/kw/g)) {
        put(m.index, m.index + 2, 'tok-keyword');
      }
    },
  };
  let invalidated = -1;
  const lang = lezerLanguage({ name: 'fake', parser, highlight, delay: 0 });
  const tok = lang.createTokenizer({
    invalidate: (from) => {
      invalidated = from;
    },
  });
  tok.setLines(['a kw b', 'kw']);
  assert.deepEqual(tok.lineTokens(0), [], 'tokens are empty until the parse');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(invalidated, 0);
  assert.deepEqual(tok.lineTokens(0), [{ from: 2, to: 4, type: 'keyword' }]);
  assert.deepEqual(tok.lineTokens(1), [{ from: 0, to: 2, type: 'keyword' }]);
  assert.equal(parsed[parsed.length - 1], 'a kw b\nkw');
  tok.dispose?.();
});

test('lezerLanguage: a missing highlighter paints plain, quietly', async () => {
  const lang = lezerLanguage({
    name: 'fake',
    parser: { parse: () => ({}) },
    highlight: Promise.reject(new Error('not installed')),
  });
  const tok = lang.createTokenizer(host);
  tok.setLines(['text']);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(tok.lineTokens(0), []);
  tok.dispose?.();
});

// a helper for eyeballing failures — kept out of assertions
void textOf;

// --- jsx / tsx -------------------------------------------------------------

test('jsx: tags, attributes, expressions, children', () => {
  const lang = javascript({ typescript: true, jsx: true });
  const src = [
    'const ui = (',
    '  <box style={{ gap: 4 }} focusable>',
    '    {rows.map((r) => <Item key={r.id} />)}',
    '    plain text',
    '  </box>',
    ');',
  ].join('\n');
  const t = tokenize(lang, src);
  assert.equal(typeAt(t, 1, 3), 'typeName'); // <box — host element
  assert.equal(typeAt(t, 1, 7), 'propertyName'); // style attribute
  // gap inside the {{…}} object is ordinary JS — object keys paint as
  // variableName (detecting them would misfire on ternary `b :` arms)
  assert.equal(typeAt(t, 1, 16), 'variableName');
  assert.equal(typeAt(t, 1, 27), 'propertyName'); // focusable
  assert.equal(typeAt(t, 2, 5), 'variableName'); // rows in {rows.map(…)}
  assert.equal(typeAt(t, 2, 10), 'function'); // .map(
  assert.equal(typeAt(t, 2, 22), 'className'); // <Item — a component
  assert.equal(typeAt(t, 2, 27), 'propertyName'); // key attribute
  assert.equal(typeAt(t, 3, 6), null); // children text paints plain
  assert.equal(typeAt(t, 4, 4), 'typeName'); // </box>
  assert.equal(typeAt(t, 5, 0), 'bracket'); // back in code: the )
});

test('jsx: string attributes, fragments, self-closing back to code', () => {
  const lang = javascript({ jsx: true });
  const t = tokenize(
    lang,
    'const a = <>{x}</>;\nconst b = <img src="x.png" />;\nconst c = b / 2;',
  );
  assert.equal(typeAt(t, 0, 13), 'variableName'); // x inside the fragment
  assert.equal(typeAt(t, 1, 11), 'typeName'); // img
  assert.equal(typeAt(t, 1, 15), 'propertyName'); // src
  assert.equal(typeAt(t, 1, 19), 'string'); // "x.png"
  assert.equal(typeAt(t, 2, 0), 'keyword'); // const — cleanly out of JSX
  assert.equal(typeAt(t, 2, 12), 'operator'); // and / still divides
});

test('jsx: comparison stays comparison after a value', () => {
  const t = tokenize(javascript({ jsx: true }), 'if (a < b) go();');
  assert.equal(typeAt(t, 0, 6), 'operator'); // a < b, not a tag
});

// --- theme picking ---------------------------------------------------------

test('isDarkBackground and autoTokenStyles', async () => {
  const {
    isDarkBackground,
    autoTokenStyles,
    DARK_TOKEN_STYLES,
    LIGHT_TOKEN_STYLES,
  } = await import('../src/code-editor/theme.js');
  assert.equal(isDarkBackground('#1e2227'), true);
  assert.equal(isDarkBackground('#ffffff'), false);
  assert.equal(isDarkBackground('#fff'), false);
  assert.equal(isDarkBackground('rgba(40, 44, 52, 1)'), true);
  assert.equal(isDarkBackground('rgb(250, 250, 250)'), false);
  assert.equal(isDarkBackground('transparent'), null);
  assert.equal(isDarkBackground(undefined), null);
  assert.equal(autoTokenStyles('#282c34'), DARK_TOKEN_STYLES);
  assert.equal(autoTokenStyles('#fdfdfd'), LIGHT_TOKEN_STYLES);
  assert.equal(autoTokenStyles('nonsense'), LIGHT_TOKEN_STYLES);
});
