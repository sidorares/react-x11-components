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
import { SYNC_LINES, TOKENIZE_LIMIT } from '../src/code-language/stream.js';
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

  // edit line 3 (same line count): re-tokenizes 3, then the state leaving
  // it matches the one line 4 was tokenized from, and everything below
  // survives — line 4 included, which is the line an editor then need not
  // lay out again
  const below = tok.lineTokens(4);
  lines[3] = 'c!';
  tok.edit({ fromLine: 3, removed: 1, inserted: 1 });
  runs = 0;
  assert.equal(
    tok.lineTokens(4),
    below,
    'the line after the edit kept its tokens',
  );
  assert.equal(runs, 1, 'converged at the edited line');

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
  } = await import('../src/code-language/theme.js');
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

test('stream engine: a line past the tokenizing limit is tokenized only so far', () => {
  // CodeMirror's maxHighlightLength: a line is tokenized whole on every
  // edit to it, and a minified file is one line.
  const long = 'const a = "b"; '.repeat(2000); // 30,000 characters
  const tokens = tokenize(javascript(), `${long}\nconst c = 1;`);
  assert.ok(tokens[0].length > 0, 'the start is tokenized');
  assert.ok(
    tokens[0].every((t) => t.to <= TOKENIZE_LIMIT),
    'nothing past the limit',
  );
  assert.ok(tokens[1].length > 0, 'the next line still is');
});

// A language whose only state is whether a `<<` … `>>` block is open, and
// which counts the lines it runs: every line is one token, `comment` inside
// a block and `keyword` outside it.
function blocks(): { language: Language; runs: () => number } {
  let runs = 0;
  const language = lineModeLanguage<{ open: boolean }>({
    name: 'blocks',
    startState: () => ({ open: false }),
    runLine(text, state) {
      runs++;
      if (text === '<<') state.open = true;
      const type = state.open ? 'comment' : 'keyword';
      if (text === '>>') state.open = false;
      return text ? [{ from: 0, to: text.length, type }] : [];
    },
  });
  return { language, runs: () => runs };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > 5000) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('stream engine: a line far past the frontier is a guess the walk corrects', async () => {
  // A jump to the end of a file opened a moment ago tokenized every line
  // above it first — a fifth of a second for 50,000 lines. Past SYNC_LINES
  // the line runs from a guess instead (here: the top level, which is
  // wrong, since a block opened on line 0 is still open), and the frontier
  // is walked there in the background and tells the host where it was.
  const { language, runs } = blocks();
  const told: number[] = [];
  const tok = language.createTokenizer({
    invalidate: (from) => told.push(from),
  });
  const lines: string[] = Array.from({ length: 10_000 }, (_, i) =>
    i === 0 ? '<<' : i === 8000 ? '>>' : 'x',
  );
  tok.setLines(lines);
  const far = 6000;
  assert.ok(far > SYNC_LINES);
  assert.equal(tok.lineTokens(far)[0].type, 'keyword', 'answered from a guess');
  assert.ok(runs() <= 102, `the guess ran ${runs()} lines`);
  await until(
    () => (tok as unknown as { guessedTo: number }).guessedTo < 0,
    'the walk',
  );
  assert.equal(tok.lineTokens(far)[0].type, 'comment');
  assert.equal(told.length, 1, 'told once, where the guess went wrong');
  assert.ok(told[0] <= far && told[0] >= far - 100, `told at ${told[0]}`);
  // within reach of the frontier now: exact, and no walk
  assert.equal(tok.lineTokens(far + 500)[0].type, 'comment');
  tok.dispose?.();
});

test('stream engine: a guess that was right is kept, and nobody is told', async () => {
  const { language } = blocks();
  const told: number[] = [];
  const tok = language.createTokenizer({
    invalidate: (from) => told.push(from),
  });
  const lines: string[] = Array.from({ length: 10_000 }, (_, i) =>
    i === 10 ? '<<' : i === 20 ? '>>' : 'x',
  );
  tok.setLines(lines);
  const guessed = tok.lineTokens(6000);
  assert.equal(guessed[0].type, 'keyword');
  await until(
    () => (tok as unknown as { guessedTo: number }).guessedTo < 0,
    'the walk',
  );
  assert.strictEqual(tok.lineTokens(6000), guessed, 'the same array');
  assert.deepEqual(told, []);
  tok.dispose?.();
});

test('stream engine: within reach, a line is tokenized exactly, with no walk', () => {
  const { language, runs } = blocks();
  const tok = language.createTokenizer(host);
  const lines: string[] = Array.from({ length: 10_000 }, (_, i) =>
    i === 0 ? '<<' : 'x',
  );
  tok.setLines(lines);
  assert.equal(tok.lineTokens(SYNC_LINES)[0].type, 'comment');
  assert.equal(runs(), SYNC_LINES + 1);
  assert.equal((tok as unknown as { worker: unknown }).worker, null);
});

