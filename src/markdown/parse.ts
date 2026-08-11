// Markdown → AST, written for this component rather than adapted from a
// DOM-shaped pipeline. GFM-flavoured CommonMark: headings (ATX and setext),
// paragraphs, fenced and indented code, blockquotes with lazy continuation,
// nested ordered/bullet/task lists with the tight/loose distinction, tables,
// thematic breaks; inline emphasis with the real flanking and rule-of-three
// algorithm, code spans, links, images, autolinks, hard breaks, entities.
//
// The deliberate deviations, all in the direction LLM output wants:
//
// - **Streaming tolerance is in the parser, not a repair pre-pass.** The
//   behavioural spec is Streamdown's `remend` package (the handlers were
//   read, not imported): unclosed `**`/`*`/`~~`/`` ` `` reaching the end of
//   a partial document close implicitly, `[text](partial-url` renders its
//   text link-styled with `href: null`, half-arrived images vanish, a bare
//   trailing `**`, `#` or `---` is held back until it can be read. Doing it
//   during the parse means one pass over the text instead of
//   repair-then-reparse, and none of remend's "was that backtick inside a
//   fence?" re-scans.
// - **Single `~` is never strikethrough** (GFM allows it): `~~` only, so
//   "20~25" needs no escaping heuristic.
// - **Reference links (`[text][ref]`) stay literal.** They need a
//   definitions pass over the whole document, and streamed model output
//   essentially never uses them.
// - **Raw HTML is literal text.** There is no HTML pass anywhere in this
//   component, by design; `<Component />` syntax is reserved for a future
//   MDX extension (see `ComponentInline` in ast.ts).
import type {
  BlockNode,
  Document,
  InlineNode,
  ListBlock,
  ListItem,
  ParseOptions,
  TableAlign,
} from './ast.js';

// --- line-level regexes, compiled once -------------------------------------

const RE_BLANK = /^[ \t]*$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RE_ATX_STUB = /^ {0,3}#{1,6}$/;
const RE_FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const RE_HR = /^ {0,3}([*_-])[ \t]*(?:\1[ \t]*){2,}$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_QUOTE = /^ {0,3}>[ ]?(.*)$/;
const RE_LIST = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const RE_TASK = /^\[([ xX])\][ \t]+/;
const RE_INDENT_CODE = /^(?: {4}|\t)/;
// a complete GFM delimiter row: | :---: | --- |
const RE_TABLE_DELIM =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
// a plausible prefix of one, for the streaming case ("| :--" mid-arrival)
const RE_TABLE_DELIM_PREFIX = /^ {0,3}\|[ \t:|-]*$/;

/** Would this line open something other than a paragraph? The test lazy
 *  continuation and list/quote termination share. */
function isBlockStart(line: string): boolean {
  return (
    RE_ATX.test(line) ||
    RE_FENCE_OPEN.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_LIST.test(line)
  );
}

/** Leading tabs advance to 4-column stops; content tabs are left alone. */
function expandLeadingTabs(line: string): string {
  let i = 0;
  let col = 0;
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch === 32) col += 1;
    else if (ch === 9) col += 4 - (col % 4);
    else break;
    i += 1;
  }
  if (col === i) return line; // no tabs in the indent
  return ' '.repeat(col) + line.slice(i);
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i += 1;
  return i;
}

// --- entry -----------------------------------------------------------------

export function parse(source: string, options: ParseOptions = {}): Document {
  const partial = options.partial !== false;
  const normalized = source.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').map(expandLeadingTabs);
  const blocks: BlockNode[] = [];
  const ranges: Array<[number, number]> = [];
  parseBlocks(lines, partial, blocks, ranges);
  return {
    blocks,
    raws: ranges.map(([a, b]) => lines.slice(a, b).join('\n')),
  };
}

// --- block layer -----------------------------------------------------------

/**
 * Parse a run of lines into blocks. `tailOpen` says the end of `lines` is
 * the live end of a streaming document — the license for every "complete it
 * anyway" rule. `ranges`, when given, receives each block's [start, endExcl)
 * line range (only the top-level call wants them, for the streaming cache).
 */
