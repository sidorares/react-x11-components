// AST → markdown: the other half of `./parse.ts`.
//
// The rich text editor keeps its document as ProseMirror nodes and saves it
// as markdown through this AST, so this is the serializer the package did not
// have — and it is written against the parser beside it rather than against
// CommonMark in the abstract, because that parser is the first reader every
// document written here meets. What comes out is *normalized* GFM, not the
// source a document was parsed from: ATX headings, `-` bullets, `1.`
// numbering, fenced code, `**`/`*`/`~~`, backslash hard breaks. What is
// promised is the round trip: `parse(stringify(ast), { partial: false })`
// gives back `ast` for every AST the parser can produce and every one the
// editor builds, which test/rich-text-editor-markdown.test.ts holds it to
// over a generated corpus as well as by example.
//
// Nearly all of the work is escaping, and nearly all of the escaping is
// context: `*` is always syntax, `_` only at the edge of a word, `~` only in
// pairs, and `#`, `>`, `-`, `1.` only at the start of a line — where a line
// starts after every hard break, not only at the top of a paragraph.
import type {
  BlockNode,
  CodeBlock,
  Document,
  InlineNode,
  LinkInline,
  ListBlock,
  TableBlock,
} from './ast.js';
import { parseInline } from './parse.js';

/** Markdown for a document, or for a run of blocks. */
export function stringify(doc: Document | readonly BlockNode[]): string {
  const blocks = 'blocks' in doc ? doc.blocks : doc;
  return blockSequence(blocks, false).join('\n');
}

// --- blocks ------------------------------------------------------------------

interface ListMarker {
  ordered: boolean;
  marker: string;
}

/** A list line with a marker and nothing after it. */
const EMPTY_ITEM = /^(?:\d{1,9}[.)]|[-+*])(?: \[[ x]\])? *$/;

/**
 * The lines for a run of sibling blocks, with a blank line between each two.
 * The exception is a nested list straight after the paragraph of a tight
 * item — "- a\n  - b" — which is how a tight list stays tight.
 */
function blockSequence(
  blocks: readonly BlockNode[],
  tightItem: boolean,
): string[] {
  const out: string[] = [];
  let prevList: ListMarker | null = null;
  for (const block of blocks) {
    let lines: string[];
    let list: ListMarker | null = null;
    if (block.type === 'list') {
      // Two lists in a row with the same marker are one list to a reader —
      // a blank line between them only makes it loose — so the second takes
      // its kind's other marker, which is the break CommonMark recognises.
      const base = block.ordered ? '.' : '-';
      const other = block.ordered ? ')' : '*';
      const marker: string =
        prevList &&
        prevList.ordered === block.ordered &&
        prevList.marker === base
          ? other
          : base;
      list = { ordered: block.ordered, marker };
      lines = listLines(block, marker);
    } else {
      lines = blockLines(block);
    }
    // an empty paragraph has no markdown; dropping it is the only honest
    // spelling of "nothing", and it keeps adjacent lists adjacent
    if (lines.length === 0) continue;
    // …and an empty item cannot interrupt a paragraph ("a\n3." is one
    // paragraph), so a list that opens with one keeps its blank line
    const interrupts =
      tightItem && block.type === 'list' && !EMPTY_ITEM.test(lines[0]);
    if (out.length > 0 && !interrupts) out.push('');
    out.push(...lines);
    prevList = list;
  }
  return out;
}

function blockLines(block: BlockNode): string[] {
  switch (block.type) {
    case 'paragraph': {
      const text = inline(block.children, 'block');
      return text === '' ? [] : text.split('\n');
    }
    case 'heading':
      return [headingLine(block.depth, block.children)];
    case 'code':
      return fenceLines(block);
    case 'quote':
      return blockSequence(block.children, false).map((line) =>
        line === '' ? '>' : `> ${line}`,
      );
    case 'list':
      return listLines(block, block.ordered ? '.' : '-');
    case 'table':
      return tableLines(block);
    case 'rule':
      return ['---'];
    case 'component':
      // The editor never builds one; an AST that has one keeps its content.
      return blockSequence(block.children, false);
  }
}