test('stream engine: dispose stops the walk', async () => {
  const { language, runs } = blocks();
  const told: number[] = [];
  const tok = language.createTokenizer({
    invalidate: (from) => told.push(from),
  });
  tok.setLines(
    Array.from({ length: 10_000 }, (_, i) => (i === 0 ? '<<' : 'x')),
  );
  tok.lineTokens(9000);
  const after = runs();
  tok.dispose?.();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs(), after, 'nothing ran after dispose');
  assert.deepEqual(told, []);
});

test('stream engine: an edit above a guess is walked through to it', async () => {
  // The block closes at the line edited, so the top level the guess
  // assumed is right after all: the walk arrives with the guess's state and
  // takes the guessed run as it is.
  const { language } = blocks();
  const told: number[] = [];
  const tok = language.createTokenizer({
    invalidate: (from) => told.push(from),
  });
  const lines: string[] = Array.from({ length: 10_000 }, (_, i) =>
    i === 0 ? '<<' : 'x',
  );
  tok.setLines(lines);
  const guessed = tok.lineTokens(6000);
  assert.equal(guessed[0].type, 'keyword');
  lines[3000] = '>>';
  tok.edit({ fromLine: 3000, removed: 1, inserted: 1 });
  await until(
    () => (tok as unknown as { guessedTo: number }).guessedTo < 0,
    'the walk',
  );
  assert.strictEqual(tok.lineTokens(6000), guessed);
  assert.equal(tok.lineTokens(2999)[0].type, 'comment');
  assert.equal(tok.lineTokens(3001)[0].type, 'keyword');
  assert.deepEqual(told, []);
  tok.dispose?.();
});

test('stream engine: an edit inside a guessed run recolours the guessed lines below it', () => {
  // The walk is far away, so the lines under the edit have nothing but the
  // guess to go on — which is walked again from the edit, as far as a line
  // asked for, the way the frontier walks after an edit.
  const { language } = blocks();
  const tok = language.createTokenizer(host);
  const lines: string[] = Array.from({ length: 10_000 }, () => 'x');
  tok.setLines(lines);
  assert.equal(tok.lineTokens(6000)[0].type, 'keyword');
  lines[5990] = '<<';
  tok.edit({ fromLine: 5990, removed: 1, inserted: 1 });
  assert.equal(tok.lineTokens(5990)[0].type, 'comment');
  assert.equal(tok.lineTokens(6000)[0].type, 'comment', 'the line below');
  assert.equal(tok.lineTokens(5995)[0].type, 'comment', 'and one between');
  tok.dispose?.();
});

test('stream engine: a guess starts at the least indented line above it', () => {
  // …which is at the top level far more often than the line itself is: a
  // guess started on a comment's continuation line would read it as code.
  const block = [
    '/*',
    ' * a note',
    ' * another',
    ' */',
    'function f() {',
    '  return 1;',
    '}',
    '',
  ];
  const lines: string[] = Array.from(
    { length: 4000 },
    (_, i) => block[i % block.length],
  );
  const tok = javascript().createTokenizer(host);
  tok.setLines(lines);
  const far = 3001;
  assert.ok(far > SYNC_LINES);
  assert.equal(lines[far], ' * a note');
  const tokens = tok.lineTokens(far);
  assert.ok(
    tokens.length > 0 && tokens.every((t) => t.type === 'comment'),
    JSON.stringify(tokens),
  );
  tok.dispose?.();
});

// The walk by hand: one turn at a time, nothing left scheduled between them.
type Walked = { work(): void; stopWorker(): void; frontier: number };

test('stream engine: a guess at the frontier is run again from the state the walk left there', () => {
  // A turn of the walk can end on a guessed line whose entering state it
  // has just replaced; the guess the line holds ran from the state before,
  // and a request for it then must not take it as it is.
  const { language } = blocks();
  const tok = language.createTokenizer(host);
  tok.setLines(
    Array.from({ length: 10_000 }, (_, i) => (i === 0 ? '<<' : 'x')),
  );
  assert.equal(tok.lineTokens(6000)[0].type, 'keyword');
  const walked = tok as unknown as Walked;
  walked.stopWorker();
  while (walked.frontier < 6000) {
    walked.work();
    walked.stopWorker();
  }
  assert.equal(walked.frontier, 6000, 'a turn ended on the guessed line');
  assert.equal(tok.lineTokens(6000)[0].type, 'comment');
  tok.dispose?.();
});