function parseBlocks(
  lines: string[],
  tailOpen: boolean,
  out: BlockNode[],
  ranges?: Array<[number, number]>,
): void {
  let i = 0;
  const n = lines.length;

  let paraStart = -1;
  const para: string[] = [];

  const commit = (block: BlockNode, start: number, end: number): void => {
    out.push(block);
    ranges?.push([start, end]);
  };

  const flushPara = (end: number): void => {
    if (para.length === 0) return;
    const text = para.join('\n');
    const start = paraStart;
    para.length = 0;
    paraStart = -1;
    // the paragraph owns the live tail iff its last line is the document's
    const children = parseInline(text, tailOpen && end === n);
    if (children.length > 0)
      commit({ type: 'paragraph', children }, start, end);
  };

  while (i < n) {
    const line = lines[i];
    const isLast = i === n - 1;
    const held = tailOpen && isLast; // "might still grow" applies

    if (RE_BLANK.test(line)) {
      flushPara(i);
      i += 1;
      continue;
    }

    // Setext underline closes an open paragraph — unless it is the live
    // tail, where "Title\n---" might still become a rule, a list item or
    // plain text ("--- more"), so the line is held back for one round.
    if (para.length > 0) {
      const setext = RE_SETEXT.exec(line);
      if (setext) {
        if (held) {
          i += 1;
          continue;
        }
        const text = para.join('\n');
        const start = paraStart;
        para.length = 0;
        paraStart = -1;
        commit(
          {
            type: 'heading',
            depth: setext[1][0] === '=' ? 1 : 2,
            children: parseInline(text, false),
          },
          start,
          i + 1,
        );
        i += 1;
        continue;
      }
    }

    // Ambiguous live tails, hidden until they commit to being something:
    // a bare marker run (`---`, `***` — rule? setext? bold opener?) or a
    // content-less ATX stub (`##`).
    if (
      held &&
      para.length === 0 &&
      (RE_SETEXT.test(line) || RE_HR.test(line) || RE_ATX_STUB.test(line))
    ) {
      i += 1;
      continue;
    }

    // Thematic break — before list, so `- - -` is a rule and not a list.
    if (RE_HR.test(line)) {
      flushPara(i);
      commit({ type: 'rule' }, i, i + 1);
      i += 1;
      continue;
    }

    const atx = RE_ATX.exec(line);
    if (atx) {
      flushPara(i);
      commit(
        {
          type: 'heading',
          depth: atx[1].length,
          children: parseInline(atx[2] ?? '', held),
        },
        i,
        i + 1,
      );
      i += 1;
      continue;
    }

    const fence = RE_FENCE_OPEN.exec(line);
    // an info string on a backtick fence cannot itself contain a backtick
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      flushPara(i);
      const start = i;
      const fenceIndent = fence[1].length;
      const marker = fence[2];
      const lang = (fence[3].trim().split(/[ \t]/, 1)[0] ?? '').toLowerCase();
      const body: string[] = [];
      let closed = false;
      i += 1;
      while (i < n) {
        const l = lines[i];
        const close = RE_FENCE_OPEN.exec(l);
        if (
          close &&
          close[2][0] === marker[0] &&
          close[2].length >= marker.length &&
          close[3] === ''
        ) {
          closed = true;
          i += 1;
          break;
        }
        // content dedents by at most the opening fence's indent
        body.push(
          indentOf(l) >= fenceIndent
            ? l.slice(fenceIndent)
            : l.replace(/^ +/, ''),
        );
        i += 1;
      }
      commit({ type: 'code', lang, text: body.join('\n'), closed }, start, i);
      continue;
    }

    const quote = RE_QUOTE.exec(line);
    if (quote) {
      flushPara(i);
      const start = i;
      const inner: string[] = [];
      inner.push(quote[1]);
      i += 1;
      // further `>` lines, plus lazy continuation of a trailing paragraph
      while (i < n) {
        const l = lines[i];
        const q = RE_QUOTE.exec(l);
        if (q) {
          inner.push(q[1]);
          i += 1;
          continue;
        }
        if (
          !RE_BLANK.test(l) &&
          !isBlockStart(l) &&
          inner.length > 0 &&
          !RE_BLANK.test(inner[inner.length - 1])
        ) {
          inner.push(l); // lazy: "> a\nb" keeps b in the quote
          i += 1;
          continue;
        }
        break;
      }
      const children: BlockNode[] = [];
      parseBlocks(inner, tailOpen && i === n, children);
      if (children.length > 0) commit({ type: 'quote', children }, start, i);
      continue;
    }

    const list = RE_LIST.exec(line);
    // an empty item cannot interrupt a paragraph ("foo\n-" is not a list…),
    // and while streaming the very last line gets the same benefit of doubt
    if (list && !(para.length > 0 && !list[4]) && !(held && !list[4])) {
      flushPara(i);
      const start = i;
      const block = parseList(lines, i, tailOpen);
      i = block.end;
      commit(block.list, start, i);
      continue;
    }

    // GFM table: a header row whose next line is the delimiter row. While
    // streaming, a delimiter row still arriving ("| :--") is accepted too.
    if (para.length === 0 && line.includes('|')) {
      const next = i + 1 < n ? lines[i + 1] : null;
      const headerCells = splitRow(line);
      // a complete delimiter row with agreeing column count is the real
      // thing; while streaming, a still-arriving one ("| :-" as the last
      // line) is accepted with the header's column count and no alignment
      const fullDelim =
        next !== null &&
        next.includes('-') &&
        RE_TABLE_DELIM.test(next) &&
        splitRow(next).length === headerCells.length;
      const partialDelim =
        !fullDelim &&
        tailOpen &&
        i + 1 === n - 1 &&
        next !== null &&
        RE_TABLE_DELIM_PREFIX.test(next);
      const arrivingDelim = tailOpen && i === n - 1;
      if (headerCells.length > 0 && (fullDelim || partialDelim)) {
        const start = i;
        const align: TableAlign[] = fullDelim
          ? splitRow(next).map(alignOf)
          : headerCells.map(() => null);
        i += 2;
        const rows: InlineNode[][][] = [];
        while (i < n) {
          const l = lines[i];
          if (RE_BLANK.test(l) || !l.includes('|') || isBlockStart(l)) break;
          rows.push(
            normalizeRow(splitRow(l), align.length, tailOpen && i === n - 1),
          );
          i += 1;
        }
        commit(
          {
            type: 'table',
            align,
            header: normalizeRow(headerCells, align.length, false),
            rows,
          },
          start,
          i,
        );
        continue;
      } else if (
        arrivingDelim &&
        headerCells.length > 1 &&
        line.trimStart().startsWith('|')
      ) {
        // the header row itself is the live tail — hold it rather than
        // flashing "| a | b |" as literal text for one frame
        i += 1;
        continue;
      }
    }

    // indented code cannot interrupt a paragraph
    if (para.length === 0 && RE_INDENT_CODE.test(line)) {
      const start = i;
      const body: string[] = [];
      while (i < n) {
        const l = lines[i];
        if (RE_INDENT_CODE.test(l)) {
          body.push(l.startsWith('\t') ? l.slice(1) : l.slice(4));
          i += 1;
        } else if (RE_BLANK.test(l)) {
          body.push('');
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      commit(
        { type: 'code', lang: '', text: body.join('\n'), closed: true },
        start,
        i,
      );
      continue;
    }

    if (para.length === 0) paraStart = i;
    // only the lead is trimmed: trailing spaces are the hard-break syntax
    para.push(line.trimStart());
    i += 1;
  }

  flushPara(n);
}

// --- lists -----------------------------------------------------------------

interface ParsedList {
  list: ListBlock;
  end: number;
}

function parseList(
  lines: string[],
  from: number,
  tailOpen: boolean,
): ParsedList {
  const n = lines.length;
  const first = RE_LIST.exec(lines[from]);
  // caller matched — this is the narrowing, not a runtime possibility
  if (!first) throw new Error('parseList called off a list marker');
  const marker = first[2];
  const ordered = marker.length > 1;
  const markerType = ordered ? marker[marker.length - 1] : marker; // ')' '.' '-' '+' '*'
  const start = ordered ? parseInt(marker, 10) : 1;

  const items: ListItem[] = [];
  let loose = false;
  let i = from;
  let sawBlank = false;

  while (i < n) {
    const m = RE_LIST.exec(lines[i]);
    const sameKind =
      m &&
      (ordered
        ? /\d/.test(m[2][0]) && m[2][m[2].length - 1] === markerType
        : m[2] === markerType);
    if (!sameKind) break;
    if (sawBlank && items.length > 0) loose = true;
    sawBlank = false;

    const indent = m[1].length;
    const afterMarker = m[3] ?? '';
    const rest = m[4] ?? '';
    // content column: marker + one space, or the actual spacing when ≤ 4
    const pad =
      afterMarker.length === 0 || afterMarker.length > 4
        ? 1
        : afterMarker.length;
    const contentIndent = indent + m[2].length + pad;

    const inner: string[] = [rest];
    i += 1;
    let pendingBlanks = 0;
    while (i < n) {
      const l = lines[i];
      if (RE_BLANK.test(l)) {
        pendingBlanks += 1;
        if (pendingBlanks > 1) break;
        i += 1;
        continue;
      }
      if (indentOf(l) >= contentIndent) {
        if (pendingBlanks > 0) {
          inner.push('');
          loose = true;
          pendingBlanks = 0;
        }
        inner.push(l.slice(contentIndent));
        i += 1;
        continue;
      }
      if (pendingBlanks === 0 && !isBlockStart(l) && !RE_BLANK.test(l)) {
        inner.push(l); // lazy paragraph continuation
        i += 1;
        continue;
      }
      break;
    }
    if (pendingBlanks > 0) sawBlank = true;

    // GFM task marker sits at the head of the item's first line
    let checked: boolean | null = null;
    const task = RE_TASK.exec(inner[0]);
    if (task) {
      checked = task[1] !== ' ';
      inner[0] = inner[0].slice(task[0].length);
    }

    const children: BlockNode[] = [];
    parseBlocks(inner, tailOpen && i >= n, children);
    items.push({ checked, children });
  }

  return {
    list: { type: 'list', ordered, start, tight: !loose, items },
    end: i,
  };
}

// --- tables ----------------------------------------------------------------

/** Split a row on unescaped pipes; `\|` stays literal in the cell. */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  if (cells.length > 0 && cells[0] === '' && trimmed.startsWith('|'))
    cells.shift();
  if (
    cells.length > 0 &&
    cells[cells.length - 1] === '' &&
    trimmed.endsWith('|')
  )
    cells.pop();
  return cells;
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function normalizeRow(
  cells: string[],
  width: number,
  rowIsLiveTail: boolean,
): InlineNode[][] {
  const row: InlineNode[][] = [];
  for (let c = 0; c < width; c += 1) {
    const text = cells[c] ?? '';
    row.push(
      parseInline(
        text,
        rowIsLiveTail && c === Math.min(cells.length, width) - 1,
      ),
    );
  }
  return row;
}

// --- inline layer ----------------------------------------------------------

// A mutable working item: finished inline nodes interleaved with unresolved
// delimiter runs, resolved in place by the emphasis pass.
type Item =
  | { kind: 'node'; node: InlineNode }
  | {
      kind: 'delim';
      char: '*' | '_' | '~';
      length: number;
      canOpen: boolean;
      canClose: boolean;
    }
  | { kind: 'bracket'; image: boolean };

const RE_UNI_WS = /\s/u;
const RE_UNI_PUNCT = /[\p{P}\p{S}]/u;
const RE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/;
const RE_AUTOEMAIL = /^<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/;
const RE_ENTITY =
  /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  times: '×',
  middot: '·',
};

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(RE_ENTITY, (whole, dec, hex, named) => {
    if (dec) {
      const cp = parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
    }
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
    }
    return NAMED_ENTITIES[named] ?? whole;
  });
}

