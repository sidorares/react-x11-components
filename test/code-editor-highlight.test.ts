// Highlighting and diagnostics under edits, held to oracles rather than to
// the editor's own answers: the tokens an edited document ends up with are
// the ones a fresh tokenizer gives the final text, and what an edited
// editor paints is what a fresh editor paints for the same state.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import React from 'react';

import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import {
  CodeEditor,
  glsl,
  javascript,
  json,
  shell,
  sql,
  tokenizeText,
} from '../src/index.js';
import { stopInterval } from '../src/code-language/timers.js';
import type {
  CodeEditorNode,
  Diagnostic,
  Language,
  Position,
  Token,
  Tokenizer,
} from '../src/index.js';

const h = React.createElement;

afterEach(() => cleanup());

/** How many random sequences each case runs; raise it to search harder. */
const SEEDS = Number(process.env.CODE_EDITOR_SEEDS ?? 40);

/** A seeded generator (mulberry32): the same sequence of edits every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JS = `/** A module. */
import { a, b } from './x.js';
const s = "a string with \\"escapes\\"";
const t = \`template \${a + \`nested \${b}\`} end\`;
// a line comment with a /* not a comment
let r = /re[/]gex/g.test(s) ? 1 / 2 : 0x1f;
/* a block
   comment */
function f(x, y) {
  if (x < y && y > 0) return { x, y };
  const c = 'single \\' quote';
  return [x, y].map((v) => v * 2);
}
class K extends Base {
  #priv = 1;
  static get m() { return this.#priv; }
}
export default f;`;

const TS = `interface Shape<T> { kind: 'circle'; r: T }
type U = Shape<number> | null;
enum E { A = 1, B }
function g<T extends object>(v: T): keyof T {
  return Object.keys(v)[0] as keyof T;
}
const x = <const>['a', 'b'];
@decorate() class C { private y?: string = \`\${1}\`; }`;

const SQL = `-- a query
SELECT a, "quoted col", 'it''s', $1, :name
FROM t /* a block
comment */ JOIN u ON t.id = u.id
WHERE x = E'esc\\n' AND y IN (1, 2.5e3)
  AND z LIKE 'multi
line string';`;

const SHELL = `#!/bin/sh
# a comment
echo "home is $HOME and \${USER:-nobody}" 'single $NOT'
x=$(ls | grep "a b") && echo \`date\`
cat <<EOF
heredoc $var
EOF
if [ -f "$f" ]; then echo ok; fi`;

const JSON_DOC = `{
  "a": 1,
  "b": [true, false, null, -1.5e3],
  "c": { "d": "string with \\"quotes\\"", "e": {} }
}`;

const GLSL = `#version 330 core
#define PI 3.14159
uniform mat4 u_mvp; // a comment
/* a block
   comment */
void main() {
  vec3 p = position.xyz * 2.0;
  gl_Position = u_mvp * vec4(p, 1.0);
}`;

/** What a random edit inserts: mostly the tokens a tokenizer has a state
 *  for, the ones an edit most often gets wrong. */
const SNIPPETS: Record<string, readonly string[]> = {
  js: [
    '/*',
    '*/',
    '//',
    '"',
    "'",
    '`',
    '${',
    '}',
    '{',
    '(',
    ')',
    '[',
    ']',
    '\n',
    '\\',
    '/',
    'x',
    ' ',
    '\t',
    'let ',
    'a = 1;',
    '/re+g/',
    '=>',
    '#p',
    '0x1f',
    '"str"',
    '`t${a}`',
    '// c\n',
    '/* c */',
    '\n\n',
    'q\nw',
  ],
  sql: [
    "'",
    '"',
    '--',
    '/*',
    '*/',
    'SELECT ',
    'from ',
    '$1',
    ':name',
    '\n',
    ' ',
    'x',
    '(',
    ')',
    ';',
    "E'",
    '\\',
    "''",
    '\n\n',
  ],
  shell: [
    '"',
    "'",
    '$',
    '${',
    '}',
    '$(',
    ')',
    '#',
    '<<EOF\n',
    'EOF\n',
    '\n',
    'echo ',
    '`',
    '\\',
    ' ',
    'x',
    '|',
    '&&',
    '\n\n',
  ],
  json: [
    '"',
    '{',
    '}',
    '[',
    ']',
    ':',
    ',',
    'true',
    'null',
    '1.5',
    '\n',
    ' ',
    'x',
    '\\',
    '"k": ',
  ],
  glsl: [
    '/*',
    '*/',
    '//',
    '#define X\n',
    'vec3 ',
    '.xyz',
    '(',
    ')',
    '\n',
    ' ',
    'x',
    ';',
    '{',
    '}',
    '1.0',
  ],
};

