// `markup`: the literal text of a document of lines, drawn as what it would
// mean as markdown, and never changed.
//
// A chat composer's value is what was typed, byte for byte — `2 * 3` and
// `src/**/*.ts` go to whoever reads it as they are, where the markdown codec
// would escape both. So the formatting is drawn *over* the text: a fence's
// lines set in the code face on one band, with their syntax coloured; a code
// span's text on a tint; with `'markdown'`, emphasis, headings, quotes and
// list markers too — and every marker still there, dimmed. Discord's box,
// Zed's agent panel and VS Code's chat input draw their markers the same way.
//
// It is read from the textblocks at the top of the document, one line each —
// `format="text"`'s shape — and drawn as each block's own decorations, kept
// by the view in a store of their own (`RichEditorView.markup`), not as
// ProseMirror decorations: the view walks every plugin decoration in the
// document on every transaction, and a long fence of coloured code is tens of
// thousands of them. Here a keystroke reads the document's lines again, which
// costs a lookup a line for every line whose node did not change, and tells
// only the blocks whose markup did.
//
// The rules for a line on its own — what a fence line is, where a code span
// or an emphasis runs — are pure functions, asserted with no display
// (test/rich-text-editor-model.test.ts).
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';

import { CodeBlockRunCache } from '../codeblock/index.js';
import type { CodeBlockLook } from '../codeblock/index.js';
import type { Language } from '../code-language/index.js';
import type { TextRun } from '../richtext/index.js';
import type { InlineDecoration, RunStyle } from './inline.js';
import type { KeyedStore } from './store.js';

/** What `markup` decorates: fences and code spans, or all of markdown's
 *  inline and line syntax as well. */
export type MarkupMode = 'code' | 'markdown';

/** Where a line sits in a fence. */
export type FenceRole = 'open' | 'body' | 'close';

/** A line's part of the band a fence is drawn on. */
export type BandPart = 'only' | 'start' | 'middle' | 'end';

/** A line's markup, as its block draws it. */
export interface LineMarkup {
  /** Styles over the line's text, in offsets inside the textblock. */
  readonly inline: readonly InlineDecoration[];
  /** The line is a fence's, and set in the code face. */
  readonly fence: FenceRole | null;
  /** Its part of the fence's band. */
  readonly band: BandPart | null;
}

/** How each part of the markup looks — derived from the editor's look. */
export interface MarkupStyles {
  /** A marker: `*`, `_`, `~~`, `#`, `>`. */
  marker: RunStyle;
  /** A code span's text. */
  code: RunStyle;
  /** A code span's backticks. */
  codeMarker: RunStyle;
  strong: RunStyle;
  em: RunStyle;
  strike: RunStyle;
  /** A heading's text, after its `#`s. */
  heading: RunStyle;
  /** A quote's text, after its `>`. */
  quote: RunStyle;
  /** A list item's `-`, `*`, `+` or number. */
  listMarker: RunStyle;
  /** A fence's opening and closing lines. */
  fence: RunStyle;
}

/** Everything a scan needs: the mode, the looks, and how code is coloured. */
export interface MarkupConfig {
  mode: MarkupMode;
  styles: MarkupStyles;
  code: CodeBlockLook;
  highlight: boolean;
  resolveLanguage?: (tag: string) => Language | null;
}

// --- one line ------------------------------------------------------------------

/** An inline leaf that is not text, in a line's text: one character, so an
 *  offset into the line is an offset into its textblock. */
const ATOM = '￼';

/** A textblock's text, each inline atom one character. */
export function lineText(block: PMNode): string {
  if (block.childCount === 1 && block.firstChild!.isText) {
    return block.firstChild!.text ?? '';
  }
  let text = '';
  block.forEach((child) => {
    text += child.isText ? (child.text ?? '') : ATOM;
  });
  return text;
}