function classify(ch: string | undefined): 'ws' | 'punct' | 'other' {
  if (ch === undefined) return 'ws'; // string boundaries count as whitespace
  if (RE_UNI_WS.test(ch)) return 'ws';
  if (RE_UNI_PUNCT.test(ch)) return 'punct';
  return 'other';
}

/**
 * Parse inline markdown. `atDocEnd` marks text whose end is the live end of
 * a streaming document — only then do the implicit-close rules apply.
 */
export function parseInline(text: string, atDocEnd: boolean): InlineNode[] {
  const items: Item[] = [];
  let buf = '';

  const flushText = (): void => {
    if (buf.length === 0) return;
    items.push({
      kind: 'node',
      node: { type: 'text', text: decodeEntities(buf) },
    });
    buf = '';
  };

  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];

    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        // hard break by trailing backslash
        flushText();
        items.push({ kind: 'node', node: { type: 'break' } });
        i += 2;
        continue;
      }
      if (next !== undefined && RE_UNI_PUNCT.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '\n') {
      const hard = buf.endsWith('  ');
      buf = buf.replace(/[ \t]+$/, '');
      flushText();
      items.push({
        kind: 'node',
        node: hard ? { type: 'break' } : { type: 'text', text: ' ' },
      });
      i += 1;
      while (text[i] === ' ' || text[i] === '\t') i += 1;
      continue;
    }

    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run += 1;
      // the closing run must be exactly as long, and not part of a longer one
      let j = i + run;
      let close = -1;
      while (j < len) {
        if (text[j] === '`') {
          let r = 1;
          while (text[j + r] === '`') r += 1;
          if (r === run) {
            close = j;
            break;
          }
          j += r;
        } else j += 1;
      }
      if (close !== -1) {
        flushText();
        items.push({
          kind: 'node',
          node: {
            type: 'code',
            text: codeSpanText(text.slice(i + run, close)),
          },
        });
        i = close + run;
        continue;
      }
      if (atDocEnd) {
        // `remend`'s inlineCode rule: an open span at the live end closes
        // itself — unless nothing follows the backticks yet, then hide them
        const rest = text.slice(i + run);
        flushText();
        if (rest.length > 0)
          items.push({
            kind: 'node',
            node: { type: 'code', text: codeSpanText(rest) },
          });
        i = len;
        continue;
      }
      buf += text.slice(i, i + run);
      i += run;
      continue;
    }

    if (ch === '<') {
      const rest = text.slice(i);
      const auto = RE_AUTOLINK.exec(rest) ?? RE_AUTOEMAIL.exec(rest);
      if (auto) {
        flushText();
        const target = auto[1];
        const href = RE_AUTOLINK.test(auto[0]) ? target : `mailto:${target}`;
        items.push({
          kind: 'node',
          node: {
            type: 'link',
            href,
            image: false,
            children: [{ type: 'text', text: target }],
          },
        });
        i += auto[0].length;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const image = ch === '!';
      flushText();
      items.push({ kind: 'bracket', image });
      i += image ? 2 : 1;
      continue;
    }

    if (ch === ']') {
      const openIdx = lastBracket(items);
      if (openIdx === -1) {
        buf += ch;
        i += 1;
        continue;
      }
      const suffix = parseLinkSuffix(text, i + 1);
      if (suffix) {
        flushText();
        closeLink(items, openIdx, suffix.href);
        i = suffix.end;
        continue;
      }
      if (atDocEnd && text[i + 1] === '(' && !text.includes(')', i + 1)) {
        // `[text](partial-url` at the live end: keep the text, link-styled,
        // with nowhere to go yet. A half-arrived image vanishes instead.
        flushText();
        const bracket = items[openIdx] as { kind: 'bracket'; image: boolean };
        if (bracket.image) items.splice(openIdx);
        else closeLink(items, openIdx, null);
        i = len;
        continue;
      }
      // no destination: not a link (reference links stay literal)
      flushText();
      items.splice(openIdx, 1, {
        kind: 'node',
        node: {
          type: 'text',
          text: (items[openIdx] as { image: boolean }).image ? '![' : '[',
        },
      });
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 1;
      while (text[i + run] === ch) run += 1;
      const before = classify(text[i - 1]);
      const after = classify(text[i + run]);
      const leftFlank =
        after !== 'ws' && (after !== 'punct' || before !== 'other');
      const rightFlank =
        before !== 'ws' && (before !== 'punct' || after !== 'other');
      let canOpen = leftFlank;
      let canClose = rightFlank;
      if (ch === '_') {
        // intraword `_` never opens or closes: snake_case stays literal
        canOpen = leftFlank && (!rightFlank || before === 'punct');
        canClose = rightFlank && (!leftFlank || after === 'punct');
      }
      if (ch === '~' && run !== 2) {
        buf += text.slice(i, i + run);
        i += run;
        continue;
      }
      // a fresh opener with nothing after it yet, at the live end of the
      // document — `text **` — is hidden rather than shown as raw markers
      if (atDocEnd && i + run === len && before !== 'other') {
        i = len;
        continue;
      }
      if (!canOpen && !canClose) {
        buf += text.slice(i, i + run);
        i += run;
        continue;
      }
      flushText();
      items.push({ kind: 'delim', char: ch, length: run, canOpen, canClose });
      i += run;
      continue;
    }

    buf += ch;
    i += 1;
  }
  flushText();

  processEmphasis(items, atDocEnd);

  // leftover brackets: a live-tail `[still typing…` renders link-styled,
  // a dead one is the literal character it always was
  for (let k = items.length - 1; k >= 0; k -= 1) {
    const it = items[k];
    if (it.kind !== 'bracket') continue;
    if (atDocEnd) {
      if (it.image) items.splice(k);
      else closeLink(items, k, null);
    } else {
      items.splice(k, 1, {
        kind: 'node',
        node: { type: 'text', text: it.image ? '![' : '[' },
      });
    }
  }

  return finish(items);
}