interface Case {
  name: string;
  language: () => Language;
  doc: string;
  snippets: readonly string[];
}

const CASES: Case[] = [
  {
    name: 'javascript',
    language: () => javascript(),
    doc: JS,
    snippets: SNIPPETS.js,
  },
  {
    name: 'typescript',
    language: () => javascript({ typescript: true }),
    doc: `${TS}\n${JS}`,
    snippets: SNIPPETS.js,
  },
  { name: 'sql', language: () => sql(), doc: SQL, snippets: SNIPPETS.sql },
  {
    name: 'shell',
    language: () => shell(),
    doc: SHELL,
    snippets: SNIPPETS.shell,
  },
  {
    name: 'json',
    language: () => json(),
    doc: JSON_DOC,
    snippets: SNIPPETS.json,
  },
  { name: 'glsl', language: () => glsl(), doc: GLSL, snippets: SNIPPETS.glsl },
];

interface Pos {
  line: number;
  ch: number;
}

/** `[a, b)` of `lines` becomes `text`, in place — the editor's own shape of
 *  an edit (`_replaceLines`): whole lines out, whole lines in. */
function replace(
  lines: string[],
  a: Pos,
  b: Pos,
  text: string,
): { fromLine: number; removed: number; inserted: number } {
  const head = lines[a.line].slice(0, a.ch);
  const tail = lines[b.line].slice(b.ch);
  const parts = text.split('\n');
  parts[0] = head + parts[0];
  parts[parts.length - 1] += tail;
  lines.splice(a.line, b.line - a.line + 1, ...parts);
  return {
    fromLine: a.line,
    removed: b.line - a.line + 1,
    inserted: parts.length,
  };
}

function randomPos(lines: readonly string[], r: () => number): Pos {
  const line = Math.floor(r() * lines.length);
  return { line, ch: Math.floor(r() * (lines[line].length + 1)) };
}

function ordered(a: Pos, b: Pos): [Pos, Pos] {
  return a.line < b.line || (a.line === b.line && a.ch <= b.ch)
    ? [a, b]
    : [b, a];
}

/** One random edit to `lines`: an insertion, a deletion or a replacement,
 *  up to a few lines long. */
function randomEdit(
  lines: string[],
  r: () => number,
  snippets: readonly string[],
): { fromLine: number; removed: number; inserted: number } {
  const a = randomPos(lines, r);
  const kind = r();
  const pick = (): string => snippets[Math.floor(r() * snippets.length)];
  if (kind < 0.55) return replace(lines, a, a, pick());
  // a range: mostly short, sometimes across lines
  const span = r() < 0.7 ? 0 : Math.floor(r() * 4);
  const bl = Math.min(lines.length - 1, a.line + span);
  const b = { line: bl, ch: Math.floor(r() * (lines[bl].length + 1)) };
  const [x, y] = ordered(a, b);
  return replace(lines, x, y, kind < 0.8 ? '' : pick() + pick());
}

function same(a: readonly Token[], b: readonly Token[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (t, i) =>
        t.from === b[i].from && t.to === b[i].to && t.type === b[i].type,
    )
  );
}

async function walked(tok: Tokenizer): Promise<void> {
  const inner = tok as unknown as { guessedTo?: number };
  const start = Date.now();
  while ((inner.guessedTo ?? -1) >= 0) {
    assert.ok(Date.now() - start < 10_000, 'the tokenizer caught up');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Every line's tokens against a fresh tokenizer's for the same text, in
 *  order from the top, the way nothing but the frontier is asked. */
function assertTokens(
  tok: Tokenizer,
  language: Language,
  lines: string[],
  what: string,
): void {
  const fresh = tokenizeText(language, lines.join('\n'));
  for (let i = 0; i < lines.length; i++) {
    const got = tok.lineTokens(i);
    if (!same(got, fresh[i])) {
      assert.fail(
        `${what}: line ${i} ${JSON.stringify(lines[i])}\n` +
          `  incremental ${JSON.stringify(got)}\n  fresh       ${JSON.stringify(fresh[i])}`,
      );
    }
  }
}

for (const c of CASES) {
  test(`${c.name}: tokens after random edits are a fresh tokenizer's`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed * 7919);
      const language = c.language();
      const lines = c.doc.split('\n');
      const tok = language.createTokenizer({ invalidate: () => {} });
      tok.setLines(lines);
      for (let step = 0; step < 30; step++) {
        tok.edit(randomEdit(lines, r, c.snippets));
        // ask for a few lines the way a paint would, so the caches the next
        // edit splices are partly filled and partly not
        const at = Math.floor(r() * lines.length);
        for (let i = at; i < Math.min(lines.length, at + 5); i++)
          tok.lineTokens(i);
      }
      await walked(tok);
      assertTokens(tok, language, lines, `${c.name} seed ${seed}`);
      tok.dispose?.();
    }
  });
}