/** A fence's line: its character, how many, and the info string after. */
export interface FenceMark {
  char: '`' | '~';
  length: number;
  /** The info string, trimmed: the language first. */
  info: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * A line that opens or closes a fence, as CommonMark has it: three or more
 * backticks or tildes, indented at most three spaces. A backtick fence's
 * info string may hold no backtick — ` ```a``` ` is a code span.
 */
export function fenceOf(text: string): FenceMark | null {
  if (text.length < 3) return null;
  const m = FENCE.exec(text);
  if (!m) return null;
  const char = m[1][0] as '`' | '~';
  if (char === '`' && m[2].includes('`')) return null;
  return { char, length: m[1].length, info: m[2].trim() };
}

/** Whether `line` closes the fence `open` opened: the same character, at
 *  least as many, and nothing after them. */
export function closesFence(open: FenceMark, line: FenceMark): boolean {
  return line.char === open.char && line.length >= open.length && !line.info;
}

/** The language a fence's info string names: its first word. */
export function fenceLanguage(info: string): string {
  return info.split(/\s/, 1)[0].toLowerCase();
}

export type SpanRole = Exclude<keyof MarkupStyles, 'fence'>;

/** A stretch of a line's text, and what it is. */
export interface MarkupSpan {
  from: number;
  to: number;
  role: SpanRole;
}

/** A character a backslash takes literally. */
const ESCAPABLE = /\\([!-/:-@[-`{-~])/g;
const MASK = '\u0001';

/** Content roles first and markers last: a marker inside an emphasis keeps
 *  its weight and takes the marker's colour. */
const ROLE_ORDER: Record<SpanRole, number> = {
  heading: 0,
  quote: 0,
  strong: 1,
  em: 2,
  strike: 3,
  code: 4,
  codeMarker: 5,
  marker: 6,
  listMarker: 6,
};

const DELIMITED: ReadonlyArray<{ re: RegExp; role: SpanRole; size: number }> = [
  { re: /~~(?![\s~])([^~]*?[^\s~])~~/g, role: 'strike', size: 2 },
  { re: /\*\*(?![\s*])(.*?[^\s*])\*\*/g, role: 'strong', size: 2 },
  {
    re: /(?<![\p{L}\p{N}_])__(?![\s_])(.*?[^\s_])__(?![\p{L}\p{N}_])/gu,
    role: 'strong',
    size: 2,
  },
  { re: /(?<!\*)\*(?![\s*])(.*?[^\s*])\*(?!\*)/g, role: 'em', size: 1 },
  {
    re: /(?<![\p{L}\p{N}_])_(?![\s_])(.*?[^\s_])_(?![\p{L}\p{N}_])/gu,
    role: 'em',
    size: 1,
  },
];

/**
 * The code spans in a line: a run of backticks to the next run as long,
 * as CommonMark pairs them. A run with no partner is text. Answers the
 * line with each span's characters masked, for the emphasis rules to run
 * over without finding a delimiter inside code.
 */
function codeSpans(text: string, out: MarkupSpan[]): string {
  if (!text.includes('`')) return text;
  let masked = text;
  const runs: Array<{ at: number; length: number }> = [];
  for (let i = 0; i < text.length;) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] === '`') j++;
    // a backslash takes the first backtick of a run literally
    const escaped = i > 0 && text[i - 1] === '\\';
    if (escaped) runs.push({ at: i + 1, length: j - i - 1 });
    else runs.push({ at: i, length: j - i });
    i = j;
  }
  for (let r = 0; r < runs.length; r++) {
    const open = runs[r];
    if (open.length === 0) continue;
    let close = -1;
    for (let s = r + 1; s < runs.length; s++) {
      if (runs[s].length === open.length) {
        close = s;
        break;
      }
    }
    if (close < 0) continue;
    const end = runs[close].at + runs[close].length;
    out.push(
      { from: open.at, to: open.at + open.length, role: 'codeMarker' },
      { from: open.at + open.length, to: runs[close].at, role: 'code' },
      { from: runs[close].at, to: end, role: 'codeMarker' },
    );
    masked =
      masked.slice(0, open.at) + MASK.repeat(end - open.at) + masked.slice(end);
    r = close;
  }
  return masked;
}