/** CommonMark's code-span rule: newlines become spaces, and one space is
 *  shaved off each end when both ends have one and content remains. */
function codeSpanText(raw: string): string {
  const flat = raw.replace(/\n/g, ' ');
  if (
    flat.length >= 2 &&
    flat.startsWith(' ') &&
    flat.endsWith(' ') &&
    flat.trim() !== ''
  )
    return flat.slice(1, -1);
  return flat;
}

function lastBracket(items: Item[]): number {
  for (let k = items.length - 1; k >= 0; k -= 1)
    if (items[k].kind === 'bracket') return k;
  return -1;
}

interface LinkSuffix {
  href: string;
  end: number;
}

/** `](dest "title")` — destination in `<>` or bare with balanced parens.
 *  The title is tolerated and dropped: nothing here renders one. */
function parseLinkSuffix(text: string, from: number): LinkSuffix | null {
  if (text[from] !== '(') return null;
  let i = from + 1;
  const len = text.length;
  while (i < len && (text[i] === ' ' || text[i] === '\n')) i += 1;
  let href = '';
  if (text[i] === '<') {
    const close = text.indexOf('>', i + 1);
    if (close === -1) return null;
    href = text.slice(i + 1, close);
    if (href.includes('\n')) return null;
    i = close + 1;
  } else {
    let depth = 0;
    while (i < len) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < len) {
        href += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      if (ch === ' ' || ch === '\n' || ch === '\t') break;
      href += ch;
      i += 1;
    }
  }
  while (i < len && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t'))
    i += 1;
  // an optional title in any of the three quote styles
  const q = text[i];
  if (q === '"' || q === "'" || q === '(') {
    const closer = q === '(' ? ')' : q;
    let j = i + 1;
    while (j < len && text[j] !== closer) j += 1;
    if (j >= len) return null;
    i = j + 1;
    while (i < len && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t'))
      i += 1;
  }
  if (text[i] !== ')') return null;
  return { href: decodeEntities(href), end: i + 1 };
}

/** Fold everything after the bracket opener at `openIdx` into a link node. */
function closeLink(items: Item[], openIdx: number, href: string | null): void {
  const bracket = items[openIdx] as { kind: 'bracket'; image: boolean };
  const inner = items.splice(openIdx);
  inner.shift();
  // emphasis inside the link text resolves within the link's own scope
  processEmphasis(inner, href === null);
  items.push({
    kind: 'node',
    node: { type: 'link', href, image: bracket.image, children: finish(inner) },
  });
}

/**
 * The CommonMark delimiter algorithm over `items`, in place: walk closers
 * left to right, match each to the nearest compatible opener, wrap. The
 * "rule of three" guards `**foo*` against eating the wrong marker. With
 * `implicitClose` (the live tail), openers left standing afterwards close
 * at the end of the text — that is `remend`'s bold/italic/strikethrough
 * behaviour — unless nothing follows them, in which case they vanish.
 */
function processEmphasis(items: Item[], implicitClose: boolean): void {
  let closer = 0;
  while (closer < items.length) {
    const c = items[closer];
    if (c.kind !== 'delim' || !c.canClose) {
      closer += 1;
      continue;
    }
    let opener = -1;
    for (let k = closer - 1; k >= 0; k -= 1) {
      const o = items[k];
      if (o.kind === 'bracket') break; // emphasis cannot cross a link boundary
      if (o.kind !== 'delim' || o.char !== c.char || !o.canOpen) continue;
      // rule of three
      if (
        (o.canClose || c.canOpen) &&
        (o.length + c.length) % 3 === 0 &&
        (o.length % 3 !== 0 || c.length % 3 !== 0)
      )
        continue;
      opener = k;
      break;
    }
    if (opener === -1) {
      if (!c.canOpen) {
        items.splice(closer, 1, delimToText(c));
      }
      closer += 1;
      continue;
    }

    const o = items[opener] as Extract<Item, { kind: 'delim' }>;
    const use = c.char === '~' ? 2 : Math.min(2, o.length, c.length);
    const type = c.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const inner = items.splice(opener + 1, closer - opener - 1);
    const node: InlineNode = { type, children: finish(inner) };
    o.length -= use;
    c.length -= use;
    items.splice(opener + 1, 0, { kind: 'node', node });
    closer = opener + 2;
    if (o.length === 0) {
      items.splice(opener, 1);
      closer -= 1;
    }
    if (c.length === 0) items.splice(closer, 1);
  }

  if (implicitClose) {
    // leftmost surviving opener wraps the rest; repeats handle `**a *b`
    for (let k = 0; k < items.length; k += 1) {
      const o = items[k];
      if (o.kind !== 'delim' || !o.canOpen) continue;
      const rest = items.splice(k + 1);
      const restNodes = finish(rest);
      if (restNodes.length === 0) {
        items.splice(k, 1);
        k -= 1;
        continue;
      }
      let node: InlineNode;
      if (o.char === '~') node = { type: 'del', children: restNodes };
      else if (o.length >= 3)
        node = {
          type: 'strong',
          children: [{ type: 'em', children: restNodes }],
        };
      else if (o.length === 2) node = { type: 'strong', children: restNodes };
      else node = { type: 'em', children: restNodes };
      items.splice(k, 1, { kind: 'node', node });
    }
  }

  // whatever survives was never emphasis — restore the literal characters
  for (let k = 0; k < items.length; k += 1) {
    const it = items[k];
    if (it.kind === 'delim') items.splice(k, 1, delimToText(it));
  }
}

function delimToText(d: Extract<Item, { kind: 'delim' }>): Item {
  return {
    kind: 'node',
    node: { type: 'text', text: d.char.repeat(d.length) },
  };
}

/** Collapse a fully-resolved item list to nodes, merging adjacent texts. */
function finish(items: Item[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const it of items) {
    const node =
      it.kind === 'node'
        ? it.node
        : it.kind === 'delim'
          ? ({ type: 'text', text: it.char.repeat(it.length) } as InlineNode)
          : ({ type: 'text', text: it.image ? '![' : '[' } as InlineNode);
    const prev = out[out.length - 1];
    if (node.type === 'text' && prev?.type === 'text') {
      prev.text += node.text;
    } else if (!(node.type === 'text' && node.text === '')) {
      out.push(node);
    }
  }
  return out;
}