test('javascript: a long document, far jumps and edits: the tokens are a fresh tokenizer’s', async () => {
  // Past a thousand lines from the frontier a line is a guess, walked to in
  // the background: once the walk is done, nothing of the guesses is left.
  for (let seed = 1; seed <= 6; seed++) {
    const r = rng(seed * 104729);
    const language = javascript({ typescript: true });
    const base = `${TS}\n${JS}`.split('\n');
    const lines = Array.from({ length: 4000 }, (_, i) => base[i % base.length]);
    const tok = language.createTokenizer({ invalidate: () => {} });
    tok.setLines(lines);
    for (let step = 0; step < 40; step++) {
      tok.edit(randomEdit(lines, r, SNIPPETS.js));
      const at = Math.floor(r() * lines.length);
      for (let i = at; i < Math.min(lines.length, at + 30); i++)
        tok.lineTokens(i);
      if (r() < 0.3) await new Promise((res) => setTimeout(res, 1));
    }
    await walked(tok);
    assertTokens(tok, language, lines, `long seed ${seed}`);
    tok.dispose?.();
  }
});

// --- the editor against a fresh one -----------------------------------------

function editorNode(): CodeEditorNode {
  const node = screen.all((n: DrawnNode) => n.kind === 'codeeditor')[0];
  assert.ok(node, 'a <codeeditor> node is mounted');
  return node as unknown as CodeEditorNode;
}

async function editorPixels(
  ctx: unknown,
  node: CodeEditorNode,
): Promise<Buffer> {
  const { abs } = node as unknown as DrawnNode;
  const { data } = await (
    ctx as {
      getImageData(
        x: number,
        y: number,
        w: number,
        h: number,
      ): Promise<{ data: Uint8ClampedArray }>;
    }
  ).getImageData(abs.x, abs.y, abs.width, abs.height);
  return Buffer.from(data);
}

/** The node's view state the handle does not reach, read and written
 *  directly: what a fresh editor needs to show the same thing. */
type Inner = {
  _scrollX: number;
  _scrollY: number;
  _widest: number;
  _blinkTimer: unknown;
  _caretOn: boolean;
};

function holdBlink(node: CodeEditorNode): void {
  const inner = node as unknown as Inner;
  stopInterval(inner._blinkTimer as never);
  inner._blinkTimer = null;
}

/** Where two frames of the editor differ, in text rows, and — with
 *  CODE_EDITOR_DUMP=<dir> — both frames as PNGs to look at. */
function describeDiff(
  node: CodeEditorNode,
  cp: Checkpoint,
  fresh: Buffer,
  scale: number,
): string {
  const { abs } = node as unknown as DrawnNode;
  const lineH = (node as unknown as { _lineH: number })._lineH;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < fresh.length; i += 4) {
    if (
      fresh[i] !== cp.pixels[i] ||
      fresh[i + 1] !== cp.pixels[i + 1] ||
      fresh[i + 2] !== cp.pixels[i + 2]
    ) {
      const px = (i / 4) % abs.width;
      const py = Math.floor(i / 4 / abs.width);
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
  }
  const dir = process.env.CODE_EDITOR_DUMP;
  if (dir) {
    // RGBA as the context reads it back, opaque
    const png = (data: Buffer): Buffer => {
      const out = Buffer.from(data);
      for (let i = 3; i < out.length; i += 4) out[i] = 255;
      return out;
    };
    fs.writeFileSync(`${dir}/edited.rgba`, png(cp.pixels));
    fs.writeFileSync(`${dir}/fresh.rgba`, png(fresh));
    fs.writeFileSync(
      `${dir}/size.json`,
      JSON.stringify({ width: abs.width, height: abs.height }),
    );
  }
  const row = (y: number): number => Math.floor((y + cp.scrollY) / lineH);
  const rows = cp.value.split('\n').slice(row(y0) - 1, row(y1) + 2);
  return (
    `the edited editor and a fresh one differ at ${scale}x: x ${x0}..${x1}, y ${y0}..${y1} ` +
    `(text rows ${row(y0)}..${row(y1)} near, lineH ${lineH}, scroll ${cp.scrollX},${cp.scrollY})\n` +
    `  rows from ${row(y0) - 1}: ${JSON.stringify(rows)}`
  );
}

interface Checkpoint {
  label: string;
  value: string;
  anchor: Position;
  head: Position;
  scrollX: number;
  scrollY: number;
  widest: number;
  diagnostics: readonly Diagnostic[];
  pixels: Buffer;
}