function headingLine(depth: number, children: readonly InlineNode[]): string {
  let text = inline(children, 'heading');
  // `# Title #` loses its closing run to the ATX rule — so a heading that
  // really ends in a `#` escapes the last one
  if (/(^|[ \t])#+$/.test(text)) text = `${text.slice(0, -1)}\\#`;
  const level = Math.max(1, Math.min(6, Math.round(depth)));
  return '#'.repeat(level) + (text ? ` ${text}` : '');
}

function fenceLines(block: CodeBlock): string[] {
  const info = (block.info ?? block.lang).trim();
  // a backtick fence cannot carry a backtick in its info string
  const char = info.includes('`') ? '~' : '`';
  let longest = 0;
  for (const m of block.text.matchAll(char === '`' ? /`+/g : /~+/g)) {
    longest = Math.max(longest, m[0].length);
  }
  const fence = char.repeat(Math.max(3, longest + 1));
  const body = block.text === '' ? [] : block.text.split('\n');
  return [fence + info, ...body, fence];
}

function listLines(list: ListBlock, marker: string): string[] {
  const out: string[] = [];
  list.items.forEach((item, index) => {
    const bullet = list.ordered ? `${list.start + index}${marker}` : marker;
    const pad = ' '.repeat(bullet.length + 1);
    const task = item.checked === null ? '' : item.checked ? '[x] ' : '[ ] ';
    const body = blockSequence(item.children, list.tight);
    if (index > 0 && !list.tight) out.push('');
    if (body.length === 0) {
      // "- [ ] " keeps the space: a task marker needs one after it
      out.push(task ? `${bullet} ${task}` : bullet);
      return;
    }
    out.push(`${bullet} ${task}${body[0]}`);
    for (let i = 1; i < body.length; i++) {
      out.push(body[i] === '' ? '' : pad + body[i]);
    }
  });
  return out;
}

function tableLines(table: TableBlock): string[] {
  const row = (cells: string[]): string =>
    `| ${cells.map((c) => c || ' ').join(' | ')} |`;
  const cell = (nodes: readonly InlineNode[]): string => inline(nodes, 'cell');
  const delimiter = table.align.map((a) =>
    a === 'left'
      ? ':---'
      : a === 'center'
        ? ':---:'
        : a === 'right'
          ? '---:'
          : '---',
  );
  return [
    row(table.header.map(cell)),
    row(delimiter),
    ...table.rows.map((r) => row(r.map(cell))),
  ];
}

// --- inline ------------------------------------------------------------------

/**
 * Where inline text is going. A paragraph's lines are `'block'`: each starts
 * a line, so the characters that open a block there are escaped. A heading
 * and a table cell sit on a line that has already started, so they are not —
 * but neither can hold a line break, and a cell cannot hold a bare `|`.
 */
type InlineMode = 'block' | 'heading' | 'cell';

/**
 * Inline content as markdown — checked. The rules above cover what prose
 * does, but the flanking rules have corners no delimiter placement escapes
 * (bold that ends in punctuation, glued to the word after it, next to
 * italic that does the same), and a corner is where a document loses text
 * to literal asterisks. So the output is read back with the parser and
 * compared, as flat runs of marked text, with what was meant; if they
 * differ, the same content is written without its emphasis, and failing
 * that as plain text. Links, code and every character survive either way.
 */
function inline(nodes: readonly InlineNode[], mode: InlineMode): string {
  const meant = expel(nodes);
  const first = write(meant, mode);
  if (!checkable(meant) || readsAs(first, meant, mode)) return first;
  const plainer = expel(stripEmphasis(meant));
  const second = write(plainer, mode);
  if (readsAs(second, plainer, mode)) return second;
  return write(expel(textOnly(meant)), mode);
}

function write(nodes: readonly InlineNode[], mode: InlineMode): string {
  const w = new InlineWriter(mode);
  w.nodes(nodes);
  return w.finish();
}

/** Only content the parser can say back — no MDX nodes — is checked. */
function checkable(nodes: readonly InlineNode[]): boolean {
  return nodes.every(
    (n) =>
      n.type !== 'expression' &&
      n.type !== 'component' &&
      (!('children' in n) || checkable(n.children)),
  );
}

/** Whether `text`, read back where it will be read, is `meant`. */
function readsAs(
  text: string,
  meant: readonly InlineNode[],
  mode: InlineMode,
): boolean {
  // a row is split on bare pipes before its cells are read, and a cell is
  // trimmed; the other two modes read their text as it is
  const source = mode === 'cell' ? text.replace(/\\\|/g, '|').trim() : text;
  const back = parseInline(source, false);
  return flatKey(back, mode) === flatKey(meant, mode);
}

/**
 * Inline content as flat runs of marked text — what a ProseMirror document
 * holds, and so what has to survive. Nesting order is not in it (`***x***`
 * is bold and italic either way round), and neither are the breaks that
 * trail a paragraph, which markdown cannot hold.
 */
function flatKey(nodes: readonly InlineNode[], mode: InlineMode): string {
  const runs: [string, string][] = [];
  const push = (marks: string, text: string): void => {
    const last = runs[runs.length - 1];
    if (last && last[0] === marks) last[1] += text;
    else runs.push([marks, text]);
  };
  const walk = (list: readonly InlineNode[], marks: string): void => {
    for (const node of list) {
      switch (node.type) {
        case 'text':
          for (const part of node.text.split(/(\n)/)) {
            if (part === '\n') push('\n', mode === 'block' ? '\n' : ' ');
            else if (part) push(marks, part);
          }
          break;
        case 'code':
          push(`${marks}|code`, node.text.replace(/\n/g, ' '));
          break;
        case 'break':
          if (mode === 'block') push('\n', '\n');
          else push(marks, ' ');
          break;
        case 'link':
          if (node.image)
            push(
              `${marks}|img:${node.href}:${node.title ?? ''}`,
              plain(node.children) || ' ',
            );
          else if (node.href === null) walk(node.children, marks);
          else
            walk(node.children, `${marks}|a:${node.href}:${node.title ?? ''}`);
          break;
        case 'strong':
        case 'em':
        case 'del':
          walk(
            node.children,
            [...marks.split('|').filter(Boolean), node.type].sort().join('|'),
          );
          break;
        default:
          break;
      }
    }
  };
  walk(nodes, '');
  while (runs.length && runs[runs.length - 1][0] === '\n') runs.pop();
  return JSON.stringify(runs);
}

function plain(nodes: readonly InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'code') out += node.text;
    else if ('children' in node) out += plain(node.children);
  }
  return out;
}

function stripEmphasis(nodes: readonly InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === 'strong' || node.type === 'em' || node.type === 'del') {
      out.push(...stripEmphasis(node.children));
    } else if (node.type === 'link') {
      out.push({ ...node, children: stripEmphasis(node.children) });
    } else out.push(node);
  }
  return out;
}

function textOnly(nodes: readonly InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'break') out.push(node);
    else if (node.type === 'code') out.push({ type: 'text', text: node.text });
    else if ('children' in node) out.push(...textOnly(node.children));
  }
  return out;
}

const WS = /\s/u;
const WORD = /[\p{L}\p{N}]/u;
const ENTITY_LIKE =
  /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

class InlineWriter {
  private out = '';
  /** The next character starts a line — the top of the text, or just after
   *  a hard break — which is where block syntax lives. */
  private lineStart = true;

  constructor(private readonly mode: InlineMode) {}

  finish(): string {
    let text = this.out;
    if (this.mode === 'block') {
      // A hard break has to be followed by something: at the very end of a
      // paragraph it would read back as a literal backslash, so it goes.
      text = text.replace(/(\\\n)+$/, '');
    } else if (/\s$/u.test(text)) {
      // The ATX rule and a cell's trim both eat trailing whitespace; the last
      // character of it is spelled as a reference so the text keeps it.
      const last = text[text.length - 1];
      text = text.slice(0, -1) + (last === '\t' ? '&#9;' : '&#32;');
    }
    return text;
  }

  /** `after` is the character the output continues with once these nodes
   *  are written — a closing delimiter, a `]`, or nothing at all. */
  nodes(nodes: readonly InlineNode[], after?: string): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const next = i + 1 < nodes.length ? leadOf(nodes[i + 1]) : after;
      switch (node.type) {
        case 'text':
          this.text(node.text, next);
          break;
        case 'code':
          this.code(node.text);
          break;
        case 'strong':
          this.wrap('**', node.children, next);
          break;
        case 'em': {
          // Beside another `*` run — italic at the start of bold, at its
          // end, or right before it — the two delimiters would merge into
          // one run and be read differently (`***x***` is bold inside
          // italic), so this one is `_`, where `_` can stand: not against a
          // word on either side.
          const besideStar = this.out.endsWith('*') || next === '*';
          const underscore =
            besideStar &&
            !WORD.test(lastChar(this.out) ?? '') &&
            !WORD.test(next ?? '');
          this.wrap(underscore ? '_' : '*', node.children, next);
          break;
        }
        case 'del':
          this.wrap('~~', node.children, next);
          break;
        case 'link':
          this.link(node);
          break;
        case 'break':
          this.hardBreak();
          break;
        case 'expression':
          this.raw(`{${node.src}}`);
          break;
        case 'component':
          this.nodes(node.children);
          break;
      }
    }
  }

  private raw(text: string): void {
    this.out += text;
    if (text) this.lineStart = false;
  }

  private hardBreak(): void {
    if (this.mode !== 'block') {
      // a heading or a cell is one line: the break is a space, spelled the
      // way any other space at its edge is
      this.text(' ', undefined);
      return;
    }
    this.out += '\\\n';
    this.lineStart = true;
  }

  /**
   * A delimited run. Whether a delimiter opens or closes depends on the
   * characters either side of it — CommonMark's flanking rules — so the
   * content is written first and the placement checked against what
   * actually surrounds it. Some placements have no spelling at all: `**`
   * cannot close after punctuation when a letter follows (`**"a"**s`). Then
   * the text is kept and the emphasis is not, because a word that stops
   * being bold is a smaller loss than a document that grows literal
   * asterisks every time it is saved.
   *
   * A dropped run is written again rather than unwrapped: what is inside it
   * was judged against this run's delimiters, which are no longer there, so
   * an inner run that stood beside them may not stand beside what replaced
   * them — and a line start it sat after is a line start again.
   */
  private wrap(
    delimiter: string,
    children: readonly InlineNode[],
    after: string | undefined,
  ): void {
    const start = this.out.length;
    const wasLineStart = this.lineStart;
    const before = lastChar(this.out);
    this.raw(delimiter);
    const innerStart = this.out.length;
    this.nodes(children, delimiter[0]);
    const inner = this.out.slice(innerStart);
    const ch = delimiter[0];
    if (
      inner !== '' &&
      canOpen(ch, before, firstChar(inner)) &&
      canClose(ch, lastChar(inner), after)
    ) {
      this.raw(delimiter);
      return;
    }
    this.out = this.out.slice(0, start);
    this.lineStart = wasLineStart;
    this.nodes(children, after);
  }

  private code(text: string): void {
    const flat = text.replace(/\n/g, ' ');
    let longest = 0;
    for (const m of flat.matchAll(/`+/g))
      longest = Math.max(longest, m[0].length);
    const fence = '`'.repeat(longest + 1);
    // CommonMark shaves one space off each end when both have one, and a
    // span that starts or ends in a backtick would merge with its fence
    const pad =
      flat.startsWith('`') ||
      flat.endsWith('`') ||
      (flat.startsWith(' ') && flat.endsWith(' ') && flat.trim() !== '')
        ? ' '
        : '';
    this.raw(this.cellSafe(fence + pad + flat + pad + fence));
  }

  /**
   * In a table cell a bare `|` ends the cell — inside a code span or a link
   * destination too, because a table row is split before its cells' inline
   * syntax is read, and `\|` is turned back into `|` as it is split.
   */
  private cellSafe(raw: string): string {
    return this.mode === 'cell' ? raw.replace(/\|/g, '\\|') : raw;
  }

  private link(node: LinkInline): void {
    if (node.href === null) {
      this.nodes(node.children); // a link still streaming in has nowhere to go
      return;
    }
    const tail = this.cellSafe(
      `](${destination(node.href)}${titlePart(node.title)})`,
    );
    if (node.image) {
      this.raw('![');
      this.nodes(node.children, ']');
      this.raw(tail);
      return;
    }
    const auto = autolink(node);
    if (auto !== null) {
      this.raw(this.cellSafe(auto));
      return;
    }
    this.raw('[');
    this.nodes(node.children, ']');
    this.raw(tail);
  }

  /** `after` is the character the output continues with past this text, so
   *  a character at the text's edge is judged by its real neighbour and not
   *  by where one node happened to end. */
  private text(text: string, after: string | undefined): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') {
        this.hardBreak(); // a text node the editor built may carry one
        continue;
      }
      if (this.lineStart) {
        this.lineStart = false;
        const lead = this.lineLead(text, i);
        if (lead !== null) {
          this.out += lead.text;
          i += lead.consumed - 1;
          continue;
        }
      }
      this.out += this.escape(text, i, after);
    }
  }

  /**
   * The first character of a line, when it would open a block: `# ` a
   * heading, `>` a quote, `-`/`+`/`=`/`:`/`|`/`~` a list, a setext underline,
   * a table's delimiter row or a fence, `12.` an ordered list, and leading
   * whitespace an indented code block (or nothing, after a trim). The last is
   * spelled as a character reference, which no block rule looks at.
   */
  private lineLead(
    text: string,
    i: number,
  ): { text: string; consumed: number } | null {
    const ch = text[i];
    if (ch === ' ') return { text: '&#32;', consumed: 1 };
    if (ch === '\t') return { text: '&#9;', consumed: 1 };
    if (this.mode !== 'block') return null;
    if ('#>-+=:|~'.includes(ch)) return { text: `\\${ch}`, consumed: 1 };
    const ordered = /^(\d{1,9})([.)])/.exec(text.slice(i));
    if (ordered) {
      const after = text[i + ordered[0].length];
      if (after === undefined || WS.test(after)) {
        return {
          text: `${ordered[1]}\\${ordered[2]}`,
          consumed: ordered[0].length,
        };
      }
    }
    return null;
  }

  private escape(text: string, i: number, after: string | undefined): string {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : lastChar(this.out);
    const next = i + 1 < text.length ? text[i + 1] : after;
    switch (ch) {
      case '\\':
      case '`':
      case '*':
      case '[':
      case ']':
        return `\\${ch}`;
      case '_':
        // intraword `_` is never emphasis — snake_case needs nothing
        return WORD.test(prev ?? '') && WORD.test(next ?? '') ? ch : `\\${ch}`;
      case '~':
        // strikethrough is `~~` only, so a lone tilde is text — but one
        // beside another, or beside a strikethrough's own delimiter, is not
        return prev === '~' || next === '~' ? `\\${ch}` : ch;
      case '<':
        return /[A-Za-z/!?]/.test(text[i + 1] ?? '') ? `\\${ch}` : ch;
      case '&':
        return ENTITY_LIKE.test(text.slice(i)) ? `\\${ch}` : ch;
      case '!':
        // `!` then a link is an image
        return next === '[' ? `\\${ch}` : ch;
      case '|':
        return this.mode === 'cell' ? `\\${ch}` : ch;
      default:
        return ch;
    }
  }
}