test('stream engine: lines inserted above a guess move it, and the walk goes as far', async () => {
  const { language } = blocks();
  const told: number[] = [];
  const tok = language.createTokenizer({
    invalidate: (from) => told.push(from),
  });
  const lines: string[] = Array.from({ length: 10_000 }, (_, i) =>
    i === 0 ? '<<' : 'x',
  );
  tok.setLines(lines);
  assert.equal(tok.lineTokens(6000)[0].type, 'keyword');
  lines.splice(100, 0, ...Array.from({ length: 10 }, () => 'x'));
  tok.edit({ fromLine: 100, removed: 0, inserted: 10 });
  await until(
    () => (tok as unknown as { guessedTo: number }).guessedTo < 0,
    'the walk',
  );
  assert.deepEqual(told, [6010], 'the guess, where it went');
  assert.equal(tok.lineTokens(6010)[0].type, 'comment');
  tok.dispose?.();
});

test('stream engine: a guess corrected on the way to another is told as well', () => {
  // Once the frontier is within a guess's reach, the guess walks from it —
  // and may find a line it answered before answered wrong. Whoever it
  // handed that line to is told, at the walk's next turn.
  const { language } = blocks();
  const told: number[] = [];
  const tok = language.createTokenizer({
    invalidate: (from) => told.push(from),
  });
  tok.setLines(
    Array.from({ length: 10_000 }, (_, i) => (i === 0 ? '<<' : 'x')),
  );
  assert.equal(tok.lineTokens(5600)[0].type, 'keyword');
  const walked = tok as unknown as Walked;
  walked.stopWorker();
  while (walked.frontier < 5500) {
    walked.work();
    walked.stopWorker();
  }
  assert.equal(tok.lineTokens(5600)[0].type, 'comment');
  walked.stopWorker();
  walked.work();
  assert.deepEqual(told, [5600]);
  tok.dispose?.();
});

test('stream engine: an edit in a guessed run re-runs the line under it, and tells', () => {
  // The walk from the edit stops at the line asked for; the line under it
  // ran from the state that line used to leave, so it goes, and whoever
  // was handed it as code is told.
  const { language } = blocks();
  const told: number[] = [];
  const tok = language.createTokenizer({
    invalidate: (from) => told.push(from),
  });
  const lines: string[] = Array.from({ length: 10_000 }, () => 'x');
  tok.setLines(lines);
  for (let i = 6000; i <= 6010; i++) {
    assert.equal(tok.lineTokens(i)[0].type, 'keyword');
  }
  const walked = tok as unknown as Walked;
  walked.stopWorker();
  lines[6005] = '<<';
  tok.edit({ fromLine: 6005, removed: 1, inserted: 1 });
  assert.equal(tok.lineTokens(6005)[0].type, 'comment');
  assert.equal(tok.lineTokens(6006)[0].type, 'comment', 'the line under it');
  walked.stopWorker();
  walked.work();
  assert.deepEqual(told, [6006]);
  tok.dispose?.();
});

test('stream engine: an edit above the frontier does not take the tokens the walk left behind', () => {
  // A walk stops with its last line's state replaced and that line not yet
  // run again. An edit above moves the frontier back past it, and
  // convergence then took those tokens as the line's: the line under the
  // view kept the colours it had before a comment opened above it.
  const { language } = blocks();
  const tok = language.createTokenizer(host);
  const lines: string[] = Array.from({ length: 100 }, () => 'x');
  tok.setLines(lines);
  for (let i = 0; i < 100; i++) tok.lineTokens(i);
  lines[10] = '<<';
  tok.edit({ fromLine: 10, removed: 1, inserted: 1 });
  assert.equal(tok.lineTokens(20)[0].type, 'comment');
  lines[2] = 'y';
  tok.edit({ fromLine: 2, removed: 1, inserted: 1 });
  assert.equal(tok.lineTokens(2)[0].type, 'keyword');
  assert.equal(
    tok.lineTokens(21)[0].type,
    'comment',
    'the line under the walk',
  );
  assert.equal(tok.lineTokens(99)[0].type, 'comment');
});

test('the built-in languages are one object per set of options', () => {
  // `language={javascript()}` inline hands the editor a new object every
  // render, and a new language is a new tokenizer and every line laid out
  // again — on every keystroke of a controlled editor.
  assert.strictEqual(javascript(), javascript());
  assert.strictEqual(
    javascript({ typescript: true }),
    javascript({ typescript: true }),
  );
  assert.notStrictEqual(javascript({ typescript: true }), javascript());
  assert.strictEqual(
    sql({ keywords: ['merge'] }),
    sql({ keywords: ['merge'] }),
  );
  assert.notStrictEqual(sql({ keywords: ['merge'] }), sql());
  assert.strictEqual(json(), json());
  assert.strictEqual(shell(), shell());
  assert.strictEqual(glsl(), glsl());
});