const DIAGNOSTICS: readonly Diagnostic[] = [
  { from: { line: 1, ch: 9 }, to: { line: 1, ch: 13 }, severity: 'error' },
  { from: { line: 6, ch: 4 }, to: { line: 6, ch: 5 }, severity: 'warning' },
  {
    from: { line: 9, ch: 2 },
    to: { line: 10, ch: 6 },
    severity: 'information',
  },
  { from: { line: 14, ch: 0 }, to: { line: 14, ch: 0 }, severity: 'hint' },
];

const EDITOR_DOC = `${TS}\n${JS}\n${JS}`;

function editorProps(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    language: javascript({ typescript: true }),
    lineNumbers: true,
    activeLine: true,
    style: { flexGrow: 1 },
    ...extra,
  };
}

function diagnosticsOf(node: CodeEditorNode): readonly Diagnostic[] {
  const mapped = (node as unknown as { diagnostics?: readonly Diagnostic[] })
    .diagnostics;
  return mapped ?? DIAGNOSTICS;
}

/** One random action through the handle, as a user or an app would take it. */
function randomAction(
  node: CodeEditorNode,
  r: () => number,
  snippets: readonly string[] = SNIPPETS.js,
): string {
  const lines = node.lines;
  const pos = (): Position => {
    const line = Math.floor(r() * lines.length);
    return { line, ch: Math.floor(r() * (lines[line].length + 1)) };
  };
  const snippet = (): string => snippets[Math.floor(r() * snippets.length)];
  const k = r();
  if (k < 0.3) {
    const t = snippet();
    node.insertText(t);
    return `type ${JSON.stringify(t)}`;
  }
  if (k < 0.4) {
    node.insertText('\n');
    return 'enter';
  }
  if (k < 0.52) {
    const p = pos();
    node.moveCaret(p, false);
    return `caret ${p.line}:${p.ch}`;
  }
  if (k < 0.6) {
    const a = pos();
    const b = pos();
    node.select(a, b);
    return `select ${a.line}:${a.ch}-${b.line}:${b.ch}`;
  }
  if (k < 0.74) {
    const a = pos();
    const bl = Math.min(lines.length - 1, a.line + Math.floor(r() * 3));
    const b = { line: bl, ch: Math.floor(r() * (lines[bl].length + 1)) };
    const t = r() < 0.5 ? '' : snippet();
    node.replaceRange(a, b, t);
    return `replace ${a.line}:${a.ch}-${b.line}:${b.ch} ${JSON.stringify(t)}`;
  }
  if (k < 0.82) {
    node.undo();
    return 'undo';
  }
  if (k < 0.87) {
    node.redo();
    return 'redo';
  }
  if (k < 0.93) {
    const dy = Math.round((r() - 0.5) * 160);
    node.scrollBy(0, dy);
    return `scroll ${dy}`;
  }
  if (k < 0.97) {
    const dir = r() < 0.5 ? 1 : -1;
    node.indentSelection(dir);
    return `indent ${dir}`;
  }
  node.toggleLineComment();
  return 'comment';
}

const ORACLE_DOCS: Array<{
  name: string;
  doc: string;
  snippets: readonly string[];
  /** Sequences at the default SEEDS: the long line is laid out again in
   *  every fresh editor, and makes each one several times the cost. */
  share: number;
}> = [
  { name: 'code', doc: EDITOR_DOC, snippets: SNIPPETS.js, share: 5 },
  {
    // tabs, astral and combining characters, CJK, and a line past the
    // length the editor lays out in pieces
    name: 'tabs, emoji, CJK and a long line',
    share: 10,
    doc: [
      '\tconst a = "😀 smile"; // é',
      'let under_scores__ = "gjpqy|Å";',
      '\t\tlet 中文 = `${a}\t😀`;',
      `const long = "${'abc😀 '.repeat(420)}";`,
      ...EDITOR_DOC.split('\n').slice(0, 30),
    ].join('\n'),
    snippets: [
      ...SNIPPETS.js,
      '___',
      'gjpqy',
      '|',
      'Å',
      'ʃ',
      'Ég',
      '😀',
      'é',
      'e\u0301',
      '中文',
      '\t',
      '\t\t',
      '"',
      '𝒳',
    ],
  },
];