// --- flanking -----------------------------------------------------------------
//
// The parser's own rules (`./parse.ts`, the emphasis scan), asked in advance.

const PUNCT = /[\p{P}\p{S}]/u;

function kind(ch: string | undefined): 'ws' | 'punct' | 'other' {
  if (ch === undefined || ch === '' || WS.test(ch)) return 'ws';
  return PUNCT.test(ch) ? 'punct' : 'other';
}

function flanks(before: string | undefined, after: string | undefined) {
  const b = kind(before);
  const a = kind(after);
  return {
    b,
    a,
    left: a !== 'ws' && (a !== 'punct' || b !== 'other'),
    right: b !== 'ws' && (b !== 'punct' || a !== 'other'),
  };
}

function canOpen(
  ch: string,
  before: string | undefined,
  first: string | undefined,
): boolean {
  const f = flanks(before, first);
  return ch === '_' ? f.left && (!f.right || f.b === 'punct') : f.left;
}

function canClose(
  ch: string,
  last: string | undefined,
  after: string | undefined,
): boolean {
  const f = flanks(last, after);
  return ch === '_' ? f.right && (!f.left || f.a === 'punct') : f.right;
}

/** The whole last character of `text` — both halves of a surrogate pair. */
function lastChar(text: string): string | undefined {
  if (text === '') return undefined;
  const unit = text.charCodeAt(text.length - 1);
  return unit >= 0xdc00 && unit <= 0xdfff && text.length >= 2
    ? text.slice(-2)
    : text[text.length - 1];
}