/**
 * What one line outside a fence draws, as spans of its text: code spans in
 * either mode; with `'markdown'`, a heading's `#`s, a quote's `>`, a list
 * item's marker, and strong, emphasis and strikethrough with their
 * delimiters. Nothing here changes a character, and nothing in a code span
 * is anything but code. Sorted for drawing: what a span is, then its
 * markers over it.
 */
export function inlineMarkup(text: string, mode: MarkupMode): MarkupSpan[] {
  const out: MarkupSpan[] = [];
  const masked = codeSpans(text, out);
  if (mode === 'markdown') {
    lineSyntax(masked, out);
    const plain = masked.replace(
      ESCAPABLE,
      (m) => MASK + MASK.repeat(m.length - 1),
    );
    for (const { re, role, size } of DELIMITED) {
      re.lastIndex = 0;
      for (let m = re.exec(plain); m; m = re.exec(plain)) {
        const from = m.index + m[0].indexOf(m[1]) - size;
        const to = from + size + m[1].length + size;
        out.push(
          { from: from + size, to: to - size, role },
          { from, to: from + size, role: 'marker' },
          { from: to - size, to, role: 'marker' },
        );
      }
    }
  }
  return out.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
}

const HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)[ \t]*/;
const QUOTE = /^ {0,3}>[ \t]?/;
const LIST = /^[ \t]*([-+*]|\d{1,9}[.)])(?=[ \t]|$)/;

/** A line's own syntax, at its start: a heading, a quote, a list item. */
function lineSyntax(text: string, out: MarkupSpan[]): void {
  const heading = HEADING.exec(text);
  if (heading) {
    const marks = heading[0].indexOf('#');
    out.push({ from: marks, to: marks + heading[1].length, role: 'marker' });
    if (heading[0].length < text.length)
      out.push({ from: heading[0].length, to: text.length, role: 'heading' });
    return;
  }
  const quote = QUOTE.exec(text);
  if (quote) {
    const at = quote[0].indexOf('>');
    out.push({ from: at, to: at + 1, role: 'marker' });
    if (quote[0].length < text.length)
      out.push({ from: quote[0].length, to: text.length, role: 'quote' });
    return;
  }
  const list = LIST.exec(text);
  if (list) {
    const at = list[0].length - list[1].length;
    out.push({ from: at, to: list[0].length, role: 'listMarker' });
  }
}

// --- the document ----------------------------------------------------------------

interface LineInfo {
  text: string;
  fence: FenceMark | null;
}

const NO_DECORATIONS: readonly InlineDecoration[] = [];

/** One fence found by a scan: its lines, by top-level index. */
interface FenceRun {
  open: number;
  /** The closing line, or -1 for a fence still open at the end. */
  close: number;
  lang: string;
}

/**
 * Reads a document's lines into each block's `LineMarkup`, a keystroke at a
 * time. What it keeps from one scan to the next: each node's text and fence
 * mark, each node's spans as styled for one config, and a run cache per
 * fence — keyed by its opening line's block key — so typing in a long fence
 * tokenizes the lines it changed.
 */
export class MarkupScanner {
  private info = new WeakMap<PMNode, LineInfo>();
  private styled = new WeakMap<
    PMNode,
    { config: MarkupConfig; inline: readonly InlineDecoration[] }
  >();
  private fences = new Map<string, CodeBlockRunCache>();
  private fromRuns = new WeakMap<
    readonly TextRun[],
    readonly InlineDecoration[]
  >();
  private runStyles = new WeakMap<TextRun, RunStyle>();

  private lineInfo(node: PMNode): LineInfo {
    let info = this.info.get(node);
    if (!info) {
      const text = lineText(node);
      info = { text, fence: fenceOf(text) };
      this.info.set(node, info);
    }
    return info;
  }