for (const { name: docName, doc, snippets, share } of ORACLE_DOCS)
  for (const scale of [1, 2]) {
    test(`${docName}: an edited editor paints what a fresh editor paints for the same state, at ${scale}x`, async () => {
      const options = {
        scale,
        width: 400,
        height: 300,
        screen: { width: 1000, height: 800 },
      };
      const checkpoints: Checkpoint[] = [];
      const only = Number(process.env.CODE_EDITOR_ONLY_SEED ?? 0);
      const every = Number(process.env.CODE_EDITOR_EVERY ?? 10);
      for (
        let seed = only || 1;
        seed <= (only || Math.max(2, Math.round(SEEDS / share)));
        seed++
      ) {
        const r = rng(seed * 31337 + scale);
        const { ctx } = await renderX11(
          h(
            CodeEditor,
            editorProps({ defaultValue: doc, diagnostics: DIAGNOSTICS }),
          ),
          options,
        );
        const node = editorNode();
        node.focus();
        holdBlink(node);
        const trail: string[] = [];
        for (let step = 1; step <= 40; step++) {
          trail.push(randomAction(node, r, snippets));
          await act();
          if (step % every === 0) {
            const inner = node as unknown as Inner;
            const { anchor, head } = node.selection;
            checkpoints.push({
              label: `seed ${seed} step ${step}: ${trail.slice(-Math.max(every, 10)).join(', ')}`,
              value: node.value,
              anchor,
              head,
              scrollX: inner._scrollX,
              scrollY: inner._scrollY,
              widest: inner._widest,
              diagnostics: diagnosticsOf(node),
              pixels: await editorPixels(ctx, node),
            });
          }
        }
        await cleanup();
      }
      for (const cp of checkpoints) {
        const { ctx, windowNode } = await renderX11(
          h(
            CodeEditor,
            editorProps({
              defaultValue: cp.value,
              diagnostics: cp.diagnostics,
            }),
          ),
          options,
        );
        const node = editorNode();
        node.focus();
        holdBlink(node);
        node.select(cp.anchor, cp.head);
        const inner = node as unknown as Inner;
        inner._scrollX = cp.scrollX;
        inner._scrollY = cp.scrollY;
        inner._widest = cp.widest;
        inner._caretOn = true;
        await act(() => {
          (
            windowNode as unknown as { invalidate(all: boolean): void }
          ).invalidate(true);
        });
        const fresh = await editorPixels(ctx, node);
        if (!fresh.equals(cp.pixels)) {
          assert.fail(`${cp.label}\n  ${describeDiff(node, cp, fresh, scale)}`);
        }
        await cleanup();
      }
    });
  }

// --- geometry past the X protocol's 16 bits --------------------------------

for (const scale of [1, 2]) {
  test(`a selection, a squiggle and a bracket across a 6,000-character line paint, at ${scale}x`, async () => {
    // A line past 32,767 device pixels is drawn in pieces (#131), but a
    // selection band, a squiggle or a bracket's highlight across it was one
    // rectangle as wide as the line, and X11 coordinates are 16 bits: the
    // paint threw, and the window stopped painting.
    const long = `(${'x'.repeat(6000)})`;
    const { ctx } = await renderX11(
      h(CodeEditor, {
        defaultValue: `${long}\nshort`,
        diagnostics: [
          {
            from: { line: 0, ch: 0 },
            to: { line: 0, ch: 6002 },
            severity: 'warning',
          },
        ],
        style: { flexGrow: 1 },
      }),
      { scale, width: 300, height: 120, screen: { width: 800, height: 600 } },
    );
    const node = editorNode();
    node.focus();
    holdBlink(node);
    node.selectAll();
    await act();
    node.moveCaret({ line: 0, ch: 1 }, false); // beside `(`: its `)` 6,000 characters on
    await act();
    node.moveCaret({ line: 0, ch: 6002 }, false); // and the other way
    await act();
    node.select({ line: 0, ch: 3000 }, { line: 1, ch: 2 });
    await act();
    assert.ok((await editorPixels(ctx, node)).length > 0, 'painted');
  });
}

// --- diagnostics that follow the text ----------------------------------------

/** `node.diagnostics` as `line:ch-line:ch` strings, easy to compare. */
function flags(node: CodeEditorNode): string[] {
  return (
    node as unknown as { diagnostics: readonly Diagnostic[] }
  ).diagnostics.map(
    (d) => `${d.from.line}:${d.from.ch}-${d.to.line}:${d.to.ch}`,
  );
}

async function flagged(
  text: string,
  diagnostics: Diagnostic[],
): Promise<CodeEditorNode> {
  await renderX11(
    h(CodeEditor, { defaultValue: text, diagnostics, style: { flexGrow: 1 } }),
    {
      width: 300,
      height: 120,
    },
  );
  return editorNode();
}

const at = (line: number, ch: number): Position => ({ line, ch });
const range = (a: Position, b: Position): Diagnostic => ({
  from: a,
  to: b,
  severity: 'warning',
});