function firstChar(text: string): string | undefined {
  const cp = text.codePointAt(0);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/** The first character a node writes — all its neighbour's flanking can
 *  see. Every delimiter and bracket is punctuation, whichever it turns out
 *  to be. */
function leadOf(node: InlineNode): string | undefined {
  switch (node.type) {
    case 'text':
      return firstChar(node.text);
    case 'code':
      return '`';
    case 'strong':
    case 'em':
      return '*';
    case 'del':
      return '~';
    case 'link':
      return node.image ? '!' : '[';
    case 'break':
      return '\\';
    case 'expression':
      return '{';
    case 'component':
      return node.children.length ? leadOf(node.children[0]) : undefined;
  }
}

/** `<https://…>` for a link whose text is its own target. */
function autolink(node: LinkInline): string | null {
  if (node.title || !node.href || node.children.length !== 1) return null;
  const only = node.children[0];
  if (only.type !== 'text') return null;
  const text = only.text;
  if (
    text === node.href &&
    /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*$/.test(text)
  ) {
    return `<${text}>`;
  }
  if (
    node.href === `mailto:${text}` &&
    /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(text)
  ) {
    return `<${text}>`;
  }
  return null;
}

/** A link destination: bare with its parentheses escaped, or in `<…>` when
 *  it has whitespace in it — the one form a space survives in. */
function destination(href: string): string {
  if (href === '') return '<>';
  if (/[\s<>]/.test(href)) {
    return `<${href.replace(/[\n\r]/g, '').replace(/[<>]/g, (c) => encodeURIComponent(c))}>`;
  }
  return href.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** ` "title"`, in whichever of the three quote styles the title does not
 *  contain — the parser's title scan has no escapes. */
function titlePart(title: string | undefined): string {
  if (!title) return '';
  if (!title.includes('"')) return ` "${title}"`;
  if (!title.includes("'")) return ` '${title}'`;
  if (!title.includes(')')) return ` (${title})`;
  return ` "${title.replace(/"/g, '&quot;')}"`;
}

/**
 * Emphasis can open only before non-space and close only after it (the
 * flanking rules), so `**bold **` is not bold. Whitespace at the edge of a
 * strong/em/del node moves outside it, and a node that was all whitespace
 * becomes that whitespace.
 */
function expel(nodes: readonly InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === 'strong' || node.type === 'em' || node.type === 'del') {
      const children = expel(node.children);
      const lead = takeEdge(children, 'start');
      const trail = takeEdge(children, 'end');
      if (lead) out.push({ type: 'text', text: lead });
      if (children.length > 0) out.push({ type: node.type, children });
      if (trail) out.push({ type: 'text', text: trail });
    } else if (node.type === 'link' || node.type === 'component') {
      out.push({ ...node, children: expel(node.children) });
    } else {
      out.push(node);
    }
  }
  return mergeTexts(out);
}

/** Remove, and return, the whitespace at one end of `nodes` (in place). */
function takeEdge(nodes: InlineNode[], side: 'start' | 'end'): string {
  const at = side === 'start' ? 0 : nodes.length - 1;
  const node = nodes[at];
  if (!node || node.type !== 'text') return '';
  const m =
    side === 'start' ? /^\s+/u.exec(node.text) : /\s+$/u.exec(node.text);
  if (!m) return '';
  const rest =
    side === 'start'
      ? node.text.slice(m[0].length)
      : node.text.slice(0, node.text.length - m[0].length);
  if (rest === '') nodes.splice(at, 1);
  else nodes[at] = { type: 'text', text: rest };
  return m[0];
}

function mergeTexts(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === 'text') {
      if (node.text === '') continue;
      if (prev?.type === 'text') {
        out[out.length - 1] = { type: 'text', text: prev.text + node.text };
        continue;
      }
    }
    out.push(node);
  }
  return out;
}