  /** A line outside a fence: its spans, styled. */
  private lineDecorations(
    node: PMNode,
    config: MarkupConfig,
  ): readonly InlineDecoration[] {
    const hit = this.styled.get(node);
    if (hit && hit.config === config) return hit.inline;
    const spans = inlineMarkup(this.lineInfo(node).text, config.mode);
    const inline = spans.length
      ? spans.map((s) => ({
          from: s.from,
          to: s.to,
          style: config.styles[s.role],
        }))
      : NO_DECORATIONS;
    this.styled.set(node, { config, inline });
    return inline;
  }

  /** A fence's body line: its tokens' colours, as decorations. */
  private bodyDecorations(
    runs: readonly TextRun[],
  ): readonly InlineDecoration[] {
    let out = this.fromRuns.get(runs);
    if (!out) {
      const decos: InlineDecoration[] = [];
      let at = 0;
      for (const run of runs) {
        let style = this.runStyles.get(run);
        if (!style) {
          const { text: _text, ...rest } = run;
          void _text;
          style = rest;
          this.runStyles.set(run, style);
        }
        decos.push({ from: at, to: at + run.text.length, style });
        at += run.text.length;
      }
      out = decos;
      this.fromRuns.set(runs, out);
    }
    return out;
  }

  /**
   * Read `doc` and set each top-level textblock's markup in `store`, by the
   * key `keyAt` gives its start. A block whose markup is what it was is not
   * told, and a block with none has none.
   */
  scan(
    doc: PMNode,
    keyAt: (pos: number) => string | undefined,
    config: MarkupConfig,
    store: KeyedStore<LineMarkup>,
  ): void {
    const nodes: PMNode[] = [];
    const keys: Array<string | undefined> = [];
    doc.forEach((child, offset) => {
      nodes.push(child);
      keys.push(child.isTextblock ? keyAt(offset) : undefined);
    });

    // the fences: an opening line, to a line that closes it or the end
    const fences: FenceRun[] = [];
    const role: Array<FenceRole | null> = new Array(nodes.length).fill(null);
    let open: { at: number; mark: FenceMark } | null = null;
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].isTextblock) continue;
      const { fence } = this.lineInfo(nodes[i]);
      if (open) {
        if (fence && closesFence(open.mark, fence)) {
          role[i] = 'close';
          fences.push({
            open: open.at,
            close: i,
            lang: fenceLanguage(open.mark.info),
          });
          open = null;
        } else {
          role[i] = 'body';
        }
      } else if (fence) {
        role[i] = 'open';
        open = { at: i, mark: fence };
      }
    }
    if (open) {
      fences.push({
        open: open.at,
        close: -1,
        lang: fenceLanguage(open.mark.info),
      });
    }

    const records: Array<LineMarkup | undefined> = new Array(nodes.length);
    const seenFences = new Set<string>();
    for (const fence of fences) {
      const last = fence.close >= 0 ? fence.close : nodes.length - 1;
      const textblocks: number[] = [];
      for (let i = fence.open; i <= last; i++) {
        if (nodes[i].isTextblock) textblocks.push(i);
      }
      const bandOf = (k: number): BandPart =>
        textblocks.length === 1
          ? 'only'
          : k === 0
            ? 'start'
            : k === textblocks.length - 1
              ? 'end'
              : 'middle';
      const body = textblocks.filter((i) => role[i] === 'body');
      let runs: readonly TextRun[][] = [];
      const openKey = keys[fence.open];
      if (body.length && openKey) {
        seenFences.add(openKey);
        let cache = this.fences.get(openKey);
        if (!cache) this.fences.set(openKey, (cache = new CodeBlockRunCache()));
        runs = cache.runsByLine(
          body.map((i) => this.lineInfo(nodes[i]).text),
          config.code,
          {
            lang: fence.lang,
            highlight: config.highlight,
            ...(config.resolveLanguage
              ? { resolveLanguage: config.resolveLanguage }
              : null),
          },
        );
      }
      let b = 0;
      textblocks.forEach((i, k) => {
        const r = role[i]!;
        const size = nodes[i].content.size;
        const inline =
          r === 'body'
            ? this.bodyDecorations(runs[b++] ?? [])
            : size
              ? [{ from: 0, to: size, style: config.styles.fence }]
              : NO_DECORATIONS;
        records[i] = { inline, fence: r, band: bandOf(k) };
      });
    }
    for (const [key, cache] of this.fences) {
      if (seenFences.has(key)) continue;
      cache.dispose();
      this.fences.delete(key);
    }

    const seen = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      const key = keys[i];
      if (!key) continue;
      seen.add(key);
      let record = records[i];
      if (!record) {
        const inline = this.lineDecorations(nodes[i], config);
        if (inline.length) record = { inline, fence: null, band: null };
      }
      const prev = store.get(key);
      if (record && prev && sameMarkup(prev, record)) continue;
      store.set(key, record);
    }
    for (const key of [...store.keys()]) {
      if (!seen.has(key)) store.set(key, undefined);
    }
  }

  /** Let go of every fence's tokenizer. */
  dispose(): void {
    for (const cache of this.fences.values()) cache.dispose();
    this.fences.clear();
  }
}