test('a squiggle moves with the code it flags as the text is edited', async () => {
  // `beta` is flagged, on line 1. A linter answers once the text settles,
  // and until then the squiggle has to be where `beta` went.
  const node = await flagged('let x;\nlet alpha = beta;\nend', [
    range(at(1, 12), at(1, 16)),
  ]);
  node.replaceRange(at(1, 4), at(1, 4), 'big_');
  assert.deepEqual(flags(node), ['1:16-1:20'], 'typed before it on its line');
  node.replaceRange(at(0, 0), at(0, 0), 'a\nb\n');
  assert.deepEqual(flags(node), ['3:16-3:20'], 'two lines above it');
  node.replaceRange(at(0, 0), at(2, 0), '');
  assert.deepEqual(flags(node), ['1:16-1:20'], 'the two lines taken back out');
  node.replaceRange(at(1, 18), at(1, 18), 'XX');
  assert.deepEqual(flags(node), ['1:16-1:22'], 'typed inside it');
  node.replaceRange(at(1, 16), at(1, 16), '(');
  assert.deepEqual(
    flags(node),
    ['1:17-1:23'],
    'typed at its start: it moves, it does not grow',
  );
  node.replaceRange(at(1, 23), at(1, 23), ')');
  assert.deepEqual(
    flags(node),
    ['1:17-1:23'],
    'typed at its end: it does not grow',
  );
  node.undo();
  node.undo();
  assert.deepEqual(flags(node), ['1:16-1:22'], 'undone');
  node.replaceRange(at(1, 16), at(1, 22), '0');
  assert.deepEqual(flags(node), [], 'what it flagged is gone, and so is it');
});

test('a diagnostic at a point, and one across lines, follow the text too', async () => {
  const node = await flagged('a\nbb\nccc\ndddd', [
    range(at(1, 1), at(1, 1)),
    range(at(1, 1), at(3, 2)),
  ]);
  node.replaceRange(at(1, 1), at(1, 1), 'zz');
  assert.deepEqual(flags(node), ['1:1-1:1', '1:3-3:2'], 'typed at the point');
  node.replaceRange(at(2, 0), at(2, 3), '');
  assert.deepEqual(
    flags(node),
    ['1:1-1:1', '1:3-3:2'],
    'a line inside the range emptied',
  );
  node.replaceRange(at(1, 4), at(3, 1), '');
  assert.deepEqual(
    flags(node),
    ['1:1-1:1', '1:3-1:5'],
    'the lines it spanned joined',
  );
  node.replaceRange(at(0, 0), at(1, 1), '');
  assert.deepEqual(
    flags(node),
    ['0:0-0:0', '0:2-0:4'],
    'the text before the point taken away',
  );
});

test('a new diagnostics prop replaces the ones that were moved', async () => {
  const first = [range(at(0, 0), at(0, 3))];
  const { rerender } = await renderX11(
    h(CodeEditor, {
      defaultValue: 'abc def',
      diagnostics: first,
      style: { flexGrow: 1 },
    }),
    { width: 300, height: 120 },
  );
  const node = editorNode();
  node.replaceRange(at(0, 0), at(0, 0), 'xx');
  assert.deepEqual(flags(node), ['0:2-0:5']);
  const second = [range(at(0, 6), at(0, 9))];
  await rerender(
    h(CodeEditor, {
      defaultValue: 'abc def',
      diagnostics: second,
      style: { flexGrow: 1 },
    }),
  );
  assert.deepEqual(
    flags(node),
    ['0:6-0:9'],
    'what the linter said about the new text',
  );
});

test('a value set from outside moves the diagnostics as an edit would', async () => {
  const diagnostics = [range(at(2, 0), at(2, 3))];
  const { rerender } = await renderX11(
    h(CodeEditor, {
      value: 'a\nb\nfoo',
      diagnostics,
      onChange: () => {},
      style: { flexGrow: 1 },
    }),
    { width: 300, height: 120 },
  );
  const node = editorNode();
  await rerender(
    h(CodeEditor, {
      value: 'a\nnew\nb\nfoo',
      diagnostics,
      onChange: () => {},
      style: { flexGrow: 1 },
    }),
  );
  await act();
  assert.deepEqual(flags(node), ['3:0-3:3']);
});

/** The box (device pixels, node-relative) where two frames of the editor
 *  differ: a squiggle, drawn in one and not the other. */
function inkOf(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : { x0, x1, y0, y1 };
}

type Metrics = {
  _lineH: number;
  _contentRect(): { x: number; y: number; width: number; height: number };
  _gutterWidth(): number;
};

for (const scale of [1, 2]) {
  test(`a squiggle sits under the characters it flags, after tabs and an emoji, at ${scale}x`, async () => {
    // Held to a ruler rather than to the editor's own answer: each case's
    // squiggle is drawn under a word, and the word's own glyphs are where it
    // has to start and end. One squiggle at a time, against a frame with
    // none: a row's pixels are not all its own when the line height is
    // fractional, and the row above may ink the one they share.
    const lines = ['let a = beta;', '\tlet a = beta;', '😀 let a = beta;'];
    const where = lines.map((text) => text.indexOf('beta'));
    const flagged = where.map((ch, line) => ({
      from: { line, ch },
      to: { line, ch: ch + 4 },
      severity: 'error' as const,
    }));
    const editor = (diagnostics: Diagnostic[]) =>
      h(CodeEditor, {
        defaultValue: lines.join('\n'),
        diagnostics,
        style: { fontSize: 16, flexGrow: 1 },
      });
    const { ctx, rerender } = await renderX11(editor([]), {
      scale,
      width: 400,
      height: 160,
      screen: { width: 900, height: 600 },
    });
    const node = editorNode();
    await act();
    const m = node as unknown as Metrics & { _caretX(p: Position): number };
    const box = m._contentRect();
    const abs = (node as unknown as DrawnNode).abs;
    const without = await editorPixels(ctx, node);
    for (let line = 0; line < lines.length; line++) {
      await rerender(editor([flagged[line]]));
      await act();
      const ink = inkOf(
        await editorPixels(ctx, node),
        without,
        abs.width,
        abs.height,
      );
      assert.ok(ink, `line ${line} has a squiggle`);
      // `beta`'s glyphs: the text between the caret before it and after it
      const x0 =
        box.x - abs.x + m._gutterWidth() + m._caretX({ line, ch: where[line] });
      const x1 =
        box.x -
        abs.x +
        m._gutterWidth() +
        m._caretX({ line, ch: where[line] + 4 });
      const step = 4 * scale;
      assert.ok(
        Math.abs(ink.x0 - x0) <= 1 + scale &&
          ink.x1 <= x1 + scale &&
          ink.x1 >= x1 - step - 2 * scale - 1,
        `line ${line}: the squiggle spans ${ink.x0}..${ink.x1}, the word ${x0.toFixed(1)}..${x1.toFixed(1)}`,
      );
      // (the zigzag ends on its last whole 4px step, and anti-aliasing
      // fades the stroke at both ends: a pixel or two, not a column)
      const top = box.y - abs.y + line * m._lineH;
      assert.ok(
        ink.y0 >= Math.floor(top + m._lineH / 2) &&
          ink.y1 < Math.ceil(top + m._lineH),
        `line ${line}: the squiggle inks rows ${ink.y0}..${ink.y1}, the line's lower half is ${(top + m._lineH / 2).toFixed(1)}..${(top + m._lineH).toFixed(1)}`,
      );
    }
  });
}

test('a linter answering repaints the rows its squiggles are on, and lays nothing out', async () => {
  // A new diagnostics prop, arriving after every pause in typing, relaid
  // out and repainted the whole editor.
  const lines = Array.from({ length: 40 }, (_, i) => `const v${i} = f(${i});`);
  const language = javascript();
  const editor = (diagnostics: Diagnostic[]) =>
    h(CodeEditor, {
      defaultValue: lines.join('\n'),
      diagnostics,
      language,
      style: { flexGrow: 1 },
    });
  const { ctx, rerender, windowNode } = await renderX11(
    editor([range(at(3, 6), at(3, 8))]),
    { width: 400, height: 300 },
  );
  const node = editorNode();
  await act();
  const { abs } = node as unknown as DrawnNode;
  let passes = 0;
  let painted = 0;
  const drawn = node as unknown as {
    paint(c: unknown): void;
    paintDamage(): { width: number; height: number } | null;
    _lineCache: Map<number, unknown>;
  };
  const paint = drawn.paint;
  drawn.paint = function (this: typeof drawn, c: unknown) {
    const d = this.paintDamage();
    passes++;
    painted += d ? d.width * d.height : abs.width * abs.height;
    paint.call(this, c);
  };
  const cached = drawn._lineCache.size;
  await rerender(
    editor([range(at(7, 6), at(7, 8)), range(at(9, 0), at(10, 3))]),
  );
  await act();
  drawn.paint = paint;
  assert.ok(passes > 0, 'painted');
  assert.ok(
    painted < abs.width * abs.height * 0.35,
    `a new diagnostics prop painted ${Math.round((100 * painted) / (abs.width * abs.height))}% of the editor`,
  );
  assert.equal(drawn._lineCache.size, cached, 'the layouts stayed');
  const frame = await editorPixels(ctx, node);
  await act(() => {
    (windowNode as unknown as { invalidate(all: boolean): void }).invalidate(
      true,
    );
  });
  assert.ok(
    frame.equals(await editorPixels(ctx, node)),
    'and it is what a full repaint paints',
  );
});

test('taking the widest line away takes its horizontal scroll with it', async () => {
  const long = `const long = "${'x'.repeat(200)}";`;
  await renderX11(
    h(CodeEditor, { defaultValue: `a\n${long}\nb`, style: { flexGrow: 1 } }),
    { width: 300, height: 120 },
  );
  const node = editorNode();
  await act();
  const inner = node as unknown as { _maxScrollX(): number };
  assert.ok(inner._maxScrollX() > 0, 'a line wider than the view scrolls it');
  node.replaceRange(at(1, 0), at(2, 0), '');
  await act();
  assert.equal(inner._maxScrollX(), 0, 'nothing is wider than the view now');
});