function sameMarkup(a: LineMarkup, b: LineMarkup): boolean {
  if (a.fence !== b.fence || a.band !== b.band) return false;
  if (a.inline === b.inline) return true;
  if (a.inline.length !== b.inline.length) return false;
  for (let i = 0; i < a.inline.length; i++) {
    const x = a.inline[i];
    const y = b.inline[i];
    if (x.from !== y.from || x.to !== y.to || x.style !== y.style) return false;
  }
  return true;
}

/** What `markup` draws with, from the editor's look: markers in the muted
 *  ink, code in the mono face on the code tint, list markers in the accent. */
export function markupConfig(
  mode: MarkupMode,
  look: {
    size: number;
    mono: string;
    text: string;
    muted: string;
    accent: string;
    codeBg: string;
    code: CodeBlockLook;
    highlightCode: boolean;
    resolveLanguage?: (tag: string) => Language | null;
  },
): MarkupConfig {
  const muted: RunStyle = { color: look.muted };
  const code: RunStyle = {
    family: look.mono,
    size: Math.round(look.size * 0.9),
    bg: look.codeBg,
  };
  return {
    mode,
    styles: {
      marker: muted,
      code,
      codeMarker: { ...code, color: look.muted },
      strong: { weight: 700 },
      em: { style: 'italic' },
      strike: { strike: look.text },
      heading: { weight: 700 },
      quote: muted,
      listMarker: { color: look.accent },
      fence: muted,
    },
    code: look.code,
    highlight: look.highlightCode,
    ...(look.resolveLanguage
      ? { resolveLanguage: look.resolveLanguage }
      : null),
  };
}

const INDENT = '  ';

/**
 * Tab and Shift-Tab on a fence's code lines: two spaces in, or up to two
 * out, on every code line the selection touches — and Tab with nothing
 * selected types two spaces, as it does in a code block. Null where the
 * selection is on no code line, so Tab goes on to leave the editor.
 * `markupAt` is the view's: a line's markup by a position in it.
 */
export function indentFence(
  state: EditorState,
  markupAt: (pos: number) => LineMarkup | undefined,
  dir: 1 | -1,
): Transaction | null {
  const { doc, selection } = state;
  const lines: number[] = [];
  doc.nodesBetween(selection.from, selection.to, (node, pos, parent) => {
    if (parent === doc && node.isTextblock) {
      if (markupAt(pos + 1)?.fence === 'body') lines.push(pos + 1);
    }
    return false;
  });
  if (lines.length === 0) return null;
  const tr = state.tr;
  if (dir === 1 && selection.empty) return tr.insertText(INDENT);
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i];
    if (dir === 1) {
      tr.insertText(INDENT, at);
      continue;
    }
    let n = 0;
    while (n < INDENT.length && doc.textBetween(at + n, at + n + 1) === ' ')
      n++;
    if (n) tr.delete(at, at + n);
  }
  return tr;
}