test('a controlled editor repaints the rows a keystroke changed, not the editor', async () => {
  // The parent holds the text and hands it back on every change, with a
  // new `onChange` and, often, a new `diagnostics` array. A new value was
  // the whole editor repainted, over the rows the keystroke had claimed.
  const language = javascript();
  const initial = Array.from(
    { length: 40 },
    (_, i) => `const v${i} = f(${i});`,
  ).join('\n');
  let setFromOutside: (f: (v: string) => string) => void = () => {};
  function Controlled(): ReturnType<typeof h> {
    const [value, setValue] = React.useState(initial);
    setFromOutside = setValue;
    return h(CodeEditor, {
      value,
      onChange: (ev: { value: string }) => setValue(ev.value),
      diagnostics: [range(at(2, 6), at(2, 8))],
      language,
      lineNumbers: true,
      style: { flexGrow: 1 },
    });
  }
  const { ctx, windowNode } = await renderX11(h(Controlled), {
    width: 400,
    height: 300,
  });
  const node = editorNode();
  node.focus();
  holdBlink(node);
  node.moveCaret(at(5, 4), false);
  await act();
  const { abs } = node as unknown as DrawnNode;
  const area = abs.width * abs.height;
  const drawn = node as unknown as {
    paint(c: unknown): void;
    paintDamage(): { width: number; height: number } | null;
  };
  const paint = drawn.paint;
  for (const ch of 'abc') {
    let painted = 0;
    drawn.paint = function (this: typeof drawn, c: unknown) {
      const d = this.paintDamage();
      painted += d ? d.width * d.height : area;
      paint.call(this, c);
    };
    await act(() => node.insertText(ch));
    drawn.paint = paint;
    assert.ok(
      painted < area * 0.15,
      `typing ${ch} painted ${Math.round((100 * painted) / area)}% of the editor`,
    );
    const frame = await editorPixels(ctx, node);
    await act(() => {
      (windowNode as unknown as { invalidate(all: boolean): void }).invalidate(
        true,
      );
    });
    assert.ok(
      frame.equals(await editorPixels(ctx, node)),
      `after ${ch}, what a full repaint paints`,
    );
  }
  assert.ok(node.value.split('\n')[5].includes('abc'));
  // …and a value the parent changed itself — a formatter's line — is that
  // line's rows, drawn as a full repaint draws them
  let painted = 0;
  drawn.paint = function (this: typeof drawn, c: unknown) {
    const d = this.paintDamage();
    painted += d ? d.width * d.height : area;
    paint.call(this, c);
  };
  await act(() => setFromOutside((v) => v.replace('const v10 =', 'let v10 =')));
  drawn.paint = paint;
  assert.equal(node.lines[10], 'let v10 = f(10);');
  assert.ok(
    painted < area * 0.15,
    `an outside change painted ${Math.round((100 * painted) / area)}%`,
  );
  const frame = await editorPixels(ctx, node);
  await act(() => {
    (windowNode as unknown as { invalidate(all: boolean): void }).invalidate(
      true,
    );
  });
  assert.ok(
    frame.equals(await editorPixels(ctx, node)),
    'the outside change, as a full repaint paints it',
  );
});

test('the same diagnostics handed over again stay where the edits moved them', async () => {
  // A parent that maps its linter's result into diagnostics inline hands a
  // new array on every render: the answer for the old text, again. Taken as
  // new, the squiggle jumped back to where the old text had `beta`.
  const lint = () => [range(at(0, 12), at(0, 16))];
  const { rerender } = await renderX11(
    h(CodeEditor, {
      defaultValue: 'let alpha = beta;',
      diagnostics: lint(),
      style: { flexGrow: 1 },
    }),
    { width: 300, height: 120 },
  );
  const node = editorNode();
  node.replaceRange(at(0, 0), at(0, 0), '/* x */ ');
  assert.deepEqual(flags(node), ['0:20-0:24']);
  await rerender(
    h(CodeEditor, {
      defaultValue: 'let alpha = beta;',
      diagnostics: lint(),
      style: { flexGrow: 1 },
    }),
  );
  assert.deepEqual(flags(node), ['0:20-0:24'], 'the same answer, a new array');
  await rerender(
    h(CodeEditor, {
      defaultValue: 'let alpha = beta;',
      diagnostics: [range(at(0, 4), at(0, 9))],
      style: { flexGrow: 1 },
    }),
  );
  assert.deepEqual(flags(node), ['0:4-0:9'], 'a new answer');
});
